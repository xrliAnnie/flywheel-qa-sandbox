#!/usr/bin/env bash
# Standalone 529 channel census; does not depend on generalized room-info.
set -euo pipefail
repo="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$repo" "$@" <<'PY'
import datetime
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys

repo=Path(sys.argv[1]); args=sys.argv[2:]
summary={'applicableCount':0,'liveCount':0,'leads':[]}
json_mode='--json' in args

def finish(rc):
    if json_mode: print(json.dumps(summary))
    else:
        for item in summary['leads']:
            status='N/A (codex-app-server)' if item['carrier']=='codex-app-server' else ('live' if item['live'] else item['reason'])
            print(f"{item['agentId']}: {status}")
        print(f"applicable={summary['applicableCount']} live={summary['liveCount']}")
    raise SystemExit(rc)

def read_object(path):
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
    with os.fdopen(fd,'rb') as stream:
        st=os.fstat(stream.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_size>65536: raise ValueError('invalid coordinate file')
        raw=stream.read(65537)
    if len(raw)>65536: raise ValueError('oversized coordinates')
    value=json.loads(raw)
    if not isinstance(value,dict): raise ValueError('invalid coordinates')
    return value

def parse_time(value):
    if not isinstance(value,str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)',value): raise ValueError('invalid since')
    datetime.datetime.fromisoformat(value.replace('Z','+00:00'))

try:
    if not args or not re.fullmatch('[1-9][0-9]*',args[0]): raise ValueError('invalid slot')
    root=Path('/tmp')/('flywheel-test-slot-'+args.pop(0))
    agent=None; since=None; timeout='1'
    while args:
        option=args.pop(0)
        if option=='--json': continue
        if option not in ('--agent','--since','--timeout') or not args: raise ValueError('invalid argument')
        value=args.pop(0)
        if option=='--agent':
            if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]*',value): raise ValueError('invalid agent')
            agent=value
        elif option=='--since': parse_time(value); since=value
        else:
            if not re.fullmatch('[1-9][0-9]{0,3}',value) or int(value)>3600: raise ValueError('invalid timeout')
            timeout=value
    if (root/'launchd').is_symlink(): raise ValueError('invalid launchd directory')
    paths=sorted((root/'launchd').glob('*/lead-coordinates.json'))
    if not paths: finish(3 if agent else 4)
    if agent: paths=[p for p in paths if p.parent.name==agent]
    if not paths: finish(3)
    # Validate the full selected census before probing or replacing artifacts.
    entries=[]
    for path in paths:
        if path.parent.is_symlink(): raise ValueError('symlink runtime')
        c=read_object(path)
        if c.get('schemaVersion')!=1 or c.get('agentId')!=path.parent.name or c.get('carrier') not in ('claude-code','codex-app-server'): raise ValueError('invalid identity')
        parse_time(c.get('startedAt'))
        if c['carrier']=='claude-code':
            for field,name in [('manifestPath','manifest.json'),('bodyStatusPath','body-status.json'),('livenessPath','channel-liveness.json')]:
                if c.get(field)!=str(path.parent/name): raise ValueError('invalid artifact path')
            if not isinstance(c.get('discordStateDir'),str) or not c['discordStateDir'].startswith('/') or not isinstance(c.get('socketPath'),str) or not c['socketPath'].startswith('/') or not isinstance(c.get('launchdLabel'),str): raise ValueError('invalid probe coordinates')
        entries.append((path,c))
    overall=0
    for path,c in entries:
        item={'agentId':c['agentId'],'carrier':c['carrier'],'live':None,'reason':'not_applicable','livenessPath':None}
        if c['carrier']=='claude-code':
            summary['applicableCount']+=1
            out=path.parent/'channel-liveness.json'
            p=subprocess.run(['bash','-c','source "$1"; qa_discord_liveness_wait "$2" "$3" "$4" "$5"','probe',str(repo/'scripts/lib/qa-discord-liveness.sh'),str(path),since or c['startedAt'],str(out),timeout],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            item.update(live=False,reason='probe_unavailable',livenessPath=str(out))
            try:
                value=read_object(out)
                if value.get('schemaVersion')==1 and value.get('agentId')==c['agentId']:
                    item['reason']=value.get('reason') or 'probe_unavailable'
                    if p.returncode==0 and value.get('live') is True:
                        item.update(live=True,reason=None); summary['liveCount']+=1
            except (OSError,ValueError): pass
            if p.returncode==2 or item['reason']=='probe_unavailable': overall=2
            elif not item['live'] and overall!=2: overall=1
        summary['leads'].append(item)
    finish(overall if summary['applicableCount'] else 5)
except (OSError,ValueError,KeyError,TypeError):
    finish(3)
PY
