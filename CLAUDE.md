# CLAUDE.md — Segmint

## What This Is

Segmint is a semantic Git runtime for AI agents. It is an MCP server that turns raw git output into structured, agent-readable objects — typed Changes, commit history, blame data, and diffs — so any MCP-compatible agent can inspect repository state.

The core substrate is deterministic: all tools produce structured objects directly from git commands with no external dependencies.

## Product Direction (Non-Negotiable)

Segmint is **infrastructure**, not an application. It provides structured Git primitives that agents operate on directly.

**Core identity:** A semantic Git runtime — structured diffs, typed Change objects, commit history, blame attribution, and repository status.

**What Segmint is NOT:**
- Not a commit assistant
- Not a PR generator
- Not a Git workflow tool

**Language standard:** All descriptions, comments, and documentation must use substrate/runtime/primitive language. Never "assistant", "helper", or "workflow tool".

## Project Status

**Current phase: v0.2.0 complete. 8 MCP tools, all Tier 1 read-only. Explicit repo selection via `set_repo_root`.**

Completed:
- Phase 1: MCP stdio server wired, 8 tools registered, canonical models
- Phase 2: `list_changes` returns real uncommitted changes (staged + unstaged) parsed from `git diff`
- Tier 1 read-only tools: `repo_status`, `log`, `show_commit`, `diff_between_refs`, `blame`
- Repo selection: `set_repo_root` / `get_repo_root` — all tools require explicit repo selection (no implicit `process.cwd()`)
- Safety caps: arrays capped at 200 entries with `truncated`/`omitted_count` fields

Planned phases (do NOT start unless explicitly instructed):

| Phase | Scope |
|---|---|
| Tier 1 expansion | `list_branches`, `list_tags`, `list_remotes` |
| Tier 2 | Workspace mutation tools with guardrails (`stage_changes`, `unstage_changes`, etc.) |

Do not begin future phase work speculatively.

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

1. `src/index.ts` is the MCP server entrypoint. `src/server.ts` holds the `createServer()` factory with all tool registrations. This separation enables in-process testing.
2. All git subprocess calls go through `src/exec-git.ts` (`execGit` for throwing, `tryExecGit` for non-throwing).
3. Agents reason over structured objects (Change, LogCommit, CommitDetail, RepoStatus, BlameResult). Never raw git output.
4. stdout is reserved for MCP JSON-RPC. All logging goes to stderr via `console.error`.
5. No god files. Keep modules small and focused.
6. No speculative abstractions. Only build what is explicitly required.

## Data Models

Defined in `src/models.ts`. These are the canonical shapes:

- **Change** — a single file's diff: `{ id, file_path, hunks[] }`
- **LogCommit** — a single commit from history: `{ sha, short_sha, subject, author_name, author_email, author_date, parents[] }`
- **CommitDetail** — full commit details: `{ sha, short_sha, subject, body, author_name, author_email, author_date, committer_name, committer_email, committer_date, parents[], files[], diff: { changes: Change[] } }`
- **RepoStatus** — structured repo state snapshot: `{ is_git_repo, root_path, head, staged[], unstaged[], untracked[], ahead_by?, behind_by?, upstream?, merge_in_progress, rebase_in_progress }`
- **BlameResult** — line-level blame output: `{ path, ref, lines: BlameLine[] }`
- **BlameLine** — a single blamed line: `{ line_number, content, commit: BlameCommit }`
- **BlameCommit** — blame commit metadata: `{ sha, short_sha, author_name, author_email, author_time, summary }`

## MCP Tool Contracts

These names and signatures are canonical. Do not rename or change contracts without updating this file.

| Tool | Tier | Input | Output | Description |
|---|---|---|---|---|
| `set_repo_root` | 1 | `{ path: string }` | `{ repo_root: string }` | Select the repository Segmint operates on |
| `get_repo_root` | 1 | `{}` | `{ repo_root: string \| null }` | Return the currently configured repository root |
| `repo_status` | 1 | `{}` | `RepoStatus` | Structured repository state |
| `list_changes` | 1 | `{}` | `{ changes: Change[] }` | List uncommitted changes as structured objects |
| `log` | 1 | `{ limit?, ref?, path?, since?, until?, include_merges? }` | `{ commits: LogCommit[] }` | Structured commit history with filtering |
| `show_commit` | 1 | `{ sha: string }` | `{ commit: CommitDetail }` | Full commit details with metadata, files, and diff |
| `diff_between_refs` | 1 | `{ base, head, path?, unified? }` | `{ base, head, changes: Change[] }` | Structured diff between any two refs |
| `blame` | 1 | `{ path, ref?, start_line?, end_line?, ignore_whitespace?, detect_moves? }` | `BlameResult` | Line-level attribution for a file |

All tools require `set_repo_root` to be called first (except `set_repo_root` and `get_repo_root` themselves). Tools return `SEGMINT_NO_REPO` error if no repository has been selected.

All tools return both `content` (text JSON) and `structuredContent` (typed object).

## Error Handling

All tools must follow these conventions:

- Validate inputs with Zod schemas (handled automatically by the SDK).
- Return `{ isError: true }` with a descriptive message for unknown IDs or invalid references. Do not throw exceptions.
- All git-touching tools must call `requireRepoRoot()` before any operation. If no repo has been selected via `set_repo_root`, return `{ isError: true }` with the `SEGMINT_NO_REPO` error message.
- Never crash the MCP server on bad user input. All errors must be returned as structured MCP responses.
- Error messages must be deterministic and machine-readable (e.g., `"SEGMINT_NO_REPO: ..."`).
- Do not use `try/catch` to swallow errors silently. If something unexpected happens, return it as an MCP error.

## Directory Structure

```
src/
  index.ts        — MCP server entrypoint (slim — imports createServer, connects stdio)
  server.ts       — createServer() factory with all 8 tool registrations + repo_root state
  exec-git.ts     — Centralized git command execution + error handling
  models.ts       — TypeScript interfaces for data models
  git.ts          — Git diff execution and unified diff parsing
  history.ts      — Commit history retrieval (Tier 1 read-only)
  show.ts         — Single commit detail retrieval (Tier 1 read-only)
  diff.ts         — Ref-to-ref structured diff (Tier 1 read-only)
  blame.ts        — Line-level blame attribution (Tier 1 read-only)
  status.ts       — Repository status gathering (Tier 1 read-only)
tests/
  unit/           — Unit tests for parsers, helpers, and isolated logic
  integration/    — Integration tests against real temporary git repos
  e2e/            — In-process E2E tests via createServer() + InMemoryTransport
  fixtures/       — Test fixture files (diffs, porcelain output, etc.)
scripts/
  clean.mjs       — Cross-platform clean script (removes build/ and coverage/)
typescript-sdk/   — Local copy of MCP TypeScript SDK (READ-ONLY)
llms-full.txt     — MCP protocol documentation (READ-ONLY)
build/            — Compiled output (gitignored)
.github/workflows/ — CI configuration
.env.example      — Environment variable template (copy to .env)
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

Dev dependencies:
- `vitest` — test framework
- `@vitest/coverage-v8` — V8 code coverage provider

## Environment Variables

No environment variables are required. Segmint is fully deterministic with no external API dependencies.

## Build and Run

```bash
npm install
npm run clean    # node scripts/clean.mjs (removes build/ and coverage/)
npm run build    # npm run clean && tsc
npm start        # node build/index.js (stdio)
```

### Test Commands

```bash
npm test              # Run all tests
npm run test:unit     # Unit tests only
npm run test:integration  # Integration tests only (requires git)
npm run test:e2e      # E2E tests only
npm run test:coverage # All tests with coverage report
npm run test:watch    # Watch mode
```

All tests run fully offline with no external dependencies.

## Testing Requirements

**Every change must be validated.** No exceptions.

### Automated test suite

The project has a comprehensive Vitest test suite with 95%+ coverage enforcement:

1. `npm run build` must succeed with zero errors.
2. `npm run test:coverage` must pass with all thresholds met (95% statements, branches, functions, lines).
3. New tools or logic changes must include corresponding tests.
4. Coverage must not regress — if you add code, add tests to cover it.

### Manual smoke test (optional, for protocol-level changes)

If MCP behavior changes, provide example JSON-RPC payloads in the PR or commit message.

If tool contracts change, update this file.

### Test sequence

Send these messages over stdin (each on its own line):

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"set_repo_root","arguments":{"path":"/path/to/your/repo"}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"repo_status","arguments":{}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"list_changes","arguments":{}}}
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"log","arguments":{"limit":5}}}
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"show_commit","arguments":{"sha":"HEAD"}}}
{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"diff_between_refs","arguments":{"base":"HEAD~1","head":"HEAD"}}}
{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"blame","arguments":{"path":"src/index.ts"}}}
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

## Anti-Drift Contract: Substrate Tiers

> These rules exist to prevent Segmint from drifting beyond its role as read-only Git infrastructure. Every future agent must follow them.

### Tier classification

All tools belong to a tier. The tiers are:

- **Tier 1 (read-only):** Safe, foundational tools that inspect repo state without mutation. Examples: `repo_status`, `log`, `show_commit`, `diff`, `blame`, `list_branches`, `list_tags`, `list_remotes`. All current tools are Tier 1.
- **Tier 2 (workspace mutation):** Controlled, reversible tools that change working tree or index. Examples: `stage_changes`, `unstage_changes`, `apply_patch`, `checkout_branch`, `stash_save`, `reset_soft`. All Tier 2 tools must include explicit safety guardrails.
- **Tier 3 (irreversible/destructive):** `push`, `rebase`, `reset --hard`, force operations. Gated behind safety/preview mechanisms. Not a near-term priority.

### Rules

1. **Tier mapping required.** Every plan to implement a new tool must explicitly state which tier the tool belongs to before implementation begins. No tool is implemented without a tier assignment.
2. **Capability naming.** Tool names and descriptions must reflect Git capabilities (e.g., `repo_status`, `stage_hunks`, `blame`). Names must never reflect assistant workflows (e.g., `plan_my_commits`, `help_with_pr`, `suggest_changes`).
3. **Roadmap updates mandatory.** Every PR or task that adds, removes, or changes tool capabilities MUST update the Capability Roadmap section in README.md in the same change.
4. **Substrate independence.** Tier 1 and Tier 2 tools must be independently useful. The substrate must never depend on higher-level workflow features.
5. **No premature implementation.** Do NOT implement new Tier 1, Tier 2, or Tier 3 tools unless the user has explicitly instructed you to do so. Planning and documenting future tools is fine; writing code for them is not.

## Planning Checklist (New Tools)

Before implementing any new MCP tool, complete this checklist:

- [ ] **Explicit user instruction:** Has the user explicitly asked for this tool to be implemented? (Do NOT start Tier 1/2/3 work speculatively.)
- [ ] **Phase status:** Is the current phase complete? Does the roadmap support this work now?
- [ ] **Tier assignment:** Which tier does this tool belong to? (1 = read-only, 2 = workspace mutation, 3 = irreversible)
- [ ] **Inputs/outputs as typed primitives:** Define input schema (Zod) and output types using existing or new canonical models from `src/models.ts`
- [ ] **Safety and guardrails:** For Tier 2+, define what guardrails prevent data loss (dry-run, confirmation, undo path). For Tier 3, define gating mechanism.
- [ ] **Determinism guarantees:** State which parts of the output are deterministic and which depend on external state (repo contents, LLM responses)
- [ ] **JSON-RPC test payload:** Write at least one example `tools/call` JSON-RPC message that exercises the tool, suitable for the smoke test sequence
- [ ] **Error cases:** List expected error conditions and verify they return `{ isError: true }` with machine-readable messages
- [ ] **README + CLAUDE.md sync:** Confirm both docs will be updated in the same change (tool contracts, tier assignments, directory structure, test sequence)

## Git and Commit Rules

- Do not commit code unless explicitly instructed by the user.
- Do not invent branching strategies or create branches without instruction.
- Do not push to any remote without explicit instruction.
- If commit messages are requested, they must be semantic and aligned with Segmint's intent model (e.g., `feat(auth): add token expiry validation`).

## Documentation Rules

> These rules exist to prevent documentation drift as Segmint evolves.

- `README.md` is a first-class product artifact, not optional documentation.
- Any task that changes behavior, architecture, or roadmap MUST also update `README.md`.
- `README.md` must always accurately reflect:
  - Which MCP tools are real vs mocked
  - Current pipeline stages
  - Environment variables
  - Directory structure
  - Roadmap phase
  - Capability Roadmap tier assignments
- If functionality is added or removed, `README.md` is updated in the same task.
- Pull requests or task completions are considered incomplete if `README.md` is stale.

## Release Hygiene

Before publishing a new version, verify the following:

- [ ] **Clean build:** `npm run build` produces only files from current `src/` (the `clean` script removes `build/` first, preventing stale artifacts from deleted modules).
- [ ] **Tests pass:** `npm run test:coverage` passes with all 95%+ thresholds met.
- [ ] **`.env.example` up to date:** All supported environment variables are documented in `.env.example` with comments.
- [ ] **LICENSE present:** `LICENSE` file exists at project root and `"license"` field is set in `package.json`.
- [ ] **`engines` field set:** `package.json` specifies `"engines": { "node": ">=20" }`.
- [ ] **Tarball clean:** `npm pack --dry-run` shows only `build/` files, `package.json`, and `README.md` — no tests, fixtures, coverage, or stale build artifacts.
- [ ] **No secrets:** `.env` is gitignored. No API keys in source, tests, or fixtures. Rotate any key that has been exposed.
- [ ] **Docs in sync:** README.md and CLAUDE.md reflect current tool contracts, directory structure, env vars, and roadmap phase.

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
