#!/usr/bin/env python3
"""PreToolUse hook (matcher: SendMessage): a Flywheel Lead may not message a
Runner through the native Agent Team mailbox (FLY-3083).

The only Lead → Runner path is `flywheel-comm send` (ordinary messages) /
`flywheel-comm respond` (gate answers): every message gets a CommDB id, a
delivered_at audit stamp and a Runner-visible `[lead-instruction <id>]` prefix.
A native `SendMessage to:"runner-…"` writes the same inbox file with none of
that (2026-09-29: a dozen such messages, zero CommDB rows). This hook denies it
at the tool boundary and hands the Lead a shell-safe replacement command.

Decision algorithm (design: engineering/doc/FLY-3083-lead-runner-mailbox-only/plan.md §Chunk 2):

  judgment path — fail-open, exit 0 with no output:
    stdin not JSON / not an object / tool_name != "SendMessage" /
    tool_input not an object / `to` not a string;
    FLYWHEEL_RUNNER_MSG_GUARD == "0" (QA / rollback switch);
    FLYWHEEL_LEAD_ID unset or empty (not a Flywheel Lead session).

  normalize(to) — judged by the FINAL inbox file name, not the spelling:
    name  = to.strip() minus a trailing ` [<hex>]` ref suffix
    canon = sanitize(name).lower()
      sanitize mirrors stock claude-code `sanitizePathComponent`
      (tasks.ts:217; repo mirror packages/agent-team-transport/src/path-helpers.ts
      `sanitizePathComponent`, used by `getClaudeInboxPath`). The JS regex has no
      `u` flag, so it replaces per UTF-16 code unit: a non-BMP character (a
      surrogate pair) becomes TWO `-`. Python iterates code points, so that is
      spelled out below. A lone surrogate from json.loads has ord <= 0xFFFF and
      becomes one `-`, same as JS. `.lower()`: the deployment disk (APFS) is
      case-insensitive, so `Runner-42AFA86C.json` is the canonical file.
      Drift guard: fly3083-runner-alias-oracle.test.ts (agent-team-transport).

  hit A: canon matches ^runner-[0-9a-f]{8}$ → deny; the replacement command
         always uses canon (the lowercase mailbox name `send --to` resolves).
  hit B: name == "*" (native broadcast writes every member's inbox, Runners
         included) → deny in every Flywheel Lead session. The hook never reads
         the team roster: a roster exemption races a Runner registering between
         the hook's read and the native send.

  Every exit after a hit is a deny; a failure while composing the reason
  still denies with a short fallback reason. The audit line is best-effort
  and never changes the decision. No bypass syntax exists; the only switch is
  FLYWHEEL_RUNNER_MSG_GUARD=0.

Dependencies: python3 stdlib only.
Env:  FLYWHEEL_LEAD_ID              — sending Lead id (also marks a Lead session)
      FLYWHEEL_COMM_CLI             — flywheel-comm dist/index.js for the command
      FLYWHEEL_RUNNER_MSG_GUARD     — "0" disables the hook
      FLYWHEEL_RUNNER_MSG_GUARD_LOG — audit log override; default
                                      <FLYWHEEL_STATE_DIR|~/.flywheel>/logs/runner-msg-guard.log
Deployed to: <FLYWHEEL_STATE_DIR|~/.flywheel>/bin/flywheel-runner-msg-guard.py
             via scripts/hooks/install-runner-msg-guard.sh (Lead-local settings).
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
import time
from pathlib import Path

RUNNER_RE = re.compile(r"^runner-[0-9a-f]{8}$")
REF_SUFFIX_RE = re.compile(r"\s+\[[0-9a-f]+\]$")
SAFE_CHAR_RE = re.compile(r"[A-Za-z0-9_-]")
MAX_INLINE_BODY = 4000
BODY_PLACEHOLDER = "<在此粘贴原文>"


def sanitize(value: str) -> str:
    """Mirror of stock sanitizePathComponent, per UTF-16 code unit."""
    return "".join(
        c if SAFE_CHAR_RE.fullmatch(c) else ("--" if ord(c) > 0xFFFF else "-")
        for c in value
    )


def classify(to: str) -> tuple[str | None, str]:
    """Return (kind, canon): kind is "runner", "broadcast" or None."""
    name = REF_SUFFIX_RE.sub("", to.strip())
    if name == "*":
        return "broadcast", "*"
    canon = sanitize(name).lower()
    if RUNNER_RE.match(canon):
        return "runner", canon
    return None, canon


def cli_prefix() -> list[str]:
    cli = os.environ.get("FLYWHEEL_COMM_CLI", "")
    return ["node", cli] if cli else ["flywheel-comm"]


REASON_TAIL = (
    "\n\n回答 Runner 的 gate 用 `flywheel-comm respond`(命令在收件箱信封里)。"
    "`send --json` 的 `transport_write`:ok = 已写进 Runner 传输层(不是消费确认);"
    "skipped + backend_commdb = 回滚模式正常;skipped + no_transport = 该 Runner 后端无传输;"
    "error = 即时传输失败。通道故障按 Runner 通道契约的故障分支表处理,"
    "**不要**换回 SendMessage 或其他旁路。"
)


def runner_reason(lead: str, canon: str, message) -> str:
    head = (
        f"FLY-3083:SendMessage 给 Runner({canon})已被拦下——它不留 CommDB 账、没有编号、"
        "丢了没人知道。给 Runner 发消息只有一条路:flywheel-comm send。"
    )
    if not isinstance(message, str):
        return (
            head
            + "\n\n这是 Agent Team 协议消息(shutdown / plan_approval 等),"
            "Runner 不走 Agent Team 协议消息,没有可替代的命令;"
            "要让 Runner 停下或改方向,用 flywheel-comm send 发一条普通指令。"
            + REASON_TAIL
        )
    too_long = len(message) > MAX_INLINE_BODY
    body = BODY_PLACEHOLDER if too_long else message
    command = shlex.join(
        cli_prefix() + ["send", "--from", lead, "--to", canon, "--", body]
    )
    if too_long:
        note = (
            f"\n\n正文过长(>{MAX_INLINE_BODY} 字符),下面的命令用了占位符,"
            "**不能直接运行**——请把原文粘贴到占位符处(保持单引号引用)后再运行:"
        )
    else:
        note = "\n\n改用下面的命令(正文已完整、按 shell 安全方式引用,可直接运行):"
    return head + note + "\n```bash\n" + command + "\n```" + REASON_TAIL


def broadcast_reason(lead: str) -> str:
    template = shlex.join(
        cli_prefix()
        + ["send", "--from", lead, "--to", "<runner-队名>", "--", "<正文>"]
    )
    return (
        "FLY-3083:SendMessage 广播(to:\"*\")在 Flywheel Lead 会话里一律拦下——"
        "广播会写进每个 Runner 的收件箱,绕过 CommDB。"
        "要给 Runner 发,逐个 Runner 用 flywheel-comm send(下面是模板,"
        "把 <runner-队名> 换成真实队名、<正文> 换成原文);"
        "非 Runner 队友仍可逐个点名 SendMessage。\n```bash\n"
        + template
        + "\n```"
        + REASON_TAIL
    )


def audit_path() -> Path:
    override = os.environ.get("FLYWHEEL_RUNNER_MSG_GUARD_LOG")
    if override:
        return Path(override)
    base = os.environ.get("FLYWHEEL_STATE_DIR") or os.path.join(
        os.path.expanduser("~"), ".flywheel"
    )
    return Path(base) / "logs" / "runner-msg-guard.log"


def audit_write(record: dict) -> None:
    try:
        path = audit_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=True) + "\n")
    except Exception:
        pass  # best-effort: never changes the decision


def deny(reason: str) -> None:
    # ensure_ascii keeps stdout encodable whatever the locale or lone
    # surrogates in the message; the JSON consumer decodes the escapes.
    print(
        json.dumps(
            {
                "hookSpecificOutput": {
                    "hookEventName": "PreToolUse",
                    "permissionDecision": "deny",
                    "permissionDecisionReason": reason,
                }
            },
            ensure_ascii=True,
        )
    )


def main() -> int:
    # ── Judgment path: fail-open. Any parse problem = silent allow. ──────────
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except Exception:
        return 0
    if not isinstance(data, dict) or data.get("tool_name") != "SendMessage":
        return 0
    tool_input = data.get("tool_input")
    if not isinstance(tool_input, dict):
        return 0
    to = tool_input.get("to")
    if not isinstance(to, str):
        return 0
    if os.environ.get("FLYWHEEL_RUNNER_MSG_GUARD") == "0":
        return 0
    lead = os.environ.get("FLYWHEEL_LEAD_ID", "")
    if not lead:
        return 0
    try:
        kind, canon = classify(to)
    except Exception:
        return 0
    if kind is None:
        return 0

    # ── Hit: every exit below is a deny. ─────────────────────────────────────
    message = tool_input.get("message")
    try:
        reason = (
            broadcast_reason(lead)
            if kind == "broadcast"
            else runner_reason(lead, canon, message)
        )
    except Exception:
        reason = (
            "FLY-3083:SendMessage 给 Runner 已被拦下。给 Runner 发消息只有一条路:"
            "flywheel-comm send --from <你的 lead id> --to <runner 队名> -- <正文>。"
        )
    audit_write(
        {
            "ts": time.time(),
            "session_id": data.get("session_id"),
            "cwd": data.get("cwd"),
            "lead_id": lead,
            "to": to[:200],
            "canon": canon,
            "kind": kind,
            "message_type": type(message).__name__,
            "message_len": len(message) if isinstance(message, str) else None,
            "decision": "deny",
        }
    )
    deny(reason)
    return 0


if __name__ == "__main__":
    sys.exit(main())
