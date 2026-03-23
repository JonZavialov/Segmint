import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { resetSoft } from "../../src/reset.js";

function createTempRepo(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "segmint-reset-"));
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

describe("resetSoft", () => {
  let dir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ dir, cleanup } = createTempRepo());
  });

  afterEach(() => cleanup());

  it("soft resets HEAD and keeps changes staged", () => {
    // Create a second commit
    writeFileSync(join(dir, "second.txt"), "second\n");
    execFileSync("git", ["add", "second.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "second commit"], { cwd: dir });

    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();

    const targetSha = execFileSync("git", ["rev-parse", "HEAD~1"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();

    const result = resetSoft("HEAD~1", false, dir);
    expect(result.ref).toBe("HEAD~1");
    expect(result.previous_sha).toBe(headBefore);
    expect(result.new_sha).toBe(targetSha);
    expect(result.dry_run).toBe(false);

    // HEAD should now point to the first commit
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    expect(headAfter).toBe(targetSha);

    // second.txt should be staged (changes preserved)
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: dir,
      encoding: "utf8",
    });
    expect(status).toContain("A  second.txt");
  });

  it("dry_run returns correct SHAs without resetting", () => {
    writeFileSync(join(dir, "second.txt"), "second\n");
    execFileSync("git", ["add", "second.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-m", "second commit"], { cwd: dir });

    const headBefore = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();

    const result = resetSoft("HEAD~1", true, dir);
    expect(result.dry_run).toBe(true);
    expect(result.previous_sha).toBe(headBefore);
    expect(result.new_sha).toMatch(/^[0-9a-f]{40}$/);

    // HEAD should not have moved
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
    }).trim();
    expect(headAfter).toBe(headBefore);
  });

  it("throws on invalid ref", () => {
    expect(() => resetSoft("nonexistent-ref", false, dir)).toThrow();
  });
});
