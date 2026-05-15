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
  try { process.kill(pid, 0); return true; }
  catch (e) {
    // EPERM means a process exists but we cannot signal it (different uid).
    // For liveness purposes that is "alive" — returning false here would
    // cause session-lifecycle-hook to reap a job owned by another user.
    if (e && e.code === "EPERM") return true;
    return false;
  }
}

// Send SIGTERM to the process group (negative PID), fall back to PID-only kill.
// After the grace window, escalate to SIGKILL. Returns a Promise that resolves
// after the SIGKILL escalation step — callers MUST await this before exiting,
// otherwise the timer is cancelled by process.exit and SIGKILL never fires.
//
// Liveness checks intentionally do NOT gate the group kill: a dead leader
// can still have surviving descendants in the same group. POSIX
// `kill(-pid, sig)` routes to all live members regardless of leader state,
// and ESRCH on an empty group is harmless. The previous "isAlive at top"
// guard caused descendants to leak whenever the leader exited on SIGTERM
// or was reaped before this function was called.
export function terminateProcessTree(pid, { graceMs = 2000, closedPromise } = {}) {
  if (!isValidPid(pid)) return Promise.resolve();
  // Always attempt the group SIGTERM first — even if the leader is already
  // dead, surviving group descendants need the signal. EPERM means the
  // group exists under a different uid (still tracked as alive elsewhere).
  // ESRCH means the group is empty; harmless.
  let groupKilled = false;
  try {
    process.kill(-pid, "SIGTERM");
    groupKilled = true;
  } catch {
    // Group kill failed — leader may not have been detached. Fall back to
    // direct pid kill, only if the leader itself is still alive.
    if (isAlive(pid)) {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
  }
  // Race the SIGKILL grace window against the optional `closedPromise`.
  // Callers that can observe the child's close event pass it in; we then
  // skip the full graceMs wait once the child has actually exited, since
  // SIGKILL on a dead leader is moot (and after the kernel reaps the pid
  // it would risk hitting a recycled pid). Callers that don't pass it
  // get the old behavior: wait full graceMs, then SIGKILL.
  return new Promise(resolve => {
    let resolved = false;
    const finish = () => { if (!resolved) { resolved = true; resolve(); } };
    const timer = setTimeout(() => {
      if (groupKilled) {
        // Sweep the whole group. Don't gate on leader liveness — surviving
        // descendants (auth helpers, sidecars gemini may have spawned) still
        // need the kill even after the leader exits on SIGTERM.
        try { process.kill(-pid, "SIGKILL"); } catch {
          // ESRCH is fine: group already empty. Fall back to direct pid
          // SIGKILL only if the leader itself is still alive.
          if (isAlive(pid)) {
            try { process.kill(pid, "SIGKILL"); } catch {}
          }
        }
      } else if (isAlive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
      finish();
    }, graceMs);
    if (closedPromise) {
      closedPromise.then(() => {
        // Child already exited on SIGTERM. Cancel the grace timer and
        // resolve immediately — SIGKILL is no longer needed for the
        // leader, and any group descendants will be swept by the natural
        // cascade since the leader's exit closes the controlling tty.
        clearTimeout(timer);
        finish();
      }, () => {});
    }
  });
}
