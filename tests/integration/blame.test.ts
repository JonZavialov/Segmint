import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { getBlame } from "../../src/blame.js";

function createTempRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "segmint-blame-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  git(["init"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "commit.gpgsign", "false"]);

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function addCommit(dir: string, file: string, content: string, msg: string) {
  writeFileSync(join(dir, file), content);
  execFileSync("git", ["add", file], { cwd: dir });
  execFileSync("git", ["commit", "-m", msg], { cwd: dir });
}

describe("getBlame", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
  });

  afterEach(() => cleanup());

  it("blames a single-line file", () => {
    addCommit(dir, "hello.txt", "hello world\n", "add hello");

    const result = getBlame({ path: "hello.txt" }, dir);
    expect(result.path).toBe("hello.txt");
    expect(result.ref).toBe("HEAD");
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].line_number).toBe(1);
    expect(result.lines[0].content).toBe("hello world");
    expect(result.lines[0].commit.author_name).toBe("Test");
    expect(result.lines[0].commit.author_email).toBe("test@test.com");
    expect(result.lines[0].commit.summary).toBe("add hello");
    expect(result.lines[0].commit.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.lines[0].commit.short_sha).toHaveLength(7);
  });

  it("blames a multi-line file with multiple commits", () => {
    addCommit(dir, "multi.txt", "line1\nline2\n", "first two");
    writeFileSync(join(dir, "multi.txt"), "line1\nline2\nline3\n");
    execFileSync("git", ["add", "multi.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "add line3"], { cwd: dir });

    const result = getBlame({ path: "multi.txt" }, dir);
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0].commit.summary).toBe("first two");
    expect(result.lines[1].commit.summary).toBe("first two");
    expect(result.lines[2].commit.summary).toBe("add line3");
  });

  it("supports line range filtering", () => {
    addCommit(dir, "range.txt", "a\nb\nc\nd\ne\n", "five lines");

    const result = getBlame({ path: "range.txt", start_line: 2, end_line: 4 }, dir);
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0].line_number).toBe(2);
    expect(result.lines[0].content).toBe("b");
    expect(result.lines[2].line_number).toBe(4);
    expect(result.lines[2].content).toBe("d");
  });

  it("supports start_line only (to end of file)", () => {
    addCommit(dir, "start.txt", "a\nb\nc\n", "three");

    const result = getBlame({ path: "start.txt", start_line: 2 }, dir);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].line_number).toBe(2);
    expect(result.lines[1].line_number).toBe(3);
  });

  it("supports end_line only (from start of file)", () => {
    addCommit(dir, "end.txt", "a\nb\nc\n", "three");

    const result = getBlame({ path: "end.txt", end_line: 2 }, dir);
    expect(result.lines).toHaveLength(2);
    expect(result.lines[0].line_number).toBe(1);
    expect(result.lines[1].line_number).toBe(2);
  });

  it("supports ignore_whitespace flag", () => {
    addCommit(dir, "ws.txt", "hello\n", "init");
    writeFileSync(join(dir, "ws.txt"), "  hello\n");
    execFileSync("git", ["add", "ws.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "indent"], { cwd: dir });

    const withWs = getBlame({ path: "ws.txt", ignore_whitespace: true }, dir);
    expect(withWs.lines).toHaveLength(1);
    // With -w, the blame should attribute to the original commit (init), not "indent"
    expect(withWs.lines[0].commit.summary).toBe("init");
  });

  it("supports detect_moves flag", () => {
    addCommit(dir, "moves.txt", "original content\n", "orig");

    // Just verify that the flag doesn't cause an error
    const result = getBlame({ path: "moves.txt", detect_moves: true }, dir);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].content).toBe("original content");
  });

  it("blames at a specific ref", () => {
    addCommit(dir, "ref.txt", "version1\n", "v1");
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    writeFileSync(join(dir, "ref.txt"), "version2\n");
    execFileSync("git", ["add", "ref.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "v2"], { cwd: dir });

    const result = getBlame({ path: "ref.txt", ref: sha }, dir);
    expect(result.ref).toBe(sha);
    expect(result.lines[0].content).toBe("version1");
    expect(result.lines[0].commit.summary).toBe("v1");
  });

  it("throws for nonexistent file", () => {
    addCommit(dir, "exists.txt", "x\n", "init");
    expect(() => getBlame({ path: "nope.txt" }, dir)).toThrow();
  });

  it("throws for invalid ref", () => {
    addCommit(dir, "file.txt", "x\n", "init");
    expect(() =>
      getBlame({ path: "file.txt", ref: "nonexistent-ref" }, dir)
    ).toThrow();
  });

  it("returns all lines when start_line > end_line (git wraps)", () => {
    addCommit(dir, "rev.txt", "a\nb\nc\n", "three lines");

    // git blame -L 3,1 returns all lines (git does not reject reversed ranges)
    const result = getBlame({ path: "rev.txt", start_line: 3, end_line: 1 }, dir);
    expect(result.lines).toHaveLength(3);
  });

  it("throws for negative line numbers", () => {
    addCommit(dir, "neg.txt", "a\nb\n", "two lines");

    // git rejects negative line specs
    expect(() =>
      getBlame({ path: "neg.txt", start_line: -1, end_line: 2 }, dir)
    ).toThrow();
  });

  it("throws for zero start_line", () => {
    addCommit(dir, "zero.txt", "a\nb\n", "two lines");

    // git rejects line 0
    expect(() =>
      getBlame({ path: "zero.txt", start_line: 0 }, dir)
    ).toThrow();
  });

  it("clamps end_line exceeding file length to actual EOF", () => {
    addCommit(dir, "short.txt", "a\nb\nc\n", "three lines");

    // git blame -L 1,100 on a 3-line file returns lines 1-3 (clamped)
    const result = getBlame({ path: "short.txt", start_line: 1, end_line: 100 }, dir);
    expect(result.lines).toHaveLength(3);
    expect(result.lines[0].line_number).toBe(1);
    expect(result.lines[2].line_number).toBe(3);
  });

  it("throws when start_line exceeds file length", () => {
    addCommit(dir, "eof.txt", "a\nb\n", "two lines");

    // git rejects -L 50, when file only has 2 lines
    expect(() =>
      getBlame({ path: "eof.txt", start_line: 50 }, dir)
    ).toThrow(/has only 2 lines/);
  });

  it("produces ISO 8601 timestamps", () => {
    addCommit(dir, "ts.txt", "data\n", "timestamp test");

    const result = getBlame({ path: "ts.txt" }, dir);
    // Should be a valid ISO string
    const parsed = new Date(result.lines[0].commit.author_time);
    expect(parsed.getTime()).not.toBeNaN();
    expect(result.lines[0].commit.author_time).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/
    );
  });
});
