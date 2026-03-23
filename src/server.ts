/**
 * Segmint MCP Server factory.
 *
 * Creates and configures the McpServer with all tool registrations.
 * Separated from index.ts to enable in-process testing without spawning
 * a child process — tests import createServer() directly.
 */

import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getUncommittedChanges } from "./git.js";
import type { ChangeSummary } from "./models.js";
import { stageChanges, unstageChanges, stageHunks } from "./staging.js";
import { getRepoStatus } from "./status.js";
import { getLog } from "./history.js";
import { getCommit } from "./show.js";
import { getDiffBetweenRefs } from "./diff.js";
import { getBlame } from "./blame.js";
import { execGit } from "./exec-git.js";
import { createCommit } from "./commit.js";
import { createBranch, checkoutBranch } from "./branch.js";
import { listStashes, saveStash, popStash } from "./stash.js";
import { resetSoft } from "./reset.js";
import { pushToRemote } from "./push.js";

// ---------------------------------------------------------------------------
// Shared schemas
// ---------------------------------------------------------------------------

const hunkSchema = z.object({
  old_start: z.number(),
  old_lines: z.number(),
  new_start: z.number(),
  new_lines: z.number(),
  header: z.string(),
  lines: z.array(z.string()),
});

const changeSchema = z.object({
  id: z.string(),
  file_path: z.string(),
  hunks: z.array(hunkSchema),
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard cap on array entries returned by any tool. */
const MAX_ARRAY_ENTRIES = 200;

/** Error code returned when no repo root has been configured. */
const SEGMINT_NO_REPO =
  "SEGMINT_NO_REPO: No repository selected. Call set_repo_root first.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Cap an array at MAX_ARRAY_ENTRIES. Returns the truncated array and
 * the number of omitted entries.
 */
function capArray<T>(arr: T[]): { items: T[]; truncated: boolean; omitted_count: number } {
  if (arr.length <= MAX_ARRAY_ENTRIES) {
    return { items: arr, truncated: false, omitted_count: 0 };
  }
  return {
    items: arr.slice(0, MAX_ARRAY_ENTRIES),
    truncated: true,
    omitted_count: arr.length - MAX_ARRAY_ENTRIES,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fully-configured Segmint MCP server.
 *
 * The returned server has all 19 tools registered and is ready to be
 * connected to any MCP transport (stdio, in-memory, etc.).
 *
 * Repo root is stored as server-instance state inside the closure.
 * All tools that touch git use this root (returned by getRepoRoot()).
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "segmint",
    version: "0.3.0",
  });

  // -----------------------------------------------------------------------
  // Server-instance state: configured repository root
  // -----------------------------------------------------------------------
  let repoRoot: string | null = null;

  /** Return the configured repo root or null. */
  function getRepoRoot(): string | null {
    return repoRoot;
  }

  /**
   * Return the configured repo root or throw SEGMINT_NO_REPO.
   * All git-touching handlers call this to enforce the invariant.
   */
  function requireRepoRoot(): string {
    if (repoRoot === null) {
      throw new Error(SEGMINT_NO_REPO);
    }
    return repoRoot;
  }

  // -------------------------------------------------------------------------
  // Tool: set_repo_root (Tier 1 — configuration)
  // -------------------------------------------------------------------------

  server.registerTool(
    "set_repo_root",
    {
      description:
        "Select the repository Segmint operates on. Resolves the path to an absolute directory, verifies it is inside a git work tree, and stores the resolved repo root for all subsequent tool calls.",
      inputSchema: z.object({
        path: z.string().describe(
          "Absolute or relative path to a directory inside the target repository"
        ),
      }),
      outputSchema: z.object({
        repo_root: z.string(),
      }),
    },
    async ({ path: inputPath }, _extra) => {
      try {
        const absPath = resolve(inputPath);

        // Verify it is a git repo by asking git for the toplevel
        const toplevel = execGit(
          ["rev-parse", "--show-toplevel"],
          absPath,
        ).trim();

        repoRoot = toplevel;

        return {
          content: [{ type: "text", text: JSON.stringify({ repo_root: toplevel }, null, 2) }],
          structuredContent: { repo_root: toplevel },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: get_repo_root (Tier 1 — configuration)
  // -------------------------------------------------------------------------

  server.registerTool(
    "get_repo_root",
    {
      description:
        "Return the currently configured repository root, or null if none has been set.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        repo_root: z.string().nullable(),
      }),
    },
    async (_args, _extra) => {
      const root = getRepoRoot();
      return {
        content: [{ type: "text", text: JSON.stringify({ repo_root: root }, null, 2) }],
        structuredContent: { repo_root: root },
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: list_changes
  // -------------------------------------------------------------------------

  server.registerTool(
    "list_changes",
    {
      description:
        "List uncommitted changes in the repository, returned as structured Change objects with file paths and hunks.",
      inputSchema: z.object({
        path: z
          .string()
          .optional()
          .describe("Restrict to changes matching this path (file or directory)"),
        summary_only: z
          .boolean()
          .optional()
          .describe(
            "When true, return only file paths and stats (hunk_count, insertions, deletions) without full hunk content. Useful for large changesets."
          ),
      }),
      outputSchema: z.object({
        changes: z.array(
          z.object({
            id: z.string(),
            file_path: z.string(),
            hunks: z.array(hunkSchema).optional(),
            hunk_count: z.number().optional(),
            insertions: z.number().optional(),
            deletions: z.number().optional(),
          })
        ),
        truncated: z.boolean().optional(),
        omitted_count: z.number().optional(),
      }),
    },
    async ({ path, summary_only }, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const allChanges = getUncommittedChanges(cwd, path);
        const { items, truncated, omitted_count } = capArray(allChanges);

        let changes: Array<Record<string, unknown>>;

        if (summary_only) {
          changes = items.map((c) => {
            let insertions = 0;
            let deletions = 0;
            for (const hunk of c.hunks) {
              for (const line of hunk.lines) {
                if (line.startsWith("+")) insertions++;
                else if (line.startsWith("-")) deletions++;
              }
            }
            return {
              id: c.id,
              file_path: c.file_path,
              hunk_count: c.hunks.length,
              insertions,
              deletions,
            } satisfies ChangeSummary as Record<string, unknown>;
          });
        } else {
          changes = items.map((c) => ({ ...c }));
        }

        const result: Record<string, unknown> = { changes };
        if (truncated) {
          result.truncated = true;
          result.omitted_count = omitted_count;
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: repo_status (Tier 1 — read-only)
  // -------------------------------------------------------------------------

  server.registerTool(
    "repo_status",
    {
      description:
        "Get structured repository status: HEAD ref, staged/unstaged/untracked files, ahead/behind counts, and merge/rebase state.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        is_git_repo: z.boolean(),
        root_path: z.string(),
        head: z.object({
          type: z.enum(["branch", "detached"]),
          name: z.string().optional(),
          sha: z.string().optional(),
        }),
        staged: z.array(z.object({ path: z.string(), status: z.string() })),
        unstaged: z.array(z.object({ path: z.string(), status: z.string() })),
        untracked: z.array(z.string()),
        ahead_by: z.number().optional(),
        behind_by: z.number().optional(),
        upstream: z.string().optional(),
        merge_in_progress: z.boolean(),
        rebase_in_progress: z.boolean(),
        truncated: z.boolean().optional(),
      }),
    },
    async (_args, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const status = getRepoStatus(cwd);

        // Cap arrays
        const stagedCap = capArray(status.staged);
        const unstagedCap = capArray(status.unstaged);
        const untrackedCap = capArray(status.untracked);
        const truncated =
          stagedCap.truncated || unstagedCap.truncated || untrackedCap.truncated;

        const result: Record<string, unknown> = {
          ...status,
          staged: stagedCap.items,
          unstaged: unstagedCap.items,
          untracked: untrackedCap.items,
        };
        if (truncated) result.truncated = true;

        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: log (Tier 1 — read-only)
  // -------------------------------------------------------------------------

  server.registerTool(
    "log",
    {
      description:
        "Retrieve commit history as structured objects. Supports limit, ref, path filtering, date range, and merge filtering.",
      inputSchema: z.object({
        limit: z
          .number()
          .optional()
          .describe("Max commits to return (default 20, clamped 1..200)"),
        ref: z
          .string()
          .optional()
          .describe("Git ref to start from (default HEAD)"),
        path: z
          .string()
          .optional()
          .describe("Restrict to commits touching this path"),
        since: z
          .string()
          .optional()
          .describe("Only commits after this date (ISO 8601 or git date string)"),
        until: z
          .string()
          .optional()
          .describe("Only commits before this date (ISO 8601 or git date string)"),
        include_merges: z
          .boolean()
          .optional()
          .describe("Include merge commits (default false)"),
      }),
      outputSchema: z.object({
        commits: z.array(
          z.object({
            sha: z.string(),
            short_sha: z.string(),
            subject: z.string(),
            author_name: z.string(),
            author_email: z.string(),
            author_date: z.string(),
            parents: z.array(z.string()),
          })
        ),
      }),
    },
    async (args, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const result = getLog(args, cwd);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: show_commit (Tier 1 — read-only)
  // -------------------------------------------------------------------------

  server.registerTool(
    "show_commit",
    {
      description:
        "Retrieve full details for a single commit: metadata, affected files, and structured diff with Change/Hunk objects.",
      inputSchema: z.object({
        sha: z.string().describe("Commit SHA, short SHA, or ref to inspect"),
      }),
      outputSchema: z.object({
        commit: z.object({
          sha: z.string(),
          short_sha: z.string(),
          subject: z.string(),
          body: z.string(),
          author_name: z.string(),
          author_email: z.string(),
          author_date: z.string(),
          committer_name: z.string(),
          committer_email: z.string(),
          committer_date: z.string(),
          parents: z.array(z.string()),
          files: z.array(z.object({ path: z.string(), status: z.string() })),
          diff: z.object({
            changes: z.array(changeSchema),
          }),
        }),
      }),
    },
    async ({ sha }, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const result = getCommit(sha, cwd);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: {
            commit: {
              ...result.commit,
              files: result.commit.files.map((f) => ({ ...f })),
              diff: {
                changes: result.commit.diff.changes.map((c) => ({
                  ...c,
                  hunks: c.hunks.map((h) => ({ ...h, lines: [...h.lines] })),
                })),
              },
            },
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: diff_between_refs (Tier 1 — read-only)
  // -------------------------------------------------------------------------

  server.registerTool(
    "diff_between_refs",
    {
      description:
        "Compute a structured diff between any two git refs (branches, commits, tags). Returns Change[] with typed hunks.",
      inputSchema: z.object({
        base: z.string().describe("Base ref (branch, tag, SHA, or expression like HEAD~3)"),
        head: z.string().describe("Head ref to diff against base"),
        path: z
          .string()
          .optional()
          .describe("Restrict diff to this path"),
        unified: z
          .number()
          .optional()
          .describe("Lines of context (default 3, clamped 0..20)"),
      }),
      outputSchema: z.object({
        base: z.string(),
        head: z.string(),
        changes: z.array(changeSchema),
      }),
    },
    async ({ base, head, path, unified }, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const changes = getDiffBetweenRefs({ base, head, path, unified }, cwd);
        const result = { base, head, changes };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: {
            base,
            head,
            changes: changes.map((c) => ({
              ...c,
              hunks: c.hunks.map((h) => ({ ...h, lines: [...h.lines] })),
            })),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: blame (Tier 1 — read-only)
  // -------------------------------------------------------------------------

  server.registerTool(
    "blame",
    {
      description:
        "Line-level attribution for a file: for each line, returns the commit SHA, author, timestamp, and summary. Supports line ranges, whitespace-ignoring, and move/copy detection.",
      inputSchema: z.object({
        path: z.string().describe("Repo-relative file path to blame"),
        ref: z
          .string()
          .optional()
          .describe("Git ref to blame at (default HEAD)"),
        start_line: z
          .number()
          .optional()
          .describe("Start line (1-indexed, inclusive)"),
        end_line: z
          .number()
          .optional()
          .describe("End line (1-indexed, inclusive)"),
        ignore_whitespace: z
          .boolean()
          .optional()
          .describe("Ignore whitespace changes (default false)"),
        detect_moves: z
          .boolean()
          .optional()
          .describe("Detect moved/copied lines across files (default false)"),
      }),
      outputSchema: z.object({
        path: z.string(),
        ref: z.string(),
        lines: z.array(
          z.object({
            line_number: z.number(),
            content: z.string(),
            commit: z.object({
              sha: z.string(),
              short_sha: z.string(),
              author_name: z.string(),
              author_email: z.string(),
              author_time: z.string(),
              summary: z.string(),
            }),
          })
        ),
      }),
    },
    async ({ path, ref, start_line, end_line, ignore_whitespace, detect_moves }, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const result = getBlame({ path, ref, start_line, end_line, ignore_whitespace, detect_moves }, cwd);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: {
            path: result.path,
            ref: result.ref,
            lines: result.lines.map((l) => ({
              line_number: l.line_number,
              content: l.content,
              commit: { ...l.commit },
            })),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: stage_changes (Tier 2 — workspace mutation)
  // -------------------------------------------------------------------------

  server.registerTool(
    "stage_changes",
    {
      description:
        "Stage file paths for commit via `git add`. Accepts explicit file paths only (no wildcards). Use dry_run to validate before executing. Reversible via unstage_changes.",
      inputSchema: z.object({
        paths: z
          .array(z.string())
          .describe("File paths to stage (relative to repo root)"),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "When true, validate paths without staging. Default false."
          ),
      }),
      outputSchema: z.object({
        staged_paths: z.array(z.string()),
        dry_run: z.boolean(),
      }),
    },
    async ({ paths, dry_run }, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const result = stageChanges(paths, dry_run ?? false, cwd);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: unstage_changes (Tier 2 — workspace mutation)
  // -------------------------------------------------------------------------

  server.registerTool(
    "unstage_changes",
    {
      description:
        "Unstage file paths via `git reset HEAD`. Accepts explicit file paths only (no wildcards). Use dry_run to validate before executing. Reversible via stage_changes.",
      inputSchema: z.object({
        paths: z
          .array(z.string())
          .describe("File paths to unstage (relative to repo root)"),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "When true, validate paths without unstaging. Default false."
          ),
      }),
      outputSchema: z.object({
        unstaged_paths: z.array(z.string()),
        dry_run: z.boolean(),
      }),
    },
    async ({ paths, dry_run }, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const result = unstageChanges(paths, dry_run ?? false, cwd);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: { ...result },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: stage_hunks (Tier 2 — workspace mutation)
  // -------------------------------------------------------------------------

  server.registerTool(
    "stage_hunks",
    {
      description:
        "Stage specific hunks by file_path and hunk indices. Reconstructs a minimal patch with only selected hunks and applies via git apply --cached. Use dry_run to validate before executing.",
      inputSchema: z.object({
        file_path: z.string().describe("Repo-relative file path"),
        hunk_indices: z
          .array(z.number())
          .describe(
            "0-based indices of hunks to stage from the file's unstaged diff"
          ),
        dry_run: z
          .boolean()
          .optional()
          .describe("When true, validate without staging. Default false."),
      }),
      outputSchema: z.object({
        file_path: z.string(),
        hunks_staged: z.number(),
        dry_run: z.boolean(),
      }),
    },
    async ({ file_path, hunk_indices, dry_run }, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const result = stageHunks(
          file_path,
          hunk_indices,
          dry_run ?? false,
          cwd,
        );
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
          structuredContent: { ...result },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: create_commit (Tier 2 — workspace mutation)
  // -------------------------------------------------------------------------

  server.registerTool(
    "create_commit",
    {
      description:
        "Commit staged changes with a message. Use dry_run to inspect what would be committed.",
      inputSchema: z.object({
        message: z.string().describe("Commit message"),
        dry_run: z
          .boolean()
          .optional()
          .describe("When true, validate without committing. Default false."),
      }),
      outputSchema: z.object({
        sha: z.string(),
        short_sha: z.string(),
        subject: z.string(),
        dry_run: z.boolean(),
      }),
    },
    async ({ message, dry_run }, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const result = createCommit(message, dry_run ?? false, cwd);
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
          structuredContent: { ...result },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: msg }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: create_branch (Tier 2 — workspace mutation)
  // -------------------------------------------------------------------------

  server.registerTool(
    "create_branch",
    {
      description:
        "Create a new branch at a ref. Use dry_run to validate before creating.",
      inputSchema: z.object({
        name: z.string().describe("Branch name to create"),
        ref: z
          .string()
          .optional()
          .describe("Starting ref (default HEAD)"),
        dry_run: z
          .boolean()
          .optional()
          .describe("When true, validate without creating. Default false."),
      }),
      outputSchema: z.object({
        branch_name: z.string(),
        sha: z.string(),
        dry_run: z.boolean(),
      }),
    },
    async ({ name, ref, dry_run }, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const result = createBranch(name, ref, dry_run ?? false, cwd);
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
          structuredContent: { ...result },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: checkout_branch (Tier 2 — workspace mutation)
  // -------------------------------------------------------------------------

  server.registerTool(
    "checkout_branch",
    {
      description:
        "Switch to an existing branch. Git naturally refuses if uncommitted changes would be overwritten. Use dry_run to validate before switching.",
      inputSchema: z.object({
        name: z.string().describe("Branch name to switch to"),
        dry_run: z
          .boolean()
          .optional()
          .describe("When true, validate without switching. Default false."),
      }),
      outputSchema: z.object({
        branch_name: z.string(),
        previous_branch: z.string().nullable(),
        dry_run: z.boolean(),
      }),
    },
    async ({ name, dry_run }, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const result = checkoutBranch(name, dry_run ?? false, cwd);
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
          structuredContent: { ...result },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: stash_save (Tier 2 — workspace mutation)
  // -------------------------------------------------------------------------

  server.registerTool(
    "stash_save",
    {
      description:
        "Stash current changes. Use dry_run to check if there are changes to stash.",
      inputSchema: z.object({
        message: z
          .string()
          .optional()
          .describe("Optional stash message"),
        dry_run: z
          .boolean()
          .optional()
          .describe("When true, validate without stashing. Default false."),
      }),
      outputSchema: z.object({
        message: z.string(),
        dry_run: z.boolean(),
      }),
    },
    async ({ message, dry_run }, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const result = saveStash(message, dry_run ?? false, cwd);
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
          structuredContent: { ...result },
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: msg }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: stash_list (Tier 1 — read-only)
  // -------------------------------------------------------------------------

  server.registerTool(
    "stash_list",
    {
      description:
        "List all stashes as structured entries with index, message, and SHA.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        stashes: z.array(
          z.object({
            index: z.number(),
            message: z.string(),
            sha: z.string(),
          })
        ),
      }),
    },
    async (_args, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const result = listStashes(cwd);
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
          structuredContent: {
            stashes: result.stashes.map((s) => ({ ...s })),
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: stash_pop (Tier 2 — workspace mutation)
  // -------------------------------------------------------------------------

  server.registerTool(
    "stash_pop",
    {
      description:
        "Pop a stash entry, applying it to the working tree. Use dry_run to validate the stash exists.",
      inputSchema: z.object({
        index: z
          .number()
          .optional()
          .describe("Stash index to pop (default 0)"),
        dry_run: z
          .boolean()
          .optional()
          .describe("When true, validate without popping. Default false."),
      }),
      outputSchema: z.object({
        index: z.number(),
        dry_run: z.boolean(),
      }),
    },
    async ({ index, dry_run }, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const result = popStash(index, dry_run ?? false, cwd);
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
          structuredContent: { ...result },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: reset_soft (Tier 2 — workspace mutation)
  // -------------------------------------------------------------------------

  server.registerTool(
    "reset_soft",
    {
      description:
        "Move HEAD backward while keeping all changes staged. Use dry_run to preview the reset target.",
      inputSchema: z.object({
        ref: z
          .string()
          .describe("Target ref to reset to (e.g., HEAD~1, a SHA)"),
        dry_run: z
          .boolean()
          .optional()
          .describe("When true, validate without resetting. Default false."),
      }),
      outputSchema: z.object({
        ref: z.string(),
        previous_sha: z.string(),
        new_sha: z.string(),
        dry_run: z.boolean(),
      }),
    },
    async ({ ref, dry_run }, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const result = resetSoft(ref, dry_run ?? false, cwd);
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
          structuredContent: { ...result },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // Tool: push (Tier 3 — irreversible, gated)
  // -------------------------------------------------------------------------

  server.registerTool(
    "push",
    {
      description:
        "Push to remote. SAFETY: dry_run defaults to true — set dry_run: false explicitly to execute. Force push uses --force-with-lease for safety.",
      inputSchema: z.object({
        remote: z
          .string()
          .optional()
          .describe("Remote name (default 'origin')"),
        branch: z
          .string()
          .optional()
          .describe("Branch to push (default: current branch)"),
        force: z
          .boolean()
          .optional()
          .describe("Use --force-with-lease (default false)"),
        dry_run: z
          .boolean()
          .optional()
          .describe(
            "Simulate push without executing. DEFAULT TRUE for safety."
          ),
      }),
      outputSchema: z.object({
        remote: z.string(),
        branch: z.string(),
        dry_run: z.boolean(),
        forced: z.boolean(),
      }),
    },
    async ({ remote, branch, force, dry_run }, _extra) => {
      try {
        const cwd = requireRepoRoot();
        const result = pushToRemote(
          remote,
          branch,
          force ?? false,
          dry_run ?? true,
          cwd,
        );
        return {
          content: [
            { type: "text", text: JSON.stringify(result, null, 2) },
          ],
          structuredContent: { ...result },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      }
    }
  );

  return server;
}
