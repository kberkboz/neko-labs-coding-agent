import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"

/**
 * Compact knowledge store for the Neko agent team.
 *
 * A small, project-scoped key -> fact store (backed by opencode's Storage
 * service) that any agent can read or write. The point is COMPACT access:
 * agents `search`/`list` to pull only the few relevant facts as terse
 * `key: value` lines (mirroring Neko Labs' format_knowledge_for_prompt) rather
 * than dumping a whole knowledge base into context.
 *
 * Not gated by a permission so read-only specialists can still consult it
 * during discussion and review.
 */

const STORE_KEY = ["neko", "knowledge"]
const SEARCH_LIMIT = 20
const VALUE_PREVIEW = 160

interface Entry {
  value: string
  source?: string
  ts: number
}
type Store = Record<string, Entry>

export const Parameters = Schema.Struct({
  action: Schema.Literals(["set", "get", "search", "list", "delete"]).annotate({
    description: "set | get | search | list | delete",
  }),
  key: Schema.optional(Schema.String).annotate({
    description: "Fact key (required for set/get/delete). Short, stable, snake_case (e.g. 'build_command').",
  }),
  value: Schema.optional(Schema.String).annotate({ description: "Fact value (required for set)." }),
  query: Schema.optional(Schema.String).annotate({ description: "Search text (required for search)." }),
  source: Schema.optional(Schema.String).annotate({ description: "Optional provenance note for a set fact." }),
})

type Metadata = { action: string; count: number }

const preview = (value: string) => (value.length > VALUE_PREVIEW ? value.slice(0, VALUE_PREVIEW) + "…" : value)
const line = (key: string, entry: Entry) => `  ${key}: ${preview(entry.value)}`

export const KnowledgeTool = Tool.define<typeof Parameters, Metadata, Storage.Service>(
  "knowledge",
  Effect.gen(function* () {
    const storage = yield* Storage.Service

    const load = storage.read<Store>(STORE_KEY).pipe(Effect.catch(() => Effect.succeed({} as Store)))

    const run = Effect.fn("KnowledgeTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const store = yield* load

      if (params.action === "set") {
        if (!params.key || params.value === undefined)
          return yield* Effect.fail(new Error("knowledge set requires both 'key' and 'value'"))
        store[params.key] = { value: params.value, source: params.source, ts: Date.now() }
        yield* storage.write(STORE_KEY, store)
        yield* ctx.metadata({ title: `knowledge set ${params.key}`, metadata: { action: "set", count: 1 } })
        return { title: `Saved knowledge: ${params.key}`, output: `Saved.\n${line(params.key, store[params.key])}`, metadata: { action: "set", count: 1 } }
      }

      if (params.action === "get") {
        if (!params.key) return yield* Effect.fail(new Error("knowledge get requires 'key'"))
        const entry = store[params.key]
        const output = entry
          ? `${params.key}: ${entry.value}${entry.source ? `\n(source: ${entry.source})` : ""}`
          : `No knowledge stored under '${params.key}'.`
        return { title: `knowledge ${params.key}`, output, metadata: { action: "get", count: entry ? 1 : 0 } }
      }

      if (params.action === "delete") {
        if (!params.key) return yield* Effect.fail(new Error("knowledge delete requires 'key'"))
        const existed = params.key in store
        delete store[params.key]
        yield* storage.write(STORE_KEY, store)
        return { title: `knowledge delete ${params.key}`, output: existed ? `Deleted '${params.key}'.` : `Nothing stored under '${params.key}'.`, metadata: { action: "delete", count: existed ? 1 : 0 } }
      }

      if (params.action === "search") {
        if (!params.query) return yield* Effect.fail(new Error("knowledge search requires 'query'"))
        const q = params.query.toLowerCase()
        const hits = Object.entries(store)
          .filter(([key, entry]) => key.toLowerCase().includes(q) || entry.value.toLowerCase().includes(q))
          .sort((a, b) => b[1].ts - a[1].ts)
          .slice(0, SEARCH_LIMIT)
        const output = hits.length
          ? ["KNOWLEDGE (matches):", ...hits.map(([key, entry]) => line(key, entry))].join("\n")
          : `No knowledge matches '${params.query}'.`
        return { title: `knowledge search ${params.query}`, output, metadata: { action: "search", count: hits.length } }
      }

      // list
      const entries = Object.entries(store).sort((a, b) => b[1].ts - a[1].ts)
      const output = entries.length
        ? ["KNOWLEDGE (all):", ...entries.map(([key, entry]) => line(key, entry))].join("\n")
        : "No knowledge stored yet. Use action='set' to record durable facts."
      return { title: "knowledge list", output, metadata: { action: "list", count: entries.length } }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)

const DESCRIPTION = [
  "Compact, project-scoped knowledge store shared by the whole agent team.",
  "Record durable facts the team should remember (build/test commands, architecture decisions, conventions, gotchas) with action='set' (key + value).",
  "Retrieve them compactly with action='search' (query) or action='list' — results come back as terse `key: value` lines, so pull only what's relevant instead of re-deriving it.",
  "Also supports action='get' (single key) and action='delete'. Keys should be short, stable, and snake_case.",
].join("\n")
