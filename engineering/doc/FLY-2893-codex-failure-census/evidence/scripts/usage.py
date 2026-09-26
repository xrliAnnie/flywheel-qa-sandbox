#!/usr/bin/env python3
"""FLY-2893: per-execution token timeline facts from raw Codex rollouts / Claude transcripts.

Read-only. Inputs: ../raw/executions.csv, ../raw/freeze.json (from collect.py).
Outputs (counts and timestamps only; no message content, no paths):
  ../raw/exec_tokens.csv   one row per execution
  ../raw/codex_quota_fingerprints.csv   account-week fingerprints for the %-of-week estimate

Codex: ~/.flywheel/state/codex-sessions/<exec>/session.json threadId -> rollout-*-<threadId>.jsonl
(the locate + cumulative-difference rules are copied from FLY-2889 scripts/usage.py; a
counter drop starts a new segment from 0). Only rows with timestamp <= frozen_at are read.
Claude: transcript under ~/.claude/projects/<worktree slug>/ whose prompt_snapshot carries
"--exec-id <id>" (FLY-2889 rule). Only first assistant timestamp and totals are used.

Per execution:
  first_token_ts       first Codex token_count / Claude assistant message at or after created_at - 5 s
  tokens_total         all tokens up to the freeze
  tokens_until_cut     tokens with ts <= cut, cut = terminal_at + 2 min (freeze if not terminal)
  tokens_after_cut     tokens with ts  > cut (post-terminal consumption, S6)
  first_turn_tokens    tokens of the first task_started..task_complete turn (Codex only)
"""
import collections
import csv
import datetime as dt
import glob
import json
import os
import re

H = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "raw")
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
CUT_GRACE = dt.timedelta(minutes=2)


def parse_ts(v):
    if not v:
        return None
    v = v.strip().replace(" ", "T")
    if not v.endswith("Z") and "+" not in v[10:]:
        v += "Z"
    try:
        return dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None


def iso(t):
    return t.strftime("%Y-%m-%dT%H:%M:%SZ") if t else ""


_ROLL = None


def rollout_index():
    global _ROLL
    if _ROLL is None:
        _ROLL = collections.defaultdict(list)
        for root in (f"{H}/.flywheel/codex-homes", f"{H}/.flywheel/codex-homes-exp"):
            for dp, _, fn in os.walk(root):
                for n in fn:
                    m = re.match(rf"rollout-.*-({UUID})\.jsonl$", n)
                    if m:
                        _ROLL[m.group(1)].append(os.path.join(dp, n))
    return _ROLL


def codex_files(eid):
    st = f"{H}/.flywheel/state/codex-sessions/{eid}/session.json"
    tid = None
    if os.path.exists(st):
        try:
            tid = json.load(open(st)).get("threadId")
        except ValueError:
            tid = None
    if tid and rollout_index().get(tid):
        uniq = {}
        for f in rollout_index()[tid]:  # same native thread copied into two homes: count once
            uniq.setdefault(os.path.basename(f), f)
        return "state_thread", sorted(uniq.values())
    per = glob.glob(f"{H}/.flywheel/codex-homes/{eid}/*sessions/**/rollout-*.jsonl", recursive=True)
    if per:
        return "per_exec_home", per
    return ("state_without_rollout" if tid else "no_state"), []


def codex_events(files, frozen):
    """Yield (ts, delta_total, turn_index, used_pct, resets_minute) in file order."""
    for f in files:
        prev = None
        turn = -1
        with open(f, errors="replace") as fh:
            for line in fh:
                if '"token_count"' not in line and '"task_started"' not in line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                p = r.get("payload") or {}
                ts = parse_ts(r.get("timestamp"))
                if ts is None or ts > frozen:
                    continue
                if r.get("type") == "event_msg" and p.get("type") == "task_started":
                    turn += 1
                    continue
                if r.get("type") != "event_msg" or p.get("type") != "token_count" or not p.get("info"):
                    continue
                total = ((p["info"].get("total_token_usage") or {}).get("total_tokens")) or 0
                delta = total if prev is None or total < prev else total - prev
                prev = total
                rl = (p.get("rate_limits") or {}).get("primary") or {}
                weekly = rl.get("window_minutes") == 10080
                yield (ts, delta, max(turn, 0),
                       rl.get("used_percent") if weekly else None,
                       int(rl.get("resets_at") or 0) // 60 if weekly else None)


TAIL_BYTES = 400_000


def transcript_error(eid):
    """Last upstream [error] line and final 'run ended' status from the adapter transcript."""
    f = f"{H}/.flywheel/state/codex-sessions/{eid}/transcript.log"
    if not os.path.exists(f):
        return "", "", ""
    with open(f, "rb") as fh:
        fh.seek(max(0, os.path.getsize(f) - TAIL_BYTES))
        tail = fh.read().decode("utf8", "replace")
    info = msg = ""
    for m in re.finditer(r"^\[error\] (\{.*\})$", tail, re.M):
        try:
            er = json.loads(m.group(1)).get("error") or {}
        except ValueError:
            continue
        ci = er.get("codexErrorInfo")
        info = ci if isinstance(ci, str) else (next(iter(ci)) if isinstance(ci, dict) and ci else "")
        msg = re.sub(r"\s+", " ", er.get("message") or "")[:160]
    ended = re.findall(r"── run ended: (\w+)", tail)
    return info, msg, ended[-1] if ended else ""


def last_assistant(files, frozen):
    last = ""
    for f in files:
        with open(f, errors="replace") as fh:
            for line in fh:
                if '"assistant"' not in line or '"response_item"' not in line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                p = r.get("payload") or {}
                ts = parse_ts(r.get("timestamp"))
                if p.get("type") == "message" and p.get("role") == "assistant" and ts and ts <= frozen:
                    txt = " ".join(c.get("text", "") for c in p.get("content", []) if isinstance(c, dict))
                    if txt.strip():
                        last = txt
    last = re.sub(r"<oai-mem-citation>.*", "", last, flags=re.S)
    return re.sub(r"\s+", " ", last).replace(H, "~")[:200]


def home_label(path):
    """CODEX_HOME that owns a rollout, as a short label (no absolute paths)."""
    p = path.replace(H, "~")
    p = p.split("/sessions/")[0]
    p = p.replace("~/.flywheel/codex-homes/", "")
    if re.fullmatch(UUID, p):
        return "per_exec_home"
    return p


def slug(p):
    return re.sub(r"[^a-zA-Z0-9]", "-", p)


def claude_files(eid, worktree):
    out = []
    if not worktree:
        return out
    needle = "--exec-id " + eid
    for p in {worktree, os.path.realpath(worktree)}:
        for f in glob.glob(f"{H}/.claude/projects/{slug(p)}/*.jsonl"):
            with open(f, errors="replace") as fh:
                for line in fh:
                    if '"prompt_snapshot"' in line and needle in line:
                        out.append(f)
                        break
    return sorted(set(out))


def claude_events(files, frozen):
    seen = {}
    for f in files:
        with open(f, errors="replace") as fh:
            for line in fh:
                if '"assistant"' not in line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if r.get("type") != "assistant":
                    continue
                m = r.get("message") or {}
                u = m.get("usage") or {}
                ts = parse_ts(r.get("timestamp"))
                if not u or m.get("model") == "<synthetic>" or ts is None or ts > frozen:
                    continue
                tot = sum((u.get(k) or 0) for k in ("input_tokens", "output_tokens",
                                                    "cache_read_input_tokens",
                                                    "cache_creation_input_tokens"))
                seen[(f, m.get("id") or r.get("uuid"))] = (ts, tot)
    for ts, tot in sorted(seen.values()):
        yield ts, tot


def main():
    freeze = json.load(open(os.path.join(RAW, "freeze.json")))
    frozen = parse_ts(freeze["frozen_at"])
    execs = list(csv.DictReader(open(os.path.join(RAW, "executions.csv"))))
    worktrees = {}
    import sqlite3
    db = sqlite3.connect(f"file:{H}/.flywheel/teamlead.db?mode=ro", uri=True)
    worktrees = dict(db.execute("select execution_id, coalesce(worktree_binding_path, worktree_path) from sessions"))

    fp = collections.defaultdict(lambda: {"tokens": 0, "min": None, "max": None, "series": []})
    rows = []
    errs = []
    stats = collections.Counter()
    for e in execs:
        eid, vendor = e["execution_id"], e["vendor"]
        created = parse_ts(e["created_at"])
        term = parse_ts(e["terminal_at"])
        cut = (term + CUT_GRACE) if term else frozen
        first = last = None
        total = until = after = first_turn = 0
        if vendor == "codex":
            how, files = codex_files(eid)
            evs = list(codex_events(files, frozen)) if files else []
            for ts, d, turn, pct, rkey in evs:
                if ts < created - dt.timedelta(seconds=5):
                    continue
                first = first or ts
                last = ts
                total += d
                if ts <= cut:
                    until += d
                else:
                    after += d
                if turn == 0:
                    first_turn += d
        else:
            files = claude_files(eid, worktrees.get(eid))
            how = "prompt_snapshot" if files else "none"
            for ts, d in claude_events(files, frozen):
                if ts < created - dt.timedelta(seconds=5):
                    continue
                first = first or ts
                last = ts
                total += d
                if ts <= cut:
                    until += d
                else:
                    after += d
        if vendor == "codex":
            info, msg, ended = transcript_error(eid)
            says = last_assistant(files, frozen) if (ended == "blocked" or e["session_status"] == "blocked") and files else ""
            errs.append([eid, info, msg, ended, says])
        stats[(vendor, how if (vendor == "claude" or files) else "missing:" + how)] += 1
        home = home_label(files[0]) if vendor == "codex" and files else ""
        thread = ""
        if vendor == "codex" and files:
            m = re.search(rf"({UUID})\.jsonl$", files[0])
            thread = m.group(1) if m else ""
        rows.append([eid, vendor, how, home, thread, iso(first), iso(last), total, until, after, first_turn])
    with open(os.path.join(RAW, "exec_tokens.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["execution_id", "vendor", "locate", "codex_home", "thread", "first_token_ts", "last_token_ts",
                    "tokens_total", "tokens_until_cut", "tokens_after_cut", "first_turn_tokens"])
        w.writerows(rows)
    with open(os.path.join(RAW, "codex_errors.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["execution_id", "error_info", "error_message", "run_ended", "blocked_last_message"])
        w.writerows(errs)
    # Account-week fingerprints over EVERY rollout on this host (all Codex homes, incl.
    # Leads / reviews), not just census executions: counting only census tokens would
    # understate tokens-per-percent and overstate the %-of-week estimate.
    t0 = parse_ts(freeze["T0"])
    roots = [f"{H}/.flywheel/codex-homes", f"{H}/.flywheel/codex-homes-exp"] + glob.glob(f"{H}/.codex*/sessions")
    seen_names = set()
    activity = set()
    n_files = 0
    for root in roots:
        for dp_, _, fn in os.walk(root):
            for n in fn:
                if not re.match(rf"rollout-.*-{UUID}\.jsonl$", n) or n in seen_names:
                    continue
                p = os.path.join(dp_, n)
                if os.path.getmtime(p) < t0.timestamp():
                    continue
                seen_names.add(n)
                n_files += 1
                hl = home_label(p)
                thread = re.search(rf"({UUID})\.jsonl$", n).group(1)
                for ts, d, _turn, pct, rkey in codex_events([p], frozen):
                    if ts < t0:
                        continue
                    if d > 0:
                        activity.add((hl, thread, ts.strftime("%Y-%m-%dT%H:%MZ")))
                    if rkey is None:
                        continue
                    f = fp[rkey]
                    f["tokens"] += d
                    f["series"].append((ts, pct, d))
                    f["min"] = pct if f["min"] is None else min(f["min"], pct)
                    f["max"] = pct if f["max"] is None else max(f["max"], pct)
    print("fingerprint rollout files:", n_files)
    with open(os.path.join(RAW, "codex_home_activity.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["codex_home", "thread", "minute"])
        w.writerows(sorted(activity))
    with open(os.path.join(RAW, "codex_quota_fingerprints.csv"), "w", newline="") as fh:
        w = csv.writer(fh, lineterminator="\n")
        w.writerow(["resets_at_utc", "host_tokens_until_max", "min_pct", "max_pct", "delta_pct",
                    "pct_per_100M_tokens"])
        for key, f in sorted(fp.items()):
            ser = sorted(f["series"])
            dp = (f["max"] - f["min"]) if f["min"] is not None else None
            if dp:
                cutn = next(i for i, s in enumerate(ser) if s[1] == f["max"])
                toks = sum(s[2] for s in ser[:cutn + 1])
            else:
                toks = f["tokens"]
            w.writerow([dt.datetime.fromtimestamp(key * 60, dt.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
                        toks, f["min"], f["max"], dp,
                        round(dp / toks * 1e8, 3) if dp and toks else ""])
    for k, v in sorted(stats.items()):
        print(k, v)


if __name__ == "__main__":
    main()
