import { createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { DialogAgentConfigure } from "./dialog-agent-configure"

// Pinned to the top of the picker, in this order; everyone else is grouped under
// the "Neko Specialist Agents" section.
const TOP = ["aria", "plan"]
const SPECIALISTS_CATEGORY = "Neko Specialist Agents"

export function DialogAgent() {
  const local = useLocal()
  const dialog = useDialog()
  const [highlighted, setHighlighted] = createSignal<string>()

  const options = createMemo(() => {
    const all = local.agent.list()
    const describe = (item: (typeof all)[number]) => {
      const model = item.model ? `${item.model.providerID}/${item.model.modelID}` : "inherits model"
      const role = item.description || (item.native ? "native" : "")
      return role ? `${role}  ·  ${model}` : model
    }
    const toOption = (item: (typeof all)[number], category?: string) => ({
      value: item.name,
      title: item.name,
      description: describe(item),
      category,
    })
    const top = TOP.flatMap((name) => {
      const item = all.find((a) => a.name === name)
      return item ? [toOption(item)] : []
    })
    const rest = all.filter((a) => !TOP.includes(a.name)).map((item) => toOption(item, SPECIALISTS_CATEGORY))
    return [...top, ...rest]
  })

  return (
    <DialogSelect
      title="Select agent"
      current={local.agent.current()?.name}
      options={options()}
      onMove={(option) => setHighlighted(option.value)}
      footerHints={[{ title: "configure", label: "tab", side: "right" }]}
      bindings={[
        {
          key: "tab",
          desc: "Configure agent",
          group: "Dialog",
          cmd: () => {
            const target = highlighted() ?? options()[0]?.value
            if (target) dialog.replace(() => <DialogAgentConfigure name={target} />)
          },
        },
      ]}
      onSelect={(option) => {
        local.agent.set(option.value)
        dialog.clear()
      }}
    />
  )
}
