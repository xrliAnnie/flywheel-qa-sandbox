#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
[[ -f "$repo/scripts/qa-529-discord-liveness.sh" ]] || { echo 'FAIL: standalone liveness CLI missing'; exit 1; }
python3 - "$repo" <<'PY'
import json, os, shutil, subprocess, sys, tempfile
from pathlib import Path
repo=Path(sys.argv[1]); slot=str(os.getpid())+'1948'; root=Path('/tmp')/('flywheel-test-slot-'+slot)
assert not root.exists()
root.mkdir(mode=0o700)
try:
    def invoke(rc, agent=None):
        args=['bash',str(repo/'scripts/qa-529-discord-liveness.sh'),slot,'--json','--timeout','1']
        if agent: args+=['--agent',agent]
        p=subprocess.run(args,capture_output=True,text=True,env=env)
        assert p.returncode==rc,(rc,p.returncode,p.stdout,p.stderr)
        value=json.loads(p.stdout); print('PASS: CLI rc',rc,'agent',agent); return value
    env={**os.environ,'HOME':str(root)}
    for op in ['ps','start','env','lsof','pane','launch']:
        script=root/op
        script.write_text('''#!/usr/bin/env python3
import sys
from pathlib import Path
root=Path(__file__).parent; op=Path(__file__).name
if op=='ps':
 for n in [1,2]: print(f'{n*10+1} {n*10} claude --agent lead-{n}\\n{n*10+2} {n*10+1} bun /x/plugins/cache/flywheel/discord/0.0.7/server.ts')
elif op=='start': print('Mon Sep 14 20:00:00 2026')
elif op=='env': raise SystemExit(0 if sys.argv[3]==str(root/f'state-{int(sys.argv[1])//10}') else 1)
elif op=='lsof': print('bun TCP local->162.159.1.1:443 (ESTABLISHED)')
elif op=='launch': print('10')
''');script.chmod(0o700)
        key={'ps':'PS_SNAPSHOT','start':'PS_LSTART','env':'ENV_HAS','lsof':'LSOF','pane':'PANE_CAPTURE','launch':'LAUNCHD_PID'}[op]
        env['FLYWHEEL_QA_'+key+'_CMD']=str(script)
    assert invoke(4)['applicableCount']==0
    def lead(n,carrier='claude-code',mode='slot'):
        agent=f'lead-{n}'; rt=root/'launchd'/agent; rt.mkdir(parents=True,exist_ok=True,mode=0o700)
        state=root/f'state-{n}';state.mkdir(exist_ok=True)
        (state/'gateway-health.log').write_text('2026-09-14T20:00:03Z gateway shard 0 ready\n')
        c=dict(schemaVersion=1,agentId=agent,carrier=carrier,mode=mode,startedAt='2026-09-14T20:00:00Z',discordStateDir=str(state),socketPath=str(root/'sock'),manifestPath=str(rt/'manifest.json'),bodyStatusPath=str(rt/'body-status.json'),launchdLabel='com.flywheel.qa.lead.slot-'+slot+'.'+agent,livenessPath=str(rt/'channel-liveness.json'))
        (rt/'manifest.json').write_text(json.dumps(dict(leadId=agent,pid=n*10)))
        (rt/'lead-coordinates.json').write_text(json.dumps(c))
        return rt
    rt=lead(1,'codex-app-server'); v=invoke(5); assert v['applicableCount']==0
    assert not (rt/'channel-liveness.json').exists()
    invoke(3,'missing')
    lead(1);v=invoke(0);assert v['liveCount']==1
    lead(2);v=invoke(0);assert v['liveCount']==2
    for mode in ['mirror','roundtable']:
        lead(1,mode=mode);assert invoke(0,'lead-1')['liveCount']==1
    (root/'state-2/gateway-health.log').write_text('');v=invoke(1);assert v['liveCount']==1
    env['FLYWHEEL_QA_PS_SNAPSHOT_CMD']=str(root/'missing-command');invoke(2,'lead-1')
    (rt/'lead-coordinates.json').write_text('{}');invoke(3,'lead-1')
finally: shutil.rmtree(root)
PY
