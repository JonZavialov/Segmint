/**
 * Commit history — Tier 1 read-only repo intelligence.
 *
 * Retrieves structured commit log entries from git CLI using a NUL-delimited
 * format for safe parsing. No mutation, no LLM involvement.
 */

import { execFileSync } from "node:child_process";
import type { LogCommit } from "./models.js";

// 10 MB — consistent with git.ts and status.ts
const MAX_BUFFER = 10 * 1024 * 1024;

const EXEC_OPTS_BASE = {
  encoding: "utf8" as const,
  maxBuffer: MAX_BUFFER,
  stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
};

export interface GetLogArgs {
  limit?: number;
  ref?: string;
  path?: string;
  since?: string;
  until?: string;
  include_merges?: boolean;
}

/**
 * Retrieve commit history as structured LogCommit objects.
 *
 * Uses a NUL-delimited format (%x00) for safe field splitting and double-NUL
 * (%x00%x00) as the record separator.
 *
 * @throws Error with descriptive message if not a git repo, bad ref, or bad path
 */
export function getLog(args: GetLogArgs): { commits: LogCommit[] } {
  const dir = process.cwd();
  const opts = { ...EXEC_OPTS_BASE, cwd: dir };

  const ref = args.ref ?? "HEAD";

  // Clamp limit to 1..200, default 20
  let limit = args.limit ?? 20;
  if (limit < 1) limit = 1;
  if (limit > 200) limit = 200;

  const argv: string[] = [
    "log",
    ref,
    `-n`,
    String(limit),
    "--date=iso-strict",
    "--pretty=format:%H%x00%h%x00%s%x00%an%x00%ae%x00%ad%x00%P%x00%x00",
  ];

  if (args.include_merges !== true) {
    argv.push("--no-merges");
  }

  if (args.since !== undefined) {
    argv.push(`--since=${args.since}`);
  }

  if (args.until !== undefined) {
    argv.push(`--until=${args.until}`);
  }

  if (args.path !== undefined) {
    argv.push("--", args.path);
  }

  let raw: string;
  try {
    raw = execFileSync("git", argv, opts);
  } catch (err) {
    throwGitError(err);
  }

  const commits = parseLogOutput(raw);
  return { commits };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse the NUL-delimited git log output into LogCommit objects.
 *
 * Records are separated by double-NUL (\0\0). Each record contains 7 fields
 * separated by single NUL (\0): sha, short_sha, subject, author_name,
 * author_email, author_date, parents.
 */
function parseLogOutput(raw: string): LogCommit[] {
  if (raw.trim().length === 0) return [];

  // Split on double-NUL record separator
  const records = raw.split("\0\0").filter((r) => r.length > 0);

  const commits: LogCommit[] = [];
  for (const record of records) {
    // Strip leading/trailing whitespace (newlines between records)
    const trimmed = record.replace(/^\n+/, "");
    if (trimmed.length === 0) continue;

    const fields = trimmed.split("\0");
    if (fields.length < 7) continue;

    const [sha, short_sha, subject, author_name, author_email, author_date, parentsRaw] = fields;

    const parents = parentsRaw.trim().length > 0
      ? parentsRaw.trim().split(" ")
      : [];

    commits.push({
      sha,
      short_sha,
      subject,
      author_name,
      author_email,
      author_date,
      parents,
    });
  }

  return commits;
}

/**
 * Inspect a git error and throw a descriptive message.
 * Mirrors the pattern in status.ts and git.ts.
 */
function throwGitError(err: unknown): never {
  if (!(err instanceof Error)) throw err;

  const stderr = "stderr" in err ? String((err as { stderr: unknown }).stderr).trim() : "";
  const msg = stderr || err.message || "";

  if (msg.includes("not a git repository")) {
    throw new Error("Not a git repository");
  }

  if ("code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error("git command not found. Please install git.");
  }

  throw new Error(msg || "Unknown git error");
}
