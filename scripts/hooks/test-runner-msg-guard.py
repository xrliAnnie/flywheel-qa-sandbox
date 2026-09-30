#!/usr/bin/env python3
"""Test suite for flywheel-runner-msg-guard.py PreToolUse hook (FLY-3083).

Usage: python3 scripts/hooks/test-runner-msg-guard.py

Covers: must-deny Runner names (incl. same-inbox aliases), broadcast `*`,
protocol-object messages; must-allow non-Runner names and distinct inboxes;
fail-open judgment path; the env switch / non-Lead session; the deny output
schema; the audit-log invariant (unwritable log still denies); and a byte-exact
round-trip of the replacement command through a stub FLYWHEEL_COMM_CLI.

The native-inbox equivalence itself is pinned by the vitest oracle
packages/agent-team-transport/src/__tests__/fly3083-runner-alias-oracle.test.ts
(judged by the repo's getClaudeInboxPath, not by this hook's own regex).

Exit non-zero if any assertion fails.
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True  # don't litter scripts/hooks/ with __pycache__

import json  # noqa: E402
import os  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
from pathlib import Path  # noqa: E402

HOOK = Path(__file__).resolve().parent / "flywheel-runner-msg-guard.py"
LEAD = "flywheel-eng-lead"
# The long-body template's single line the Lead replaces with the verbatim body.
PASTE_LINE = "<<PASTE THE FULL MESSAGE HERE VERBATIM - no escaping>>"
CANON = "runner-42afa86c"

PASS = 0
FAIL = 0
TMP = tempfile.mkdtemp(prefix="fly3083-guard-test-")


def ok(name: str) -> None:
    global PASS
    PASS += 1
    print(f"  PASS {name}")


def bad(name: str, detail: str) -> None:
    global FAIL
    FAIL += 1
    print(f"  FAIL {name}: {detail}")


def base_env(**extra: str) -> dict:
    env = {k: v for k, v in os.environ.items()
           if k not in ("FLYWHEEL_RUNNER_MSG_GUARD", "FLYWHEEL_LEAD_ID",
                        "FLYWHEEL_COMM_CLI", "FLYWHEEL_RUNNER_MSG_GUARD_LOG")}
    env["FLYWHEEL_LEAD_ID"] = LEAD
    env["FLYWHEEL_RUNNER_MSG_GUARD_LOG"] = os.path.join(TMP, "guard.log")
    env.update(extra)
    return env


def run_hook(stdin_data, env=None) -> tuple[int, str, str]:
    if isinstance(stdin_data, (dict, list)):
        stdin_data = json.dumps(stdin_data)
    p = subprocess.run(
        [sys.executable, str(HOOK)],
        input=stdin_data, capture_output=True, text=True,
        env=env if env is not None else base_env(), timeout=30,
    )
    return p.returncode, p.stdout, p.stderr


def send_event(to, message="please rebase on main", **extra) -> dict:
    tool_input = {"to": to, "message": message}
    tool_input.update(extra)
    return {"session_id": "s1", "cwd": TMP, "hook_event_name": "PreToolUse",
            "tool_name": "SendMessage", "tool_input": tool_input}


def decision(stdout: str):
    if not stdout.strip():
        return None
    try:
        return json.loads(stdout)["hookSpecificOutput"]["permissionDecision"]
    except Exception:
        return "unparseable"


def reason_of(stdout: str) -> str:
    return json.loads(stdout)["hookSpecificOutput"]["permissionDecisionReason"]


def extract_command(reason: str) -> str | None:
    start = reason.find("```bash\n")
    if start < 0:
        return None
    end = reason.rindex("\n```")
    return reason[start + len("```bash\n"):end]


# ── T1 must-deny / must-allow matrix ─────────────────────────────────────────
MUST_DENY_RUNNER = [
    "runner-42afa86c", " runner-42afa86c ", "runner-42afa86c [3fa9c1]",
    "runner/42afa86c", "runner.42afa86c", "runner 42afa86c", "runner:42afa86c",
    "runner‐42afa86c", "Runner-42AFA86C", "RUNNER-42afa86c",
    "runner/42afa86c [3fa9c1]",
]
MUST_ALLOW = [
    "team-lead", "main", "flywheel-eng-lead", "runner-42afa86c-extra",
    "runner.42afa86c.extra", "runner--42afa86c", "runner\U0001F60042afa86c",
    "runner\U0001000042afa86c", "worker [3fa9c1]", "runner-42afa86",
]


def t1_matrix() -> None:
    for to in MUST_DENY_RUNNER:
        code, out, err = run_hook(send_event(to))
        if code == 0 and decision(out) == "deny":
            cmd = extract_command(reason_of(out))
            if cmd and f"--to {CANON} " in cmd:
                ok(f"T1 deny {to!r} → --to {CANON}")
            else:
                bad(f"T1 deny {to!r}", f"command lacks canonical --to: {cmd!r}")
        else:
            bad(f"T1 deny {to!r}", f"exit={code} decision={decision(out)} err={err[-200:]}")
    for to in MUST_ALLOW:
        code, out, err = run_hook(send_event(to))
        if code == 0 and out == "":
            ok(f"T1 allow {to!r}")
        else:
            bad(f"T1 allow {to!r}", f"exit={code} stdout={out[:200]!r}")


# ── T2 broadcast: always denied in a Flywheel Lead session, no roster read ──
def t2_broadcast() -> None:
    cfg = os.path.join(TMP, "claude-config")
    team_dir = os.path.join(cfg, "teams", LEAD)
    os.makedirs(team_dir, exist_ok=True)
    roster = os.path.join(team_dir, "config.json")
    fixtures = {
        "roster-with-runner": json.dumps({"members": [{"name": CANON}]}),
        "roster-without-runner": json.dumps({"members": [{"name": "team-lead"}]}),
        "roster-bad-json": "{not json",
        "roster-missing": None,
    }
    for label, content in fixtures.items():
        if content is None:
            if os.path.exists(roster):
                os.remove(roster)
        else:
            with open(roster, "w") as fh:
                fh.write(content)
        for to in ("*", " * "):
            code, out, _ = run_hook(send_event(to), base_env(CLAUDE_CONFIG_DIR=cfg))
            if code == 0 and decision(out) == "deny":
                reason = reason_of(out)
                if re.search(r"runner-[0-9a-f]{8}", reason):
                    bad(f"T2 broadcast {label} {to!r}", "reason names a concrete runner")
                elif "<runner-" not in reason:
                    bad(f"T2 broadcast {label} {to!r}", "reason lacks the per-Runner template")
                else:
                    ok(f"T2 broadcast {label} {to!r} denied with template")
            else:
                bad(f"T2 broadcast {label} {to!r}", f"exit={code} decision={decision(out)}")
    # non-Lead session: broadcast passes untouched
    env = base_env()
    env.pop("FLYWHEEL_LEAD_ID")
    code, out, _ = run_hook(send_event("*"), env)
    if code == 0 and out == "":
        ok("T2 broadcast allowed outside a Flywheel Lead session")
    else:
        bad("T2 broadcast non-Lead", f"exit={code} stdout={out[:200]!r}")


# ── T3 protocol-object message: deny, no command ────────────────────────────
def t3_protocol_object() -> None:
    for msg in ({"type": "shutdown_request"}, {"type": "plan_approval_response", "approve": True}):
        code, out, _ = run_hook(send_event(CANON, message=msg))
        if code == 0 and decision(out) == "deny":
            reason = reason_of(out)
            if extract_command(reason) is None and "协议" in reason:
                ok(f"T3 protocol object {msg['type']} denied without a command")
            else:
                bad(f"T3 protocol {msg['type']}", f"reason={reason[:300]!r}")
        else:
            bad(f"T3 protocol {msg['type']}", f"exit={code} decision={decision(out)}")


# ── T4 fail-open judgment path + switch + non-Lead ──────────────────────────
def t4_fail_open() -> None:
    cases = {
        "bad json": "{nope",
        "empty stdin": "",
        "json list": [],
        "non-SendMessage tool": {"tool_name": "Bash", "tool_input": {"command": "echo runner-42afa86c"}},
        "tool_input not dict": {"tool_name": "SendMessage", "tool_input": "x"},
        "to not str": {"tool_name": "SendMessage", "tool_input": {"to": 7, "message": "m"}},
        "missing to": {"tool_name": "SendMessage", "tool_input": {"message": "m"}},
        "empty object": {},
    }
    for label, data in cases.items():
        code, out, _ = run_hook(data)
        if code == 0 and out == "":
            ok(f"T4 fail-open {label}")
        else:
            bad(f"T4 fail-open {label}", f"exit={code} stdout={out[:200]!r}")
    code, out, _ = run_hook(send_event(CANON), base_env(FLYWHEEL_RUNNER_MSG_GUARD="0"))
    if code == 0 and out == "":
        ok("T4 FLYWHEEL_RUNNER_MSG_GUARD=0 allows")
    else:
        bad("T4 switch", f"stdout={out[:200]!r}")
    env = base_env()
    env.pop("FLYWHEEL_LEAD_ID")
    code, out, _ = run_hook(send_event(CANON), env)
    if code == 0 and out == "":
        ok("T4 no FLYWHEEL_LEAD_ID → not a Flywheel Lead session → allow")
    else:
        bad("T4 non-Lead", f"stdout={out[:200]!r}")
    code, out, _ = run_hook(send_event(CANON), base_env(FLYWHEEL_LEAD_ID=""))
    if code == 0 and out == "":
        ok("T4 empty FLYWHEEL_LEAD_ID → allow")
    else:
        bad("T4 empty lead id", f"stdout={out[:200]!r}")


# ── T5 deny schema + audit invariant ────────────────────────────────────────
def t5_schema_and_audit() -> None:
    log = os.path.join(TMP, "audit.log")
    code, out, _ = run_hook(send_event(CANON), base_env(FLYWHEEL_RUNNER_MSG_GUARD_LOG=log))
    obj = json.loads(out)
    hso = obj.get("hookSpecificOutput", {})
    if (list(obj) == ["hookSpecificOutput"]
            and set(hso) == {"hookEventName", "permissionDecision", "permissionDecisionReason"}
            and hso["hookEventName"] == "PreToolUse" and hso["permissionDecision"] == "deny"):
        ok("T5 deny output schema has exactly the three keys")
    else:
        bad("T5 schema", out[:300])
    try:
        lines = [json.loads(line) for line in Path(log).read_text().splitlines()]
        rec = lines[-1]
        if rec.get("kind") == "runner" and rec.get("canon") == CANON and "message" not in rec:
            ok("T5 audit line written (no message body)")
        else:
            bad("T5 audit line", json.dumps(rec)[:300])
    except Exception as exc:  # noqa: BLE001
        bad("T5 audit line", repr(exc))
    blocker = os.path.join(TMP, "a-file")
    Path(blocker).write_text("x")
    code, out, _ = run_hook(send_event(CANON),
                            base_env(FLYWHEEL_RUNNER_MSG_GUARD_LOG=os.path.join(blocker, "x.log")))
    if code == 0 and decision(out) == "deny":
        ok("T5 unwritable audit path still denies")
    else:
        bad("T5 unwritable audit", f"exit={code} decision={decision(out)}")


# ── T6 command round-trip through a stub CLI ─────────────────────────────────
BODIES = {
    "dollar var": "use $HOME and ${PATH}",
    "command subst": "run $(printf X) now",
    "backticks": "see `id` output",
    "mixed quotes": "it's a \"quoted\" 'thing'",
    "multi-line": "line one\nline two\n\n  indented three",
    "leading dashes": "--json is not a flag here",
    "unicode": "中文正文 ✓ 😀",
}


def t6_round_trip() -> None:
    stub = os.path.join(TMP, "stub-cli.js")
    argv_out = os.path.join(TMP, "argv.json")
    Path(stub).write_text(
        "require('fs').writeFileSync(process.env.STUB_ARGV_OUT,"
        " JSON.stringify(process.argv.slice(2)));\n")
    for label, body in BODIES.items():
        for to in (CANON, "runner/42afa86c [3fa9c1]"):
            env = base_env(FLYWHEEL_COMM_CLI=stub)
            code, out, _ = run_hook(send_event(to, message=body), env)
            cmd = extract_command(reason_of(out)) if decision(out) == "deny" else None
            if not cmd:
                bad(f"T6 {label} {to!r}", "no command in reason")
                continue
            if os.path.exists(argv_out):
                os.remove(argv_out)
            p = subprocess.run(["bash", "-c", cmd], capture_output=True, text=True,
                               env={**os.environ, "STUB_ARGV_OUT": argv_out}, timeout=30)
            try:
                argv = json.loads(Path(argv_out).read_text())
            except Exception as exc:  # noqa: BLE001
                bad(f"T6 {label} {to!r}", f"stub not run: {exc!r} stderr={p.stderr[-200:]}")
                continue
            want = ["send", "--from", LEAD, "--to", CANON, "--", body]
            if argv == want:
                ok(f"T6 round-trip {label} {to!r}")
            else:
                bad(f"T6 round-trip {label} {to!r}", f"argv={argv!r}")
    # >4000 chars: the body is NOT inlined; the template takes it verbatim in a
    # quoted heredoc (no escaping), then passes it via "$(cat file)" as ONE argv.
    # Code review R1 HIGH: pasting into a single-quoted placeholder broke quoting
    # and could execute body text — round-trip the COMPLETED template here.
    long_bodies = {
        "plain": "x" * 4001,
        "apostrophe": "x" * 4001 + " Don't restart.",
        "quote-break": "x" * 4001 + "'; printf REVIEW_BODY_EXECUTED; #",
        "metachars": "y" * 4001 + ' $(printf SUBST) `printf BT` "dq" \\ \n $HOME ) ( ; & |',
        "multi-line": ("z" * 2100 + "\n") * 2 + "last line with ' and \" and )",
    }
    for label, long_body in long_bodies.items():
        code, out, _ = run_hook(send_event(CANON, message=long_body),
                                base_env(FLYWHEEL_COMM_CLI=stub))
        reason = reason_of(out)
        tmpl = extract_command(reason) or ""
        if "过长" not in reason or long_body[:4001] in reason or "PASTE" not in tmpl:
            bad(f"T6 long {label}", "missing 过长 notice / body inlined / no paste line")
            continue
        filled = tmpl.replace(PASTE_LINE, long_body, 1)
        shells = ["bash"] + (["zsh"] if shutil.which("zsh") else [])
        for sh in shells:
            if os.path.exists(argv_out):
                os.remove(argv_out)
            p = subprocess.run([sh, "-c", filled], capture_output=True, text=True,
                               env={**os.environ, "STUB_ARGV_OUT": argv_out}, timeout=30)
            try:
                argv = json.loads(Path(argv_out).read_text())
            except Exception as exc:  # noqa: BLE001
                bad(f"T6 long {label} ({sh})", f"stub not run: {exc!r} rc={p.returncode} err={p.stderr[-200:]}")
                continue
            want = ["send", "--from", LEAD, "--to", CANON, "--", long_body]
            if argv == want and "EXECUTED" not in p.stdout and "SUBST" not in p.stdout and p.returncode == 0:
                ok(f"T6 long {label} ({sh}): completed template delivers the body byte-exact, nothing executed")
            else:
                bad(f"T6 long {label} ({sh})", f"rc={p.returncode} stdout={p.stdout[:120]!r} argv_tail={str(argv[-1:])[:120]!r}")
    exact = "y" * 4000
    code, out, _ = run_hook(send_event(CANON, message=exact), base_env(FLYWHEEL_COMM_CLI=stub))
    if exact in (extract_command(reason_of(out)) or ""):
        ok("T6 exactly 4000 chars keeps the full body")
    else:
        bad("T6 4000 boundary", "body missing")
    # CLI env missing → literal flywheel-comm fallback, lead id kept
    code, out, _ = run_hook(send_event(CANON))
    cmd = extract_command(reason_of(out)) or ""
    if cmd.startswith(f"flywheel-comm send --from {LEAD} --to {CANON} -- "):
        ok("T6 no FLYWHEEL_COMM_CLI → flywheel-comm fallback")
    else:
        bad("T6 fallback", cmd[:200])


# ── T7 reason tail + negative source guard ──────────────────────────────────
def t7_reason_and_source() -> None:
    code, out, _ = run_hook(send_event(CANON))
    reason = reason_of(out)
    for needle in ("respond", "transport_write", "SendMessage"):
        if needle in reason:
            ok(f"T7 reason mentions {needle}")
        else:
            bad(f"T7 reason {needle}", reason[-400:])
    src = HOOK.read_text()
    if "config.json" not in src and "members" not in src:
        ok("T7 hook source never reads the team roster")
    else:
        bad("T7 roster read", "hook source references the team roster")


def main() -> int:
    if not HOOK.exists():
        print(f"FAIL: hook not found at {HOOK}")
        return 1
    t1_matrix()
    t2_broadcast()
    t3_protocol_object()
    t4_fail_open()
    t5_schema_and_audit()
    t6_round_trip()
    t7_reason_and_source()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
