import { TextAttributes } from "@opentui/core"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { Global } from "@opencode-ai/core/global"
import { readJson } from "../util/persistence"
import path from "path"

/**
 * Neko coding board — the kanban dashboard. Reads the board state the `board`
 * tool writes (Global storage: neko/board.json) and renders the cards as columns
 * that work flows through: Planning → Implementing → Peer Review → Done. Polls so
 * cards visibly move across the columns as ARIA runs the workflow.
 */

type Stage = "planning" | "implementing" | "peer_review" | "done"
interface Card {
  id: number
  title: string
  stage: Stage
  agents: string[]
  note?: string
}
interface BoardState {
  cards: Card[]
}

const COLUMNS: { stage: Stage; label: string }[] = [
  { stage: "planning", label: "Planning" },
  { stage: "implementing", label: "Implementing" },
  { stage: "peer_review", label: "Peer Review" },
  { stage: "done", label: "Done" },
]

const BOARD_FILE = path.join(Global.Path.data, "storage", "neko", "board.json")

export function DialogBoard() {
  const { theme } = useTheme()
  const dialog = useDialog()
  const [cards, setCards] = createSignal<Card[]>([])

  const refresh = () =>
    readJson<BoardState>(BOARD_FILE)
      .then((data) => setCards(Array.isArray(data?.cards) ? data.cards : []))
      .catch(() => setCards([]))

  onMount(() => {
    dialog.setSize("xlarge")
    void refresh()
    const timer = setInterval(() => void refresh(), 1500)
    onCleanup(() => clearInterval(timer))
  })

  const stageColor = (stage: Stage) =>
    stage === "planning"
      ? theme.primary
      : stage === "implementing"
        ? theme.warning
        : stage === "peer_review"
          ? theme.accent
          : theme.success

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1} width="100%">
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text} attributes={TextAttributes.BOLD}>
          Coding board
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>

      <Show
        when={cards().length > 0}
        fallback={
          <text fg={theme.textMuted}>
            No cards yet. ARIA opens a card for each coding task and moves it across the columns as the team works.
          </text>
        }
      >
        <box flexDirection="row" gap={1}>
          <For each={COLUMNS}>
            {(col) => {
              const inColumn = () => cards().filter((c) => c.stage === col.stage)
              return (
                <box flexGrow={1} flexBasis={0} gap={1}>
                  <box flexDirection="row" justifyContent="space-between" borderStyle="single" borderColor={stageColor(col.stage)} paddingLeft={1} paddingRight={1}>
                    <text fg={stageColor(col.stage)} attributes={TextAttributes.BOLD}>
                      {col.label}
                    </text>
                    <text fg={theme.textMuted}>{inColumn().length}</text>
                  </box>
                  <For each={inColumn()}>
                    {(card) => (
                      <box
                        borderStyle="single"
                        borderColor={theme.textMuted}
                        paddingLeft={1}
                        paddingRight={1}
                        gap={0}
                      >
                        <text fg={theme.text} wrapMode="word">
                          <span style={{ fg: theme.textMuted }}>#{card.id} </span>
                          {card.title}
                        </text>
                        <Show when={card.agents.length > 0}>
                          <text fg={stageColor(card.stage)} wrapMode="word">
                            {card.agents.join(" · ")}
                          </text>
                        </Show>
                        <Show when={card.note}>
                          <text fg={theme.textMuted} wrapMode="word">
                            {card.note}
                          </text>
                        </Show>
                      </box>
                    )}
                  </For>
                </box>
              )
            }}
          </For>
        </box>
      </Show>
    </box>
  )
}
