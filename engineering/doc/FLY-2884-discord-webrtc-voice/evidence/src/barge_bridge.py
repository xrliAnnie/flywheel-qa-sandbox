# FLY-2884: bridge-side barge-in timing (single process clock).
# For every uplink speech segment that starts while a downlink speech segment is active,
# report: time from uplink speech start to the first >=300ms downlink silence gap.
import json, sys

def segs(frames, th, min_voiced=200, hang=400):
    out, cur = [], None
    for f in frames:
        if f['rms'] > th:
            if cur and f['t'] - cur['last'] <= hang:
                cur['last'] = f['t']; cur['v'] += 20
            else:
                if cur: out.append(cur)
                cur = {'start': f['t'], 'last': f['t'], 'v': 20}
    if cur: out.append(cur)
    return [s for s in out if s['v'] >= min_voiced]

run = sys.argv[1]
fr = json.load(open(f'/tmp/fly2884-proto/runs/{run}/frames-bridge.json'))
m = json.load(open(f'/tmp/fly2884-proto/runs/{run}/metrics-bridge.json'))
up, down = fr['up'], fr['down']
thu, thd = m['calibration']['up']['th'], m['calibration']['down']['th']
us, ds = segs(up, thu), segs(down, thd)
dv = [f for f in down if f['rms'] > thd]
res = []
for u in us:
    active = [d for d in ds if d['start'] < u['start'] <= d['last'] + 300]
    if not active: continue
    # first gap >= 300ms in voiced downlink frames after u.start
    after = [f['t'] for f in dv if f['t'] >= u['start'] - 40]
    stop = None
    prev = u['start']
    for t in after:
        if t - prev >= 300: stop = prev; break
        prev = t
    if stop is None and after: stop = after[-1]
    res.append({'upStart': round(u['start']), 'upEnd': round(u['last']), 'downLastBeforeGap': round(stop) if stop else None,
                'bridgeStopMs': round(stop - u['start']) if stop else None})
print(json.dumps(res, indent=1))
