# CLAUDE.md — Segmint

## What This Is

Segmint is an MCP server that exposes Git as semantic objects so AI agents can inspect a dirty repo, cluster edits by intent, plan commits, apply them, and generate PR descriptions.

The core pipeline is deterministic:

```
git diff → Change objects → embeddings → clustering → ChangeGroups → CommitPlans → PullRequestDraft
```

LLMs participate only in: group summaries, commit planning, and PR generation. Everything else is mechanical.

## Project Status

**Current phase: Phase 2 — Real git diff parsing implemented for `list_changes`.**

Completed:
- Phase 1: MCP stdio server wired, 5 tools registered, canonical models, mock data, smoke tests
- Phase 2: `list_changes` returns real uncommitted changes (staged + unstaged) parsed from `git diff`

Planned phases (do NOT start unless explicitly instructed):

| Phase | Scope |
|---|---|
| Phase 3 | Embeddings + clustering → ChangeGroups |
| Phase 4 | Commit planner agent |
| Phase 5 | Executor + PR generation |

Each phase builds on the previous one. Do not skip ahead. Do not begin future phase work speculatively.

## Sources of Truth

**These are the ONLY authoritative references for MCP behavior. Do not assume APIs or invent helpers.**

| What | Where |
|---|---|
| MCP TypeScript SDK | `./typescript-sdk` |
| MCP protocol docs | `./llms-full.txt` |

If uncertain about MCP server setup, tool registration, schemas, stdio transport, or request/response formats — search these local sources. Do not rely on outside knowledge.

### Immutable references

The following paths are **READ-ONLY**. Claude must never modify them.

- `./typescript-sdk/`
- `./llms-full.txt`

They exist only as references for MCP behavior. If something in them seems wrong, do not "fix" it — surface it to the user.

## Architecture Rules

1. `src/index.ts` is always the MCP server entrypoint.
2. Git mutation may ONLY occur inside MCP tool handlers. Never directly in agents.
3. Agents reason over structured objects (Change, ChangeGroup, CommitPlan, PullRequestDraft). Never raw git output.
4. stdout is reserved for MCP JSON-RPC. All logging goes to stderr via `console.error`.
5. No god files. Keep modules small and focused.
6. No speculative abstractions. Only build what is explicitly required.

## Data Models

Defined in `src/models.ts`. These are the canonical shapes:

- **Change** — a single file's diff: `{ id, file_path, hunks[] }`
- **ChangeGroup** — related changes clustered by intent: `{ id, change_ids[], summary }`
- **CommitPlan** — a proposed commit: `{ id, title, description, change_group_ids[] }`
- **PullRequestDraft** — a PR covering multiple commits: `{ title, description, commits[] }`

## MCP Tool Contracts

These names and signatures are canonical. Do not rename or change contracts without updating this file.

| Tool | Input | Output | Description |
|---|---|---|---|
| `list_changes` | `{}` | `{ changes: Change[] }` | List uncommitted changes as structured objects |
| `group_changes` | `{ change_ids: string[] }` | `{ groups: ChangeGroup[] }` | Group changes by intent |
| `propose_commits` | `{ group_ids: string[] }` | `{ commits: CommitPlan[] }` | Propose commits from groups |
| `apply_commit` | `{ commit_id: string }` | `{ success: boolean }` | Apply a commit plan to the repo |
| `generate_pr` | `{ commit_ids: string[] }` | `PullRequestDraft` | Generate a PR draft from commits |

All tools return both `content` (text JSON) and `structuredContent` (typed object).

## Error Handling

All tools must follow these conventions:

- Validate inputs with Zod schemas (handled automatically by the SDK).
- Return `{ isError: true }` with a descriptive message for unknown IDs or invalid references. Do not throw exceptions.
- Never crash the MCP server on bad user input. All errors must be returned as structured MCP responses.
- Error messages must be deterministic and machine-readable (e.g., `"Unknown change IDs: bad-id"`).
- Do not use `try/catch` to swallow errors silently. If something unexpected happens, return it as an MCP error.

## Mock Data Contract

`src/mock-data.ts` is part of the test contract. Do not treat it as throwaway scaffolding.

- IDs (`change-1`, `change-2`, `group-1`, `group-2`, `commit-1`, `commit-2`) are relied on by the smoke test sequence.
- Do not change mock shapes, IDs, or return values unless tests are updated simultaneously.
- Mock behavior must remain fully deterministic — no randomness, no timestamps, no external state.
- `list_changes` now returns real git changes, but `group_changes`, `propose_commits`, `apply_commit`, and `generate_pr` still validate against mock IDs. Real change IDs from `list_changes` will not match mock IDs — this is expected until those tools are implemented with real logic.

## Directory Structure

```
src/
  index.ts        — MCP server entrypoint, tool registration
  models.ts       — TypeScript interfaces for data models
  mock-data.ts    — Deterministic mock data (test contract)
  git.ts          — Git diff execution and unified diff parsing
typescript-sdk/   — Local copy of MCP TypeScript SDK (READ-ONLY)
llms-full.txt     — MCP protocol documentation (READ-ONLY)
build/            — Compiled output (gitignored)
```

## Stack

- TypeScript (strict mode)
- `@modelcontextprotocol/sdk@1.26.0`
- `zod@3.x` for all schemas
- stdio transport
- Node.js ESM (`"type": "module"`)

## Dependencies

- Do not add npm dependencies without explicit instruction from the user.
- Prefer using existing dependencies before introducing new ones.
- Any new dependency must be justified with a note in this file under this section.
- Avoid heavy frameworks. Keep the dependency tree minimal.

Current dependencies:
- `@modelcontextprotocol/sdk` — MCP server framework
- `zod` — schema validation

## Build and Run

```bash
npm install
npm run build    # tsc
npm start        # node build/index.js (stdio)
```

## Testing Requirements

**Every change must be validated.** No exceptions.

1. `npm run build` must succeed with zero errors.
2. Start the MCP server and confirm it responds to `initialize`.
3. Call `tools/list` and verify all 5 tools are present.
4. Call `list_changes` and verify structured output.
5. Call at least one additional tool.

If MCP behavior changes, provide example JSON-RPC payloads in the PR or commit message.

If tool contracts change, update this file.

### Test sequence

Send these messages over stdin (each on its own line):

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_changes","arguments":{}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"group_changes","arguments":{"change_ids":["change-1","change-2"]}}}
```

## Coding Standards

- TypeScript only. No JavaScript source files.
- Zod for all input and output schemas.
- Strong typing everywhere. No `any`. Avoid `as` casts unless unavoidable.
- `structuredContent` must satisfy `{ [x: string]: unknown }`. Use spread/map to create plain objects from typed interfaces.
- Deterministic behavior where possible.
- No `console.log` — stdout is the MCP transport. Use `console.error` for diagnostics.

## Workflow Rules

- Never bundle multiple milestones into one change.
- Finish the current task before starting the next.
- Do not add features unless explicitly instructed.
- Do not refactor unrelated code.
- Do not add comments, docstrings, or type annotations to code you did not change.
- No speculative abstractions. Three similar lines are better than a premature helper.

## Planning Rules (Do Not Regress)

> These rules exist because we previously planned `git diff HEAD` with a HEAD-existence fallback for `list_changes`. That was wrong — it conflates staged and unstaged changes and behaves poorly on fresh repos. The correct approach (two separate diffs, merged deterministically) was caught in review. These rules prevent repeating that class of mistake.

### Requirements-first planning

- Do not assume git commands or MCP APIs. Confirm behavior from `./llms-full.txt`, `./typescript-sdk`, and existing code before proposing.
- State exact acceptance criteria before proposing implementation steps.

### Git change capture (Segmint v1)

- `list_changes` MUST capture staged + unstaged changes by running BOTH:
  - `git diff --no-color --unified=3` (unstaged)
  - `git diff --cached --no-color --unified=3` (staged)
- Do NOT use `git diff HEAD` for `list_changes`.
- No HEAD existence checks or fallbacks are needed — these two commands work on fresh repos.

### Diff parsing

- Parse `diff --git a/<path> b/<path>` headers to extract file paths.
- Handle `/dev/null` correctly:
  - If `b` is `/dev/null` → deleted file → use `a/<path>`.
  - If `a` is `/dev/null` → new file → use `b/<path>`.
  - `file_path` must never be `/dev/null`.
- Preserve the full `@@ ... @@` line as the hunk `header` field (store the exact line, not a subset).

### Determinism

- Sort Changes by `file_path` before assigning IDs.
- Assign IDs as `change-1`, `change-2`, … (1-indexed, after sorting).
- When merging staged + unstaged hunks for the same file, concatenate in fixed order: staged first, then unstaged.

### MCP stdio hygiene

- stdout must contain ONLY JSON-RPC protocol output.
- All logs go to stderr (`console.error`) or are removed entirely.
- No banners, no startup messages on stdout.

### Scale and safety

- Configure `execFileSync` with sufficient `maxBuffer` (currently 10 MB) so large diffs do not crash.
- On errors (not a git repo, git not installed), return structured tool errors (`{ isError: true }`). Do not crash the server.

## Git and Commit Rules

- Do not commit code unless explicitly instructed by the user.
- Do not invent branching strategies or create branches without instruction.
- Do not push to any remote without explicit instruction.
- If commit messages are requested, they must be semantic and aligned with Segmint's intent model (e.g., `feat(auth): add token expiry validation`).

## Maintaining This File

This file must stay in sync with the codebase. If you change any of the following, update CLAUDE.md before finishing:

- MCP tool names, inputs, or outputs
- Data model shapes in `src/models.ts`
- Directory structure or new source files
- Build/run commands in `package.json`
- Architecture rules or constraints
- SDK import paths or patterns
- Dependencies added or removed
- Project status or phase completion

Do not wait for a separate request. Update this file as part of the same change.

## SDK Notes

- Import `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`
- Import `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`
- `registerTool(name, { description, inputSchema, outputSchema }, handler)`
- `inputSchema` accepts `z.object({...})` or a raw shape `{ key: z.string() }`
- Handler signature: `(args, extra) => CallToolResult | Promise<CallToolResult>`
- Return: `{ content: [{ type: "text", text: "..." }], structuredContent: {...}, isError?: boolean }`
- The SDK supports both Zod v3 and v4. This project uses Zod v3.

## Platform

- Windows (no `chmod` in scripts, use Windows-compatible paths in tests)
- Node.js ESM with `"module": "Node16"` resolution
