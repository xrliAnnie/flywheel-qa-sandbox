import json,re,hashlib
from pathlib import Path
root=Path(__file__).resolve().parents[4]
fixture=root/'packages/teamlead/src/__tests__/fixtures/fly2912-evening'
index=json.loads((fixture/'replay-index.json').read_text())['entries']
mail=[json.loads(s) for s in (fixture/'mailbox-v2.jsonl').read_text().splitlines()]
by_seq={e['seq']:e for e in index}; known_batches={r['batch_id'] for r in mail if r.get('batch_id')}
p=Path('/Users/xiaorongli/.claude/projects/-Users-xiaorongli--flywheel-lead-workspace-flywheel-eng-lead/e051d32f-92e3-4b1b-ab18-6f0a83471413.jsonl')
raw=p.read_bytes()
prior=root/'engineering/doc/FLY-2912-quiet-notification-expansion/evidence/carrier-observation.json'
if prior.exists(): raw=raw[:json.loads(prior.read_text())['source']['completePrefixBytes']]
complete=raw[:raw.rfind(b'\n')+1]
start,end='2026-09-26T01:30:00','2026-09-26T04:00:00'
meta={}; users=[]; assistants=[]; duration=[]
for line in complete.splitlines():
 try:r=json.loads(line)
 except:continue
 t=r.get('timestamp',''); uid=r.get('uuid');typ=r.get('type');msg=r.get('message') or {}
 if not isinstance(msg,dict):msg={}
 content=msg.get('content'); isinput=typ=='user' and isinstance(content,str)
 if uid:meta[uid]={'parent':r.get('parentUuid'),'input':isinput}
 if start<=t<end:
  if isinput:
   batches=sorted(set(re.findall(r'\[mailbox-batch ([^\s|\]]+)',content)) & known_batches)
   seqs=sorted(set(int(s) for s in re.findall(r'\[Event #(\d+)\]',content)) & by_seq.keys())
   users.append({'uuid':uid,'timestamp':t,'knownMailboxBatchIds':batches,'sourceEventSeqs':seqs,'assistantRequestIds':[]})
  if typ=='assistant':assistants.append({'uuid':uid,'requestId':r.get('requestId'),'timestamp':t,'stopReason':msg.get('stop_reason')})
  if typ=='system' and r.get('subtype')=='turn_duration':duration.append({'uuid':uid,'timestamp':t,**{k:v for k,v in r.items() if ('duration' in k.lower() or k=='turnId') and isinstance(v,(int,float,str))}})
roots={u['uuid']:u for u in users}
for a in assistants:
 cur=a['uuid'];seen=set(); nearest=None
 while cur and cur not in seen:
  seen.add(cur); row=meta.get(cur)
  if row is None:break
  if row['input']:nearest=cur;break
  cur=row['parent']
 if nearest in roots and a['requestId']:roots[nearest]['assistantRequestIds'].append(a['requestId'])
for u in users:u['assistantRequestIds']=sorted(set(u['assistantRequestIds']))
matched_seqs=sorted(set(s for u in users for s in u['sourceEventSeqs']))
matched_batches=sorted(set(b for u in users for b in u['knownMailboxBatchIds']))
consumed=[u for u in users if u['assistantRequestIds'] and (u['knownMailboxBatchIds'] or u['sourceEventSeqs'])]
result={'schemaVersion':1,'source':{'fileName':p.name,'completePrefixBytes':len(complete),'completePrefixSha256':hashlib.sha256(complete).hexdigest()},'window':{'start':'2026-09-26T01:30:00Z','endExclusive':'2026-09-26T04:00:00Z'},'method':'Only user string inputs containing exact known mailbox-batch IDs or [Event #seq] join to frozen inputs. Model requests follow actual parentUuid ancestry to the nearest user string. No text/tool arguments/credentials retained. System turn_duration counts cover the entire Lead, not just these 257 rows. These are consumed inputs and requests, not inferred sleep-to-awake transitions.','counts':{'sourceEvents':len(index),'historicalModelRows':sum(e['observedJournalDisposition']=='model' for e in index),'userStringInputs':len(users),'userInputsWithKnownSources':sum(bool(u['knownMailboxBatchIds'] or u['sourceEventSeqs']) for u in users),'knownSourceInputsWithAssistantDescendant':len(consumed),'exactSourceEventSeqMatches':len(matched_seqs),'exactSourceBatchMatches':len(matched_batches),'allLeadCompletedTurnMarkers':len(duration),'allLeadDistinctModelRequests':len(set(a['requestId'] for a in assistants if a['requestId']))},'inputTimeline':users,'completedTurnMarkers':duration,'matchedSourceSeqs':matched_seqs,'unmatchedSourceSeqs':[e['seq'] for e in index if e['seq'] not in matched_seqs],'limitations':['Assistant API requests are not independent Lead wakeups.','A known event may be embedded into an already running turn or queued alongside unrelated work.','No prior idle state or per-source first-action latency inferred.','This historical baseline does not prove revised ON/OFF model consumption.']}
out=root/'engineering/doc/FLY-2912-quiet-notification-expansion/evidence/carrier-observation.json';out.write_text(json.dumps(result,indent=2,ensure_ascii=False)+'\n')
print(json.dumps(result['counts'],ensure_ascii=False))
