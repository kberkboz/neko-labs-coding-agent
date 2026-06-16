import * as Tool from "./tool"
import { Effect, Schema } from "effect"
import { Storage } from "@/storage/storage"

/**
 * Neko "Tasks": a persistent, user-facing, assignable backlog shared by the
 * whole team (distinct from the ephemeral in-session `todowrite` checklist).
 *
 * The user builds a todo list; ARIA works through it one task at a time. Each
 * task is assigned to a specific agent or to `aria` (auto: ARIA decomposes it
 * into subtasks and routes them). This tool owns the LIST + STATUS; ARIA drives
 * execution with its normal discuss/task/review flow and reports completion back
 * here.
 *
 * Storage-backed (project-scoped), ungated so any agent can read/update it.
 */

const STORE_KEY = ["neko", "tasks"]
const DESC_PREVIEW = 100

type Status = "pending" | "in_progress" | "done"
interface Task {
  id: number
  description: string
  assignee: string
  status: Status
  parentId?: number
  result?: string
  ts: number
}
interface Store {
  tasks: Task[]
}

export const Parameters = Schema.Struct({
  action: Schema.Literals(["add", "list", "assign", "start", "complete", "decompose", "delete"]).annotate({
    description: "add | list | assign | start | complete | decompose | delete",
  }),
  description: Schema.optional(Schema.String).annotate({ description: "Task description (required for add)." }),
  assignee: Schema.optional(Schema.String).annotate({
    description: "Agent name to own the task, or 'aria' for auto-decompose/route (add/assign). Defaults to 'aria'.",
  }),
  id: Schema.optional(Schema.Number).annotate({ description: "Task id (assign/start/complete/decompose/delete)." }),
  result: Schema.optional(Schema.String).annotate({ description: "Outcome note when completing a task." }),
  subtasks: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Subtask descriptions when decomposing a parent task (decompose).",
  }),
})

type Metadata = { action: string; pending: number; total: number }

const STATUS_MARK: Record<Status, string> = { pending: "[ ]", in_progress: "[~]", done: "[x]" }

function render(tasks: Task[]) {
  if (tasks.length === 0) return "No tasks yet. Use action='add' to build the list."
  const byParent = (parentId?: number) => tasks.filter((t) => t.parentId === parentId)
  const lines: string[] = ["TASKS:"]
  const line = (t: Task, indent: string) => {
    const desc = t.description.length > DESC_PREVIEW ? t.description.slice(0, DESC_PREVIEW) + "…" : t.description
    return `${indent}#${t.id} ${STATUS_MARK[t.status]} (@${t.assignee}) ${desc}${t.result ? ` — ${t.result.slice(0, 80)}` : ""}`
  }
  for (const top of byParent(undefined)) {
    lines.push(line(top, "  "))
    for (const child of byParent(top.id)) lines.push(line(child, "    "))
  }
  return lines.join("\n")
}

export const TasksTool = Tool.define<typeof Parameters, Metadata, Storage.Service>(
  "tasks",
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const load = storage
      .read<Store>(STORE_KEY)
      .pipe(Effect.catch(() => Effect.succeed({ tasks: [] } as Store)))

    const run = Effect.fn("TasksTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context<Metadata>,
    ) {
      const store = yield* load
      const nextId = () => store.tasks.reduce((max, t) => Math.max(max, t.id), 0) + 1
      const find = (id?: number) => store.tasks.find((t) => t.id === id)
      const save = storage.write(STORE_KEY, store)
      const meta = () => ({
        action: params.action,
        pending: store.tasks.filter((t) => t.status === "pending").length,
        total: store.tasks.length,
      })
      const done = function* (title: string, extra = "") {
        yield* save
        yield* ctx.metadata({ title, metadata: meta() })
        return { title, output: [extra, render(store.tasks)].filter(Boolean).join("\n\n"), metadata: meta() }
      }

      if (params.action === "add") {
        if (!params.description) return yield* Effect.fail(new Error("tasks add requires 'description'"))
        const task: Task = {
          id: nextId(),
          description: params.description,
          assignee: params.assignee?.trim() || "aria",
          status: "pending",
          ts: Date.now(),
        }
        store.tasks.push(task)
        return yield* done(`Added task #${task.id}`, `Added #${task.id} (@${task.assignee}).`)
      }

      if (params.action === "assign") {
        const task = find(params.id)
        if (!task) return yield* Effect.fail(new Error(`No task #${params.id}`))
        if (!params.assignee) return yield* Effect.fail(new Error("tasks assign requires 'assignee'"))
        task.assignee = params.assignee.trim()
        return yield* done(`Assigned #${task.id} -> @${task.assignee}`)
      }

      if (params.action === "start") {
        const task = find(params.id)
        if (!task) return yield* Effect.fail(new Error(`No task #${params.id}`))
        task.status = "in_progress"
        return yield* done(`Started #${task.id}`)
      }

      if (params.action === "complete") {
        const task = find(params.id)
        if (!task) return yield* Effect.fail(new Error(`No task #${params.id}`))
        task.status = "done"
        if (params.result) task.result = params.result
        return yield* done(`Completed #${task.id}`)
      }

      if (params.action === "delete") {
        const task = find(params.id)
        if (!task) return yield* Effect.fail(new Error(`No task #${params.id}`))
        store.tasks = store.tasks.filter((t) => t.id !== task.id && t.parentId !== task.id)
        return yield* done(`Deleted #${task.id}`)
      }

      if (params.action === "decompose") {
        const task = find(params.id)
        if (!task) return yield* Effect.fail(new Error(`No task #${params.id}`))
        const subs = (params.subtasks ?? []).map((s) => s.trim()).filter(Boolean)
        if (subs.length === 0) return yield* Effect.fail(new Error("tasks decompose requires non-empty 'subtasks'"))
        task.status = "in_progress"
        for (const description of subs) {
          store.tasks.push({
            id: nextId(),
            description,
            assignee: task.assignee,
            status: "pending",
            parentId: task.id,
            ts: Date.now(),
          })
        }
        return yield* done(`Decomposed #${task.id} into ${subs.length} subtasks`)
      }

      // list
      yield* ctx.metadata({ title: "Tasks", metadata: meta() })
      return { title: "Tasks", output: render(store.tasks), metadata: meta() }
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
  "Manage the project's persistent, assignable task backlog (distinct from your in-session todowrite checklist).",
  "When the user gives you a list of things to do, action='add' each one (with an optional assignee = an agent name, or 'aria' to auto-handle). Then work through PENDING tasks one at a time: action='start', do the work (discuss -> implement -> review), then action='complete' with a short result.",
  "If a task is assigned to a specific agent, delegate it to that agent via the task tool. If assigned to 'aria', either do it yourself or action='decompose' it into subtasks and route those.",
  "Actions: add, list, assign, start, complete, decompose (id + subtasks), delete. Always 'list' to see current state.",
].join("\n")
