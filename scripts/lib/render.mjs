// Output rendering helpers for status and result.

export function fmtTime(s) {
  return s ? s.replace("T", " ").replace(/\..*/, "") : "-";
}

export function renderJobTable(jobs) {
  if (jobs.length === 0) return "No Gemini jobs in this workspace.";
  const lines = [
    "| Job | Kind | Status | Started | PID | Task |",
    "|-----|------|--------|---------|-----|------|"
  ];
  for (const j of jobs) {
    const task = (j.task_text || "").slice(0, 50).replace(/\|/g, "\\|");
    lines.push(
      `| ${j.id} | ${j.kind}${j.write ? " (w)" : ""} | ${j.status} | ${fmtTime(j.started_at)} | ${j.pid ?? "-"} | ${task} |`
    );
  }
  return lines.join("\n");
}

export function renderJobDetails(meta) {
  const lines = [];
  lines.push(`Job: ${meta.id}`);
  lines.push(`Kind: ${meta.kind}${meta.write ? " (write)" : ""}`);
  lines.push(`Status: ${meta.status}`);
  lines.push(`PID: ${meta.pid ?? "-"}`);
  lines.push(`Started: ${fmtTime(meta.started_at)}`);
  if (meta.ended_at) lines.push(`Ended: ${fmtTime(meta.ended_at)}`);
  if (meta.exit_code !== undefined) lines.push(`Exit: ${meta.exit_code}`);
  lines.push(`Task: ${meta.task_text || "-"}`);
  lines.push("");
  lines.push("Follow-up:");
  lines.push(`- /gemini:result ${meta.id}`);
  lines.push(`- /gemini:cancel ${meta.id}`);
  return lines.join("\n");
}
