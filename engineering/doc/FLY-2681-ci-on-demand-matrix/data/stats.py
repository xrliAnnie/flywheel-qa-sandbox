import csv, math, collections, datetime, statistics, sys, os
S = os.path.dirname(os.path.abspath(__file__))
def ts(s):
    return datetime.datetime.strptime(s, "%Y-%m-%dT%H:%M:%SZ") if s else None
runs = {}
for r in csv.reader(open(f"{S}/runs-0916.tsv"), delimiter="\t"):
    runs[r[0]] = dict(id=r[0], event=r[1], status=r[2], concl=r[3], branch=r[4], sha=r[5], attempt=r[8])
jobs = collections.defaultdict(list)
for j in csv.reader(open(f"{S}/jobs-0916.tsv"), delimiter="\t"):
    rid, name, status, concl, st, en, att = j
    a, b = ts(st), ts(en)
    dur = (b - a).total_seconds() if a and b and concl not in ("skipped",) else 0
    jobs[rid].append(dict(name=name, concl=concl, dur=max(dur, 0), att=att))
tot_bill = 0; tot_raw = 0
per_job = collections.defaultdict(list)
per_run = {}
for rid, js in jobs.items():
    bill = sum(math.ceil(j["dur"] / 60) for j in js if j["dur"] > 0)
    raw = sum(j["dur"] for j in js) / 60
    per_run[rid] = (bill, raw)
    tot_bill += bill; tot_raw += raw
    for j in js:
        if j["concl"] == "success" and j["dur"] > 0:
            per_job[j["name"]].append(j["dur"] / 60)
print("runs", len(runs), "billable-min", tot_bill, "raw-min", round(tot_raw))
print("\nper-job success median / p90 minutes (n):")
tot_med = 0
for n, v in sorted(per_job.items()):
    v.sort()
    med = statistics.median(v); p90 = v[int(len(v) * 0.9) - 1] if len(v) > 1 else v[0]
    tot_med += med
    print(f"  {n:75s} {med:5.1f} {p90:5.1f} ({len(v)})")
print("sum of medians:", round(tot_med, 1))
by = collections.defaultdict(lambda: [0, 0])
for rid, (bill, raw) in per_run.items():
    k = (runs[rid]["event"], runs[rid]["concl"])
    by[k][0] += 1; by[k][1] += bill
print("\nby event/conclusion: runs, billable-min")
for k, v in sorted(by.items()):
    print(" ", k, v)
