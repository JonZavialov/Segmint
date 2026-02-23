import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * Test server.ts error catch blocks that can't easily be triggered in E2E tests.
 *
 * Mocks the underlying modules to throw, exercising the try/catch error paths
 * in all tool handlers. Also tests set_repo_root / get_repo_root tools.
 */

// Mock modules to throw errors on demand
const mockGetUncommittedChanges = vi.fn();
const mockGetRepoStatus = vi.fn();
const mockGetLog = vi.fn();
const mockGetCommit = vi.fn();
const mockGetDiffBetweenRefs = vi.fn();
const mockGetBlame = vi.fn();
const mockExecGit = vi.fn();

vi.mock("../../src/git.js", () => ({
  getUncommittedChanges: (...args: unknown[]) => mockGetUncommittedChanges(...args),
}));

vi.mock("../../src/status.js", () => ({
  getRepoStatus: (...args: unknown[]) => mockGetRepoStatus(...args),
}));

vi.mock("../../src/history.js", () => ({
  getLog: (...args: unknown[]) => mockGetLog(...args),
}));

vi.mock("../../src/show.js", () => ({
  getCommit: (...args: unknown[]) => mockGetCommit(...args),
}));

vi.mock("../../src/diff.js", () => ({
  getDiffBetweenRefs: (...args: unknown[]) => mockGetDiffBetweenRefs(...args),
}));

vi.mock("../../src/blame.js", () => ({
  getBlame: (...args: unknown[]) => mockGetBlame(...args),
}));

vi.mock("../../src/exec-git.js", () => ({
  execGit: (...args: unknown[]) => mockExecGit(...args),
}));

describe("server.ts error catch blocks", () => {
  let client: Client;

  beforeAll(async () => {
    // set_repo_root calls execGit(["rev-parse", "--show-toplevel"], absPath)
    // Mock it to return a fake repo root
    mockExecGit.mockReturnValue("/fake/repo\n");

    const { createServer } = await import("../../src/server.js");
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-errors", version: "1.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    // Set repo root so tools don't fail with SEGMINT_NO_REPO
    await client.callTool({
      name: "set_repo_root",
      arguments: { path: "/fake/repo" },
    });
  });

  afterAll(async () => {
    await client.close();
  });

  // ---- set_repo_root / get_repo_root ----

  it("get_repo_root returns configured root", async () => {
    const result = await client.callTool({
      name: "get_repo_root",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { repo_root: string | null };
    expect(sc.repo_root).toBe("/fake/repo");
  });

  it("set_repo_root with non-repo path returns error", async () => {
    mockExecGit.mockImplementationOnce(() => {
      throw new Error("Not a git repository");
    });
    const result = await client.callTool({
      name: "set_repo_root",
      arguments: { path: "/nonexistent" },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toContain("Not a git repository");

    // Ensure previous root is preserved
    const rootResult = await client.callTool({
      name: "get_repo_root",
      arguments: {},
    });
    const sc = rootResult.structuredContent as { repo_root: string | null };
    expect(sc.repo_root).toBe("/fake/repo");
  });

  // ---- list_changes ----

  it("list_changes returns truncated when over 200 changes", async () => {
    // Generate 210 fake changes
    const fakeChanges = Array.from({ length: 210 }, (_, i) => ({
      id: `change-${i + 1}`,
      file_path: `file-${i + 1}.ts`,
      hunks: [],
    }));
    mockGetUncommittedChanges.mockReturnValue(fakeChanges);

    const result = await client.callTool({
      name: "list_changes",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      changes: unknown[];
      truncated?: boolean;
      omitted_count?: number;
    };
    expect(sc.changes).toHaveLength(200);
    expect(sc.truncated).toBe(true);
    expect(sc.omitted_count).toBe(10);
  });

  it("list_changes catch block returns isError on throw", async () => {
    mockGetUncommittedChanges.mockImplementation(() => {
      throw new Error("git failed");
    });

    const result = await client.callTool({
      name: "list_changes",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toBe("git failed");
  });

  it("list_changes catch with non-Error value", async () => {
    mockGetUncommittedChanges.mockImplementation(() => {
      throw "string error";
    });

    const result = await client.callTool({
      name: "list_changes",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toBe("string error");
  });

  // ---- repo_status ----

  it("repo_status returns truncated when arrays exceed cap", async () => {
    mockGetRepoStatus.mockReturnValue({
      is_git_repo: true,
      root_path: "/fake/repo",
      head: { type: "branch", name: "main" },
      staged: Array.from({ length: 210 }, (_, i) => ({ path: `staged-${i}.ts`, status: "modified" })),
      unstaged: [],
      untracked: [],
      merge_in_progress: false,
      rebase_in_progress: false,
    });

    const result = await client.callTool({
      name: "repo_status",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as {
      staged: unknown[];
      truncated?: boolean;
    };
    expect(sc.staged).toHaveLength(200);
    expect(sc.truncated).toBe(true);
  });

  it("repo_status catch block returns isError on throw", async () => {
    mockGetRepoStatus.mockImplementation(() => {
      throw new Error("not a git repo");
    });

    const result = await client.callTool({
      name: "repo_status",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toBe("not a git repo");
  });

  it("repo_status catch with non-Error value", async () => {
    mockGetRepoStatus.mockImplementation(() => {
      throw 42;
    });

    const result = await client.callTool({
      name: "repo_status",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toBe("42");
  });

  // ---- log ----

  it("log catch block returns isError on throw", async () => {
    mockGetLog.mockImplementation(() => {
      throw new Error("bad ref");
    });

    const result = await client.callTool({
      name: "log",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("bad ref");
  });

  it("log catch with non-Error value", async () => {
    mockGetLog.mockImplementation(() => {
      throw "log string error";
    });

    const result = await client.callTool({
      name: "log",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("log string error");
  });

  // ---- show_commit ----

  it("show_commit catch block returns isError on throw", async () => {
    mockGetCommit.mockImplementation(() => {
      throw new Error("unknown sha");
    });

    const result = await client.callTool({
      name: "show_commit",
      arguments: { sha: "abc" },
    });
    expect(result.isError).toBe(true);
  });

  it("show_commit catch with non-Error value", async () => {
    mockGetCommit.mockImplementation(() => {
      throw "show string error";
    });

    const result = await client.callTool({
      name: "show_commit",
      arguments: { sha: "abc" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("show string error");
  });

  // ---- diff_between_refs ----

  it("diff_between_refs catch block returns isError on throw", async () => {
    mockGetDiffBetweenRefs.mockImplementation(() => {
      throw new Error("bad ref");
    });

    const result = await client.callTool({
      name: "diff_between_refs",
      arguments: { base: "a", head: "b" },
    });
    expect(result.isError).toBe(true);
  });

  it("diff_between_refs catch with non-Error value", async () => {
    mockGetDiffBetweenRefs.mockImplementation(() => {
      throw "diff string error";
    });

    const result = await client.callTool({
      name: "diff_between_refs",
      arguments: { base: "a", head: "b" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("diff string error");
  });

  // ---- blame ----

  it("blame catch block returns isError on throw", async () => {
    mockGetBlame.mockImplementation(() => {
      throw new Error("no such path");
    });

    const result = await client.callTool({
      name: "blame",
      arguments: { path: "missing.txt" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("no such path");
  });

  it("blame catch with non-Error value", async () => {
    mockGetBlame.mockImplementation(() => {
      throw "blame string error";
    });

    const result = await client.callTool({
      name: "blame",
      arguments: { path: "missing.txt" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("blame string error");
  });
});
