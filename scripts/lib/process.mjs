// Process helpers — alive checks and process-group-aware termination.

// PID validation: must be a positive integer > 1. We reject:
//  - 0 (POSIX: signal to process group of caller — never useful here)
//  - 1 (init/launchd — kill -1 here would mean kill(-1,...) which BROADCASTS
//       SIGTERM to all processes the user owns, taking down the session)
//  - non-integers, NaN, strings, negatives
export function isValidPid(pid) {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1;
}

export function isAlive(pid) {
  if (!isValidPid(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Send SIGTERM to the process group (negative PID), fall back to PID-only kill.
// After the grace window, escalate to SIGKILL.
export function terminateProcessTree(pid, { graceMs = 2000 } = {}) {
  if (!isValidPid(pid) || !isAlive(pid)) return;
  let groupKilled = false;
  try {
    process.kill(-pid, "SIGTERM");
    groupKilled = true;
  } catch {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
  setTimeout(() => {
    if (isAlive(pid)) {
      if (groupKilled) {
        try { process.kill(-pid, "SIGKILL"); } catch {
          try { process.kill(pid, "SIGKILL"); } catch {}
        }
      } else {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
  }, graceMs);
}
