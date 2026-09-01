import json,sys,os,glob,statistics
def stats(pattern, label, limit_files=6):
    files = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)[:limit_files]
    vals=[]
    for f in files:
        try:
            for line in open(f, errors="ignore"):
                if '"usage"' not in line: continue
                try: o=json.loads(line)
                except: continue
                u=(o.get("message") or {}).get("usage") or o.get("usage")
                if not isinstance(u,dict): continue
                t=(u.get("input_tokens") or 0)+(u.get("cache_creation_input_tokens") or 0)+(u.get("cache_read_input_tokens") or 0)
                if t>1000: vals.append(t)
        except Exception: pass
    if not vals:
        print(f"{label}: no data"); return
    vals.sort()
    print(f"{label}: n={len(vals)} files={len(files)} median={statistics.median(vals):.0f} mean={statistics.mean(vals):.0f} p10={vals[len(vals)//10]} p90={vals[len(vals)*9//10]} min={vals[0]} max={vals[-1]}")
H=os.path.expanduser("~")
stats(H+"/.claude/projects/-Users-xiaorongli--flywheel-lead-workspace-flywheel-eng-lead/*.jsonl","Lead: flywheel-eng-lead")
stats(H+"/.claude/projects/-Users-xiaorongli--flywheel-lead-workspace-flywheel-cos-lead/*.jsonl","Lead: flywheel-cos-lead")
stats(H+"/.claude/projects/-Users-xiaorongli-Dev-flywheel-FLY-*/*.jsonl","Runner: flywheel worktrees", 25)
