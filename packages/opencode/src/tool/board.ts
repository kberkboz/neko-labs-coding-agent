import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"
import { Board } from "../neko/board"
import type { Stage, BoardState } from "../neko/board"

/**
 * Neko coding board — the tool ARIA drives to move coding-task cards through the
 * kanban columns (planning -> implementing -> peer_review -> done) as it runs the
 * pull-request workflow. The TUI renders the same state as columns of cards.
 *
 * Storage-backed (project-scoped), ungated so any agent can read/update it.
 */

const STAGES: Stage[] = ["planning", "implementing", "peer_review", "done"]

export const Parameters = Schema.Struct({
  action: Schema.Literals(["create", "move", "update", "list", "delete", "clear"]).annotate({
    description: "create (new card) | move (to a stage) | update (agents/note) | list | delete | clear (remove done)",
  }),
  title: Schema.optional(Schema.String).annotate({ description: "Card title (required for create)." }),
  id: Schema.optional(Schema.Number).annotate({ description: "Card id (move/update/delete)." }),
  stage: Schema.optional(Schema.Literals(STAGES)).annotate({
    description: "Target stage for move: planning | implementing | peer_review | done.",
  }),
  agents: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Agents currently working on this card in its stage (e.g. ['coder','physicist']).",
  }),
  note: Schema.optional(Schema.String).annotate({ description: "Short activity note shown on the card." }),
})

type Metadata = { action: string; total: number; done: number }

export const BoardTool = Tool.define<typeof Parameters, Metadata, Storage.Service>(
  "board",
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const load = storage.read<BoardState>(Board.STORE_KEY).pipe(Effect.catch(() => Effect.succeed(Board.empty())))

    const run = Effect.fn("BoardTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const board = yield* load
      const find = (id?: number) => board.cards.find((c) => c.id === id)
      const meta = () => ({
        action: params.action,
        total: board.cards.length,
        done: board.cards.filter((c) => c.stage === "done").length,
      })
      const finish = function* (title: string, extra = "") {
        yield* storage.write(Board.STORE_KEY, board)
        yield* ctx.metadata({ title, metadata: meta() })
        return { title, output: [extra, Board.render(board)].filter(Boolean).join("\n\n"), metadata: meta() }
      }

      if (params.action === "create") {
        if (!params.title) return yield* Effect.fail(new Error("board create requires 'title'"))
        const now = Date.now()
        const agents = (params.agents ?? []).map((a) => a.trim()).filter(Boolean)
        const card = {
          id: Board.nextId(board),
          title: params.title,
          stage: "planning" as Stage,
          agents,
          note: params.note,
          events: [{ stage: "planning" as Stage, agents, note: params.note, ts: now }],
          ts: now,
          updated: now,
        }
        board.cards.push(card)
        return yield* finish(`Card #${card.id} → Planning`, `Created card #${card.id}: ${card.title}`)
      }

      if (params.action === "move") {
        const card = find(params.id)
        if (!card) return yield* Effect.fail(new Error(`No card #${params.id}`))
        if (!params.stage) return yield* Effect.fail(new Error("board move requires 'stage'"))
        // A card cannot reach Done without passing through Peer Review — this is
        // how the kanban enforces that every change is reviewed before it's done.
        if (params.stage === "done") {
          const reviewed = card.stage === "peer_review" || card.events.some((e) => e.stage === "peer_review")
          if (!reviewed)
            return yield* Effect.fail(
              new Error(
                `Card #${card.id} can't move to Done — it has not been through Peer Review. Move it to 'peer_review' and run the 'review' tool first.`,
              ),
            )
        }
        const now = Date.now()
        card.stage = params.stage
        if (params.agents) card.agents = params.agents.map((a) => a.trim()).filter(Boolean)
        if (params.note !== undefined) card.note = params.note
        card.updated = now
        card.events.push({ stage: card.stage, agents: card.agents, note: card.note, ts: now })
        return yield* finish(`Card #${card.id} → ${stageLabel(card.stage)}`)
      }

      if (params.action === "update") {
        const card = find(params.id)
        if (!card) return yield* Effect.fail(new Error(`No card #${params.id}`))
        if (params.agents) card.agents = params.agents.map((a) => a.trim()).filter(Boolean)
        if (params.note !== undefined) card.note = params.note
        card.updated = Date.now()
        return yield* finish(`Updated card #${card.id}`)
      }

      if (params.action === "delete") {
        const card = find(params.id)
        if (!card) return yield* Effect.fail(new Error(`No card #${params.id}`))
        board.cards = board.cards.filter((c) => c.id !== card.id)
        return yield* finish(`Deleted card #${card.id}`)
      }

      if (params.action === "clear") {
        const removed = board.cards.filter((c) => c.stage === "done").length
        board.cards = board.cards.filter((c) => c.stage !== "done")
        return yield* finish(`Cleared ${removed} done card(s)`)
      }

      // list
      yield* ctx.metadata({ title: "Coding board", metadata: meta() })
      return { title: "Coding board", output: Board.render(board), metadata: meta() }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

function stageLabel(stage: Stage) {
  return Board.STAGE_LABEL[stage]
}

const DESCRIPTION = [
  "Drive the Neko coding board (the kanban dashboard the user watches). Create a CARD per coding task and move it through the columns as you run the pull-request workflow: planning -> implementing -> peer_review -> done.",
  "Keep the card's 'agents' current so the user can see who is working on each task: in planning, the discussion participants; in implementing, the coder(s); in peer_review, the reviewer(s). Add a short 'note' describing the current activity.",
  "Actions: create (title, optional agents/note), move (id, stage, optional agents/note), update (id, agents/note), list, delete, clear (remove done cards).",
].join("\n")
