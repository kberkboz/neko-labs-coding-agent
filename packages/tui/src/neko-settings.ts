import { Global } from "@opencode-ai/core/global"
import { readJson, writeJsonAtomic } from "./util/persistence"
import path from "path"

/**
 * Neko runtime toggles.
 *
 * - bypass permissions: TUI-local (KV) — the permission prompt auto-approves
 *   while it's on.
 * - manual peer review: must reach the server-side `review` tool, so it lives in
 *   a shared settings file (same storage dir the board uses) that both the TUI
 *   command and the review tool read.
 */

// KV key (TUI-local) for the bypass-permissions toggle.
export const BYPASS_PERMISSIONS_KEY = "neko_bypass_permissions"

// Shared settings file read by the server-side review tool.
export const NEKO_SETTINGS_FILE = path.join(Global.Path.data, "storage", "neko", "settings.json")

export interface NekoSettings {
  manualReview?: boolean
}

export async function readNekoSettings(): Promise<NekoSettings> {
  return readJson<NekoSettings>(NEKO_SETTINGS_FILE).catch(() => ({}) as NekoSettings)
}

export async function setManualReview(value: boolean): Promise<void> {
  const current = await readNekoSettings()
  await writeJsonAtomic(NEKO_SETTINGS_FILE, { ...current, manualReview: value })
}
