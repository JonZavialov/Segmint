/**
 * Reset operations — Tier 2 workspace mutation.
 *
 * Provides controlled soft reset: moves HEAD backward while
 * keeping all changes staged. Supports dry-run for safety.
 */

import { execGit } from "./exec-git.js";
import type { ResetResult } from "./models.js";

/**
 * Soft reset HEAD to a ref, keeping changes staged.
 *
 * @param ref Target ref to reset to
 * @param dryRun If true, validate only — do not reset
 * @param cwd Repository working directory
 * @throws Error if ref is invalid (propagated from git)
 */
export function resetSoft(
  ref: string,
  dryRun: boolean,
  cwd: string,
): ResetResult {
  const previousSha = execGit(["rev-parse", "HEAD"], cwd).trim();
  const newSha = execGit(["rev-parse", ref], cwd).trim();

  if (dryRun) {
    return { ref, previous_sha: previousSha, new_sha: newSha, dry_run: true };
  }

  execGit(["reset", "--soft", ref], cwd);

  return { ref, previous_sha: previousSha, new_sha: newSha, dry_run: false };
}
