#!/usr/bin/env bash
# FLY-1948: sourceable, read-only channel observations. Bash 3.2 compatible.
# CMD seams name executable files; arguments remain data, never eval'd.
qa_discord_observe() {
  local op="$1"; shift
  local seam="" lib_dir
  case "$op" in
    ps) seam="${FLYWHEEL_QA_PS_SNAPSHOT_CMD:-}" ;;
    start) seam="${FLYWHEEL_QA_PS_LSTART_CMD:-}" ;;
    lsof) seam="${FLYWHEEL_QA_LSOF_CMD:-}" ;;
    env) seam="${FLYWHEEL_QA_ENV_HAS_CMD:-}" ;;
    pane) seam="${FLYWHEEL_QA_PANE_CAPTURE_CMD:-}" ;;
    launch) seam="${FLYWHEEL_QA_LAUNCHD_PID_CMD:-}" ;;
    *) return 2 ;;
  esac
  if [[ -n "$seam" ]]; then
    if [[ "$op" == start ]]; then TZ=UTC LC_ALL=C "$seam" "$@"; else "$seam" "$@"; fi
    return $?
  fi
  case "$op" in
    ps) ps axww -o pid= -o ppid= -o command= ;;
    start) TZ=UTC LC_ALL=C /bin/ps -p "$1" -o lstart= ;;
    lsof) lsof -nP -iTCP -a -sTCP:ESTABLISHED -p "$1" ;;
    pane) "${FLYWHEEL_QA_TMUX:-tmux}" -S "$1" capture-pane -t '=main:main.%0' -p ;;
    env|launch)
      lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" || return 2
      source "$lib_dir/qa-launchd-lead.sh" || return 2
      if [[ "$op" == env ]]; then qa_launchd_process_env_has "$@"
      else qa_launchd_lead_pid_exact "$@"; fi ;;
  esac
}

qa_discord_is_adapter_argv() { qa_discord_liveness_python match "$1"; }
qa_discord_redact_line() { qa_discord_liveness_python redact "$1"; }
qa_discord_liveness_probe() { qa_discord_liveness_python probe "$@"; }
qa_discord_liveness_wait() {
  local coords="$1" since="$2" out="$3" timeout="$4" begin=$SECONDS rc=2
  [[ "$timeout" =~ ^[1-9][0-9]*$ && "${#timeout}" -le 4 ]] || return 2
  (( timeout <= 3600 )) || return 2
  while :; do
    rc=0
    qa_discord_liveness_probe "$coords" "$since" "$out" || rc=$?
    [[ "$rc" -eq 0 || "$rc" -eq 3 ]] && return "$rc"
    (( SECONDS - begin >= timeout )) && return "$rc"
    sleep 2
  done
}

qa_discord_liveness_python() {
  local lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/qa-discord-liveness.sh"
  python3 - "$lib" "$@" <<'PY'
import datetime as dt
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

LIB, OP, *ARGS = sys.argv[1:]
UTC = dt.timezone.utc
class Unavailable(Exception): pass
class Verdict(Exception):
    def __init__(self, reason, rc=1): self.reason, self.rc = reason, rc

def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)', value):
        raise ValueError('invalid ISO timestamp')
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00')).astimezone(UTC)
def iso(value): return value.isoformat(timespec='milliseconds').replace('+00:00','Z')
def redact(line):
    suspect = re.search(r'token|secret|password|authorization|bearer|api[_-]?key',line,re.I)
    for word in re.findall(r'[A-Za-z0-9_./+=-]{24,}',line):
        if re.search('[A-Za-z]',word) and re.search('[0-9]',word): suspect=True
    return '<redacted>' if suspect else line

def adapter(argv):
    words=argv.split()
    return len(words)>=2 and (words[0]=='bun' or words[0].endswith('/bun')) and bool(re.fullmatch(r'/\S*/plugins/cache/[^/]+/discord/[^/]+/server\.ts', words[1]))
def tail(lines): return [redact(x).encode('utf-8')[:200].decode('utf-8','ignore') for x in lines[-40:]]

if OP=='match': raise SystemExit(0 if adapter(ARGS[0]) else 1)
if OP=='redact': print(redact(ARGS[0])); raise SystemExit(0)
if OP!='probe': raise SystemExit(2)

def safe_read(path, limit=65536):
    fd=os.open(path,os.O_RDONLY | getattr(os,'O_NOFOLLOW',0) | getattr(os,'O_NONBLOCK',0))
    with os.fdopen(fd,'rb') as stream:
        st=os.fstat(stream.fileno())
        if not stat.S_ISREG(st.st_mode) or st.st_size>limit: raise ValueError('invalid evidence file')
        raw=stream.read(limit+1)
        if len(raw)>limit: raise ValueError('oversized evidence')
        return raw.decode('utf-8')
def object_file(path):
    obj=json.loads(safe_read(path))
    if not isinstance(obj,dict): raise ValueError('expected object')
    return obj

def observe(op,*args):
    # Capture to private scratch files; only bounded stdout enters memory and
    # stderr is never copied into artifacts (env commands can expose secrets).
    limit=4*1024*1024 if op=='ps' else 65536
    try:
        with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as error:
            p=subprocess.run(['bash','-c','source "$1"; shift; qa_discord_observe "$@"','observe',LIB,op,*map(str,args)],stdout=output,stderr=error,timeout=10)
            output.seek(0); raw=output.read(limit+1)
        if p.returncode<0 or p.returncode>=2 or len(raw)>limit: raise Unavailable(op)
        return p.returncode,raw.decode('utf-8')
    except (OSError,UnicodeDecodeError,subprocess.TimeoutExpired) as exc: raise Unavailable(op) from exc

def incarnation(pid):
    rc,text=observe('start',pid)
    if rc: raise Unavailable('start')
    try: return dt.datetime.strptime(' '.join(text.split()),'%a %b %d %H:%M:%S %Y').replace(tzinfo=UTC)
    except ValueError as exc: raise Unavailable('start') from exc

def log_snapshot(paths):
    def identity(path):
        try:
            st=path.lstat()
            if not stat.S_ISREG(st.st_mode): raise Unavailable('gateway log file')
            return st.st_ino,st.st_size,st.st_mtime_ns
        except FileNotFoundError: return None
    for attempt in range(3):
        before=[identity(p) for p in paths]
        try: texts=[safe_read(p,262144+65536) if info else '' for p,info in zip(paths,before)]
        except FileNotFoundError: continue
        after=[identity(p) for p in paths]
        if before==after: return texts,attempt
    raise Unavailable('unstable gateway logs')

coords_path=Path(ARGS[0]); out_path=Path(ARGS[2])
# Output authority is tied to the supplied coordinate artifact, not arbitrary
# paths carried in JSON. Reject unsafe output rather than following a symlink.
try:
    if (not coords_path.is_absolute() or coords_path.name!='lead-coordinates.json'
        or coords_path.parent.parent.name!='launchd'
        or out_path != coords_path.parent/'channel-liveness.json'
        or any(p.is_symlink() for p in [coords_path,coords_path.parent,coords_path.parent.parent,out_path])):
        raise ValueError('invalid coordinate/output location')
except (OSError,ValueError): raise SystemExit(2)
result={'schemaVersion':1,'agentId':coords_path.parent.name,'carrier':None,'live':False,'reason':None,'observedAt':iso(dt.datetime.now(UTC)),
    'since':{'requested':ARGS[1],'effective':ARGS[1],'claudeStartSecond':None,'bodyStartedAt':None,'bodyStartAdopted':False,'gatewayCutoff':None,'ambiguousLinesIgnored':0,'logSnapshotRetries':0},
    'claude':{'pid':None,'startedAt':None},'adapter':{'pid':None,'ppid':None,'startedAt':None,'argv':None,'others':[],'rejectedLegacyShapes':[]},
    'socket':{'established':0,'peers':[]},'gateway':{'state':None,'readyAt':None,'logPath':None,'lastLifecycle':[]},'pollerVerdict':'none',
    'evidence':{'paneTail':[],'gatewayLogTail':[],'startupLogSince':[]}}
rc=2
try:
    c=object_file(coords_path)
    if c.get('schemaVersion')!=1 or c.get('agentId')!=coords_path.parent.name or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*',c['agentId']): raise ValueError('invalid coordinates')
    result['carrier']=c['carrier']
    if c['carrier']!='claude-code': raise Verdict('not_applicable',3)
    requested=timestamp(ARGS[1]); state=Path(c['discordStateDir'])
    if not state.is_absolute() or Path(c['manifestPath'])!=coords_path.parent/'manifest.json' or Path(c['bodyStatusPath'])!=coords_path.parent/'body-status.json': raise ValueError('invalid coordinate paths')
    status,ps=observe('ps')
    if status: raise Unavailable('ps')
    rows=[]
    for line in ps.splitlines():
        if not line.strip(): continue
        m=re.fullmatch(r'\s*([1-9][0-9]*)\s+([0-9]+)\s+(.+)',line)
        if not m: raise Unavailable('malformed ps row')
        rows.append((int(m[1]),int(m[2]),m[3]))
    candidates=[]; adapters=[]; legacy=[]; candidate_count=0
    for row in rows:
        words=row[2].split()
        is_claude=len(words)>=3 and words[:3]==['claude','--agent',c['agentId']]
        is_adapter=adapter(row[2])
        is_legacy=len(words)>=2 and (words[0]=='bun' or words[0].endswith('/bun')) and (words[1]=='server.ts' or words[1:3]==['run','--cwd'])
        if is_claude or is_adapter or is_legacy:
            candidate_count+=1
            if candidate_count>32: raise Unavailable('candidate limit')
            env_rc,_=observe('env',row[0],'DISCORD_STATE_DIR',str(state))
            if env_rc==0:
                (candidates if is_claude else adapters if is_adapter else legacy).append(row)
    result['adapter']['rejectedLegacyShapes']=tail([r[2] for r in legacy])
    if not candidates: raise Verdict('claude_process_missing')
    if len(candidates)>1: raise Verdict('claude_process_ambiguous')
    claude=candidates[0]; start=incarnation(claude[0])
    result['claude']={'pid':claude[0],'startedAt':iso(start)}
    effective=max(requested,start)
    result['since']['claudeStartSecond']=iso(start)
    launch_rc,launch=observe('launch',c['launchdLabel'])
    try:
        body=object_file(c['bodyStatusPath']); manifest=object_file(c['manifestPath'])
        carrier=body.get('carrierPid')
        if body.get('schemaVersion')==1 and type(carrier) is int and carrier>0 and carrier==manifest.get('pid') and launch_rc==0 and re.fullmatch('[1-9][0-9]*',launch.strip()) and carrier==int(launch):
            body_start=timestamp(body['startedAt']); effective=max(effective,body_start)
            result['since'].update(bodyStartedAt=iso(body_start),bodyStartAdopted=True)
    except (OSError,ValueError,KeyError): pass
    result['since']['effective']=iso(effective)
    # Poller evidence is advisory; missing logs never establish channel health.
    startup=Path.home()/'.flywheel/logs'/('lead-'+c['agentId']+'-startup.log')
    try:
        lines=[]
        for line in safe_read(startup,262144+65536).splitlines():
            parts=line.split(' ',1)
            if len(parts)==2 and 'dialog-poller-v2:' in parts[1]:
                try: when=timestamp(parts[0] if parts[0].endswith('Z') else parts[0]+'Z')
                except ValueError: continue
                if when>=effective: lines.append(line)
        result['evidence']['startupLogSince']=tail(lines)
        for line in reversed(lines):
            for key,val in [('confirmed=1','confirmed'),('NOT_SEEN','not_seen'),('SEND_FAILED','send_failed'),('UNVERIFIED','unverified'),('VERIFY_FAILED','unverified'),('pane gone','pane_gone'),('no tmux','no_tmux')]:
                if key in line: result['pollerVerdict']=val; break
            if result['pollerVerdict']!='none': break
    except (OSError,ValueError): pass
    if not adapters:
        _,pane=observe('pane',c['socketPath'])
        result['evidence']['paneTail']=tail(pane.splitlines())
        if 'WARNING: Loading development channels' in pane and 'I am using this for local development' in pane: raise Verdict('dev_channels_dialog_parked')
        raise Verdict('adapter_missing')
    result['adapter']['others']=[{'pid':r[0],'ppid':r[1],'argv':redact(r[2])} for r in adapters]
    if any(r[1]!=claude[0] for r in adapters): raise Verdict('adapter_orphaned')
    if len(adapters)>1: raise Verdict('adapter_process_ambiguous')
    current=adapters[0]; adapter_start=incarnation(current[0])
    result['adapter'].update(pid=current[0],ppid=current[1],startedAt=iso(adapter_start),argv=redact(current[2]),others=[])
    if adapter_start<start: raise Verdict('adapter_orphaned')
    cutoff=max(effective,adapter_start); result['since']['gatewayCutoff']=iso(cutoff)
    _,sockets=observe('lsof',current[0])
    peers=re.findall(r'->([^\s]+:443)\s+\(ESTABLISHED\)',sockets)
    result['socket']={'established':len(peers),'peers':peers}
    if not peers: raise Verdict('gateway_socket_missing')
    log=state/'gateway-health.log'; result['gateway']['logPath']=str(log)
    texts,retries=log_snapshot([state/'gateway-health.log.1',log]); result['since']['logSnapshotRetries']=retries
    result['evidence']['gatewayLogTail']=tail('\n'.join(texts).splitlines())
    lifecycle=[]; stale=False
    for file_index,text in enumerate(texts):
        for line_index,line in enumerate(text.splitlines()):
            parts=line.split(' ',1)
            if len(parts)!=2: continue
            try: when=timestamp(parts[0])
            except ValueError: continue
            msg=parts[1]
            ready=bool(re.fullmatch(r'gateway shard \d+ (?:ready|resumed; replayed=\d+)',msg))
            degraded=bool(re.match(r'gateway shard \d+ (?:reconnecting$|disconnected permanently;|reconnect deadline elapsed)',msg))
            if not ready and not degraded: continue
            if any(generation<=when<generation+dt.timedelta(seconds=1) for generation in [start,adapter_start]):
                result['since']['ambiguousLinesIgnored']+=1; continue
            if when<cutoff+dt.timedelta(seconds=1):
                if ready: stale=True
                continue
            lifecycle.append((when,file_index,line_index,'ready' if ready else 'degraded',line))
    lifecycle.sort(key=lambda item:item[:3])
    result['gateway']['lastLifecycle']=tail([x[4] for x in lifecycle[-3:]])
    if not lifecycle: raise Verdict('gateway_ready_stale' if stale else 'gateway_ready_missing')
    latest=lifecycle[-1]; result['gateway']['state']=latest[3]
    if latest[3]!='ready': raise Verdict('gateway_degraded')
    result['gateway']['readyAt']=iso(latest[0]); result['live']=True; rc=0
except Verdict as verdict:
    result['reason']=verdict.reason; rc=verdict.rc
    if rc==3: result['live']=None
except (Unavailable,OSError,ValueError,KeyError,TypeError):
    result['reason']='probe_unavailable'; rc=2
try:
    fd,tmp=tempfile.mkstemp(prefix='.channel-liveness.',dir=out_path.parent)
    try:
        with os.fdopen(fd,'w') as stream: json.dump(result,stream,ensure_ascii=False,indent=2); stream.write('\n')
        os.replace(tmp,out_path)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
except OSError: raise SystemExit(2)
raise SystemExit(rc)
PY
}
