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
      "checkout_branch",
      "create_branch",
      "create_commit",
      "diff_between_refs",
      "get_repo_root",
      "list_changes",
      "log",
      "push",
      "repo_status",
      "reset_soft",
      "set_repo_root",
      "show_commit",
      "stage_changes",
      "stage_hunks",
      "stash_list",
      "stash_pop",
      "stash_save",
      "unstage_changes",
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

  it("list_changes with path filter", async () => {
    writeFileSync(join(dir, "file.txt"), "e2e modified\n");
    writeFileSync(join(dir, "other.txt"), "other\n");
    execFileSync("git", ["add", "other.txt"], { cwd: dir });

    const result = await client.callTool({
      name: "list_changes",
      arguments: { path: "file.txt" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { changes: Array<{ file_path: string }> };
    expect(sc.changes).toHaveLength(1);
    expect(sc.changes[0].file_path).toBe("file.txt");

    // Restore
    writeFileSync(join(dir, "file.txt"), "modified content\n");
    execFileSync("git", ["reset", "HEAD", "other.txt"], { cwd: dir });
    rmSync(join(dir, "other.txt"), { force: true });
  });

  it("list_changes with summary_only", async () => {
    writeFileSync(join(dir, "file.txt"), "e2e modified\n");
    const result = await client.callTool({
      name: "list_changes",
      arguments: { summary_only: true },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      changes: Array<{
        id: string;
        file_path: string;
        hunk_count: number;
        insertions: number;
        deletions: number;
        hunks?: unknown;
      }>;
    };
    expect(sc.changes).toHaveLength(1);
    expect(sc.changes[0].file_path).toBe("file.txt");
    expect(sc.changes[0].hunk_count).toBeGreaterThanOrEqual(1);
    expect(typeof sc.changes[0].insertions).toBe("number");
    expect(typeof sc.changes[0].deletions).toBe("number");
    // summary_only should NOT have hunks
    expect(sc.changes[0].hunks).toBeUndefined();

    // Restore
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

  it("stage_changes stages a file", async () => {
    writeFileSync(join(dir, "file.txt"), "stage-test\n");

    const result = await client.callTool({
      name: "stage_changes",
      arguments: { paths: ["file.txt"] },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { staged_paths: string[]; dry_run: boolean };
    expect(sc.staged_paths).toEqual(["file.txt"]);
    expect(sc.dry_run).toBe(false);

    // Unstage and restore
    execFileSync("git", ["reset", "HEAD", "file.txt"], { cwd: dir });
    writeFileSync(join(dir, "file.txt"), "modified content\n");
  });

  it("stage_changes dry_run does not mutate", async () => {
    writeFileSync(join(dir, "file.txt"), "dry-run-test\n");

    const result = await client.callTool({
      name: "stage_changes",
      arguments: { paths: ["file.txt"], dry_run: true },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { staged_paths: string[]; dry_run: boolean };
    expect(sc.dry_run).toBe(true);

    // Restore
    writeFileSync(join(dir, "file.txt"), "modified content\n");
  });

  it("stage_changes with empty paths returns error", async () => {
    const result = await client.callTool({
      name: "stage_changes",
      arguments: { paths: [] },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_EMPTY_PATHS");
  });

  it("unstage_changes unstages a file", async () => {
    writeFileSync(join(dir, "file.txt"), "unstage-test\n");
    execFileSync("git", ["add", "file.txt"], { cwd: dir });

    const result = await client.callTool({
      name: "unstage_changes",
      arguments: { paths: ["file.txt"] },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { unstaged_paths: string[]; dry_run: boolean };
    expect(sc.unstaged_paths).toEqual(["file.txt"]);
    expect(sc.dry_run).toBe(false);

    // Restore
    writeFileSync(join(dir, "file.txt"), "modified content\n");
  });

  it("unstage_changes with empty paths returns error", async () => {
    const result = await client.callTool({
      name: "unstage_changes",
      arguments: { paths: [] },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_EMPTY_PATHS");
  });

  // ---- stage_hunks ----

  it("stage_hunks dry_run validates without staging", async () => {
    writeFileSync(join(dir, "file.txt"), "hunk-test\n");
    const result = await client.callTool({
      name: "stage_hunks",
      arguments: { file_path: "file.txt", hunk_indices: [0], dry_run: true },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { file_path: string; hunks_staged: number; dry_run: boolean };
    expect(sc.dry_run).toBe(true);
    expect(sc.hunks_staged).toBe(1);
    writeFileSync(join(dir, "file.txt"), "modified content\n");
  });

  it("stage_hunks with empty hunk_indices returns error", async () => {
    const result = await client.callTool({
      name: "stage_hunks",
      arguments: { file_path: "file.txt", hunk_indices: [] },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_EMPTY_HUNKS");
  });

  // ---- create_commit ----

  it("create_commit dry_run validates without committing", async () => {
    writeFileSync(join(dir, "file.txt"), "commit-test\n");
    execFileSync("git", ["add", "file.txt"], { cwd: dir });

    const result = await client.callTool({
      name: "create_commit",
      arguments: { message: "e2e dry commit", dry_run: true },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { sha: string; subject: string; dry_run: boolean };
    expect(sc.dry_run).toBe(true);
    expect(sc.subject).toBe("e2e dry commit");

    execFileSync("git", ["reset", "HEAD", "file.txt"], { cwd: dir });
    writeFileSync(join(dir, "file.txt"), "modified content\n");
  });

  it("create_commit with nothing staged returns error", async () => {
    const result = await client.callTool({
      name: "create_commit",
      arguments: { message: "should fail" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NOTHING_STAGED");
  });

  // ---- create_branch ----

  it("create_branch creates and returns branch info", async () => {
    const result = await client.callTool({
      name: "create_branch",
      arguments: { name: "e2e-test-branch" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { branch_name: string; sha: string; dry_run: boolean };
    expect(sc.branch_name).toBe("e2e-test-branch");
    expect(sc.dry_run).toBe(false);
  });

  it("create_branch with existing name returns error", async () => {
    const result = await client.callTool({
      name: "create_branch",
      arguments: { name: "e2e-test-branch" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_BRANCH_EXISTS");
  });

  // ---- checkout_branch ----

  it("checkout_branch switches to branch", async () => {
    const result = await client.callTool({
      name: "checkout_branch",
      arguments: { name: "e2e-test-branch" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { branch_name: string; previous_branch: string | null; dry_run: boolean };
    expect(sc.branch_name).toBe("e2e-test-branch");
    expect(sc.dry_run).toBe(false);

    // Switch back to original branch
    if (sc.previous_branch) {
      await client.callTool({
        name: "checkout_branch",
        arguments: { name: sc.previous_branch },
      });
    }
  });

  it("checkout_branch with nonexistent branch returns error", async () => {
    const result = await client.callTool({
      name: "checkout_branch",
      arguments: { name: "nonexistent-xyz" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_BRANCH_NOT_FOUND");
  });

  // ---- stash_list ----

  it("stash_list returns structured stash entries", async () => {
    const result = await client.callTool({
      name: "stash_list",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { stashes: unknown[] };
    expect(Array.isArray(sc.stashes)).toBe(true);
  });

  // ---- stash_save ----

  it("stash_save with nothing to stash returns error", async () => {
    const result = await client.callTool({
      name: "stash_save",
      arguments: { message: "should fail" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NOTHING_TO_STASH");
  });

  // ---- stash_pop ----

  it("stash_pop with no stashes returns error", async () => {
    const result = await client.callTool({
      name: "stash_pop",
      arguments: { index: 99 },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_STASH_NOT_FOUND");
  });

  // ---- reset_soft ----

  it("reset_soft dry_run returns SHA info", async () => {
    const result = await client.callTool({
      name: "reset_soft",
      arguments: { ref: "HEAD", dry_run: true },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { ref: string; previous_sha: string; new_sha: string; dry_run: boolean };
    expect(sc.dry_run).toBe(true);
    expect(sc.previous_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(sc.new_sha).toMatch(/^[0-9a-f]{40}$/);
  });

  // ---- push ----

  it("push defaults to dry_run true", async () => {
    const result = await client.callTool({
      name: "push",
      arguments: {},
    });
    // Will error because no remote configured on temp repo, but tests the handler
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REMOTE");
  });
});
