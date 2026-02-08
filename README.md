# Segmint

Segmint segments code changes by intent.

Modern Git workflows operate on raw diffs and files. Segmint works at a higher level -- it models repositories as structured changesets that AI agents can reason about. Related edits are grouped together, commits become semantic units, and pull requests reflect actual engineering decisions.

Segmint is an MCP server that exposes Git as semantic objects so AI agents can inspect a dirty repo, cluster edits by intent, plan commits, apply them, and generate PR descriptions.

## How It Works

The core pipeline:

```
git diff --> Change[] --> embeddings --> clustering --> ChangeGroup[] --> CommitPlan[] --> PullRequestDraft
```

Segmint runs as a stdio-based MCP server. An AI agent connects over stdin/stdout using JSON-RPC, calls tools to inspect changes, group them, plan commits, and generate PRs.

What is mechanical (no LLM): diff parsing, embedding text construction, cosine similarity, clustering, ID assignment.

What uses LLMs: group summaries (planned), commit message generation (planned), PR description generation (planned). Currently these produce heuristic or mocked output.

## Architecture

### MCP Server Model

Segmint uses the Model Context Protocol (MCP) over stdio transport. The server exposes tools that clients call via JSON-RPC:

1. Client sends `initialize` with protocol version and capabilities.
2. Client sends `notifications/initialized`.
3. Client calls `tools/list` to discover available tools.
4. Client calls `tools/call` with tool name and arguments.

All tool responses include both a `content` array (text JSON for display) and `structuredContent` (typed object for programmatic use).

### Data Models

All models are defined in `src/models.ts`.

**Change** -- A single file's diff, parsed from `git diff` output.
```
{ id: string, file_path: string, hunks: Hunk[] }
```

**Hunk** -- A contiguous region of changed lines within a file.
```
{ old_start, old_lines, new_start, new_lines, header: string, lines: string[] }
```

**ChangeGroup** -- A cluster of related changes grouped by semantic similarity.
```
{ id: string, change_ids: string[], summary: string }
```

**CommitPlan** -- A proposed commit covering one or more change groups.
```
{ id: string, title: string, description: string, change_group_ids: string[] }
```

**PullRequestDraft** -- A PR covering multiple commits.
```
{ title: string, description: string, commits: CommitPlan[] }
```

### Current Pipeline Status

| Stage | Status | Implementation |
|---|---|---|
| `git diff` parsing | Real | Runs `git diff` and `git diff --cached`, merges staged + unstaged per file |
| Change ID assignment | Real | Sorted by file path, assigned as `change-1`, `change-2`, ... |
| Embedding text | Real | Built from file path + hunk headers + diff lines (truncated at 200 lines) |
| Embedding vectors | Real | OpenAI `text-embedding-3-small` via pluggable `EmbeddingProvider` |
| Clustering | Real | Centroid-based greedy cosine similarity (threshold 0.80) |
| Group summaries | Heuristic | `"Changes in <file>"` or `"Related changes across <file1>, <file2>"` |
| Commit planning | Mocked | Returns deterministic mock data |
| Commit execution | Mocked | Always returns `{ success: true }` |
| PR generation | Mocked | Returns deterministic mock data |

## Current Features

### list_changes (real)

Returns all uncommitted changes (staged + unstaged) as structured `Change[]` objects.

- Runs both `git diff --no-color --unified=3` and `git diff --cached --no-color --unified=3`
- Merges hunks per file (staged first, then unstaged)
- Sorts by file path, assigns deterministic IDs
- Handles new files, deleted files, binary files (skipped)
- Returns `{ isError: true }` if not a git repo or git is not installed

### group_changes (real)

Clusters changes by semantic similarity using OpenAI embeddings.

- Input: `{ change_ids: string[] }` (IDs from `list_changes`)
- Validates IDs against current repo state (not mock data)
- Builds embedding text from file path and diff content
- Calls OpenAI `text-embedding-3-small` for vector embeddings
- Clusters using centroid-based greedy cosine similarity (threshold 0.80)
- Single-change optimization: skips embeddings, returns one group directly
- Requires `OPENAI_API_KEY` (returns structured error if missing)

### propose_commits (mocked)

Returns deterministic mock `CommitPlan[]`. Validates input against mock group IDs.

### apply_commit (mocked)

Always returns `{ success: true }`. Validates input against mock commit IDs.

### generate_pr (mocked)

Returns a deterministic mock `PullRequestDraft`. Validates input against mock commit IDs.

## Directory Structure

```
src/
  index.ts        MCP server entrypoint. Registers all 5 tools and starts stdio transport.
  models.ts       TypeScript interfaces for Change, ChangeGroup, CommitPlan, PullRequestDraft.
  git.ts          Executes git diff commands, parses unified diff format into Change objects.
  changes.ts      Shared change-loading helper. Single source of truth for ID assignment.
                  Also builds embedding text and resolves change IDs.
  embeddings.ts   Pluggable EmbeddingProvider interface. Ships with OpenAI implementation
                  using text-embedding-3-small.
  cluster.ts      Cosine similarity function and centroid-based greedy clustering algorithm.
  mock-data.ts    Deterministic mock data for propose_commits, apply_commit, generate_pr.
                  Part of the test contract -- IDs are relied on by smoke tests.

typescript-sdk/   Local copy of the MCP TypeScript SDK (read-only reference).
llms-full.txt     MCP protocol documentation (read-only reference).
build/            Compiled JavaScript output (gitignored).
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_API_KEY` | Yes (for `group_changes` with 2+ changes) | OpenAI API key for `text-embedding-3-small`. If not set, `group_changes` returns a structured MCP error with setup instructions. Single-change calls work without it. |

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
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_changes","arguments":{}}}
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"group_changes","arguments":{"change_ids":["change-1","change-2"]}}}
```

Start the server and pipe input:

```bash
npm start
```

## Design Principles

**Determinism.** Changes are sorted by file path before ID assignment. Clustering processes inputs in sorted order. Group IDs are assigned sequentially. Given the same diff and embeddings, the output is identical.

**MCP stdout hygiene.** stdout is reserved exclusively for JSON-RPC protocol messages. All diagnostic output goes to stderr via `console.error`. No banners, no startup messages on stdout.

**Pluggable embeddings.** The `EmbeddingProvider` interface decouples clustering from any specific API. The default implementation calls OpenAI, but the interface can be swapped without touching clustering or tool logic.

**Real data before agents.** Each pipeline stage is implemented with real data before adding LLM-powered agents on top. Mocked tools are explicitly labeled and return deterministic data.

**No speculative abstraction.** Code is written for the current requirement. Helpers are introduced only when shared by multiple callers. Three similar lines are better than a premature abstraction.

**Structured errors, never crashes.** Invalid input returns `{ isError: true }` with a descriptive message. The MCP server never crashes on bad user input.

## Roadmap

| Phase | Status | Scope |
|---|---|---|
| Phase 1 | Complete | MCP skeleton, tool registration, mock data |
| Phase 2 | Complete | Real git diff parsing for `list_changes` |
| Phase 3 | Complete | OpenAI embeddings + clustering for `group_changes` |
| Phase 4 | Planned | Commit planner agent for `propose_commits` |
| Phase 5 | Planned | Real git execution for `apply_commit` + PR generation |

Phases are sequential. Each builds on the previous one.

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

## Stack

- TypeScript (strict mode, ESM)
- `@modelcontextprotocol/sdk@1.26.0`
- `zod@3.x`
- Node.js 20+
- stdio transport
