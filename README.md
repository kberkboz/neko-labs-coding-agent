<div align="center">

# Neko Labs Coding Agent

**Your AI coding team, in the terminal.**

ARIA leads a roster of specialist agents that discuss the approach, write the code, and peer-review every change before it ships. Work flows through a live pull-request process and a kanban board you can watch in real time.

[getnekolabs.com](https://getnekolabs.com)

</div>

## Why a team

Most coding agents are a single model doing everything. Neko runs a team. ARIA routes each task to the specialists that fit it, has them debate the design, hands the work to a coder, and requires a different agent to review it before anything merges. You get the judgment of an engineering team instead of one generalist.

## Features

- **Specialist agents.** Coder, researcher, analyst, red team, physicist, biologist, and more, each with its own expertise. ARIA picks the right ones for each task.
- **Enforced peer review.** Every change is reviewed by a different agent before merge, and the gate is enforced in code so nothing ships unreviewed.
- **Live kanban board.** Watch tasks move through Planning, Implementing, Peer Review, and Done, with the agents working each card.
- **Collaborative implementation.** Two agents pair on hard changes, one writing and one critiquing, until they agree.
- **Experiments.** Run the scientific method end to end, with peer review at every step.
- **Academic search.** Pull real papers from arXiv, PubMed, Semantic Scholar, and Crossref. No API key needed.
- **Bring your own models.** Major providers, free tiers, or fully local with Ollama. Set a different model per agent.

## Quickstart

Run it in any project:

```sh
neko
```

Inside the app, type `/discuss`, `/board`, `/agents`, `/task`, or `/experiment` to reach the Neko features. Other entry points: `neko run -i`, `neko serve`, and `neko agent configure`.

Configure models with `neko agent configure`, or edit `opencode.json`.

## Built on opencode

Neko Labs Coding Agent merges the Neko Labs multi-agent architecture with the [opencode](https://github.com/anomalyco/opencode) engine (MIT). opencode provides the runtime, tools, providers, server, and terminal UI. Neko adds ARIA, the specialist roster, the pull-request workflow, the board, and more. opencode is a project by anomalyco; Neko Labs is an independent fork and is not affiliated with anomalyco.

## License

MIT. See [LICENSE](LICENSE), which keeps opencode's original copyright alongside the Neko Labs copyright.
