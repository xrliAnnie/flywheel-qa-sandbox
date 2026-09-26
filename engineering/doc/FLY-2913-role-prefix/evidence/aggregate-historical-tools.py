#!/usr/bin/env python3
"""Aggregate already-redacted FLY-2904 rows; no live transcript or database access."""
import argparse, collections, csv, hashlib, json, pathlib, statistics
ap=argparse.ArgumentParser();ap.add_argument('source',type=pathlib.Path);ap.add_argument('output',type=pathlib.Path);a=ap.parse_args()
p=a.source;start='2026-09-18T22:00:00Z';end='2026-09-25T22:00:00Z'
roles=['claude:implement','claude:eng_design','claude:qa','claude-review:design','claude-review:code']
out={'window':{'startInclusive':start,'endExclusive':end},'basis':'FLY-2904 frozen redacted CSV; tool-result rows, not deduped tool invocations; native Bash subcommands grouped; subagents separated','roles':{}}
files=list(csv.DictReader((p/'raw/claude_files.csv').open()));req=list(csv.DictReader((p/'raw/claude_requests.csv').open()));tools=list(csv.DictReader((p/'raw/claude_tool_outputs.csv').open()))
for role in roles:
 d={}
 for sa in ['0','1']:
  rs=[r for r in req if r['sub']==role and r['subagent']==sa and start<=r['ts']<end]
  ts=[r for r in tools if r['sub']==role and r['subagent']==sa and start<=r['ts']<end]
  fs=[r for r in files if r['sub']==role and r['subagent']==sa and int(r['requests'])]
  d['main' if sa=='0' else 'subagent']={'weekRequests':len(rs),'weekFiles':len({r['file_id'] for r in rs}),'weekToolResultRows':len(ts),'weekToolResultCounts':dict(collections.Counter(r['tool_class'] for r in ts).most_common()),'fourteenDayFileCount':len(fs),'fourteenDayFirstContextMedian':statistics.median([int(r['first_ctx']) for r in fs]) if fs else None,'fourteenDayMinContextMedian':statistics.median([int(r['min_ctx']) for r in fs]) if fs else None}
 out['roles'][role]=d
names=['raw/claude_files.csv','raw/claude_requests.csv','raw/claude_tool_outputs.csv','raw/freeze-claude-codex.json','derived/summary.json','scripts/census.py','scripts/analyze.py']
out['provenance']={'sourceRoot':str(p),'inputs':[]}
for n in names:
 with (p/n).open('rb') as f: digest=hashlib.file_digest(f,'sha256').hexdigest()
 entry={'path':n,'bytes':(p/n).stat().st_size,'sha256':digest}
 if n.endswith('.csv'):
  with (p/n).open() as f: entry['columns']=next(csv.reader(f))
 out['provenance']['inputs'].append(entry)
out['coverage']={'weekRequestsByBucketAndSub':dict(collections.Counter(r['bucket']+'|'+r['sub'] for r in req if start<=r['ts']<end)), 'caveats':['Role classification inherited from FLY-2904 execution/reviewer roster; unmapped-worktree is not allocated to roles.', 'Tool rows are observed results, may include errors, and lack tool_use_id dedup; no-call sessions and calls without results are absent.', 'First/min context values use entire eligible file, not just the seven-day interval, and include task/history; not fixed-prefix component measurements.']}
a.output.write_text(json.dumps(out,indent=2,ensure_ascii=False))
