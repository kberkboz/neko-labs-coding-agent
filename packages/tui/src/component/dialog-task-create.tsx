import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useLocal } from "../context/local"
import { useToast } from "../ui/toast"
import { Global } from "@opencode-ai/core/global"
import { readJson, writeJsonAtomic } from "../util/persistence"
import path from "path"

/**
 * /task — add a card to the coding board and pick who it's assigned to.
 *
 * Step 1: prompt for the task title. Step 2: a submenu to choose the assignee
 * agent (or ARIA, to auto-route). Writes a Planning card straight into the board
 * file the `board` tool / kanban dialog read, so the new task shows up on the
 * board and ARIA can pick it up.
 */

const BOARD_FILE = path.join(Global.Path.data, "storage", "neko", "board.json")

interface Card {
  id: number
  title: string
  stage: string
  agents: string[]
  note?: string
  events: { stage: string; agents: string[]; note?: string; ts: number }[]
  ts: number
  updated: number
}

async function addCard(title: string, assignee: string): Promise<number> {
  const board = await readJson<{ cards?: Card[] }>(BOARD_FILE).catch(() => ({ cards: [] as Card[] }))
  const cards = Array.isArray(board?.cards) ? board!.cards! : []
  const id = cards.reduce((max, c) => Math.max(max, c?.id ?? 0), 0) + 1
  const now = Date.now()
  const agents = assignee && assignee !== "aria" ? [assignee] : []
  const note = assignee === "aria" ? "queued — ARIA to route" : `queued — assigned to ${assignee}`
  cards.push({
    id,
    title,
    stage: "planning",
    agents,
    note,
    events: [{ stage: "planning", agents, note, ts: now }],
    ts: now,
    updated: now,
  })
  await writeJsonAtomic(BOARD_FILE, { cards })
  return id
}

export function DialogTaskCreate() {
  const dialog = useDialog()
  const local = useLocal()
  const toast = useToast()

  const pickAssignee = (title: string) => {
    const rest = local.agent
      .list()
      .filter((a) => a.name !== "aria")
      .map((a) => ({ value: a.name, title: a.name, description: a.description || "", category: "Assign to a specialist" }))
    const options = [
      { value: "aria", title: "ARIA — auto-route", description: "Let ARIA decide and route the task" },
      ...rest,
    ]
    dialog.replace(() => (
      <DialogSelect
        title="Assign task to"
        options={options}
        onSelect={(option) => {
          void addCard(title, option.value).then(
            (id) => toast.show({ message: `Added task #${id} to the board (@${option.value})`, variant: "info" }),
            () => toast.show({ message: "Failed to add task to the board", variant: "error" }),
          )
          dialog.clear()
        }}
      />
    ))
  }

  return (
    <DialogPrompt
      title="New task"
      placeholder="What should be done?"
      onConfirm={(value) => {
        const title = value.trim()
        if (!title) {
          dialog.clear()
          return
        }
        pickAssignee(title)
      }}
      onCancel={() => dialog.clear()}
    />
  )
}
