#!/usr/bin/env python3
"""PreToolUse hook (matcher: Bash): hard-deny manual Flywheel service restarts
(FLY-913 deployment guardrail).

Manual launchd mutation / kill+relaunch of the Bridge or a Lead daemon
skips `pnpm build` (old code keeps running), skips the core-channel deploy
broadcast (the founder's deploy audit trail breaks), and has no health-check
rollback. Verbal promises and agent memory do not enforce behavior — this hook
does, physically, at the Bash boundary. The founder emergency path is
`scripts/request-restart.sh`, which tickets the standalone updater; the
updater's internal `restart-services.sh` / launchctl calls run in a child
process the hook never sees. Ordinary merges wait for the 00:00/12:00 shuttle.

Decision algorithm (design: engineering/doc/FLY-913-restart-guard-hook/plan.md):

  block patterns (case-insensitive; proven read-only grep/rg segments cannot
  supply a P1/P2 mutating verb, but identifiers are matched against the full
  command so a ps|grep|xargs kill pipeline cannot hide its target; command-
  substitution and rg executable-option forms are never considered proven
  reads):
    P1  launchctl + mutating subcommand (kickstart|bootout|bootstrap|kill|
        stop|unload|load|enable|disable|remove|submit) AND either
        `com.flywheel.` or a restart-script identifier in the same command
        string. Read-only subcommands (print/list/…) never match.
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
    P4  a non-list crontab invocation + either a restart-script identifier or
        `com.flywheel.` in the raw command string. `crontab -l`, including a
        pipe into grep/rg, never matches.
    P5  a Homebrew invocation from a Runner (`FLYWHEEL_EXEC_ID` is present)
        unless it matches the explicit read-only allowlist below. Unknown and
        externally-defined subcommands fail closed. Lead/founder sessions have
        no execution id, so their brew mutations are allowed with an audit row.
    P6  a `gog calendar|cal` or Calendar-scoped `gws` write from any Claude
        session. Known reads and help/version introspection stay allowed;
        unknown Calendar methods fail closed. Before founder enforcement the
        hit is audited as `would_deny`; after a durable receipt it is denied,
        except when every extracted write target is the configured QA calendar.

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
      FLYWHEEL_EXEC_ID                  — Runner-context marker for P5
      ~/.flywheel/calendar-guard/mode + enforce-receipt.json — P6 rollout latch
      ~/.flywheel/qa-calendar-id        — the only agent-writable Calendar target
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
import stat
import subprocess
import sys
import time
from pathlib import Path

# ── Block patterns ────────────────────────────────────────────────────────────
MUTATING_LAUNCHCTL = (
    "kickstart|bootout|bootstrap|kill|stop|unload|load|enable|disable|remove|submit"
)
P1_RE = re.compile(rf"\blaunchctl\b(?:\s+-\S+)*\s+(?:{MUTATING_LAUNCHCTL})\b", re.I)
FLYWHEEL_LABEL_RE = re.compile(r"com\.flywheel\.", re.I)
RESTART_SCRIPT_RE = re.compile(
    r"restart-services|update-flywheel", re.I
)

KILL_RE = re.compile(r"\b(?:pkill|killall|kill)\b", re.I)
PROC_IDENT_RE = re.compile(
    r"run-bridge|claude-lead\.sh|flywheel-bridge-wrapper|flywheel-codex-lead-wrapper"
    r"|restart-services|com\.flywheel",
    re.I,
)
SCHEDULER_RE = re.compile(r"\bcrontab\b", re.I)
SAFE_READ_TOOLS = {"grep", "rg"}
RG_EXECUTABLE_OPTIONS = {"--pre", "--hostname-bin"}
SHELL_EVAL_MARKERS = ("$(", "`", "<(", ">(")

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

BREW_READ_SUBCOMMANDS = {
    "list", "ls", "info", "abv", "deps", "outdated", "doctor", "config",
    "help", "search", "desc", "home", "leaves", "uses", "missing",
    "options", "log", "tap-info", "shellenv",
}
BREW_OPTION_ONLY_NO_VALUE = {"--version", "-v", "--caskroom", "--repository"}
BREW_OPTION_ONLY_OPTIONAL_FORMULA = {"--prefix", "--cellar"}

GOG_GLOBAL_VALUE_FLAGS = {
    "--account", "-a", "--client", "--enable-commands", "--color",
    "--select", "--fields",
}
GOG_GLOBAL_BOOL_FLAGS = {
    "--json", "-j", "--plain", "-p", "--results-only", "--dry-run", "-n",
    "--force", "-y", "--no-input", "--verbose", "-v",
}
GOG_CALENDAR_READ_METHODS = {
    "calendars", "acl", "permissions", "perms", "events", "list", "ls",
    "event", "get", "info", "show", "search", "find", "query", "freebusy",
    "conflicts", "colors", "time", "users", "team", "propose-time",
}
GOG_DIRECT_TARGET_METHODS = {
    "create", "add", "new", "update", "edit", "set", "delete", "rm", "del",
    "remove", "respond", "rsvp", "reply",
}
GOG_OPTIONAL_TARGET_METHODS = {
    "focus-time", "focus", "out-of-office", "ooo", "working-location", "wl",
}
GOG_METHOD_BOOL_FLAGS = {
    "--all-day", "--guests-can-invite", "--guests-can-modify",
    "--guests-can-see-others", "--with-meet", "--dry-run", "-n", "--force",
    "-y", "--no-input", "--json", "-j", "--plain", "-p", "--results-only",
    "--verbose", "-v",
}

GWS_GLOBAL_VALUE_FLAGS = {"--sanitize", "--format", "--api-version"}
GWS_GLOBAL_BOOL_FLAGS = {"--dry-run"}
GWS_CALENDAR_READS = {
    ("+agenda", None),
    ("events", "list"), ("events", "get"), ("events", "instances"),
    ("calendarList", "list"), ("calendarList", "get"),
    ("calendars", "get"), ("acl", "list"), ("colors", "get"),
    ("freebusy", "query"), ("settings", "list"), ("settings", "get"),
}
GWS_EVENTS_TARGET_METHODS = {"insert", "update", "patch", "delete", "quickAdd", "move"}
QA_CALENDAR_ID_RE = re.compile(r"^[A-Za-z0-9._-]+@group\.calendar\.google\.com$")
CALENDAR_VERSION_RE = re.compile(r"^calendar:v\d+$")

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
    "launchctl submit 退出即重拉;crontab 周期重跑;自装 plist 可被配置成重拉 —— "
    "2026-08-14 就是 submit 造成 66 连发重启风暴。\n"
    "正确做法:\n"
    "  • founder 紧急票:bash ~/Dev/flywheel/scripts/request-restart.sh"
    "(投给独立 com.flywheel.updater;发起 Lead 也会换本体)\n"
    "  • 纯 env 改动(无代码 delta)要重启 Bridge:"
    "仍走 request-restart.sh;先确保目标 main 已含配置(FLY-1434)\n"
    "  • 普通 merge 永不即时重启:等待本地 00:00/12:00 班车,不要手动 kickstart。"
)

CMUX_WATCHER_DENY_GUIDANCE = (
    "\ncmux watcher(显示层 sidecar)人肉正门:"
    "bash ~/.flywheel/bin/flywheel-cmux-autostart"
    "(label 缺失才 bootstrap,幂等;Bridge patrol 通常已自动恢复,先 "
    "launchctl print gui/$UID/com.flywheel.cmux-watcher 查看)。"
)

BYPASS_FAIL_REASON = (
    "🚫 Flywheel 部署护栏(FLY-913):bypass 记账失败,拒绝放行。\n"
    "bypass 的放行前置是「审计日志写入成功 + 告警确认送达/入队」缺一不可 —— "
    "本次未全部满足(告警通道或日志路径故障)。\n"
    "请改用 bash ~/Dev/flywheel/scripts/request-restart.sh,"
    "或先修复告警通道后重试;若仍被拦,报告 Lead/founder 人工处理。"
)

BREW_DENY_REASON = (
    "🚫 Flywheel 宿主工具链护栏(FLY-1944):Runner 中的 brew 变更命令已硬拦。\n"
    "tmux/git/node/Homebrew link 等宿主工具是全舰单点;在用版本被无声替换会让所有 "
    "Runner 与 cmux 同时断连。\n"
    "正确做法:用 flywheel-comm ask 报告 Lead,由 Lead/founder 在宿主终端执行并安排验证窗口。"
)

CALENDAR_DENY_REASON = (
    "🚫 founder 日历写入护栏(FLY-2137):检测到 agent 直接调用 gog/gws Calendar 写操作,"
    "已硬拦。\n"
    "唯一获准的自动写入方是 Raya meeting 模块(事件必须带 raya_meeting_id 并有 receipt/审计);"
    "QA 写入必须使用 ~/.flywheel/qa-calendar-id 指定的测试日历,不可写 primary。\n"
    "Calendar 读操作不受限制。确有新写入需求时请通过 Lead 回到 FLY-2137 授权名单公开申请,"
    "agent 会话内没有 ACK/bypass 特批通道。"
)

CALENDAR_CONFIG_ERROR_REASON = (
    "🚫 founder 日历写入护栏(FLY-2137):enforce 批准 receipt 已存在,但 mode 文件缺失或损坏;"
    "为防止静默降级到 audit,本次 Calendar 写操作按 fail-closed 拒绝。\n"
    "请由 Lead/founder 核对 ~/.flywheel/calendar-guard/mode,按留痕授权写入首 token "
    "enforce 或 audit;不要删除 receipt。"
)

CALENDAR_AUDIT_ERROR_REASON = (
    "🚫 founder 日历写入护栏(FLY-2137):写操作审计记账失败;为防止无痕写入,"
    "本次 Calendar 写操作按 fail-closed 拒绝。\n"
    "请由 Lead/founder 修复 ~/.flywheel/logs/restart-guard.log 的路径、权限或磁盘空间后重试。"
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


def _segment_command(tokens: list[str]) -> tuple[str | None, list[str]]:
    """Return the effective command and its args for conservative exemptions.

    This is intentionally narrower than the P3 wrapper walker: an ambiguous
    wrapper flag means "not a proven read", so the guard keeps scanning.
    """
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if ENV_ASSIGN_RE.match(token):
            i += 1
            continue
        base = os.path.basename(token)
        if base not in {"sudo", "env", "command", "time"}:
            return base, tokens[i + 1 :]
        i += 1
        while i < len(tokens) and tokens[i].startswith("-") and tokens[i] != "-":
            flag = tokens[i]
            # env split-string and unknown value-bearing wrapper flags can
            # carry an executable payload. Never classify those as reads.
            if "S" in flag or flag.startswith("--split-string"):
                return None, []
            if flag in _WRAPPER_ARG_FLAGS:
                if i + 1 >= len(tokens):
                    return None, []
                i += 2
            else:
                i += 1
        while i < len(tokens) and ENV_ASSIGN_RE.match(tokens[i]):
            i += 1
    return None, []


def _shell_segments(cmd: str) -> list[list[str]]:
    """Split shell control operators while preserving quoted regex tokens."""
    try:
        lexer = shlex.shlex(cmd, posix=True, punctuation_chars=";&|\n")
        # Newline is a command boundary, not ignorable whitespace.
        lexer.whitespace = " \t\r"
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError:
        # Malformed input gets only the older coarse split; exemptions remain
        # conservative because broken quoting cannot prove a plain read.
        return [seg.split() for seg in SEG_SPLIT_RE.split(cmd) if seg.strip()]
    segments: list[list[str]] = []
    current: list[str] = []
    for token in tokens:
        if token and all(ch in ";&|\n" for ch in token):
            if current:
                segments.append(current)
                current = []
            continue
        current.append(token)
    if current:
        segments.append(current)
    return segments


def _plain_read_tokens(tokens: list[str]) -> bool:
    """True only for source-inspection segments that cannot spawn a payload."""
    rendered = " ".join(tokens)
    if any(marker in rendered for marker in SHELL_EVAL_MARKERS):
        return False
    command, args = _segment_command(tokens)
    if command not in SAFE_READ_TOOLS:
        return False
    # ripgrep currently exposes two options whose values are external programs.
    # Neither the space nor equals form can prove this segment is a plain read.
    if command == "rg" and any(
        a.split("=", 1)[0] in RG_EXECUTABLE_OPTIONS for a in args
    ):
        return False
    return True


def _non_read_segments(cmd: str) -> str:
    """Mask proven read-only segments without hiding adjacent mutations."""
    return " ; ".join(
        " ".join(tokens) for tokens in _shell_segments(cmd)
        if tokens and not _plain_read_tokens(tokens)
    )


def _p4_hit(cmd: str) -> bool:
    """Detect a crontab write while preserving list-mode inspection."""
    if not SCHEDULER_RE.search(cmd) or not (
        RESTART_SCRIPT_RE.search(cmd) or FLYWHEEL_LABEL_RE.search(cmd)
    ):
        return False
    for tokens in _shell_segments(cmd):
        command, args = _segment_command(tokens)
        if command != "crontab":
            continue
        if "-l" in args:
            continue
        return True
    return False


def _brew_args_are_read_only(args: list[str]) -> bool:
    """Recognize only the bounded read grammar approved for Runner sessions."""
    if len(args) == 1 and args[0] in BREW_OPTION_ONLY_NO_VALUE:
        return True
    if (
        1 <= len(args) <= 2
        and args[0] in BREW_OPTION_ONLY_OPTIONAL_FORMULA
        and (len(args) == 1 or not args[1].startswith("-"))
    ):
        return True

    i = 0
    while i < len(args) and args[i].startswith("-"):
        i += 1
    if i >= len(args):
        return False
    subcommand = args[i]
    subcommand_args = args[i + 1 :]
    if subcommand == "analytics":
        return subcommand_args == ["state"]
    return subcommand in BREW_READ_SUBCOMMANDS


def _brew_mutation_hit(cmd: str, depth: int = 0) -> bool:
    """Return True when any shell segment invokes non-read-only Homebrew."""
    if depth > 1:
        return False
    for tokens in _shell_segments(cmd):
        split = _wrapper_split_string_payload(tokens)
        if split is not None:
            split_payload, remainder = split
            if _brew_mutation_hit(split_payload, depth + 1):
                return True
            # `env -S FOO=1 brew install tmux` splits only FOO=1; brew and
            # its arguments remain ordinary env operands. The old `continue`
            # discarded them and silently allowed the mutation.
            tokens = remainder
            if not tokens:
                continue
        command, args = _brew_effective_command(tokens)
        if command in SHELLS:
            payload = _extract_c_payload(args)
            if payload is not None and _brew_mutation_hit(payload, depth + 1):
                return True
            continue
        if command == "brew" and not _brew_args_are_read_only(args):
            return True
    return False


def _strip_global_flags(
    args: list[str], value_flags: set[str], bool_flags: set[str]
) -> tuple[list[str], bool]:
    """Strip known global flags before the service positional.

    Returns (remaining, ambiguous). Unknown/malformed leading flag shapes are
    deliberately ambiguous so a Calendar-looking invocation cannot acquire a
    read or QA exemption through parser confusion.
    """
    i = 0
    while i < len(args) and args[i].startswith("-") and args[i] != "-":
        flag = args[i]
        name = flag.split("=", 1)[0]
        if name in bool_flags:
            i += 1
            continue
        if name in value_flags:
            if "=" in flag:
                if not flag.split("=", 1)[1]:
                    return args[i:], True
                i += 1
                continue
            if i + 1 >= len(args) or args[i + 1].startswith("-"):
                return args[i:], True
            i += 2
            continue
        return args[i:], True
    return args[i:], False


def _first_cli_positional(args: list[str]) -> str | None:
    """Find a method positional without treating option values as targets.

    Unknown flags are assumed value-bearing. That may withhold a QA exemption,
    but can never grant one to an uncertain target.
    """
    i = 0
    while i < len(args):
        token = args[i]
        if token == "--":
            return args[i + 1] if i + 1 < len(args) else None
        if not token.startswith("-"):
            return token
        name = token.split("=", 1)[0]
        if "=" in token or name in GOG_METHOD_BOOL_FLAGS:
            i += 1
        else:
            i += 2
    return None


def _flag_value(args: list[str], wanted: str) -> str | None:
    value = None
    for i, token in enumerate(args):
        if token.startswith(wanted + "="):
            value = token.split("=", 1)[1] or None
        elif token == wanted:
            value = args[i + 1] if i + 1 < len(args) else None
    return value


def _gog_calendar_candidate(args: list[str]) -> dict | None:
    if any(token in {"-h", "--help", "--version"} for token in args):
        return None
    remaining, ambiguous = _strip_global_flags(
        args, GOG_GLOBAL_VALUE_FLAGS, GOG_GLOBAL_BOOL_FLAGS
    )
    if ambiguous:
        if not any(token in {"calendar", "cal"} for token in args):
            return None
        # Scope cannot be proven. Preserve the fail-closed parse contract while
        # making the uncertainty explicit in the audit row.
        return {
            "cli": "gog", "service": "unknown", "method": "unknown",
            "targets": ["unknown"],
        }
    if not remaining:
        return None
    service = remaining[0]
    if service not in {"calendar", "cal"}:
        return None
    method = remaining[1] if len(remaining) > 1 else "unknown"
    if method == "help":
        return None
    if method in GOG_CALENDAR_READ_METHODS:
        return None
    method_args = remaining[2:]
    targets: list[str] = []
    if method in GOG_DIRECT_TARGET_METHODS | GOG_OPTIONAL_TARGET_METHODS:
        target = _first_cli_positional(method_args)
        if target:
            targets = [target]
    return {
        "cli": "gog", "service": "calendar", "method": method,
        "targets": targets or ["unknown"],
    }


def _gws_calendar_candidate(args: list[str]) -> dict | None:
    if any(token in {"-h", "--help", "--version"} for token in args):
        return None
    remaining, ambiguous = _strip_global_flags(
        args, GWS_GLOBAL_VALUE_FLAGS, GWS_GLOBAL_BOOL_FLAGS
    )
    if ambiguous:
        if not any(
            token == "calendar" or CALENDAR_VERSION_RE.fullmatch(token)
            for token in args
        ):
            return None
        return {
            "cli": "gws", "service": "unknown", "method": "unknown",
            "targets": ["unknown"],
        }
    if not remaining:
        return None
    raw_service = remaining[0]
    if raw_service != "calendar" and not CALENDAR_VERSION_RE.fullmatch(raw_service):
        return None
    resource = remaining[1] if len(remaining) > 1 else "unknown"
    if resource == "help":
        return None
    method = remaining[2] if len(remaining) > 2 and not remaining[2].startswith("-") else None
    if method == "help" or (resource, method) in GWS_CALENDAR_READS:
        return None
    method_label = resource if resource.startswith("+") else (
        f"{resource}.{method}" if method else resource
    )
    method_args = remaining[2:] if resource.startswith("+") else remaining[3:]
    targets: list[str] = []
    if resource == "+insert":
        target = _flag_value(method_args, "--calendar")
        if target:
            targets = [target]
    elif resource == "events" and method in GWS_EVENTS_TARGET_METHODS:
        raw_params = _flag_value(method_args, "--params")
        try:
            params = json.loads(raw_params) if raw_params is not None else None
        except Exception:
            params = None
        if isinstance(params, dict):
            calendar_id = params.get("calendarId")
            if isinstance(calendar_id, str) and calendar_id:
                targets.append(calendar_id)
            if method == "move":
                destination = params.get("destination")
                if isinstance(destination, str) and destination:
                    targets.append(destination)
    return {
        "cli": "gws", "service": "calendar", "method": method_label,
        "targets": targets or ["unknown"],
    }


def _calendar_write_candidates(cmd: str, depth: int = 0) -> list[dict]:
    """Return every Calendar write candidate in the Bash command.

    A Bash tool invocation can contain multiple shell segments. QA exemption is
    valid only when every write in the complete invocation targets the QA
    calendar; returning just the first candidate would let a later primary write
    hide behind an earlier QA write.
    """
    if depth > 1:
        return []
    candidates: list[dict] = []
    for tokens in _shell_segments(cmd):
        if not tokens or _plain_read_tokens(tokens):
            continue
        split = _wrapper_split_string_payload(tokens)
        if split is not None:
            payload, remainder = split
            candidates.extend(_calendar_write_candidates(payload, depth + 1))
            tokens = remainder
            if not tokens:
                continue
        command, args = _brew_effective_command(tokens)
        if command in SHELLS:
            payload = _extract_c_payload(args)
            if payload is not None:
                candidates.extend(_calendar_write_candidates(payload, depth + 1))
            continue
        if command == "gog":
            candidate = _gog_calendar_candidate(args)
        elif command == "gws":
            candidate = _gws_calendar_candidate(args)
        else:
            candidate = None
        if candidate is not None:
            candidates.append(candidate)
    return candidates


def _calendar_write_candidate(cmd: str, depth: int = 0) -> dict | None:
    """Aggregate all write candidates into one fail-closed decision record."""
    candidates = _calendar_write_candidates(cmd, depth)
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0]
    targets = [
        target
        for candidate in candidates
        for target in candidate.get("targets", ["unknown"])
    ]
    cli_values = {candidate.get("cli", "unknown") for candidate in candidates}
    method_values = {
        candidate.get("method", "unknown") for candidate in candidates
    }
    return {
        "cli": next(iter(cli_values)) if len(cli_values) == 1 else "multiple",
        "service": "calendar",
        "method": (
            next(iter(method_values)) if len(method_values) == 1 else "multiple"
        ),
        "targets": targets or ["unknown"],
        "candidates": candidates,
    }


def _wrapper_split_string_payload(
    tokens: list[str],
) -> tuple[str, list[str]] | None:
    """Extract an env -S payload and preserve the unconsumed command tail."""
    i = 0
    while i < len(tokens):
        token = tokens[i]
        if ENV_ASSIGN_RE.match(token):
            i += 1
            continue
        base = os.path.basename(token)
        if base not in _WRAPPERS:
            return None
        wrapper = base
        i += 1
        while i < len(tokens) and tokens[i].startswith("-") and tokens[i] != "-":
            flag = tokens[i]
            if flag == "--split-string":
                return (tokens[i + 1], tokens[i + 2 :]) if i + 1 < len(tokens) else None
            if flag.startswith("--split-string="):
                return flag.split("=", 1)[1], tokens[i + 1 :]
            if not flag.startswith("--") and "S" in flag:
                rest = flag[flag.index("S") + 1 :]
                if rest:
                    return rest, tokens[i + 1 :]
                return (tokens[i + 1], tokens[i + 2 :]) if i + 1 < len(tokens) else None
            flag_name = flag.split("=", 1)[0]
            if (
                "=" not in flag
                and flag_name in _BREW_WRAPPER_VALUE_FLAGS.get(wrapper, set())
            ):
                i += 2
            else:
                i += 1
        if wrapper == "timeout" and i < len(tokens):
            i += 1
        elif wrapper in {"nice", "chrt"} and i < len(tokens):
            if re.fullmatch(r"[+-]?\d+", tokens[i]):
                i += 1
        while i < len(tokens) and ENV_ASSIGN_RE.match(tokens[i]):
            i += 1
    return None


_BREW_WRAPPER_VALUE_FLAGS = {
    "sudo": {"-u", "--user", "-g", "--group", "-C", "--chdir", "-p", "--prompt"},
    "env": {"-u", "--unset", "-C", "--chdir", "-P"},
    "nice": {"-n", "--adjustment"},
    "caffeinate": {"-t", "-w"},
    "timeout": {"-k", "--kill-after", "-s", "--signal"},
    "stdbuf": {"-i", "-o", "-e"},
    "ionice": {
        "-c", "--class", "-n", "--classdata", "-p", "--pid",
        "-P", "--pgid", "-u", "--uid",
    },
}


def _brew_effective_command(tokens: list[str]) -> tuple[str | None, list[str]]:
    """Strip the complete transparent-wrapper table for P5.

    `_segment_command` is deliberately narrow because it proves conservative
    read exemptions. P5 has the opposite safety posture: after any known
    transparent wrapper, a brew executable must still be found and judged.
    The bounded wrapper backstop closes unknown/value-bearing flag shapes in
    the same way as P3 without treating an unwrapped `echo brew ...` as code.
    """
    i = 0
    saw_wrapper = False
    wrapper_tail_start: int | None = None
    while i < len(tokens):
        while i < len(tokens) and ENV_ASSIGN_RE.match(tokens[i]):
            i += 1
        if i >= len(tokens):
            return None, []
        base = os.path.basename(tokens[i])
        if base not in _WRAPPERS:
            break
        saw_wrapper = True
        wrapper = base
        i += 1
        if wrapper_tail_start is None:
            wrapper_tail_start = i
        while i < len(tokens) and tokens[i].startswith("-") and tokens[i] != "-":
            flag = tokens[i]
            flag_name = flag.split("=", 1)[0]
            if (
                "=" not in flag
                and flag_name in _BREW_WRAPPER_VALUE_FLAGS.get(wrapper, set())
            ):
                i += 2
            else:
                i += 1
        while i < len(tokens) and ENV_ASSIGN_RE.match(tokens[i]):
            i += 1
        # These wrappers have a required positional control operand before the
        # command. Values are not interpreted; the later wrapper backstop still
        # finds brew if a platform-specific option shape was not enumerated.
        if wrapper == "timeout" and i < len(tokens):
            i += 1  # duration
        elif wrapper in {"nice", "chrt"} and i < len(tokens):
            if re.fullmatch(r"[+-]?\d+", tokens[i]):
                i += 1  # adjustment / scheduling priority

    if i < len(tokens) and os.path.basename(tokens[i]) == "brew":
        return "brew", tokens[i + 1 :]
    if i < len(tokens) and os.path.basename(tokens[i]) in SHELLS:
        return os.path.basename(tokens[i]), tokens[i + 1 :]
    if saw_wrapper and wrapper_tail_start is not None:
        for brew_index in range(wrapper_tail_start, len(tokens)):
            if os.path.basename(tokens[brew_index]) == "brew":
                return "brew", tokens[brew_index + 1 :]
    if i < len(tokens):
        return os.path.basename(tokens[i]), tokens[i + 1 :]
    return None, []


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
                    if payload is not None and _restart_block(payload, depth + 1):
                        return True
                continue
            break
        if i >= len(tokens):
            continue
        first = os.path.basename(tokens[i])
        if first in SHELLS:
            payload = _extract_c_payload(tokens[i + 1 :])
            if payload is not None and _restart_block(payload, depth + 1):
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


def _policy_scan_block(cmd: str, depth: int = 0):
    """Return the matched pattern name (P1/P2/P3/P4/P5/P6) or None. One level of
    shell -c recursion only (depth > 1 stops). Restart authority always wins
    over the narrower Lead/founder Homebrew exemption."""
    block = _restart_block(cmd, depth)
    if block is not None:
        return block
    brew_hit = _brew_mutation_hit(cmd, depth)
    # A Runner brew mutation is an unconditional existing hard deny. It must
    # win over P6 rollout/QA allow paths for a compound Bash command.
    if brew_hit and "FLYWHEEL_EXEC_ID" in os.environ:
        return "P5"
    if _calendar_write_candidate(cmd, depth) is not None:
        return "P6"
    if brew_hit:
        return "P5"
    return None


# FLY-1942: small command IR. Payload words never supply mutating heads.
LABEL_TARGET_RE = re.compile(r'com\.flywheel\.[A-Za-z0-9._-]+', re.I)
PROTECTED_CORE_RE = re.compile(r'^com\.flywheel\.(bridge|lead\..+|updater|cmux-watcher|quota-monitor|qa\.lead\..+)$', re.I)


def _protected_target(target):
    label = os.path.basename(target).removesuffix('.plist')
    if PROTECTED_CORE_RE.fullmatch(label):
        return 'core'
    path = Path(os.path.expanduser(target)) if target.endswith('.plist') else Path(os.environ.get('FLYWHEEL_RESTART_GUARD_LAUNCH_AGENTS_DIR', str(Path.home() / 'Library/LaunchAgents'))) / (target + '.plist')
    try:
        import plistlib
        with path.open('rb') as handle:
            data = plistlib.load(handle)
        for key in ('KeepAlive', 'RunAtLoad', 'StartInterval'):
            if key in data:
                return 'plist_shape:' + key
        return None
    except Exception:
        return 'plist_missing'


def _expansions(text):
    """Extract balanced shell substitutions without executing them."""
    i = 0
    while i < len(text):
        if text[i] == '`':
            end = text.find('`', i + 1)
            if end >= 0:
                yield text[i + 1:end]
                i = end + 1
                continue
        if text[i:i + 2] in ('$(' , '<(', '>('):
            start = i + 2
            level = 1
            i = start
            while i < len(text) and level:
                if text[i] == '(':
                    level += 1
                elif text[i] == ')':
                    level -= 1
                i += 1
            if not level:
                yield text[start:i - 1]
            continue
        i += 1


def _effective_head(tokens):
    i, payloads, wrappers, nohup = 0, [], False, False
    while i < len(tokens):
        token = tokens[i]
        # Reserved words introduce an executable command at this position.
        # They are transparent only at the head, never inside message argv.
        if token in {'do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{', '('}:
            i += 1
            continue
        if ENV_ASSIGN_RE.match(token):
            i += 1
            continue
        base = os.path.basename(token)
        if base == 'cd':
            i += 2
            continue
        if base not in _WRAPPERS:
            break
        wrappers = True
        nohup |= base == 'nohup'
        i += 1
        while i < len(tokens) and tokens[i].startswith('-'):
            flag = tokens[i]
            i += 1
            if base == 'env' and (flag.startswith('--split-string') or (not flag.startswith('--') and 'S' in flag)):
                attached = flag.split('=', 1)[1] if '=' in flag else (flag[flag.index('S') + 1:] if 'S' in flag else '')
                if attached:
                    payloads.append(attached)
                elif i < len(tokens):
                    payloads.append(tokens[i])
                    i += 1
            elif flag in _WRAPPER_ARG_FLAGS | {'-p', '-n'}:
                i += 1
        if base == 'timeout' and i < len(tokens):
            i += 1
    if i >= len(tokens):
        return None, [], payloads, nohup
    if wrappers and os.path.basename(tokens[i]) not in EXECUTORS | SHELLS | {'launchctl', 'kill', 'pkill', 'killall', 'xargs'}:
        # Preserve the established unknown wrapper-operand backstop.
        for j in range(i, len(tokens)):
            if os.path.basename(tokens[j]) in EXECUTORS:
                i = j
                break
    return os.path.basename(tokens[i]), tokens[i + 1:], payloads, nohup


def _parse_ir(cmd):
    heredocs, lines, output, index = {}, cmd.splitlines(keepends=True), [], 0
    while index < len(lines):
        line = lines[index]
        index += 1
        matches = list(re.finditer(r'(?<!<)<<(-?)\s*([\'\"]?)(\w+)\2', line))
        for match in reversed(matches):
            body = []
            while index < len(lines) and lines[index].strip() != match[3]:
                body.append(lines[index].lstrip('\t') if match[1] else lines[index])
                index += 1
            if index < len(lines):
                index += 1
            marker = '__HEREDOC_' + str(len(heredocs)) + '__'
            heredocs[marker] = (''.join(body), bool(match[2]))
            line = line[:match.start()] + ' ' + marker + ' ' + line[match.end():]
        output.append(line)
    source = ''.join(output)
    # shlex removes quote provenance. Mask variable references inside single
    # quotes first so static assignment resolution cannot reinterpret literals.
    variable_ref = re.compile(r'\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)')
    literal_variables, masked, quote, cursor = {}, [], None, 0
    while cursor < len(source):
        char = source[cursor]
        if char == '\\' and quote != "'" and cursor + 1 < len(source):
            escaped = variable_ref.match(source, cursor + 1)
            if escaped:
                marker = '__LITERAL_VAR_' + str(len(literal_variables)) + '__'
                literal_variables[marker] = escaped[0]
                masked.append(marker)
                cursor = escaped.end()
            else:
                masked.append(source[cursor:cursor + 2])
                cursor += 2
            continue
        if quote == "'":
            match = variable_ref.match(source, cursor)
            if match:
                marker = '__LITERAL_VAR_' + str(len(literal_variables)) + '__'
                literal_variables[marker] = match[0]
                masked.append(marker)
                cursor = match.end()
                continue
        if char in ("'", '"'):
            if quote == char:
                quote = None
            elif quote is None:
                quote = char
        masked.append(char)
        cursor += 1
    source = ''.join(masked)
    # Mask substitutions before shlex so their spaces/control operators cannot
    # corrupt the surrounding word or pipeline. Restore their original bytes.
    substitutions = {}
    for payload in list(_expansions(source)):
        for opening, closing in (('$(', ')'), ('<(', ')'), ('>(', ')'), ('`', '`')):
            raw = opening + payload + closing
            if raw in source:
                marker = '__SUB_' + str(len(substitutions)) + '__'
                substitutions[marker] = raw
                source = source.replace(raw, marker)
    # Retain shell quote provenance before shlex removes it. Only complete
    # quoted string portions without expansions qualify as inert data.
    quoted_words, masked, cursor = {}, [], 0
    malformed = False
    while cursor < len(source):
        char = source[cursor]
        if char == '\\' and cursor + 1 < len(source):
            masked.append(source[cursor:cursor + 2])
            cursor += 2
            continue
        if char not in ("'", '"'):
            masked.append(char)
            cursor += 1
            continue
        end = cursor + 1
        while end < len(source):
            if source[end] == '\\' and char == '"':
                end += 2
                continue
            if source[end] == char:
                break
            end += 1
        if end >= len(source):
            malformed = True
            masked.append(source[cursor:])
            break
        value = shlex.split(source[cursor:end + 1])[0]
        marker = '__QUOTED_WORD_' + str(len(quoted_words)) + '__'
        quoted_words[marker] = (value, bool(variable_ref.search(value) or '__SUB_' in value))
        masked.append(marker)
        cursor = end + 1
    source = ''.join(masked)
    lexer = shlex.shlex(source, posix=True, punctuation_chars=';&|\n()')
    lexer.whitespace = ' \t\r'
    lexer.whitespace_split = True
    tokens = []
    try:
        while True:
            token = lexer.get_token()
            if token is None:
                break
            tokens.append(token)
    except ValueError:
        # Keep complete tokens and the unfinished quoted word. An invalid
        # quote must not throw past all guard checks into main's fail-open.
        # Retaining the word (rather than splitting free text) keeps payload
        # arguments distinct from executable command heads.
        if lexer.token:
            tokens.append(lexer.token)
    groups, stages, words, sep = [], [], [], None
    assignments = {}

    def resolve_word(word):
        return variable_ref.sub(lambda m: assignments.get(m[1] or m[2], m[0]), word)

    def finish_stage():
        if not words:
            return
        restored, surface = [], []
        for word in words:
            exposed = word
            for marker, (value, executable) in quoted_words.items():
                exposed = exposed.replace(marker, value if executable else "")
                word = word.replace(marker, value)
            for marker, raw in substitutions.items():
                exposed = exposed.replace(marker, raw)
            surface.append(resolve_word(exposed))
            for marker, raw in substitutions.items():
                word = word.replace(marker, raw)
            restored.append(word)
        literal, quoted, clean = None, True, []
        i = 0
        while i < len(restored):
            word = restored[i]
            if word in heredocs:
                literal, quoted = heredocs[word]
            elif word == '<<<' and i + 1 < len(restored):
                i += 1
                literal, quoted = restored[i], False
            elif word.startswith('<<<'):
                literal, quoted = word[3:], False
            else:
                clean.append(word)
            i += 1
        # Static assignments contribute only through an explicit later variable
        # reference; unrelated prior statements never donate a target.
        if clean and all(ENV_ASSIGN_RE.match(word) for word in clean):
            for word in clean:
                name, value = word.split('=', 1)
                assignments[name] = resolve_word(value)
        clean = [resolve_word(word) for word in clean]
        for index, word in enumerate(clean):
            for marker, literal in literal_variables.items():
                word = word.replace(marker, literal)
            clean[index] = word
        head, args, payloads, nohup = _effective_head(clean)
        kind = head if head in SHELLS | EXECUTORS | {'launchctl', 'kill', 'pkill', 'killall', 'echo', 'printf'} else 'other'
        if head == 'xargs':
            kind = 'xargs'
            i = 0
            while i < len(args) and args[i].startswith('-'):
                flag = args[i]
                i += 1
                if flag in {'-I', '-n', '-P', '-L', '-s', '-E', '-d'}:
                    i += 1
            head, args, extra, nohup = _effective_head(args[i:])
            payloads.extend(extra)
        stages.append(dict(head=head, args=[a for a in args if not any(c.isspace() for c in a)], all_args=args, raw=shlex.join(clean), stdin_literal=literal, quoted=quoted, head_kind=kind, payloads=payloads, nohup=nohup, executable_surface=' '.join(clean if malformed else surface), malformed=malformed))
        words.clear()

    for token in tokens:
        operators = re.findall(r'&&|\|\||;;|[;&|\n()]', token) if token and all(c in ';&|\n()' for c in token) else None
        if operators:
            for operator in operators:
                finish_stage()
                if operator not in {'|', '(', ')'}:
                    if stages:
                        groups.append(dict(pipelines=[dict(stages=stages[:])], sep_before=sep))
                    stages.clear()
                    sep = operator
        else:
            words.append(token)
    finish_stage()
    if stages:
        groups.append(dict(pipelines=[dict(stages=stages)], sep_before=sep))
    return groups


def _static_output(stage):
    args = stage['all_args']
    if stage['head'] == 'echo':
        return ' '.join(args)
    if stage['head'] != 'printf' or not args:
        return None
    def escapes(value):
        return value.replace('\\n', '\n').replace('\\t', '\t').replace('\\\\', '\\')
    fmt, data = args[0], iter(args[1:])
    if '%' not in fmt:
        return escapes(fmt) + '\n'.join(args[1:])
    return escapes(re.sub(r'%([sb%]|.)', lambda m: '%' if m[1] == '%' else next(data, '') if m[1] in 'sb' else '', fmt))


def _pipeline_targets(pipeline, stage):
    # A shell expansion may contain spaces inside a single executable target
    # word; retain that raw label before filtering payload text (FLY-1942).
    candidates = list(stage['args'])
    if stage['head'] in {'kill', 'pkill', 'killall'}:
        # Quoted process regexes and pgrep substitutions are executable kill
        # operands, even though their single shell word contains whitespace.
        candidates.extend(stage['all_args'])
    candidates.extend(a for a in stage['all_args'] if LABEL_TARGET_RE.search(a) and any(marker in a for marker in SHELL_EVAL_MARKERS))
    for upstream in pipeline['stages']:
        if upstream is stage:
            break
        candidates.extend(upstream['args'])
    if stage['stdin_literal'] is not None:
        candidates.extend(stage['stdin_literal'].split())
    return candidates


def _match(pattern, stage, target, protected_by):
    return dict(pattern=pattern, segment=' '.join([stage['head'] or ''] + stage['args'][:3]), target=target, protected_by=protected_by)


def _executable_carrier_payloads(stage):
    """Known code-bearing operands override ordinary quoted-argument exemption."""
    head, args = stage['head'] or '', stage['all_args']
    if head == 'tmux':
        # Resolve the actual subcommand, not a command name inside display text.
        i = 0
        while i < len(args) and args[i].startswith('-'):
            flag = args[i]
            i += 1
            if flag in {'-L', '-S', '-f', '-T'}:
                i += 1
        if i >= len(args):
            return []
        command = args[i]
        aliases = {'send': 'send-keys', 'send-key': 'send-keys', 'run': 'run-shell',
                   'neww': 'new-window', 'new': 'new-session', 'splitw': 'split-window',
                   'respawnp': 'respawn-pane', 'respawnw': 'respawn-window'}
        command = aliases.get(command, command)
        value_flags = {
            'send-keys': {'-t', '-N'},
            'run-shell': {'-t', '-d'},
            'new-window': {'-c', '-e', '-F', '-n', '-t'},
            'new-session': {'-c', '-e', '-f', '-F', '-n', '-s', '-t', '-x', '-y'},
            'split-window': {'-c', '-e', '-F', '-l', '-p', '-t'},
            'respawn-pane': {'-c', '-e', '-t'},
            'respawn-window': {'-c', '-e', '-t'},
            'if-shell': {'-t'},
            'popup': {'-b', '-c', '-d', '-e', '-h', '-s', '-S', '-t', '-T', '-w', '-x', '-y'},
        }
        if command not in value_flags:
            return []
        i += 1
        format_condition = False
        while i < len(args) and args[i].startswith('-'):
            flag = args[i]
            i += 1
            if flag == '--':
                break
            if command == 'if-shell' and not flag.startswith('--') and 'F' in flag:
                format_condition = True
            if flag in value_flags[command]:
                i += 1
        # if-shell's first operand executes in a shell unless -F selects a
        # format expression. Subsequent operands are executable tmux branch
        # commands; the conservative backstop covers their execution payload.
        if command == 'if-shell' and format_condition:
            i += 1
        return [' '.join(args[i:])]
    if head in {'watch', 'parallel'}:
        return [' '.join(args)]
    if head == 'trap':
        return [next((a for a in args if not a.startswith('-')), '')]
    if head in {'su', 'script'}:
        payload = _extract_c_payload(args)
        if payload is not None:
            return [payload]
        if head == 'script':
            first = next((i for i, a in enumerate(args) if not a.startswith('-')), len(args))
            return [' '.join(args[first + 1:])]
        return []
    if head == 'ssh':
        i = 0
        while i < len(args) and args[i].startswith('-'):
            flag = args[i]
            i += 1
            if flag in {'-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'}:
                i += 1
        return [' '.join(args[i + 1:])]
    if head == 'find':
        payloads = []
        for i, arg in enumerate(args):
            if arg in {'-exec', '-execdir', '-ok', '-okdir'}:
                payload = []
                for value in args[i + 1:]:
                    if value in {';', '+'}:
                        break
                    payload.append(value)
                payloads.append(' '.join(payload))
        return payloads
    # Inline interpreter programs are executable, including print-only programs:
    # Lead ruling 27252ba2 requires the conservative regex layer on their code.
    if re.fullmatch(r'(?:python|pypy)[0-9.]*', head):
        flags = {'-c'}
    elif head in {'perl', 'ruby', 'node', 'nodejs', 'bun', 'deno', 'osascript'}:
        flags = {'-e', '-E', '--eval', '--print', '-p'}
    elif head == 'php':
        flags = {'-r'}
    else:
        return []
    payloads = []
    for i, arg in enumerate(args):
        for flag in flags:
            if arg == flag and i + 1 < len(args):
                payloads.append(args[i + 1])
            elif arg.startswith(flag + '='):
                payloads.append(arg[len(flag) + 1:])
            elif len(flag) == 2 and arg.startswith(flag) and len(arg) > 2:
                payloads.append(arg[2:])
    return payloads


def _legacy_executable_match(code, stage):
    """Active regex backstop, restricted to executable surfaces (27252ba2).

    IR remains the first layer. Unknown unquoted stages fail closed; well-formed
    quoted message/document arguments were removed by the provenance-aware lexer.
    """
    if P1_RE.search(code):
        script = RESTART_SCRIPT_RE.search(code)
        if script:
            return _match('P1', stage, script[0], 'restart_script')
        plist_paths = re.findall(r"[^\s'\"]+\.plist", code)
        label_code = code
        for path in plist_paths:
            label_code = label_code.replace(path, "")
        targets = plist_paths + LABEL_TARGET_RE.findall(label_code)
        for target in targets:
            protected = _protected_target(target)
            if protected:
                return _match('P1', stage, target, protected)
    if KILL_RE.search(code) and PROC_IDENT_RE.search(code):
        return _match('P2', stage, PROC_IDENT_RE.search(code)[0], 'core')
    if _p3_hit(code, 1):
        return _match('P3', stage, 'run-bridge', 'core')
    return None


def _restart_scan(cmd, depth=0):
    if depth > 1:
        return None
    for group in _parse_ir(cmd):
        for pipeline in group['pipelines']:
            previous = None
            for stage in pipeline['stages']:
                head, args = stage['head'], stage['all_args']
                if stage['stdin_literal'] is None and previous:
                    stage['stdin_literal'] = _static_output(previous)
                payloads = list(stage['payloads'])
                payloads.extend(p for word in [stage['raw']] for p in _expansions(word))
                literal = stage['stdin_literal']
                if literal is not None and not stage['quoted']:
                    payloads.extend(_expansions(literal))
                if head in SHELLS:
                    payload = _extract_c_payload(args)
                    if payload is not None:
                        payloads.append(payload)
                    elif literal is not None:
                        payloads.append(literal)
                elif head == 'eval':
                    payloads.append(' '.join(args))
                elif head in EXECUTORS and literal is not None:
                    payloads.append(literal)
                if head == 'rg':
                    for i, arg in enumerate(args):
                        if arg.split('=', 1)[0] in RG_EXECUTABLE_OPTIONS:
                            if '=' in arg:
                                payloads.append(arg.split('=', 1)[1])
                            elif i + 1 < len(args):
                                payloads.append(args[i + 1])
                targets = _pipeline_targets(pipeline, stage)
                if head == 'launchctl' and 'submit' in args and '--' in args:
                    nested = args[args.index('--') + 1:]
                    payloads.append(shlex.join(nested))
                    targets.extend(a for a in nested if not any(c.isspace() for c in a))
                    nested_head, nested_args, _, _ = _effective_head(nested)
                    if nested_head in SHELLS:
                        payload = _extract_c_payload(nested_args)
                        if payload:
                            # submit is a command carrier, not an extra shell
                            # evaluation level; scan its shell payload directly.
                            payloads.append(payload)
                            for nested_group in _parse_ir(payload):
                                for nested_pipeline in nested_group['pipelines']:
                                    for nested_stage in nested_pipeline['stages']:
                                        targets.extend(nested_stage['args'])
                for payload in payloads:
                    hit = _restart_scan(payload, depth + 1)
                    if hit:
                        return hit
                subcommand = next((a for a in stage['args'] if not a.startswith('-')), None)
                if head == 'launchctl' and subcommand in MUTATING_LAUNCHCTL.split('|'):
                    for token in targets:
                        if RESTART_SCRIPT_RE.search(token):
                            return _match('P1', stage, token, 'restart_script')
                        candidates = [token] if token.endswith('.plist') else LABEL_TARGET_RE.findall(token)
                        for target in candidates:
                            protected = _protected_target(target)
                            if protected:
                                return _match('P1', stage, target, protected)
                if head in {'kill', 'pkill', 'killall'}:
                    for target in targets:
                        if PROC_IDENT_RE.search(target):
                            return _match('P2', stage, target, 'core')
                if head in EXECUTORS or stage['nohup']:
                    for target in stage['args'] + ([head] if stage['nohup'] else []):
                        if RUN_BRIDGE_RE.search(target):
                            return _match('P3', stage, target, 'core')
                # Lead-approved second layer: executable stage text + known
                # code payloads, not arbitrary quoted messages/documents.
                surfaces = _executable_carrier_payloads(stage)
                if not _plain_read_tokens([head or ''] + args):
                    surfaces.append(stage['executable_surface'])
                # Existing shell/env/eval/rg expansion edges are executable too.
                surfaces.extend(payloads)
                if literal is not None and not stage['quoted']:
                    surfaces.append(literal)
                for surface in surfaces:
                    hit = _legacy_executable_match(surface, stage)
                    if hit:
                        return hit
                previous = stage
    if _p4_hit(cmd):
        return dict(pattern='P4', segment='crontab', target='scheduler', protected_by='restart_script')
    return None


def _restart_block(cmd: str, depth: int = 0):
    hit = _restart_scan(cmd, depth)
    return hit['pattern'] if hit else None


def _scan(cmd: str, depth: int = 0):
    hit = _restart_scan(cmd, depth)
    if hit:
        return hit
    pattern = _policy_scan_block(cmd, depth)
    return dict(pattern=pattern, segment='', target='', protected_by='') if pattern else None


def scan_block(cmd: str, depth: int = 0):
    hit = _scan(cmd, depth)
    return hit['pattern'] if hit else None


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


# ── P6 calendar rollout / QA state ──────────────────────────────────────────
def _calendar_guard_dir() -> Path:
    return Path.home() / ".flywheel" / "calendar-guard"


def _calendar_mode_state() -> tuple[bool, str]:
    """Return (receipt_exists, audit|enforce|invalid).

    Before the immutable founder receipt exists, rollout is audit regardless
    of a stray mode file. Once it exists, missing/unknown mode is invalid and
    therefore denied by the caller; deletion can never silently disable P6.
    """
    root = _calendar_guard_dir()
    receipt_exists = (root / "enforce-receipt.json").exists()
    if not receipt_exists:
        return False, "audit"
    try:
        tokens = (root / "mode").read_text().split()
        mode = tokens[0] if tokens else ""
    except Exception:
        return True, "invalid"
    return (True, mode) if mode in {"audit", "enforce"} else (True, "invalid")


def _qa_calendar_id() -> str | None:
    try:
        value = (Path.home() / ".flywheel" / "qa-calendar-id").read_text().strip()
    except Exception:
        return None
    if value == "primary" or not QA_CALENDAR_ID_RE.fullmatch(value):
        return None
    return value


def _calendar_qa_exempt(candidate: dict) -> bool:
    qa_id = _qa_calendar_id()
    targets = candidate.get("targets")
    return bool(
        qa_id
        and isinstance(targets, list)
        and targets
        and all(isinstance(target, str) and target == qa_id for target in targets)
    )


# ── Accounting ────────────────────────────────────────────────────────────────
LOG_MAX_BYTES = 10 * 1024 * 1024
LOG_RETENTION = 3
LOG_LOCK_STALE_SECONDS = 5 * 60


def _rotation_lock_identity(path: Path) -> tuple[int, int, int]:
    observed = path.lstat()
    return observed.st_dev, observed.st_ino, observed.st_mtime_ns


def _acquire_rotation_lock(lock: Path) -> bool:
    try:
        lock.mkdir()
        return True
    except Exception:
        pass
    try:
        observed_stat = lock.lstat()
        if not stat.S_ISDIR(observed_stat.st_mode) or lock.is_symlink():
            return False
        age_ns = time.time_ns() - observed_stat.st_mtime_ns
        if age_ns < LOG_LOCK_STALE_SECONDS * 1_000_000_000:
            return False
        observed = (
            observed_stat.st_dev,
            observed_stat.st_ino,
            observed_stat.st_mtime_ns,
        )
    except Exception:
        return False

    quarantine = lock.with_name(
        f"{lock.name}.stale.{os.getpid()}.{time.time_ns()}"
    )
    moved = False
    try:
        os.replace(lock, quarantine)
        moved = True
        if _rotation_lock_identity(quarantine) != observed:
            if not os.path.lexists(lock):
                os.replace(quarantine, lock)
                moved = False
            return False
        lock.mkdir()
        try:
            quarantine.rmdir()
        except Exception:
            pass
        return True
    except Exception:
        if moved and not os.path.lexists(lock):
            try:
                os.replace(quarantine, lock)
            except Exception:
                pass
        return False


def rotate_log_if_needed(path: Path) -> None:
    """Best-effort rename rotation for a log opened separately per append."""
    lock = path.with_name(path.name + ".rotate.lock")
    try:
        stat_result = path.lstat()
        if path.is_symlink() or not path.is_file() or stat_result.st_size < LOG_MAX_BYTES:
            return
    except Exception:
        return
    if not _acquire_rotation_lock(lock):
        return
    try:
        stat_result = path.lstat()
        if path.is_symlink() or not path.is_file() or stat_result.st_size < LOG_MAX_BYTES:
            return
        path.with_name(f"{path.name}.{LOG_RETENTION}").unlink(missing_ok=True)
        for generation in range(LOG_RETENTION, 1, -1):
            prior = path.with_name(f"{path.name}.{generation - 1}")
            if prior.exists() and not prior.is_symlink():
                os.replace(prior, path.with_name(f"{path.name}.{generation}"))
        os.replace(path, path.with_name(f"{path.name}.1"))
    except Exception:
        pass
    finally:
        try:
            lock.rmdir()
        except Exception:
            pass


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
        rotate_log_if_needed(p)
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
    # Missing attribution must stay explicit; never impersonate an engineering
    # Lead merely because the hook inherited no canonical Lead projection.
    lead = os.environ.get("FLYWHEEL_LEAD_ID") or "system"
    lead_unknown = lead == "system"
    argv = argv0 + [
        "--lead", lead,
        "--project", project,
        "--kind", "restart_guard_bypass",
        "--severity", "severe",
        "--signature", make_signature(cmd),
        "--strict-delivery",
        "--title", "Restart-guard BYPASS used",
        "--body", f"lead_unknown={str(lead_unknown).lower()}\nreason: {reason}\ncommand: {cmd[:800]}",
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
        calendar_candidate = _calendar_write_candidate(cmd)
        match = _scan(cmd)
        pattern = match["pattern"] if match else None
    except Exception:
        return 0  # judgment failure only — never reached once a hit is known
    if not pattern and calendar_candidate is None:
        return 0

    # ── Hit: the only exits below are deny or a fully-accounted bypass. ──────
    base_rec = {
        "ts": time.time(),
        "session_id": data.get("session_id"),
        "cwd": data.get("cwd"),
        "pattern": pattern,
        "match": match,
        "command": cmd[:COMMAND_AUDIT_CAP],
    }
    if calendar_candidate is not None:
        # P6 has no bypass/ACK path and is evaluated independently from the
        # winning P1-P5 pattern. Otherwise a bypassed co-located mutation could
        # carry an enforce-mode Calendar write through the same Bash command.
        candidate = calendar_candidate
        receipt_exists, mode = _calendar_mode_state()
        calendar_rec = {
            **base_rec,
            "pattern": "P6",
            "mode": mode,
            "cli": candidate.get("cli"),
            "service": candidate.get("service"),
            "method": candidate.get("method"),
            "targets": candidate.get("targets", ["unknown"]),
        }
        if _calendar_qa_exempt(candidate):
            if not audit_write(
                {**calendar_rec, "decision": "allow", "note": "qa_calendar"}
            ):
                deny(CALENDAR_AUDIT_ERROR_REASON)
                return 0
            if pattern == "P6":
                return 0
        elif not receipt_exists or mode == "audit":
            if not audit_write({**calendar_rec, "decision": "would_deny"}):
                deny(CALENDAR_AUDIT_ERROR_REASON)
                return 0
            if pattern == "P6":
                return 0
        elif mode == "enforce":
            audit_write({**calendar_rec, "decision": "deny"})
            deny(CALENDAR_DENY_REASON)
            return 0
        else:
            audit_write(
                {
                    **calendar_rec,
                    "decision": "deny",
                    "note": "mode_invalid_with_receipt",
                }
            )
            deny(CALENDAR_CONFIG_ERROR_REASON)
            return 0

    if pattern == "P5" and "FLYWHEEL_EXEC_ID" not in os.environ:
        audit_write({**base_rec, "decision": "allow", "note": "lead_or_founder"})
        return 0

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
    deny(
        BREW_DENY_REASON
        if pattern == "P5"
        else DENY_REASON
        + "\nmatched: " + " ".join(f"{key}={value}" for key, value in match.items())
        + (
            CMUX_WATCHER_DENY_GUIDANCE
            if pattern == "P1" and "com.flywheel.cmux-watcher" in cmd.lower()
            else ""
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
