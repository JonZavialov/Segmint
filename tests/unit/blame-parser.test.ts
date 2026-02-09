import { describe, it, expect } from "vitest";
import { parseBlamePorcelain } from "../../src/blame.js";

describe("parseBlamePorcelain", () => {
  it("returns empty for empty string", () => {
    expect(parseBlamePorcelain("")).toEqual([]);
  });

  it("returns empty for whitespace-only", () => {
    expect(parseBlamePorcelain("   \n  \n")).toEqual([]);
  });

  it("parses a single blame block", () => {
    const raw = [
      "abc1234567890abc1234567890abc123456789ab 1 1 1",
      "author Alice",
      "author-mail <alice@example.com>",
      "author-time 1700000000",
      "author-tz +0000",
      "committer Alice",
      "committer-mail <alice@example.com>",
      "committer-time 1700000000",
      "committer-tz +0000",
      "summary Initial commit",
      "filename src/index.ts",
      "\tconsole.log('hello');",
    ].join("\n");

    const result = parseBlamePorcelain(raw);
    expect(result).toHaveLength(1);
    expect(result[0].line_number).toBe(1);
    expect(result[0].content).toBe("console.log('hello');");
    expect(result[0].commit.sha).toBe(
      "abc1234567890abc1234567890abc123456789ab"
    );
    expect(result[0].commit.short_sha).toBe("abc1234");
    expect(result[0].commit.author_name).toBe("Alice");
    expect(result[0].commit.author_email).toBe("alice@example.com");
    expect(result[0].commit.summary).toBe("Initial commit");
    // 1700000000 seconds → 2023-11-14T22:13:20.000Z
    expect(result[0].commit.author_time).toBe("2023-11-14T22:13:20.000Z");
  });

  it("parses multiple blame blocks", () => {
    const raw = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1 1 1",
      "author Alice",
      "author-mail <alice@test.com>",
      "author-time 1700000000",
      "summary First line",
      "filename file.ts",
      "\tline one",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2 2 1",
      "author Bob",
      "author-mail <bob@test.com>",
      "author-time 1700001000",
      "summary Second line",
      "filename file.ts",
      "\tline two",
    ].join("\n");

    const result = parseBlamePorcelain(raw);
    expect(result).toHaveLength(2);
    expect(result[0].line_number).toBe(1);
    expect(result[0].content).toBe("line one");
    expect(result[0].commit.author_name).toBe("Alice");
    expect(result[1].line_number).toBe(2);
    expect(result[1].content).toBe("line two");
    expect(result[1].commit.author_name).toBe("Bob");
  });

  it("handles empty content lines (tab only)", () => {
    const raw = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 5 5 1",
      "author Alice",
      "author-mail <a@b.com>",
      "author-time 1700000000",
      "summary blank",
      "filename f.ts",
      "\t",
    ].join("\n");

    const result = parseBlamePorcelain(raw);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("");
    expect(result[0].line_number).toBe(5);
  });

  it("skips lines that don't match header pattern", () => {
    const raw = [
      "not-a-sha line",
      "random garbage",
      "",
    ].join("\n");

    expect(parseBlamePorcelain(raw)).toEqual([]);
  });

  it("handles block with missing optional fields", () => {
    // Only sha header + content line, no author/summary keys
    const raw = [
      "cccccccccccccccccccccccccccccccccccccccc 3 3 1",
      "filename f.ts",
      "\tsome content",
    ].join("\n");

    const result = parseBlamePorcelain(raw);
    expect(result).toHaveLength(1);
    expect(result[0].commit.author_name).toBe("");
    expect(result[0].commit.author_email).toBe("");
    expect(result[0].commit.author_time).toBe("");
    expect(result[0].commit.summary).toBe("");
  });
});
