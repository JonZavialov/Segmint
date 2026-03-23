# Segmint

A semantic Git runtime for AI agents.

Segmint is an MCP server that turns raw `git diff` output into structured, agent-readable objects. It parses diffs into typed Changes, exposes structured commit history, blame, status, and ref-to-ref diffs through the Model Context Protocol so any MCP-compatible agent can inspect repository state.

## Core Primitives

Segmint models a repository as a set of structured objects that agents operate on directly:

| Primitive | What it represents |
|---|---|
| **Change** | A single file's diff — file path and typed hunks |
| **Hunk** | A contiguous region of changed lines within a file |

Change and Hunk are the foundational layer. All other structures (LogCommit, CommitDetail, RepoStatus, BlameResult) are read-only views over repository state.

## How It Works

```
git ──► structured objects ──► agent
```

Segmint runs as a stdio-based MCP server. An AI agent connects over stdin/stdout using JSON-RPC and calls tools to read structured diffs, commit history, blame data, repository status, and ref-to-ref diffs.

**Everything is mechanical (no LLM):** diff parsing, Change construction, commit history retrieval, blame attribution, status gathering, deterministic ID assignment.

## MCP Tools

| Tool | Tier | Description |
|---|---|---|
| `set_repo_root` | 1 | Select the repository Segmint operates on (resolves to absolute path, verifies git work tree) |
| `get_repo_root` | 1 | Return the currently configured repository root, or null |
| `repo_status` | 1 | Structured repository state — HEAD, staged/unstaged/untracked, ahead/behind, merge/rebase |
| `list_changes` | 1 | Parse uncommitted diffs into structured `Change[]` objects, with optional path filtering and summary mode |
| `log` | 1 | Structured commit history with ref, path, date, and merge filtering |
| `show_commit` | 1 | Full commit details — metadata, affected files, and structured diff |
| `diff_between_refs` | 1 | Structured diff between any two refs with optional path filtering |
| `blame` | 1 | Line-level attribution — commit SHA, author, timestamp, summary per line |
| `stash_list` | 1 | List all stashes as structured entries with index, message, and SHA |
| `stage_changes` | 2 | Stage file paths for commit via `git add`, with dry-run validation |
| `unstage_changes` | 2 | Unstage file paths via `git reset HEAD`, with dry-run validation |
| `stage_hunks` | 2 | Stage specific hunks by file path and hunk indices via `git apply --cached`, with dry-run validation |
| `create_commit` | 2 | Commit staged changes with a message, with dry-run validation |
| `create_branch` | 2 | Create a new branch at a ref, with dry-run validation |
| `checkout_branch` | 2 | Switch to an existing branch (git refuses if uncommitted changes conflict), with dry-run validation |
| `stash_save` | 2 | Stash current changes with optional message, with dry-run validation |
| `stash_pop` | 2 | Pop a stash entry and apply to working tree, with dry-run validation |
| `reset_soft` | 2 | Move HEAD backward while keeping all changes staged, with dry-run validation |
| `push` | 3 | Push to remote — dry_run defaults true for safety, force push uses `--force-with-lease` |

All tools require `set_repo_root` to be called first (except `set_repo_root` and `get_repo_root` themselves). Tools return a `SEGMINT_NO_REPO` error if no repository has been selected. Arrays returned by `repo_status` and `list_changes` are capped at 200 entries with `truncated` and `omitted_count` fields when exceeded.

### set_repo_root

Selects the repository Segmint operates on.

- Input: `{ path: string }` — absolute or relative path to a directory inside a git repository
- Resolves the path to an absolute directory, then runs `git rev-parse --show-toplevel` to find and store the repository root
- Must be called before any other git-touching tool
- If the path is not inside a git work tree, returns `{ isError: true }` and preserves the previous root (if any)
- Calling again switches to a different repository

### get_repo_root

Returns the currently configured repository root, or null if none has been set.

- Input: `{}`
- Returns `{ repo_root: string | null }`

### repo_status

Returns structured repository state as a single `RepoStatus` object.

- HEAD info: branch name or detached SHA
- Staged files with status labels (modified, added, deleted, renamed, etc.)
- Unstaged files with status labels
- Untracked file paths
- Ahead/behind counts relative to upstream (if tracking branch exists)
- Upstream tracking branch name
- Merge/rebase in-progress flags (detected via `.git/MERGE_HEAD`, `.git/rebase-apply`, `.git/rebase-merge`)
- Returns `{ isError: true }` if not in a git repository

### list_changes

Returns all uncommitted changes (staged + unstaged) as structured `Change[]` objects with typed hunks.

- Input: `{ path?, summary_only? }` — optional path filter and summary mode
- Runs both `git diff` and `git diff --cached`, merges per file (staged hunks first)
- Sorts by file path, assigns deterministic IDs (`change-1`, `change-2`, ...)
- `path` filter restricts output to changes matching the given file or directory
- `summary_only` returns lightweight stats (hunk count, insertions, deletions) without full hunk content — useful for large changesets
- Handles new files, deleted files, skips binary files
- Returns `{ isError: true }` if not in a git repository

### log

Returns commit history as structured `LogCommit[]` objects.

- Input: `{ limit?, ref?, path?, since?, until?, include_merges? }`
- Default: 20 commits from HEAD, no merges
- Limit clamped to 1..200
- Supports date filtering via `since` / `until` (ISO 8601 or git date strings)
- Path filtering restricts to commits touching the given path
- Uses NUL-delimited format for safe parsing of commit fields
- Returns `{ isError: true }` for bad refs, paths, or non-git directories

### show_commit

Returns full details for a single commit as a structured `CommitDetail` object.

- Input: `{ sha: string }` — commit SHA, short SHA, or any ref
- Returns metadata: subject, body, author/committer names, emails, dates (ISO 8601), parents
- Returns affected files with status labels (modified, added, deleted, renamed, etc.)
- Returns the full diff parsed into `Change[]` with typed hunks (reuses existing diff parser)
- Handles root commits (no parent) via `git show` fallback
- Returns `{ isError: true }` for unknown SHAs or non-git directories

### diff_between_refs

Returns a structured diff between any two git refs as `Change[]` objects.

- Input: `{ base, head, path?, unified? }`
- Supports branches, tags, SHAs, and expressions like `HEAD~3`
- Optional path filtering restricts diff to a single file or directory
- Context lines configurable via `unified` (default 3, clamped 0..20)
- Reuses existing `parseDiff` pipeline for Change/Hunk construction
- IDs are scoped to this output (`change-1`, `change-2`, ...), sorted by file path
- Returns `{ isError: true }` for invalid refs or non-git directories

### blame

Returns line-level attribution for a file, showing which commit last modified each line.

- Input: `{ path, ref?, start_line?, end_line?, ignore_whitespace?, detect_moves? }`
- Default ref: HEAD
- Optional line range filtering via `start_line` / `end_line` (1-indexed, inclusive)
- `ignore_whitespace` (`-w`) ignores whitespace-only changes in attribution
- `detect_moves` (`-M -C`) detects lines moved/copied across files
- Each output line includes: line number, content, and commit metadata (SHA, author, timestamp, summary)
- Timestamps are ISO 8601
- Returns `{ isError: true }` for invalid paths, bad refs, or non-git directories

### stage_changes

Stage file paths for commit via `git add`.

- Input: `{ paths: string[], dry_run?: boolean }`
- `paths`: repo-relative file paths to stage (no wildcards — explicit paths only)
- `dry_run`: when true, validates paths without executing `git add` (default false)
- Returns `{ staged_paths: string[], dry_run: boolean }`
- Reversible via `unstage_changes`
- Returns `{ isError: true }` if paths is empty, path is invalid, or not in a git repository

### unstage_changes

Unstage file paths via `git reset HEAD`.

- Input: `{ paths: string[], dry_run?: boolean }`
- `paths`: repo-relative file paths to unstage (no wildcards — explicit paths only)
- `dry_run`: when true, validates paths without executing `git reset` (default false)
- Returns `{ unstaged_paths: string[], dry_run: boolean }`
- Reversible via `stage_changes`
- Returns `{ isError: true }` if paths is empty, path is invalid, or not in a git repository

### stage_hunks

Stage specific hunks by file path and hunk indices. Reconstructs a minimal patch with only selected hunks and applies via `git apply --cached`.

- Input: `{ file_path: string, hunk_indices: number[], dry_run?: boolean }`
- `file_path`: repo-relative file path
- `hunk_indices`: 0-based indices of hunks to stage from the file's unstaged diff
- `dry_run`: when true, validates without staging (default false)
- Returns `{ file_path: string, hunks_staged: number, dry_run: boolean }`
- Returns `{ isError: true }` if file path is invalid, hunk indices are out of range, or not in a git repository

### create_commit

Commit staged changes with a message.

- Input: `{ message: string, dry_run?: boolean }`
- `message`: commit message
- `dry_run`: when true, inspects what would be committed without committing (default false)
- Returns `{ sha: string, short_sha: string, subject: string, dry_run: boolean }`
- Returns `{ isError: true }` if nothing is staged, message is empty, or not in a git repository

### create_branch

Create a new branch at a ref.

- Input: `{ name: string, ref?: string, dry_run?: boolean }`
- `name`: branch name to create
- `ref`: starting ref (default HEAD)
- `dry_run`: when true, validates without creating (default false)
- Returns `{ branch_name: string, sha: string, dry_run: boolean }`
- Returns `{ isError: true }` if branch name already exists, ref is invalid, or not in a git repository

### checkout_branch

Switch to an existing branch. Git naturally refuses if uncommitted changes would be overwritten.

- Input: `{ name: string, dry_run?: boolean }`
- `name`: branch name to switch to
- `dry_run`: when true, validates without switching (default false)
- Returns `{ branch_name: string, previous_branch: string | null, dry_run: boolean }`
- Returns `{ isError: true }` if branch does not exist, uncommitted changes conflict, or not in a git repository

### stash_save

Stash current changes.

- Input: `{ message?: string, dry_run?: boolean }`
- `message`: optional stash message
- `dry_run`: when true, checks if there are changes to stash without stashing (default false)
- Returns `{ message: string, dry_run: boolean }`
- Returns `{ isError: true }` if no changes to stash or not in a git repository

### stash_list

List all stashes as structured entries.

- Input: `{}`
- Returns `{ stashes: StashEntry[] }` where each entry has `{ index: number, message: string, sha: string }`
- Returns an empty array if no stashes exist
- Returns `{ isError: true }` if not in a git repository

### stash_pop

Pop a stash entry, applying it to the working tree.

- Input: `{ index?: number, dry_run?: boolean }`
- `index`: stash index to pop (default 0)
- `dry_run`: when true, validates the stash exists without popping (default false)
- Returns `{ index: number, dry_run: boolean }`
- Returns `{ isError: true }` if stash index is invalid, conflicts prevent apply, or not in a git repository

### reset_soft

Move HEAD backward while keeping all changes staged.

- Input: `{ ref: string, dry_run?: boolean }`
- `ref`: target ref to reset to (e.g., `HEAD~1`, a SHA)
- `dry_run`: when true, previews the reset target without resetting (default false)
- Returns `{ ref: string, previous_sha: string, new_sha: string, dry_run: boolean }`
- Returns `{ isError: true }` if ref is invalid or not in a git repository

### push

Push to remote. Safety-gated: `dry_run` defaults to `true` — the agent must explicitly set `dry_run: false` to execute.

- Input: `{ remote?: string, branch?: string, force?: boolean, dry_run?: boolean }`
- `remote`: remote name (default `origin`)
- `branch`: branch to push (default: current branch)
- `force`: use `--force-with-lease` instead of bare `--force` (default false)
- `dry_run`: simulate push without executing — **defaults to true** for safety
- Returns `{ remote: string, branch: string, dry_run: boolean, forced: boolean }`
- Returns `{ isError: true }` if remote is invalid, branch does not exist, or not in a git repository

## Architecture

### MCP Server Model

Segmint uses the Model Context Protocol over stdio transport. The server exposes tools that clients call via JSON-RPC:

1. Client sends `initialize` with protocol version and capabilities.
2. Client sends `notifications/initialized`.
3. Client calls `tools/list` to discover available tools.
4. Client calls `tools/call` with tool name and arguments.

All tool responses include both `content` (text JSON for display) and `structuredContent` (typed object for programmatic use).

### Data Models

All models are defined in `src/models.ts`.

**Change** — a single file's diff, parsed from `git diff` output.
```
{ id: string, file_path: string, hunks: Hunk[] }
```

**Hunk** — a contiguous region of changed lines within a file.
```
{ old_start, old_lines, new_start, new_lines, header: string, lines: string[] }
```

**LogCommit** — a single commit from history (Tier 1).
```
{ sha: string, short_sha: string, subject: string, author_name: string,
  author_email: string, author_date: string, parents: string[] }
```

**CommitDetail** — full commit details (Tier 1).
```
{ sha, short_sha, subject, body, author_name, author_email, author_date,
  committer_name, committer_email, committer_date, parents: string[],
  files: FileStatus[], diff: { changes: Change[] } }
```

**RepoStatus** — structured repository state snapshot (Tier 1).
```
{ is_git_repo, root_path, head: HeadInfo, staged: FileStatus[],
  unstaged: FileStatus[], untracked: string[], ahead_by?, behind_by?,
  upstream?, merge_in_progress, rebase_in_progress }
```

**BlameResult** — line-level blame output (Tier 1).
```
{ path: string, ref: string, lines: BlameLine[] }
```

**BlameLine** — a single blamed line.
```
{ line_number: number, content: string, commit: BlameCommit }
```

**BlameCommit** — blame commit metadata.
```
{ sha, short_sha, author_name, author_email, author_time, summary }
```

**ChangeSummary** — lightweight change stats (used with `summary_only` mode).
```
{ id: string, file_path: string, hunk_count: number, insertions: number, deletions: number }
```

**StageResult** — staging operation result (Tier 2).
```
{ staged_paths: string[], dry_run: boolean }
```

**UnstageResult** — unstaging operation result (Tier 2).
```
{ unstaged_paths: string[], dry_run: boolean }
```

**StageHunksResult** — hunk-level staging result (Tier 2).
```
{ file_path: string, hunks_staged: number, dry_run: boolean }
```

**CommitResult** — commit operation result (Tier 2).
```
{ sha: string, short_sha: string, subject: string, dry_run: boolean }
```

**CreateBranchResult** — branch creation result (Tier 2).
```
{ branch_name: string, sha: string, dry_run: boolean }
```

**CheckoutResult** — branch checkout result (Tier 2).
```
{ branch_name: string, previous_branch: string | null, dry_run: boolean }
```

**StashEntry** — a single stash entry (Tier 1).
```
{ index: number, message: string, sha: string }
```

**StashSaveResult** — stash save result (Tier 2).
```
{ message: string, dry_run: boolean }
```

**StashPopResult** — stash pop result (Tier 2).
```
{ index: number, dry_run: boolean }
```

**ResetResult** — soft reset result (Tier 2).
```
{ ref: string, previous_sha: string, new_sha: string, dry_run: boolean }
```

**PushResult** — push operation result (Tier 3).
```
{ remote: string, branch: string, dry_run: boolean, forced: boolean }
```

### Pipeline Status

| Stage | Status | Implementation |
|---|---|---|
| Repo status | Real | `git status --porcelain=v1 -b`, `git rev-parse`, `.git/` state detection |
| Commit history | Real | `git log` with NUL-delimited format, ref/path/date/merge filtering |
| Commit detail | Real | `git show` metadata + name-status + diff, parsed into CommitDetail |
| Ref-to-ref diff | Real | `git diff <base> <head>` with path/context filtering, parsed into Change[] |
| Line-level blame | Real | `git blame --line-porcelain` with line range, whitespace, and move detection |
| `git diff` parsing | Real | Runs `git diff` and `git diff --cached`, merges staged + unstaged per file |
| Change ID assignment | Real | Sorted by file path, assigned as `change-1`, `change-2`, ... |
| File staging | Real | `git add` and `git reset HEAD` with explicit file paths, dry-run validation |
| Hunk staging | Real | Reconstructs minimal patch from selected hunks, applies via `git apply --cached` |
| Commit creation | Real | `git commit -m` with dry-run validation |
| Branch management | Real | `git branch` and `git checkout` with dry-run validation |
| Stash management | Real | `git stash push`, `git stash list`, `git stash pop` with dry-run validation |
| Soft reset | Real | `git reset --soft` with dry-run validation |
| Remote push | Real | `git push` with `--dry-run` default, `--force-with-lease` for force push |

## Directory Structure

```
src/
  index.ts        MCP server entrypoint (slim — imports createServer, connects stdio).
  server.ts       createServer() factory with all 19 tool registrations + repo_root state.
  exec-git.ts     Centralized git command execution + error handling.
  models.ts       TypeScript interfaces for all data models (Change, RepoStatus, etc.).
  git.ts          Executes git diff commands, parses unified diff format into Change objects.
  history.ts      Commit history retrieval — Tier 1 read-only, NUL-delimited parsing.
  show.ts         Single commit detail retrieval — Tier 1 read-only, reuses parseDiff.
  diff.ts         Ref-to-ref structured diff — Tier 1 read-only, reuses parseDiff.
  blame.ts        Line-level blame attribution — Tier 1 read-only, porcelain parsing.
  staging.ts      Tier 2 workspace mutation: staging/unstaging file paths and hunks.
  status.ts       Repository status gathering — Tier 1 read-only repo intelligence.
  commit.ts       Tier 2 workspace mutation: commit creation with dry-run.
  branch.ts       Tier 2 workspace mutation: branch creation and checkout.
  stash.ts        Tier 2 workspace mutation + Tier 1 read-only: stash save, list, pop.
  reset.ts        Tier 2 workspace mutation: soft reset with dry-run.
  push.ts         Tier 3 irreversible: push to remote with safety gating.

tests/
  unit/           Unit tests for parsers, helpers, and isolated logic.
  integration/    Integration tests against real temporary git repos.
  e2e/            In-process E2E tests via createServer() + InMemoryTransport.
  fixtures/       Test fixture files (diffs, etc.).

scripts/
  clean.mjs       Cross-platform clean script (removes build/ and coverage/).

typescript-sdk/   Local copy of the MCP TypeScript SDK (read-only reference).
llms-full.txt     MCP protocol documentation (read-only reference).
build/            Compiled JavaScript output (gitignored).
.github/workflows/ CI configuration (GitHub Actions).
```

## Configuration

No environment variables are required. Segmint operates entirely offline using only the local `git` CLI. There are no LLM dependencies or external API calls.

## Running Locally

### Install and build

```bash
npm install
npm run build
```

The `build` script runs `npm run clean && tsc`, which removes stale artifacts from `build/` before compiling. This prevents leftover files from deleted source modules.

### Use with Claude Desktop

Add Segmint to your Claude Desktop configuration (`%APPDATA%\Claude\claude_desktop_config.json` on Windows, `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "segmint": {
      "command": "node",
      "args": ["C:/path/to/segmint/build/index.js"]
    }
  }
}
```

No `cwd` field is needed — the agent selects the target repository at runtime by calling `set_repo_root`.

### Agent workflow

1. Agent connects and calls `set_repo_root` with the target repository path.
2. Agent calls any combination of tools (`repo_status`, `list_changes`, `log`, etc.).
3. To switch repositories, call `set_repo_root` again with a different path.

### Test with JSON-RPC over stdio

The server communicates via stdin/stdout using JSON-RPC. Send one message per line:

```
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

Start the server and pipe input:

```bash
npm start
```

## Design Principles

**Substrate, not application.** Segmint provides structured Git primitives for agents. Commit planning, PR generation, change grouping, and workflow automation are the responsibility of the consuming agent — they use the substrate but do not define it.

**Determinism.** Changes are sorted by file path before ID assignment. Given the same diff, the output is identical.

**MCP stdout hygiene.** stdout is reserved exclusively for JSON-RPC protocol messages. All diagnostic output goes to stderr via `console.error`. No banners, no startup messages on stdout.

**Real data, no mocks.** All 19 MCP tools operate on real git data. No mock data in production code.

**No speculative abstraction.** Code is written for the current requirement. Helpers are introduced only when shared by multiple callers. Three similar lines are better than a premature abstraction.

**Structured errors, never crashes.** Invalid input returns `{ isError: true }` with a descriptive message. The MCP server never crashes on bad user input.

## Capability Roadmap (Tiers)

Segmint's long-term direction is to expose comprehensive Git capabilities as structured, agent-operable primitives. Tools are organized into tiers by safety profile and dependency order.

### Tier 1: Read-Only Repo Intelligence (safe, foundational)

Tools that let an agent understand repository state without mutating anything. These are safe, composable, and foundational for all downstream operations.

**Implemented:**
- `repo_status` — staged/unstaged/untracked counts, current branch, ahead/behind remote
- `log` — commit history with filters (date range, path, ref, merge filtering, limit)
- `show_commit` — full commit details (message, author, diff) for a given SHA
- `diff_between_refs` — structured diff between any two refs (branches, commits, tags) with optional path filtering
- `blame` — line-level attribution for a file or line range
- `stash_list` — list all stashes as structured entries

**Planned:**
- `list_branches` / `list_tags` / `current_branch` — ref enumeration
- `list_remotes` / `remote_info` — remote configuration

### Tier 2: Workspace Mutation (controlled, reversible)

Tools that change working tree or index state. All Tier 2 tools include explicit safety guardrails (dry-run modes and undo paths).

**Implemented:**
- `stage_changes` / `unstage_changes` — file-level staging/unstaging with dry-run validation
- `stage_hunks` — hunk-level staging via `git apply --cached` with dry-run validation
- `create_commit` — commit staged changes with dry-run validation
- `create_branch` — branch creation at any ref with dry-run validation
- `checkout_branch` — branch switching with dry-run validation (git refuses on conflicts)
- `stash_save` / `stash_pop` — stash save and restore with dry-run validation
- `reset_soft` — move HEAD backward while keeping changes staged, with dry-run validation

**Planned:**
- `apply_patch` / `revert_patch` — apply or reverse a structured patch
- `reset_mixed` — with guardrails preventing data loss (no `--hard`)

### Tier 3: Irreversible / Destructive Operations (gated)

Operations that cannot be undone locally. Every Tier 3 tool is gated behind explicit safety mechanisms (dry-run by default, confirmation required, destructive flags opt-in).

**Implemented:**
- `push` — push to remote with `dry_run` defaulting to `true`, force push uses `--force-with-lease`

**Planned:**
- `rebase`, `reset --hard`, `force push` — history rewriting and destructive operations with safety gating

### Phase Roadmap

| Phase | Status | Scope |
|---|---|---|
| Phase 1 | Complete | MCP skeleton, tool registration |
| Phase 2 | Complete | Real git diff parsing — structured Change objects |
| Tier 1 | Complete | Read-only repo intelligence tools (repo_status, log, show_commit, diff_between_refs, blame) |
| v0.1.1 | Complete | Explicit repo selection (set_repo_root/get_repo_root), safety caps (200-entry arrays), SEGMINT_NO_REPO invariant, removal of downstream tools and embedding infrastructure |
| v0.2.1 | Complete | Enhanced `list_changes` (path filter, summary mode), Tier 2 staging tools (`stage_changes`, `unstage_changes`) |
| v0.3.0 | Complete | Safe mutation layer: 9 new tools (commit, branch, stash, reset, push, hunk staging) |

### Post-v0.3.0 Roadmap

| Priority | Scope |
|---|---|
| Next | Tier 1 expansion: `list_branches`, `list_tags`, `list_remotes` |
| Later | Tier 2 expansion: `apply_patch`, `revert_patch`, `reset_mixed` |
| Later | Tier 3 expansion: `rebase`, `reset --hard` with safety gating |

## Non-Goals (for now)

These are explicitly out of scope and must not drive substrate design:

- **Commit planning, PR generation, and change grouping.** These are the responsibility of the consuming agent, not Segmint. Segmint provides the structured data; the agent decides how to group changes, plan commits, and generate PRs using its own reasoning.
- **Opinionated Git workflows.** Segmint does not enforce branching strategies, commit conventions, or merge policies. It exposes Git capabilities; agents decide how to use them.
- **Interactive UIs or dashboards.** Segmint is a headless MCP server. Any UI is a separate concern built on top.
- **Git hosting integration.** GitHub/GitLab/Bitbucket API wrappers are not part of the substrate. Interacting with remote hosting platforms is a downstream operation.

## Development Rules

These rules are enforced via CLAUDE.md and apply to all contributors (human or AI).

- `list_changes` captures staged + unstaged changes by running both `git diff` and `git diff --cached`. Never use `git diff HEAD`.
- Changes are sorted by `file_path` before assigning IDs (`change-1`, `change-2`, ...).
- When merging staged and unstaged hunks for the same file, staged hunks come first.
- stdout contains only JSON-RPC. All logging goes to stderr.
- All tools return structured MCP errors (`{ isError: true }`) on failure. No thrown exceptions reach the client.
- `execFileSync` uses a 10 MB buffer to handle large diffs without crashing.
- No new npm dependencies without explicit justification.

## Testing

Segmint has a comprehensive Vitest test suite with 95%+ coverage enforcement across all metrics.

```bash
npm test              # Run all tests
npm run test:unit     # Unit tests only
npm run test:integration  # Integration tests (requires git CLI)
npm run test:e2e      # E2E tests (in-process via InMemoryTransport)
npm run test:coverage # All tests with V8 coverage report
npm run test:watch    # Watch mode for development
```

All tests run fully offline with no external dependencies.

CI runs on both Ubuntu and Windows via GitHub Actions on every push and pull request.

## Stack

- TypeScript (strict mode, ESM)
- `@modelcontextprotocol/sdk@1.26.0`
- `zod@3.x`
- `vitest` + `@vitest/coverage-v8` (dev)
- Node.js 20+
- stdio transport
