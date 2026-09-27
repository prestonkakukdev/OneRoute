# OneRoute Code: coding harness design

Status: design, before the first spike. Branch: `harness`.

## Goal

Build with OneRoute, not only chat with it. A **Code** mode in the web app (a Chat | Code toggle, like
ChatGPT ↔ Codex) where an agent reads, edits, runs and tests a real project on the user's machine. What makes it
OneRoute: **each part of the work goes to the model best suited to it** — planning, exploring, implementing,
reviewing and fixing are routed separately, using the same Jev reading and capability database as chat.

Principles:

- **Route per sub-task, not per message.** Switching models mid-task throws away the prompt cache and the thread
  of the work. A sub-task keeps its model; the next one is routed afresh.
- **Escalate on evidence.** Failing tests move a sub-task to a higher effort or a stronger model.
- **Tests are the success signal.** Pass/fail after an agent's changes is objective feedback for routing, far
  richer than 👍/👎.
- **Never touch the user's checkout mid-task.** Work happens in a git worktree; the user applies or discards it.
- **Auto-edit by default, ask before danger.** Edits inside the task's worktree run without prompts; dangerous
  commands wait for approval. (The agent-defense system plugs in here later.)
- **Every step is visible and costed.** Which model did what, why, and what it cost.

Provenance: this design is built from publicly documented concepts and permissively licensed harnesses
(OpenAI Codex CLI, OpenCode, Aider, OpenHands). No code, names or structure are taken from unlicensed sources.

## Where it lives

- **Repo:** same repository, same packages for now; the harness is `src/harness/` (server) and `web/src/code/`
  (UI), sharing the router, store and gateway. It needs the router for every model decision and feeds it outcomes,
  so a separate repo or long-lived branch would drift. If it grows, split into `packages/`.
- **Runtime:** the local OneRoute server (the background service) runs the agent. The browser is the interface;
  commands and file edits happen on the user's machine, inside a worktree of the project they pick.
- **Transport:** one SSE stream per run (events below); plain POSTs to approve, deny, stop, apply, discard.

## Architecture

```
Web app (Code mode) ──SSE/POST──► Harness session ──► Orchestrator ──► Agent loop (per role / sub-task)
                                        │                  │                  │
                                        │                  │                  ├─ Router: Jev + optimizer pick model/effort
                                        │                  │                  ├─ Executor: OpenRouter, streaming, tools
                                        │                  │                  └─ Tools ─► Permission check ─► Worktree
                                        └─ Store (SQLite): sessions, steps, checkpoints, costs, outcomes
```

### Agent loop

1. Build the request: system prompt for the role, project context, conversation so far, the role's tools.
2. Route: Jev classifies the (sub-)task once; the router picks model and effort with the role's requirements
   (below). The choice sticks for the sub-task.
3. Stream the answer. Text streams to the UI; tool calls are collected as they arrive.
4. For each tool call: validate arguments with Zod → permission check → run → append a (truncated) result.
5. Repeat until the model finishes, a step or cost budget is hit, a loop is detected, or the user stops it.

Budgets: max steps and max cost per run (warn at 80 %, stop at 100 %); the same failing call repeated three times
counts as a loop and escalates or stops.

### Tools

Each tool is one module: **name, description, Zod input schema, permission class, execute**. Permission classes:
`read`, `edit` (inside the worktree), `exec`, `network`, `dangerous`.

| Tool | Class | Notes |
|---|---|---|
| `list_files` / `glob` | read | respects .gitignore |
| `grep` | read | ripgrep-style, capped results |
| `read_file` | read | line ranges; records what was read (for edit safety) |
| `edit_file` | edit | replace an exact snippet; must match exactly once; the file must have been read and unchanged since |
| `write_file` | edit | new files (or full rewrites of small files) |
| `bash` | exec | cwd = worktree, timeout, output cap; classified per command (below) |
| `todo` | — | the agent's visible task list |
| `finish` | — | summary of what changed and how it was verified |

Later: `web_fetch` (network), LSP (diagnostics, go-to-definition, references), MCP servers, sub-agent tools, and a
tool-search tool once there are enough tools that sending every schema costs real tokens.

### Permissions

Modes (per session, switchable in the composer):

- **Auto-edit** (default): read and edit tools run freely inside the worktree; `exec` runs unless classified
  dangerous; dangerous actions show an approval card.
- **Ask**: every edit and command needs approval.
- **Plan**: read-only; the agent researches and proposes a plan for approval before any change.

Dangerous (always asks in auto-edit): `git push` and other remote-changing git, deleting outside the worktree,
`rm -rf` on broad paths, `sudo`, piping downloads into a shell, package publishing, writes outside the worktree,
anything touching credentials or `~/.ssh`. The classifier is a function, so the **agent-defense system** can replace
or extend it later.

### Workspace isolation

- The user picks a project folder (a git repo) and a base branch.
- Each run gets a worktree under `~/.oneroute/worktrees/<session>` on a new branch.
- The UI shows the diff as it grows. **Apply** commits to the new branch and merges/cherry-picks into the user's
  branch (asks first); **Discard** removes the worktree and branch.
- Checkpoints: a snapshot (commit on the worktree branch) after each successful step, so any step can be undone.

### Context management

- Project instructions: `AGENTS.md` (and `README.md` excerpt) at the root.
- Repo map: file tree plus top-level symbols, trimmed to a budget.
- Read tracking: edits require a prior read of that file and fail if it changed since (hash).
- Tool output truncation: keep head and tail, say what was cut.
- Compaction: near the model's context limit, a cheap reliable model summarises older turns and stale tool results;
  the plan, todo list and recent turns stay verbatim.
- Prompt caching: the router's session stickiness and cache planning apply per sub-task.

### Routing by role

The router gets the role as a hint; the role sets requirement weights and hard filters on top of Jev's reading.

| Role | Needs | Hard requirements |
|---|---|---|
| Planner | reasoning, software engineering | tools, long context |
| Explorer | long context, speed, low cost | tools |
| Implementer | code generation, agentic tool use | tools, strong tool-call reliability |
| Reviewer | code debugging, a **different model family** from the implementer | tools |
| Test fixer | code debugging; escalates effort on repeated failure | tools |
| Summariser | accuracy, lowest cost | none |

Outcome signals per step (tests pass/fail, edits applied/reverted, user approve/deny) are recorded against the
model and effort that produced them.

### Verification

Detect the project's test, lint and type-check commands (package.json scripts, Makefile, pyproject, …), run them after
changes, and feed failures back to the implementer or test fixer. The final summary states what was verified.

### Multi-agent (phase 3)

An orchestrator splits a task into sub-tasks with roles. Sub-agents run with their own context and return a
Zod-validated structured result (so the parent's context stays small). Explorer and reviewer can run in parallel;
edits stay serial per worktree.

## UI (web app, Code mode)

- Header: **Chat | Code** toggle.
- Left: code sessions, grouped by project; project and branch picker.
- Centre: the run timeline — messages, tool-call cards (collapsible output), approval cards, the todo list, and a
  routing chip per step (role · model · effort · cost).
- Right (tabs): **Changes** (diff per file, apply/discard), **Files**, **Terminal** (command output),
  **Inspector** (why each model was chosen, cost so far).
- Composer: the same AiPromptInput, with mode (Auto-edit / Ask / Plan), budget, and attachments.

Events on the stream: `run_started`, `route` (role, model, effort, why), `text_delta`, `tool_call`, `tool_result`,
`approval_required`, `checkpoint`, `diff_updated`, `verification`, `cost`, `run_finished`, `error`.

## What we take from the research list

| Idea | Decision |
|---|---|
| Schema-validated tool inputs (Zod) | **Now** — every tool |
| Streaming loop that runs tools without breaking the stream | **Now** |
| Tool modules = schema + execution + permission | **Now** |
| Partial edits by exact replacement | **Now**; AST edits later |
| Worktree isolation with apply/discard | **Now** |
| Permission modes (default/auto/plan) and plan mode | **Now** (auto-edit default) |
| Cost tracking with warnings and hard stops | **Now** |
| Context compaction | Phase 2 |
| Sub-agents, teams, structured results between agents | Phase 3 |
| LSP for code understanding | Phase 3 |
| MCP | Phase 3 |
| Tool search (load tools on demand) | Later, once the tool count justifies it |
| Sleep / scheduled wake-ups for background jobs | Later |
| Lazy loading heavy dependencies | Applies to the server; cheap to do as we go |
| Terminal UI (Ink), CLI boot prefetch, compile-time feature flags | Not applicable (web app) |
| IDE bridge | Later, if an editor extension is wanted |

## Phases

1. **Spike** — agent loop, the core tools, auto-edit with approval cards, worktree with diff/apply/discard, Code mode
   UI with timeline and Changes tab. One role (implementer) routed by OneRoute. Try on 10–20 real tasks; compare
   against pointing Aider or OpenCode at the OneRoute API.
2. **Solid core** — checkpoints and undo, compaction, AGENTS.md and repo map, verification loop, budgets and loop
   detection, outcome signals into routing.
3. **Roles and sub-agents** — planner/explorer/implementer/reviewer/test-fixer with per-role routing and escalation;
   LSP; MCP.
4. **Benchmark** — tasks solved per dollar against a single frontier model; the landing page's real numbers.
5. **Agent defense** — the user's system plugged into the dangerous-command classifier and approvals.

## Open questions

- Project access: only folders the user adds explicitly (recommended), or anywhere under the home folder?
- Default budgets per run (e.g. $1 and 60 steps)?
- Apply: merge into the user's current branch, or leave the work on its own branch for them to merge?
