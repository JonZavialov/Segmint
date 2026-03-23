/**
 * Commit creation — Tier 2 workspace mutation.
 *
 * Creates a commit from currently staged changes. Supports dry-run
 * validation to inspect what would be committed before execution.
 */

import { execGit } from "./exec-git.js";
import type { CommitResult } from "./models.js";

/**
 * Create a commit from staged changes.
 *
 * @param message Commit message
 * @param dryRun If true, validate only — do not commit
 * @param cwd Repository working directory
 * @returns CommitResult with sha, subject, and dry_run flag
 * @throws Error if nothing is staged (SEGMINT_NOTHING_STAGED)
 */
export function createCommit(
  message: string,
  dryRun: boolean,
  cwd: string,
): CommitResult {
  const status = execGit(["status", "--porcelain"], cwd);
  const hasStagedChanges = status
    .split("\n")
    .filter((l) => l.length >= 2)
    .some((l) => {
      const x = l[0];
      return x !== " " && x !== "?" && x !== "!";
    });

  if (!hasStagedChanges) {
    throw new Error(
      "SEGMINT_NOTHING_STAGED: No staged changes to commit.",
    );
  }

  if (dryRun) {
    return { sha: "", short_sha: "", subject: message, dry_run: true };
  }

  execGit(["commit", "-m", message], cwd);

  const sha = execGit(["rev-parse", "HEAD"], cwd).trim();
  const shortSha = execGit(["rev-parse", "--short", "HEAD"], cwd).trim();

  return { sha, short_sha: shortSha, subject: message, dry_run: false };
}
