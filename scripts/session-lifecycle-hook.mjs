#!/usr/bin/env node
// Session lifecycle hook for Gemini Companion.
// Invoked by Claude Code on SessionStart and SessionEnd.
//
// SessionStart: prune dead jobs (orphan PIDs from a previous Claude run).
// SessionEnd:   mark any still-running jobs as "ended" so /gemini:status
//               doesn't lie. We do NOT kill running jobs here — the user
//               may have launched them deliberately as background tasks.

import { listJobs, writeJobMeta, pruneJobs } from "./lib/state.mjs";
import { isAlive } from "./lib/process.mjs";

const phase = process.argv[2] || "SessionStart";

function reapDeadJobs() {
  const all = listJobs();
  let reaped = 0;
  for (const j of all) {
    if (j.status === "running" && !isAlive(j.pid)) {
      j.status = "ended";
      j.ended_at = j.ended_at || new Date().toISOString();
      writeJobMeta(j.id, j);
      reaped++;
    }
  }
  return reaped;
}

try {
  const reaped = reapDeadJobs();
  pruneJobs();
  // The hook output is silent on success; log a one-line system message
  // only when something actually happened so users can see it in transcripts.
  if (reaped > 0) {
    process.stdout.write(JSON.stringify({
      systemMessage: `gemini-plugin: reaped ${reaped} orphaned job(s) on ${phase}`
    }) + "\n");
  }
  process.exit(0);
} catch (err) {
  // Never break the user's session because of cleanup.
  process.stderr.write(`gemini-plugin lifecycle (${phase}) error: ${err.message}\n`);
  process.exit(0);
}
