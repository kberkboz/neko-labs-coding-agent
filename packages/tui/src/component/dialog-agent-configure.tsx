import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { useSync } from "../context/sync"
import {
  setAgentModel,
  setAgentTemperature,
  setAgentReasoningEffort,
  setAgentSystem,
  setAgentSteps,
} from "../neko-agent-config"

/**
 * Configure a single agent (opened with Tab from the /agents picker).
 *
 * A menu of the things you can tune per agent — model, temperature, reasoning
 * effort, system prompt, step budget — each opening a focused sub-menu. Writes
 * to the global opencode.json; takes effect on restart / reload.
 */

const EFFORTS = ["minimal", "low", "medium", "high"]

export function DialogAgentConfigure(props: { name: string }) {
  const dialog = useDialog()
  const toast = useToast()
  const sync = useSync()
  const name = props.name

  const back = () => dialog.replace(() => <DialogAgentConfigure name={name} />)
  const done = (msg: string) => {
    toast.show({ message: msg, variant: "info" })
    back()
  }

  const pickModel = () => {
    const providers = sync.data.provider
    dialog.replace(() => (
      <DialogSelect
        title={`${name} · model — pick a provider`}
        options={providers.map((p) => ({
          value: p.id,
          title: p.name ?? p.id,
          description: `${Object.keys(p.models ?? {}).length} models`,
        }))}
        onSelect={(opt) => {
          const provider = providers.find((p) => p.id === opt.value)
          if (!provider) return back()
          dialog.replace(() => (
            <DialogSelect
              title={`${name} · model — ${provider.id}`}
              options={Object.entries(provider.models ?? {}).map(([id, m]) => ({
                value: id,
                title: (m as { name?: string }).name ?? id,
                description: id,
              }))}
              onSelect={(mopt) =>
                void setAgentModel(name, `${provider.id}/${mopt.value}`).then(() =>
                  done(`${name} → ${provider.id}/${mopt.value}`),
                )
              }
            />
          ))
        }}
      />
    ))
  }

  const setTemp = () =>
    dialog.replace(() => (
      <DialogPrompt
        title={`${name} · temperature (0–2)`}
        placeholder="0.7 — lower is focused, higher is creative"
        onConfirm={(v) => {
          const n = parseFloat(v)
          if (Number.isNaN(n)) return back()
          void setAgentTemperature(name, Math.max(0, Math.min(2, n))).then(() =>
            done(`${name} temperature → ${Math.max(0, Math.min(2, n))}`),
          )
        }}
        onCancel={back}
      />
    ))

  const setEffort = () =>
    dialog.replace(() => (
      <DialogSelect
        title={`${name} · reasoning effort`}
        options={EFFORTS.map((e) => ({ value: e, title: e }))}
        onSelect={(opt) => void setAgentReasoningEffort(name, opt.value).then(() => done(`${name} reasoning → ${opt.value}`))}
      />
    ))

  const setSys = () =>
    dialog.replace(() => (
      <DialogPrompt
        title={`${name} · system prompt`}
        placeholder="Override the agent's instructions (leave blank to reset to default)"
        onConfirm={(v) => void setAgentSystem(name, v).then(() => done(`${name} system prompt updated`))}
        onCancel={back}
      />
    ))

  const setStepsAction = () =>
    dialog.replace(() => (
      <DialogPrompt
        title={`${name} · max steps`}
        placeholder="agentic iteration budget, e.g. 40"
        onConfirm={(v) => {
          const n = parseInt(v, 10)
          if (Number.isNaN(n)) return back()
          void setAgentSteps(name, n).then(() => done(`${name} max steps → ${n}`))
        }}
        onCancel={back}
      />
    ))

  const options = [
    { value: "model", title: "Model", description: "provider / model", onSelect: () => pickModel() },
    { value: "temperature", title: "Temperature", description: "0–2 (focused ↔ creative)", onSelect: () => setTemp() },
    { value: "reasoning", title: "Reasoning effort", description: "minimal → high", onSelect: () => setEffort() },
    { value: "system", title: "System prompt", description: "override the agent's instructions", onSelect: () => setSys() },
    { value: "steps", title: "Max steps", description: "agentic iteration budget", onSelect: () => setStepsAction() },
  ]

  return <DialogSelect title={`Configure ${name}`} options={options} />
}
