import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createCommit } from "../../src/commit.js";

function createTempRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "segmint-commit-"));
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

describe("createCommit", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
  });

  afterEach(() => cleanup());

  it("commits staged changes and returns sha", () => {
    writeFileSync(join(dir, "init.txt"), "modified\n");
    execFileSync("git", ["add", "init.txt"], { cwd: dir });

    const result = createCommit("test commit message", false, dir);
    expect(result.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.short_sha).toMatch(/^[0-9a-f]+$/);
    expect(result.subject).toBe("test commit message");
    expect(result.dry_run).toBe(false);

    // Verify commit exists in log
    const log = execFileSync("git", ["log", "--oneline", "-1"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(log).toContain("test commit message");
  });

  it("dry_run returns empty sha without committing", () => {
    writeFileSync(join(dir, "init.txt"), "modified\n");
    execFileSync("git", ["add", "init.txt"], { cwd: dir });

    const result = createCommit("dry run message", true, dir);
    expect(result.sha).toBe("");
    expect(result.short_sha).toBe("");
    expect(result.subject).toBe("dry run message");
    expect(result.dry_run).toBe(true);

    // Verify no commit was created
    const log = execFileSync("git", ["log", "--oneline"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(log).not.toContain("dry run message");
  });

  it("throws SEGMINT_NOTHING_STAGED when nothing staged", () => {
    expect(() => createCommit("should fail", false, dir)).toThrow(
      "SEGMINT_NOTHING_STAGED",
    );
  });

  it("throws SEGMINT_NOTHING_STAGED with only unstaged changes", () => {
    writeFileSync(join(dir, "init.txt"), "modified\n");

    expect(() => createCommit("should fail", false, dir)).toThrow(
      "SEGMINT_NOTHING_STAGED",
    );
  });
});
