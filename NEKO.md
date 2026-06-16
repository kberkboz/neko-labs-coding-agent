# Neko Labs Coding Agent — architecture

Neko Labs Coding Agent is a fork of [opencode](https://github.com/anomalyco/opencode)
(MIT, by anomalyco) that grafts the **Neko Labs** multi-agent model onto opencode's
coding-agent engine. Where opencode runs a single agent, this runs a **team**:
**ARIA** orchestrates a roster of specialists who **discuss** an approach,
**implement** it, and **peer-review** the result before it reaches you. opencode is
the base engine; the Neko orchestration described below is what this fork adds.

Everything is built on opencode's existing primitives (Effect services/layers, the tool
registry, subagent sessions via `Session.create` + `promptOps`, project-scoped Storage),
so it inherits opencode's providers (BYOK / OpenRouter free models / Google Gemini free
tier / local **Ollama**), permissions, sandbox, and server/TUI/SDK.

## The agent roster

Defined in [`packages/opencode/src/neko/roster.ts`](packages/opencode/src/neko/roster.ts)
and registered as native agents in `agent/agent.ts`. **ARIA is the default agent.**

- **aria** — orchestrator (primary). Routes a task to the right specialists, runs the
  discussion + peer review, delegates implementation to the coder, and assembles the result.
- **Specialists** (subagents, read-only unless noted): `planner`, `researcher`, `analyst`,
  `coder` (the implementer — full edit/shell), `writer` (can edit docs), `physicist`,
  `biologist`, `computer_scientist`, `data_scientist`, `strategist`, `marketer`,
  `patent` (edits), `grant_writer` (edits), `red_team` (adversarial reviewer), `reviewer`.

System prompts are ported from Neko Labs' `ROLE_LIBRARY`. Permissions are job-scoped: only
the coder/writer/patent/grant agents can mutate files; analysts and reviewers are read-only.
The Ideator and the four brainstorm judges are intentionally excluded.

## Neko tools

All live in `packages/opencode/src/tool/` and are registered in `tool/registry.ts`.

| Tool | What it does |
| --- | --- |
| **discuss** | ARIA convenes named specialists in parallel for N rounds of debate on a design decision; returns a transcript to synthesize **before** code is written. |
| **review** | Captures the working-tree `git diff` and dispatches it to read-only reviewer/red_team subagents for line-cited peer review + an APPROVE/REQUEST-CHANGES verdict. |
| **experiment** | Runs the full scientific method (hypothesis → literature → feasibility → code & run → interpret → conclusion), each step routed to the right specialist with peer review. Ports Neko's `run_scientific`. |
| **coimplement** | Pair/ensemble implementation: a driver codes while partner specialists critique the diff and the driver revises, looping until they converge. |
| **board** | Drives the kanban coding board (cards through Planning → Implementing → Peer Review → Done). |
| **academic_search** | Searches real papers across arXiv / PubMed / Semantic Scholar / Crossref (free, no API key) — title, authors, year, abstract, DOI, URL. Ports Neko's `literature.py`. |
| **tasks** | Persistent, assignable backlog (add/list/assign/start/complete/decompose). The user builds a todo list; ARIA works it one task at a time, decomposing `aria`-assigned tasks into routed subtasks. |
| **knowledge** | Compact, project-scoped key→fact store (set/get/search/list). Agents pull only relevant facts as terse `key: value` lines instead of re-deriving them. |

`discuss`/`review`/`experiment` are gated behind matching permissions so read-only
specialist subagents can never recursively convene their own — only ARIA (and the built-in
`build`/`plan` agents) can. `tasks`/`knowledge` are ungated so every agent can consult them.

### Slash commands

The tools are normally driven by ARIA automatically, but they're also discoverable in the
TUI `/` palette as built-in commands that route an instruction to ARIA:

| Command | Runs |
| --- | --- |
| `/discuss <topic>` | convene a multi-agent discussion on an approach |
| `/experiment <goal>` | run a scientific-method experiment |
| `/knowledge <fact or query>` | record or search the compact knowledge store |
| `/task` | add a card to the coding board and pick its assignee |
| `/board` | open the kanban coding board |
| `/manual-review` | toggle manual peer review — `review` asks you instead of the agents |
| `/bypass` | toggle bypassing permission prompts (auto-approve — dangerous) |

You can also `@`-mention any specialist (e.g. `@red_team`, `@coder`) to pull it into a message,
and switch the active agent with `Tab`.

## Seeing & configuring agents

- **See the roster + what each is hooked to:** open the agent dialog (`Tab` / the agent
  command). Each agent now shows its role and the model it uses (or `inherits model` when it
  follows the session model).
- **Configure agents interactively:** run `neko agent configure` — pick an agent, then a
  provider, then a model; repeat for as many agents as you like. It writes the choices to
  your global config (use `--project` to scope to the current project). Non-interactive:
  `neko agent configure --agent coder --model anthropic/claude-opus-4-8`.
- **Or edit config directly** (`opencode.json`), so different specialists run on different
  providers:
  ```jsonc
  {
    "agent": {
      "coder":      { "model": "anthropic/claude-opus-4-8" },
      "researcher": { "model": "google/gemini-2.5-pro" },
      "red_team":   { "model": "openai/gpt-5.5" },
      "analyst":    { "model": "deepseek/deepseek-reasoner" }
    }
  }
  ```
  Anything not given a `model` inherits whatever model the session is on. You can also set
  `prompt`, `temperature`, `permission`, etc. per agent, and `neko agent create` scaffolds a
  brand-new one.
- ARIA is the default, full-access orchestrator; opencode's generic `build` agent is hidden
  (ARIA supersedes it). `plan` remains as a read-only planning mode.

## How a coding task flows (the pull-request workflow)

ARIA runs every coding task as a pull request and narrates each step to you:

1. **Triage** — ARIA classifies the change as **trivial** or **non-trivial** (and says why).
2. **Discussion** *(non-trivial only)* — `discuss` convenes the right small group of
   specialists (e.g. `physicist` + `coder`) to debate the specific change; ARIA
   synthesizes the consensus design before any code is written.
3. **Implementation** — routine changes: ARIA delegates to `coder` via the `task` tool.
   Tricky/high-stakes changes: ARIA uses `coimplement` — a driver (coder) writes the
   code while partner specialists critique the actual diff each round and the driver
   revises, looping until they converge (pair/ensemble programming).
4. **Pull request** — `changeset status` opens the diff as a reviewable PR.
5. **Peer review** *(mandatory, every PR)* — `review` runs the diff past a **different**
   agent than the implementer (a fresh reviewer) plus `red_team`, returning
   **APPROVE / REQUEST CHANGES**. Changes-requested loops back to step 3.
6. **Merge** — once review approves, you decide: `changeset approve` (commit = merge) or
   `changeset discard` (stash, recoverable).

**Mandatory peer review is enforced, not just prompted.** `review` records the verdict
against a hash of the exact diff it saw; `changeset approve` refuses to commit unless a
*passing* review exists for the *current* diff — so an un-reviewed or post-review-edited
change set physically cannot be merged (see
[`neko/review-gate.ts`](packages/opencode/src/neko/review-gate.ts)). Trivial changes skip
the discussion but still get a PR + peer review.

## Status

Implemented and typechecking: roster, discuss, review, coimplement, experiment,
academic_search, tasks, knowledge, the kanban board, and branding. Remaining:
standalone Discuss/Experiment TUI surfaces and provider-onboarding polish.

See `AGENTS.md` for upstream contributor conventions (they apply here too).
