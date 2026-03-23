/**
 * Workspace mutation — Tier 2 staging primitives.
 *
 * Provides controlled, reversible staging and unstaging of file paths.
 * All operations require explicit file paths (no wildcards or blanket
 * operations) and support dry-run mode for validation before execution.
 */

import { execGit } from "./exec-git.js";
import { parseDiff } from "./git.js";
import type { StageResult, UnstageResult, StageHunksResult } from "./models.js";

/**
 * Stage file paths via `git add`.
 *
 * @param paths Repo-relative file paths to stage
 * @param dryRun If true, validate only — do not execute `git add`
 * @param cwd Repository working directory
 * @returns StageResult with the list of staged paths and dry_run flag
 * @throws Error if paths is empty, or if git add fails
 */
export function stageChanges(
  paths: string[],
  dryRun: boolean,
  cwd: string,
): StageResult {
  if (paths.length === 0) {
    throw new Error("SEGMINT_EMPTY_PATHS: paths array must not be empty.");
  }

  if (dryRun) {
    // Dry run: validate that git can resolve the paths by running
    // git status on each path (does not mutate anything)
    execGit(["status", "--porcelain", "--", ...paths], cwd);
    return { staged_paths: paths, dry_run: true };
  }

  execGit(["add", "--", ...paths], cwd);
  return { staged_paths: paths, dry_run: false };
}

/**
 * Unstage file paths via `git reset HEAD`.
 *
 * @param paths Repo-relative file paths to unstage
 * @param dryRun If true, validate only — do not execute `git reset`
 * @param cwd Repository working directory
 * @returns UnstageResult with the list of unstaged paths and dry_run flag
 * @throws Error if paths is empty, or if git reset fails
 */
export function unstageChanges(
  paths: string[],
  dryRun: boolean,
  cwd: string,
): UnstageResult {
  if (paths.length === 0) {
    throw new Error("SEGMINT_EMPTY_PATHS: paths array must not be empty.");
  }

  if (dryRun) {
    // Dry run: validate that git can resolve the paths
    execGit(["status", "--porcelain", "--", ...paths], cwd);
    return { unstaged_paths: paths, dry_run: true };
  }

  execGit(["reset", "HEAD", "--", ...paths], cwd);
  return { unstaged_paths: paths, dry_run: false };
}

/**
 * Stage specific hunks from a file's unstaged diff.
 *
 * Reconstructs a minimal patch containing only the selected hunks
 * and applies it to the index via `git apply --cached`.
 *
 * @param filePath Repo-relative file path
 * @param hunkIndices 0-based indices of hunks to stage
 * @param dryRun If true, validate only via --check
 * @param cwd Repository working directory
 * @throws Error if hunk_indices is empty (SEGMINT_EMPTY_HUNKS)
 * @throws Error if no unstaged changes for file (SEGMINT_NO_UNSTAGED_CHANGES)
 * @throws Error if any hunk index is out of range (SEGMINT_HUNK_OUT_OF_RANGE)
 */
export function stageHunks(
  filePath: string,
  hunkIndices: number[],
  dryRun: boolean,
  cwd: string,
): StageHunksResult {
  if (hunkIndices.length === 0) {
    throw new Error(
      "SEGMINT_EMPTY_HUNKS: hunk_indices array must not be empty.",
    );
  }

  const diffOutput = execGit(
    ["diff", "--no-color", "--unified=3", "--", filePath],
    cwd,
  );

  const parsed = parseDiff(diffOutput);
  if (parsed.length === 0) {
    throw new Error(
      `SEGMINT_NO_UNSTAGED_CHANGES: No unstaged changes for '${filePath}'.`,
    );
  }

  const entry = parsed[0];
  const totalHunks = entry.hunks.length;

  for (const idx of hunkIndices) {
    if (idx < 0 || idx >= totalHunks) {
      throw new Error(
        `SEGMINT_HUNK_OUT_OF_RANGE: Hunk index ${idx} is out of range (0..${totalHunks - 1}).`,
      );
    }
  }

  // Reconstruct the diff header (everything before the first hunk)
  const diffLines = diffOutput.split("\n");
  const headerLines: string[] = [];
  for (const line of diffLines) {
    if (line.startsWith("@@")) break;
    headerLines.push(line);
  }

  // Build a minimal patch with only selected hunks
  const patchParts = [...headerLines];
  for (const idx of hunkIndices) {
    const hunk = entry.hunks[idx];
    patchParts.push(hunk.header);
    patchParts.push(...hunk.lines);
  }
  const patch = patchParts.join("\n") + "\n";

  if (dryRun) {
    execGit(["apply", "--cached", "--check"], cwd, patch);
    return { file_path: filePath, hunks_staged: hunkIndices.length, dry_run: true };
  }

  execGit(["apply", "--cached"], cwd, patch);
  return { file_path: filePath, hunks_staged: hunkIndices.length, dry_run: false };
}
