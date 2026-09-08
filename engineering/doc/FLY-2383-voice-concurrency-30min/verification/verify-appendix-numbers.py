import json,os,re,sys,datetime
R=os.path.expanduser('~/.flywheel/raya/qa/FLY-2383-runs')
doc=open('product/doc/FLY-1850-headphone-voice-relay/measurement-appendix-FLY-2383.md',encoding='utf-8').read()
summ=json.load(open('engineering/doc/FLY-2383-voice-concurrency-30min/calibration/run-summary.json'))
cal=json.load(open('engineering/doc/FLY-2383-voice-concurrency-30min/calibration/calibration-report.json'))
a,b=summ['armA'],summ['armB']
checks=[]
def chk(label, claim, actual):
    ok = str(claim)==str(actual)
    checks.append((ok,label,claim,actual))

# head limits + conclusions
chk('arm A window ms', '1,802,534', f"{a['timing']['monotonicDurationMs']:,}")
chk('arm A teardown ms', '720', a['timing']['teardownMs'])
chk('arm A turns attempted', '10', a['turns']['attempted'])
chk('arm A within-deadline', '8', a['turns']['completed'])
chk('arm A uncontaminated', '10', a['turns']['uncontaminated'])
chk('arm A tool turns w/ rtt', '4', a['turns']['rttByKind']['tool']['n'])
chk('orch samples A', '60', a['orchestration']['samples'])
chk('orch executing A', '60', a['orchestration']['executingSamples'])
chk('voice_exit in-window A', '0', a['voiceExit']['withinObservationWindow'])
chk('bed seconds A', '84.60', f"{a['audio']['classSeconds']['bed']:.2f}")
chk('bed share A', '4.69', f"{a['audio']['classShare']['bed']*100:.2f}")
chk('bed seconds B', '0.60', f"{b['audio']['classSeconds']['bed']:.2f}")
chk('bed share B', '0.07', f"{b['audio']['classShare']['bed']*100:.2f}")
chk('holes A', '68', a['audio']['holes'])
chk('clock stalls in-window A', '4', a['audio']['clockStalls']['inWindow'])
chk('decoder errors A', '1', a['audio']['decoderErrors'])
chk('flywheel sha A', 'ec300f3b', a['provenance']['flywheelSha'][:8])
chk('flywheel sha B', '1b96c05b', b['provenance']['flywheelSha'][:8])
chk('flywheel dirty B', 'True', str(b['provenance']['flywheelDirty']))
chk('flywheel dirty A', 'False', str(a['provenance']['flywheelDirty']))
chk('runtime thresholds blob', '2878d1d0', a['provenance']['thresholdsFile']['sha256'][:8])
chk('probes A attempted', '5', a['probes']['tally']['attempted'])
chk('probes A eligible', '2', a['probes']['tally']['audioEligible'])
chk('probes A hit', '2', a['probes']['tally']['hit'])
chk('probes B eligible', '3', b['probes']['tally']['audioEligible'])
chk('probes B hit', '3', b['probes']['tally']['hit'])
chk('ambiguous_audio A', '3', a['probes']['tally']['ineligibleByReason']['ambiguous_audio'])
chk('collector files count', '7', len(a['provenance']['collector']))
# calibration
chk('cal n voice window', '1,603', f"{cal['windowFrames']['voice']:,}")
chk('neg control busy frames', '405', cal['negativeControl']['busyFrames'])
chk('neg control bed', '0', cal['negativeControl']['classified']['bed'])
# section 6 numbers recomputed from raw
m=json.load(open(f'{R}/fly2383-pilot-on-r7/manifest.json'))
t0w,t0m=m['timing']['t0WallMs'],m['timing']['t0MonoMs']
fr=[json.loads(l) for l in open(f'{R}/fly2383-pilot-on-r7/frames.jsonl')]
ev=[json.loads(l) for l in open(f'{R}/fly2383-pilot-on-r7/session/state/voice-evidence/events.jsonl') if l.strip()]
TH=json.load(open('engineering/doc/FLY-2383-voice-concurrency-30min/calibration/thresholds.json'))
def cls(f):
    if f['energy']<TH['silenceFloor']: return 'silence'
    if f['tonalRatio']>=TH['bedTonalMin'] and f['energy']<=TH['bedEnergyMax']: return 'bed'
    if f['energy']>=TH['voiceEnergyMin'] and f['tonalRatio']<=TH['voiceTonalMax']: return 'voice'
    return 'unknown'
def mono(ts): return datetime.datetime.fromisoformat(ts.replace('Z','+00:00')).timestamp()*1000-t0w+t0m
win=[]; runs=[]
for e in [x for x in ev if x.get('kind')=='realtime_transcript' and x['role']=='assistant']:
    at=mono(e['ts']); w=[f for f in fr if at+400<=f['atMonoMs']<=at+4000]
    if not w: continue
    win+=w
    cur=0;longest=0
    for f in w:
        if cls(f) in ('bed','silence'): cur+=1; longest=max(longest,cur)
        else: cur=0
    runs.append(longest*20)
from collections import Counter
c=Counter(cls(f) for f in win)
chk('sec6 n', '1,603', f"{len(win):,}")
chk('sec6 bed frames', '18', c['bed'])
chk('sec6 bed rate %', '1.12', f"{100*c['bed']/len(win):.2f}")
chk('sec6 blocking frames', '1,308', f"{c['voice']+c['unknown']:,}")
chk('sec6 blocking %', '81.6', f"{100*(c['voice']+c['unknown'])/len(win):.1f}")
chk('sec6 longest non-blocking ms', '960', max(runs))
chk('sec6 run list', '320 · 220 · 440 · 460 · 100 · 440 · 960 · 200 · 200', ' · '.join(str(x) for x in runs))
# round 1 / round 12 details
ar=json.load(open(f'{R}/fly2383-main-arm-a-r5/manifest.json'))
r1=[t for t in ar['turns'] if t['roundId']==1][0]; r12=[t for t in ar['turns'] if t['roundId']==12][0]
chk('round1 nonce','616670',r1['nonce']); chk('round12 nonce','269294',r12['nonce'])
late=[r for r in a['turns']['rounds'] if r['roundId']==12][0]
chk('round12 late rtt','37,916',f"{late['lateRttMs']:,}"); chk('round12 deadline','28,114',f"{late['deadlineMs']:,}")
bad=[c for c in checks if not c[0]]
print(f"checked {len(checks)} claimed numbers; MISMATCHES: {len(bad)}")
for ok,label,claim,actual in bad: print(f"   ✗ {label}: appendix says {claim!r}, artifacts give {actual!r}")
# and confirm each claim string actually appears in the doc
missing=[l for ok,l,cl,ac in checks if str(cl) not in doc]
print(f"claims not found verbatim in appendix: {len(missing)}")
for l in missing[:10]: print("   ?",l)
sys.exit(1 if bad else 0)
