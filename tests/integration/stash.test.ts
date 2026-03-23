import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { listStashes, saveStash, popStash } from "../../src/stash.js";

function createTempRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "segmint-stash-"));
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

describe("listStashes", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
  });

  afterEach(() => cleanup());

  it("returns empty array when no stashes", () => {
    const result = listStashes(dir);
    expect(result.stashes).toEqual([]);
  });

  it("returns structured entries after stash push", () => {
    writeFileSync(join(dir, "init.txt"), "modified\n");
    execFileSync("git", ["stash", "push", "-m", "test stash"], { cwd: dir });

    const result = listStashes(dir);
    expect(result.stashes).toHaveLength(1);
    expect(result.stashes[0].index).toBe(0);
    expect(result.stashes[0].message).toContain("test stash");
    expect(result.stashes[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("returns multiple stashes in order", () => {
    writeFileSync(join(dir, "init.txt"), "first change\n");
    execFileSync("git", ["stash", "push", "-m", "first stash"], { cwd: dir });

    writeFileSync(join(dir, "init.txt"), "second change\n");
    execFileSync("git", ["stash", "push", "-m", "second stash"], { cwd: dir });

    const result = listStashes(dir);
    expect(result.stashes).toHaveLength(2);
    expect(result.stashes[0].index).toBe(0);
    expect(result.stashes[0].message).toContain("second stash");
    expect(result.stashes[1].index).toBe(1);
    expect(result.stashes[1].message).toContain("first stash");
  });
});

describe("saveStash", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
  });

  afterEach(() => cleanup());

  it("stashes changes and working tree becomes clean", () => {
    writeFileSync(join(dir, "init.txt"), "modified\n");

    const result = saveStash("my stash", false, dir);
    expect(result.message).toBe("my stash");
    expect(result.dry_run).toBe(false);

    const status = gitStatus(dir);
    expect(status.trim()).toBe("");
  });

  it("stashes without message", () => {
    writeFileSync(join(dir, "init.txt"), "modified\n");

    const result = saveStash(undefined, false, dir);
    expect(result.message).toBe("");
    expect(result.dry_run).toBe(false);

    const status = gitStatus(dir);
    expect(status.trim()).toBe("");
  });

  it("dry_run does not stash", () => {
    writeFileSync(join(dir, "init.txt"), "modified\n");

    const result = saveStash("dry stash", true, dir);
    expect(result.message).toBe("dry stash");
    expect(result.dry_run).toBe(true);

    // Changes should still be present
    const status = gitStatus(dir);
    expect(status).toContain("init.txt");
  });

  it("throws SEGMINT_NOTHING_TO_STASH on clean tree", () => {
    expect(() => saveStash("should fail", false, dir)).toThrow(
      "SEGMINT_NOTHING_TO_STASH",
    );
  });
});

describe("popStash", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
  });

  afterEach(() => cleanup());

  it("pops stash and restores changes", () => {
    writeFileSync(join(dir, "init.txt"), "stashed content\n");
    execFileSync("git", ["stash", "push", "-m", "to pop"], { cwd: dir });

    // Working tree should be clean
    expect(gitStatus(dir).trim()).toBe("");

    const result = popStash(0, false, dir);
    expect(result.index).toBe(0);
    expect(result.dry_run).toBe(false);

    // Changes should be restored
    const status = gitStatus(dir);
    expect(status).toContain("init.txt");
  });

  it("pops default stash (index 0) when no index given", () => {
    writeFileSync(join(dir, "init.txt"), "stashed\n");
    execFileSync("git", ["stash", "push", "-m", "default pop"], { cwd: dir });

    const result = popStash(undefined, false, dir);
    expect(result.index).toBe(0);
    expect(result.dry_run).toBe(false);
  });

  it("dry_run does not pop", () => {
    writeFileSync(join(dir, "init.txt"), "stashed\n");
    execFileSync("git", ["stash", "push", "-m", "dry pop"], { cwd: dir });

    const result = popStash(0, true, dir);
    expect(result.index).toBe(0);
    expect(result.dry_run).toBe(true);

    // Stash should still exist
    const stashList = execFileSync("git", ["stash", "list"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(stashList).toContain("dry pop");
  });

  it("throws SEGMINT_STASH_NOT_FOUND for invalid index", () => {
    expect(() => popStash(99, false, dir)).toThrow("SEGMINT_STASH_NOT_FOUND");
  });
});
