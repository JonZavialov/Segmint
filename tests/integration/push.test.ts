import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pushToRemote } from "../../src/push.js";

function getDefaultBranch(dir: string): string {
  return execFileSync("git", ["branch", "--show-current"], {
    cwd: dir,
    encoding: "utf8",
  }).trim();
}

function createTempRepoWithRemote(): {
  dir: string;
  remoteDir: string;
  branch: string;
  cleanup: () => void;
} {
  const remoteDir = mkdtempSync(join(tmpdir(), "segmint-remote-"));
  execFileSync("git", ["init", "--bare"], { cwd: remoteDir });

  const dir = mkdtempSync(join(tmpdir(), "segmint-push-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: "pipe" });

  git(["init"]);
  git(["config", "user.name", "Test"]);
  git(["config", "user.email", "test@test.com"]);
  git(["config", "core.autocrlf", "false"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["remote", "add", "origin", remoteDir]);

  writeFileSync(join(dir, "init.txt"), "initial content\n");
  git(["add", "."]);
  git(["commit", "-m", "initial commit"]);

  const branch = getDefaultBranch(dir);
  git(["push", "-u", "origin", branch]);

  return {
    dir,
    remoteDir,
    branch,
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
      rmSync(remoteDir, { recursive: true, force: true });
    },
  };
}

describe("pushToRemote", () => {
  let dir: string;
  let remoteDir: string;
  let branch: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, remoteDir, branch, cleanup } = createTempRepoWithRemote());
  });

  afterEach(() => cleanup());

  it("dry_run push succeeds without pushing", () => {
    writeFileSync(join(dir, "new.txt"), "new content\n");
    execFileSync("git", ["add", "new.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "new commit"], {
      cwd: dir,
      stdio: "pipe",
    });

    const result = pushToRemote(undefined, undefined, false, true, dir);
    expect(result.remote).toBe("origin");
    expect(result.branch).toBe(branch);
    expect(result.dry_run).toBe(true);
    expect(result.forced).toBe(false);

    // Verify remote does not have the new commit
    const remoteLog = execFileSync(
      "git",
      ["log", "--oneline"],
      { cwd: remoteDir, encoding: "utf8" },
    );
    expect(remoteLog).not.toContain("new commit");
  });

  it("push with dry_run false actually pushes", () => {
    writeFileSync(join(dir, "pushed.txt"), "pushed\n");
    execFileSync("git", ["add", "pushed.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "pushed commit"], {
      cwd: dir,
      stdio: "pipe",
    });

    const result = pushToRemote(undefined, undefined, false, false, dir);
    expect(result.dry_run).toBe(false);

    // Verify remote has the commit
    const remoteLog = execFileSync(
      "git",
      ["log", "--oneline", branch],
      { cwd: remoteDir, encoding: "utf8" },
    );
    expect(remoteLog).toContain("pushed commit");
  });

  it("force push uses --force-with-lease", () => {
    writeFileSync(join(dir, "force.txt"), "force\n");
    execFileSync("git", ["add", "force.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "force commit"], {
      cwd: dir,
      stdio: "pipe",
    });

    const result = pushToRemote(undefined, undefined, true, false, dir);
    expect(result.forced).toBe(true);
    expect(result.dry_run).toBe(false);
  });

  it("throws SEGMINT_NO_REMOTE for nonexistent remote", () => {
    expect(() =>
      pushToRemote("nonexistent", undefined, false, true, dir),
    ).toThrow("SEGMINT_NO_REMOTE");
  });

  it("throws SEGMINT_NO_BRANCH on detached HEAD without explicit branch", () => {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["checkout", sha], { cwd: dir, stdio: "pipe" });

    expect(() =>
      pushToRemote(undefined, undefined, false, true, dir),
    ).toThrow("SEGMINT_NO_BRANCH");
  });
});
