# OneRoute Code: coding harness design

Status: phase 1 (spike) and most of phase 2 (solid core) built; see **Phases** for what is done. Branch: `harness`.

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
- **Work where the user works.** By default the agent edits the folder the user opened (like Claude Code), with a
  checkpoint per message so any message's changes can be undone; a separate git worktree on its own branch is an
  option.
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
| `bash` (`background: true`) | exec | dev servers and watchers: returns once a local URL is printed; `process_output`, `stop_process` |
| `check_page` | exec | opens an HTML file (from disk, as the user would) or a localhost URL in headless Chrome; reports console errors, exceptions, failed requests, visible text; optional click/fill/press/select steps and element reads; screenshot for the UI |
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
- Compaction (`src/harness/compact.ts`): the budget is the smaller of 75 % of the model's context and a per-mode
  cap (Cheap 48K, Balanced 128K, Best 256K prompt tokens). Past 60 % of it, output of all but the last six tool
  results is cleared; past 100 %, the older conversation is summarised by the run's model and the recent turns stay
  verbatim.
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

When the agent calls `finish` after changing things, OneRoute runs the project's checks itself (`src/harness/verify.ts`):
type check, lint and tests from package.json scripts (npm/pnpm/yarn/bun), `node --test` for `*.test.js`, pytest,
cargo, go, `make test`, and — for a plain web page with no dev server — a headless-browser load of `index.html` from
disk. Failures go back to the agent as the result of its `finish` call ("Not finished: …") up to 1/2/3 times
(Cheap/Balanced/Best); after that the run ends with the failures stated. The result is recorded as implicit
feedback on the run's routing decision, so passing or failing checks feed the router's per-model success rates.

### Checkpoints

Before any file is written (edit tools) and around every shell command (git status before/after; originals of
files that were clean come from HEAD, new files are recorded as new), the original is saved twice under
`~/.oneroute/snapshots/<session>/`: once for the session (its diff and "Undo changes") and once for the current
message. "Restore files to here" on a message puts every file back to how it was before that message, undoing it
and everything after; the agent is told on its next run. Limitation: in a folder without git, files a shell command
modifies (rather than creates) can't be restored.

### Preview and processes

Preview runs the project's `dev`/`start`/`serve`/`preview` script (installing dependencies first if needed) as a
tracked background process and opens the URL it prints; a project without one is served by a small static server on
127.0.0.1 (hidden files never served). Background processes run in their own process groups, show their output in
the Run tab, and are stopped when the session is removed or the server shuts down.

### Helpers (sub-agents)

The main agent can hand a self-contained job to a helper with the `subagent` tool (`src/harness/subagents.ts`):
**explore** (find things, make sense of long logs; read-only tools plus bash) or **review** (check the work so far,
including the session's diff; adds `check_page`). A helper runs in a fresh context, is routed on its own task (a
reviewer is kept off the main agent's model family when another family fits), has a step budget (8/20/30 for
Cheap/Balanced/Best, the last turn forced to report), and returns only a Zod-validated `report` (summary,
findings with file/line/severity, files, pass/fail). Its reads and command output never enter the main
conversation. Helpers can't start helpers (one level deep). In the app each helper is a card with its model, cost,
verdict and findings; its own tool calls are folded inside.

### Project memory

After a run where the user followed up (often a correction) or things failed, a cheap model extracts at most three
durable, non-secret facts about the project ("user-visible text says Gratuity, not Tip", "parseAmount must reject
1e9-style input") into `code_memory`; entries shown wrong are removed. Every run's system prompt includes the
memory. The Memory tab lists it, and entries can be edited, removed or added by hand.

### Other

- `wait`: pauses without tokens until a background process prints some text or exits, or for N seconds.
- Approvals raise a system notification when the app isn't in view.
- The conversation is saved after every step; a run cut off by a restart is marked interrupted and has a Resume
  button.

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
2. **Solid core** — done: checkpoints and per-message undo, compaction, AGENTS.md and file list, verification loop
   with a real-browser page check, loop detection, check outcomes into routing, Preview and background processes.
   Left: a symbol-level repo map, cost budgets per run (off by default by choice).
3. **Roles and sub-agents** — started: explore and review helpers with their own routing and structured reports,
   project memory. Left: planner and test-fixer roles, escalation on repeated failure, LSP, MCP.
4. **Benchmark** — tasks solved per dollar against a single frontier model; the landing page's real numbers.
5. **Agent defense** — the user's system plugged into the dangerous-command classifier and approvals.

## Open questions

- Project access: only folders the user adds explicitly (recommended), or anywhere under the home folder?
- Default budgets per run (e.g. $1 and 60 steps)?
- Apply: merge into the user's current branch, or leave the work on its own branch for them to merge?
