import subprocess
import csv, subprocess, collections, os, re, json
S = os.path.dirname(os.path.abspath(__file__))
REPO = subprocess.run(["git", "-C", S, "rev-parse", "--show-toplevel"], stdout=subprocess.PIPE, text=True).stdout.strip()
def git(*a):
    return subprocess.run(["git", "-C", REPO, *a], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True).stdout.strip()
def area(p):
    m = re.match(r"packages/([^/]+)/(.*)", p)
    if m:
        pkg, rest = m.groups()
        if rest.startswith("scripts/"): return f"pkg:{pkg}:scripts"
        if rest.startswith("agents/") or rest.endswith(".md"): return f"pkg:{pkg}:md/agents"
        return f"pkg:{pkg}"
    if p.startswith("scripts/__tests__/"): return "scripts/__tests__"
    if p.startswith("scripts/"): return "scripts"
    if p.startswith(("engineering/doc/", "product/doc/", "doc/", "content/doc/")): return "docs"
    if p.startswith(".github/"): return ".github"
    if p.startswith(".claude/"): return ".claude"
    if "/" not in p: return "root:" + p
    return p.split("/")[0] + "/"
out = {}
for r in csv.reader(open(f"{S}/runs-0916.tsv"), delimiter="\t"):
    rid, event, status, concl, branch, sha = r[:6]
    if event == "push":
        base = git("rev-parse", sha + "^1")
    else:
        base = git("merge-base", "origin/main", sha)
        if base == sha:  # already merged into main: find the merge-base with first parent chain before merge
            base = ""
    files = git("diff", "--name-only", "--no-renames", f"{base}..{sha}").splitlines() if base else None
    out[rid] = dict(event=event, concl=concl, branch=branch, sha=sha, base=base, files=files)
json.dump(out, open(f"{S}/paths-0916.json", "w"))
unk = sum(1 for v in out.values() if v["files"] is None)
print("runs", len(out), "unresolved", unk)
combo = collections.Counter()
for v in out.values():
    if v["files"] is None: continue
    combo[(v["event"], tuple(sorted({area(f) for f in v["files"]})))] += 1
for k, n in combo.most_common():
    print(n, k[0], list(k[1]))
