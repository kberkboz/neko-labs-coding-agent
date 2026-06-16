import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { ReviewGate } from "../neko/review-gate"

/**
 * PR-like change set for the Neko workflow.
 *
 * A "change set" is the current working-tree delta (vs HEAD) produced during a
 * task — the discussion happened, the coder implemented, the reviewers signed
 * off, and now the change set is presented for the user's decision:
 *
 *   - status:  review the change set (diff stat + file list) — the "PR".
 *   - approve: stage everything and commit it — the "merge".
 *   - discard: stash it (recoverable: `git stash pop`) — "close without merging".
 *
 * Gated behind the "changeset" permission so only ARIA / build / plan can drive
 * it. The commit is deliberately recoverable (git), and users who want an
 * explicit confirmation can set `permission: { changeset: "ask" }` in config.
 */

const git = (cwd: string, args: string[]) =>
  Effect.tryPromise({
    try: async () => {
      const proc = Bun.spawn(["git", "--no-pager", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
      const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
      const code = await proc.exited
      return { code, out: out.trim(), err: err.trim() }
    },
    catch: () => new Error("git invocation failed"),
  }).pipe(Effect.catch(() => Effect.succeed({ code: 1, out: "", err: "git unavailable" })))

export const Parameters = Schema.Struct({
  action: Schema.Literals(["status", "approve", "discard"]).annotate({
    description: "status (review the change set) | approve (stage + commit) | discard (stash, recoverable)",
  }),
  message: Schema.optional(Schema.String).annotate({
    description: "Commit message (required for approve). Use a conventional-commit style summary.",
  }),
  label: Schema.optional(Schema.String).annotate({ description: "Optional label for the stash when discarding." }),
})

type Metadata = { action: string; files: number; clean: boolean }

const DESCRIPTION = [
  "Manage the current change set as a pull request: the uncommitted changes produced during a task.",
  "After the team has discussed, implemented, and peer-reviewed a change, use action='status' to present the change set, then 'approve' (stage + commit with a message = merge) or 'discard' (stash it, recoverable) based on the user's decision.",
  "Only commit after review has passed. Discard is non-destructive (it stashes).",
].join("\n")

export const ChangesetTool = Tool.define<typeof Parameters, Metadata, never>(
  "changeset",
  Effect.succeed({
    description: DESCRIPTION,
    parameters: Parameters,
    execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
      Effect.gen(function* () {
        yield* ctx.ask({ permission: "changeset", patterns: ["*"], always: ["*"], metadata: {} })
        const instance = yield* InstanceState.context
        const cwd = instance.worktree

        const porcelain = yield* git(cwd, ["status", "--porcelain"])
        const changedFiles = porcelain.out ? porcelain.out.split("\n").filter(Boolean) : []
        const clean = changedFiles.length === 0

        if (params.action === "status") {
          const stat = yield* git(cwd, ["diff", "HEAD", "--stat"])
          const diff = yield* git(cwd, ["diff", "HEAD"])
          const gate = ReviewGate.check(cwd, diff.out)
          const reviewLine = gate.ok
            ? `Review: ✓ APPROVED by ${gate.record.reviewers.join(", ")} — ready to merge.`
            : `Review: ✗ ${gate.reason} — run 'review' before this can merge.`
          const output = clean
            ? "Change set is empty — working tree matches HEAD."
            : [
                `# Pull request (${changedFiles.length} file${changedFiles.length === 1 ? "" : "s"})`,
                "",
                stat.out || changedFiles.join("\n"),
                "",
                reviewLine,
                "",
                "approve to commit (merge), or discard to stash (recoverable).",
              ].join("\n")
          return { title: "Pull request", output, metadata: { action: "status", files: changedFiles.length, clean } }
        }

        if (clean)
          return {
            title: "Change set",
            output: "Nothing to do — the change set is empty.",
            metadata: { action: params.action, files: 0, clean },
          }

        if (params.action === "approve") {
          if (!params.message) return yield* Effect.fail(new Error("changeset approve requires a commit 'message'"))

          // Mandatory peer review: a change set cannot be merged until a DIFFERENT
          // agent has peer-reviewed this exact diff and approved it. Enforced here
          // (not just in the prompt) so the rule can't be skipped.
          const diff = yield* git(cwd, ["diff", "HEAD"])
          const gate = ReviewGate.check(cwd, diff.out)
          if (!gate.ok)
            return yield* Effect.fail(
              new Error(
                `Cannot merge — ${gate.reason}. Every pull request must be peer-reviewed: run the 'review' tool on the current change set and resolve it to APPROVE before approving.`,
              ),
            )

          const add = yield* git(cwd, ["add", "-A"])
          if (add.code !== 0) return yield* Effect.fail(new Error(`git add failed: ${add.err}`))
          const commit = yield* git(cwd, ["commit", "-m", params.message])
          if (commit.code !== 0) return yield* Effect.fail(new Error(`git commit failed: ${commit.err || commit.out}`))
          const sha = yield* git(cwd, ["rev-parse", "--short", "HEAD"])
          const reviewedBy = gate.ok ? ` (peer-reviewed by ${gate.record.reviewers.join(", ")})` : ""
          return {
            title: "Change set merged",
            output: `Merged: committed ${changedFiles.length} file(s) as ${sha.out}${reviewedBy}.\n${commit.out}`,
            metadata: { action: "approve", files: changedFiles.length, clean: true },
          }
        }

        // discard
        const label = params.label?.trim() || "neko change set"
        const stash = yield* git(cwd, ["stash", "push", "-u", "-m", label])
        if (stash.code !== 0) return yield* Effect.fail(new Error(`git stash failed: ${stash.err || stash.out}`))
        return {
          title: "Change set discarded",
          output: `Stashed ${changedFiles.length} file(s) as "${label}". Recover with \`git stash pop\` if needed.`,
          metadata: { action: "discard", files: changedFiles.length, clean: true },
        }
      }).pipe(Effect.orDie),
  }),
)
