/**
 * Segmint canonical data models.
 *
 * These are the core primitives of the semantic Git substrate.
 * Change and Hunk are the foundational layer — structured diffs
 * that agents operate on directly.
 */

export interface Hunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  header: string;
  lines: string[];
}

export interface Change {
  id: string;
  file_path: string;
  hunks: Hunk[];
}

// ---------------------------------------------------------------------------
// Tier 1: Read-only repo intelligence
// ---------------------------------------------------------------------------

export interface HeadInfo {
  type: "branch" | "detached";
  name?: string;
  sha?: string;
}

export interface FileStatus {
  path: string;
  status: string;
}

export interface LogCommit {
  sha: string;
  short_sha: string;
  subject: string;
  author_name: string;
  author_email: string;
  author_date: string;
  parents: string[];
}

export interface CommitDetail {
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
  files: FileStatus[];
  diff: { changes: Change[] };
}

export interface RepoStatus {
  is_git_repo: boolean;
  root_path: string;
  head: HeadInfo;
  staged: FileStatus[];
  unstaged: FileStatus[];
  untracked: string[];
  ahead_by?: number;
  behind_by?: number;
  upstream?: string;
  merge_in_progress: boolean;
  rebase_in_progress: boolean;
}

export interface BlameCommit {
  sha: string;
  short_sha: string;
  author_name: string;
  author_email: string;
  author_time: string;
  summary: string;
}

export interface BlameLine {
  line_number: number;
  content: string;
  commit: BlameCommit;
}

export interface BlameResult {
  path: string;
  ref: string;
  lines: BlameLine[];
}
