/**
 * Cross-platform clean script for Segmint.
 *
 * Removes build/ and coverage/ directories to ensure fresh compilation
 * without stale artifacts from deleted source files.
 *
 * Usage: node scripts/clean.mjs
 */

import { rmSync } from "node:fs";

const dirs = ["build", "coverage"];

for (const dir of dirs) {
  rmSync(dir, { recursive: true, force: true });
}
