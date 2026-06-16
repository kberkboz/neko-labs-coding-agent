import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import { Agent } from "../agent/agent"
import { Session } from "@/session/session"
import { MessageID } from "../session/schema"
import { deriveSubagentSessionPermission } from "../agent/subagent-permissions"
import { InstanceState } from "@/effect/instance-state"
import type { TaskPromptOps } from "./task"
import type { Provider } from "@/provider/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { ReviewGate } from "../neko/review-gate"
import { Question } from "../question"
import { Global } from "@opencode-ai/core/global"
import path from "path"

// Shared settings file (also written by the TUI /manual-review command).
const NEKO_SETTINGS_FILE = path.join(Global.Path.data, "storage", "neko", "settings.json")
const readManualReview = () =>
  Effect.tryPromise({
    try: async () => {
      const data = (await Bun.file(NEKO_SETTINGS_FILE).json()) as { manualReview?: boolean }
      return data?.manualReview === true
    },
    catch: () => new Error("settings read failed"),
  }).pipe(Effect.catch(() => Effect.succeed(false)))

/**
 * Neko peer-review engine, exposed as a tool ARIA calls AFTER implementation.
 *
 * Captures the working-tree diff (vs HEAD) and dispatches it to read-only
 * reviewer subagents in parallel for line-cited critique, then returns their
 * combined verdict. This is the "peer review step" that runs on every
 * non-trivial coding task, mirroring Neko Labs' per-step peer review.
 *
 * Reviewers are read-only (they cannot run git), so the diff is computed here
 * and handed to them in the prompt.
 */

const MAX_REVIEWERS = 4
const CONCURRENCY = 4
const MAX_DIFF_CHARS = 24_000
const DEFAULT_REVIEWERS = ["reviewer", "red_team"]

export const Parameters = Schema.Struct({
  agents: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Reviewer agent names (default ['reviewer','red_team']). Add domain specialists when relevant (e.g. 'data_scientist' for data work).",
  }),
  focus: Schema.optional(Schema.String).annotate({
    description: "Optional: what the reviewers should pay special attention to (e.g. 'concurrency safety', 'the new API').",
  }),
})

type Metadata = {
  reviewers: string[]
  hadChanges: boolean
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

export const ReviewTool = Tool.define<typeof Parameters, Metadata, Agent.Service | Session.Service | Question.Service>(
  "review",
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const question = yield* Question.Service

    const run = Effect.fn("ReviewTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const ops = ctx.extra?.promptOps as TaskPromptOps | undefined
      if (!ops) return yield* Effect.fail(new Error("ReviewTool requires promptOps in ctx.extra"))
      const model = ctx.extra?.model as Provider.Model | undefined
      if (!model) return yield* Effect.fail(new Error("ReviewTool requires model in ctx.extra"))

      // Gate behind the "review" permission so only orchestrators can convene a
      // review; read-only specialist subagents deny "*" and cannot recurse.
      yield* ctx.ask({ permission: "review", patterns: ["*"], always: ["*"], metadata: {} })

      const instance = yield* InstanceState.context
      const diff = yield* captureDiff(instance.worktree)
      if (!diff.trim())
        return {
          title: "Peer review",
          output: "No uncommitted changes to review (working tree matches HEAD).",
          metadata: { reviewers: [], hadChanges: false },
        }

      const cappedDiff =
        diff.length > MAX_DIFF_CHARS
          ? diff.slice(0, MAX_DIFF_CHARS) + `\n\n... (diff truncated at ${MAX_DIFF_CHARS} chars)`
          : diff

      // Manual peer review (toggled via /manual-review): ask the USER to approve
      // the change set instead of dispatching it to reviewer agents.
      if (yield* readManualReview()) {
        const files = diff.split("\n").filter((l) => l.startsWith("diff --git ")).length
        const answers = yield* question.ask({
          sessionID: ctx.sessionID,
          questions: [
            {
              question: `Manual peer review: approve the current change set (${files} file${files === 1 ? "" : "s"})? Inspect the diff in your editor or with the changeset first.`,
              header: "Manual peer review",
              options: [
                { label: "Approve", description: "The change looks good — allow it to be merged." },
                { label: "Request changes", description: "Needs more work before it can merge." },
              ],
            },
          ],
          tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
        })
        const choice = answers[0]?.[0] ?? "Request changes"
        const verdict = /approve/i.test(choice) ? "APPROVE" : "REQUEST CHANGES"
        ReviewGate.record(instance.worktree, diff, ["you"], verdict)
        yield* ctx.metadata({ title: `Manual review — ${verdict}`, metadata: { reviewers: ["you"], hadChanges: true } })
        return {
          title: `Manual review — ${verdict}`,
          output:
            verdict === "APPROVE"
              ? "You approved the change set. It may now be merged with `changeset approve`."
              : "You requested changes. Address them, then re-run review — the change set cannot merge until a review passes.",
          metadata: { reviewers: ["you"], hadChanges: true },
        }
      }

      const requested = [...new Set((params.agents ?? DEFAULT_REVIEWERS).map((a) => a.trim()).filter(Boolean))].slice(
        0,
        MAX_REVIEWERS,
      )
      const resolved = yield* Effect.forEach(requested, (name) =>
        agents.get(name).pipe(Effect.map((info) => ({ name, info }))),
      )
      const reviewers = resolved.filter((r) => r.info)
      if (reviewers.length === 0)
        return yield* Effect.fail(new Error(`No valid reviewers. Requested: ${requested.join(", ")}`))

      const parent = yield* sessions.get(ctx.sessionID)
      const focusLine = params.focus ? `\n\nPay special attention to: ${params.focus}` : ""
      const prompt = [
        "Peer-review the following working-tree diff (vs HEAD). Give concrete, line-cited comments.",
        "For each issue: severity (nit/minor/major/blocker), the file and rough location, why it's a problem, and a concrete fix.",
        "Distinguish blocking issues from nits. End with a single verdict line: APPROVE or REQUEST CHANGES, plus a one-sentence rationale.",
        focusLine,
        "",
        "```diff",
        cappedDiff,
        "```",
      ].join("\n")

      const reviewOne = Effect.fn("ReviewTool.reviewOne")(function* (reviewer: (typeof reviewers)[number]) {
        const child = yield* sessions.create({
          parentID: ctx.sessionID,
          title: `Review: ${reviewer.name}`,
          agent: reviewer.info.name,
          permission: deriveSubagentSessionPermission({
            parentSessionPermission: parent.permission ?? [],
            subagent: reviewer.info,
          }),
        })
        const parts = yield* ops.resolvePromptParts(prompt)
        const result = yield* ops.prompt({
          messageID: MessageID.ascending(),
          sessionID: child.id,
          model: { modelID: ModelV2.ID.make(model.api.id), providerID: model.providerID },
          agent: reviewer.info.name,
          parts,
        })
        const text = result.parts.findLast((item) => item.type === "text")?.text ?? "(no response)"
        return { name: reviewer.name, text }
      })

      const results = yield* Effect.forEach(reviewers, reviewOne, { concurrency: CONCURRENCY })

      // Record this review against the exact diff that was reviewed, so the
      // changeset "merge" can verify the change set was peer-reviewed. The diff
      // hash means any later edit invalidates the approval (forces a re-review).
      const verdict = ReviewGate.inferVerdict(results.map((r) => r.text).join("\n"))
      ReviewGate.record(instance.worktree, diff, reviewers.map((r) => r.name), verdict)

      yield* ctx.metadata({
        title: `Peer review — ${verdict} (${reviewers.map((r) => r.name).join(", ")})`,
        metadata: { reviewers: reviewers.map((r) => r.name), hadChanges: true },
      })

      const output = [
        `# Peer review — ${verdict}`,
        `Reviewers: ${reviewers.map((r) => r.name).join(", ")}`,
        "",
        ...results.map((r) => `## ${r.name}\n${r.text}`),
        "",
        "---",
        verdict === "APPROVE"
          ? "Approved. The change set may now be merged with `changeset approve`."
          : "Changes requested. Address every blocker/major issue, then re-run `review` — the change set cannot be merged until a review passes.",
      ].join("\n")

      return {
        title: `Peer review — ${verdict}`,
        output,
        metadata: { reviewers: reviewers.map((r) => r.name), hadChanges: true },
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
  "Run a peer review of the current uncommitted code changes: dispatch the working-tree diff to reviewer agents in parallel for line-cited critique and a verdict (APPROVE / REQUEST CHANGES).",
  "Call this AFTER implementing a non-trivial change and BEFORE telling the user it's done. Defaults to the 'reviewer' and 'red_team' agents; add domain specialists when the change touches their area.",
  "Address blockers and major issues, then re-run until the reviewers approve.",
].join("\n")
