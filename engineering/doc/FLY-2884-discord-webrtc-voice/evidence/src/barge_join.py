# FLY-2884: per valid barge-in attempt, bridge-clock detection latency + server cut + content outcome.
import json, sys, importlib.util
run = sys.argv[1]
D = f'/tmp/fly2884-proto/runs/{run}'
L = [json.loads(l) for l in open(f'{D}/bridge.jsonl')]
off = [x['data']['ms'] - x['t'] * 1000 for x in L if x['kind'] == 'mark'][0]
ev = []
for x in L:
    if x['kind'] == 'dc_event' and x['data']['type'] in ('turn.created', 'turn.done') and isinstance(x['data']['raw'], dict):
        t = x['data']['raw']['turn']
        ev.append({'bt': x['t'] * 1000 + off, 'type': x['data']['type'], 'role': t['role'], 's': t['start_ms'], 'e': t['end_ms'], 'tx': t['transcript']})
spec = importlib.util.spec_from_file_location('bb', '/tmp/fly2884-proto/barge_bridge.py')
fr = json.load(open(f'{D}/frames-bridge.json')); m = json.load(open(f'{D}/metrics-bridge.json'))
def segs(frames, th):
    out, cur = [], None
    for f in frames:
        if f['rms'] > th:
            if cur and f['t'] - cur['last'] <= 400: cur['last'] = f['t']; cur['v'] += 20
            else:
                if cur: out.append(cur)
                cur = {'start': f['t'], 'last': f['t'], 'v': 20}
    if cur: out.append(cur)
    return [s for s in out if s['v'] >= 200]
us = segs(fr['up'], m['calibration']['up']['th'])
s = json.load(open(f'{D}/metrics-speaker.json'))
nvalid = len(s['bargeEval'])
# interrupt user turns = user turn.done whose transcript looks like an interruption
rows = []
dones = [e for e in ev if e['type'] == 'turn.done']
for i, e in enumerate(dones):
    if e['role'] != 'user' or not any(k in e['tx'] for k in ('停', '等等', '打断', '好了', '听一下')): continue
    prev_a = [d for d in dones[:i] if d['role'] == 'assistant']
    old = prev_a[-1] if prev_a else None
    cut = old is not None and old['e'] <= e['s'] + 400  # server truncated old answer near interrupt onset
    nxt = dones[i + 1] if i + 1 < len(dones) and dones[i + 1]['role'] == 'assistant' else None
    created = [c for c in ev if c['type'] == 'turn.created' and c['role'] == 'user' and c['s'] == e['s']]
    # bridge upStart of the interrupt: last uplink segment start before the created event
    ups = [u for u in us if u['start'] < (created[0]['bt'] if created else e['bt'])]
    up_start = ups[-1]['start'] if ups else None
    det = round(created[0]['bt'] - up_start) if created and up_start else None
    ans = nxt['tx'] if nxt else ''
    import re
    honored = bool(nxt) and re.sub(r'[^一-鿿]', '', ans)[:12].find('等于') >= 0 or ans.startswith(('等于', '嗯哼', '。等于'))
    rows.append({'interrupt': e['tx'], 'serverCutOld': cut, 'oldTail': old['tx'][-18:] if old else None,
                 'detectMsAtBridge': det, 'nextAnswer': ans[:40], 'honoredFirst': honored})
print(json.dumps(rows, ensure_ascii=False, indent=0))
