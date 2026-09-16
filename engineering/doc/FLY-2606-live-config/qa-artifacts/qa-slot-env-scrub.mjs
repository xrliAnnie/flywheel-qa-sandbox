// Scrub production coordinates from this process before touching anything.
export function scrubToSlot(slot) {
  const drop = [
    "TMUX","TMUX_PANE","CODEX_HOME","FLYWHEEL_COMM_DB","FLYWHEEL_STATE_DIR",
    "FLYWHEEL_RUNNER_STATE_DIR","FLYWHEEL_COMM_ROOT","FLYWHEEL_BRIDGE_URL",
    "FLYWHEEL_INGEST_TOKEN","FLYWHEEL_CALLBACK_TOKEN","FLYWHEEL_CALLBACK_PORT",
    "FLYWHEEL_EXEC_ID","FLYWHEEL_LEAD_ID","FLYWHEEL_PROJECT_NAME","FLYWHEEL_ISSUE_ID",
    "FLYWHEEL_AGENT_BACKEND","FLYWHEEL_WORKFLOW_SUBMISSION_CREDENTIAL",
    "FLYWHEEL_WORKFLOW_SUBMISSION_EXPECTED","FLYWHEEL_COMM_CLI",
  ];
  for (const k of drop) delete process.env[k];
  process.env.TMPDIR = `${slot}/tmp`;
  process.env.TMUX_TMPDIR = `${slot}/tmux`;
  process.env.FLYWHEEL_STATE_DIR = `${slot}/state`;
  process.env.FLYWHEEL_RUNNER_STATE_DIR = `${slot}/runner-state`;
  process.env.FLYWHEEL_COMM_DB = `${slot}/state/comm.db`;
  process.env.FLYWHEEL_CODEX_HOMES_ROOT = `${slot}/state/codex-homes`;
  process.env.FLYWHEEL_CODEX_SESSION_DIR = `${slot}/state/codex-sessions`;
  process.env.FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT = `${slot}/state/cdx-sock`;
  const bad = Object.entries(process.env).filter(([k, v]) =>
    /^(FLYWHEEL_|CODEX|TMUX|TMPDIR)/.test(k) &&
    typeof v === "string" && v.startsWith("/Users/xiaorongli/.flywheel"));
  if (bad.length) throw new Error("slot env preflight failed: " + JSON.stringify(bad));
  return Object.fromEntries(Object.entries(process.env).filter(([k]) =>
    /^(FLYWHEEL_|CODEX|TMUX|TMPDIR)/.test(k)));
}
