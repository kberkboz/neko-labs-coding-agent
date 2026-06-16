import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import { Agent } from "../agent/agent"
import { Session } from "@/session/session"
import { MessageID } from "../session/schema"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import type { TaskPromptOps } from "./task"
import type { Provider } from "@/provider/provider"
import { ModelV2 } from "@opencode-ai/core/model"

/**
 * Neko "Experiment" mode, exposed as a tool ARIA calls for empirical/research
 * tasks. Ports Neko Labs' run_scientific (backend/experiments.py): the team
 * marches through the scientific method, each step routed to the right
 * specialist subagent, feeding prior outputs forward, with optional peer review.
 *
 *   hypothesis (planner) -> literature (researcher) -> feasibility (analyst)
 *   -> experiment/code+run (coder) -> interpret (analyst) -> conclusion (writer)
 *
 * Built on the same subagent plumbing as discuss/review (ctx.extra.promptOps +
 * Session.create), so each step is a first-class child session.
 */

interface Step {
  key: string
  agent: string
  /** Build the step prompt from the goal + accumulated prior outputs. */
  prompt: (goal: string, prior: Record<string, string>, slug: string) => string
  /** Skip when code execution is disabled. */
  code?: boolean
  /** Run a peer-review pass on this step's output. */
  review?: boolean
}

const STEPS: Step[] = [
  {
    key: "hypothesis",
    agent: "planner",
    prompt: (goal) =>
      `State a clear, testable hypothesis for the following goal.\n\nGoal: ${goal}\n\n` +
      `Structure your answer with three sections: **Background** (2-3 sentences), **Predictions** ` +
      `(2-3 concrete, observable predictions), **Hypothesis** (one falsifiable statement). ` +
      `Analytical only — do NOT write code or describe methods yet.`,
  },
  {
    key: "literature",
    agent: "researcher",
    prompt: (goal, prior) =>
      `Research prior art relevant to this hypothesis. Use your search tools (web/academic) and read the codebase if relevant.\n\n` +
      `Goal: ${goal}\nHypothesis: ${prior.hypothesis ?? ""}\n\n` +
      `Synthesize the current state of knowledge, the key approaches, and the gaps. Cite specifically. Prose only.`,
  },
  {
    key: "feasibility",
    agent: "analyst",
    prompt: (goal, prior) =>
      `Evaluate the feasibility of testing this hypothesis.\n\n` +
      `Goal: ${goal}\nHypothesis: ${prior.hypothesis ?? ""}\nLiterature: ${prior.literature ?? ""}\n\n` +
      `Assess technical feasibility, data/compute needs, and the top risks. End with a clear verdict: ` +
      `GO / CONDITIONAL GO / NO-GO, with justification. Prose only.`,
  },
  {
    key: "experiment",
    agent: "coder",
    code: true,
    review: true,
    prompt: (goal, prior, slug) =>
      `Implement and RUN code to test this hypothesis, then report the real results.\n\n` +
      `Goal: ${goal}\nHypothesis: ${prior.hypothesis ?? ""}\nFeasibility notes: ${prior.feasibility ?? ""}\n\n` +
      `Write self-contained code under \`experiments/${slug}/\`, execute it, and print clear numerical results. ` +
      `Report exactly what the code produced — never invent results. If a run fails, fix and re-run (a few attempts), ` +
      `then report the real outcome.`,
  },
  {
    key: "interpret",
    agent: "analyst",
    prompt: (goal, prior) =>
      `Critically interpret the experimental results.\n\n` +
      `Hypothesis: ${prior.hypothesis ?? ""}\nResults from the experiment step:\n${prior.experiment ?? "(none)"}\n\n` +
      `Do the results support or refute the hypothesis? Assess significance, effect size, and limitations. ` +
      `ONLY discuss results that actually appear above. Prose only.`,
  },
  {
    key: "conclusion",
    agent: "writer",
    review: true,
    prompt: (goal, prior, slug) =>
      `Write a structured research conclusion and save it to \`experiments/${slug}/conclusion.md\`.\n\n` +
      `Goal: ${goal}\nHypothesis: ${prior.hypothesis ?? ""}\nResults: ${prior.experiment ?? "(none)"}\n` +
      `Interpretation: ${prior.interpret ?? ""}\n\n` +
      `Sections: # Title, ## Background, ## Hypothesis, ## Methods, ## Results, ## Interpretation, ## Conclusion, ## Next Steps. ` +
      `Only report results that actually occurred.`,
  },
]

export const Parameters = Schema.Struct({
  goal: Schema.String.annotate({ description: "The research goal / question to investigate via the scientific method." }),
  includeCode: Schema.optional(Schema.Boolean).annotate({
    description: "Whether to include the code-and-run step (default true). Set false for a theoretical/literature study.",
  }),
  peerReview: Schema.optional(Schema.Boolean).annotate({
    description: "Whether to peer-review key steps (experiment + conclusion). Default true.",
  }),
})

type Metadata = { steps: string[]; slug: string }

function slugify(goal: string) {
  const base = goal
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("-")
  const suffix = Date.now().toString(36).slice(-4)
  return base ? `${base}-${suffix}` : `exp-${suffix}`
}

export const ExperimentTool = Tool.define<typeof Parameters, Metadata, Agent.Service | Session.Service>(
  "experiment",
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service

    const run = Effect.fn("ExperimentTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return yield* Effect.fail(new Error("ExperimentTool requires promptOps in ctx.extra"))
      const model = ctx.extra?.model as Provider.Model | undefined
      if (!model) return yield* Effect.fail(new Error("ExperimentTool requires model in ctx.extra"))

      yield* ctx.ask({ permission: "experiment", patterns: ["*"], always: ["*"], metadata: {} })

      const includeCode = params.includeCode !== false
      const peerReview = params.peerReview !== false
      const slug = slugify(params.goal)
      const parent = yield* sessions.get(ctx.sessionID)

      const callAgent = Effect.fn("ExperimentTool.callAgent")(function* (agentName: string, prompt: string, title: string) {
        const info = yield* agents.get(agentName)
        if (!info) return `[agent '${agentName}' unavailable]`
        const child = yield* sessions.create({
          parentID: ctx.sessionID,
          title,
          agent: info.name,
          permission: deriveSubagentSessionPermission({
            parentSessionPermission: parent.permission ?? [],
            subagent: info,
          }),
        })
        const parts = yield* ops.resolvePromptParts(prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: child.id,
          model: { modelID: ModelV2.ID.make(model.api.id), providerID: model.providerID },
          agent: info.name,
          parts,
        })
        return result.parts.findLast((item) => item.type === "text")?.text ?? "(no response)"
      })

      const prior: Record<string, string> = {}
      const report: string[] = [`# Experiment: ${params.goal}`, `Working dir: experiments/${slug}/`, ""]
      const ran: string[] = []

      for (const step of STEPS) {
        if (step.code && !includeCode) continue
        const out = yield* callAgent(
          step.agent,
          step.prompt(params.goal, prior, slug),
          `Experiment ${step.key} (@${step.agent})`,
        )
        prior[step.key] = out
        ran.push(step.key)
        report.push(`## ${step.key} — @${step.agent}`, out, "")

        if (step.review && peerReview) {
          const reviewOut = yield* callAgent(
            "red_team",
            `Stress-test this experiment step for the goal "${params.goal}". Hunt for p-hacking, data leakage, ` +
              `non-determinism, numerical instability, overfitting, and invented results.\n\n` +
              `Step (${step.key}) output:\n${out.slice(0, 8000)}\n\n` +
              `List concrete findings with severity, or state clearly that you found none.`,
            `Experiment ${step.key} review (@red_team)`,
          )
          prior[`${step.key}_review`] = reviewOut
          report.push(`### ${step.key} peer review — @red_team`, reviewOut, "")
        }
      }

      yield* ctx.metadata({ title: `Experiment: ${slug}`, metadata: { steps: ran, slug } })

      return {
        title: `Experiment: ${params.goal.slice(0, 60)}`,
        output: report.join("\n"),
        metadata: { steps: ran, slug },
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
  "Run a full scientific-method experiment for a research goal: the team marches through hypothesis -> literature review -> feasibility -> code & run -> interpretation -> conclusion, each step handled by the right specialist, with peer review on the experiment and conclusion.",
  "Use this for empirical/research questions that need real evidence (benchmarks, comparisons, 'does X actually work?'), not for ordinary coding tasks.",
  "Code is written and executed under experiments/<slug>/. Set includeCode=false for a purely theoretical/literature study. Returns the full multi-step report.",
  "This is a heavy, multi-step operation — expect it to take a while.",
].join("\n")
