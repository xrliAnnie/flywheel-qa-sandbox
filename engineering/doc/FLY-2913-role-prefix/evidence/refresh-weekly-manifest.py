# Transcript-only discovery adapted from origin/main FLY-2904 census.py claude_pass.
# No sqlite import/connection and no prompt/content output. Bounded header reads.
import pathlib,datetime,json,re,hashlib,collections
root=pathlib.Path('/Users/xiaorongli/.claude/projects')
cutoff=datetime.datetime.now(datetime.timezone.utc); start=cutoff-datetime.timedelta(days=7)
out=pathlib.Path('/tmp/fly2913-history'); stats=collections.Counter(); entries=[]; parent={}; notes=[]
for p in sorted(root.rglob('*.jsonl')):
 try:
  if p.stat().st_mtime < start.timestamp():continue
  stats['eligibleFiles']+=1
  sid=None; texts=[]; size=0; lines=0; first_user=False
  with p.open('rb') as f:
   while lines<96 and size<2*1024*1024:
    line=f.readline(2*1024*1024+1);lines+=1;size+=len(line)
    if not line:break
    if len(line)>2*1024*1024:stats['oversizedHeaderLines']+=1;break
    try:r=json.loads(line)
    except (ValueError,UnicodeDecodeError):continue
    if not isinstance(r,dict):continue
    if isinstance(r.get('sessionId'),str):sid=sid or r['sessionId']
    if r.get('type')=='user' and not first_user:
     first_user=True
     content=r.get('message',{}).get('content',[]) if isinstance(r.get('message'),dict) else []
     if isinstance(content,str):texts.append(content)
     elif isinstance(content,list):texts.extend(b['text'] for b in content if isinstance(b,dict) and b.get('type')=='text' and isinstance(b.get('text'),str))

    a=r.get('attachment',{})
    if isinstance(a,dict) and a.get('type')=='prompt_snapshot':
     for t in a.get('systemPrompt',[]):
      if isinstance(t,str) and '## Agent Role' in t:texts.append(t[t.index('## Agent Role'):])
     break
    if r.get('type')=='assistant':break
    if r.get('type') in ['system','system_prompt','prompt_snapshot']:
     for k in ['content','prompt','systemPrompt','appendSystemPrompt','text']:
      if isinstance(r.get(k),str):texts.append(r[k])
  role='unattributed';basis='no_recognized_header'
  candidates=set()
  for t in texts:
   # Restrict runner phase match to initial role preamble, not quoted plan text.
   m=re.search(r'(?:^|\n)(?:## Agent Role\n)?# Workflow phase protocol: (design|implement|qa)(?:\s|$)',t[:1500])
   if m:candidates.add(m.group(1));basis='phase_protocol_header'
   if t.startswith('You are the CROSS-FAMILY REVIEWER for '):
    if '\n\nReview the DESIGN/PLAN at path:' in t:candidates.add('review-design');basis='cross_family_prompt_contract'
    elif '\n\nReview the CODE at commit ' in t:candidates.add('review-code');basis='cross_family_prompt_contract'
  if len(candidates)==1:role=next(iter(candidates))
  elif len(candidates)>1:basis='ambiguous_header';stats['ambiguousRoles']+=1
  sub='/subagents/' in str(p)
  if sub:
   pp=p.parent.parent.with_suffix('.jsonl')
   if role=='unattributed' and str(pp) in parent:
    role=parent[str(pp)];basis='explicit_parent_transcript_header'
  else:parent[str(p)]=role
  if not sid:
   stats['missingSessionId']+=1;notes.append({'path':str(p),'status':'missing_session_id'});continue
  entry={'path':str(p),'sessionId':sid,'role':role,'vendor':'claude','subagent':sub}
  if role.startswith('review-'):entry['reviewType']=role[7:]
  entries.append(entry);stats[role+('|subagent' if sub else '|main')]+=1
  notes.append({'path':str(p),'sessionId':sid,'role':role,'basis':basis,'headerBytes':size,'headerLines':lines})
 except OSError:stats['unreadableInputs']+=1;notes.append({'path':str(p),'status':'unreadable'})
manifest={'version':1,'transcripts':entries}
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(out/'discovery.json').write_text(json.dumps({'cutoff':cutoff.isoformat(),'start':start.isoformat(),'root':str(root),'stats':dict(stats),'method':'FLY-2904 transcript path discovery; bounded first-user/phase header role classification, unknown preserved; no DB','notes':notes},indent=2)+'\n')
print(json.dumps({'cutoff':cutoff.isoformat(),'stats':dict(stats),'manifest':str(out/'manifest.json')}))
