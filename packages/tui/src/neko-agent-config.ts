import { Global } from "@opencode-ai/core/global"
import { readJson, writeJsonAtomic } from "./util/persistence"
import path from "path"

/**
 * Per-agent configuration writer for the /agents → configure flow.
 *
 * Writes to the global opencode.json under `agent.<name>.*`, the same place the
 * `neko agent configure` CLI uses. opencode reads these on next start / reload:
 *   - model:  "provider/model"
 *   - system: system-prompt override
 *   - steps:  max agentic iterations
 *   - request.body.temperature / reasoningEffort: passed through to the provider
 */

const CONFIG_FILE = path.join(Global.Path.config, "opencode.json")

type AgentConfig = {
  model?: string
  system?: string
  steps?: number
  request?: { body?: Record<string, unknown> }
  [k: string]: unknown
}
type Config = { agent?: Record<string, AgentConfig>; [k: string]: unknown }

async function read(): Promise<Config> {
  return readJson<Config>(CONFIG_FILE).catch(() => ({}) as Config)
}

async function update(name: string, fn: (agent: AgentConfig) => void): Promise<void> {
  const config = await read()
  config.agent ??= {}
  config.agent[name] ??= {}
  fn(config.agent[name])
  await writeJsonAtomic(CONFIG_FILE, config)
}

export async function getAgentConfig(name: string): Promise<AgentConfig> {
  const config = await read()
  return config.agent?.[name] ?? {}
}

export const setAgentModel = (name: string, model: string) => update(name, (a) => void (a.model = model))
export const setAgentSystem = (name: string, system: string) =>
  update(name, (a) => void (system.trim() ? (a.system = system) : delete a.system))
export const setAgentSteps = (name: string, steps: number) => update(name, (a) => void (a.steps = steps))

function setBody(name: string, key: string, value: unknown) {
  return update(name, (a) => {
    a.request ??= {}
    a.request.body ??= {}
    if (value === undefined || value === "") delete a.request.body[key]
    else a.request.body[key] = value
  })
}
export const setAgentTemperature = (name: string, temperature: number) =>
  setBody(name, "temperature", temperature)
export const setAgentReasoningEffort = (name: string, effort: string) =>
  setBody(name, "reasoningEffort", effort || undefined)

export const AGENT_CONFIG_FILE = CONFIG_FILE
