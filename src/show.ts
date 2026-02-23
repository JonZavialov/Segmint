/**
 * Commit detail retrieval — Tier 1 read-only repo intelligence.
 *
 * Returns full structured details for a single commit: metadata, affected files,
 * and the full diff parsed into Change/Hunk objects via the existing parseDiff
 * pipeline from git.ts.
 */

import type { CommitDetail, FileStatus, Change } from "./models.js";
import { parseDiff } from "./git.js";
import { execGit, compareAscii } from "./exec-git.js";

/**
 * Retrieve full details for a single commit.
 *
 * Executes three git commands:
 * 1. `git show -s` with NUL-delimited format for metadata
 * 2. `git show --name-status` for affected files
 * 3. `git diff <sha>^!` (or `git show` for root commits) for the full diff
 *
 * @throws Error with descriptive message if sha is unknown, not a git repo, etc.
 */
export function getCommit(sha: string, cwd?: string): { commit: CommitDetail } {
  // 1. Metadata via NUL-delimited format
  const metaRaw = execGit([
    "show", "-s",
    "--date=iso-strict",
    "--pretty=format:%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd%x00%P",
    sha,
  ], cwd);

  const meta = parseMetadata(metaRaw);

  // 2. Name-status for affected files
  const nameStatusRaw = execGit(
    ["show", "--name-status", "--pretty=format:", sha],
    cwd,
  );
  const files = parseNameStatus(nameStatusRaw);

  // 3. Diff — use parent-based diff or git show for root commits
  let diffRaw: string;
  if (meta.parents.length === 0) {
    // Root commit: no parent to diff against, use git show for diff
    diffRaw = execGit(
      ["show", sha, "--no-color", "--unified=3", "--pretty=format:"],
      cwd,
    );
  } else {
    // Normal commit: diff against parent(s)
    diffRaw = execGit(
      ["diff", `${sha}^!`, "--no-color", "--unified=3"],
      cwd,
    );
  }

  const parsed = parseDiff(diffRaw);
  const sortedPaths = parsed
    .map((e) => e.file_path)
    .sort(compareAscii);

  const pathToEntry = new Map(parsed.map((e) => [e.file_path, e]));
  const changes: Change[] = sortedPaths.map((fp, idx) => ({
    id: `change-${idx + 1}`,
    file_path: fp,
    hunks: pathToEntry.get(fp)!.hunks,
  }));

  const commit: CommitDetail = {
    sha: meta.sha,
    short_sha: meta.short_sha,
    subject: meta.subject,
    body: meta.body,
    author_name: meta.author_name,
    author_email: meta.author_email,
    author_date: meta.author_date,
    committer_name: meta.committer_name,
    committer_email: meta.committer_email,
    committer_date: meta.committer_date,
    parents: meta.parents,
    files,
    diff: { changes },
  };

  return { commit };
}

// ---------------------------------------------------------------------------
// Internal helpers (exported for testing)
// ---------------------------------------------------------------------------

interface CommitMeta {
  sha: string;
  short_sha: string;
  subject: string;
  body: string;
  author_name: string;
  author_email: string;
  author_date: string;
  committer_name: string;
  committer_email: string;
  committer_date: string;
  parents: string[];
}

/**
 * Parse the NUL-delimited metadata output from git show -s.
 *
 * Fields: %H %h %s %b %an %ae %ad %cn %ce %cd %P
 * The body (%b) may contain newlines, so we split on NUL from the left
 * for the first 3 fields, then from the right for the last 7 fields,
 * and everything in between is the body.
 */
export function parseMetadata(raw: string): CommitMeta {
  // Split on NUL
  const parts = raw.split("\0");

  // We expect exactly 11 fields: sha, short_sha, subject, body, an, ae, ad, cn, ce, cd, parents
  // However body (%b) might be empty or contain no NULs, so we should have 11 parts
  if (parts.length < 11) {
    // Body might be empty — if we have exactly 10, body is empty
    if (parts.length === 10) {
      const [sha, short_sha, subject, author_name, author_email, author_date,
        committer_name, committer_email, committer_date, parentsRaw] = parts;
      return {
        sha, short_sha, subject, body: "",
        author_name, author_email, author_date,
        committer_name, committer_email, committer_date,
        parents: parseParents(parentsRaw),
      };
    }
    throw new Error("Unexpected git show output format");
  }

  // Normal case: 11+ parts. First 3 are sha, short_sha, subject.
  // Last 7 are an, ae, ad, cn, ce, cd, parents.
  // Everything in between (index 3 to length-7) is body (joined by NUL in case body had NUL somehow).
  const sha = parts[0];
  const short_sha = parts[1];
  const subject = parts[2];
  const parentsRaw = parts[parts.length - 1];
  const committer_date = parts[parts.length - 2];
  const committer_email = parts[parts.length - 3];
  const committer_name = parts[parts.length - 4];
  const author_date = parts[parts.length - 5];
  const author_email = parts[parts.length - 6];
  const author_name = parts[parts.length - 7];

  // Body is everything between index 3 and length-7
  const bodyParts = parts.slice(3, parts.length - 7);
  const body = bodyParts.join("\0").trim();

  return {
    sha, short_sha, subject, body,
    author_name, author_email, author_date,
    committer_name, committer_email, committer_date,
    parents: parseParents(parentsRaw),
  };
}

function parseParents(raw: string): string[] {
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed.split(" ") : [];
}

/**
 * Parse `git show --name-status --pretty=format:` output.
 *
 * Each non-empty line: <status>\t<path> (or <status>\t<old>\t<new> for renames)
 */
export function parseNameStatus(raw: string): FileStatus[] {
  const files: FileStatus[] = [];
  const lines = raw.split("\n").filter((l) => l.length > 0);

  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 2) continue;

    const statusCode = parts[0].trim();
    // For renames/copies (R100, C100), use the new path
    const path = parts.length >= 3 ? parts[2] : parts[1];
    files.push({ path, status: showStatusCodeToLabel(statusCode) });
  }

  return files;
}

/**
 * Map git status codes to human-readable labels.
 * Consistent with status.ts.
 */
export function showStatusCodeToLabel(code: string): string {
  // Handle R100, C100 etc — take just the letter
  const letter = code[0];
  switch (letter) {
    case "M": return "modified";
    case "A": return "added";
    case "D": return "deleted";
    case "R": return "renamed";
    case "C": return "copied";
    case "U": return "unmerged";
    case "T": return "typechange";
    default: return code;
  }
}
