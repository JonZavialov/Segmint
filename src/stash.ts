/**
 * Stash operations — Tier 1 read-only (list) + Tier 2 mutation (save, pop).
 *
 * Provides structured stash management with dry-run guardrails
 * for save and pop operations.
 */

import { execGit, tryExecGit } from "./exec-git.js";
import type { StashEntry, StashSaveResult, StashPopResult } from "./models.js";

/**
 * List all stashes as structured entries.
 *
 * @param cwd Repository working directory
 * @returns Object containing array of StashEntry objects
 */
export function listStashes(cwd: string): { stashes: StashEntry[] } {
  const raw = execGit(
    ["stash", "list", "--format=%gd%x00%s%x00%H"],
    cwd,
  );

  if (raw.trim().length === 0) {
    return { stashes: [] };
  }

  const stashes: StashEntry[] = [];
  const lines = raw.trim().split("\n");

  for (const line of lines) {
    if (line.trim().length === 0) continue;
    const parts = line.split("\0");
    if (parts.length < 3) continue;

    const [reflog, message, sha] = parts;
    const indexMatch = reflog.match(/stash@\{(\d+)\}/);
    const index = indexMatch ? parseInt(indexMatch[1], 10) : 0;

    stashes.push({ index, message, sha });
  }

  return { stashes };
}

/**
 * Stash current changes.
 *
 * @param message Optional stash message
 * @param dryRun If true, validate only — do not stash
 * @param cwd Repository working directory
 * @throws Error if nothing to stash (SEGMINT_NOTHING_TO_STASH)
 */
export function saveStash(
  message: string | undefined,
  dryRun: boolean,
  cwd: string,
): StashSaveResult {
  const status = execGit(["status", "--porcelain"], cwd);
  const hasChanges = status
    .split("\n")
    .some((l) => l.trim().length > 0);

  if (!hasChanges) {
    throw new Error(
      "SEGMINT_NOTHING_TO_STASH: No changes to stash.",
    );
  }

  const stashMessage = message ?? "";

  if (dryRun) {
    return { message: stashMessage, dry_run: true };
  }

  const args = ["stash", "push"];
  if (message !== undefined) {
    args.push("-m", message);
  }
  execGit(args, cwd);

  return { message: stashMessage, dry_run: false };
}

/**
 * Pop a stash entry.
 *
 * @param index Stash index to pop (default 0)
 * @param dryRun If true, validate only — do not pop
 * @param cwd Repository working directory
 * @throws Error if stash at index does not exist (SEGMINT_STASH_NOT_FOUND)
 */
export function popStash(
  index: number | undefined,
  dryRun: boolean,
  cwd: string,
): StashPopResult {
  const stashIndex = index ?? 0;

  const check = tryExecGit(
    ["stash", "show", `stash@{${stashIndex}}`],
    cwd,
  );
  if (!check.ok) {
    throw new Error(
      `SEGMINT_STASH_NOT_FOUND: No stash found at index ${stashIndex}.`,
    );
  }

  if (dryRun) {
    return { index: stashIndex, dry_run: true };
  }

  execGit(["stash", "pop", `stash@{${stashIndex}}`], cwd);

  return { index: stashIndex, dry_run: false };
}
