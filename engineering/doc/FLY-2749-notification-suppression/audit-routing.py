#!/usr/bin/env python3
"""Read-only bounded production census. No payload bodies/credentials are emitted."""
import sqlite3,json,os,datetime,collections,argparse
a=argparse.ArgumentParser();a.add_argument("--start",default="2026-09-17");args=a.parse_args();start=args.start
out={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'windowStart':start+'T00:00:00Z'}
for name,path in [('teamlead','~/.flywheel/teamlead.db'),('comm','~/.flywheel/comm/flywheel/comm.db')]:
 c=sqlite3.connect('file:'+os.path.expanduser(path)+'?mode=ro',uri=True,timeout=3); c.row_factory=sqlite3.Row
 if name=='teamlead':
  out['flags']=[dict(r) for r in c.execute("select flag_name,scope,has_override,raw_value,last_effective,revision from flag_values where flag_name='lead_token_savings'")]
  out['events']=[dict(r) for r in c.execute("select substr(created_at,1,10) day,event_type,delivery_disposition,count(*) n,sum(delivered_at is not null) delivered from lead_events where lead_id=? and created_at>=? group by 1,2,3 order by 1,2,3",('flywheel-eng-lead',start))]
  stages=collections.Counter(); examples=[]
  for r in c.execute("select seq,event_id,created_at,payload,delivery_disposition from lead_events where lead_id=? and event_type='stage_changed' and created_at>=?",('flywheel-eng-lead',start)):
   p=json.loads(r['payload']); keys=['last_error','error','failure_kind','failureKind','blocked','needs_action','requires_action','action_required','checkpoint','decision_route','review','ship','messages','founder_message']
   guards=[k for k in keys if p.get(k) not in (None,False,'')]
   if p.get('status') not in (None,'running'): guards.append('status='+str(p.get('status')))
   stages[(str(p.get('stage')),r['delivery_disposition'],','.join(guards))]+=1
   if len(examples)<8 and r['delivery_disposition']=='model': examples.append({'seq':r['seq'],'eventId':r['event_id'],'at':r['created_at'],'stage':p.get('stage'),'status':p.get('status'),'decision_route':p.get('decision_route'),'guardFields':guards})
  out['stageGuards']=[{'stage':k[0],'disposition':k[1],'guards':k[2],'n':v} for k,v in stages.items()];out['examples']=examples
 else:
  out['commSchemas']={t:[r['name'] for r in c.execute('pragma table_info('+t+')')] for t in ['mailbox','mailbox_message_projection','runner_stop_declarations']}
  out['questionKinds']=[dict(r) for r in c.execute("select substr(created_at,1,10) day,checkpoint,kind,count(*) n from mailbox_message_projection where to_agent=? and type='question' and created_at>=? group by 1,2,3",('flywheel-eng-lead',start))]
  out['reportKinds']=[dict(r) for r in c.execute("select substr(created_at,1,10) day,case when content like 'RUNNER-STOPPED kind=runner_stopped %' then 'runner_stop_text' when content like 'DONE:%' then 'done_text_only' else 'other_report' end shape,count(*) n from mailbox_message_projection where to_agent=? and kind='report' and created_at>=? group by 1,2",('flywheel-eng-lead',start))]
 c.close()
print(json.dumps(out,ensure_ascii=False,indent=2))
