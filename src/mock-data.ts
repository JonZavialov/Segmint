/**
 * Deterministic mock data for the Segmint MCP skeleton.
 */

import type { Change, ChangeGroup, CommitPlan, PullRequestDraft } from "./models.js";

export const MOCK_CHANGES: Change[] = [
  {
    id: "change-1",
    file_path: "src/auth/login.ts",
    hunks: [
      {
        old_start: 10,
        old_lines: 3,
        new_start: 10,
        new_lines: 5,
        header: "@@ -10,3 +10,5 @@ export function login()",
        lines: [
          " import { hash } from './utils';",
          "-function validate(token: string) {",
          "+function validate(token: string, expiry: number) {",
          "+  if (Date.now() > expiry) throw new Error('expired');",
          "   return verify(token);",
        ],
      },
    ],
  },
  {
    id: "change-2",
    file_path: "src/api/routes.ts",
    hunks: [
      {
        old_start: 25,
        old_lines: 2,
        new_start: 25,
        new_lines: 4,
        header: "@@ -25,2 +25,4 @@ router.get('/health')",
        lines: [
          " router.get('/health', healthCheck);",
          "+router.post('/auth/refresh', refreshToken);",
          "+router.delete('/auth/logout', logout);",
          " export default router;",
        ],
      },
    ],
  },
];

export const MOCK_CHANGE_GROUPS: ChangeGroup[] = [
  {
    id: "group-1",
    change_ids: ["change-1"],
    summary: "Add token expiry validation to login flow",
  },
  {
    id: "group-2",
    change_ids: ["change-2"],
    summary: "Add auth refresh and logout API routes",
  },
];

export const MOCK_COMMIT_PLANS: CommitPlan[] = [
  {
    id: "commit-1",
    title: "feat(auth): add token expiry validation",
    description:
      "Extends the validate function to accept an expiry timestamp and throw if the token has expired.",
    change_group_ids: ["group-1"],
  },
  {
    id: "commit-2",
    title: "feat(api): add refresh and logout endpoints",
    description:
      "Registers POST /auth/refresh and DELETE /auth/logout routes on the API router.",
    change_group_ids: ["group-2"],
  },
];

export const MOCK_PR_DRAFT: PullRequestDraft = {
  title: "Auth token expiry and session management",
  description:
    "Adds token expiry validation to the login flow and introduces refresh/logout API endpoints for complete session management.",
  commits: MOCK_COMMIT_PLANS,
};
