#!/usr/bin/env python3
"""Flywheel Orchestrator Dashboard — localhost HTTP server rendering agent state from SQLite."""

import argparse
import html
import os
import sqlite3
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import unquote

_default_db = str(Path(os.environ.get("SHARED_STATE_DIR", str(Path.home() / ".flywheel" / "orchestrator"))) / "agent-state.db")
DB_PATH = os.environ.get("ORCHESTRATOR_DB", os.environ.get("DB_PATH", _default_db))
STATUS_ICONS = {
    "spawned": "\U0001f535",      # blue
    "running": "\U0001f7e2",      # green
    "awaiting_approval": "\U0001f7e1",  # yellow
    "shipping": "\U0001f7e0",     # orange
    "completed": "\u2705",        # check
    "failed": "\u274c",           # cross
    "stopped": "\u26d4",          # no entry
}


def _query(sql, params=()):
    con = sqlite3.connect(DB_PATH, timeout=5)
    con.row_factory = sqlite3.Row
    try:
        return con.execute(sql, params).fetchall()
    finally:
        con.close()


def _esc(val):
    return html.escape(str(val)) if val is not None else ""


def _page(title, body):
    return f"""<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="10">
<title>{_esc(title)}</title>
<style>
  body {{ font-family: -apple-system, BlinkMacSystemFont, sans-serif; margin: 2rem; background: #0d1117; color: #c9d1d9; }}
  h1 {{ color: #58a6ff; }} h2 {{ color: #79c0ff; }}
  a {{ color: #58a6ff; text-decoration: none; }} a:hover {{ text-decoration: underline; }}
  table {{ border-collapse: collapse; width: 100%; margin: 1rem 0; }}
  th, td {{ text-align: left; padding: 0.5rem 0.75rem; border: 1px solid #30363d; }}
  th {{ background: #161b22; color: #8b949e; font-size: 0.85rem; text-transform: uppercase; }}
  tr:hover {{ background: #161b22; }}
  nav {{ margin-bottom: 1.5rem; font-size: 0.9rem; }}
  nav a {{ margin-right: 1rem; }}
  .badge {{ padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.8rem; }}
  .pending {{ background: #30363d; }} .in_progress {{ background: #1f6feb; color: #fff; }}
  .completed {{ background: #238636; color: #fff; }} .skipped {{ background: #6e7681; }}
  .failed {{ background: #da3633; color: #fff; }}
  .muted {{ color: #6e7681; }}
  .agent-card {{ background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1rem; }}
  .agent-header {{ display: flex; gap: 1rem; align-items: center; flex-wrap: wrap; }}
  .agent-current {{ margin: 0.5rem 0 0.4rem; font-size: 0.9rem; }}
  .progress-bar-bg {{ background: #30363d; border-radius: 4px; height: 6px; margin: 0.4rem 0; }}
  .progress-bar-fill {{ background: #238636; height: 100%; border-radius: 4px; transition: width 0.3s; }}
  .step-list {{ margin-top: 0.4rem; line-height: 1.8; }}
</style>
</head><body>
<nav><a href="/">Overview</a><a href="/history">History</a><a href="/templates">Templates</a></nav>
<h1>{_esc(title)}</h1>
{body}
</body></html>"""


def _fmt_duration(minutes):
    if minutes is None:
        return ""
    m = int(minutes)
    if m < 60:
        return f"{m}m"
    return f"{m // 60}h{m % 60:02d}m"


def _step_progress(agent_id):
    steps = _query(
        "SELECT * FROM agent_steps WHERE agent_id = ? ORDER BY step_order ASC;",
        (agent_id,),
    )
    if not steps:
        return '<span class="muted">No steps.</span>'

    items = ""
    for s in steps:
        cls = s["status"]
        if s["is_aggregate"]:
            continue
        key = _esc(s["step_key"])
        name = _esc(s["step_name"])
        items += f'<span class="badge {cls}" style="margin:0 2px;">{key} {name}</span> '
    return items


def overview():
    if not Path(DB_PATH).exists():
        return _page("Dashboard", "<p>No database found.</p>")

    rows = _query("""
        SELECT a.id, a.domain, a.version, a.status, a.pr_number, a.issue_id,
            s.step_key, s.step_name,
            CAST((julianday('now') - julianday(a.spawned_at)) * 1440 AS INTEGER) AS minutes_elapsed
        FROM agents a
        LEFT JOIN (
            SELECT agent_id, step_key, step_name,
                ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY step_order ASC) AS rn
            FROM agent_steps
            WHERE is_aggregate = 0 AND status NOT IN ('completed', 'skipped')
        ) s ON a.id = s.agent_id AND s.rn = 1
        WHERE a.status NOT IN ('completed', 'failed', 'stopped')
        ORDER BY a.spawned_at DESC;
    """)
    active_count = len(rows)

    completed = _query("SELECT count(*) as c FROM agents WHERE status IN ('completed','failed','stopped');")
    done_count = completed[0]["c"] if completed else 0

    cards = ""
    for r in rows:
        icon = STATUS_ICONS.get(r["status"], "")
        step = f'{_esc(r["step_key"])} {_esc(r["step_name"])}' if r["step_key"] else '<span class="muted">--</span>'
        issue = _esc(r["issue_id"] or "")
        pr = f'#{r["pr_number"]}' if r["pr_number"] else ""
        progress = _step_progress(r["id"])

        step_stats = _query(
            "SELECT COUNT(*) as total, SUM(CASE WHEN status IN ('completed','skipped') THEN 1 ELSE 0 END) as done FROM agent_steps WHERE agent_id = ? AND is_aggregate = 0;",
            (r["id"],),
        )
        done_n = step_stats[0]["done"] if step_stats else 0
        total_n = step_stats[0]["total"] if step_stats else 0
        pct = int(done_n / total_n * 100) if total_n > 0 else 0

        cards += f"""<div class="agent-card">
            <div class="agent-header">
                <a href="/agent/{_esc(r['id'])}"><strong>{_esc(r['id'])}</strong></a>
                <span class="muted">{issue} &middot; {_esc(r['version'])}</span>
                <span>{icon} {_esc(r['status'])}</span>
                <span class="muted">{_fmt_duration(r['minutes_elapsed'])}</span>
                {f'<span>{pr}</span>' if pr else ''}
            </div>
            <div class="agent-current">Now: <strong>{step}</strong></div>
            <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:{pct}%"></div></div>
            <div class="step-list">{progress}</div>
            <div class="muted" style="font-size:0.8rem;margin-top:0.3rem;">{done_n}/{total_n} steps ({pct}%)</div>
        </div>"""

    if not cards:
        cards = '<p class="muted">No active agents.</p>'

    body = f"""<p>Active: <strong>{active_count}</strong> | Completed: <strong>{done_count}</strong> | Auto-refresh: 10s</p>
    {cards}"""
    return _page("Flywheel Orchestrator Dashboard", body)


def agent_detail(agent_id):
    agents = _query("SELECT * FROM agents WHERE id = ?;", (agent_id,))
    if not agents:
        return _page("Not Found", f"<p>Agent <code>{_esc(agent_id)}</code> not found.</p>")

    a = agents[0]
    icon = STATUS_ICONS.get(a["status"], "")

    steps = _query("SELECT * FROM agent_steps WHERE agent_id = ? ORDER BY step_order ASC;", (agent_id,))
    step_rows = ""
    for s in steps:
        cls = s["status"]
        indent = "&nbsp;&nbsp;&nbsp;&nbsp;" if not s["is_aggregate"] else ""
        weight = "font-weight:bold;" if s["is_aggregate"] else ""
        notes = f' <span class="muted">({_esc(s["notes"])})</span>' if s["notes"] else ""
        step_rows += f'<tr><td>{indent}<span style="{weight}">{_esc(s["step_key"])}</span></td><td style="{weight}">{_esc(s["step_name"])}</td><td><span class="badge {cls}">{_esc(s["status"])}</span></td><td class="muted">{_esc(s["started_at"] or "")}</td><td class="muted">{_esc(s["completed_at"] or "")}</td><td>{notes}</td></tr>'

    artifacts = _query("SELECT * FROM artifacts WHERE agent_id = ? ORDER BY created_at ASC;", (agent_id,))
    art_rows = ""
    for ar in artifacts:
        art_rows += f'<tr><td>{_esc(ar["artifact_type"])}</td><td>{_esc(ar["value"])}</td><td class="muted">{_esc(ar["metadata"] or "")}</td><td class="muted">{_esc(ar["created_at"])}</td></tr>'

    error_section = f'<p style="color:#da3633;"><strong>Error:</strong> {_esc(a["error_message"])}</p>' if a["error_message"] else ""

    body = f"""
    <p>{icon} <strong>{_esc(a['status'])}</strong> | Issue: {_esc(a['issue_id'] or 'N/A')} | Version: {_esc(a['version'])} | Branch: <code>{_esc(a['branch'])}</code></p>
    <p>Plan: <code>{_esc(a['plan_file'] or 'N/A')}</code></p>
    <p>Worktree: <code>{_esc(a['worktree_path'] or 'N/A')}</code></p>
    <p>Spawned: {_esc(a['spawned_at'])} | Completed: {_esc(a['completed_at'] or '--')}</p>
    {error_section}
    <h2>Steps</h2>
    <table><thead><tr><th>Key</th><th>Step</th><th>Status</th><th>Started</th><th>Completed</th><th>Notes</th></tr></thead><tbody>{step_rows or '<tr><td colspan="6" class="muted">No steps.</td></tr>'}</tbody></table>
    <h2>Artifacts</h2>
    <table><thead><tr><th>Type</th><th>Value</th><th>Metadata</th><th>Created</th></tr></thead><tbody>{art_rows or '<tr><td colspan="4" class="muted">No artifacts.</td></tr>'}</tbody></table>"""
    return _page(f"Agent: {agent_id}", body)


def history_page():
    rows = _query("""
        SELECT a.id, a.domain, a.version, a.status, a.pr_number, a.issue_id, a.error_message,
            CAST((julianday(COALESCE(a.completed_at, 'now')) - julianday(a.spawned_at)) * 1440 AS INTEGER) AS total_minutes,
            a.spawned_at, a.completed_at
        FROM agents a
        WHERE a.status IN ('completed', 'failed', 'stopped')
        ORDER BY a.completed_at DESC;
    """)
    trs = ""
    for r in rows:
        icon = STATUS_ICONS.get(r["status"], "")
        err = f' <span title="{_esc(r["error_message"])}">&#9888;</span>' if r["error_message"] else ""
        trs += f'<tr><td><a href="/agent/{_esc(r["id"])}">{_esc(r["id"])}</a></td><td>{_esc(r["issue_id"] or "")}</td><td>{_esc(r["version"])}</td><td>{icon} {_esc(r["status"])}{err}</td><td>{_fmt_duration(r["total_minutes"])}</td><td class="muted">{_esc(r["spawned_at"])}</td><td class="muted">{_esc(r["completed_at"] or "")}</td></tr>'

    if not trs:
        trs = '<tr><td colspan="7" class="muted">No history.</td></tr>'

    body = f"""<table><thead><tr><th>ID</th><th>Issue</th><th>Version</th><th>Status</th><th>Duration</th><th>Spawned</th><th>Completed</th></tr></thead><tbody>{trs}</tbody></table>"""
    return _page("Agent History", body)


def templates_page():
    rows = _query("SELECT * FROM step_templates ORDER BY agent_type, step_order;")
    trs = ""
    for r in rows:
        agg = "Yes" if r["is_aggregate"] else ""
        trs += f'<tr><td>{_esc(r["agent_type"])}</td><td>{_esc(r["step_key"])}</td><td>{_esc(r["step_name"])}</td><td>{r["step_order"]}</td><td>{agg}</td></tr>'
    body = f"""<table><thead><tr><th>Agent Type</th><th>Step Key</th><th>Step Name</th><th>Order</th><th>Aggregate</th></tr></thead><tbody>{trs}</tbody></table>"""
    return _page("Step Templates", body)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        path = unquote(self.path).rstrip("/") or "/"
        try:
            if path == "/":
                content = overview()
            elif path.startswith("/agent/"):
                content = agent_detail(path[7:])
            elif path == "/history":
                content = history_page()
            elif path == "/templates":
                content = templates_page()
            else:
                self.send_response(404)
                self.end_headers()
                self.wfile.write(b"Not Found")
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(content.encode())
        except Exception as e:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(f"Internal error: {e}".encode())

    def log_message(self, fmt, *args):
        pass


def main():
    global DB_PATH
    parser = argparse.ArgumentParser(description="Flywheel Orchestrator Dashboard")
    parser.add_argument("--port", type=int, default=int(os.environ.get("DASHBOARD_PORT", 9474)))
    parser.add_argument("--db", type=str, default=DB_PATH, help="Path to agent-state.db")
    args = parser.parse_args()
    DB_PATH = args.db

    server = HTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Dashboard running at http://localhost:{args.port}")
    print(f"Database: {DB_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.")
        server.server_close()


if __name__ == "__main__":
    main()
