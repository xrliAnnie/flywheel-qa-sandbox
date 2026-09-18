import subprocess
"""FLY-2681 replay: re-price 2026-09-16 CI runs under the on-demand matrix.
Inputs: runs-0916.tsv, runs-prev.tsv, jobs-0916.tsv (GitHub API), local git objects.
Model: a deselected job bills 0; a selected job bills exactly what it billed that day
(so cancellations / reruns / failures stay as they really happened).
"""
import csv, math, json, os, re, subprocess, datetime, collections, glob, sys
S = os.path.dirname(os.path.abspath(__file__))
REPO = subprocess.run(["git", "-C", S, "rev-parse", "--show-toplevel"], stdout=subprocess.PIPE, text=True).stdout.strip()
def git(*a):
    return subprocess.run(["git", "-C", REPO, *a], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True).stdout.strip()
def ts(s): return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ") if s else None

# ---- workspace reverse-dependency closure
pkgdir = {}; deps = {}
for pj in glob.glob(f"{REPO}/packages/*/package.json"):
    d = json.load(open(pj)); name = d["name"]; pkgdir[os.path.basename(os.path.dirname(pj))] = name
    alld = {**d.get("dependencies", {}), **d.get("devDependencies", {})}
    deps[name] = {k for k, v in alld.items() if str(v).startswith("workspace")}
def dependents_closure(names):
    out = set(names); changed = True
    while changed:
        changed = False
        for n, ds in deps.items():
            if n not in out and ds & out: out.add(n); changed = True
    return out
HEAVY = {"flywheel-claude-runner", "flywheel-comm", "flywheel-edge-worker"}
TEAMLEAD_JOBS = [f"Unit (teamlead {k} of 4)" for k in (1, 2, 3, 4)] + ["Unit (observation performance)"]
SHELL_PREFIX = "Script Tests "
PAYLOAD = "NPM payload distribution (endpoint + release pipeline)"
ALWAYS = {"Classify CI scope", "Quick Gate (build + typecheck + lint)", "CI OK"}
DOC_PREFIX = ("doc/", "product/doc/", "engineering/doc/", "content/doc/")
SHELLISH = re.compile(r"^(scripts/|packages/[^/]+/scripts/|packages/teamlead/(bin|lead-rules-base|phase-protocols|lead-skill-adapters[^/]*)/|\.claude/|\.flywheel/|\.lead/|vendor/)|\.(sh|bash|zsh|plist)$")
PAYLOAD_RE = re.compile(r"^(packages/(payload-endpoint|release-contract|onboard-shell)/|scripts/.*(payload|release|promote|publish|customer|dist-tag|endpoint|package-onboard|oidc|shell-p))")
FULL_RE = re.compile(r"^(\.github/|scripts/ci-|scripts/teamlead-ci-shard\.mjs|scripts/package-gate)|^[^/]+$")

def select(files, closure=True):
    """return None => full, else set of lanes among teamlead/heavy/light/shell/payload"""
    lanes = set()
    for f in files:
        if f.startswith(DOC_PREFIX): continue
        if FULL_RE.search(f) and not f.endswith(".md"): return None
        m = re.match(r"packages/([^/]+)/", f)
        hit = False
        if m and m.group(1) in pkgdir and not re.match(r"packages/[^/]+/scripts/", f):
            names = {pkgdir[m.group(1)]}
            if closure: names = dependents_closure(names)
            if "flywheel-teamlead" in names: lanes.add("teamlead")
            if names & HEAVY: lanes.add("heavy")
            if names - HEAVY - {"flywheel-teamlead"}: lanes.add("light")
            hit = True
        if PAYLOAD_RE.search(f): lanes.add("payload"); hit = True
        if SHELLISH.search(f): lanes.add("shell"); hit = True
        if f.endswith(".md") and not hit: lanes.add("shell"); hit = True
        if not hit: return None
    return lanes
def job_selected(name, lanes):
    if lanes is None or name in ALWAYS: return True
    if name in TEAMLEAD_JOBS: return "teamlead" in lanes
    if name == "Unit (heavy)": return "heavy" in lanes
    if name == "Unit (light)": return True  # floor row, see plan §unit floor
    if name.startswith(SHELL_PREFIX): return "shell" in lanes
    if name == PAYLOAD: return "payload" in lanes
    return True

runs = []
for fn in ("runs-prev.tsv", "runs-0916.tsv"):
    for r in csv.reader(open(f"{S}/{fn}"), delimiter="\t"):
        runs.append(dict(id=r[0], event=r[1], concl=r[3], branch=r[4], sha=r[5], started=r[6], day16=(fn == "runs-0916.tsv")))
runs.sort(key=lambda r: r["started"])
jobs = collections.defaultdict(list)
_seen = set()
for j in csv.reader(open(f"{S}/jobs-0916.tsv"), delimiter="\t"):
    rid, name, status, concl, st, en, att = j
    if (rid, name, st, en) in _seen: continue
    _seen.add((rid, name, st, en))
    a, b = ts(st), ts(en)
    dur = (b - a).total_seconds() if a and b and concl != "skipped" else 0
    jobs[rid].append((name, math.ceil(max(dur, 0) / 60) if dur > 0 else 0))
paths = json.load(open(f"{S}/paths-0916.json"))
main_tip = git("rev-parse", "origin/main")

def is_base_merge(sha):
    ps = git("rev-list", "--parents", "-n", "1", sha).split()[1:]
    if len(ps) != 2: return False
    return subprocess.run(["git", "-C", REPO, "merge-base", "--is-ancestor", ps[1], main_tip]).returncode == 0

last_head = {}
res = collections.defaultdict(lambda: collections.Counter())
detail = []
for r in runs:
    br, sha = r["branch"], r["sha"]
    prev = last_head.get(br) if r["event"] == "pull_request" else None
    if r["event"] == "pull_request": last_head[br] = sha
    if not r["day16"]: continue
    actual = sum(m for _, m in jobs[r["id"]])
    cum = paths[r["id"]]["files"] or []
    if r["event"] == "push":
        kind = "main-push"; lanesA = lanesB = None
    elif is_base_merge(sha):
        kind = "base-merge"; lanesA = lanesB = None
    else:
        kind = "pr-head"
        inc = None
        if prev and prev != sha and subprocess.run(["git", "-C", REPO, "merge-base", "--is-ancestor", prev, sha]).returncode == 0:
            inc = git("diff", "--name-only", "--no-renames", f"{prev}..{sha}").splitlines()
        basis = inc if inc is not None else cum
        lanesA = {v: select(cum, c) for v, c in (("closure", True), ("own", False))}
        lanesB = {v: select(basis, c) for v, c in (("closure", True), ("own", False))}
    for pol, lanes_by in (("A-cumulative", lanesA), ("B-incremental", lanesB)):
        for variant in ("closure", "own"):
            lanes = None if lanes_by is None else lanes_by[variant]
            cost = sum(m for n, m in jobs[r["id"]] if job_selected(n, lanes))
            res[(pol, variant)][kind] += cost
    res[("actual", "-")][kind] += actual
    res[("count", "-")][kind] += 1
    detail.append((r["id"], kind, br, actual, None if lanesB is None else sorted(lanesB["closure"] or ["FULL"]) if lanesB["closure"] is not None else ["FULL"]))

# Price of one full run = billed minutes of CLEAN full runs only: single attempt, 16 jobs, all success.
# (The mean over every "success" run is higher because it includes re-run attempts; do not use it.)
_raw = collections.defaultdict(list)
for j in csv.reader(open(f"{S}/jobs-0916.tsv"), delimiter="\t"):
    _raw[j[0]].append(j)
_attempt = {r[0]: r[8] for r in csv.reader(open(f"{S}/runs-0916.tsv"), delimiter="\t")}
clean = sorted(
    sum(math.ceil((ts(j[5]) - ts(j[4])).total_seconds() / 60) for j in js)
    for rid, js in _raw.items()
    if _attempt.get(rid) == "1" and len(js) == 16 and all(j[3] == "success" and j[6] == "1" for j in js)
)
CLEAN_MEDIAN = clean[len(clean) // 2] if len(clean) % 2 else (clean[len(clean) // 2 - 1] + clean[len(clean) // 2]) / 2
CLEAN_MEAN = sum(clean) / len(clean)
print(f"clean single-attempt full green runs: n={len(clean)} median={CLEAN_MEDIAN} mean={CLEAN_MEAN:.1f} min={clean[0]} max={clean[-1]}")
print("run counts:", dict(res[("count", "-")]))
act = res[("actual", "-")]; total_act = sum(act.values())
print("ACTUAL billed:", dict(act), "total", total_act)
QA_FREEZES = 15
FULL_COST = 140
for key in [k for k in res if k[0] not in ("actual", "count")]:
    c = res[key]; base = sum(c.values())
    for nfull in (QA_FREEZES, QA_FREEZES * 2):
        tot = base + nfull * FULL_COST
        print(f"{key[0]:14s} {key[1]:8s} pr-head={c['pr-head']:6d} base-merge={c['base-merge']:5d} main={c['main-push']:5d} + {nfull} freeze-full={nfull*FULL_COST:5d} => {tot:6d}  saving {100*(1-tot/total_act):5.1f}%")
json.dump(detail, open(f"{S}/replay-detail.json", "w"))

# ---- option table. FULL is pinned to the clean-run evidence above; the assert fails if the data drifts.
FULL = 140
assert abs(FULL - CLEAN_MEDIAN) <= 2 and abs(FULL - CLEAN_MEAN) <= 2, (FULL, CLEAN_MEDIAN, CLEAN_MEAN)
qg = sum(sum(m for n, m in jobs[r["id"]] if n in ALWAYS) for r in runs if r["day16"] and r["event"] == "pull_request" and not is_base_merge(r["sha"]))
main_act = act["main-push"]; bm = act["base-merge"]
print("\n=== option table (actual deduped total = %d) ===" % total_act)
def line(label, pr_cost, main_cost, nfull, extra_full=0):
    tot = pr_cost + bm + main_cost + (nfull + extra_full) * FULL
    print(f"{label:58s} pr={pr_cost:5d} main={main_cost:5d} fulls={nfull+extra_full:2d} total={tot:6d} saving={100*(1-tot/total_act):5.1f}%")
B_own = res[("B-incremental", "own")]["pr-head"]; B_clo = res[("B-incremental", "closure")]["pr-head"]; A_clo = res[("A-cumulative", "closure")]["pr-head"]
for main_cost, mlabel in ((main_act, "main full"), (round(main_act * 0.5), "main tree-reuse 50%")):
    line(f"P1 package/lane by cumulative diff (issue literal) | {mlabel}", A_clo, main_cost, 15)
    line(f"P2 package/lane by this-push diff                  | {mlabel}", B_own, main_cost, 15)
    # Sensitivity to "full run red -> fix -> full again". 2026-09-16 had 16 failure-concluded PR runs
    # across 10 of 21 branches, so +10 (one extra full per branch that really went red) is the
    # supported worst case; +16 is the pessimistic ceiling. An earlier draft used +8 without data.
    for extra in (0, 5, 10, 16):
        line(f"P3 quick-gate only on intermediate heads, +{extra:2d} fulls   | {mlabel}", qg, main_cost, 15, extra)
