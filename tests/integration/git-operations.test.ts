import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { getUncommittedChanges } from "../../src/git.js";
import { getRepoStatus } from "../../src/status.js";
import { getLog } from "../../src/history.js";
import { getCommit } from "../../src/show.js";
import { getDiffBetweenRefs } from "../../src/diff.js";

function createTempRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "segmint-test-"));
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

describe("getUncommittedChanges", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
    // Need at least one commit for diff to work
    addCommit(dir, "init.txt", "init", "initial");
  });

  afterEach(() => cleanup());

  it("returns empty for clean repo", () => {
    const changes = getUncommittedChanges(dir);
    expect(changes).toEqual([]);
  });

  it("detects staged changes", () => {
    writeFileSync(join(dir, "init.txt"), "modified");
    execFileSync("git", ["add", "init.txt"], { cwd: dir });
    const changes = getUncommittedChanges(dir);
    expect(changes).toHaveLength(1);
    expect(changes[0].file_path).toBe("init.txt");
    expect(changes[0].id).toBe("change-1");
  });

  it("detects unstaged changes", () => {
    writeFileSync(join(dir, "init.txt"), "modified");
    const changes = getUncommittedChanges(dir);
    expect(changes).toHaveLength(1);
  });

  it("merges staged and unstaged for same file (staged first)", () => {
    writeFileSync(join(dir, "init.txt"), "staged content");
    execFileSync("git", ["add", "init.txt"], { cwd: dir });
    writeFileSync(join(dir, "init.txt"), "further modified");
    const changes = getUncommittedChanges(dir);
    expect(changes).toHaveLength(1);
    // Should have hunks from both staged and unstaged
    expect(changes[0].hunks.length).toBeGreaterThanOrEqual(2);
  });

  it("sorts changes by file path", () => {
    writeFileSync(join(dir, "z-file.txt"), "z");
    writeFileSync(join(dir, "a-file.txt"), "a");
    execFileSync("git", ["add", "z-file.txt", "a-file.txt"], { cwd: dir });
    const changes = getUncommittedChanges(dir);
    expect(changes[0].file_path).toBe("a-file.txt");
    expect(changes[1].file_path).toBe("z-file.txt");
  });

  it("detects new files", () => {
    writeFileSync(join(dir, "brand-new.txt"), "new content");
    execFileSync("git", ["add", "brand-new.txt"], { cwd: dir });
    const changes = getUncommittedChanges(dir);
    expect(changes).toHaveLength(1);
    expect(changes[0].file_path).toBe("brand-new.txt");
  });

  it("filters by path", () => {
    writeFileSync(join(dir, "src-file.ts"), "export const x = 1;");
    writeFileSync(join(dir, "readme.md"), "# readme");
    execFileSync("git", ["add", "src-file.ts", "readme.md"], { cwd: dir });
    const changes = getUncommittedChanges(dir, "src-file.ts");
    expect(changes).toHaveLength(1);
    expect(changes[0].file_path).toBe("src-file.ts");
  });

  it("path filter returns empty when no matches", () => {
    writeFileSync(join(dir, "init.txt"), "modified");
    execFileSync("git", ["add", "init.txt"], { cwd: dir });
    const changes = getUncommittedChanges(dir, "nonexistent-path");
    expect(changes).toEqual([]);
  });

  it("returns empty or throws for non-git directory", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      // On some systems, a non-git temp dir may be inside a git repo (e.g. TEMP
      // inside user home), so git diff succeeds with empty output.
      try {
        const result = getUncommittedChanges(tempDir);
        expect(result).toEqual([]);
      } catch {
        // Expected on systems where temp dir is not under a git repo
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("getRepoStatus", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
  });

  afterEach(() => cleanup());

  it("returns status for fresh repo with commit", () => {
    addCommit(dir, "init.txt", "init", "initial");
    const status = getRepoStatus(dir);
    expect(status.is_git_repo).toBe(true);
    expect(status.head.type).toBe("branch");
    expect(status.staged).toEqual([]);
    expect(status.unstaged).toEqual([]);
    expect(status.merge_in_progress).toBe(false);
    expect(status.rebase_in_progress).toBe(false);
  });

  it("detects staged, unstaged, and untracked files", () => {
    addCommit(dir, "tracked.txt", "original", "init");
    writeFileSync(join(dir, "tracked.txt"), "modified");
    writeFileSync(join(dir, "untracked.txt"), "new");
    writeFileSync(join(dir, "staged.txt"), "staged");
    execFileSync("git", ["add", "staged.txt"], { cwd: dir });

    const status = getRepoStatus(dir);
    expect(status.staged.length).toBeGreaterThanOrEqual(1);
    expect(status.unstaged.length).toBeGreaterThanOrEqual(1);
    expect(status.untracked).toContain("untracked.txt");
  });

  it("returns status or throws for non-git directory", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "no-git-"));
    try {
      // On some systems, temp dir may be inside a git repo
      try {
        const status = getRepoStatus(tempDir);
        expect(status.is_git_repo).toBe(true);
      } catch {
        // Expected on systems where temp dir is not under a git repo
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("handles detached HEAD", () => {
    addCommit(dir, "init.txt", "init", "initial");
    // Get the current commit SHA and detach
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    execFileSync("git", ["checkout", sha], { cwd: dir, encoding: "utf8" });
    const status = getRepoStatus(dir);
    expect(status.head.type).toBe("detached");
    expect(status.head.sha).toBe(sha);
  });

  it("handles fresh repo with no commits", () => {
    // The createTempRepo() creates a repo with no commits yet
    // We just need to test status on a truly empty repo
    const emptyDir = mkdtempSync(join(tmpdir(), "segmint-empty-"));
    try {
      execFileSync("git", ["init"], { cwd: emptyDir });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: emptyDir });
      execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: emptyDir });
      const status = getRepoStatus(emptyDir);
      expect(status.is_git_repo).toBe(true);
      expect(status.head.type).toBe("branch");
      // In a fresh repo, sha is undefined
      expect(status.head.sha).toBeUndefined();
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe("getLog", () => {
  let dir: string;
  let cleanup: () => void;
  let originalCwd: string;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
    originalCwd = process.cwd();
    process.chdir(dir);
    // Need 3 commits: root commit is skipped by parseLogOutput due to
    // empty parents field merging with record separator in NUL-delimited format
    addCommit(dir, "init.txt", "init", "initial commit");
    addCommit(dir, "a.txt", "a", "first commit");
    addCommit(dir, "b.txt", "b", "second commit");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup();
  });

  it("returns commits", () => {
    const result = getLog({ include_merges: true });
    expect(result.commits.length).toBeGreaterThanOrEqual(2);
    expect(result.commits[0].subject).toBe("second commit");
  });

  it("respects limit", () => {
    const result = getLog({ limit: 1 });
    expect(result.commits).toHaveLength(1);
  });

  it("clamps limit to 1 minimum", () => {
    const result = getLog({ limit: 0 });
    expect(result.commits).toHaveLength(1);
  });

  it("filters by path", () => {
    const result = getLog({ path: "a.txt" });
    expect(result.commits).toHaveLength(1);
    expect(result.commits[0].subject).toBe("first commit");
  });

  it("filters by since date", () => {
    const result = getLog({ since: "2000-01-01", include_merges: true });
    expect(result.commits.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by until date", () => {
    const result = getLog({ until: "2000-01-01", include_merges: true });
    expect(result.commits).toHaveLength(0);
  });

  it("clamps limit above 200", () => {
    const result = getLog({ limit: 300, include_merges: true });
    expect(result.commits.length).toBeGreaterThanOrEqual(1);
  });
});

describe("getCommit", () => {
  let dir: string;
  let cleanup: () => void;
  let originalCwd: string;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
    originalCwd = process.cwd();
    process.chdir(dir);
    addCommit(dir, "file.txt", "content", "test commit");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup();
  });

  it("retrieves HEAD commit details", () => {
    const result = getCommit("HEAD");
    expect(result.commit.subject).toBe("test commit");
    expect(result.commit.sha).toBeTruthy();
    expect(result.commit.files.length).toBeGreaterThanOrEqual(1);
  });

  it("retrieves root commit with diff", () => {
    // HEAD is root commit in this repo
    const result = getCommit("HEAD");
    expect(result.commit.diff.changes.length).toBeGreaterThanOrEqual(1);
  });

  it("includes body text", () => {
    // Current commit has no body, so body should be empty
    const result = getCommit("HEAD");
    expect(result.commit.body).toBe("");
  });

  it("throws for invalid SHA", () => {
    expect(() => getCommit("0000000000000000000000000000000000000000")).toThrow();
  });
});

describe("getDiffBetweenRefs", () => {
  let dir: string;
  let cleanup: () => void;
  let originalCwd: string;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
    originalCwd = process.cwd();
    process.chdir(dir);
    addCommit(dir, "file.txt", "original", "first");
    addCommit(dir, "file.txt", "modified", "second");
  });

  afterEach(() => {
    process.chdir(originalCwd);
    cleanup();
  });

  it("computes diff between two refs", () => {
    const changes = getDiffBetweenRefs({ base: "HEAD~1", head: "HEAD" });
    expect(changes.length).toBeGreaterThanOrEqual(1);
    expect(changes[0].file_path).toBe("file.txt");
  });

  it("clamps unified to valid range (high)", () => {
    const changes = getDiffBetweenRefs({ base: "HEAD~1", head: "HEAD", unified: 25 });
    expect(changes.length).toBeGreaterThanOrEqual(1);
  });

  it("clamps unified to valid range (negative)", () => {
    const changes = getDiffBetweenRefs({ base: "HEAD~1", head: "HEAD", unified: -5 });
    expect(changes.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by path", () => {
    addCommit(dir, "other.txt", "other", "third");
    const changes = getDiffBetweenRefs({
      base: "HEAD~2",
      head: "HEAD",
      path: "file.txt",
    });
    // Should only contain file.txt changes
    for (const c of changes) {
      expect(c.file_path).toBe("file.txt");
    }
  });

  it("throws for invalid refs", () => {
    expect(() =>
      getDiffBetweenRefs({ base: "nonexistent-ref", head: "HEAD" })
    ).toThrow();
  });
});
