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


def _restart_block(cmd: str, depth: int = 0):
    """Return a restart/scheduler pattern P1-P4, excluding brew policy."""
    if depth > 1:
        return None
    non_read_cmd = _non_read_segments(cmd)
    if P1_RE.search(non_read_cmd) and (
        FLYWHEEL_LABEL_RE.search(cmd) or RESTART_SCRIPT_RE.search(cmd)
    ):
        return "P1"
    if KILL_RE.search(non_read_cmd) and PROC_IDENT_RE.search(cmd):
        return "P2"
    if _p3_hit(cmd, depth):
        return "P3"
    if _p4_hit(cmd):
        return "P4"
    return None


def scan_block(cmd: str, depth: int = 0):
    """Return the matched pattern name (P1/P2/P3/P4/P5) or None. One level of
    shell -c recursion only (depth > 1 stops). Restart authority always wins
    over the narrower Lead/founder Homebrew exemption."""
    block = _restart_block(cmd, depth)
    if block is not None:
        return block
    if _brew_mutation_hit(cmd, depth):
        return "P5"
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
    deny(BREW_DENY_REASON if pattern == "P5" else DENY_REASON)
    return 0


if __name__ == "__main__":
    sys.exit(main())
