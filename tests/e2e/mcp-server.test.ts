import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";

function createTempRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "segmint-e2e-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  git(["init"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "commit.gpgsign", "false"]);

  writeFileSync(join(dir, "file.txt"), "initial content\n");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);

  writeFileSync(join(dir, "file.txt"), "modified content\n");
  git(["add", "."]);
  git(["commit", "-m", "second commit"]);

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("MCP server E2E (in-process)", () => {
  let client: Client;
  let dir: string;
  let cleanup: () => void;

  beforeAll(async () => {
    ({ dir, cleanup } = createTempRepo());

    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    // Select the temp repo as the active repository
    const setResult = await client.callTool({
      name: "set_repo_root",
      arguments: { path: dir },
    });
    if (setResult.isError) {
      throw new Error(`Failed to set repo root: ${(setResult.content as Array<{ text: string }>)[0].text}`);
    }
  });

  afterAll(async () => {
    await client.close();
    cleanup();
  });

  it("lists all tools", async () => {
    const result = await client.listTools();
    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "blame",
      "diff_between_refs",
      "get_repo_root",
      "list_changes",
      "log",
      "repo_status",
      "set_repo_root",
      "show_commit",
    ]);
  });

  it("doc-contract: tool names match CLAUDE.md tool table", async () => {
    // Read CLAUDE.md and extract tool names from the MCP Tool Contracts table
    const claudeMd = readFileSync(
      join(__dirname, "..", "..", "CLAUDE.md"),
      "utf8"
    );
    // Extract the MCP Tool Contracts section
    const toolSection = claudeMd.split("## MCP Tool Contracts")[1]?.split("\n##")[0] ?? "";
    // Match lines starting with "| `tool_name` |" — first column only (anchored to line start)
    const toolMatches = toolSection.matchAll(/^\| `(\w+)` \|/gm);
    const docToolNames = [...toolMatches].map((m) => m[1]).sort();
    expect(docToolNames.length).toBeGreaterThan(0);

    // Compare against actual server tool list
    const result = await client.listTools();
    const serverToolNames = result.tools.map((t) => t.name).sort();
    expect(docToolNames).toEqual(serverToolNames);
  });

  it("get_repo_root returns the configured root", async () => {
    const result = await client.callTool({
      name: "get_repo_root",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { repo_root: string | null };
    expect(sc.repo_root).toBeTruthy();
  });

  it("repo_status returns structured data", async () => {
    const result = await client.callTool({
      name: "repo_status",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.is_git_repo).toBe(true);
    expect(sc.head).toBeDefined();
  });

  it("list_changes returns structured data", async () => {
    // Add unstaged change
    writeFileSync(join(dir, "file.txt"), "e2e modified\n");
    const result = await client.callTool({
      name: "list_changes",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toBeDefined();
    // Restore for other tests
    writeFileSync(join(dir, "file.txt"), "modified content\n");
  });

  it("log returns commits", async () => {
    const result = await client.callTool({
      name: "log",
      arguments: { limit: 5 },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { commits: unknown[] };
    expect(sc.commits.length).toBeGreaterThanOrEqual(1);
  });

  it("show_commit returns commit details", async () => {
    const result = await client.callTool({
      name: "show_commit",
      arguments: { sha: "HEAD" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { commit: Record<string, unknown> };
    expect(sc.commit.sha).toBeTruthy();
    expect(sc.commit.subject).toBeTruthy();
  });

  it("diff_between_refs returns changes", async () => {
    const result = await client.callTool({
      name: "diff_between_refs",
      arguments: { base: "HEAD~1", head: "HEAD" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { changes: unknown[] };
    expect(sc.changes.length).toBeGreaterThanOrEqual(1);
  });

  it("diff_between_refs with invalid refs returns error", async () => {
    const result = await client.callTool({
      name: "diff_between_refs",
      arguments: { base: "nonexistent-ref-xyz", head: "HEAD" },
    });
    expect(result.isError).toBe(true);
  });

  it("show_commit with invalid sha returns error", async () => {
    const result = await client.callTool({
      name: "show_commit",
      arguments: { sha: "0000000000000000000000000000000000000000" },
    });
    expect(result.isError).toBe(true);
  });

  it("log with invalid ref returns error", async () => {
    const result = await client.callTool({
      name: "log",
      arguments: { ref: "nonexistent-ref-xyz" },
    });
    expect(result.isError).toBe(true);
  });

  it("blame returns structured line-level data", async () => {
    const result = await client.callTool({
      name: "blame",
      arguments: { path: "file.txt" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      path: string;
      ref: string;
      lines: Array<{ line_number: number; content: string; commit: Record<string, string> }>;
    };
    expect(sc.path).toBe("file.txt");
    expect(sc.ref).toBe("HEAD");
    expect(sc.lines.length).toBeGreaterThanOrEqual(1);
    expect(sc.lines[0].commit.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sc.lines[0].commit.author_name).toBe("Test");
  });

  it("blame with invalid path returns error", async () => {
    const result = await client.callTool({
      name: "blame",
      arguments: { path: "nonexistent-file.xyz" },
    });
    expect(result.isError).toBe(true);
  });

  it("blame with line range", async () => {
    const result = await client.callTool({
      name: "blame",
      arguments: { path: "file.txt", start_line: 1, end_line: 1 },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { lines: Array<{ line_number: number }> };
    expect(sc.lines).toHaveLength(1);
    expect(sc.lines[0].line_number).toBe(1);
  });
});
