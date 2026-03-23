/**
 * Branch operations — Tier 2 workspace mutation.
 *
 * Provides controlled branch creation and switching with dry-run support.
 * Git's natural safety mechanisms handle dirty-tree conflicts during checkout.
 */

import { execGit, tryExecGit } from "./exec-git.js";
import type { CreateBranchResult, CheckoutResult } from "./models.js";

/**
 * Create a new branch.
 *
 * @param name Branch name to create
 * @param ref Optional starting ref (defaults to HEAD)
 * @param dryRun If true, validate only — do not create
 * @param cwd Repository working directory
 * @throws Error if branch already exists (SEGMINT_BRANCH_EXISTS)
 */
export function createBranch(
  name: string,
  ref: string | undefined,
  dryRun: boolean,
  cwd: string,
): CreateBranchResult {
  const check = tryExecGit(
    ["rev-parse", "--verify", `refs/heads/${name}`],
    cwd,
  );
  if (check.ok) {
    throw new Error(
      `SEGMINT_BRANCH_EXISTS: Branch '${name}' already exists.`,
    );
  }

  const targetRef = ref ?? "HEAD";
  const sha = execGit(["rev-parse", targetRef], cwd).trim();

  if (dryRun) {
    return { branch_name: name, sha, dry_run: true };
  }

  const args = ["branch", name];
  if (ref !== undefined) {
    args.push(ref);
  }
  execGit(args, cwd);

  return { branch_name: name, sha, dry_run: false };
}

/**
 * Switch to an existing branch.
 *
 * @param name Branch name to switch to
 * @param dryRun If true, validate only — do not switch
 * @param cwd Repository working directory
 * @throws Error if branch does not exist (SEGMINT_BRANCH_NOT_FOUND)
 */
export function checkoutBranch(
  name: string,
  dryRun: boolean,
  cwd: string,
): CheckoutResult {
  const check = tryExecGit(
    ["rev-parse", "--verify", `refs/heads/${name}`],
    cwd,
  );
  if (!check.ok) {
    throw new Error(
      `SEGMINT_BRANCH_NOT_FOUND: Branch '${name}' does not exist.`,
    );
  }

  const currentBranch = tryExecGit(
    ["symbolic-ref", "--short", "HEAD"],
    cwd,
  );
  const previousBranch = currentBranch.ok
    ? currentBranch.stdout.trim()
    : null;

  if (dryRun) {
    return {
      branch_name: name,
      previous_branch: previousBranch,
      dry_run: true,
    };
  }

  execGit(["checkout", name], cwd);

  return {
    branch_name: name,
    previous_branch: previousBranch,
    dry_run: false,
  };
}
