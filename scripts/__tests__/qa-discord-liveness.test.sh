#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
lib="$repo/scripts/lib/qa-discord-liveness.sh"
[[ -f "$lib" ]] || { echo 'FAIL: liveness library missing'; exit 1; }
python3 - "$lib" <<'PY'
import json, os, subprocess, sys, tempfile
from pathlib import Path
lib = sys.argv[1]
with tempfile.TemporaryDirectory(prefix='fly1948-live-') as tmp:
    root=Path(tmp); runtime=root/'launchd/flywheel-test-2'; runtime.mkdir(parents=True)
    state=root/'discord-state'; state.mkdir()
    coords=runtime/'lead-coordinates.json'; out=runtime/'channel-liveness.json'
    manifest=runtime/'manifest.json'; body=runtime/'body-status.json'
    c=dict(schemaVersion=1,agentId='flywheel-test-2',carrier='claude-code',discordStateDir=str(state),socketPath=str(root/'sock'),startedAt='2026-09-14T20:00:00Z',manifestPath=str(manifest),bodyStatusPath=str(body),launchdLabel='com.flywheel.qa.lead.slot-2.flywheel-test-2',livenessPath=str(out))
    fixture=root/'fixture.json'
    observer=root/'observe'
    observer.write_text('''#!/usr/bin/env python3
import json,os,sys
v=json.load(open(os.environ['FIXTURE']))
op=sys.argv[1]; args=sys.argv[2:]
if op=='start':
 assert os.environ['TZ']=='UTC' and os.environ['LC_ALL']=='C'
 value=v['start'].get(args[0],'')
elif op=='env':
 raise SystemExit(v.get('envRc',0))
else: value=v.get(op,'')
if isinstance(value,int): raise SystemExit(value)
print(value)
'''); observer.chmod(0o700)
    env={**os.environ,'HOME':str(root),'FIXTURE':str(fixture)}
    for op,key in [('ps','PS_SNAPSHOT'),('start','PS_LSTART'),('lsof','LSOF'),('env','ENV_HAS'),('pane','PANE_CAPTURE'),('launch','LAUNCHD_PID')]:
        shim=root/op; shim.write_text('#!/bin/bash\nexec '+str(observer)+' '+op+' "$@"\n'); shim.chmod(0o700)
        env['FLYWHEEL_QA_'+key+'_CMD']=str(shim)
    adapter='bun /home/test/plugins/cache/flywheel-plugins/discord/0.0.7/server.ts'
    def reset():
        global v
        c['carrier']='claude-code'; coords.write_text(json.dumps(c))
        if body.is_symlink(): body.unlink()
        body.write_text(json.dumps(dict(schemaVersion=1,carrierPid=10,startedAt='2026-09-14T20:00:00.500Z')))
        manifest.write_text(json.dumps(dict(leadId=c['agentId'],pid=10)))
        v={'ps':'11 10 claude --agent flywheel-test-2\n12 11 '+adapter,'start':{'11':'Mon Sep 14 20:00:00 2026','12':'Mon Sep 14 20:00:01 2026'},'launch':'10','pane':'ready prompt','lsof':'bun 12 TCP 127.0.0.1:50000->162.159.1.1:443 (ESTABLISHED)'}
        (state/'gateway-health.log').write_text('2026-09-14T20:00:03Z gateway shard 0 ready\n')
        (state/'gateway-health.log.1').unlink(missing_ok=True)
    def probe(reason=None, rc=0):
        fixture.write_text(json.dumps(v))
        result=subprocess.run(['bash','-c','source "$1"; qa_discord_liveness_probe "$2" "$3" "$4"','test',lib,str(coords),c['startedAt'],str(out)],env=env,capture_output=True,text=True)
        assert result.returncode==rc,(reason,result.returncode,result.stderr)
        value=json.loads(out.read_text()); assert value['reason']==reason,(reason,value)
        assert out.stat().st_mode & 0o777==0o600
        print('PASS:',reason or 'live'); return value
    reset(); live=probe(); assert live['since']['bodyStartAdopted'] is True
    assert live['since']['gatewayCutoff']=='2026-09-14T20:00:01.000Z'
    reset(); v['ps'] += '\n' + '\n'.join(f'{i+100} 1 unrelated-process '+('x'*310) for i in range(1000)); assert len(v['ps'])>300000; probe()
    reset(); v['ps']='x'*(4*1024*1024+1); probe('probe_unavailable',2)
    reset(); c['carrier']='codex-app-server'; coords.write_text(json.dumps(c)); v['ps']=2; probe('not_applicable',3)
    reset(); v['ps']=2; probe('probe_unavailable',2)
    reset(); v['envRc']=2; probe('probe_unavailable',2)
    reset(); v['ps']=''; probe('claude_process_missing',1)
    reset(); v['ps']+='\n13 10 claude --agent flywheel-test-2'; probe('claude_process_ambiguous',1)
    reset(); v['ps']='11 10 claude --agent flywheel-test-2'; probe('adapter_missing',1)
    v['pane']='WARNING: Loading development channels\nI am using this for local development'; probe('dev_channels_dialog_parked',1)
    reset(); v['ps']+='\n13 11 '+adapter; probe('adapter_process_ambiguous',1)
    reset(); v['ps']=v['ps'].replace('12 11','12 1'); probe('adapter_orphaned',1)
    reset(); v['lsof']=1; probe('gateway_socket_missing',1)
    reset(); (state/'gateway-health.log').write_text(''); probe('gateway_ready_missing',1)
    reset(); v['start']['12']='Mon Sep 14 20:00:05 2026'; probe('gateway_ready_stale',1)
    reset(); (state/'gateway-health.log').write_text('2026-09-14T20:00:00.700Z gateway shard 0 ready\n'); value=probe('gateway_ready_missing',1); assert value['since']['ambiguousLinesIgnored']==1
    reset(); (state/'gateway-health.log').write_text('2026-09-14T20:00:03Z gateway shard 0 ready\n2026-09-14T20:00:04Z gateway shard 0 reconnecting\n'); probe('gateway_degraded',1)
    reset(); (state/'gateway-health.log.1').write_text('2026-09-14T20:00:03Z gateway shard 0 ready\n'); (state/'gateway-health.log').write_text('2026-09-14T20:00:03Z gateway shard 0 reconnecting\n'); probe('gateway_degraded',1)
    reset(); (state/'gateway-health.log.1').write_text('2026-09-14T20:00:03Z gateway shard 0 reconnecting\n'); (state/'gateway-health.log').write_text('2026-09-14T20:00:03Z gateway shard 0 resumed; replayed=1\n'); probe()
    for kind in ['manifest','launch','symlink','invalid']:
        reset(); (state/'gateway-health.log').write_text('')
        if kind=='manifest': manifest.write_text(json.dumps(dict(pid=99)))
        elif kind=='launch': v['launch']='99'
        elif kind=='symlink': body.unlink(); body.symlink_to(manifest)
        else: body.write_text('[]')
        assert probe('gateway_ready_missing',1)['since']['bodyStartAdopted'] is False
    reset(); v['launch']=2; probe('probe_unavailable',2)
    reset(); v['ps']='x'*65537; probe('probe_unavailable',2)
    reset(); v['ps']='\n'.join(f'{i+20} 10 claude --agent flywheel-test-2' for i in range(33)); probe('probe_unavailable',2)
    v['envRc']=1; probe('probe_unavailable',2)
    reset(); v['ps']='11 10 claude --agent flywheel-test-2\n12 11 bun run --cwd /plugin/discord start\n13 11 bun server.ts'; assert len(probe('adapter_missing',1)['adapter']['rejectedLegacyShapes'])==2
    for secret in ['TEST_BOT_TOKEN_2=MTIzSECRET','Bearer xyz','eyJabcdefghijk12345.abcdefghijk123456789.xyz']:
        result=subprocess.run(['bash','-c','source "$1"; qa_discord_redact_line "$2"','test',lib,secret],capture_output=True,text=True)
        assert result.returncode==0 and result.stdout.strip()=='<redacted>',result
    print('PASS: secret lines redacted')
    # Deterministically rotate during each actual read, exercising the same
    # production function without a timing-dependent background writer.
    import stat
    class Unavailable(Exception): pass
    paths=[state/'gateway-health.log.1',state/'gateway-health.log']
    for path in paths: path.write_text('old')
    def changing_read(path, limit):
        text=path.read_text()
        path.write_text(text+'x')
        return text
    namespace=dict(stat=stat,Unavailable=Unavailable,safe_read=changing_read)
    source=Path(lib).read_text().split('def log_snapshot(paths):',1)[1].split('\ncoords_path=',1)[0]
    exec('def log_snapshot(paths):'+source,namespace)
    try:
        namespace['log_snapshot'](paths)
        raise AssertionError('unstable rotation incorrectly accepted')
    except Unavailable: pass
    print('PASS: three unstable log snapshots fail closed')
PY
