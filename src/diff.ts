/**
 * Ref-to-ref diff — Tier 1 read-only repo intelligence.
 *
 * Computes a structured diff between any two git refs (branches, commits, tags)
 * with optional path filtering. Reuses the existing parseDiff pipeline from
 * git.ts to produce Change/Hunk objects.
 */

import type { Change } from "./models.js";
import { parseDiff } from "./git.js";
import { execGit, compareAscii } from "./exec-git.js";

export interface DiffBetweenRefsArgs {
  base: string;
  head: string;
  path?: string;
  unified?: number;
}

/**
 * Compute structured diff between two refs.
 *
 * @throws Error with descriptive message if refs are invalid, not a git repo, etc.
 */
export function getDiffBetweenRefs(args: DiffBetweenRefsArgs, cwd?: string): Change[] {
  // Clamp unified context lines to 0..20, default 3
  let unified = args.unified ?? 3;
  if (unified < 0) unified = 0;
  if (unified > 20) unified = 20;

  const argv: string[] = [
    "diff",
    args.base,
    args.head,
    "--no-color",
    `--unified=${unified}`,
  ];

  if (args.path !== undefined) {
    argv.push("--", args.path);
  }

  const raw = execGit(argv, cwd);
  const parsed = parseDiff(raw);

  // Sort by file_path for deterministic IDs (scoped to this output)
  const sorted = parsed.sort((a, b) => compareAscii(a.file_path, b.file_path));

  return sorted.map((entry, idx) => ({
    id: `change-${idx + 1}`,
    file_path: entry.file_path,
    hunks: entry.hunks,
  }));
}
