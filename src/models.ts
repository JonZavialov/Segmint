/**
 * Segmint canonical data models.
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

export interface ChangeGroup {
  id: string;
  change_ids: string[];
  summary: string;
}

export interface CommitPlan {
  id: string;
  title: string;
  description: string;
  change_group_ids: string[];
}

export interface PullRequestDraft {
  title: string;
  description: string;
  commits: CommitPlan[];
}
