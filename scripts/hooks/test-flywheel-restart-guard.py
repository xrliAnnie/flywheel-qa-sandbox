#!/usr/bin/env python3
"""Test suite for flywheel-restart-guard.py PreToolUse hook (FLY-913).

Usage: python3 scripts/hooks/test-flywheel-restart-guard.py

Covers the block-pattern matrix (must-block incident forms / must-pass legit
flow), the bypass accounting contract (audit + strict alert result, both
fail-closed), the deny-audit invariant (audit failure never flips a deny to
allow), robustness on malformed stdin (judgment path fail-open), and the deny
output schema.

Matrix goal (plan §4): 0 false positives INSIDE the enumerated matrix + 0
false negatives on the FLY-913 incident forms. Out-of-matrix research-shaped
false positives are accepted per plan §5 — not asserted here.

Exit non-zero if any assertion fails.
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True  # don't litter scripts/hooks/ with __pycache__

import importlib.util  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
import stat  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

HOOK = Path(__file__).resolve().parent / "flywheel-restart-guard.py"

PASS = 0
FAIL = 0


def ok(name: str) -> None:
    global PASS
    PASS += 1
    print(f"  PASS {name}")


def bad(name: str, detail: str) -> None:
    global FAIL
    FAIL += 1
    print(f"  FAIL {name}: {detail}")


def load_hook_module():
    spec = importlib.util.spec_from_file_location("flywheel_restart_guard", HOOK)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── End-to-end runner: feed stdin JSON, capture stdout/exit ──────────────────
def run_hook(stdin_data, env_extra=None, env_remove=()) -> tuple[int, str]:
    env = dict(os.environ)
    # Default isolation: audit log to a throwaway temp file unless the test
    # overrides it; alert cmd to /usr/bin/false so an unexpected bypass path
    # can never fire a real alert.
    env.setdefault("FLYWHEEL_RESTART_GUARD_LOG", os.path.join(
        tempfile.gettempdir(), f"restart-guard-test-{os.getpid()}.log"))
    env.setdefault("FLYWHEEL_RESTART_GUARD_ALERT_CMD", "/usr/bin/false")
    if env_extra:
        env.update(env_extra)
    for key in env_remove:
        env.pop(key, None)
    if isinstance(stdin_data, (dict, list)):
        stdin_data = json.dumps(stdin_data)
    p = subprocess.run(
        [sys.executable, str(HOOK)],
        input=stdin_data,
        capture_output=True,
        text=True,
        env=env,
        timeout=30,
    )
    return p.returncode, p.stdout


def bash_event(command: str) -> dict:
    return {
        "tool_name": "Bash",
        "tool_input": {"command": command},
        "session_id": "test-session",
        "cwd": "/Users/x/Dev/flywheel",
        "permission_mode": "default",
    }


def decision_of(stdout: str):
    """Return 'deny' if stdout carries a deny payload, 'allow' if empty."""
    if not stdout.strip():
        return "allow"
    try:
        data = json.loads(stdout)
    except json.JSONDecodeError:
        return f"unparseable:{stdout[:80]}"
    return data.get("hookSpecificOutput", {}).get("permissionDecision", "missing")


def deny_reason(stdout: str) -> str:
    try:
        return json.loads(stdout)["hookSpecificOutput"]["permissionDecisionReason"]
    except Exception:
        return ""


def jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


# ── T1: must-block matrix (incident forms, research §4) ─────────────────────
MUST_BLOCK = [
    # P1 — launchctl mutating subcommand + com.flywheel.
    (
        "launchctl submit -l com.flywheel.restart-bus-manual "
        "-o /tmp/restart.out -e /tmp/restart.err -- /bin/bash "
        "/Users/x/Dev/flywheel/scripts/restart-services.sh --force",
        "P1 incident submit restart bus",
    ),
    (
        "launchctl submit -l com.example.restart -- bash "
        "/Users/x/Dev/flywheel/scripts/restart-services.sh --force",
        "P1 submit label evasion still names restart-services",
    ),
    (
        'bash -c "launchctl submit -l com.flywheel.restart-bus -- '
        '/bin/bash /Users/x/Dev/flywheel/scripts/restart-services.sh"',
        "P1 nested submit restart bus",
    ),
    (
        "launchctl submit -l com.example.restart -- /bin/bash -c "
        "'FLYWHEEL_RESTART_FOREGROUND=1 bash "
        "/Users/x/Dev/flywheel/scripts/restart-services.sh'",
        "P1 submit foreground env payload",
    ),
    ("launchctl kickstart -k gui/501/com.flywheel.bridge", "P1 kickstart -k"),
    ("launchctl kickstart gui/$(id -u)/com.flywheel.lead.flywheel-flywheel-eng-lead",
     "P1 kickstart uid-var lead"),
    ("launchctl bootout gui/501/com.flywheel.lead.growth-mufasa-lead", "P1 bootout"),
    ("launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.flywheel.bridge.plist",
     "P1 bootstrap"),
    ("launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.flywheel.cmux-watcher.plist",
     "P1 cmux watcher bootstrap"),
    ("launchctl kill SIGTERM gui/501/com.flywheel.bridge", "P1 launchctl kill"),
    ("sudo launchctl unload ~/Library/LaunchAgents/com.flywheel.updater.plist",
     "P1 unload updater"),
    ("cd ~/Dev/flywheel && launchctl kickstart -k gui/501/com.flywheel.bridge",
     "P1 cd-prefixed"),
    ("bash scripts/restart-services.sh; launchctl bootout gui/501/com.flywheel.bridge",
     "P1 concatenated after legit flow"),
    # P2 — kill family + flywheel process identifier
    ("pgrep -f run-bridge | xargs kill -9", "P2 pgrep|xargs kill (FLY-176 form)"),
    ("pkill -f run-bridge", "P2 pkill run-bridge"),
    ("pkill -f claude-lead.sh", "P2 pkill claude-lead.sh (FLY-239 form)"),
    ("pkill -f restart-services.sh", "P2 pkill restart-services in-flight wave"),
    ("grep \"$(pkill -f restart-services.sh)\" /tmp/input",
     "P2 command substitution inside grep is executable"),
    ("rg --pre 'pkill -f restart-services.sh' pattern /tmp/input",
     "P2 rg preprocessor is executable"),
    (
        "rg --hostname-bin 'pkill -f run-bridge' pattern /tmp/input",
        "P2 rg hostname program is executable",
    ),
    (
        "rg --hostname-bin='pkill -f run-bridge' "
        "--hyperlink-format 'x://{host}' pattern /tmp/input",
        "P2 rg hostname program equals form is executable",
    ),
    ("grep harmless /tmp/input; pkill -f restart-services.sh",
     "P2 adjacent mutation is not hidden by read segment"),
    (
        "ps aux | grep run-bridge | awk '{print $2}' | xargs kill -9",
        "P2 grep pipeline preserves run-bridge identifier",
    ),
    (
        "ps aux | grep -v grep | grep run-bridge | awk '{print $2}' | xargs kill",
        "P2 chained grep pipeline preserves run-bridge identifier",
    ),
    (
        "ps aux | grep claude-lead.sh | grep -v grep | awk '{print $2}' "
        "| xargs kill -9",
        "P2 grep pipeline preserves claude-lead identifier",
    ),
    (
        "ps -ef | grep com.flywheel | awk '{print $2}' | xargs kill",
        "P2 grep pipeline preserves launchd label identifier",
    ),
    (
        "rg run-bridge /tmp/pslist | awk '{print $2}' | xargs kill -9",
        "P2 rg pipeline preserves run-bridge identifier",
    ),
    ("pkill -f flywheel-bridge-wrapper", "P2 pkill bridge wrapper"),
    ("killall node && npx tsx scripts/run-bridge.ts", "P2 killall + relaunch"),
    ("kill 1234 && nohup npx tsx scripts/run-bridge.ts &", "P2 kill+relaunch"),
    (
        "grep -l com.flywheel.bridge ~/Library/LaunchAgents/*.plist "
        "| xargs launchctl unload",
        "P1 grep pipeline preserves launchd label identifier",
    ),
    # P3 — bare-handed bridge launch via executor first token
    ("nohup npx tsx scripts/run-bridge.ts &", "P3 nohup npx tsx"),
    ("node scripts/run-bridge.ts", "P3 node direct"),
    ("npx tsx scripts/run-bridge.ts", "P3 npx tsx direct"),
    ("FLYWHEEL_BRIDGE_PORT=9999 node scripts/run-bridge.ts", "P3 env-prefixed node"),
    # P3 — wrapper-prefixed executor forms (Codex code review R1 HIGH: env /
    # sudo wrappers must not silently allow a bare-handed bridge relaunch)
    ("env node scripts/run-bridge.ts", "P3 env wrapper"),
    ("/usr/bin/env node scripts/run-bridge.ts", "P3 /usr/bin/env wrapper"),
    ("sudo -E node scripts/run-bridge.ts", "P3 sudo -E wrapper"),
    ("sudo FLYWHEEL_BRIDGE_PORT=9999 node scripts/run-bridge.ts",
     "P3 sudo + env-assign wrapper"),
    ("sudo -u xiaorongli npx tsx scripts/run-bridge.ts", "P3 sudo -u user wrapper"),
    ("env -i FLYWHEEL_X=1 nohup npx tsx scripts/run-bridge.ts &",
     "P3 env -i + nohup stack"),
    ('sudo bash -c "node scripts/run-bridge.ts"', "P3 sudo bash -c payload"),
    # Codex code review R2 MEDIUM: env -S/--split-string carries a whole
    # command line in ONE argument — must be scanned like a -c payload.
    ('env -S "node scripts/run-bridge.ts"', "P3 env -S payload"),
    ('/usr/bin/env -S "node scripts/run-bridge.ts"', "P3 /usr/bin/env -S payload"),
    ('env --split-string "node scripts/run-bridge.ts"', "P3 env --split-string payload"),
    ('env --split-string="node scripts/run-bridge.ts"', "P3 env --split-string= payload"),
    ('env -S"node scripts/run-bridge.ts"', "P3 env -S merged payload"),
    # Codex R3 MEDIUM: macOS env -P <utilpath> consumes a value — without
    # skipping it, /usr/bin masquerades as the first token.
    ("env -P /usr/bin node scripts/run-bridge.ts", "P3 env -P utilpath"),
    ("/usr/bin/env -P /usr/bin node scripts/run-bridge.ts", "P3 /usr/bin/env -P utilpath"),
    # Structural close of the unknown-consuming-flag class: even when a wrapper
    # flag we don't know swallows the token walk, wrapper + executor token +
    # run-bridge in one segment must still deny.
    ('sudo -p "pw:" node scripts/run-bridge.ts', "P3 sudo -p prompt (unknown arg flag)"),
    ("sudo --preserve-env=PATH node scripts/run-bridge.ts", "P3 sudo --preserve-env="),
    ("env -i -P /usr/bin npx tsx scripts/run-bridge.ts", "P3 env -i -P stacked"),
    # Codex R4 MEDIUM: shell/utility wrappers are equally transparent.
    ("command node scripts/run-bridge.ts", "P3 command wrapper"),
    ("exec node scripts/run-bridge.ts", "P3 exec wrapper"),
    ("time node scripts/run-bridge.ts", "P3 time wrapper"),
    ("nice node scripts/run-bridge.ts", "P3 nice wrapper"),
    ("nice -n 10 node scripts/run-bridge.ts", "P3 nice -n value (backstop)"),
    ("arch -x86_64 node scripts/run-bridge.ts", "P3 arch -x86_64 wrapper"),
    ("timeout 300 node scripts/run-bridge.ts", "P3 timeout duration (backstop)"),
    ("caffeinate -i npx tsx scripts/run-bridge.ts", "P3 caffeinate wrapper"),
    ('bash -lc "command node scripts/run-bridge.ts"', "P3 -c payload with command wrapper"),
    # Codex R5 MEDIUM: -S inside a short-option CLUSTER (env -iS "…").
    ('env -iS "node scripts/run-bridge.ts"', "P3 env -iS cluster payload"),
    ('env -iS"npx tsx scripts/run-bridge.ts"', "P3 env -iS attached cluster payload"),
    ('/usr/bin/env -iS "node scripts/run-bridge.ts"', "P3 /usr/bin/env -iS cluster"),
    # Codex R5 MEDIUM: package-manager exec forms of the same tsx entrypoint.
    ("pnpm tsx scripts/run-bridge.ts", "P3 pnpm tsx"),
    ("pnpm exec tsx scripts/run-bridge.ts", "P3 pnpm exec tsx"),
    ("npm exec tsx scripts/run-bridge.ts", "P3 npm exec tsx"),
    ("yarn tsx scripts/run-bridge.ts", "P3 yarn tsx"),
    ("pnpx tsx scripts/run-bridge.ts", "P3 pnpx tsx"),
    ("sudo pnpm exec tsx scripts/run-bridge.ts", "P3 sudo pnpm exec tsx"),
    # Codex R6 MEDIUM (final closed list): bunx + corepack shim.
    ("bunx tsx scripts/run-bridge.ts", "P3 bunx"),
    ("corepack pnpm tsx scripts/run-bridge.ts", "P3 corepack pnpm tsx"),
    ("corepack pnpm exec tsx scripts/run-bridge.ts", "P3 corepack pnpm exec tsx"),
    ("corepack yarn tsx scripts/run-bridge.ts", "P3 corepack yarn tsx"),
    ("corepack yarn dlx tsx scripts/run-bridge.ts", "P3 corepack yarn dlx tsx"),
    # P3 — shell -c payload recursion (one level), incl. merged flag clusters
    ('bash -c "nohup npx tsx scripts/run-bridge.ts"', "P3 bash -c payload"),
    ("sh -c 'npx tsx scripts/run-bridge.ts'", "P3 sh -c payload"),
    ('zsh -lc "node scripts/run-bridge.ts"', "P3 zsh -lc merged flag cluster"),
    ('bash -lec "npx tsx scripts/run-bridge.ts"', "P3 bash -lec cluster"),
    # P4 — persistent scheduler payload that can repeatedly start a restart.
    (
        "echo '* * * * * bash /Users/x/Dev/flywheel/scripts/restart-services.sh --force' "
        "| crontab -",
        "P4 crontab restart-services payload",
    ),
    (
        "crontab -l; echo '* * * * * bash scripts/restart-services.sh' | crontab -",
        "P4 list followed by crontab write",
    ),
    # pseudo-bypass forms must stay on the deny path (Codex R1 #4)
    ("echo FLYWHEEL_RESTART_GUARD_BYPASS=x; launchctl kickstart -k gui/501/com.flywheel.bridge",
     "pseudo-bypass echo prefix"),
    ("# FLYWHEEL_RESTART_GUARD_BYPASS=x\nlaunchctl kickstart -k gui/501/com.flywheel.bridge",
     "pseudo-bypass comment prefix"),
    ("FLYWHEEL_RESTART_GUARD_BYPASS= launchctl kickstart -k gui/501/com.flywheel.bridge",
     "pseudo-bypass empty reason"),
]

# ── T2: must-pass matrix (legit flow + reads + unrelated ops) ────────────────
MUST_PASS = [
    ("bash scripts/request-restart.sh", "default updater-backed restart request"),
    ("bash scripts/restart-services.sh", "legit restart-services relative"),
    ("bash ~/Dev/flywheel/scripts/restart-services.sh --force", "legit --force"),
    ("bash /Users/x/.flywheel/bin/restart-services.sh --dry-run", "legit deployed copy --dry-run"),
    ("RESTART_MAX_WAIT=60 bash scripts/restart-services.sh", "legit env-prefixed"),
    # FLY-1142: the sanctioned env-reload path must never be guard-blocked —
    # it IS the alternative the deny message points operators to.
    ("bash scripts/restart-services.sh --reason env-change",
     "legit unified env-change restart (FLY-1434)"),
    ("bash ~/Dev/flywheel/scripts/restart-services.sh --reason manual --dry-run",
     "legit unified dry-run (FLY-1434)"),
    ("bash ~/Dev/flywheel/scripts/restart-services.sh --reason deploy --force",
     "legit unified forced restart (FLY-1434)"),
    ("bash scripts/update-flywheel.sh", "legit updater"),
    ("bash ~/.flywheel/bin/flywheel-cmux-autostart", "cmux watcher operator front door"),
    ("bash scripts/flywheel-cmux-autostart.sh", "cmux watcher repo front door"),
    ("launchctl print gui/501/com.flywheel.bridge", "read-only launchctl print"),
    ("launchctl list | grep flywheel", "read-only launchctl list"),
    ("launchctl submit -l com.test.envprobe -- /usr/bin/env", "unrelated submit probe"),
    ("launchctl remove com.test.envprobe", "unrelated launchctl remove"),
    ("crontab -l", "read-only crontab list"),
    ("crontab -l | grep restart-services", "read-only crontab output inspection"),
    ("pgrep -f run-bridge", "bare pgrep no kill"),
    ("grep -n launchctl scripts/restart-services.sh", "grep launchctl no label"),
    ("grep -n kill scripts/restart-services.sh", "grep kill in restart source"),
    ("rg -n 'kill' scripts/restart-services.sh", "rg kill in restart source"),
    ("grep -En 'kill|restart-services' scripts/restart-services.sh",
     "grep alternation in restart source"),
    ("rg 'kill|restart-services' scripts/restart-services.sh",
     "rg alternation in restart source"),
    ("grep -n 'launchctl bootout' scripts/restart-services.sh",
     "grep launchctl mutator in restart source"),
    ("sed -n '1,50p' scripts/run-bridge.ts", "sed read of run-bridge source"),
    ('rg "nohup npx tsx scripts/run-bridge.ts" scripts/restart-services.sh',
     "rg needle containing executor+run-bridge (read tool first token)"),
    ("cat scripts/run-bridge.ts", "cat run-bridge source"),
    ("pkill -f chrome", "unrelated pkill"),
    ("kill %1", "bare jobspec kill"),
    ("kill 12345", "bare pid kill"),
    ("tmux kill-session -t qa-slot-2", "QA slot tmux kill-session"),
    ("node scripts/qa-fly-529-alert-smoke.mjs", "executor without run-bridge"),
    ("git log --oneline -- scripts/run-bridge.ts", "git read of run-bridge path"),
    ("git log --oneline -- scripts/restart-services.sh", "git read of restart-services path"),
    ("bash scripts/test-restart-services.sh", "restart harness invocation"),
    ("sudo cat scripts/run-bridge.ts", "sudo-wrapped read tool"),
    ("env | grep run-bridge", "bare env piped to grep"),
    ("env node scripts/qa-tool.mjs", "env-wrapped executor without run-bridge"),
    ('env -S "node scripts/qa-tool.mjs"', "env -S payload without run-bridge"),
    ("sudo grep node scripts/restart-services.sh",
     "sudo grep with executor-shaped needle, no run-bridge"),
    ("command -v node", "command -v probe without run-bridge"),
    ("time grep run-bridge scripts/restart-services.sh",
     "time-wrapped grep of run-bridge (no executor token)"),
    ("time pnpm build", "time-wrapped build"),
    ("pnpm build", "pnpm build (no run-bridge)"),
    ("pnpm -C packages/teamlead build", "pnpm -C build"),
    ("npm run lint", "npm run lint"),
    ("pnpm test:packages:run", "pnpm test script"),
    ("pnpm install --frozen-lockfile", "pnpm install"),
    ("corepack pnpm build", "corepack pnpm build (no run-bridge)"),
    ("corepack enable", "corepack enable"),
    ("sudo launchctl print gui/501/com.flywheel.bridge", "sudo read-only launchctl"),
]


def t1_t2_matrix():
    print("T1: must-block matrix")
    for cmd, name in MUST_BLOCK:
        code, out = run_hook(bash_event(cmd))
        d = decision_of(out)
        if code == 0 and d == "deny":
            ok(f"T1 block: {name}")
        else:
            bad(f"T1 block: {name}", f"exit={code} decision={d}")

    print("T2: must-pass matrix")
    for cmd, name in MUST_PASS:
        code, out = run_hook(bash_event(cmd))
        d = decision_of(out)
        if code == 0 and d == "allow":
            ok(f"T2 pass: {name}")
        else:
            bad(f"T2 pass: {name}", f"exit={code} decision={d}")


# ── T3: deny output schema + audit ────────────────────────────────────────────
def t3_deny_schema():
    print("T3: deny output schema + deny audit record")
    with tempfile.TemporaryDirectory() as tmp:
        log = os.path.join(tmp, "guard.log")
        code, out = run_hook(
            bash_event("launchctl kickstart -k gui/501/com.flywheel.bridge"),
            env_extra={"FLYWHEEL_RESTART_GUARD_LOG": log},
        )
        try:
            payload = json.loads(out)
            hso = payload["hookSpecificOutput"]
        except Exception:
            bad("T3 schema", f"unparseable stdout: {out[:120]}")
            return
        if hso.get("hookEventName") == "PreToolUse" and hso.get("permissionDecision") == "deny":
            ok("T3 hookSpecificOutput deny schema")
        else:
            bad("T3 schema", json.dumps(hso)[:200])
        reason = hso.get("permissionDecisionReason", "")
        if (
            "request-restart.sh" in reason
            and "founder 紧急票" in reason
            and "self-ship" not in reason
        ):
            ok("T3 reason names the sole founder emergency ticket path")
        else:
            bad("T3 reason", f"missing correct-command pointer: {reason[:200]}")
        if "FLYWHEEL_RESTART_GUARD_BYPASS" not in reason:
            ok("T3 reason does NOT advertise the bypass env")
        else:
            bad("T3 reason", "bypass env name leaked into deny reason")
        # deny audit record written
        try:
            lines = [json.loads(x) for x in Path(log).read_text().splitlines() if x.strip()]
        except Exception:
            lines = []
        recs = [r for r in lines if r.get("decision") == "deny"]
        if recs and recs[-1].get("session_id") == "test-session" and "kickstart" in recs[-1].get("command", ""):
            ok("T3 deny audit JSON line written (ts/session_id/cwd/command)")
        else:
            bad("T3 deny audit", f"records={lines}")

    _code, out = run_hook(
        bash_event(
            "launchctl bootstrap gui/501 "
            "~/Library/LaunchAgents/com.flywheel.cmux-watcher.plist"
        )
    )
    reason = deny_reason(out)
    if "bash ~/.flywheel/bin/flywheel-cmux-autostart" in reason:
        ok("T3 cmux watcher deny points to the operator front door")
    else:
        bad("T3 cmux watcher guidance", f"reason={reason!r}")


# ── T4: deny-audit invariant — unwritable log still denies (Codex R1 #5) ─────
def t4_deny_audit_invariant():
    print("T4: deny-audit invariant (audit failure never flips deny)")
    with tempfile.TemporaryDirectory() as tmp:
        # log path whose PARENT is a file → mkdir/append must fail
        blocker = os.path.join(tmp, "blocker")
        Path(blocker).write_text("i am a file")
        log = os.path.join(blocker, "guard.log")
        code, out = run_hook(
            bash_event("pkill -f run-bridge"),
            env_extra={"FLYWHEEL_RESTART_GUARD_LOG": log},
        )
        if code == 0 and decision_of(out) == "deny":
            ok("T4 unwritable audit path → still deny")
        else:
            bad("T4", f"exit={code} decision={decision_of(out)}")


# ── T5: bypass contract via alert seam ───────────────────────────────────────
BYPASS_CMD = (
    'FLYWHEEL_RESTART_GUARD_BYPASS="bridge wedged, restart-services broken" '
    "launchctl kickstart -k gui/501/com.flywheel.bridge"
)


def make_fake_alert(tmp: str, result_line: str, args_file: str) -> str:
    fake = os.path.join(tmp, "fake-lead-alert.sh")
    Path(fake).write_text(
        "#!/bin/bash\n"
        f'printf \'%s\\n\' "$*" >> "{args_file}"\n'
        + (f"printf '%s\\n' '{result_line}'\n" if result_line else "")
        + "exit 0\n"
    )
    os.chmod(fake, 0o755)
    return fake


def t5_bypass_contract():
    print("T5: bypass contract (strict alert result + audit, fail-closed)")
    cases = [
        ("sent", "allow"),
        ("queued_transient", "allow"),
        ("dead_lettered", "deny"),
        ("config_error", "deny"),
        ("duplicate", "deny"),  # Codex R2 #1: claim precedes delivery → not proof
        ("totally-unexpected-output", "deny"),
        ("", "deny"),  # no parseable strict result → deny
    ]
    for result_line, expected in cases:
        with tempfile.TemporaryDirectory() as tmp:
            args_file = os.path.join(tmp, "args.txt")
            fake = make_fake_alert(tmp, result_line, args_file)
            log = os.path.join(tmp, "guard.log")
            code, out = run_hook(
                bash_event(BYPASS_CMD),
                env_extra={
                    "FLYWHEEL_RESTART_GUARD_LOG": log,
                    "FLYWHEEL_RESTART_GUARD_ALERT_CMD": fake,
                },
            )
            d = decision_of(out)
            if code == 0 and d == expected:
                ok(f"T5 strict result {result_line or '(empty)'} → {expected}")
            else:
                bad(f"T5 {result_line or '(empty)'}", f"exit={code} decision={d} want={expected}")
            if expected == "allow":
                # bypass audit record with reason must exist
                recs = [json.loads(x) for x in Path(log).read_text().splitlines() if x.strip()]
                byp = [r for r in recs if r.get("decision") == "bypass"]
                if byp and "bridge wedged" in (byp[-1].get("bypass_reason") or ""):
                    ok(f"T5 bypass audit record ({result_line})")
                else:
                    bad(f"T5 bypass audit ({result_line})", f"recs={recs}")
                # alert argv contract: strict flag + kind + severity present
                argv = Path(args_file).read_text()
                for needle in ("--strict-delivery", "restart_guard_bypass", "severe"):
                    if needle in argv:
                        ok(f"T5 alert argv has {needle} ({result_line})")
                    else:
                        bad(f"T5 alert argv ({result_line})", f"missing {needle}: {argv}")


def t5b_bypass_audit_fail_closed():
    print("T5b: bypass with unwritable audit log → deny even when alert would send")
    with tempfile.TemporaryDirectory() as tmp:
        args_file = os.path.join(tmp, "args.txt")
        fake = make_fake_alert(tmp, "sent", args_file)
        blocker = os.path.join(tmp, "blocker")
        Path(blocker).write_text("file")
        log = os.path.join(blocker, "guard.log")
        code, out = run_hook(
            bash_event(BYPASS_CMD),
            env_extra={
                "FLYWHEEL_RESTART_GUARD_LOG": log,
                "FLYWHEEL_RESTART_GUARD_ALERT_CMD": fake,
            },
        )
        if code == 0 and decision_of(out) == "deny":
            ok("T5b audit write failure → deny (bypass fail-closed)")
        else:
            bad("T5b", f"exit={code} decision={decision_of(out)}")
        # precondition ordering: audit-before-alert means the alert must NOT
        # have been fired when the audit write failed.
        if not os.path.exists(args_file):
            ok("T5b alert not fired when audit failed (audit is precondition)")
        else:
            bad("T5b", "alert fired despite audit failure")


def t5c_dead_letter_regression():
    print("T5c: dead_lettered → retry with same command must NOT become duplicate-allow")
    with tempfile.TemporaryDirectory() as tmp:
        args_file = os.path.join(tmp, "args.txt")
        fake = make_fake_alert(tmp, "dead_lettered", args_file)
        log = os.path.join(tmp, "guard.log")
        env = {
            "FLYWHEEL_RESTART_GUARD_LOG": log,
            "FLYWHEEL_RESTART_GUARD_ALERT_CMD": fake,
        }
        code1, out1 = run_hook(bash_event(BYPASS_CMD), env_extra=env)
        code2, out2 = run_hook(bash_event(BYPASS_CMD), env_extra=env)
        if decision_of(out1) == "deny" and decision_of(out2) == "deny":
            ok("T5c both attempts denied (no duplicate-allow)")
        else:
            bad("T5c", f"d1={decision_of(out1)} d2={decision_of(out2)}")
        # per-invocation signature uniqueness: the two alert invocations must
        # carry DIFFERENT --signature values.
        lines = Path(args_file).read_text().strip().splitlines()
        sigs = []
        for ln in lines:
            toks = ln.split()
            if "--signature" in toks:
                sigs.append(toks[toks.index("--signature") + 1])
        if len(sigs) == 2 and sigs[0] != sigs[1]:
            ok("T5c per-invocation signatures are unique")
        else:
            bad("T5c signatures", f"sigs={sigs}")


def t5d_alert_cmd_missing():
    print("T5d: alert command missing/failing → deny")
    with tempfile.TemporaryDirectory() as tmp:
        log = os.path.join(tmp, "guard.log")
        code, out = run_hook(
            bash_event(BYPASS_CMD),
            env_extra={
                "FLYWHEEL_RESTART_GUARD_LOG": log,
                "FLYWHEEL_RESTART_GUARD_ALERT_CMD": os.path.join(tmp, "nonexistent"),
            },
        )
        if code == 0 and decision_of(out) == "deny":
            ok("T5d nonexistent alert cmd → deny")
        else:
            bad("T5d", f"exit={code} decision={decision_of(out)}")


# ── T6: robustness — judgment path fail-open ─────────────────────────────────
def t6_robustness():
    print("T6: malformed input fail-open")
    cases = [
        ("", "empty stdin"),
        ("not json at all {{{", "non-JSON stdin"),
        (json.dumps({"tool_name": "Write", "tool_input": {"command": "launchctl kickstart -k gui/501/com.flywheel.bridge"}}),
         "tool_name != Bash"),
        (json.dumps({"tool_name": "Bash"}), "missing tool_input"),
        (json.dumps({"tool_name": "Bash", "tool_input": {}}), "missing command"),
        (json.dumps({"tool_name": "Bash", "tool_input": {"command": 42}}), "non-string command"),
    ]
    for stdin_data, name in cases:
        code, out = run_hook(stdin_data)
        if code == 0 and not out.strip():
            ok(f"T6 {name} → silent allow")
        else:
            bad(f"T6 {name}", f"exit={code} out={out[:80]}")


# ── T7: unit checks on the module (signature entropy) ────────────────────────
def t7_unit():
    print("T7: unit — signature uniqueness")
    mod = load_hook_module()
    s1 = mod.make_signature("launchctl kickstart x")
    s2 = mod.make_signature("launchctl kickstart x")
    if s1 != s2:
        ok("T7 same command twice → different signatures")
    else:
        bad("T7", f"identical signatures: {s1}")

    captured = []

    class Result:
        stdout = "sent\n"

    original_run = mod.subprocess.run
    original_environ = dict(mod.os.environ)
    try:
        mod.os.environ.pop("FLYWHEEL_LEAD_ID", None)
        mod.os.environ["FLYWHEEL_RESTART_GUARD_ALERT_CMD"] = "/tmp/fake-alert"
        mod.subprocess.run = lambda argv, **_kwargs: (captured.append(argv) or Result())
        if mod.fire_bypass_alert("test", "restart-services"):
            argv = captured[0]
            body = argv[argv.index("--body") + 1]
            lead = argv[argv.index("--lead") + 1]
            if lead == "system" and "lead_unknown=true" in body:
                ok("T7 missing Lead identity stays system-attributed")
            else:
                bad("T7 missing Lead identity", f"lead={lead} body={body}")
        else:
            bad("T7 missing Lead identity", "alert unexpectedly failed")
    finally:
        mod.subprocess.run = original_run
        mod.os.environ.clear()
        mod.os.environ.update(original_environ)


# ── T8: integration — hook default path drives the REAL lead-alert.sh ────────
def t8_real_lead_alert_integration():
    """Bypass through the real scripts/lead-alert.sh (--strict-delivery) with a
    fake curl on PATH and isolated FLYWHEEL_* dirs: sent → allow, 403 → deny.
    Skipped when jq/sqlite3/shasum are unavailable."""
    print("T8: integration via real lead-alert.sh")
    import shutil

    for tool in ("jq", "sqlite3", "shasum"):
        if not shutil.which(tool):
            print(f"  SKIP T8 (missing {tool})")
            return
    repo_root = HOOK.parent.parent.parent
    if not (repo_root / "scripts" / "lead-alert.sh").is_file():
        print("  SKIP T8 (lead-alert.sh not found)")
        return
    for http_code, expected in (("200", "allow"), ("403", "deny")):
        with tempfile.TemporaryDirectory() as tmp:
            bindir = os.path.join(tmp, "bin")
            os.makedirs(bindir)
            Path(bindir, "curl").write_text(
                "#!/bin/bash\n"
                "[[ -z \"${SYSTEM_ALERT_MUST_NOT_LEAK:-}\" ]] || exit 7\n"
                "[[ -z \"${SYSTEM_ALERT_TOKEN:-}\" ]] || exit 8\n"
                "printf '%s' \"${CURL_HTTP_CODE:-200}\"\n"
                "exit 0\n"
            )
            os.chmod(os.path.join(bindir, "curl"), 0o755)
            Path(bindir, "osascript").write_text("#!/bin/bash\nexit 0\n")
            os.chmod(os.path.join(bindir, "osascript"), 0o755)
            home = Path(tmp, "home")
            state = home / ".flywheel"
            state.mkdir(parents=True)
            production_claims = Path(tmp, "production-claims.db")
            (state / ".env").write_text(
                "FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=444444444444444444\n"
                "FLYWHEEL_ALERT_SENDER_TOKEN_ENV=SYSTEM_ALERT_TOKEN\n"
                "SYSTEM_ALERT_TOKEN=CANARY-TOKEN\n"
                "SYSTEM_ALERT_MUST_NOT_LEAK=latent-secret\n"
                f"FLYWHEEL_CLAIMS_DB={production_claims}\n"
            )
            env = {
                "HOME": str(home),
                "PATH": f"{bindir}:{os.environ.get('PATH', '')}",
                "CURL_HTTP_CODE": http_code,
                "FLYWHEEL_ROOT": str(repo_root),
                "FLYWHEEL_RESTART_GUARD_ALERT_CMD": "",  # force default path
                "FLYWHEEL_RESTART_GUARD_LOG": os.path.join(tmp, "guard.log"),
                "FLYWHEEL_PROJECTS_FILE": os.path.join(tmp, "missing-projects.json"),
                "FLYWHEEL_CLAIMS_DB": os.path.join(tmp, "claims.db"),
                "FLYWHEEL_ALERT_QUEUE_DIR": os.path.join(tmp, "queue"),
                "FLYWHEEL_ALERT_DEADLETTER_DIR": os.path.join(tmp, "deadletter"),
                "FLYWHEEL_STATE_DIR": os.path.join(tmp, "state"),
            }
            # empty ALERT_CMD env must mean "unset" for the hook
            full_env = {k: v for k, v in {**os.environ, **env}.items() if v != ""}
            full_env.pop("FLYWHEEL_RESTART_GUARD_ALERT_CMD", None)
            for name in (
                "FLYWHEEL_LEAD_ID",
                "PROJECT_NAME",
                "FLYWHEEL_PROJECT_NAME",
                "FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID",
                "FLYWHEEL_ALERT_SENDER_TOKEN_ENV",
                "SYSTEM_ALERT_TOKEN",
            ):
                full_env.pop(name, None)
            p = subprocess.run(
                [sys.executable, str(HOOK)],
                input=json.dumps(bash_event(BYPASS_CMD)),
                capture_output=True, text=True, env=full_env, timeout=60,
            )
            d = decision_of(p.stdout)
            caller_claims = Path(env["FLYWHEEL_CLAIMS_DB"])
            isolated = caller_claims.is_file() and not production_claims.exists()
            if p.returncode == 0 and d == expected and isolated:
                ok(f"T8 real lead-alert HTTP {http_code} → {expected}")
            else:
                bad(
                    f"T8 HTTP {http_code}",
                    f"exit={p.returncode} decision={d} isolated={isolated} stderr={p.stderr[-200:]}",
                )


def t9_log_rotation():
    print("T9: restart-guard audit rotation")
    mod = load_hook_module()
    with tempfile.TemporaryDirectory() as tmp:
        log = Path(tmp) / "restart-guard.log"
        log.write_text("old-evidence\n")
        prior = os.environ.get("FLYWHEEL_RESTART_GUARD_LOG")
        os.environ["FLYWHEEL_RESTART_GUARD_LOG"] = str(log)
        old_max = mod.LOG_MAX_BYTES
        try:
            mod.LOG_MAX_BYTES = 8
            wrote = mod.audit_write({"event": "new-evidence"})
        finally:
            mod.LOG_MAX_BYTES = old_max
            if prior is None:
                os.environ.pop("FLYWHEEL_RESTART_GUARD_LOG", None)
            else:
                os.environ["FLYWHEEL_RESTART_GUARD_LOG"] = prior
        archive = log.with_name("restart-guard.log.1")
        if wrote and archive.read_text() == "old-evidence\n" \
                and "new-evidence" in log.read_text():
            ok("T9 audit rotates by rename before append")
        else:
            active = log.read_text() if log.exists() else "missing"
            bad("T9 audit rotation", f"wrote={wrote} active={active}")

        log.write_text("stale-lock-evidence\n")
        lock = log.with_name("restart-guard.log.rotate.lock")
        lock.mkdir()
        old_lock_time = time.time() - 10 * 60
        os.utime(lock, (old_lock_time, old_lock_time))
        prior = os.environ.get("FLYWHEEL_RESTART_GUARD_LOG")
        os.environ["FLYWHEEL_RESTART_GUARD_LOG"] = str(log)
        old_max = mod.LOG_MAX_BYTES
        try:
            mod.LOG_MAX_BYTES = 8
            recovered = mod.audit_write({"event": "after-stale-lock"})
        finally:
            mod.LOG_MAX_BYTES = old_max
            if prior is None:
                os.environ.pop("FLYWHEEL_RESTART_GUARD_LOG", None)
            else:
                os.environ["FLYWHEEL_RESTART_GUARD_LOG"] = prior
        if recovered and archive.read_text() == "stale-lock-evidence\n" \
                and "after-stale-lock" in log.read_text() and not lock.exists():
            ok("T9 stale crash-residue lock is recovered before append")
        else:
            active = log.read_text() if log.exists() else "missing"
            bad("T9 stale lock recovery", f"recovered={recovered} active={active}")


# ── T10: FLY-1944 host-toolchain brew guard ──────────────────────────────────
BREW_MUTATIONS = [
    ("brew install tmux", "install"),
    ("brew --debug install tmux", "global flag before mutation"),
    ("/opt/homebrew/bin/brew reinstall tmux", "absolute-path reinstall"),
    ("sudo -E /usr/local/bin/brew upgrade tmux", "wrapped absolute-path upgrade"),
    ("env FOO=1 brew install tmux", "env wrapper"),
    ("nohup brew install tmux", "nohup wrapper"),
    ("command brew install tmux", "command wrapper"),
    ("exec brew install tmux", "exec wrapper"),
    ("time -p brew install tmux", "time wrapper"),
    ("nice -n 5 brew install tmux", "nice wrapper with value flag"),
    ("arch -x86_64 /usr/local/bin/brew install tmux", "arch wrapper"),
    ("caffeinate brew install tmux", "caffeinate wrapper"),
    ("timeout 60 brew install tmux", "timeout wrapper with duration"),
    ("stdbuf -o0 brew install tmux", "stdbuf wrapper"),
    ("setsid brew install tmux", "setsid wrapper"),
    ("ionice -c 3 brew install tmux", "ionice wrapper with value flag"),
    ("chrt -o 0 brew install tmux", "chrt wrapper with priority"),
    ("corepack brew install tmux", "corepack wrapper"),
    ("bash -lc 'brew unlink tmux'", "shell payload unlink"),
    ("brew list && brew link tmux", "read then mutation"),
    ("brew bundle", "bundle is fail-closed"),
    ("brew services restart postgresql", "services is fail-closed"),
    ("brew analytics on", "analytics on"),
    ("brew analytics off", "analytics off"),
    ("brew analytics regenerate-uuid", "analytics regenerate-uuid"),
    ("brew gist-logs tmux", "gist-logs creates an external Gist"),
    ("brew future-read-command tmux", "unknown future subcommand"),
    (
        "env --split-string='brew install tmux'",
        "env split-string payload is scanned fail-closed",
    ),
    (
        "env -S FOO=1 brew install tmux",
        "env split-string assignment preserves and scans remaining command",
    ),
    (
        "nice -n 5 env -S 'brew install tmux'",
        "stacked value wrapper preserves env split-string payload",
    ),
    (
        "timeout 60 env -S FOO=1 brew upgrade tmux",
        "stacked positional wrapper preserves env split-string command tail",
    ),
    (
        "env FLYWHEEL_EXEC_ID= brew install tmux",
        "command-local empty EXEC_ID cannot impersonate a Lead",
    ),
]

BREW_READS = [
    ("brew list", "list"),
    ("brew ls --versions tmux", "ls"),
    ("brew info tmux", "info"),
    ("brew deps tmux", "deps"),
    ("brew outdated", "outdated"),
    ("brew doctor", "doctor"),
    ("brew config", "config"),
    ("brew search tmux", "search"),
    ("brew analytics state", "analytics state"),
    ("brew --version", "option-only version"),
    ("brew -v", "option-only short version"),
    ("brew --prefix", "option-only prefix"),
    ("brew --prefix tmux", "option-only prefix formula"),
    ("/opt/homebrew/bin/brew --cellar tmux", "absolute-path cellar formula"),
    ("brew --caskroom", "option-only caskroom"),
    ("brew --repository", "option-only repository"),
]


def t10_brew_guard():
    print("T10: FLY-1944 runner brew allowlist + Lead audit")
    runner_env = {"FLYWHEEL_EXEC_ID": "fly-1944-test-exec"}
    for cmd, name in BREW_MUTATIONS:
        code, out = run_hook(bash_event(cmd), env_extra=runner_env)
        if code == 0 and decision_of(out) == "deny" and "brew" in deny_reason(out):
            ok(f"T10 runner mutation denied: {name}")
        else:
            bad(
                f"T10 runner mutation: {name}",
                f"exit={code} decision={decision_of(out)} reason={deny_reason(out)[:100]}",
            )

    for cmd, name in BREW_READS:
        code, out = run_hook(bash_event(cmd), env_extra=runner_env)
        if code == 0 and decision_of(out) == "allow":
            ok(f"T10 runner read allowed: {name}")
        else:
            bad(f"T10 runner read: {name}", f"exit={code} decision={decision_of(out)}")

    for enforce_qa, name in (
        (False, "calendar audit allow cannot mask runner brew deny"),
        (True, "calendar QA exemption cannot mask runner brew deny"),
    ):
        with tempfile.TemporaryDirectory() as tmp:
            qa_id = "flywheel-qa@group.calendar.google.com"
            mode, receipt, qa_path = calendar_home(tmp)
            if enforce_qa:
                mode.write_text("enforce\n")
                write_enforce_receipt(receipt)
                qa_path.write_text(qa_id + "\n")
            target = qa_id if enforce_qa else "primary"
            log = Path(tmp) / "guard.log"
            code, out = run_hook(
                bash_event(f"brew install tmux && gog calendar create {target}"),
                env_extra={
                    **runner_env,
                    "HOME": tmp,
                    "FLYWHEEL_RESTART_GUARD_LOG": str(log),
                },
            )
            records = jsonl(log)
            if (
                code == 0
                and decision_of(out) == "deny"
                and any(
                    record.get("pattern") == "P5"
                    and record.get("decision") == "deny"
                    for record in records
                )
            ):
                ok(f"T10 {name}")
            else:
                bad(f"T10 {name}", f"decision={decision_of(out)} records={records}")

    with tempfile.TemporaryDirectory() as tmp:
        log = Path(tmp) / "guard.log"
        code, out = run_hook(
            bash_event("brew install tmux"),
            env_extra={"FLYWHEEL_RESTART_GUARD_LOG": str(log)},
            env_remove=("FLYWHEEL_EXEC_ID",),
        )
        records = (
            [json.loads(line) for line in log.read_text().splitlines()]
            if log.exists()
            else []
        )
        lead_allows = [
            rec for rec in records
            if rec.get("pattern") == "P5" and rec.get("decision") == "allow"
        ]
        if code == 0 and decision_of(out) == "allow" and len(lead_allows) == 1:
            ok("T10 Lead/founder context allows mutation and writes one audit record")
        else:
            bad(
                "T10 Lead/founder allow audit",
                f"exit={code} decision={decision_of(out)} records={records}",
            )

    for cmd, expected_pattern, name in (
        (
            "brew install tmux && pnpm tsx scripts/run-bridge.ts",
            "P3",
            "Lead brew prefix cannot mask direct Bridge relaunch",
        ),
        (
            'brew upgrade tmux; echo "* * * * * ~/Dev/flywheel/scripts/restart-services.sh" | crontab -',
            "P4",
            "Lead brew prefix cannot mask restart crontab write",
        ),
    ):
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "guard.log"
            code, out = run_hook(
                bash_event(cmd),
                env_extra={"FLYWHEEL_RESTART_GUARD_LOG": str(log)},
                env_remove=("FLYWHEEL_EXEC_ID",),
            )
            records = (
                [json.loads(line) for line in log.read_text().splitlines()]
                if log.exists()
                else []
            )
            denied = [rec for rec in records if rec.get("decision") == "deny"]
            if (
                code == 0
                and decision_of(out) == "deny"
                and len(denied) == 1
                and denied[0].get("pattern") == expected_pattern
            ):
                ok(f"T10 {name}")
            else:
                bad(
                    f"T10 {name}",
                    f"exit={code} decision={decision_of(out)} records={records}",
                )

    with tempfile.TemporaryDirectory() as tmp:
        args_file = os.path.join(tmp, "args.txt")
        fake = make_fake_alert(tmp, "sent", args_file)
        log = os.path.join(tmp, "guard.log")
        cmd = (
            'FLYWHEEL_RESTART_GUARD_BYPASS="founder-approved tmux cutover" '
            "brew install tmux"
        )
        code, out = run_hook(
            bash_event(cmd),
            env_extra={
                **runner_env,
                "FLYWHEEL_RESTART_GUARD_LOG": log,
                "FLYWHEEL_RESTART_GUARD_ALERT_CMD": fake,
            },
        )
        alert_args = Path(args_file).read_text() if Path(args_file).exists() else ""
        if code == 0 and decision_of(out) == "allow" and "--strict-delivery" in alert_args:
            ok("T10 runner bypass reuses audit + strict-alert preconditions")
        else:
            bad("T10 runner bypass", f"exit={code} decision={decision_of(out)}")


# ── T11/T12: FLY-2137 founder-calendar CLI governance ───────────────────────
CALENDAR_WRITES = [
    ("gog calendar create primary --summary QA", "gog create"),
    ("gog cal add primary --summary QA", "gog cal alias + add"),
    ("gog --account personal calendar update primary event-1", "gog spaced global flag"),
    ("gog --account=personal --dry-run calendar delete primary event-1", "gog equals flag + dry-run"),
    ("gog calendar respond primary event-1 accepted", "gog respond"),
    ("gog calendar focus-time --summary focus", "gog focus-time omitted calendar = primary"),
    ("gog calendar future-mutation primary", "gog unknown method fails closed"),
    ("gws calendar +insert --calendar primary", "gws helper insert"),
    ("gws calendar:v3 events insert --params '{\"calendarId\":\"primary\"}'", "gws version-qualified service"),
    ("gws --api-version v3 calendar events update --params '{\"calendarId\":\"primary\"}'", "gws api-version spaced flag"),
    ("gws --api-version=v3 calendar events delete --params '{\"calendarId\":\"primary\"}'", "gws api-version equals flag"),
    ("gws calendar calendars transferOwnership --params '{}'", "gws transfer ownership"),
    ("gws calendar acl insert --params '{}'", "gws acl write"),
    ("gws calendar futureResource futureMethod", "gws unknown resource fails closed"),
    ("env FOO=1 gog calendar create primary", "env wrapper"),
    ("sudo -E gws calendar events insert --params '{\"calendarId\":\"primary\"}'", "sudo wrapper"),
    ('bash -lc "gog calendar create primary --summary QA"', "shell -c recursion"),
]

CALENDAR_READS = [
    ("gog calendar events primary --from 2026-08-01 --to 2026-09-01", "gog events read"),
    ("gog calendar list", "gog list read"),
    ("gog calendar freebusy primary", "gog freebusy read"),
    ("gog gmail send --to founder@example.com", "gog other service"),
    ("gog calendar create --help", "gog mutator help introspection"),
    ("gog --version", "gog version introspection"),
    ("gws calendar events list --params '{\"calendarId\":\"primary\"}'", "gws events list"),
    ("gws calendar:v3 settings get", "gws version-qualified read"),
    ("gws calendar help", "gws calendar help"),
    ("gws --help", "gws top-level help"),
    ("gws gmail:v1 users messages send", "gws other version-qualified service"),
    ("gws events insert", "Workspace Events is not Calendar"),
    ("gog --unknown-flag gmail messages list", "ambiguous gog flag stays outside non-calendar service"),
    ("gws --unknown drive files list", "ambiguous gws flag stays outside non-calendar service"),
    ('grep "gog calendar create" engineering/doc/FLY-2137-calendar-write-governance/plan.md', "grep source inspection"),
    ('rg "gws calendar events insert" scripts', "rg source inspection"),
]


def calendar_home(tmp: str) -> tuple[Path, Path, Path]:
    root = Path(tmp) / ".flywheel" / "calendar-guard"
    root.mkdir(parents=True)
    return root / "mode", root / "enforce-receipt.json", Path(tmp) / ".flywheel" / "qa-calendar-id"


def write_enforce_receipt(path: Path) -> None:
    path.write_text(json.dumps({
        "schemaVersion": 1,
        "approvedBy": "founder",
        "discordMsgId": "founder-msg-1",
        "approvedAt": "2026-08-31T12:00:00Z",
        "decision": "enforce",
    }))


def t11_calendar_grammar():
    print("T11: FLY-2137 calendar CLI grammar")
    for cmd, name in CALENDAR_WRITES:
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "guard.log"
            code, out = run_hook(
                bash_event(cmd),
                env_extra={"HOME": tmp, "FLYWHEEL_RESTART_GUARD_LOG": str(log)},
                env_remove=("FLYWHEEL_EXEC_ID",),
            )
            p6 = [r for r in jsonl(log) if r.get("pattern") == "P6"]
            if code == 0 and decision_of(out) == "allow" and len(p6) == 1 and p6[0].get("decision") == "would_deny":
                ok(f"T11 write candidate audited: {name}")
            else:
                bad(f"T11 write candidate: {name}", f"exit={code} decision={decision_of(out)} records={jsonl(log)}")

    for cmd, name in CALENDAR_READS:
        with tempfile.TemporaryDirectory() as tmp:
            log = Path(tmp) / "guard.log"
            code, out = run_hook(
                bash_event(cmd),
                env_extra={"HOME": tmp, "FLYWHEEL_RESTART_GUARD_LOG": str(log)},
                env_remove=("FLYWHEEL_EXEC_ID",),
            )
            p6 = [r for r in jsonl(log) if r.get("pattern") == "P6"]
            if code == 0 and decision_of(out) == "allow" and not p6:
                ok(f"T11 read/unrelated allowed: {name}")
            else:
                bad(f"T11 read/unrelated: {name}", f"exit={code} decision={decision_of(out)} records={p6}")


def t12_calendar_decision_and_qa_targets():
    print("T12: FLY-2137 calendar audit/enforce/QA target contract")
    command = "gog calendar create primary --summary QA"
    for mode_case, mode_text, receipt_present, expected_decision, expected_note in (
        ("rollout without receipt", "enforce\n", False, "allow", None),
        ("founder enforce", "enforce\n", True, "deny", None),
        ("explicit founder rollback", "audit # founder-msg-2\n", True, "allow", None),
        ("missing mode after receipt", None, True, "deny", "mode_invalid_with_receipt"),
        ("damaged mode after receipt", "surprise\n", True, "deny", "mode_invalid_with_receipt"),
    ):
        with tempfile.TemporaryDirectory() as tmp:
            mode, receipt, _qa = calendar_home(tmp)
            if mode_text is not None:
                mode.write_text(mode_text)
            if receipt_present:
                write_enforce_receipt(receipt)
            log = Path(tmp) / "guard.log"
            code, out = run_hook(
                bash_event(command),
                env_extra={"HOME": tmp, "FLYWHEEL_RESTART_GUARD_LOG": str(log)},
                env_remove=("FLYWHEEL_EXEC_ID",),
            )
            p6 = [r for r in jsonl(log) if r.get("pattern") == "P6"]
            rec = p6[-1] if p6 else {}
            expected_audit = "deny" if expected_decision == "deny" else "would_deny"
            if (
                code == 0
                and decision_of(out) == expected_decision
                and rec.get("decision") == expected_audit
                and (expected_note is None or rec.get("note") == expected_note)
            ):
                ok(f"T12 mode: {mode_case}")
            else:
                bad(f"T12 mode: {mode_case}", f"decision={decision_of(out)} reason={deny_reason(out)[:100]} records={p6}")

    qa_id = "flywheel-qa@group.calendar.google.com"
    qa_cases = [
        (f"gog calendar create {qa_id} --summary QA", True, "gog positional target"),
        (f"gog calendar focus-time {qa_id} --summary focus", True, "gog helper target"),
        (f"gws calendar +insert --calendar {qa_id}", True, "gws helper target"),
        (f"gws calendar events insert --params '{{\"calendarId\":\"{qa_id}\"}}'", True, "gws params target"),
        (f"gws calendar events move --params '{{\"calendarId\":\"{qa_id}\",\"destination\":\"{qa_id}\"}}'", True, "gws move both targets QA"),
        (f"gws calendar events move --params '{{\"calendarId\":\"{qa_id}\",\"destination\":\"primary\"}}'", False, "gws move mixed targets"),
        (f"gog calendar create {qa_id} && gws calendar +insert --calendar {qa_id}", True, "multiple writes all target QA"),
        (f"gog calendar create {qa_id} && gog calendar create primary", False, "later primary write cannot hide behind QA first"),
        (f"gws calendar +insert --calendar {qa_id} --calendar primary", False, "repeated target flag cannot preserve QA exemption"),
        (f"gws calendar events insert --params '{{\"calendarId\":\"primary\",\"summary\":\"{qa_id}\"}}'", False, "QA id only in summary"),
        ("gws calendar events insert --params not-json", False, "invalid params JSON"),
        ("gws calendar +insert", False, "omitted calendar means primary"),
        ("gws calendar calendars clear --params '{}'", False, "no extractor never exempt"),
    ]
    for cmd, exempt, name in qa_cases:
        with tempfile.TemporaryDirectory() as tmp:
            mode, receipt, qa_path = calendar_home(tmp)
            mode.write_text("enforce\n")
            write_enforce_receipt(receipt)
            qa_path.write_text(qa_id + "\n")
            log = Path(tmp) / "guard.log"
            code, out = run_hook(
                bash_event(cmd),
                env_extra={"HOME": tmp, "FLYWHEEL_RESTART_GUARD_LOG": str(log)},
                env_remove=("FLYWHEEL_EXEC_ID",),
            )
            recs = [r for r in jsonl(log) if r.get("pattern") == "P6"]
            rec = recs[-1] if recs else {}
            got_exempt = decision_of(out) == "allow" and rec.get("note") == "qa_calendar"
            got_denied = decision_of(out) == "deny" and rec.get("decision") == "deny"
            if code == 0 and ((exempt and got_exempt) or (not exempt and got_denied)):
                ok(f"T12 QA target: {name}")
            else:
                bad(f"T12 QA target: {name}", f"decision={decision_of(out)} records={recs}")

    for invalid_id in ("primary", "founder@gmail.com", "founder@u.northwestern.edu"):
        with tempfile.TemporaryDirectory() as tmp:
            mode, receipt, qa_path = calendar_home(tmp)
            mode.write_text("enforce\n")
            write_enforce_receipt(receipt)
            qa_path.write_text(invalid_id + "\n")
            log = Path(tmp) / "guard.log"
            _code, out = run_hook(
                bash_event(f"gog calendar create {invalid_id}"),
                env_extra={"HOME": tmp, "FLYWHEEL_RESTART_GUARD_LOG": str(log)},
                env_remove=("FLYWHEEL_EXEC_ID",),
            )
            if decision_of(out) == "deny":
                ok(f"T12 invalid QA id denied: {invalid_id}")
            else:
                bad(f"T12 invalid QA id: {invalid_id}", f"decision={decision_of(out)}")

    for command, setup_enforce, name in (
        ("gog calendar create primary", False, "audit-mode accounting failure denies"),
        (f"gog calendar create {qa_id}", True, "QA-exemption accounting failure denies"),
    ):
        with tempfile.TemporaryDirectory() as tmp:
            mode, receipt, qa_path = calendar_home(tmp)
            if setup_enforce:
                mode.write_text("enforce\n")
                write_enforce_receipt(receipt)
                qa_path.write_text(qa_id + "\n")
            audit_path = Path(tmp) / "audit-is-a-directory"
            audit_path.mkdir()
            _code, out = run_hook(
                bash_event(command),
                env_extra={
                    "HOME": tmp,
                    "FLYWHEEL_RESTART_GUARD_LOG": str(audit_path),
                },
                env_remove=("FLYWHEEL_EXEC_ID",),
            )
            if decision_of(out) == "deny":
                ok(f"T12 {name}")
            else:
                bad(f"T12 {name}", f"decision={decision_of(out)}")

    with tempfile.TemporaryDirectory() as tmp:
        mode, receipt, _qa = calendar_home(tmp)
        mode.write_text("enforce\n")
        write_enforce_receipt(receipt)
        args_file = Path(tmp) / "alert-args.txt"
        fake_alert = make_fake_alert(tmp, "sent", str(args_file))
        log = Path(tmp) / "guard.log"
        bypassed = 'FLYWHEEL_RESTART_GUARD_BYPASS="calendar exception" gog calendar create primary'
        _code, out = run_hook(
            bash_event(bypassed),
            env_extra={
                "HOME": tmp,
                "FLYWHEEL_RESTART_GUARD_LOG": str(log),
                "FLYWHEEL_RESTART_GUARD_ALERT_CMD": fake_alert,
            },
            env_remove=("FLYWHEEL_EXEC_ID",),
        )
        if decision_of(out) == "deny" and not args_file.exists():
            ok("T12 restart-guard bypass has no effect on P6")
        else:
            bad("T12 P6 bypass", f"decision={decision_of(out)} alert_fired={args_file.exists()}")

    for command, runner_context, name in (
        (
            'FLYWHEEL_RESTART_GUARD_BYPASS="need tmux" brew install tmux && gog calendar create primary',
            True,
            "P5 bypass cannot carry an enforce-mode primary write",
        ),
        (
            'FLYWHEEL_RESTART_GUARD_BYPASS="rescue" pkill -f run-bridge && gog calendar create primary',
            False,
            "P2 bypass cannot carry an enforce-mode primary write",
        ),
    ):
        with tempfile.TemporaryDirectory() as tmp:
            mode, receipt, _qa = calendar_home(tmp)
            mode.write_text("enforce\n")
            write_enforce_receipt(receipt)
            args_file = Path(tmp) / "alert-args.txt"
            fake_alert = make_fake_alert(tmp, "sent", str(args_file))
            log = Path(tmp) / "guard.log"
            env_extra = {
                "HOME": tmp,
                "FLYWHEEL_RESTART_GUARD_LOG": str(log),
                "FLYWHEEL_RESTART_GUARD_ALERT_CMD": fake_alert,
            }
            if runner_context:
                env_extra["FLYWHEEL_EXEC_ID"] = "fly-2137-compound-test"
            _code, out = run_hook(
                bash_event(command),
                env_extra=env_extra,
                env_remove=() if runner_context else ("FLYWHEEL_EXEC_ID",),
            )
            p6 = [record for record in jsonl(log) if record.get("pattern") == "P6"]
            if (
                decision_of(out) == "deny"
                and any(record.get("decision") == "deny" for record in p6)
                and not args_file.exists()
            ):
                ok(f"T12 {name}")
            else:
                bad(
                    f"T12 {name}",
                    f"decision={decision_of(out)} records={jsonl(log)} alert_fired={args_file.exists()}",
                )


def main() -> int:
    if not HOOK.exists():
        print(f"FAIL: hook not found at {HOOK}")
        return 1
    t1_t2_matrix()
    t3_deny_schema()
    t4_deny_audit_invariant()
    t5_bypass_contract()
    t5b_bypass_audit_fail_closed()
    t5c_dead_letter_regression()
    t5d_alert_cmd_missing()
    t6_robustness()
    t7_unit()
    t8_real_lead_alert_integration()
    t9_log_rotation()
    t10_brew_guard()
    t11_calendar_grammar()
    t12_calendar_decision_and_qa_targets()
    print(f"\n{PASS} passed, {FAIL} failed")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
