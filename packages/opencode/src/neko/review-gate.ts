/**
 * Mandatory peer-review gate for the Neko pull-request workflow.
 *
 * The rule the user asked for: *every* pull request must be peer-reviewed before
 * it merges. We enforce this deterministically rather than trusting the model to
 * remember — the `review` tool records the review it performed (keyed by a hash
 * of the exact diff it saw), and `changeset approve` (the "merge") refuses to
 * commit unless a matching, passing review exists for the current diff.
 *
 * Hashing the diff means editing the code after a review invalidates the
 * approval: ARIA must re-review the new state before it can merge. State is
 * process-local (a Map) — both tools run in the same server process, and a
 * review only needs to gate the merge that follows it in the same session.
 */
import { createHash } from "crypto"

export type Verdict = "APPROVE" | "REQUEST CHANGES"

export interface ReviewRecord {
  hash: string
  reviewers: string[]
  verdict: Verdict
  at: number
}

const records = new Map<string, ReviewRecord>()

export function diffHash(diff: string): string {
  // Normalise (trim) so the `review` tool's raw capture and `changeset`'s
  // trimmed capture of the same `git diff HEAD` hash identically.
  return createHash("sha1").update(diff.trim()).digest("hex").slice(0, 16)
}

/** Infer the overall verdict from the reviewers' combined text. */
export function inferVerdict(text: string): Verdict {
  return /request\s*changes/i.test(text) ? "REQUEST CHANGES" : "APPROVE"
}

export function record(worktree: string, diff: string, reviewers: string[], verdict: Verdict): ReviewRecord {
  const rec: ReviewRecord = { hash: diffHash(diff), reviewers, verdict, at: Date.now() }
  records.set(worktree, rec)
  return rec
}

export type GateResult =
  | { ok: true; record: ReviewRecord }
  | { ok: false; reason: string }

/** Check whether the current diff has a passing peer review on file. */
export function check(worktree: string, diff: string): GateResult {
  const rec = records.get(worktree)
  if (!rec) return { ok: false, reason: "this change set has not been peer-reviewed yet" }
  if (rec.hash !== diffHash(diff))
    return { ok: false, reason: "the change set changed since the last peer review" }
  if (rec.verdict === "REQUEST CHANGES")
    return { ok: false, reason: `the last peer review (${rec.reviewers.join(", ")}) requested changes` }
  return { ok: true, record: rec }
}

export * as ReviewGate from "./review-gate"
