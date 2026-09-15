#!/usr/bin/env python3
"""Read-only research extractor. Usage is charged once per request, never per block."""
import argparse, collections, csv, hashlib, json, pathlib, re
p = argparse.ArgumentParser()
p.add_argument('transcript', type=pathlib.Path)
p.add_argument('--since', default='2026-09-12')
p.add_argument('--until', default='2026-09-14')
p.add_argument('--bytes', type=int)
p.add_argument('--out', type=pathlib.Path, required=True)
a = p.parse_args()
limit = a.bytes or a.transcript.stat().st_size
fields = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
raw = collections.defaultdict(collections.Counter)
requests, ancestry, users, tools = {}, {}, [], {}
batches, events, bootstrap = [], [], []
errors = 0
h = hashlib.sha256()

def classify(text):
    blocks = re.findall(r'<teammate-message\b[^>]*>(.*?)</teammate-message>', text, re.S)
    kinds = []
    for b in blocks:
        if '## Bootstrap — Lead:' in b: k = 'bootstrap'
        elif re.search(r'\| from founder\]', b): k = 'founder'
        else:
            ev = re.findall(r'\[Event #\d+\]\s*(?:\[[^\]]+\]\s*)?(\w+)', b)
            if ev and len(set(ev)) == 1:
                k = ev[0]
                if k == 'runner_question': k = 'runner_report' if '[REPORT]' in b else 'runner_ask'
            elif ev: k = 'mixed_events'
            elif re.search(r'\| from ', b): k = 'other_mailbox'
            else: k = 'other_teammate'
        kinds.append(k)
    if not kinds:
        if text.startswith('[self-wakeup') or text.startswith('[session-cron'): return 'self_schedule'
        if text.startswith('This session is being continued'): return 'compact_summary'
        if '<task-notification>' in text: return 'task_notification'
        return 'other_input'
    if len(set(kinds)) == 1: return kinds[0]
    return 'mixed_with_founder' if 'founder' in kinds else 'mixed_without_founder'

with a.transcript.open('rb') as f:
    consumed = 0
    for lineno, line in enumerate(f, 1):
        if consumed + len(line) > limit: break
        consumed += len(line); h.update(line)
        try: o = json.loads(line)
        except (ValueError, UnicodeDecodeError): errors += 1; continue
        typ, uid = o.get('type'), o.get('uuid')
        ts, m = o.get('timestamp', ''), o.get('message', {})
        day, content = ts[:10], m.get('content', '')
        selected = a.since <= day <= a.until
        source = ancestry.get(o.get('parentUuid'))
        if typ == 'user' and not (isinstance(content, list) and any(b.get('type') == 'tool_result' for b in content)):
            text = content if isinstance(content, str) else '\n'.join(b.get('text', '') for b in content if b.get('type') == 'text')
            source = {'source_uuid': uid, 'source_line': lineno, 'source_kind': classify(text)}
            if selected:
                users.append(dict(source, timestamp=ts, chars=len(text)))
                for b in re.findall(r'<teammate-message\b[^>]*>(.*?)</teammate-message>', text, re.S):
                    for bid in re.findall(r'\[mailbox-batch ([\w-]+)', b): batches.append({'day': day, 'batch_id': bid, 'line': lineno})
                    for seq, event in re.findall(r'\[Event #(\d+)\]\s*(?:\[[^\]]+\]\s*)?(\w+)', b): events.append({'day': day, 'seq': seq, 'type': event, 'line': lineno})
                    if '## Bootstrap — Lead:' in b:
                        qs = re.findall(r'^- .*\[(ASK|REPORT)\].*?\(ID: ([^,]+),', b, re.M)
                        bootstrap.append({'day': day, 'line': lineno, 'chars': len(b), 'sha256': hashlib.sha256(b.encode()).hexdigest(), 'question_ids': [q[1] for q in qs], 'ask_count': sum(q[0] == 'ASK' for q in qs), 'report_count': sum(q[0] == 'REPORT' for q in qs), 'done_prefixed': len(re.findall(r'^- .*\[ASK\].*?: DONE:', b, re.M))})
        if uid: ancestry[uid] = source
        if typ == 'assistant' and m.get('usage') and selected:
            u = {k: m['usage'].get(k, 0) for k in fields}
            raw[day].update(u); raw[day]['rows'] += 1
            key = o.get('requestId') or m.get('id') or uid
            if key not in requests:
                requests[key] = dict(request_id=key, message_id=m.get('id'), day=day, line=lineno, model=m.get('model'), version=o.get('version'), **(source or {'source_uuid': '', 'source_line': 0, 'source_kind': 'unresolved'}), **u, rows=0, tools=set(), followups=False, usage_conflict=False)
            r = requests[key]; r['rows'] += 1
            r['usage_conflict'] |= any(r[k] != u[k] for k in fields)
            for b in content if isinstance(content, list) else []:
                if b.get('type') == 'tool_use':
                    name = b.get('name', '')
                    r['tools'].add(name)
                    tools[b['id']] = {'day': day, 'name': name}
                    if name == 'Bash' and 'FOLLOWUPS.md' in b.get('input', {}).get('command', ''): r['followups'] = True

def aggregate(rows, key):
    out = collections.defaultdict(collections.Counter)
    for r in rows:
        out[r[key]].update({k: r[k] for k in fields}); out[r[key]]['requests'] += 1
    return dict(out)

for r in requests.values():
    names = r['tools']
    r['tool_group'] = 'ack_only' if names and all('ack_batch' in n for n in names) else 'ack_mixed' if any('ack_batch' in n for n in names) else 'other_tools' if names else 'no_tool'
    r['tools'] = '|'.join(sorted(names))
a.out.mkdir(parents=True, exist_ok=True)
rows = list(requests.values())
with (a.out / 'requests.csv').open('w') as f:
    w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)
(a.out / 'inputs.json').write_text(json.dumps({'users': users, 'batches': batches, 'events': events, 'bootstrap': bootstrap}, indent=2) + '\n')
summary = {'source_file': a.transcript.name, 'prefix_bytes': consumed, 'prefix_sha256': h.hexdigest(), 'since_utc': a.since, 'until_utc_inclusive': a.until, 'parse_errors': errors, 'usage_conflicts': sum(r['usage_conflict'] for r in rows), 'raw_by_day': dict(raw), 'unique_by_day': aggregate(rows, 'day'), 'model_requests_by_day': aggregate([r for r in rows if r['model'] != '<synthetic>'], 'day'), 'synthetic_by_day': dict(collections.Counter(r['day'] for r in rows if r['model'] == '<synthetic>')), 'daily': {}}
for day in sorted(raw):
    rr = [r for r in rows if r['day'] == day and r['model'] != '<synthetic>']
    bb = collections.Counter(b['batch_id'] for b in batches if b['day'] == day)
    ee = collections.Counter(e['seq'] for e in events if e['day'] == day)
    summary['daily'][day] = {'source_usage': aggregate(rr, 'source_kind'), 'tool_usage': aggregate(rr, 'tool_group'), 'followups_usage': aggregate([r for r in rr if r['followups']], 'day'), 'inputs_by_kind': dict(collections.Counter(u['source_kind'] for u in users if u['timestamp'][:10] == day)), 'event_occurrences': dict(collections.Counter(e['type'] for e in events if e['day'] == day)), 'batch_occurrences': sum(bb.values()), 'unique_batches': len(bb), 'repeated_event_occurrences': sum(n-1 for n in ee.values()), 'tool_calls': dict(collections.Counter(t['name'] for t in tools.values() if t['day'] == day))}
(a.out / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')
print(json.dumps({'unique_by_day': summary['unique_by_day'], 'usage_conflicts': summary['usage_conflicts'], 'day14': summary['daily'].get('2026-09-14')}, indent=2))
