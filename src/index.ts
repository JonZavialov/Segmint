#!/usr/bin/env node
/**
 * Segmint MCP Server
 *
 * Exposes Git as semantic objects (Change, ChangeGroup, CommitPlan, PullRequestDraft)
 * so AI agents can inspect a repo, cluster edits by intent, plan commits, and generate PRs.
 *
 * This is the MCP skeleton with mocked data. Real git + embeddings come later.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  MOCK_CHANGES,
  MOCK_CHANGE_GROUPS,
  MOCK_COMMIT_PLANS,
  MOCK_PR_DRAFT,
} from "./mock-data.js";

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: "segmint",
  version: "0.0.1",
});

// ---------------------------------------------------------------------------
// Tool: list_changes
// ---------------------------------------------------------------------------

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
          hunks: z.array(
            z.object({
              old_start: z.number(),
              old_lines: z.number(),
              new_start: z.number(),
              new_lines: z.number(),
              header: z.string(),
              lines: z.array(z.string()),
            })
          ),
        })
      ),
    }),
  },
  async (_args, _extra) => {
    const result = { changes: MOCK_CHANGES };
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: group_changes
// ---------------------------------------------------------------------------

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
    // Validate that all requested IDs exist
    const knownIds = new Set(MOCK_CHANGES.map((c) => c.id));
    const unknown = change_ids.filter((id) => !knownIds.has(id));
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

    const result = { groups: MOCK_CHANGE_GROUPS };
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      structuredContent: result,
    };
  }
);

// ---------------------------------------------------------------------------
// Tool: propose_commits
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool: apply_commit
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tool: generate_pr
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Segmint MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
