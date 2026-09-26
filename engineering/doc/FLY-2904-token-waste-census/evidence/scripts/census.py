#!/usr/bin/env python3
"""FLY-2904: 14-day token ledger for Claude + Codex on this host (read-only).

Window: T0 inclusive .. T1 exclusive (UTC), same frozen window as FLY-2893.
Reads (read-only):
  ~/.claude/projects/**/*.jsonl                         Claude transcripts (+ subagents/)
  ~/.flywheel/codex-homes*/**, ~/.codex*/{sessions,archived_sessions}/**  Codex rollouts
  ~/.flywheel/teamlead.db (mode=ro)                     execution / session / review-job roster
  ~/.flywheel/state/codex-sessions/<exec>/session.json  Codex exec -> threadId
Writes only ../raw/*.csv|json: per-file aggregates, per-request rows WITHOUT content,
tool-output size rows (sizes + a coarse command class, never the command text).

Token conventions
  Claude: total = input + cache_creation + cache_read + output (message.id dedup, global).
  Codex : total_token_usage.total_tokens cumulative -> window deltas (counter drop = new
          segment from 0, FLY-2889 rule). input_tokens INCLUDES cached_input_tokens.
"""
import collections
import csv
import datetime as dt
import glob
import hashlib
import importlib.util
import json
import os
import re
import sqlite3
import sys

H = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "raw")
T0 = dt.datetime(2026, 9, 11, 22, tzinfo=dt.timezone.utc)
T1 = dt.datetime(2026, 9, 25, 22, tzinfo=dt.timezone.utc)
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

# Reuse FLY-2749's external-input classifier verbatim (fixed vocabulary, no free text).
_spec = importlib.util.spec_from_file_location(
    "m2749", os.path.join(HERE, "../../../FLY-2749-notification-suppression/measure-usage.py"))
m2749 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(m2749)
_external_kind_2749 = m2749.external_kind
FOUNDER_DISCORD_ID = "1138241636057481306"
KNOWN_TAGS = {"patrol_tick", "summary_due", "self-wakeup", "session-cron"}


def external_kind(content):
    """FLY-2749 classifier, extended for Bridge mailbox batches (fixed output vocabulary)."""
    text = content if isinstance(content, str) else "\n".join(
        b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text") \
        if isinstance(content, list) else ""
    if "[mailbox-batch " not in text[:200]:
        k = _external_kind_2749(content)
        if k == "task_notification":
            return "task_notification:monitor" if "Monitor event" in text else "task_notification:background"
        return k
    hdr = re.search(r"\| (\d+) messages? \| from ([^\]]+)\]", text)
    n = int(hdr.group(1)) if hdr else 1
    src = hdr.group(2) if hdr else ""
    body = text.split("dead-lettered.", 1)[-1].strip()
    if src == "founder" or f'user_id="{FOUNDER_DISCORD_ID}"' in text:
        return "founder_or_mixed_with_founder"
    if n > 1:
        return "multi_message_batch"
    if "plugin:discord" in body[:80]:
        u = re.search(r' user="([^"]*)"', body)
        name = u.group(1) if u else ""
        if name == "flywheel-alerts-dispatcher":
            return "discord:alerts_dispatcher"
        if name.endswith("-cron"):
            return "discord:cron"
        return "discord:other_bot_or_lead"
    m = re.match(r"\[(infra_alert|patrol_tick|summary_due)\]", body)
    if m and m.group(1) == "infra_alert":
        sev = re.search(r"severity=(\w+)", body)
        return "infra_alert:" + ("info" if sev and sev.group(1) == "info" else "warn_or_higher")
    if m:
        return m.group(1)
    return _external_kind_2749(body)


def ts_of(v):
    if not v:
        return None
    try:
        t = dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None
    return t if t.tzinfo else None


def slug(p):
    return re.sub(r"[^a-zA-Z0-9]", "-", p)


def alert_key(content):
    """Short hash of the normalized alert title (digits / issue ids folded) -> repeat detection
    without storing alert text."""
    text = content if isinstance(content, str) else "\n".join(
        b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text") \
        if isinstance(content, list) else ""
    body = text.split("dead-lettered.", 1)[-1].strip()
    if "<channel" in body[:40]:
        body = body.split(">", 1)[1] if ">" in body else body
        body = re.sub(r"<@\d+>|&lt;@\d+>|\*|`", "", body).strip()
    title = body.split("\n", 1)[0]
    title = re.sub(r"\d+", "N", title)
    return hashlib.sha1(title.encode()).hexdigest()[:10]


# ---------------------------------------------------------------- roster
db = sqlite3.connect(f"file:{H}/.flywheel/teamlead.db?mode=ro", uri=True)
EXEC = {}
for eid, run, node, att, vendor, model, created in db.execute(
        "select execution_id, run_id, node_id, attempt, vendor, model, created_at from workflow_execution_runtime"):
    EXEC[eid] = dict(run=run, node=node, attempt=att, vendor=vendor, model=model, created=created)
SESS = {}
for eid, issue, status, term, role in db.execute(
        "select execution_id, issue_identifier, status, terminal_at, session_role from sessions"):
    SESS[eid] = dict(issue=issue, status=status, terminal=term, role=role)
REVIEW = {}
for uid, rtype, rnd, issue, st in db.execute(
        "select reviewer_session_uuid, review_type, round, issue_id, status from codex_review_job "
        "where reviewer_session_uuid is not null"):
    r = REVIEW.setdefault(uid, dict(type=rtype, jobs=0, max_round=0, issue=issue))
    r["jobs"] += 1
    r["max_round"] = max(r["max_round"], rnd or 0)
THREAD2EXEC = {}
for sj in glob.glob(f"{H}/.flywheel/state/codex-sessions/*/session.json"):
    try:
        j = json.load(open(sj))
    except (ValueError, OSError):
        continue
    if j.get("threadId"):
        THREAD2EXEC[j["threadId"]] = os.path.basename(os.path.dirname(sj))


def terminal_of(eid):
    s = SESS.get(eid) or {}
    t = s.get("terminal")
    if not t:
        return None
    t = t.strip().replace(" ", "T")
    if not t.endswith("Z") and "+" not in t[10:]:
        t += "Z"
    return ts_of(t)


# ---------------------------------------------------------------- classify
LEAD_RE = re.compile(r"^-Users-xiaorongli--flywheel-lead-workspace-(.+)$")
WT_RE = re.compile(r"^(?:-private-tmp-claude-501-)?-Users-xiaorongli-Dev-flywheel-(FLY-\d+)")
SLOT_LEAD_RE = re.compile(r"^-private-tmp-flywheel-test-slot-\d+-(?:extra-leads-slot-\d+-)?lead-workspace")
SLOT_PROJ_RE = re.compile(r"^-private-tmp-flywheel-test-slot-\d+-")


def claude_bucket(proj, stem, exec_id):
    """-> (bucket, sub)  bucket is coarse 'who uses it'."""
    m = LEAD_RE.match(proj)
    if m:
        return "lead", m.group(1)
    if SLOT_LEAD_RE.match(proj):
        return "qa_env", "test-slot lead"
    if SLOT_PROJ_RE.match(proj) or re.match(r"^-private-tmp-(qa|fly|f27|c27|claude-501-fly)", proj) \
            or proj.startswith("-private-var-folders-"):
        return "qa_env", "qa/test sandbox"
    if stem in REVIEW:
        return "review", "claude-review:" + REVIEW[stem]["type"]
    if exec_id and exec_id in EXEC:
        return "runner", "claude:" + EXEC[exec_id]["node"]
    if WT_RE.match(proj) or proj.startswith("-Users-xiaorongli-Dev-flywheel-"):
        return "runner", "claude:unmapped-worktree"
    if proj.startswith("-private-tmp-claude-501--Users-xiaorongli--flywheel-lead-workspace-"):
        return "lead", "scratchpad"
    return "other", proj.replace("-Users-xiaorongli", "~")[:60]


# ---------------------------------------------------------------- tool classes
# Proxy for "a call that is only waiting": it matches a wait pattern and none of the work
# markers below (heredocs, builds/tests, any git, gh other than checks/watch, scripts, file
# writes, state-changing flywheel-comm verbs). A finite blacklist cannot prove a call does
# nothing else, so the resulting set is reported as a proxy, not as proven pure waiting.
WAIT_RE = re.compile(
    r"(?:^|[;&|(\s\"'])sleep\s+\d|\buntil\b[^\n]*;\s*do\b|\bwhile\b[^\n]*;\s*do\b"
    r"|(?:flywheel-comm|dist/index\.js)[\"']?\s+(?:--\S+\s+\S+\s+)*(?P<fc>turn|check|inbox|status)\b"
    r"|(?P<gh>\bgh\s+(?:pr\s+checks|run\s+watch)\b)")
WORK_RE = re.compile(
    r"<<|\b(?:pnpm|npm|yarn|npx|vitest|jest|pytest|tsc|biome|make|cargo)\b"
    r"|\bgit\b|\bgh\s+(?!pr\s+checks\b|run\s+watch\b)[a-z]+|\bnode\s+-e\b|\bnode\s+(?!\S*dist/index\.js)\S"
    r"|apply_patch|\*\*\* Begin Patch|\bpython3?\b"
    r"|\bsed\s+-i|(?:^|\s)(?:cp|mv|rm|mkdir|tee|touch)\s|>\s*[\w~/.$]"
    r"|\bgh\s+(?:pr|issue)\s+(?:create|merge|edit|comment|close)"
    r"|(?:flywheel-comm|dist/index\.js)[\"']?\s+(?:--\S+\s+\S+\s+)*(?:complete|ask|respond|progress|stage|publish-report|gate)\b")


def cmd_class(name, inp):
    if name != "Bash":
        return name
    c = (inp or {}).get("command", "") if isinstance(inp, dict) else ""
    w = WAIT_RE.search(c)
    if w:
        if WORK_RE.search(c) or len(c) > 1500:
            return "bash:mixed-with-wait"  # a wait primitive plus other work: not counted as polling
        kind = w.group("fc") or ("gh-watch" if w.group("gh") else "sleep-loop")
        return "wait:" + kind
    fc = re.search(r"(?:flywheel-comm|dist/index\.js)[\"']?\s+(?:--\S+\s+\S+\s+)*([a-z][a-z-]+)", c)
    if fc:
        sub = fc.group(1)
        return "bash:flywheel-comm:" + (sub if sub in {
            "turn", "check", "inbox", "progress", "stage", "ask", "gate", "complete", "respond",
            "await-codex-gate", "publish-report", "status"} else "other")
    if re.search(r"\bapply_patch\b|\*\*\* Begin Patch", c):
        return "bash:apply_patch"
    rules = [
        (r"\b(pnpm|npm|yarn)\b[^|;&]*\b(test|vitest)\b|\bvitest\b|\bjest\b|\bpytest\b", "bash:test"),
        (r"\b(pnpm|npm)\b[^|;&]*\b(build|lint|typecheck|tsc)\b|\btsc\b|\bbiome\b", "bash:build/lint"),
        (r"\bgit\s+(diff|show|log)\b", "bash:git diff/log/show"),
        (r"\bgh\s+(pr|api|run|issue)\b", "bash:gh"),
        (r"flywheel-comm|dist/index\.js", "bash:flywheel-comm"),
        (r"\bsqlite3\b", "bash:sqlite"),
        (r"\b(cat|sed|head|tail|less|grep|rg|find|ls|jq|wc)\b", "bash:read/search"),
        (r"\bcurl\b", "bash:curl"),
        (r"\bpython3?\b|\bnode\b", "bash:script"),
        (r"codex-companion|codex-with-fallback|\bcodex\b", "bash:codex"),
    ]
    for pat, lab in rules:
        if re.search(pat, c):
            return lab
    return "bash:other"


def content_chars(c):
    if isinstance(c, str):
        return len(c)
    if isinstance(c, list):
        n = 0
        for b in c:
            if isinstance(b, dict):
                if b.get("type") == "text":
                    n += len(b.get("text", ""))
                elif b.get("type") == "image":
                    n += 6000  # ~1.5k tokens per image, rough
                else:
                    n += len(json.dumps(b))
        return n
    return 0


def attribute_outputs(outs, ctxs, prev_out, clean, in_window):
    """Per tool output -> (in-context tokens or None, later in-window requests re-reading it).

    in-context tokens come from the measured context growth of the request that first sees
    the outputs (ctx[i] - ctx[i-1] - output tokens of request i-1), split across the outputs
    pending before request i in proportion to their characters, and capped at 1 token per
    character. If anything else entered the context in between (external input, compaction,
    session restart) the growth cannot be attributed and the result is None (unknown)."""
    by_i = collections.defaultdict(list)
    for o in outs:
        by_i[o[0]].append(o)
    res = []
    for i, lst in by_i.items():
        known = 0 < i < len(ctxs) and clean[i] and ctxs[i] >= 0.6 * max(ctxs[i - 1], 1)
        grow = max(0, ctxs[i] - ctxs[i - 1] - prev_out[i - 1]) if known else 0
        tot_ch = sum(o[3] for o in lst) or 1
        n = 0
        for j in range(i, len(ctxs)):
            if j > i and ctxs[j] < 0.6 * max(ctxs[j - 1], 1):
                break
            n += 1 if in_window[j] else 0
        for o in lst:
            res.append((o, min(round(grow * o[3] / tot_ch), o[3]) if known else None, n))
    return res


# ---------------------------------------------------------------- Claude pass
def claude_pass():
    files = [f for f in glob.glob(f"{H}/.claude/projects/**/*.jsonl", recursive=True)
             if os.path.getmtime(f) >= T0.timestamp()]
    seen = set()
    req_out = open(os.path.join(RAW, "claude_requests.csv"), "w", newline="")
    rw = csv.writer(req_out, lineterminator="\n")
    rw.writerow(["file_id", "bucket", "sub", "subagent", "ts", "model", "input", "cache_creation",
                 "cache_read", "output", "ctx", "turn_kind", "turn_seq", "req_in_turn", "trigger",
                 "alert_key", "calls_tools"])
    tool_out = open(os.path.join(RAW, "claude_tool_outputs.csv"), "w", newline="")
    tw = csv.writer(tool_out, lineterminator="\n")
    tw.writerow(["file_id", "bucket", "sub", "subagent", "ts", "tool_class", "chars", "in_ctx_tokens",
                 "later_requests_same_ctx"])
    fl_out = open(os.path.join(RAW, "claude_files.csv"), "w", newline="")
    fw = csv.writer(fl_out, lineterminator="\n")
    fw.writerow(["file_id", "session", "bucket", "sub", "subagent", "exec_id", "node", "issue", "requests",
                 "tokens", "first_ctx", "min_ctx", "max_ctx", "compactions", "external_turns",
                 "tokens_after_terminal", "review_jobs", "review_max_round"])
    stats = collections.Counter()
    stem_exec = {}  # main transcript sorts before its subagents/ dir ('.' < '/')
    for fid, f in enumerate(sorted(files)):
        rel = os.path.relpath(f, f"{H}/.claude/projects")
        parts = rel.split(os.sep)
        proj = parts[0]
        subagent = "/subagents/" in f
        stem = os.path.splitext(parts[-1])[0]
        parent_stem = parts[1] if subagent and len(parts) > 2 else stem
        exec_id = None
        rows = []
        tools = []  # (idx_of_next_request, ts, class, chars)
        tool_names = {}
        local = {}
        ext_pending = False
        turn_kind, turn_seq, req_in_turn, turn_key = "session_start", 0, 0, ""
        compactions = 0
        ext_turns = 0
        try:
            fh = open(f, errors="replace")
        except OSError:
            continue
        with fh:
            for line in fh:
                if exec_id is None and '"prompt_snapshot"' in line:
                    m = re.search(r"--exec-id (" + UUID + ")", line)
                    if m:
                        exec_id = m.group(1)
                if '"type":"assistant"' not in line and '"type":"user"' not in line \
                        and '"type": "assistant"' not in line and '"type": "user"' not in line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    stats["parse_error"] += 1
                    continue
                t = ts_of(o.get("timestamp", ""))
                msg = o.get("message") if isinstance(o.get("message"), dict) else {}
                if o.get("type") == "user":
                    c = msg.get("content", "")
                    is_tool = isinstance(c, list) and any(isinstance(b, dict) and b.get("type") == "tool_result" for b in c)
                    if is_tool:
                        for b in c:
                            if isinstance(b, dict) and b.get("type") == "tool_result":
                                cls = tool_names.get(b.get("tool_use_id"), "unknown")
                                tools.append([len(rows), t, cls, content_chars(b.get("content"))])
                    else:
                        ext_pending = True
                        k = external_kind(c)
                        tkey = alert_key(c) if k.startswith(("infra_alert", "discord:alerts")) else ""
                        if k == "inherited_compaction_summary":
                            compactions += 1
                        elif not (o.get("isMeta") or o.get("isCompactSummary")):
                            turn_kind, req_in_turn, turn_key = k, 0, tkey
                            turn_seq += 1
                            if t and T0 <= t < T1:
                                ext_turns += 1
                    continue
                if o.get("type") != "assistant":
                    continue
                for b in msg.get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        tool_names[b.get("id")] = cmd_class(b.get("name"), b.get("input"))
                u = msg.get("usage")
                if not isinstance(u, dict) or msg.get("model") == "<synthetic>" or t is None:
                    continue
                key = msg.get("id") or o.get("requestId") or o.get("uuid")
                vals = [int(u.get(k) or 0) for k in ("input_tokens", "cache_creation_input_tokens",
                                                     "cache_read_input_tokens", "output_tokens")]
                ctx = vals[0] + vals[1] + vals[2]
                calls = any(isinstance(b, dict) and b.get("type") == "tool_use" for b in msg.get("content") or [])
                if key in local:
                    # one API response is written as several lines (one per content block);
                    # the last line carries the final usage -> overwrite, count once.
                    stats["same_message_extra_lines"] += 1
                    rows[local[key]][2:7] = [*vals, ctx]
                    rows[local[key]][12] = rows[local[key]][12] or int(calls)
                    continue
                if key in seen:
                    stats["cross_file_dup"] += 1
                    continue
                seen.add(key)
                local[key] = len(rows)
                req_in_turn += 1
                parts = {x[2] for x in tools if x[0] == len(rows)}
                if ext_pending or not parts:
                    parts.add("(external)" if ext_pending else "(first/continue)")
                ext_pending = False
                trig = "+".join(sorted(parts))
                rows.append([t, msg.get("model", "?"), *vals, ctx, turn_kind, turn_seq, req_in_turn, trig, turn_key,
                             int(calls)])
        if exec_id and not subagent:
            stem_exec[stem] = exec_id
        if subagent and not exec_id:
            exec_id = stem_exec.get(parent_stem)
        if not rows:
            continue
        bucket, sub = claude_bucket(proj, parent_stem, exec_id)
        node = EXEC.get(exec_id, {}).get("node", "") if exec_id else ""
        issue = SESS.get(exec_id, {}).get("issue", "") if exec_id else ""
        term = terminal_of(exec_id) if exec_id else None
        in_win = [r for r in rows if T0 <= r[0] < T1]
        # tool output re-read: number of later requests before the context drops by >40%
        ctxs = [r[6] for r in rows]
        clean = ["(external)" not in r[10] for r in rows]
        inwin = [T0 <= r[0] < T1 for r in rows]
        for (i, tt, cls, ch), in_ctx, n in attribute_outputs(tools, ctxs, [r[5] for r in rows], clean, inwin):
            if tt is None or not (T0 <= tt < T1):
                continue
            tw.writerow([fid, bucket, sub, int(subagent), tt.strftime("%Y-%m-%dT%H:%M:%SZ"), cls, ch,
                         "" if in_ctx is None else in_ctx, n])
        for r in in_win:
            rw.writerow([fid, bucket, sub, int(subagent), r[0].strftime("%Y-%m-%dT%H:%M:%SZ"), r[1],
                         *r[2:6], r[6], r[7], r[8], r[9], r[10], r[11], r[12]])
        tot = sum(sum(r[2:6]) for r in in_win)
        after = sum(sum(r[2:6]) for r in in_win if term and r[0] > term + dt.timedelta(minutes=2))
        rv = REVIEW.get(parent_stem, {})
        fw.writerow([fid, parent_stem, bucket, sub, int(subagent), exec_id or "", node, issue, len(in_win), tot,
                     rows[0][6], min(ctxs), max(ctxs), compactions, ext_turns, after,
                     rv.get("jobs", ""), rv.get("max_round", "")])
        stats["files_with_rows"] += 1
    for h in (req_out, tool_out, fl_out):
        h.close()
    return stats


# ---------------------------------------------------------------- Codex pass
def codex_home_label(p):
    h = re.split(r"/(?:sessions|archived_sessions)/", p)[0].replace(H + "/", "")
    h = re.sub(UUID, "<exec>", h)
    return h


def codex_bucket(home, cwd, originator, thread):
    eid = THREAD2EXEC.get(thread)
    if home.startswith(".flywheel/codex-homes/agents/"):
        role = home.split("/")[-1]
        return "runner", "codex:" + role, eid
    if home.startswith(".flywheel/codex-homes/<exec>") or home.startswith(".flywheel/codex-homes-exp"):
        node = EXEC.get(eid, {}).get("node", "?") if eid else "?"
        return "runner", "codex:" + node, eid
    if home.startswith(".flywheel/voice"):
        return "voice", "codex:voice", eid
    m = re.match(r"\.codex-(mufasa|raya|infra-bot|honeylemon)", home)
    if m:
        return "lead", "codex-lead:" + m.group(1), eid
    if eid:
        return "runner", "codex:" + EXEC.get(eid, {}).get("node", "?"), eid
    if "flywheel-test-slot" in cwd or cwd.startswith("/private/tmp/qa") or "/var/folders/" in cwd:
        return "qa_env", "codex:qa/test sandbox", eid
    if re.search(r"/Dev/flywheel-FLY-\d+", cwd):
        return "review", "codex-companion (runner-invoked)", eid
    if "/.flywheel/lead-workspace/" in cwd:
        return "lead", "codex-companion (lead-invoked)", eid
    return "other", "codex:" + home + ":" + (originator or "?"), eid


def codex_pass():
    roots = [f"{H}/.flywheel/codex-homes", f"{H}/.flywheel/codex-homes-exp"] + \
        glob.glob(f"{H}/.codex*/sessions") + glob.glob(f"{H}/.codex*/archived_sessions") + \
        glob.glob(f"{H}/.codex*/profiles/*/sessions") + [f"{H}/.flywheel/voice/codex-home"]
    seen_names = set()
    rq = open(os.path.join(RAW, "codex_requests.csv"), "w", newline="")
    rw = csv.writer(rq, lineterminator="\n")
    rw.writerow(["file_id", "bucket", "sub", "ts", "delta_total", "delta_input", "delta_cached",
                 "delta_output", "ctx_last_input", "turn", "trigger"])
    fo = open(os.path.join(RAW, "codex_files.csv"), "w", newline="")
    fw = csv.writer(fo, lineterminator="\n")
    fw.writerow(["file_id", "bucket", "sub", "home", "originator", "exec_id", "node", "issue", "requests",
                 "tokens", "input", "cached", "output", "first_ctx", "min_ctx", "max_ctx", "compactions",
                 "turns", "first_turn_tokens", "tokens_after_terminal"])
    to = open(os.path.join(RAW, "codex_tool_outputs.csv"), "w", newline="")
    tw = csv.writer(to, lineterminator="\n")
    tw.writerow(["file_id", "bucket", "sub", "ts", "tool_class", "chars", "in_ctx_tokens", "later_requests_same_ctx"])
    stats = collections.Counter()
    fid = 0
    for root in roots:
        for dp, _, fn in os.walk(root):
            for n in fn:
                mm = re.match(rf"rollout-.*-({UUID})\.jsonl$", n)
                if not mm or n in seen_names:
                    continue
                p = os.path.join(dp, n)
                try:
                    if os.path.getmtime(p) < T0.timestamp():
                        continue
                except OSError:
                    continue
                seen_names.add(n)
                thread = mm.group(1)
                home = codex_home_label(p)
                cwd, originator = "", ""
                prev = None
                prev_parts = None
                turn = -1
                comp = 0
                rows = []
                calls, outs = {}, []
                ext_pending = False
                with open(p, errors="replace") as fh:
                    for line in fh:
                        if '_call' in line[:200] and '"response_item"' in line[:120]:
                            try:
                                r = json.loads(line)
                            except ValueError:
                                continue
                            pl = r.get("payload") or {}
                            ty = pl.get("type", "")
                            if ty in ("custom_tool_call", "function_call"):
                                arg = pl.get("input") or pl.get("arguments") or ""
                                calls[pl.get("call_id")] = cmd_class("Bash", {"command": arg if isinstance(arg, str) else json.dumps(arg)})
                            elif ty in ("custom_tool_call_output", "function_call_output"):
                                o_ = pl.get("output")
                                ch = content_chars(o_) if isinstance(o_, (str, list)) else len(json.dumps(o_))
                                outs.append((len(rows), ts_of(r.get("timestamp", "")), calls.get(pl.get("call_id"), "unknown"), ch))
                            continue
                        if ('"user_message"' in line[:200]) or ('"role":"user"' in line[:300] and '"response_item"' in line[:120]):
                            ext_pending = True
                            continue
                        if '"session_meta"' in line and not cwd:
                            try:
                                pl = json.loads(line).get("payload") or {}
                                cwd, originator = pl.get("cwd", ""), pl.get("originator", "")
                            except ValueError:
                                pass
                            continue
                        if '"compacted"' in line[:120]:
                            comp += 1
                            continue
                        if '"task_started"' in line:
                            turn += 1
                            continue
                        if '"token_count"' not in line:
                            continue
                        try:
                            r = json.loads(line)
                        except ValueError:
                            continue
                        pl = r.get("payload") or {}
                        info = pl.get("info")
                        if pl.get("type") != "token_count" or not info:
                            continue
                        t = ts_of(r.get("timestamp", ""))
                        tu = info.get("total_token_usage") or {}
                        lu = info.get("last_token_usage") or {}
                        tot = tu.get("total_tokens") or 0
                        parts = (tu.get("input_tokens") or 0, tu.get("cached_input_tokens") or 0,
                                 tu.get("output_tokens") or 0)
                        if prev is None or tot < prev:
                            d, dparts = tot, parts
                        else:
                            d = tot - prev
                            dparts = tuple(a - b for a, b in zip(parts, prev_parts))
                        prev, prev_parts = tot, parts
                        if d == 0 or t is None:
                            continue
                        tparts = {x[2] for x in outs if x[0] == len(rows)}
                        if ext_pending or not tparts:
                            tparts.add("(external)" if ext_pending else "(first/continue)")
                        ext_pending = False
                        trig = "+".join(sorted(tparts))
                        rows.append((t, d, *dparts, lu.get("input_tokens") or 0, max(turn, 0), trig))
                in_win = [r for r in rows if T0 <= r[0] < T1]
                if not in_win:
                    continue
                bucket, sub, eid = codex_bucket(home, cwd, originator, thread)
                node = EXEC.get(eid, {}).get("node", "") if eid else ""
                issue = SESS.get(eid, {}).get("issue", "") if eid else ""
                term = terminal_of(eid) if eid else None
                for r in in_win:
                    rw.writerow([fid, bucket, sub, r[0].strftime("%Y-%m-%dT%H:%M:%SZ"), *r[1:]])
                allctx = [r[5] for r in rows]
                clean = ["(external)" not in r[7] for r in rows]
                inwin = [T0 <= r[0] < T1 for r in rows]
                for (i, tt, cls, ch), in_ctx, n in attribute_outputs(outs, allctx, [r[4] for r in rows], clean, inwin):
                    if tt is None or not (T0 <= tt < T1):
                        continue
                    tw.writerow([fid, bucket, sub, tt.strftime("%Y-%m-%dT%H:%M:%SZ"), cls, ch,
                                 "" if in_ctx is None else in_ctx, n])
                ctxs = [r[5] for r in rows if r[5]]
                first_turn = sum(r[1] for r in in_win if r[6] == 0)
                after = sum(r[1] for r in in_win if term and r[0] > term + dt.timedelta(minutes=2))
                fw.writerow([fid, bucket, sub, home, originator, eid or "", node, issue, len(in_win),
                             sum(r[1] for r in in_win), sum(r[2] for r in in_win), sum(r[3] for r in in_win),
                             sum(r[4] for r in in_win), ctxs[0] if ctxs else 0, min(ctxs) if ctxs else 0,
                             max(ctxs) if ctxs else 0, comp, turn + 1, first_turn, after])
                fid += 1
                stats["codex_files"] += 1
    rq.close()
    fo.close()
    to.close()
    return stats


if __name__ == "__main__":
    os.makedirs(RAW, exist_ok=True)
    frozen = dt.datetime.now(dt.timezone.utc)
    which = sys.argv[1:] or ["claude", "codex"]
    out = {"T0": T0.isoformat(), "T1": T1.isoformat(), "captured_at": frozen.isoformat()}
    if "codex" in which:
        out["codex"] = dict(codex_pass())
    if "claude" in which:
        out["claude"] = dict(claude_pass())
    json.dump(out, open(os.path.join(RAW, "freeze-" + "-".join(which) + ".json"), "w"), indent=1)
    print(out)
