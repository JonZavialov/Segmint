/**
 * Segmint MCP Server factory.
 *
 * Creates and configures the McpServer with all tool registrations.
 * Separated from index.ts to enable in-process testing without spawning
 * a child process — tests import createServer() directly.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MOCK_CHANGE_GROUPS,
  MOCK_COMMIT_PLANS,
  MOCK_PR_DRAFT,
} from "./mock-data.js";
import { loadChanges, resolveChangeIds, buildEmbeddingText } from "./changes.js";
import { getEmbeddingProvider } from "./embeddings.js";
import { clusterByThreshold } from "./cluster.js";
import { getRepoStatus } from "./status.js";
import { getLog } from "./history.js";
import { getCommit } from "./show.js";
import { getDiffBetweenRefs } from "./diff.js";
import { getBlame } from "./blame.js";

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
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a fully-configured Segmint MCP server.
 *
 * The returned server has all 10 tools registered and is ready to be
 * connected to any MCP transport (stdio, in-memory, etc.).
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "segmint",
    version: "0.0.1",
  });

  // -------------------------------------------------------------------------
  // Tool: list_changes
  // -------------------------------------------------------------------------

  server.registerTool(
    "list_changes",
    {
      description:
        "List uncommitted changes in the repository, returned as structured Change objects with file paths and hunks.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        changes: z.array(
          z.object({
            id: z.string(),
            file_path: z.string(),
            hunks: z.array(hunkSchema),
          })
        ),
      }),
    },
    async (_args, _extra) => {
      try {
        const changes = loadChanges();
        const result = { changes };
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
      }),
    },
    async (_args, _extra) => {
      try {
        const status = getRepoStatus();
        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
          structuredContent: { ...status },
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
        const result = getLog(args);
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
        const result = getCommit(sha);
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
        const changes = getDiffBetweenRefs({ base, head, path, unified });
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
        const result = getBlame({ path, ref, start_line, end_line, ignore_whitespace, detect_moves });
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
  // Tool: group_changes
  // -------------------------------------------------------------------------

  server.registerTool(
    "group_changes",
    {
      description:
        "Group a set of changes by intent. Accepts change IDs and returns ChangeGroups, each with a summary describing the purpose of the grouped edits.",
      inputSchema: z.object({
        change_ids: z
          .array(z.string())
          .describe("IDs of changes to group (from list_changes)"),
      }),
      outputSchema: z.object({
        groups: z.array(
          z.object({
            id: z.string(),
            change_ids: z.array(z.string()),
            summary: z.string(),
          })
        ),
      }),
    },
    async ({ change_ids }, _extra) => {
      try {
        // Resolve requested IDs against current repo state
        const { changes, unknown } = resolveChangeIds(change_ids);
        if (unknown.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown change IDs: ${unknown.join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        // Single change — skip embeddings, return one group
        if (changes.length === 1) {
          const result = {
            groups: [
              {
                id: "group-1",
                change_ids: [changes[0].id],
                summary: `Changes in ${changes[0].file_path}`,
              },
            ],
          };
          return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
          };
        }

        // Get embedding provider (throws if OPENAI_API_KEY not set)
        const provider = getEmbeddingProvider();

        // Build embedding texts and compute embeddings
        const texts = changes.map((c) => buildEmbeddingText(c));
        const embeddings = await provider.embed(texts);

        // Cluster by cosine similarity
        const clusters = clusterByThreshold(embeddings, 0.80);

        // Map clusters to ChangeGroups
        const groups = clusters.map((cluster, idx) => {
          const clusterChanges = cluster.indices.map((i) => changes[i]);
          const filePaths = clusterChanges.map((c) => c.file_path);
          const summary =
            filePaths.length === 1
              ? `Changes in ${filePaths[0]}`
              : `Related changes across ${filePaths.join(", ")}`;

          return {
            id: `group-${idx + 1}`,
            change_ids: clusterChanges.map((c) => c.id),
            summary,
          };
        });

        const result = { groups };
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
  // Tool: propose_commits
  // -------------------------------------------------------------------------

  server.registerTool(
    "propose_commits",
    {
      description:
        "Given change group IDs, propose a sequence of commits. Returns CommitPlans with titles, descriptions, and the groups each commit covers.",
      inputSchema: z.object({
        group_ids: z
          .array(z.string())
          .describe("IDs of change groups to create commits for"),
      }),
      outputSchema: z.object({
        commits: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            description: z.string(),
            change_group_ids: z.array(z.string()),
          })
        ),
      }),
    },
    async ({ group_ids }, _extra) => {
      const knownIds = new Set(MOCK_CHANGE_GROUPS.map((g) => g.id));
      const unknown = group_ids.filter((id) => !knownIds.has(id));
      if (unknown.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown group IDs: ${unknown.join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      const result = { commits: MOCK_COMMIT_PLANS };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: apply_commit
  // -------------------------------------------------------------------------

  server.registerTool(
    "apply_commit",
    {
      description:
        "Apply a proposed commit to the repository. Accepts a commit plan ID and stages + commits the associated changes.",
      inputSchema: z.object({
        commit_id: z.string().describe("ID of the commit plan to apply"),
      }),
      outputSchema: z.object({
        success: z.boolean(),
      }),
    },
    async ({ commit_id }, _extra) => {
      const known = MOCK_COMMIT_PLANS.some((c) => c.id === commit_id);
      if (!known) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown commit ID: ${commit_id}`,
            },
          ],
          isError: true,
        };
      }

      const result = { success: true };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  );

  // -------------------------------------------------------------------------
  // Tool: generate_pr
  // -------------------------------------------------------------------------

  server.registerTool(
    "generate_pr",
    {
      description:
        "Generate a pull request draft from a set of commit plan IDs. Returns a PullRequestDraft with a title, description, and the full list of commits.",
      inputSchema: z.object({
        commit_ids: z
          .array(z.string())
          .describe("IDs of commit plans to include in the PR"),
      }),
      outputSchema: z.object({
        title: z.string(),
        description: z.string(),
        commits: z.array(
          z.object({
            id: z.string(),
            title: z.string(),
            description: z.string(),
            change_group_ids: z.array(z.string()),
          })
        ),
      }),
    },
    async ({ commit_ids }, _extra) => {
      const knownIds = new Set(MOCK_COMMIT_PLANS.map((c) => c.id));
      const unknown = commit_ids.filter((id) => !knownIds.has(id));
      if (unknown.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown commit IDs: ${unknown.join(", ")}`,
            },
          ],
          isError: true,
        };
      }

      const result = {
        title: MOCK_PR_DRAFT.title,
        description: MOCK_PR_DRAFT.description,
        commits: MOCK_PR_DRAFT.commits.map((c) => ({ ...c })),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      };
    }
  );

  return server;
}
