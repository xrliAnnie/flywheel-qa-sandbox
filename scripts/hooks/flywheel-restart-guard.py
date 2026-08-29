#!/usr/bin/env python3
"""PreToolUse hook (matcher: Bash): hard-deny manual Flywheel service restarts
(FLY-913 deployment guardrail).

Manual `launchctl kickstart` / kill+relaunch of the Bridge or a Lead daemon
skips `pnpm build` (old code keeps running), skips the core-channel deploy
broadcast (the founder's deploy audit trail breaks), and has no health-check
rollback. Verbal promises and agent memory do not enforce behavior — this hook
does, physically, at the Bash boundary. The one legitimate path is
`scripts/restart-services.sh` (and the updater / self-ship flow), whose
internal launchctl calls run in a child process the hook never sees.

Decision algorithm (design: engineering/doc/FLY-913-restart-guard-hook/plan.md):

  block patterns (case-insensitive, raw command string — NO quote stripping
  for P1/P2, so `bash -c "…"` gets no free escape hatch):
    P1  launchctl + mutating subcommand (kickstart|bootout|bootstrap|kill|
        stop|unload|load|enable|disable|remove) AND `com.flywheel.` in the
        same command string. Read-only subcommands (print/list/…) never match.
    P2  kill family (kill/pkill/killall, incl. `xargs … kill`) AND a flywheel
        process identifier (run-bridge / claude-lead.sh /
        flywheel-bridge-wrapper / flywheel-codex-lead-wrapper / com.flywheel).
    P3  segment-wise (split on ;/&&/||/|): after stripping leading env
        assignments and a `cd …` prefix, the segment's FIRST token (basename)
        is an executor (nohup/npx/tsx/node/bun) and the segment mentions
        run-bridge — the bare-handed Bridge relaunch. Read tools as first
        token (grep/rg/sed/cat/…) therefore never match. A `bash|sh|zsh -c`
        first token (incl. merged short-flag clusters like -lc/-lec) has its
        payload re-scanned ONCE with the full P1/P2/P3 set.

  hit → the ONLY exits are: deny, or a bypass whose accounting FULLY succeeds.
    bypass = the command starts (anchored prefix, a real shell env assignment,
    never a `contains`) with FLYWHEEL_RESTART_GUARD_BYPASS=<non-empty reason>.
    Allow preconditions (ALL required, fail-closed):
      1. the audit JSON line was appended successfully, AND
      2. lead-alert.sh --strict-delivery reported `sent` or `queued_transient`
         (anything else — dead_lettered / config_error / duplicate / unknown /
         unparseable — is NOT "the alert rang" and denies; Codex R1 #1, R2 #1).
    The deny branch's audit write is best-effort: an audit failure NEVER flips
    a deny into an allow (Codex R1 #5). Fail-open covers ONLY the judgment /
    parse path (bad stdin, non-Bash, internal scan error) — never a hit's exit.

Dependencies: python3 stdlib only. Per-invocation execution (deploy = cp to
~/.flywheel/bin — Tier-1, zero service restarts).
Env:  FLYWHEEL_RESTART_GUARD_LOG        — audit log override (tests);
                                          default ~/.flywheel/logs/restart-guard.log
      FLYWHEEL_RESTART_GUARD_ALERT_CMD  — alert command override (tests; the
                                          TRANSPORT-seam pattern from
                                          discord-reply-enforcer.py)
      FLYWHEEL_ROOT                     — repo root for lead-alert.sh
                                          (default ~/Dev/flywheel)
      PROJECT_NAME / FLYWHEEL_PROJECT_NAME / FLYWHEEL_LEAD_ID — alert identity
Deployed to: ~/.flywheel/bin/flywheel-restart-guard.py
             (scripts/hooks/install-restart-guard.sh + claude-lead.sh converge)
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import time
from pathlib import Path

# ── Block patterns ────────────────────────────────────────────────────────────
MUTATING_LAUNCHCTL = (
    "kickstart|bootout|bootstrap|kill|stop|unload|load|enable|disable|remove"
)
P1_RE = re.compile(rf"\blaunchctl\b(?:\s+-\S+)*\s+(?:{MUTATING_LAUNCHCTL})\b", re.I)
FLYWHEEL_LABEL_RE = re.compile(r"com\.flywheel\.", re.I)

KILL_RE = re.compile(r"\b(?:pkill|killall|kill)\b", re.I)
PROC_IDENT_RE = re.compile(
    r"run-bridge|claude-lead\.sh|flywheel-bridge-wrapper|flywheel-codex-lead-wrapper"
    r"|com\.flywheel",
    re.I,
)

# Executor first tokens that can launch scripts/run-bridge.ts directly. Package
# managers (pnpm/npm/yarn/pnpx) are here too (Codex R5): `pnpm tsx …` /
# `pnpm exec tsx …` / `npm exec tsx …` are reflexive one-line relaunch forms.
# `pnpm build` / `npm run lint` etc. never carry run-bridge, so they don't hit.
EXECUTORS = {
    "nohup", "npx", "tsx", "node", "bun", "bunx", "deno",
    "pnpm", "pnpx", "npm", "yarn",
}
SHELLS = {"bash", "sh", "zsh"}
RUN_BRIDGE_RE = re.compile(r"run-bridge", re.I)

SEG_SPLIT_RE = re.compile(r";|&&|\|\||\|")
ENV_ASSIGN_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")

# Anchored bypass prefix: a REAL leading shell env assignment with a non-empty
# reason, followed by an actual command. `echo FLYWHEEL_…=x; …` / comment forms
# do not match and stay on the deny path (Codex R1 #4).
BYPASS_RE = re.compile(
    r"^\s*FLYWHEEL_RESTART_GUARD_BYPASS=(\"[^\"]*\"|'[^']*'|\S+)\s+\S"
)

STRICT_OK = {"sent", "queued_transient"}
COMMAND_AUDIT_CAP = 2048
ALERT_TIMEOUT_S = 45  # lead-alert.sh worst case: sqlite 5s + curl --max-time 15

DENY_REASON = (
    "🚫 Flywheel 部署护栏(FLY-913):检测到手动重启/杀 Flywheel 服务的命令,已硬拦。\n"
    "手动 kickstart / kill+重拉会:漏 pnpm build(重启后跑的还是旧代码)、"
    "漏 core 频道部署播报(founder 的部署审计断链)、没有健康检查回滚。\n"
    "正确做法:\n"
    "  • 重启/部署 Bridge 或 Lead:bash ~/Dev/flywheel/scripts/restart-services.sh"
    "(FLY-1224 默认不等 idle;--wait-idle 恢复等待;--dry-run 预览)\n"
    "  • 纯 env 改动(无代码 delta)要重启 Bridge:"
    "bash ~/Dev/flywheel/scripts/restart-services.sh --bridge-only(FLY-1142)\n"
    "  • self-ship:走既有 ship flow(flywheel-land / :cool: 部署),不要手动 kickstart。\n"
    "  • 若 restart-services.sh 本身故障:报告 Lead/founder,由人工在裸终端处理。"
)

BYPASS_FAIL_REASON = (
    "🚫 Flywheel 部署护栏(FLY-913):bypass 记账失败,拒绝放行。\n"
    "bypass 的放行前置是「审计日志写入成功 + 告警确认送达/入队」缺一不可 —— "
    "本次未全部满足(告警通道或日志路径故障)。\n"
    "请改用 bash ~/Dev/flywheel/scripts/restart-services.sh,"
    "或先修复告警通道后重试;若仍被拦,报告 Lead/founder 人工处理。"
)


# ── Pattern scan ──────────────────────────────────────────────────────────────
def _extract_c_payload(args: list[str]):
    """Return the `-c` payload from shell args, or None. Recognizes merged
    short-flag clusters (-lc, -lec, …): any short cluster containing `c` is a
    -c form (Codex R2 #2). The payload is the first non-flag arg after it."""
    saw_c = False
    for a in args:
        if a.startswith("-") and len(a) > 1 and not a.startswith("--"):
            if "c" in a[1:]:
                saw_c = True
            continue
        return a if saw_c else None
    return None


# Transparent wrappers a relaunch can hide behind (Codex code review R1 HIGH:
# `env node …` / `sudo -E node …` were silent allows). Each is stripped —
# together with its short flags and leading env assignments — before the
# first-token judgment. Flags that consume a value argument; -S/--split-string
# is handled separately (its value is a whole command line — Codex R2 MEDIUM).
# Codex R4: shell/utility wrappers (command/exec/time/nice/arch/…) are equally
# transparent — a value-consuming flag we don't know is safe here because the
# saw_wrapper backstop below catches the executor token anywhere in the
# remainder. setsid/ionice/chrt cover the Linux fleet hosts (FLY-519).
_WRAPPERS = {
    "sudo", "env", "nohup",
    "command", "exec", "time", "nice", "arch",
    "caffeinate", "timeout", "stdbuf", "setsid", "ionice", "chrt",
    # corepack is the package-manager shim (`corepack pnpm tsx …`); the repo
    # declares packageManager pnpm@… via corepack (Codex R6).
    "corepack",
}
# -P is macOS env's alternate-PATH flag (`env -P /usr/bin node …`) — without
# consuming its value, `/usr/bin` would be mistaken for the first token and the
# real executor never judged (Codex R3 MEDIUM).
_WRAPPER_ARG_FLAGS = {"-u", "--user", "-g", "--group", "-C", "--chdir", "-P"}


def _p3_hit(cmd: str, depth: int) -> bool:
    for seg in SEG_SPLIT_RE.split(cmd):
        seg = seg.strip()
        if not seg:
            continue
        try:
            tokens = shlex.split(seg)
        except ValueError:
            tokens = seg.split()
        # Strip any interleaving of env assignments / `cd <dir>` / transparent
        # wrappers (sudo/env/nohup + their flags) down to the REAL first token.
        i = 0
        saw_nohup = False
        saw_wrapper = False
        while i < len(tokens):
            t = tokens[i]
            if ENV_ASSIGN_RE.match(t):
                i += 1
                continue
            if t == "cd":
                i += 2
                continue
            base = os.path.basename(t)
            if base in _WRAPPERS:
                saw_wrapper = True
                saw_nohup = saw_nohup or base == "nohup"
                i += 1
                while i < len(tokens) and tokens[i].startswith("-") and tokens[i] != "-":
                    f = tokens[i]
                    # env -S / --split-string carries a WHOLE command line in
                    # one argument (Codex R2) — scan it like a -c payload. `S`
                    # may sit anywhere in a short-option CLUSTER (`-iS`, Codex
                    # R5): everything after the S is the attached payload, else
                    # the next token is the payload.
                    payload = None
                    if f == "--split-string" and i + 1 < len(tokens):
                        payload = tokens[i + 1]
                        i += 2
                    elif f.startswith("--split-string="):
                        payload = f.split("=", 1)[1]
                        i += 1
                    elif not f.startswith("--") and "S" in f:
                        rest = f[f.index("S") + 1:]
                        if rest:
                            payload = rest
                            i += 1
                        elif i + 1 < len(tokens):
                            payload = tokens[i + 1]
                            i += 2
                        else:
                            i += 1
                    elif f in _WRAPPER_ARG_FLAGS and i + 1 < len(tokens):
                        i += 2
                    else:
                        i += 1
                    if payload is not None and scan_block(payload, depth + 1):
                        return True
                continue
            break
        if i >= len(tokens):
            continue
        first = os.path.basename(tokens[i])
        if first in SHELLS:
            payload = _extract_c_payload(tokens[i + 1 :])
            if payload is not None and scan_block(payload, depth + 1):
                return True
            continue
        # Executor first token, OR a nohup-fronted direct script (`nohup
        # scripts/run-bridge.ts &` has no executor token but is still a
        # bare-handed relaunch) — plus run-bridge in the segment.
        if (first in EXECUTORS or saw_nohup) and RUN_BRIDGE_RE.search(seg):
            return True
        # Structural close of the unknown-wrapper-flag class (Codex R1/R2/R3
        # were all "a flag we didn't enumerate swallowed the token walk"):
        # once a wrapper was seen, an executor token ANYWHERE in the remainder
        # + run-bridge in the segment is a relaunch, regardless of which flags
        # sat between. Bounded false-positive: wrapper + executor word +
        # run-bridge all in one read command is the already-accepted research
        # shape (plan §5).
        if saw_wrapper and RUN_BRIDGE_RE.search(seg):
            if any(os.path.basename(t) in EXECUTORS for t in tokens[i:]):
                return True
    return False


def scan_block(cmd: str, depth: int = 0):
    """Return the matched pattern name (P1/P2/P3) or None. One level of
    shell -c recursion only (depth > 1 stops)."""
    if depth > 1:
        return None
    if P1_RE.search(cmd) and FLYWHEEL_LABEL_RE.search(cmd):
        return "P1"
    if KILL_RE.search(cmd) and PROC_IDENT_RE.search(cmd):
        return "P2"
    if _p3_hit(cmd, depth):
        return "P3"
    return None


# ── Bypass prefix ─────────────────────────────────────────────────────────────
def bypass_reason(cmd: str):
    """Return the non-empty bypass reason, or None if the command is not a
    valid anchored bypass form."""
    m = BYPASS_RE.match(cmd)
    if not m:
        return None
    raw = m.group(1)
    if (raw.startswith('"') and raw.endswith('"')) or (
        raw.startswith("'") and raw.endswith("'")
    ):
        raw = raw[1:-1]
    raw = raw.strip()
    return raw or None


# ── Accounting ────────────────────────────────────────────────────────────────
def audit_path() -> Path:
    override = os.environ.get("FLYWHEEL_RESTART_GUARD_LOG")
    if override:
        return Path(override)
    return Path.home() / ".flywheel" / "logs" / "restart-guard.log"


def audit_write(rec: dict) -> bool:
    """Append one JSON line. Returns False on ANY failure — the bypass branch
    treats that as a hard precondition failure; the deny branch ignores it."""
    try:
        p = audit_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return True
    except Exception:
        return False


def make_signature(cmd: str) -> str:
    """Per-invocation GLOBALLY UNIQUE alert signature (ns timestamp + pid +
    random + command hash). Uniqueness makes lead-alert.sh's `duplicate` result
    unreachable in normal flow — if it ever appears it is anomalous and denies
    (Codex R2 #1: a claim row precedes delivery, so it proves nothing)."""
    cmdhash = hashlib.sha1(cmd.encode("utf-8", "replace")).hexdigest()[:12]
    return f"{time.time_ns()}-{os.getpid()}-{secrets.token_hex(4)}-{cmdhash}"


def fire_bypass_alert(reason: str, cmd: str) -> bool:
    """Fire the mandatory bypass alert via lead-alert.sh --strict-delivery.
    Returns True ONLY on a machine-readable `sent` / `queued_transient` result
    (last non-empty stdout line, exact match). Everything else — including a
    missing/failed alert command, timeout, or unknown output — is False.
    Boring, fail-closed parsing (Codex R3 note)."""
    alert_cmd = os.environ.get("FLYWHEEL_RESTART_GUARD_ALERT_CMD")
    if alert_cmd:
        argv0 = [alert_cmd]
    else:
        root = os.environ.get("FLYWHEEL_ROOT") or str(Path.home() / "Dev" / "flywheel")
        script = Path(root) / "scripts" / "lead-alert.sh"
        if not script.is_file():
            return False
        argv0 = ["bash", str(script)]
    project = (
        os.environ.get("PROJECT_NAME")
        or os.environ.get("FLYWHEEL_PROJECT_NAME")
        or "flywheel"
    )
    lead = os.environ.get("FLYWHEEL_LEAD_ID") or "flywheel-eng-lead"
    argv = argv0 + [
        "--lead", lead,
        "--project", project,
        "--kind", "restart_guard_bypass",
        "--severity", "severe",
        "--signature", make_signature(cmd),
        "--strict-delivery",
        "--title", "Restart-guard BYPASS used",
        "--body", f"reason: {reason}\ncommand: {cmd[:800]}",
    ]
    try:
        r = subprocess.run(
            argv, capture_output=True, text=True, timeout=ALERT_TIMEOUT_S
        )
    except Exception:
        return False
    lines = [ln.strip() for ln in (r.stdout or "").splitlines() if ln.strip()]
    return bool(lines) and lines[-1] in STRICT_OK


# ── Output ────────────────────────────────────────────────────────────────────
def deny(reason: str) -> None:
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            },
            ensure_ascii=False,
        )
    )


def main() -> int:
    # ── Judgment path: fail-open. Any parse problem = silent allow. ──────────
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception:
        return 0
    if not isinstance(data, dict) or data.get("tool_name") != "Bash":
        return 0
    tool_input = data.get("tool_input")
    cmd = tool_input.get("command") if isinstance(tool_input, dict) else None
    if not isinstance(cmd, str) or not cmd:
        return 0
    try:
        pattern = scan_block(cmd)
    except Exception:
        return 0  # judgment failure only — never reached once a hit is known
    if not pattern:
        return 0

    # ── Hit: the only exits below are deny or a fully-accounted bypass. ──────
    base_rec = {
        "ts": time.time(),
        "session_id": data.get("session_id"),
        "cwd": data.get("cwd"),
        "pattern": pattern,
        "command": cmd[:COMMAND_AUDIT_CAP],
    }
    reason = bypass_reason(cmd)
    if reason is not None:
        # Precondition ① audit line, THEN ② strict alert. Both fail-closed.
        if audit_write({**base_rec, "decision": "bypass", "bypass_reason": reason}):
            if fire_bypass_alert(reason, cmd):
                return 0  # bypass allowed — Annie sees the alert immediately
            audit_write(
                {**base_rec, "decision": "deny", "note": "bypass_alert_failed"}
            )
        deny(BYPASS_FAIL_REASON)
        return 0

    # Plain deny: audit is best-effort — its failure never flips the decision.
    audit_write({**base_rec, "decision": "deny"})
    deny(DENY_REASON)
    return 0


if __name__ == "__main__":
    sys.exit(main())
