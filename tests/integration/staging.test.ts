import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { stageChanges, unstageChanges, stageHunks } from "../../src/staging.js";

function createTempRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "segmint-staging-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" });

  git(["init"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "commit.gpgsign", "false"]);

  writeFileSync(join(dir, "init.txt"), "initial content\n");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);

  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function gitStatus(dir: string): string {
  return execFileSync("git", ["status", "--porcelain"], {
    cwd: dir,
    encoding: "utf8",
  });
}

describe("stageChanges", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
  });

  afterEach(() => cleanup());

  it("stages a modified file", () => {
    writeFileSync(join(dir, "init.txt"), "modified\n");

    const result = stageChanges(["init.txt"], false, dir);
    expect(result.staged_paths).toEqual(["init.txt"]);
    expect(result.dry_run).toBe(false);

    // Verify file is staged
    const status = gitStatus(dir);
    expect(status).toContain("M  init.txt");
  });

  it("stages a new file", () => {
    writeFileSync(join(dir, "new-file.txt"), "new content\n");

    const result = stageChanges(["new-file.txt"], false, dir);
    expect(result.staged_paths).toEqual(["new-file.txt"]);
    expect(result.dry_run).toBe(false);

    const status = gitStatus(dir);
    expect(status).toContain("A  new-file.txt");
  });

  it("stages multiple files", () => {
    writeFileSync(join(dir, "a.txt"), "a\n");
    writeFileSync(join(dir, "b.txt"), "b\n");

    const result = stageChanges(["a.txt", "b.txt"], false, dir);
    expect(result.staged_paths).toEqual(["a.txt", "b.txt"]);

    const status = gitStatus(dir);
    expect(status).toContain("A  a.txt");
    expect(status).toContain("A  b.txt");
  });

  it("dry_run does not stage anything", () => {
    writeFileSync(join(dir, "init.txt"), "modified\n");

    const result = stageChanges(["init.txt"], true, dir);
    expect(result.staged_paths).toEqual(["init.txt"]);
    expect(result.dry_run).toBe(true);

    // File should remain unstaged
    const status = gitStatus(dir);
    expect(status).toContain(" M init.txt");
  });

  it("throws on empty paths", () => {
    expect(() => stageChanges([], false, dir)).toThrow("SEGMINT_EMPTY_PATHS");
  });
});

describe("unstageChanges", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
  });

  afterEach(() => cleanup());

  it("unstages a staged file", () => {
    writeFileSync(join(dir, "init.txt"), "modified\n");
    execFileSync("git", ["add", "init.txt"], { cwd: dir });

    // Verify it's staged
    let status = gitStatus(dir);
    expect(status).toContain("M  init.txt");

    const result = unstageChanges(["init.txt"], false, dir);
    expect(result.unstaged_paths).toEqual(["init.txt"]);
    expect(result.dry_run).toBe(false);

    // Verify file is now unstaged
    status = gitStatus(dir);
    expect(status).toContain(" M init.txt");
  });

  it("unstages multiple files", () => {
    writeFileSync(join(dir, "a.txt"), "a\n");
    writeFileSync(join(dir, "b.txt"), "b\n");
    execFileSync("git", ["add", "a.txt", "b.txt"], { cwd: dir });

    const result = unstageChanges(["a.txt", "b.txt"], false, dir);
    expect(result.unstaged_paths).toEqual(["a.txt", "b.txt"]);

    const status = gitStatus(dir);
    // Should be untracked now (they were new files)
    expect(status).toContain("?? a.txt");
    expect(status).toContain("?? b.txt");
  });

  it("dry_run does not unstage anything", () => {
    writeFileSync(join(dir, "init.txt"), "modified\n");
    execFileSync("git", ["add", "init.txt"], { cwd: dir });

    const result = unstageChanges(["init.txt"], true, dir);
    expect(result.unstaged_paths).toEqual(["init.txt"]);
    expect(result.dry_run).toBe(true);

    // File should remain staged
    const status = gitStatus(dir);
    expect(status).toContain("M  init.txt");
  });

  it("throws on empty paths", () => {
    expect(() => unstageChanges([], false, dir)).toThrow("SEGMINT_EMPTY_PATHS");
  });
});

describe("stageHunks", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
  });

  afterEach(() => cleanup());

  it("stages a single hunk from a multi-hunk diff", () => {
    // Create a file with multiple sections
    const lines = [];
    for (let i = 1; i <= 20; i++) lines.push(`line ${i}`);
    writeFileSync(join(dir, "init.txt"), lines.join("\n") + "\n");
    execFileSync("git", ["add", "init.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "multi-line file"], { cwd: dir });

    // Modify two separate sections to create two hunks
    const modified = [...lines];
    modified[1] = "MODIFIED line 2";
    modified[17] = "MODIFIED line 18";
    writeFileSync(join(dir, "init.txt"), modified.join("\n") + "\n");

    // Stage only the first hunk (index 0)
    const result = stageHunks("init.txt", [0], false, dir);
    expect(result.file_path).toBe("init.txt");
    expect(result.hunks_staged).toBe(1);
    expect(result.dry_run).toBe(false);

    // Verify: there should still be unstaged changes (second hunk)
    const status = gitStatus(dir);
    expect(status).toContain("init.txt");
  });

  it("dry_run validates without staging", () => {
    writeFileSync(join(dir, "init.txt"), "modified content\n");

    const result = stageHunks("init.txt", [0], true, dir);
    expect(result.hunks_staged).toBe(1);
    expect(result.dry_run).toBe(true);

    // File should remain fully unstaged
    const status = gitStatus(dir);
    expect(status).toContain(" M init.txt");
  });

  it("throws SEGMINT_EMPTY_HUNKS for empty indices", () => {
    writeFileSync(join(dir, "init.txt"), "modified\n");
    expect(() => stageHunks("init.txt", [], false, dir)).toThrow(
      "SEGMINT_EMPTY_HUNKS",
    );
  });

  it("throws SEGMINT_NO_UNSTAGED_CHANGES for clean file", () => {
    expect(() => stageHunks("init.txt", [0], false, dir)).toThrow(
      "SEGMINT_NO_UNSTAGED_CHANGES",
    );
  });

  it("throws SEGMINT_HUNK_OUT_OF_RANGE for invalid index", () => {
    writeFileSync(join(dir, "init.txt"), "modified\n");
    expect(() => stageHunks("init.txt", [99], false, dir)).toThrow(
      "SEGMINT_HUNK_OUT_OF_RANGE",
    );
  });
});
