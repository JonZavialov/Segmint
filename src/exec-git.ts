/**
 * Centralized git command execution and error handling.
 *
 * All git subprocess calls go through this module. Provides both throwing
 * (execGit) and non-throwing (tryExecGit) variants, plus deterministic
 * ASCII path sorting for consistent ID assignment.
 */

import { execFileSync } from "node:child_process";

// 10 MB — generous buffer for large diffs
const MAX_BUFFER = 10 * 1024 * 1024;

const EXEC_OPTS_BASE = {
  encoding: "utf8" as const,
  maxBuffer: MAX_BUFFER,
  stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
};

export interface ExecGitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code?: number;
}

/**
 * Run a git command and return stdout. Throws on failure.
 *
 * Use for calls that must succeed (diff, log, show, etc.).
 */
export function execGit(
  args: string[],
  cwd?: string,
  input?: string,
): string {
  const dir = cwd ?? process.cwd();
  try {
    const opts =
      input !== undefined
        ? { ...EXEC_OPTS_BASE, cwd: dir, input }
        : { ...EXEC_OPTS_BASE, cwd: dir };
    return execFileSync("git", args, opts);
  } catch (err) {
    throwGitError(err);
  }
}

/**
 * Run a git command and return a result object. Never throws.
 *
 * Use for probe calls where failure is expected (e.g. symbolic-ref on
 * detached HEAD, upstream check, fresh repo).
 */
export function tryExecGit(args: string[], cwd?: string): ExecGitResult {
  const dir = cwd ?? process.cwd();
  try {
    const stdout = execFileSync("git", args, { ...EXEC_OPTS_BASE, cwd: dir });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    if (err instanceof Error) {
      const stderr = "stderr" in err
        ? String((err as { stderr: unknown }).stderr).trim()
        : "";
      const code = "status" in err
        ? (err as { status: number }).status
        : undefined;
      return { ok: false, stdout: "", stderr, code };
    }
    return { ok: false, stdout: "", stderr: String(err) };
  }
}

/**
 * Inspect a git error and throw a descriptive message.
 *
 * Matches broadly to handle git version/locale variations:
 * - "not a git repository" (with or without "fatal:" prefix)
 * - ENOENT for missing git binary
 * - All other errors preserve the stderr message
 */
export function throwGitError(err: unknown): never {
  if (!(err instanceof Error)) throw err;

  const stderr = "stderr" in err
    ? String((err as { stderr: unknown }).stderr).trim()
    : "";
  const msg = stderr || err.message || "";

  if (msg.toLowerCase().includes("not a git repository")) {
    throw new Error("Not a git repository");
  }

  if ("code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error("git command not found. Please install git.");
  }

  throw new Error(msg || "Unknown git error");
}

/**
 * Deterministic ASCII string comparator for path sorting.
 *
 * Avoids locale-dependent behavior of String.localeCompare() which can
 * produce different orderings on different platforms.
 */
export function compareAscii(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
