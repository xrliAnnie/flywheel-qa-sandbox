# FLY-2884: room-side barge-in stop time (speaker process clock only).
# stopMs = (start of the first >=GAP ms room silence after interrupt start) - interrupt start.
# A barge-in "stopped in time" when stopMs <= 1500. Content outcome (honored / resumed old topic)
# comes from the bridge's server transcripts and is joined by attempt order.
import json, sys
GAP = int(sys.argv[2]) if len(sys.argv) > 2 else 500
run = sys.argv[1]
s = json.load(open(f'/tmp/fly2884-proto/runs/{run}/metrics-speaker.json'))
fr = json.load(open(f'/tmp/fly2884-proto/runs/{run}/frames-room.json'))
th = s['calibration']['th']
voiced = [f['t'] for f in fr if f['rms'] > th]
out = []
for b in s['bargeEval']:
    t0 = b['interruptStart']
    after = [t for t in voiced if t >= t0 - 20]
    prev, stop = t0, None
    for t in after:
        if t - prev >= GAP:
            stop = prev; break
        prev = t
    out.append({'idx': b['idx'], 'interruptStart': t0, 'roomStopMs': round(stop - t0) if stop else None,
                'stoppedIn1500': (stop is not None and stop - t0 <= 1500)})
print(json.dumps(out))
