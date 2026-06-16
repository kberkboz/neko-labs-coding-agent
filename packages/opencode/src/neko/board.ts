/**
 * Neko coding board — the data model behind the kanban dashboard.
 *
 * A board is a list of coding-task CARDS, each flowing left-to-right through the
 * pull-request workflow stages: planning -> implementing -> peer_review -> done.
 * Each card records which agents are currently working on it and an event log so
 * the TUI can show a card's history as it moves between columns.
 *
 * State is project-scoped Storage under ["neko","board"]. The `board` tool
 * mutates it as ARIA runs the workflow; the TUI reads it to render the columns.
 */

export const STORE_KEY: string[] = ["neko", "board"]

export type Stage = "planning" | "implementing" | "peer_review" | "done"

export const STAGES: Stage[] = ["planning", "implementing", "peer_review", "done"]

export const STAGE_LABEL: Record<Stage, string> = {
  planning: "Planning",
  implementing: "Implementing",
  peer_review: "Peer Review",
  done: "Done",
}

export interface CardEvent {
  stage: Stage
  agents: string[]
  note?: string
  ts: number
}

export interface Card {
  id: number
  title: string
  stage: Stage
  /** Agents currently working on / responsible for this card in its stage. */
  agents: string[]
  /** Latest one-line activity note. */
  note?: string
  /** Stage/agent history, newest last. */
  events: CardEvent[]
  ts: number
  updated: number
}

export interface BoardState {
  cards: Card[]
}

export const empty = (): BoardState => ({ cards: [] })

export function nextId(board: BoardState): number {
  return board.cards.reduce((max, c) => Math.max(max, c.id), 0) + 1
}

/** Compact text rendering for the tool output (the TUI renders columns itself). */
export function render(board: BoardState): string {
  if (board.cards.length === 0) return "Board is empty. Use action='create' to add a coding-task card."
  const lines: string[] = []
  for (const stage of STAGES) {
    const cards = board.cards.filter((c) => c.stage === stage)
    if (cards.length === 0) continue
    lines.push(`## ${STAGE_LABEL[stage]} (${cards.length})`)
    for (const c of cards) {
      const who = c.agents.length ? ` [${c.agents.join(", ")}]` : ""
      lines.push(`  #${c.id} ${c.title}${who}${c.note ? ` — ${c.note}` : ""}`)
    }
  }
  return lines.join("\n")
}

export * as Board from "./board"
