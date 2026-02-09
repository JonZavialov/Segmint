# Segmint

A semantic Git runtime for AI agents.

Segmint is an MCP server that turns raw `git diff` output into structured, agent-readable objects. It parses diffs into typed Changes, clusters related edits by semantic similarity, and exposes everything through the Model Context Protocol so any MCP-compatible agent can inspect and manipulate repository state.

Commit planning, PR generation, and other downstream workflows are optional consumers of this substrate — not the core product.

## Core Primitives

Segmint models a repository as a set of structured objects that agents operate on directly:

| Primitive | What it represents |
|---|---|
| **Change** | A single file's diff — file path and typed hunks |
| **Hunk** | A contiguous region of changed lines within a file |
| **ChangeGroup** | A cluster of semantically related changes |
| **CommitPlan** | A proposed commit covering one or more groups |
| **PullRequestDraft** | A PR covering multiple commits |

Change and Hunk are the foundational layer. Everything else is built on top.

## How It Works

```
git diff ──► Change[] ──► embeddings ──► clustering ──► ChangeGroup[]
                                                            │
                                              (optional downstream)
                                                            ▼
                                                     CommitPlan[] ──► PullRequestDraft
```

Segmint runs as a stdio-based MCP server. An AI agent connects over stdin/stdout using JSON-RPC, calls tools to read structured diffs, group related changes, and optionally plan commits or generate PRs.

**What is mechanical (no LLM):** diff parsing, Change construction, embedding text assembly, cosine similarity, clustering, deterministic ID assignment.

**What uses LLMs:** embedding vectors (OpenAI `text-embedding-3-small`). Group summaries, commit messages, and PR descriptions are currently heuristic — LLM integration is planned.

## MCP Tools

| Tool | Tier | Status | Description |
|---|---|---|---|
| `repo_status` | 1 | Real | Structured repository state — HEAD, staged/unstaged/untracked, ahead/behind, merge/rebase |
| `list_changes` | 1 | Real | Parse uncommitted diffs into structured `Change[]` objects |
| `log` | 1 | Real | Structured commit history with ref, path, date, and merge filtering |
| `show_commit` | 1 | Real | Full commit details — metadata, affected files, and structured diff |
| `diff_between_refs` | 1 | Real | Structured diff between any two refs with optional path filtering |
| `blame` | 1 | Real | Line-level attribution — commit SHA, author, timestamp, summary per line |
| `group_changes` | — | Real | Cluster changes by semantic similarity into `ChangeGroup[]` |
| `propose_commits` | — | Mocked | Propose a commit sequence from change groups |
| `apply_commit` | — | Mocked | Stage and commit files for a given commit plan |
| `generate_pr` | — | Mocked | Generate a pull request draft from commits |

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

- Runs both `git diff` and `git diff --cached`, merges per file (staged hunks first)
- Sorts by file path, assigns deterministic IDs (`change-1`, `change-2`, ...)
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

### group_changes

Clusters changes by semantic similarity using embeddings.

- Input: `{ change_ids: string[] }` — IDs from `list_changes`
- Validates IDs against current repository state
- Builds embedding text from file path + hunk headers + diff lines
- Calls OpenAI `text-embedding-3-small` for vector embeddings
- Clusters using centroid-based greedy cosine similarity (threshold 0.80)
- Single-change input skips embeddings and returns one group directly
- Requires `OPENAI_API_KEY` (returns structured error if missing)

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

**ChangeGroup** — a cluster of related changes grouped by semantic similarity.
```
{ id: string, change_ids: string[], summary: string }
```

**CommitPlan** — a proposed commit covering one or more change groups.
```
{ id: string, title: string, description: string, change_group_ids: string[] }
```

**PullRequestDraft** — a PR covering multiple commits.
```
{ title: string, description: string, commits: CommitPlan[] }
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
| Embedding text | Real | Built from file path + hunk headers + diff lines (truncated at 200 lines) |
| Embedding vectors | Real | OpenAI `text-embedding-3-small` via pluggable `EmbeddingProvider` |
| Clustering | Real | Centroid-based greedy cosine similarity (threshold 0.80) |
| Group summaries | Heuristic | File-path-based summaries (LLM summaries planned) |
| Commit planning | Mocked | Returns deterministic mock data |
| Commit execution | Mocked | Returns `{ success: true }` |
| PR generation | Mocked | Returns deterministic mock data |

## Directory Structure

```
src/
  index.ts        MCP server entrypoint (slim — imports createServer, connects stdio).
  server.ts       createServer() factory with all 10 tool registrations.
  exec-git.ts     Centralized git command execution + error handling.
  models.ts       TypeScript interfaces for all data models (Change, RepoStatus, etc.).
  git.ts          Executes git diff commands, parses unified diff format into Change objects.
  changes.ts      Shared change-loading helper. Single source of truth for ID assignment.
                  Also builds embedding text and resolves change IDs.
  embeddings.ts   Pluggable EmbeddingProvider interface. Ships with OpenAI and Local
                  (SHA-256-based offline) implementations.
  cluster.ts      Cosine similarity function and centroid-based greedy clustering algorithm.
  history.ts      Commit history retrieval — Tier 1 read-only, NUL-delimited parsing.
  show.ts         Single commit detail retrieval — Tier 1 read-only, reuses parseDiff.
  diff.ts         Ref-to-ref structured diff — Tier 1 read-only, reuses parseDiff.
  blame.ts        Line-level blame attribution — Tier 1 read-only, porcelain parsing.
  status.ts       Repository status gathering — Tier 1 read-only repo intelligence.
  mock-data.ts    Deterministic mock data for propose_commits, apply_commit, generate_pr.
                  Part of the test contract — IDs are relied on by smoke tests.

tests/
  unit/           Unit tests for parsers, helpers, and isolated logic.
  integration/    Integration tests against real temporary git repos.
  e2e/            In-process E2E tests via createServer() + InMemoryTransport.
  fixtures/       Test fixture files (diffs, etc.).

typescript-sdk/   Local copy of the MCP TypeScript SDK (read-only reference).
llms-full.txt     MCP protocol documentation (read-only reference).
build/            Compiled JavaScript output (gitignored).
.github/workflows/ CI configuration (GitHub Actions).
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes (for `group_changes` with 2+ changes) | OpenAI API key for `text-embedding-3-small`. If not set, `group_changes` returns a structured MCP error with setup instructions. Single-change calls work without it. |
| `SEGMINT_EMBEDDING_PROVIDER` | No | Set to `"local"` to use the offline SHA-256-based `LocalEmbeddingProvider` instead of OpenAI. No API key needed. Used for testing and development. |

## Running Locally

### Install and build

```bash
npm install
npm run build
```

### Set your OpenAI API key

```bash
# Linux/macOS
export OPENAI_API_KEY=sk-...

# Windows PowerShell
$env:OPENAI_API_KEY = "sk-..."
```

### Test with JSON-RPC over stdio

The server communicates via stdin/stdout using JSON-RPC. Send one message per line:

```
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"repo_status","arguments":{}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"list_changes","arguments":{}}}
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"log","arguments":{"limit":5}}}
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"show_commit","arguments":{"sha":"HEAD"}}}
{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"diff_between_refs","arguments":{"base":"HEAD~1","head":"HEAD"}}}
{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"blame","arguments":{"path":"src/index.ts"}}}
{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"group_changes","arguments":{"change_ids":["change-1","change-2"]}}}
```

Start the server and pipe input:

```bash
npm start
```

## Design Principles

**Substrate, not application.** Segmint provides structured Git primitives for agents. Commit planning, PR generation, and workflow automation are downstream consumers — they use the substrate but do not define it.

**Determinism.** Changes are sorted by file path before ID assignment. Clustering processes inputs in sorted order. Group IDs are assigned sequentially. Given the same diff and embeddings, the output is identical.

**MCP stdout hygiene.** stdout is reserved exclusively for JSON-RPC protocol messages. All diagnostic output goes to stderr via `console.error`. No banners, no startup messages on stdout.

**Pluggable embeddings.** The `EmbeddingProvider` interface decouples clustering from any specific API. The default implementation calls OpenAI, but the interface can be swapped without touching clustering or tool logic.

**Real data before agents.** Each pipeline stage is implemented with real data before adding LLM-powered agents on top. Mocked tools are explicitly labeled and return deterministic data.

**No speculative abstraction.** Code is written for the current requirement. Helpers are introduced only when shared by multiple callers. Three similar lines are better than a premature abstraction.

**Structured errors, never crashes.** Invalid input returns `{ isError: true }` with a descriptive message. The MCP server never crashes on bad user input.

## Capability Roadmap (Tiers)

Segmint's long-term direction is to expose comprehensive Git capabilities as structured, agent-operable primitives. Tools are organized into tiers by safety profile and dependency order.

The next major development focus is **Tier 1 + Tier 2**. These tiers define what Segmint becomes as a Git substrate — everything else is downstream. Tier 1 and Tier 2 tools are **planned but not yet in active development** — implementation begins only when explicitly instructed.

### Tier 1: Read-Only Repo Intelligence (safe, foundational)

Tools that let an agent understand repository state without mutating anything. These are the highest priority because they are safe, composable, and foundational for all downstream operations.

- `repo_status` — staged/unstaged/untracked counts, current branch, ahead/behind remote ✅
- `log` — commit history with filters (date range, path, ref, merge filtering, limit) ✅
- `show_commit` — full commit details (message, author, diff) for a given SHA ✅
- `diff_between_refs` — structured diff between any two refs (branches, commits, tags) with optional path filtering ✅
- `blame` — line-level attribution for a file or line range ✅
- `list_branches` / `list_tags` / `current_branch` — ref enumeration
- `list_remotes` / `remote_info` — remote configuration

### Tier 2: Workspace Mutation (controlled, reversible)

Tools that change working tree or index state. All Tier 2 tools must include explicit safety guardrails (confirmation semantics, dry-run modes, or undo paths).

- `stage_changes` / `unstage_changes` — hunk-level staging/unstaging where possible
- `apply_patch` / `revert_patch` — apply or reverse a structured patch
- `checkout_branch` / `create_branch` — branch switching and creation
- `stash_save` / `stash_list` / `stash_pop` / `stash_drop` — stash management
- `reset_soft` / `reset_mixed` — with guardrails preventing data loss (no `--hard`)

### Tier 3: Irreversible / Destructive Operations (gated)

Operations like `push`, `rebase`, `reset --hard`, `force push`, and history rewriting. Tier 3 is **not a near-term priority**. When implemented, every Tier 3 tool must be gated behind explicit safety/preview mechanisms (dry-run by default, confirmation required, destructive flags opt-in).

### Phase Roadmap

| Phase | Status | Scope |
|---|---|---|
| Phase 1 | Complete | MCP skeleton, tool registration, mock data |
| Phase 2 | Complete | Real git diff parsing — structured Change objects |
| Phase 3 | Complete | Embeddings + clustering — semantic ChangeGroups |
| Phase 4 | Planned | LLM-powered group summaries and commit planning |
| Phase 5 | Planned | Real git staging/commit execution + PR generation |
| Phase 6 | Planned | Tier 1 read-only repo intelligence tools |
| Phase 7 | Planned | Tier 2 workspace mutation tools with guardrails |

Phases are sequential. Each builds on the previous one. Tier 1 and Tier 2 tools define the substrate's capability coverage. Commit and PR tooling (Phases 4–5) are downstream consumers that will be restructured to operate on Tier 1/2 primitives as they become available.

## Non-Goals (for now)

These are explicitly out of scope and must not drive substrate design:

- **UX-layer commit/PR assistance.** Segmint is not building a user-facing commit planner or PR writing tool. `propose_commits` and `generate_pr` exist as optional downstream consumers of the substrate. They must not influence the design of Tier 1/2 primitives.
- **Opinionated Git workflows.** Segmint does not enforce branching strategies, commit conventions, or merge policies. It exposes Git capabilities; agents decide how to use them.
- **Interactive UIs or dashboards.** Segmint is a headless MCP server. Any UI is a separate concern built on top.
- **Git hosting integration.** GitHub/GitLab/Bitbucket API wrappers are not part of the substrate. PR generation produces a local draft; pushing or creating remote PRs is a downstream operation.

## Development Rules

These rules are enforced via CLAUDE.md and apply to all contributors (human or AI).

- `list_changes` captures staged + unstaged changes by running both `git diff` and `git diff --cached`. Never use `git diff HEAD`.
- Changes are sorted by `file_path` before assigning IDs (`change-1`, `change-2`, ...).
- When merging staged and unstaged hunks for the same file, staged hunks come first.
- stdout contains only JSON-RPC. All logging goes to stderr.
- All tools return structured MCP errors (`{ isError: true }`) on failure. No thrown exceptions reach the client.
- `execFileSync` uses a 10 MB buffer to handle large diffs without crashing.
- Mock data IDs (`change-1`, `group-1`, `commit-1`, etc.) are part of the test contract. Do not change them without updating tests.
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

All tests run fully offline using `SEGMINT_EMBEDDING_PROVIDER=local`. No OpenAI API key is needed to run the test suite.

| Embedding Provider | Env Variable | Use Case |
|---|---|---|
| `LocalEmbeddingProvider` | `SEGMINT_EMBEDDING_PROVIDER=local` | Testing, offline development |
| `OpenAIEmbeddingProvider` | `OPENAI_API_KEY=sk-...` | Production, real semantic similarity |

CI runs on both Ubuntu and Windows via GitHub Actions on every push and pull request.

## Stack

- TypeScript (strict mode, ESM)
- `@modelcontextprotocol/sdk@1.26.0`
- `zod@3.x`
- `vitest` + `@vitest/coverage-v8` (dev)
- Node.js 20+
- stdio transport
