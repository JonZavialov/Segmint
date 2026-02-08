/**
 * Git diff execution and unified diff parsing.
 *
 * Runs `git diff` and `git diff --cached` to capture unstaged and staged
 * changes, parses the unified diff output into structured Change objects.
 */

import { execFileSync } from "node:child_process";
import type { Change, Hunk } from "./models.js";

// 10 MB — generous buffer for large diffs
const MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Capture all uncommitted changes (staged + unstaged) as Change objects.
 *
 * Merge order: when a file appears in both staged and unstaged diffs,
 * staged hunks come first, then unstaged hunks.
 *
 * @param cwd Working directory (defaults to process.cwd())
 * @returns Sorted Change[] with deterministic IDs
 * @throws Error if not a git repo or git is not installed
 */
export function getUncommittedChanges(cwd?: string): Change[] {
  const dir = cwd ?? process.cwd();
  const execOpts = {
    encoding: "utf8" as const,
    cwd: dir,
    maxBuffer: MAX_BUFFER,
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
  };

  let stagedDiff: string;
  let unstagedDiff: string;

  try {
    stagedDiff = execFileSync(
      "git",
      ["diff", "--cached", "--no-color", "--unified=3"],
      execOpts,
    );
  } catch (err) {
    throwGitError(err);
    return []; // unreachable, satisfies TS
  }

  try {
    unstagedDiff = execFileSync(
      "git",
      ["diff", "--no-color", "--unified=3"],
      execOpts,
    );
  } catch (err) {
    throwGitError(err);
    return [];
  }

  const staged = parseDiff(stagedDiff);
  const unstaged = parseDiff(unstagedDiff);

  // Merge: keyed by file_path, staged hunks first then unstaged
  const merged = new Map<string, Hunk[]>();

  for (const entry of staged) {
    merged.set(entry.file_path, [...entry.hunks]);
  }
  for (const entry of unstaged) {
    const existing = merged.get(entry.file_path);
    if (existing) {
      existing.push(...entry.hunks);
    } else {
      merged.set(entry.file_path, [...entry.hunks]);
    }
  }

  // Sort by file path for deterministic IDs
  const sortedPaths = [...merged.keys()].sort((a, b) => a.localeCompare(b));

  return sortedPaths.map((filePath, index) => ({
    id: `change-${index + 1}`,
    file_path: filePath,
    hunks: merged.get(filePath)!,
  }));
}

/**
 * Parse raw unified diff text into per-file entries with hunks.
 * Does NOT assign IDs or sort — the caller handles that after merging.
 */
export function parseDiff(
  diffText: string,
): Array<{ file_path: string; hunks: Hunk[] }> {
  if (!diffText.trim()) return [];

  const results: Array<{ file_path: string; hunks: Hunk[] }> = [];

  // Split into per-file chunks on "diff --git" boundaries
  const chunks = splitIntoFileChunks(diffText);

  for (const chunk of chunks) {
    const filePath = extractFilePath(chunk);
    if (!filePath) continue;
    if (isBinaryFile(chunk)) continue;

    const hunks = parseHunks(chunk);
    if (hunks.length === 0) continue;

    results.push({ file_path: filePath, hunks });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Split raw diff text into per-file chunks.
 * Each chunk starts with "diff --git ...".
 */
function splitIntoFileChunks(diffText: string): string[] {
  const parts = diffText.split(/^diff --git /m);
  // First element is empty or whitespace before the first "diff --git"
  return parts
    .slice(1)
    .map((part) => "diff --git " + part);
}

/**
 * Extract the file path from a diff chunk header.
 *
 * Format: `diff --git a/<path> b/<path>`
 * If either side is /dev/null (new or deleted file), uses the non-null side.
 */
function extractFilePath(chunk: string): string | null {
  const firstLine = chunk.split("\n")[0];
  // Match: diff --git a/<aPath> b/<bPath>
  const match = firstLine.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!match) return null;

  const aPath = match[1];
  const bPath = match[2];

  // For deleted files, a-side has the real path and b-side is /dev/null
  if (bPath === "/dev/null") return aPath;
  // For new files, b-side has the real path and a-side is /dev/null
  // (a-side would be /dev/null but the regex already captured it)
  return bPath;
}

/** Check if a diff chunk represents a binary file. */
function isBinaryFile(chunk: string): boolean {
  return /^Binary files .+ differ$/m.test(chunk);
}

/**
 * Parse all hunks from a single file's diff chunk.
 *
 * Hunk headers look like: `@@ -10,3 +10,5 @@ optional function context`
 */
function parseHunks(chunk: string): Hunk[] {
  const hunks: Hunk[] = [];
  const lines = chunk.split("\n");

  let i = 0;

  // Skip to first @@ line
  while (i < lines.length && !lines[i].startsWith("@@")) {
    i++;
  }

  while (i < lines.length) {
    const headerLine = lines[i];
    const headerMatch = headerLine.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/,
    );

    if (!headerMatch) {
      i++;
      continue;
    }

    const header = headerMatch[0];
    const oldStart = parseInt(headerMatch[1], 10);
    const oldLines = headerMatch[2] !== undefined ? parseInt(headerMatch[2], 10) : 1;
    const newStart = parseInt(headerMatch[3], 10);
    const newLines = headerMatch[4] !== undefined ? parseInt(headerMatch[4], 10) : 1;

    // Collect diff lines until next @@ or end of chunk
    const hunkLines: string[] = [];
    i++;
    while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("diff --git ")) {
      // Include context ( ), additions (+), deletions (-), and no-newline markers (\)
      const line = lines[i];
      if (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line.startsWith("\\")) {
        hunkLines.push(line);
      }
      i++;
    }

    hunks.push({
      old_start: oldStart,
      old_lines: oldLines,
      new_start: newStart,
      new_lines: newLines,
      header,
      lines: hunkLines,
    });
  }

  return hunks;
}

/**
 * Inspect a git error and throw a descriptive message.
 */
function throwGitError(err: unknown): never {
  if (!(err instanceof Error)) throw err;

  // execFileSync attaches stderr to the error object when the child process fails
  const stderr = "stderr" in err ? String((err as { stderr: unknown }).stderr).trim() : "";
  const msg = stderr || err.message || "";

  // "not a git repository" appears in stderr from git
  if (msg.includes("not a git repository")) {
    throw new Error("Not a git repository");
  }

  // ENOENT means git binary was not found
  if ("code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
    throw new Error("git command not found. Please install git.");
  }

  throw new Error(msg || "Unknown git error");
}
