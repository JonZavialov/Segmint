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
const mockStageChanges = vi.fn();
const mockUnstageChanges = vi.fn();
const mockStageHunks = vi.fn();
const mockExecGit = vi.fn();
const mockCreateCommit = vi.fn();
const mockCreateBranch = vi.fn();
const mockCheckoutBranch = vi.fn();
const mockListStashes = vi.fn();
const mockSaveStash = vi.fn();
const mockPopStash = vi.fn();
const mockResetSoft = vi.fn();
const mockPushToRemote = vi.fn();

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

vi.mock("../../src/staging.js", () => ({
  stageChanges: (...args: unknown[]) => mockStageChanges(...args),
  unstageChanges: (...args: unknown[]) => mockUnstageChanges(...args),
  stageHunks: (...args: unknown[]) => mockStageHunks(...args),
}));

vi.mock("../../src/commit.js", () => ({
  createCommit: (...args: unknown[]) => mockCreateCommit(...args),
}));

vi.mock("../../src/branch.js", () => ({
  createBranch: (...args: unknown[]) => mockCreateBranch(...args),
  checkoutBranch: (...args: unknown[]) => mockCheckoutBranch(...args),
}));

vi.mock("../../src/stash.js", () => ({
  listStashes: (...args: unknown[]) => mockListStashes(...args),
  saveStash: (...args: unknown[]) => mockSaveStash(...args),
  popStash: (...args: unknown[]) => mockPopStash(...args),
}));

vi.mock("../../src/reset.js", () => ({
  resetSoft: (...args: unknown[]) => mockResetSoft(...args),
}));

vi.mock("../../src/push.js", () => ({
  pushToRemote: (...args: unknown[]) => mockPushToRemote(...args),
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

  it("list_changes with path passes argument to getUncommittedChanges", async () => {
    const fakeChanges = [
      { id: "change-1", file_path: "src/foo.ts", hunks: [{ old_start: 1, old_lines: 1, new_start: 1, new_lines: 1, header: "@@ -1,1 +1,1 @@", lines: ["+added"] }] },
    ];
    mockGetUncommittedChanges.mockReturnValue(fakeChanges);

    const result = await client.callTool({
      name: "list_changes",
      arguments: { path: "src/" },
    });
    expect(result.isError).toBeFalsy();
    // Verify getUncommittedChanges was called with path
    expect(mockGetUncommittedChanges).toHaveBeenCalledWith("/fake/repo", "src/");
  });

  it("list_changes with summary_only returns stats without hunks", async () => {
    const fakeChanges = [
      {
        id: "change-1",
        file_path: "file.ts",
        hunks: [
          { old_start: 1, old_lines: 2, new_start: 1, new_lines: 3, header: "@@ -1,2 +1,3 @@", lines: ["+added1", "+added2", "-removed1"] },
          { old_start: 10, old_lines: 1, new_start: 11, new_lines: 1, header: "@@ -10,1 +11,1 @@", lines: ["-old", "+new"] },
        ],
      },
    ];
    mockGetUncommittedChanges.mockReturnValue(fakeChanges);

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
    expect(sc.changes[0].id).toBe("change-1");
    expect(sc.changes[0].file_path).toBe("file.ts");
    expect(sc.changes[0].hunk_count).toBe(2);
    expect(sc.changes[0].insertions).toBe(3); // +added1, +added2, +new
    expect(sc.changes[0].deletions).toBe(2); // -removed1, -old
    expect(sc.changes[0].hunks).toBeUndefined();
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

  // ---- stage_changes ----

  it("stage_changes returns structured result on success", async () => {
    mockStageChanges.mockReturnValue({ staged_paths: ["file.ts"], dry_run: false });

    const result = await client.callTool({
      name: "stage_changes",
      arguments: { paths: ["file.ts"] },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { staged_paths: string[]; dry_run: boolean };
    expect(sc.staged_paths).toEqual(["file.ts"]);
    expect(sc.dry_run).toBe(false);
  });

  it("stage_changes catch block returns isError on throw", async () => {
    mockStageChanges.mockImplementation(() => {
      throw new Error("SEGMINT_EMPTY_PATHS: paths array must not be empty.");
    });

    const result = await client.callTool({
      name: "stage_changes",
      arguments: { paths: [] },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain("SEGMINT_EMPTY_PATHS");
  });

  it("stage_changes catch with non-Error value", async () => {
    mockStageChanges.mockImplementation(() => {
      throw "stage string error";
    });

    const result = await client.callTool({
      name: "stage_changes",
      arguments: { paths: ["x.ts"] },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("stage string error");
  });

  // ---- unstage_changes ----

  it("unstage_changes returns structured result on success", async () => {
    mockUnstageChanges.mockReturnValue({ unstaged_paths: ["file.ts"], dry_run: false });

    const result = await client.callTool({
      name: "unstage_changes",
      arguments: { paths: ["file.ts"] },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { unstaged_paths: string[]; dry_run: boolean };
    expect(sc.unstaged_paths).toEqual(["file.ts"]);
    expect(sc.dry_run).toBe(false);
  });

  it("unstage_changes catch block returns isError on throw", async () => {
    mockUnstageChanges.mockImplementation(() => {
      throw new Error("SEGMINT_EMPTY_PATHS: paths array must not be empty.");
    });

    const result = await client.callTool({
      name: "unstage_changes",
      arguments: { paths: [] },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain("SEGMINT_EMPTY_PATHS");
  });

  it("unstage_changes catch with non-Error value", async () => {
    mockUnstageChanges.mockImplementation(() => {
      throw "unstage string error";
    });

    const result = await client.callTool({
      name: "unstage_changes",
      arguments: { paths: ["x.ts"] },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("unstage string error");
  });

  // ---- stage_hunks ----

  it("stage_hunks returns structured result on success", async () => {
    mockStageHunks.mockReturnValue({ file_path: "file.ts", hunks_staged: 1, dry_run: false });

    const result = await client.callTool({
      name: "stage_hunks",
      arguments: { file_path: "file.ts", hunk_indices: [0] },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { file_path: string; hunks_staged: number; dry_run: boolean };
    expect(sc.file_path).toBe("file.ts");
    expect(sc.hunks_staged).toBe(1);
    expect(sc.dry_run).toBe(false);
  });

  it("stage_hunks catch block returns isError on throw", async () => {
    mockStageHunks.mockImplementation(() => {
      throw new Error("SEGMINT_EMPTY_HUNKS: hunk_indices array must not be empty.");
    });

    const result = await client.callTool({
      name: "stage_hunks",
      arguments: { file_path: "file.ts", hunk_indices: [] },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain("SEGMINT_EMPTY_HUNKS");
  });

  it("stage_hunks catch with non-Error value", async () => {
    mockStageHunks.mockImplementation(() => {
      throw "stage_hunks string error";
    });

    const result = await client.callTool({
      name: "stage_hunks",
      arguments: { file_path: "file.ts", hunk_indices: [0] },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("stage_hunks string error");
  });

  // ---- create_commit ----

  it("create_commit returns structured result on success", async () => {
    mockCreateCommit.mockReturnValue({ sha: "abc123", short_sha: "abc", subject: "test", dry_run: false });

    const result = await client.callTool({
      name: "create_commit",
      arguments: { message: "test" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { sha: string; subject: string; dry_run: boolean };
    expect(sc.sha).toBe("abc123");
    expect(sc.dry_run).toBe(false);
  });

  it("create_commit catch block returns isError on throw", async () => {
    mockCreateCommit.mockImplementation(() => {
      throw new Error("SEGMINT_NOTHING_STAGED");
    });

    const result = await client.callTool({
      name: "create_commit",
      arguments: { message: "test" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain("SEGMINT_NOTHING_STAGED");
  });

  it("create_commit catch with non-Error value", async () => {
    mockCreateCommit.mockImplementation(() => {
      throw "commit string error";
    });

    const result = await client.callTool({
      name: "create_commit",
      arguments: { message: "test" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("commit string error");
  });

  // ---- create_branch ----

  it("create_branch returns structured result on success", async () => {
    mockCreateBranch.mockReturnValue({ branch_name: "feat", sha: "abc123", dry_run: false });

    const result = await client.callTool({
      name: "create_branch",
      arguments: { name: "feat" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { branch_name: string; sha: string; dry_run: boolean };
    expect(sc.branch_name).toBe("feat");
  });

  it("create_branch catch block returns isError on throw", async () => {
    mockCreateBranch.mockImplementation(() => {
      throw new Error("SEGMINT_BRANCH_EXISTS");
    });

    const result = await client.callTool({
      name: "create_branch",
      arguments: { name: "feat" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain("SEGMINT_BRANCH_EXISTS");
  });

  it("create_branch catch with non-Error value", async () => {
    mockCreateBranch.mockImplementation(() => {
      throw "branch string error";
    });

    const result = await client.callTool({
      name: "create_branch",
      arguments: { name: "feat" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("branch string error");
  });

  // ---- checkout_branch ----

  it("checkout_branch returns structured result on success", async () => {
    mockCheckoutBranch.mockReturnValue({ branch_name: "feat", previous_branch: "main", dry_run: false });

    const result = await client.callTool({
      name: "checkout_branch",
      arguments: { name: "feat" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { branch_name: string; previous_branch: string | null; dry_run: boolean };
    expect(sc.branch_name).toBe("feat");
    expect(sc.previous_branch).toBe("main");
  });

  it("checkout_branch catch block returns isError on throw", async () => {
    mockCheckoutBranch.mockImplementation(() => {
      throw new Error("SEGMINT_BRANCH_NOT_FOUND");
    });

    const result = await client.callTool({
      name: "checkout_branch",
      arguments: { name: "missing" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain("SEGMINT_BRANCH_NOT_FOUND");
  });

  it("checkout_branch catch with non-Error value", async () => {
    mockCheckoutBranch.mockImplementation(() => {
      throw "checkout string error";
    });

    const result = await client.callTool({
      name: "checkout_branch",
      arguments: { name: "feat" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("checkout string error");
  });

  // ---- stash_save ----

  it("stash_save returns structured result on success", async () => {
    mockSaveStash.mockReturnValue({ message: "wip", dry_run: false });

    const result = await client.callTool({
      name: "stash_save",
      arguments: { message: "wip" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { message: string; dry_run: boolean };
    expect(sc.message).toBe("wip");
  });

  it("stash_save catch block returns isError on throw", async () => {
    mockSaveStash.mockImplementation(() => {
      throw new Error("SEGMINT_NOTHING_TO_STASH");
    });

    const result = await client.callTool({
      name: "stash_save",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain("SEGMINT_NOTHING_TO_STASH");
  });

  it("stash_save catch with non-Error value", async () => {
    mockSaveStash.mockImplementation(() => {
      throw "stash_save string error";
    });

    const result = await client.callTool({
      name: "stash_save",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("stash_save string error");
  });

  // ---- stash_list ----

  it("stash_list returns structured result on success", async () => {
    mockListStashes.mockReturnValue({ stashes: [{ index: 0, message: "wip", sha: "abc" }] });

    const result = await client.callTool({
      name: "stash_list",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { stashes: Array<{ index: number; message: string; sha: string }> };
    expect(sc.stashes).toHaveLength(1);
    expect(sc.stashes[0].message).toBe("wip");
  });

  it("stash_list catch block returns isError on throw", async () => {
    mockListStashes.mockImplementation(() => {
      throw new Error("stash list failed");
    });

    const result = await client.callTool({
      name: "stash_list",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("stash list failed");
  });

  it("stash_list catch with non-Error value", async () => {
    mockListStashes.mockImplementation(() => {
      throw "stash_list string error";
    });

    const result = await client.callTool({
      name: "stash_list",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("stash_list string error");
  });

  // ---- stash_pop ----

  it("stash_pop returns structured result on success", async () => {
    mockPopStash.mockReturnValue({ index: 0, dry_run: false });

    const result = await client.callTool({
      name: "stash_pop",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { index: number; dry_run: boolean };
    expect(sc.index).toBe(0);
  });

  it("stash_pop catch block returns isError on throw", async () => {
    mockPopStash.mockImplementation(() => {
      throw new Error("SEGMINT_STASH_NOT_FOUND");
    });

    const result = await client.callTool({
      name: "stash_pop",
      arguments: { index: 99 },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain("SEGMINT_STASH_NOT_FOUND");
  });

  it("stash_pop catch with non-Error value", async () => {
    mockPopStash.mockImplementation(() => {
      throw "stash_pop string error";
    });

    const result = await client.callTool({
      name: "stash_pop",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("stash_pop string error");
  });

  // ---- reset_soft ----

  it("reset_soft returns structured result on success", async () => {
    mockResetSoft.mockReturnValue({ ref: "HEAD~1", previous_sha: "aaa", new_sha: "bbb", dry_run: false });

    const result = await client.callTool({
      name: "reset_soft",
      arguments: { ref: "HEAD~1" },
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { ref: string; previous_sha: string; new_sha: string; dry_run: boolean };
    expect(sc.ref).toBe("HEAD~1");
    expect(sc.previous_sha).toBe("aaa");
    expect(sc.new_sha).toBe("bbb");
  });

  it("reset_soft catch block returns isError on throw", async () => {
    mockResetSoft.mockImplementation(() => {
      throw new Error("invalid ref");
    });

    const result = await client.callTool({
      name: "reset_soft",
      arguments: { ref: "bad-ref" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("invalid ref");
  });

  it("reset_soft catch with non-Error value", async () => {
    mockResetSoft.mockImplementation(() => {
      throw "reset string error";
    });

    const result = await client.callTool({
      name: "reset_soft",
      arguments: { ref: "HEAD" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("reset string error");
  });

  // ---- push ----

  it("push returns structured result on success", async () => {
    mockPushToRemote.mockReturnValue({ remote: "origin", branch: "main", dry_run: true, forced: false });

    const result = await client.callTool({
      name: "push",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const sc = result.structuredContent as { remote: string; branch: string; dry_run: boolean; forced: boolean };
    expect(sc.remote).toBe("origin");
    expect(sc.dry_run).toBe(true);
    expect(sc.forced).toBe(false);
  });

  it("push catch block returns isError on throw", async () => {
    mockPushToRemote.mockImplementation(() => {
      throw new Error("SEGMINT_NO_REMOTE");
    });

    const result = await client.callTool({
      name: "push",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain("SEGMINT_NO_REMOTE");
  });

  it("push catch with non-Error value", async () => {
    mockPushToRemote.mockImplementation(() => {
      throw "push string error";
    });

    const result = await client.callTool({
      name: "push",
      arguments: {},
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("push string error");
  });
});
