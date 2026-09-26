#!/usr/bin/env python3
"""FLY-2889: per-execution token usage from raw Claude transcripts / Codex rollouts.

Read-only. For every execution in ../data/raw/executions.csv:
  Claude: ~/.claude/projects/<cwd slug>/*.jsonl whose prompt_snapshot attachment
          contains "--exec-id <id>" (fallback for early files without the
          attachment: id present AND first timestamp within 60 s after created_at).
          Usage = last row per message.id, skipping <synthetic>; subagents separate.
  Codex:  ~/.flywheel/state/codex-sessions/<id>/session.json threadId ->
          rollout-*-<threadId>.jsonl; cumulative total_token_usage differenced,
          counter drop = new segment from 0.
Writes ../data/raw/exec_usage.csv (counts only, no content, no paths).
"""
import collections
import csv
import datetime as dt
import glob
import json
import os
import re
import sqlite3

H = os.path.expanduser("~")
HERE = os.path.dirname(os.path.abspath(__file__))
RAW = os.path.join(HERE, "..", "data", "raw")
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


def slug(p):
    return re.sub(r"[^a-zA-Z0-9]", "-", p)


def parse_ts(v):
    try:
        return dt.datetime.fromisoformat(v.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None


def first_ts(path):
    with open(path, errors="replace") as fh:
        for line in fh:
            m = re.search(r'"timestamp":"([^"]+)"', line)
            if m:
                return parse_ts(m.group(1))
    return None


def claude_candidates(worktree):
    out = set()
    if not worktree:
        return out
    for p in {worktree, os.path.realpath(worktree)}:
        out.update(glob.glob(f"{H}/.claude/projects/{slug(p)}/*.jsonl"))
    return out


def claude_match(path, eid, created):
    needle = "--exec-id " + eid
    snapshot_seen = False
    loose = False
    with open(path, errors="replace") as fh:
        for line in fh:
            if '"prompt_snapshot"' in line:
                snapshot_seen = True
                if needle in line:
                    return "prompt_snapshot"
            elif needle in line:
                loose = True
    if not snapshot_seen and loose and created:
        t = first_ts(path)
        if t and 0 <= (t - created).total_seconds() <= 60:
            return "early_loose"
    return None


def claude_usage(files):
    seen = {}
    models = collections.Counter()
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
                if not u or m.get("model") == "<synthetic>":
                    continue
                seen[(f, m.get("id") or r.get("requestId") or r.get("uuid"))] = (u, m.get("model"))
    agg = collections.Counter()
    for (_, _), (u, model) in seen.items():
        agg["input"] += u.get("input_tokens") or 0
        agg["output"] += u.get("output_tokens") or 0
        agg["cache_read"] += u.get("cache_read_input_tokens") or 0
        agg["cache_write"] += u.get("cache_creation_input_tokens") or 0
        models[model] += 1
    agg["total"] = agg["input"] + agg["output"] + agg["cache_read"] + agg["cache_write"]
    agg["requests"] = len(seen)
    return agg, models


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


def codex_usage(files):
    agg = collections.Counter()
    models = collections.Counter()
    resets = anomalies = 0
    for f in files:
        prev = None
        new_turn = False
        with open(f, errors="replace") as fh:
            for line in fh:
                if '"token_count"' not in line and '"turn_context"' not in line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                p = r.get("payload") or {}
                if r.get("type") == "turn_context":
                    models[p.get("model")] += 1
                    new_turn = True
                    continue
                if r.get("type") != "event_msg" or p.get("type") != "token_count" or not p.get("info"):
                    continue
                tot = p["info"].get("total_token_usage") or {}
                cur = {k: tot.get(k) or 0 for k in ("input_tokens", "cached_input_tokens",
                                                    "output_tokens", "reasoning_output_tokens",
                                                    "total_tokens")}
                if prev and cur["total_tokens"] < prev["total_tokens"]:
                    if new_turn:  # importer rule: cross-turn counter reset
                        resets += 1
                    else:
                        anomalies += 1
                    prev = None
                new_turn = False
                base = prev or {k: 0 for k in cur}
                for k in cur:
                    agg[k] += cur[k] - base[k]
                prev = cur
    out = collections.Counter({
        "input": agg["input_tokens"] - agg["cached_input_tokens"],
        "cache_read": agg["cached_input_tokens"], "output": agg["output_tokens"],
        "reasoning": agg["reasoning_output_tokens"], "cache_write": 0,
        "total": agg["total_tokens"], "resets": resets, "anomalies": anomalies})
    return out, models


def main():
    freeze = json.load(open(os.path.join(RAW, "..", "freeze.json")))
    t1 = parse_ts(freeze["t1"])
    execs = list(csv.DictReader(open(os.path.join(RAW, "executions.csv"))))
    c = sqlite3.connect(f"file:{H}/.flywheel/teamlead.db?mode=ro", uri=True)
    wt = dict(c.execute("SELECT execution_id, worktree_path FROM sessions"))
    cols = ["execution_id", "vendor", "locate", "n_files", "open_at_t1", "input", "output",
            "cache_read", "cache_write", "reasoning", "total", "requests", "resets", "counter_anomalies",
            "sub_files", "sub_input", "sub_output", "sub_cache_read", "sub_cache_write",
            "sub_total", "observed_models"]
    rows = []
    stats = collections.Counter()
    for e in execs:
        eid, vendor = e["execution_id"], e["vendor"]
        created = parse_ts(e["created_at"])
        files, how, sub = [], "none", []
        if vendor == "claude":
            for f in sorted(claude_candidates(wt.get(eid))):
                m = claude_match(f, eid, created)
                if m:
                    files.append(f)
                    how = m if how == "none" else how
            for f in files:
                sub += glob.glob(os.path.join(f[:-6], "subagents", "*.jsonl"))
            use, models = claude_usage(files) if files else (collections.Counter(), {})
            suse, smodels = claude_usage(sub) if sub else (collections.Counter(), {})
        else:
            how, files = codex_files(eid)
            use, models = codex_usage(files) if files else (collections.Counter(), {})
            suse = collections.Counter()
        opened = any(os.path.getmtime(f) > t1.timestamp() - 900 for f in files)
        stats[(vendor, how if files else "missing:" + how)] += 1
        rows.append([eid, vendor, how if files else "missing:" + how, len(files), opened,
                     use.get("input", 0), use.get("output", 0), use.get("cache_read", 0),
                     use.get("cache_write", 0), use.get("reasoning", 0), use.get("total", 0),
                     use.get("requests", 0), use.get("resets", 0), use.get("anomalies", 0), len(sub),
                     suse.get("input", 0), suse.get("output", 0), suse.get("cache_read", 0),
                     suse.get("cache_write", 0), suse.get("total", 0),
                     "|".join(f"{k}:{v}" for k, v in sorted(models.items(), key=lambda kv: -kv[1]) if k)])
    with open(os.path.join(RAW, "exec_usage.csv"), "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(cols)
        w.writerows(rows)
    for k, v in sorted(stats.items()):
        print(k, v)


if __name__ == "__main__":
    main()
