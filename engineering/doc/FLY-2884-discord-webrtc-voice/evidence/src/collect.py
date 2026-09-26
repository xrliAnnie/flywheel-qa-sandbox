# FLY-2884: copy sanitized evidence of one or more runs into the repo doc folder.
# Refuses to write anything that contains a loaded secret value, a JWT, a bearer/bot token or an auth field.
import gzip, json, os, re, shutil, subprocess, sys

SRC = '/tmp/fly2884-proto'
DST = '/Users/xiaorongli/Dev/flywheel-FLY-2884/engineering/doc/FLY-2884-discord-webrtc-voice/evidence'
secrets = []
for line in open(os.path.expanduser('~/.flywheel/.env')):
    m = re.match(r'^(?:export\s+)?([A-Z0-9_]+)=["\']?([^"\'\n]+)', line)
    if m and re.search(r'TOKEN|SECRET|KEY', m.group(1)) and len(m.group(2)) >= 12:
        secrets.append(m.group(2).strip())
auth = json.load(open(os.path.expanduser('~/.codex/auth.json')))
for k, v in (auth.get('tokens') or {}).items():
    if isinstance(v, str) and len(v) >= 12: secrets.append(v)
BAD = [re.compile(p) for p in (r'eyJ[A-Za-z0-9_\-]{20,}\.', r'sk-[A-Za-z0-9_\-]{16,}', r'(?i)"(access_token|refresh_token|id_token|secret_key|authorization)"\s*:\s*"[^"*]', r'(Bot|Bearer) [A-Za-z0-9._\-]{24,}')]

def check(text, name):
    for s in secrets:
        if s in text: raise SystemExit(f'SECRET VALUE in {name} — refusing')
    for b in BAD:
        if b.search(text): raise SystemExit(f'secret pattern {b.pattern} in {name} — refusing')

def put(rel, data, binary=False):
    path = os.path.join(DST, rel); os.makedirs(os.path.dirname(path), exist_ok=True)
    if not binary: check(data, rel)
    with open(path, 'wb' if binary else 'w') as f: f.write(data)

for run in sys.argv[1:]:
    d = f'{SRC}/runs/{run}'
    for name in ('bridge.jsonl', 'speaker.jsonl', 'metrics-bridge.json', 'metrics-speaker.json'):
        if os.path.exists(f'{d}/{name}'): put(f'{run}/{name}', open(f'{d}/{name}').read())
    for name in ('frames-bridge.json', 'frames-room.json'):
        if os.path.exists(f'{d}/{name}'):
            raw = open(f'{d}/{name}').read(); check(raw, name)
            put(f'{run}/{name}.gz', gzip.compress(raw.encode(), 9), binary=True)
    for wavname, out in (('room.wav', 'room.m4a'), ('downlink.wav', 'downlink.m4a'), ('uplink.wav', 'uplink.m4a')):
        if run == 's7' or wavname != 'room.wav': continue  # founder run: recordings stay local (promised in the invitation)
        if os.path.exists(f'{d}/{wavname}'):
            os.makedirs(f'{DST}/{run}', exist_ok=True)
            subprocess.run(['ffmpeg', '-loglevel', 'error', '-y', '-i', f'{d}/{wavname}', '-ac', '1', '-c:a', 'aac', '-b:a', '24k', f'{DST}/{run}/{out}'], check=True)
    print('collected', run)

# quota readings: keep only what the report needs; mask the email local part
rows = []
for line in open(f'{SRC}/runs/quota.jsonl'):
    q = json.loads(line); p = q['rateLimits']['rateLimits']['primary']; b = (q.get('usage') or {}).get('dailyUsageBuckets') or []
    e = q['auth']['email'] or ''
    rows.append({'label': q['label'], 't': q['t'], 'weeklyUsedPercent': p['usedPercent'], 'windowMins': p['windowDurationMins'], 'resetsAt': p['resetsAt'],
                 'todayTokens': b[-1]['tokens'] if b and b[-1]['startDate'] == q['t'][:10] else None, 'plan': q['auth']['plan'],
                 'authMtime': q['auth']['mtime'], 'authLastRefresh': q['auth']['lastRefresh'], 'email': (e[:4] + '…@' + e.split('@')[-1]) if e else None})
put('quota.json', json.dumps(rows, indent=1))
print('quota rows', len(rows))
