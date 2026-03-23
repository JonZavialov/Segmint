/**
 * Push operation — Tier 3 irreversible (gated).
 *
 * Pushes to a remote with dry_run defaulting to TRUE for safety.
 * Force push uses --force-with-lease (not --force) to prevent
 * overwriting unreviewed remote changes.
 */

import { execGit, tryExecGit } from "./exec-git.js";
import type { PushResult } from "./models.js";

/**
 * Push to remote.
 *
 * SAFETY: dry_run defaults to true at the server level. The caller must
 * explicitly pass dry_run: false to actually push. Force push uses
 * --force-with-lease for safety.
 *
 * @param remote Remote name (default "origin")
 * @param branch Branch to push (default: current branch)
 * @param force Use --force-with-lease (default false)
 * @param dryRun Simulate push without executing
 * @param cwd Repository working directory
 * @throws Error if no remote configured (SEGMINT_NO_REMOTE)
 * @throws Error if no branch to push (SEGMINT_NO_BRANCH)
 */
export function pushToRemote(
  remote: string | undefined,
  branch: string | undefined,
  force: boolean,
  dryRun: boolean,
  cwd: string,
): PushResult {
  const targetRemote = remote ?? "origin";

  let targetBranch: string;
  if (branch !== undefined) {
    targetBranch = branch;
  } else {
    const branchResult = tryExecGit(
      ["symbolic-ref", "--short", "HEAD"],
      cwd,
    );
    if (!branchResult.ok) {
      throw new Error(
        "SEGMINT_NO_BRANCH: Cannot determine current branch (detached HEAD). Specify a branch explicitly.",
      );
    }
    targetBranch = branchResult.stdout.trim();
  }

  const remoteCheck = tryExecGit(
    ["remote", "get-url", targetRemote],
    cwd,
  );
  if (!remoteCheck.ok) {
    throw new Error(
      `SEGMINT_NO_REMOTE: Remote '${targetRemote}' is not configured.`,
    );
  }

  const args = ["push"];
  if (dryRun) {
    args.push("--dry-run");
  }
  if (force) {
    args.push("--force-with-lease");
  }
  args.push(targetRemote, targetBranch);

  execGit(args, cwd);

  return {
    remote: targetRemote,
    branch: targetBranch,
    dry_run: dryRun,
    forced: force,
  };
}
