import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createBranch, checkoutBranch } from "../../src/branch.js";

function createTempRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "segmint-branch-"));
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

function currentBranch(dir: string): string {
  return execFileSync("git", ["branch", "--show-current"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

function branchExists(dir: string, name: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", `refs/heads/${name}`], {
      cwd: dir,
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

describe("createBranch", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
  });

  afterEach(() => cleanup());

  it("creates a branch at HEAD", () => {
    const result = createBranch("feature", undefined, false, dir);
    expect(result.branch_name).toBe("feature");
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.dry_run).toBe(false);
    expect(branchExists(dir, "feature")).toBe(true);
  });

  it("creates a branch at a specific ref", () => {
    // Make a second commit
    writeFileSync(join(dir, "second.txt"), "second\n");
    execFileSync("git", ["add", "second.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "second commit"], { cwd: dir });

    const firstSha = execFileSync(
      "git",
      ["rev-parse", "HEAD~1"],
      { cwd: dir, encoding: "utf8" },
    ).trim();

    const result = createBranch("from-first", "HEAD~1", false, dir);
    expect(result.branch_name).toBe("from-first");
    expect(result.sha).toBe(firstSha);
    expect(result.dry_run).toBe(false);
  });

  it("dry_run does not create branch", () => {
    const result = createBranch("dry-branch", undefined, true, dir);
    expect(result.branch_name).toBe("dry-branch");
    expect(result.dry_run).toBe(true);
    expect(branchExists(dir, "dry-branch")).toBe(false);
  });

  it("throws SEGMINT_BRANCH_EXISTS for existing branch", () => {
    execFileSync("git", ["branch", "existing"], { cwd: dir });

    expect(() => createBranch("existing", undefined, false, dir)).toThrow(
      "SEGMINT_BRANCH_EXISTS",
    );
  });
});

describe("checkoutBranch", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
  });

  afterEach(() => cleanup());

  it("switches to an existing branch", () => {
    execFileSync("git", ["branch", "feature"], { cwd: dir });

    const mainBranch = currentBranch(dir);
    const result = checkoutBranch("feature", false, dir);
    expect(result.branch_name).toBe("feature");
    expect(result.previous_branch).toBe(mainBranch);
    expect(result.dry_run).toBe(false);
    expect(currentBranch(dir)).toBe("feature");
  });

  it("dry_run does not switch branch", () => {
    execFileSync("git", ["branch", "feature"], { cwd: dir });

    const mainBranch = currentBranch(dir);
    const result = checkoutBranch("feature", true, dir);
    expect(result.branch_name).toBe("feature");
    expect(result.previous_branch).toBe(mainBranch);
    expect(result.dry_run).toBe(true);
    expect(currentBranch(dir)).toBe(mainBranch);
  });

  it("throws SEGMINT_BRANCH_NOT_FOUND for nonexistent branch", () => {
    expect(() => checkoutBranch("nonexistent", false, dir)).toThrow(
      "SEGMINT_BRANCH_NOT_FOUND",
    );
  });

  it("returns null for previous_branch on detached HEAD", () => {
    execFileSync("git", ["branch", "feature"], { cwd: dir });

    // Detach HEAD
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["checkout", sha], { cwd: dir, stdio: "pipe" });

    const result = checkoutBranch("feature", false, dir);
    expect(result.previous_branch).toBeNull();
    expect(result.branch_name).toBe("feature");
  });
});
