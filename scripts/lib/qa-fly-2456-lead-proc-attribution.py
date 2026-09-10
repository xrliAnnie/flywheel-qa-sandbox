#!/usr/bin/env python3
"""FLY-2456 DEVIATION #7 — operational attribution, Lead ruling 300233ea.
The host-runs driver is immutable history. Future runs use this stricter version.
Usage: lead-proc-attribution.py <proc.json> <baseline ps-comparison.txt> <after ps-comparison.txt> <slot_dir> <checkout> <out.json>
Rules (mechanical, every row gets rule+evidence):
  A slot_arg_path : any argv word contains a slot/checkout root path (tool refuses argv on quoting grounds; Lead layer accepts with the word recorded)
  B slot_ancestry : ppid chain inside the same snapshot reaches a row that is tool-SLOT or rule A
  D production_flywheel: after A/B, own production signature outranks all transient rules
  C host_transient: exact host transient shapes; only shell-snapshot direct children inherit
  otherwise unattributed -> fail
"""
import json,re,sys,pathlib
proc=json.loads(pathlib.Path(sys.argv[1]).read_text()); base_p, after_p = sys.argv[2], sys.argv[3]
slot_dir, checkout, out_p = sys.argv[4], sys.argv[5], sys.argv[6]
roots=[slot_dir, checkout]
if slot_dir.startswith('/tmp/'): roots.append('/private'+slot_dir)
LINE=re.compile(r'^\s*(\d+)\s+(\d+)\s+(\w{3} \w{3}\s+\d+ \d\d:\d\d:\d\d \d{4})\s+(.*)$')
def parse(p):
    rows={}; skipped=0
    for line in pathlib.Path(p).read_text(errors='replace').splitlines():
        m=LINE.match(line)
        if not m: skipped+=1; continue
        rows[int(m.group(1))]={'pid':int(m.group(1)),'ppid':int(m.group(2)),'lstart':m.group(3),'command':m.group(4)}
    return rows,skipped
base,bs=parse(base_p); after,as_=parse(after_p)
SHELL_SNAPSHOT=re.compile(r'^(?:(?:/bin/)?(?:ba|z)?sh )?/Users/xiaorongli/\.claude/shell-snapshots/[^ ]+\.sh(?: |$)')
TRANSIENT=[re.compile(x) for x in (
 r'^(?:/bin/|/usr/bin/)?sleep \d+$',
 r'^(?:/opt/homebrew/bin/)?gh (api|pr|run) ',
 r'^/Applications/Google Chrome\.app/.*Google Chrome Helper',
 r'^Google Chrome Helper(?: |$)',
 r'^/System/Library/(?:Frameworks/CoreServices\.framework/.*(?:mdworker|Metadata)|PrivateFrameworks/.*contactsd)(?: |$)',
 r'^/usr/libexec/(?:mdworker(?:_shared)?|contactsd)(?: |$)',
 r'^\([A-Za-z0-9_.-]+\)$', r'^<defunct>$',
)]
PROD=[re.compile(x) for x in (
 r'runner-flywheel', r'/Users/xiaorongli/Dev/flywheel/',
 r'claude --agent(?:-id)? ', r'claude-lead', r'com\.flywheel\.',
 r'\.flywheel/comm/flywheel/', r'unix:///Users/xiaorongli/\.flywheel/',
 r'run-bridge\.(?:js|ts)', r'^tmux: server(?: |$)',
 r'^tmux .* -s flywheel(?: |$)',
)]
def rule_a(cmd):
    for w in cmd.split():
        for r in roots:
            if r in w: return w
    return None
def rule_b(row, snap, seen=None):
    seen=seen or set()
    if row['pid'] in seen: return None
    seen.add(row['pid']); parent=snap.get(row['ppid'])
    if not parent: return None
    if parent.get('attribution')=='SLOT' or rule_a(parent['command']): return parent['pid']
    return rule_b(parent, snap, seen)
def classify(row, snap, removed):
    cmd=row['command']
    w=rule_a(cmd)
    if w: return 'slot','A:slot_arg_path',w
    p=rule_b(row,snap)
    if p is not None: return 'slot','B:slot_ancestry',f'ancestor pid {p}'
    for rx in PROD:
        if rx.search(cmd): return ('production_casualty' if removed else 'production_added'),'D:production_flywheel',rx.pattern
    for rx in TRANSIENT:
        if rx.search(cmd): return 'host_transient','C:host_transient',rx.pattern
    if SHELL_SNAPSHOT.search(cmd): return 'host_transient','C:shell_snapshot',SHELL_SNAPSHOT.pattern
    parent=snap.get(row['ppid'])
    if parent and SHELL_SNAPSHOT.search(parent['command']) and not any(rx.search(parent['command']) for rx in PROD):
        return 'host_transient','C2:shell_snapshot_direct_child',f"parent pid {parent['pid']}"
    return 'unattributed','none',''
# tool-attributed SLOT rows: bring attribution into the snapshots for rule B
for key in ('added','removed'):
    for r in proc.get(key,[]):
        snap = after if key=='added' else base
        if r['pid'] in snap: snap[r['pid']]['attribution']=r.get('attribution')
rows=[]; fail=[]
for key in ('removed','added'):
    snap = base if key=='removed' else after
    for r in proc.get(key,[]):
        if r.get('attribution')=='SLOT':
            rows.append({**r,'set':key,'kind':'slot','rule':'tool:SLOT','evidence':'executable/interpreter path under root'}); continue
        srow=snap.get(r['pid'],r)
        kind,rule,ev=classify(srow,snap,key=='removed')
        if kind=='unattributed' and key=='added' and proc.get('mode')=='post-teardown':
            kind='added_unattributed'; rule='tool-semantics:post-teardown-added-informational'  # proc.mjs:82 only removed NONSLOT rows are unexplained in post-teardown mode
        rows.append({**r,'set':key,'kind':kind,'rule':rule,'evidence':ev})
        if kind in ('production_casualty','unattributed'): fail.append({'set':key,'pid':r['pid'],'kind':kind,'command':r['command'][:160]})
summary={'status':'fail' if fail else 'pass','deviation':'#7 operational attribution; production signatures precede transients (Lead 300233ea)','toolStatus':proc.get('status'),'mode':proc.get('mode'),'roots':roots,'baselineSkippedLines':bs,'afterSkippedLines':as_,'counts':{k:sum(1 for r in rows if r['kind']==k) for k in ('slot','host_transient','production_casualty','production_added','added_unattributed','unattributed')},'failures':fail,'rows':rows}
pathlib.Path(out_p).write_text(json.dumps(summary,indent=1))
print(json.dumps({'status':summary['status'],'counts':summary['counts'],'failures':fail[:6]},ensure_ascii=False))
