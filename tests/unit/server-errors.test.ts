import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * Test server.ts error catch blocks that can't easily be triggered in E2E tests.
 *
 * Mocks the underlying modules to throw, exercising the try/catch error paths
 * in list_changes, repo_status, and group_changes handlers.
 */

// Mock modules to throw errors on demand
const mockLoadChanges = vi.fn();
const mockResolveChangeIds = vi.fn();
const mockGetRepoStatus = vi.fn();
const mockGetLog = vi.fn();
const mockGetCommit = vi.fn();
const mockGetDiffBetweenRefs = vi.fn();
const mockGetBlame = vi.fn();
const mockGetEmbeddingProvider = vi.fn();

vi.mock("../../src/changes.js", () => ({
  loadChanges: (...args: unknown[]) => mockLoadChanges(...args),
  resolveChangeIds: (...args: unknown[]) => mockResolveChangeIds(...args),
  buildEmbeddingText: vi.fn((c: { file_path: string }) => `file: ${c.file_path}`),
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

vi.mock("../../src/embeddings.js", () => ({
  getEmbeddingProvider: (...args: unknown[]) => mockGetEmbeddingProvider(...args),
}));

vi.mock("../../src/cluster.js", () => ({
  clusterByThreshold: vi.fn(),
}));

describe("server.ts error catch blocks", () => {
  let client: Client;

  beforeAll(async () => {
    const { createServer } = await import("../../src/server.js");
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-errors", version: "1.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterAll(async () => {
    await client.close();
  });

  it("list_changes catch block returns isError on throw", async () => {
    mockLoadChanges.mockImplementation(() => {
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
    mockLoadChanges.mockImplementation(() => {
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

  it("group_changes catch block on embedding failure", async () => {
    // Make resolveChangeIds return valid changes (no unknowns) with 2+ items
    mockResolveChangeIds.mockReturnValue({
      changes: [
        { id: "change-1", file_path: "a.ts", hunks: [] },
        { id: "change-2", file_path: "b.ts", hunks: [] },
      ],
      unknown: [],
    });
    // Make embedding provider throw
    mockGetEmbeddingProvider.mockImplementation(() => {
      throw new Error("OPENAI_API_KEY not set");
    });

    const result = await client.callTool({
      name: "group_changes",
      arguments: { change_ids: ["change-1", "change-2"] },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0].text;
    expect(text).toBe("OPENAI_API_KEY not set");
  });

  it("group_changes catch with non-Error value", async () => {
    mockResolveChangeIds.mockReturnValue({
      changes: [
        { id: "change-1", file_path: "a.ts", hunks: [] },
        { id: "change-2", file_path: "b.ts", hunks: [] },
      ],
      unknown: [],
    });
    mockGetEmbeddingProvider.mockImplementation(() => {
      throw "group string error";
    });

    const result = await client.callTool({
      name: "group_changes",
      arguments: { change_ids: ["change-1", "change-2"] },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toBe("group string error");
  });

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
