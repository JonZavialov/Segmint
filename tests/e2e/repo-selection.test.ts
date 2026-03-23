/**
 * E2E regression test: repo selection from non-repo cwd.
 *
 * Verifies the critical invariant: the MCP server must NOT silently
 * use process.cwd(). All git tools must return SEGMINT_NO_REPO until
 * set_repo_root is called, and must target the configured repo thereafter.
 *
 * This test does NOT chdir into a git repo — it relies solely on
 * set_repo_root to select the target repository.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../../src/server.js";

function createTempRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "segmint-reposel-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  git(["init"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "commit.gpgsign", "false"]);

  writeFileSync(join(dir, "hello.txt"), "hello world\n");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);

  writeFileSync(join(dir, "hello.txt"), "hello world v2\n");
  git(["add", "."]);
  git(["commit", "-m", "second commit"]);

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("Repo selection E2E (non-repo cwd)", () => {
  let client: Client;
  let repoDir: string;
  let cleanupRepo: () => void;

  beforeAll(async () => {
    ({ dir: repoDir, cleanup: cleanupRepo } = createTempRepo());

    // Do NOT chdir into the repo — server runs from test runner's cwd
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    client = new Client({ name: "test-reposel", version: "1.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterAll(async () => {
    await client.close();
    cleanupRepo();
  });

  // -----------------------------------------------------------------------
  // Before set_repo_root: all git tools must fail with SEGMINT_NO_REPO
  // -----------------------------------------------------------------------

  it("get_repo_root returns null before set_repo_root", async () => {
    const result = await client.callTool({
      name: "get_repo_root",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { repo_root: string | null };
    expect(sc.repo_root).toBeNull();
  });

  it("repo_status returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "repo_status",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("list_changes returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "list_changes",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("log returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "log",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("show_commit returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "show_commit",
      arguments: { sha: "HEAD" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("diff_between_refs returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "diff_between_refs",
      arguments: { base: "HEAD~1", head: "HEAD" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("blame returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "blame",
      arguments: { path: "hello.txt" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("stage_changes returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "stage_changes",
      arguments: { paths: ["hello.txt"] },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("unstage_changes returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "unstage_changes",
      arguments: { paths: ["hello.txt"] },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("stage_hunks returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "stage_hunks",
      arguments: { file_path: "hello.txt", hunk_indices: [0] },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("create_commit returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "create_commit",
      arguments: { message: "test" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("create_branch returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "create_branch",
      arguments: { name: "test" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("checkout_branch returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "checkout_branch",
      arguments: { name: "test" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("stash_save returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "stash_save",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("stash_list returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "stash_list",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("stash_pop returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "stash_pop",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("reset_soft returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "reset_soft",
      arguments: { ref: "HEAD" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  it("push returns SEGMINT_NO_REPO before set_repo_root", async () => {
    const result = await client.callTool({
      name: "push",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("SEGMINT_NO_REPO");
  });

  // -----------------------------------------------------------------------
  // set_repo_root: configure, then verify tools work
  // -----------------------------------------------------------------------

  it("set_repo_root succeeds with valid repo path", async () => {
    const result = await client.callTool({
      name: "set_repo_root",
      arguments: { path: repoDir },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { repo_root: string };
    expect(sc.repo_root).toBeTruthy();
  });

  it("get_repo_root returns path after set_repo_root", async () => {
    const result = await client.callTool({
      name: "get_repo_root",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { repo_root: string | null };
    expect(sc.repo_root).toBeTruthy();
  });

  it("repo_status works after set_repo_root", async () => {
    const result = await client.callTool({
      name: "repo_status",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as Record<string, unknown>;
    expect(sc.is_git_repo).toBe(true);
  });

  it("log works after set_repo_root", async () => {
    const result = await client.callTool({
      name: "log",
      arguments: { limit: 5 },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { commits: unknown[] };
    expect(sc.commits.length).toBeGreaterThanOrEqual(1);
  });

  it("show_commit works after set_repo_root", async () => {
    const result = await client.callTool({
      name: "show_commit",
      arguments: { sha: "HEAD" },
    });
    expect(result.isError).toBeFalsy();
  });

  it("blame works after set_repo_root", async () => {
    const result = await client.callTool({
      name: "blame",
      arguments: { path: "hello.txt" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      path: string;
      lines: Array<{ content: string }>;
    };
    expect(sc.path).toBe("hello.txt");
    expect(sc.lines.length).toBeGreaterThanOrEqual(1);
  });

  it("set_repo_root with non-repo path returns error and preserves previous root", async () => {
    // Create a temp dir that is NOT a git repo
    const notARepo = mkdtempSync(join(tmpdir(), "segmint-notrepo-"));
    try {
      const result = await client.callTool({
        name: "set_repo_root",
        arguments: { path: notARepo },
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0].text;
      expect(text).toContain("Not a git repository");

      // Previous root should be preserved
      const rootResult = await client.callTool({
        name: "get_repo_root",
        arguments: {},
      });
      const sc = rootResult.structuredContent as { repo_root: string | null };
      expect(sc.repo_root).toBeTruthy();
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });
});
