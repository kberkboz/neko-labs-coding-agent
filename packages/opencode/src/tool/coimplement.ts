import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import { Agent } from "../agent/agent"
import { Session } from "@/session/session"
import { MessageID, SessionID } from "../session/schema"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { InstanceState } from "@/effect/instance-state"
import type { TaskPromptOps } from "./task"
import type { Provider } from "@/provider/provider"
import { ModelV2 } from "@opencode-ai/core/model"

/**
 * Neko collaborative ("pair / ensemble") implementation.
 *
 * Instead of one coder writing a change alone, a DRIVER (an agent with edit
 * access, default `coder`) implements the task, then one or more PARTNER agents
 * critique the driver's actual working diff each round and propose concrete
 * corrections. The driver revises; the partners re-review. This loops until the
 * partners are satisfied (every one says LGTM) or the round budget is spent —
 * pair programming, where the driver types and the navigators direct.
 *
 * Built on the same subagent plumbing as `task`/`review` (promptOps +
 * Session.create + deriveSubagentSessionPermission). The driver session is
 * reused across rounds so it keeps context; partners get a fresh session each
 * round so they re-evaluate the latest diff cleanly. A final independent
 * `review` is still required before the change set can merge.
 */

const MAX_PARTNERS = 3
const MAX_ROUNDS = 4
const CONCURRENCY = 4
const MAX_DIFF_CHARS = 24_000

export const Parameters = Schema.Struct({
  task: Schema.String.annotate({
    description: "What to implement — concrete and self-contained. Handed to the driver to code.",
  }),
  partners: Schema.Array(Schema.String).annotate({
    description:
      "Agents who critique each iteration and propose corrections (e.g. ['computer_scientist','red_team'], or a second 'coder'). Pick experts relevant to the task.",
  }),
  driver: Schema.optional(Schema.String).annotate({
    description: "The implementing agent with edit access (default 'coder').",
  }),
  rounds: Schema.optional(Schema.Number).annotate({
    description: "Max implement→critique→revise cycles (1-4, default 2). Stops early when every partner is satisfied.",
  }),
  focus: Schema.optional(Schema.String).annotate({
    description: "Optional: what the partners should focus their critique on.",
  }),
})

type Metadata = { driver: string; partners: string[]; rounds: number; converged: boolean }

function clampRounds(value: number | undefined) {
  if (!value || value < 1) return 2
  return Math.min(MAX_ROUNDS, Math.floor(value))
}

const captureDiff = (cwd: string) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["git", "--no-pager", "diff", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore" })
      const text = await new Response(proc.stdout).text()
      await proc.exited
      return text
    },
    catch: () => new Error("git diff failed"),
  }).pipe(Effect.catch(() => Effect.succeed("")))

export const CoimplementTool = Tool.define<typeof Parameters, Metadata, Agent.Service | Session.Service>(
  "coimplement",
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("CoimplementTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return yield* Effect.fail(new Error("CoimplementTool requires promptOps in ctx.extra"))
      const model = ctx.extra?.model as Provider.Model | undefined
      if (!model) return yield* Effect.fail(new Error("CoimplementTool requires model in ctx.extra"))

      // Gate so only orchestrators convene it; read-only specialists deny "*".
      yield* ctx.ask({ permission: "coimplement", patterns: ["*"], always: ["*"], metadata: {} })

      const instance = yield* InstanceState.context
      const cwd = instance.worktree

      const driverName = (params.driver ?? "coder").trim() || "coder"
      const driverInfo = yield* agents.get(driverName)
      if (!driverInfo) return yield* Effect.fail(new Error(`Unknown driver agent '${driverName}'`))

      const requestedPartners = [...new Set(params.partners.map((a) => a.trim()).filter(Boolean))]
        .filter((name) => name !== driverName)
        .slice(0, MAX_PARTNERS)
      const resolvedPartners = yield* Effect.forEach(requestedPartners, (name) =>
        agents.get(name).pipe(Effect.map((info) => ({ name, info }))),
      )
      const partners = resolvedPartners.filter((p) => p.info)
      if (partners.length === 0)
        return yield* Effect.fail(
          new Error(`No valid partners (distinct from the driver). Requested: ${requestedPartners.join(", ")}`),
        )

      const rounds = clampRounds(params.rounds)
      const parent = yield* sessions.get(ctx.sessionID)
      const modelRef = { modelID: ModelV2.ID.make(model.api.id), providerID: model.providerID }

      const promptAgent = Effect.fn("CoimplementTool.prompt")(function* (
        sessionID: typeof SessionID.Type,
        agentName: string,
        text: string,
      ) {
        const parts = yield* ops.resolvePromptParts(text)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID,
          model: modelRef,
          agent: agentName,
          parts,
        })
        return result.parts.findLast((item) => item.type === "text")?.text ?? "(no response)"
      })

      // Persistent driver session — keeps context across revise rounds.
      const driverSession = yield* sessions.create({
        parentID: ctx.sessionID,
        title: `Implement: ${driverName}`,
        agent: driverInfo.name,
        permission: deriveSubagentSessionPermission({
          parentSessionPermission: parent.permission ?? [],
          subagent: driverInfo,
        }),
      })

      const focusLine = params.focus ? `\nFocus: ${params.focus}` : ""
      const log: string[] = []
      let lastCritiques = ""
      let converged = false

      for (let round = 1; round <= rounds; round++) {
        const implPrompt =
          round === 1
            ? `Implement this task by EDITING the codebase (use your edit/write/shell tools — do not just describe the change). Make the smallest correct change, match the surrounding conventions, and run or test it if you can.${focusLine}\n\nTask:\n${params.task}`
            : `Your partners reviewed your current changes and asked for corrections:\n\n${lastCritiques}\n\nRevise your implementation to address their feedback. EDIT the files directly; do not just describe what you would change. Briefly note what you changed.`
        const implResult = yield* promptAgent(driverSession.id, driverInfo.name, implPrompt)
        log.push(`### Round ${round} — ${driverName} implements\n${implResult}`)

        const diff = yield* captureDiff(cwd)
        const cappedDiff =
          diff.length > MAX_DIFF_CHARS ? diff.slice(0, MAX_DIFF_CHARS) + "\n... (diff truncated)" : diff

        const critiquePrompt = [
          `You are pair-programming with ${driverName}, who is implementing this task:`,
          params.task,
          focusLine,
          "",
          "Review their CURRENT working diff below. Give concrete, line-cited corrections — exactly what to change and why. Be specific and brief; suggest the better approach, don't rewrite everything.",
          "End with a single verdict line: 'LGTM' if you're satisfied as-is, or 'CHANGES' if it still needs work.",
          "",
          "```diff",
          cappedDiff || "(no changes were produced yet)",
          "```",
        ].join("\n")

        const critiques = yield* Effect.forEach(
          partners,
          (p) =>
            Effect.gen(function* () {
              const child = yield* sessions.create({
                parentID: ctx.sessionID,
                title: `Critique r${round}: ${p.name}`,
                agent: p.info.name,
                permission: deriveSubagentSessionPermission({
                  parentSessionPermission: parent.permission ?? [],
                  subagent: p.info,
                }),
              })
              const text = yield* promptAgent(child.id, p.info.name, critiquePrompt)
              return { name: p.name, text }
            }),
          { concurrency: CONCURRENCY },
        )

        for (const c of critiques) log.push(`### Round ${round} — ${c.name} critiques\n${c.text}`)
        lastCritiques = critiques.map((c) => `**${c.name}:**\n${c.text}`).join("\n\n")

        const satisfied = critiques.every((c) => /\bLGTM\b/i.test(c.text) && !/\bCHANGES\b/i.test(c.text))

        yield* ctx.metadata({
          title: `Co-implement (round ${round}/${rounds}${satisfied ? ", converged" : ""})`,
          metadata: { driver: driverName, partners: partners.map((p) => p.name), rounds, converged: satisfied },
        })

        if (satisfied) {
          converged = true
          break
        }
      }

      const output = [
        `# Collaborative implementation: ${params.task.slice(0, 80)}`,
        `Driver: ${driverName} · Partners: ${partners.map((p) => p.name).join(", ")} · ${
          converged ? "converged" : `ran ${rounds} round(s)`
        }`,
        "",
        ...log,
        "",
        "---",
        converged
          ? "The partners are satisfied. Open the change set and run an independent `review` before merging."
          : "Round budget reached without full agreement — weigh the remaining critiques, decide whether to continue, then run `review` before merging.",
      ].join("\n")

      return {
        title: `Co-implement: ${params.task.slice(0, 60)}`,
        output,
        metadata: { driver: driverName, partners: partners.map((p) => p.name), rounds, converged },
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
  "Collaborative (pair/ensemble) implementation: a DRIVER agent (default 'coder') writes the code while PARTNER agents critique the driver's actual working diff each round and propose concrete corrections, looping implement→critique→revise until the partners are satisfied or the round budget is spent.",
  "Use this INSTEAD of a single `task`-to-coder hand-off when a change is tricky or high-stakes and benefits from multiple agents correcting each other as it's written (e.g. driver='coder', partners=['computer_scientist','red_team']). Pick partners whose expertise matches the task.",
  "The driver edits real files. A final independent `review` is still required before the change set can merge.",
].join("\n")
