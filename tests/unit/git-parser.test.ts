import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDiff } from "../../src/git.js";

const fixtureDir = join(__dirname, "..", "fixtures", "diffs");

function loadFixture(name: string): string {
  return readFileSync(join(fixtureDir, name), "utf8").replace(/\r\n/g, "\n");
}

describe("parseDiff", () => {
  it("returns empty for empty string", () => {
    expect(parseDiff("")).toEqual([]);
  });

  it("returns empty for whitespace-only", () => {
    expect(parseDiff("   \n  \n  ")).toEqual([]);
  });

  it("parses single file modify", () => {
    const result = parseDiff(loadFixture("single-file-modify.diff"));
    expect(result).toHaveLength(1);
    expect(result[0].file_path).toBe("src/index.ts");
    expect(result[0].hunks).toHaveLength(1);
    expect(result[0].hunks[0].old_start).toBe(10);
    expect(result[0].hunks[0].old_lines).toBe(3);
    expect(result[0].hunks[0].new_start).toBe(10);
    expect(result[0].hunks[0].new_lines).toBe(5);
    expect(result[0].hunks[0].header).toMatch(/^@@/);
  });

  it("handles new file (a-side /dev/null)", () => {
    const result = parseDiff(loadFixture("new-file.diff"));
    expect(result).toHaveLength(1);
    expect(result[0].file_path).toBe("src/new-file.ts");
  });

  it("handles deleted file (b-side /dev/null)", () => {
    const result = parseDiff(loadFixture("deleted-file.diff"));
    expect(result).toHaveLength(1);
    expect(result[0].file_path).toBe("src/old-file.ts");
  });

  it("skips binary files", () => {
    const result = parseDiff(loadFixture("binary-file.diff"));
    expect(result).toEqual([]);
  });

  it("parses multi-file diffs", () => {
    const result = parseDiff(loadFixture("multi-file.diff"));
    expect(result).toHaveLength(2);
    const paths = result.map((r) => r.file_path);
    expect(paths).toContain("src/alpha.ts");
    expect(paths).toContain("src/beta.ts");
  });

  it("preserves no-newline-at-end-of-file markers", () => {
    const result = parseDiff(loadFixture("no-newline.diff"));
    expect(result).toHaveLength(1);
    const lines = result[0].hunks[0].lines;
    expect(lines.some((l) => l.startsWith("\\"))).toBe(true);
  });

  it("parses multiple hunks in one file", () => {
    const result = parseDiff(loadFixture("multiple-hunks.diff"));
    expect(result).toHaveLength(1);
    expect(result[0].hunks).toHaveLength(2);
    expect(result[0].hunks[0].old_start).toBe(1);
    expect(result[0].hunks[1].old_start).toBe(20);
  });

  it("defaults omitted line count to 1", () => {
    const result = parseDiff(loadFixture("omitted-line-count.diff"));
    expect(result).toHaveLength(1);
    expect(result[0].hunks[0].old_lines).toBe(1);
    expect(result[0].hunks[0].new_lines).toBe(1);
  });

  it("skips chunks with no @@ header", () => {
    const noHunkDiff = `diff --git a/file.txt b/file.txt
index abc..def 100644
--- a/file.txt
+++ b/file.txt
`;
    expect(parseDiff(noHunkDiff)).toEqual([]);
  });

  it("skips malformed header lines", () => {
    const badHeader = `diff --git a/file.txt b/file.txt
index abc..def 100644
--- a/file.txt
+++ b/file.txt
NOT_A_VALID_HEADER
+some line
`;
    expect(parseDiff(badHeader)).toEqual([]);
  });

  it("returns aPath when bPath is /dev/null in header", () => {
    // Exercise the extractFilePath guard for b-side /dev/null in the header line
    const raw = `diff --git a/removed.ts b//dev/null
deleted file mode 100644
index abc1234..0000000
--- a/removed.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const x = 1;
-export const y = 2;
`;
    const result = parseDiff(raw);
    expect(result).toHaveLength(1);
    expect(result[0].file_path).toBe("removed.ts");
  });

  it("returns null for unrecognized diff --git header", () => {
    const raw = `diff --git something-weird
--- a/file.txt
+++ b/file.txt
@@ -1,1 +1,1 @@
-old
+new
`;
    expect(parseDiff(raw)).toEqual([]);
  });

  it("skips malformed @@ lines inside a hunk", () => {
    const raw = `diff --git a/file.txt b/file.txt
index abc..def 100644
--- a/file.txt
+++ b/file.txt
@@ -1,2 +1,2 @@
-old line
+new line
@@ this is not a valid hunk header
+after invalid
`;
    const result = parseDiff(raw);
    expect(result).toHaveLength(1);
    expect(result[0].hunks).toHaveLength(1);
    expect(result[0].hunks[0].lines).toContain("-old line");
    expect(result[0].hunks[0].lines).toContain("+new line");
  });
});
