import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import { Agent } from "../agent/agent"
import { Session } from "@/session/session"
import { SessionID, MessageID } from "../session/schema"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { TaskPromptOps } from "./task"
import type { Provider } from "@/provider/provider"
import { ModelV2 } from "@opencode-ai/core/model"

/**
 * Neko multi-agent discussion engine, exposed as a tool ARIA calls.
 *
 * Spawns the named specialist subagents in parallel on a shared question, runs
 * `rounds` rounds of debate (round 2+ each agent sees the prior round's combined
 * views, like Neko Labs' orchestrator.discuss), and returns a structured
 * transcript. ARIA synthesizes the consensus in its next turn.
 *
 * Built on the same subagent plumbing as the `task` tool (`ctx.extra.promptOps`
 * + Session.create + deriveSubagentSessionPermission), so discussion sessions
 * are first-class child sessions with their own scoped permissions.
 */

const MAX_AGENTS = 6
const MAX_ROUNDS = 3
const CONCURRENCY = 4

export const Parameters = Schema.Struct({
  topic: Schema.String.annotate({
    description: "The question or design decision the agents should debate (be specific and self-contained).",
  }),
  agents: Schema.Array(Schema.String).annotate({
    description:
      "Agent names to bring into the discussion (e.g. ['computer_scientist','analyst','red_team']). Pick the specialists relevant to the topic.",
  }),
  rounds: Schema.optional(Schema.Number).annotate({
    description: "Number of debate rounds (1-3, default 1). Round 2+ lets each agent respond to the others' views.",
  }),
  synthesize: Schema.optional(Schema.Boolean).annotate({
    description:
      "Whether ARIA writes a closing synthesis (agreements / disagreements / recommended action). Default true when there is more than one participant.",
  }),
})

type Metadata = {
  rounds: number
  participants: string[]
}

function clampRounds(value: number | undefined) {
  if (!value || value < 1) return 1
  return Math.min(MAX_ROUNDS, Math.floor(value))
}

export const DiscussTool = Tool.define<typeof Parameters, Metadata, Agent.Service | Session.Service>(
  "discuss",
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("DiscussTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return yield* Effect.fail(new Error("DiscussTool requires promptOps in ctx.extra"))
      const model = ctx.extra?.model as Provider.Model | undefined
      if (!model) return yield* Effect.fail(new Error("DiscussTool requires model in ctx.extra"))

      // Gate behind the "discuss" permission so only orchestrators (ARIA / build)
      // can convene a discussion. Read-only specialist subagents deny "*", so a
      // spawned participant can never recursively convene its own discussion.
      yield* ctx.ask({ permission: "discuss", patterns: ["*"], always: ["*"], metadata: {} })

      // Resolve + validate the requested participants (skip unknown names).
      const requested = [...new Set(params.agents.map((a) => a.trim()).filter(Boolean))].slice(0, MAX_AGENTS)
      const resolved = yield* Effect.forEach(requested, (name) =>
        agents.get(name).pipe(Effect.map((info) => ({ name, info }))),
      )
      const participants = resolved.filter((p) => p.info)
      if (participants.length === 0)
        return yield* Effect.fail(new Error(`No valid agents for discussion. Requested: ${requested.join(", ")}`))

      const rounds = clampRounds(params.rounds)
      const parent = yield* sessions.get(ctx.sessionID)

      // One child session per participant, reused across rounds so each agent
      // keeps its own conversational thread.
      const childSessions = yield* Effect.forEach(
        participants,
        (p) =>
          sessions
            .create({
              parentID: ctx.sessionID,
              title: `Discussion: ${p.name} — ${params.topic.slice(0, 48)}`,
              agent: p.info.name,
              permission: deriveSubagentSessionPermission({
                parentSessionPermission: parent.permission ?? [],
                subagent: p.info,
              }),
            })
            .pipe(Effect.map((session) => ({ ...p, sessionID: session.id }))),
        { concurrency: CONCURRENCY },
      )

      const askOne = Effect.fn("DiscussTool.askOne")(function* (
        target: (typeof childSessions)[number],
        promptText: string,
      ) {
        const parts = yield* ops.resolvePromptParts(promptText)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: target.sessionID,
          model: { modelID: ModelV2.ID.make(model.api.id), providerID: model.providerID },
          agent: target.info.name,
          parts,
        })
        const text = result.parts.findLast((item) => item.type === "text")?.text ?? "(no response)"
        return { name: target.name, text }
      })

      const transcript: { round: number; name: string; text: string }[] = []
      let priorViews = ""

      for (let round = 1; round <= rounds; round++) {
        const prompt =
          round === 1
            ? `Topic for discussion:\n${params.topic}\n\nGive your perspective from your discipline. Be opinionated, specific, and concrete. State concerns and trade-offs. 150-250 words.`
            : `Topic for discussion:\n${params.topic}\n\nRound ${round} — your colleagues said:\n${priorViews}\n\nRespond: where do you agree, where do you push back, and what is your recommendation now? 120-200 words.`

        const roundResults = yield* Effect.forEach(childSessions, (target) => askOne(target, prompt), {
          concurrency: CONCURRENCY,
        })
        for (const r of roundResults) transcript.push({ round, name: r.name, text: r.text })
        priorViews = roundResults.map((r) => `**${r.name}:**\n${r.text}`).join("\n\n")
      }

      // Closing synthesis by ARIA — like Neko Labs' orchestrator.discuss(synthesize=True):
      // a fresh ARIA reads the full debate and reports agreements, disagreements,
      // and the recommended action. Spawned as its own child session.
      const wantSynthesis = (params.synthesize ?? true) && participants.length > 1
      let synthesis = ""
      if (wantSynthesis) {
        const aria = yield* agents.get("aria")
        if (aria) {
          const synthSession = yield* sessions.create({
            parentID: ctx.sessionID,
            title: `Discussion synthesis — ${params.topic.slice(0, 48)}`,
            agent: aria.name,
            permission: deriveSubagentSessionPermission({
              parentSessionPermission: parent.permission ?? [],
              subagent: aria,
            }),
          })
          const synthPrompt = [
            `Discussion on: ${params.topic}`,
            "",
            priorViews,
            "",
            "Synthesise this discussion. Be concise. Cover, with headers:",
            "## Agreements — what everyone converged on.",
            "## Disagreements — open tensions and the trade-off behind each.",
            "## Recommended action — the approach to implement, and why.",
          ].join("\n")
          synthesis = yield* askOne({ ...{ name: "aria", info: aria }, sessionID: synthSession.id }, synthPrompt).pipe(
            Effect.map((r) => r.text),
          )
        }
      }

      yield* ctx.metadata({
        title: `Discussion (${participants.length} agents, ${rounds} round${rounds > 1 ? "s" : ""})`,
        metadata: { rounds, participants: participants.map((p) => p.name) },
      })

      // Render as a conversation: "Round N" headers, then "Agent: …" lines, and
      // ARIA's closing summary as the final speaker.
      const display = (name: string) =>
        name
          .split("_")
          .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
          .join(" ")

      const lines: string[] = [`Discussion: ${params.topic}`, ""]
      for (let round = 1; round <= rounds; round++) {
        lines.push(`Round ${round}`)
        for (const entry of transcript.filter((t) => t.round === round)) {
          lines.push(`${display(entry.name)}: ${entry.text}`, "")
        }
      }
      if (synthesis) {
        lines.push(`ARIA: ${synthesis}`)
      } else if (participants.length > 1) {
        lines.push("ARIA: (summarise the agreements, disagreements, and recommended approach before implementing.)")
      }
      const output = lines.join("\n")

      return {
        title: `Discussion: ${params.topic.slice(0, 60)}`,
        output,
        metadata: { rounds, participants: participants.map((p) => p.name) },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

const DESCRIPTION = [
  "Convene a multi-agent discussion: spawn the named specialist agents in parallel to debate a design decision and surface agreements, disagreements, and trade-offs before any code is written.",
  "Use this BEFORE implementing a non-trivial change so the approach is reviewed by the relevant experts. Pick agents whose expertise matches the topic (e.g. computer_scientist + analyst for an algorithm; data_scientist for data work; red_team to stress-test).",
  "Returns each agent's view per round. You (ARIA) then synthesize the consensus and proceed to implementation.",
].join("\n")
