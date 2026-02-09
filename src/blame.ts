/**
 * Line-level blame — Tier 1 read-only repo intelligence.
 *
 * Runs `git blame --line-porcelain` and parses the output into structured
 * BlameLine objects with commit metadata for each line.
 */

import type { BlameLine, BlameResult } from "./models.js";
import { execGit } from "./exec-git.js";

export interface BlameArgs {
  path: string;
  ref?: string;
  start_line?: number;
  end_line?: number;
  ignore_whitespace?: boolean;
  detect_moves?: boolean;
}

/**
 * Parse `git blame --line-porcelain` output into BlameLine[].
 *
 * Each block in the porcelain format starts with:
 *   <sha> <orig-line> <final-line> [<num-lines>]
 * Followed by key-value header lines, terminated by a tab-prefixed content line.
 */
export function parseBlamePorcelain(raw: string): BlameLine[] {
  const lines: BlameLine[] = [];
  const rawLines = raw.split("\n");
  let i = 0;

  while (i < rawLines.length) {
    const headerLine = rawLines[i];
    // Each block starts with a 40-char SHA
    const headerMatch = headerLine.match(
      /^([0-9a-f]{40})\s+(\d+)\s+(\d+)(?:\s+\d+)?$/
    );
    if (!headerMatch) {
      i++;
      continue;
    }

    const sha = headerMatch[1];
    const finalLine = parseInt(headerMatch[3], 10);
    i++;

    // Read key-value pairs until we hit the tab-prefixed content line
    let authorName = "";
    let authorMail = "";
    let authorTime = "";
    let summary = "";
    let content = "";

    while (i < rawLines.length) {
      const line = rawLines[i];
      if (line.startsWith("\t")) {
        content = line.substring(1);
        i++;
        break;
      }

      if (line.startsWith("author ")) {
        authorName = line.substring(7);
      } else if (line.startsWith("author-mail ")) {
        // Strip angle brackets: "<user@email.com>" → "user@email.com"
        authorMail = line.substring(12).replace(/^<|>$/g, "");
      } else if (line.startsWith("author-time ")) {
        const unixSeconds = parseInt(line.substring(12), 10);
        authorTime = new Date(unixSeconds * 1000).toISOString();
      } else if (line.startsWith("summary ")) {
        summary = line.substring(8);
      }

      i++;
    }

    lines.push({
      line_number: finalLine,
      content,
      commit: {
        sha,
        short_sha: sha.substring(0, 7),
        author_name: authorName,
        author_email: authorMail,
        author_time: authorTime,
        summary,
      },
    });
  }

  return lines;
}

/**
 * Get blame information for a file at a given ref.
 *
 * @throws Error with descriptive message if path is invalid, ref is bad, etc.
 */
export function getBlame(args: BlameArgs, cwd?: string): BlameResult {
  const ref = args.ref ?? "HEAD";

  const argv: string[] = ["blame", "--line-porcelain"];

  if (args.ignore_whitespace) {
    argv.push("-w");
  }
  if (args.detect_moves) {
    argv.push("-M", "-C");
  }

  if (args.start_line !== undefined && args.end_line !== undefined) {
    argv.push("-L", `${args.start_line},${args.end_line}`);
  } else if (args.start_line !== undefined) {
    argv.push("-L", `${args.start_line},`);
  } else if (args.end_line !== undefined) {
    argv.push("-L", `,${args.end_line}`);
  }

  argv.push(ref, "--", args.path);

  const raw = execGit(argv, cwd);
  const lines = parseBlamePorcelain(raw);

  return { path: args.path, ref, lines };
}
