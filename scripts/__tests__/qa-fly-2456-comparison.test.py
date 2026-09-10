import copy,json,pathlib,re,sys,tempfile,unittest
from unittest.mock import patch
DOC=pathlib.Path(__file__).resolve().parents[2]/'engineering/doc/FLY-2456-bridge-restart-drill/host-runbook.md'
def execute(marker,args):
 blocks=re.findall(r"<<'PY'\n([\s\S]*?)\nPY",DOC.read_text());code=next(b for b in blocks if marker in b);previous=sys.argv
 try:sys.argv=['embedded',*map(str,args)];exec(compile(code,'embedded-runbook','exec'),{})
 finally:sys.argv=previous
class ComparisonTests(unittest.TestCase):
 def write(self,p,v):p.write_text(json.dumps(v));return p
 def test_fixed_shape_filename(self):self.assertNotIn('finalcampaign-shape',DOC.read_text())
 def chronology(self,change=lambda m:None):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);identity={'sha256':'a'*64,'mode':384,'inode':123,'mtimeMs':1}
   stamp=lambda n:f'2026-09-01T00:0{n}:00Z'
   m={'steps':{'cycle-1':{'intent':{'createdAt':stamp(0)},'receipt':{'recordedAt':stamp(1)}},'room-info-hide':{'intent':{'createdAt':stamp(2)},'receipt':{'recordedAt':stamp(3),'result':{'action':'hide','identity':identity}}},'cycle-2':{'intent':{'createdAt':stamp(4)},'receipt':{'recordedAt':stamp(5)}},'room-info-restore':{'intent':{'createdAt':stamp(6)},'receipt':{'recordedAt':stamp(7),'result':{'action':'restore','identity':copy.deepcopy(identity)}}}}}
   change(m);self.write(root/'manifest.json',m);self.write(root/'pre.json',{'status':'pass'});shape={'status':'pass','bodies':{'B1':{'openGateIds':['g1']},'B2':{'openGateIds':['g2']}}};self.write(root/'campaign-shape.json',shape);self.write(root/'finalcampaign-shape.json',shape);self.write(root/'cycle1-observe.json',{'status':'pass'})
   execute('prepath=pathlib.Path',[root,root/'manifest.json',root/'pre.json']);return json.loads((root/'fixture.json').read_text())['roomInfoHidden']
 def test_valid_chronology(self):self.assertTrue(self.chronology())
 def test_invalid_chronologies(self):
  changes=[lambda m:m['steps']['room-info-hide']['intent'].update(createdAt='2026-09-01T00:00:30Z'),lambda m:m['steps']['room-info-hide']['receipt'].update(recordedAt='2026-09-01T00:05:00Z'),lambda m:m['steps']['cycle-2']['receipt'].update(recordedAt='2026-09-01T00:03:00Z'),lambda m:m['steps']['room-info-restore']['intent'].update(createdAt='2026-09-01T00:04:30Z'),lambda m:m['steps']['room-info-restore']['receipt']['result']['identity'].update(inode=999)]
  for change in changes:
   with self.subTest(change=change):self.assertFalse(self.chronology(change))
 def pre(self,change=lambda w:None,proc_status="pass",lead_status="pass"):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);wait={'status':'pass','startedAt':'2026-09-01T00:00:00Z','endedAt':'2026-09-01T00:10:00Z','waitedMs':600000,'maintenanceTicks':None,'tickEvidence':{'status':'unavailable','reason':'no_unconditional_tick_observable','rulingQuestionId':'c7791d8e-0d58-44d2-af0f-28b371382737'}};change(wait)
   self.write(root/'wait.json',wait);self.write(root/'manifest.json',{'steps':{'terminate-precondition':{'receipt':{'result':{'purpose':'precondition','status':'terminated','noop':False}}},'teardown-precondition':{'receipt':{'result':{'archivePath':'/tmp/test-archive'}}}}})
   for name in ['fleet.json','proc-full.json','proc-teardown.json','windows.json','kill-ledger.ndjson.summary.json']:self.write(root/name,{'status':'pass'})
   for name in ['proc-full','proc-teardown']:
    self.write(root/(name+'.json'),{'status':proc_status})
    self.write(root/(name+'.lead-attribution.json'),{'status':lead_status,'counts':{}})
   execute("termination=m['steps']",[root/'manifest.json',root/'wait.json',root,root/'pre.json']);return json.loads((root/'pre.json').read_text())['status']
 def test_lead_proc_attribution_resolves_only_pending_proof(self):
  self.assertEqual(self.pre(proc_status='needs-attribution'),'pass')
  self.assertEqual(self.pre(proc_status='needs-attribution',lead_status='fail'),'fail')
  self.assertEqual(self.pre(proc_status='fail'),'fail')
 def test_valid_timer(self):self.assertEqual(self.pre(),'pass')
 def test_invalid_timer_and_tick_proofs(self):
  changes=[lambda w:w.update(waitedMs=600001),lambda w:w.update(endedAt='2026-09-01T00:09:00Z'),lambda w:w.update(startedAt='2026-09-01T00:00:00'),lambda w:w.update(maintenanceTicks=2),lambda w:w['tickEvidence'].update(rulingQuestionId='wrong'),lambda w:w['tickEvidence'].update(reason='unknown'),lambda w:w.update(endedAt='2099-01-01T00:00:00Z')]
  for change in changes:
   with self.subTest(change=change):self.assertEqual(self.pre(change),'fail')
class LedgerTests(unittest.TestCase):
 def test_noop_reaper_is_counted_but_targeted_refusal_fails(self):
  for targeted in [False,True]:
   with self.subTest(targeted=targeted),tempfile.TemporaryDirectory() as d:
    root=pathlib.Path(d);folder=root/'kill-ledger';folder.mkdir();out=root/'combined.ndjson'
    row={'schemaVersion':1,'ts':'2026-09-10T00:00:00Z','source':'mcp_descendant_reaper','signal':'none','targetKind':'none','target':None,'reason':'periodic_orphan_pass','refusal':'isolation_boundary','refusalReason':'no_evidence'}
    if targeted:row.update(targetKind='pid',target=123,signal='TERM')
    (folder/'one.ndjson').write_text(json.dumps(row)+'\n')
    execute("folder=archive/'kill-ledger'",[root,out])
    result=json.loads(pathlib.Path(str(out)+'.summary.json').read_text())
    self.assertEqual(result['status'],'fail' if targeted else 'pass')
    self.assertEqual(result['noopRefusalCount'],0 if targeted else 1)
class CycleWaitTests(unittest.TestCase):
 def test_waits_and_resumes_original_deadline(self):
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);manifest=root/'manifest.json'
   manifest.write_text(json.dumps({'steps':{'cycle-1':{'receipt':{'recordedAt':'2026-09-01T00:00:00Z'}}}}))
   import datetime
   start=datetime.datetime(2026,9,1,tzinfo=datetime.timezone.utc).timestamp()
   clock=[start]
   def sleep(seconds):clock[0]+=seconds
   with patch('time.time',side_effect=lambda:clock[0]),patch('time.sleep',side_effect=sleep) as sleeper:
    execute("path=pathlib.Path(sys.argv[2])/'cycle1-wait.json'",[manifest,root])
    self.assertEqual(clock[0],start+60);self.assertEqual(sleeper.call_count,12)
    (root/'cycle1-wait-completed.json').unlink()
    execute("path=pathlib.Path(sys.argv[2])/'cycle1-wait.json'",[manifest,root])
    self.assertEqual(sleeper.call_count,12)
    manifest.write_text(json.dumps({'steps':{'cycle-1':{'receipt':{'recordedAt':'2026-09-01T00:00:01Z'}}}}))
    with self.assertRaisesRegex(AssertionError,'conflict'):
     execute("path=pathlib.Path(sys.argv[2])/'cycle1-wait.json'",[manifest,root])
class LeadAttributionTests(unittest.TestCase):
 def classify(self,command,parent='tmux new-session -Ad -s flywheel',removed=True):
  import subprocess
  repo=DOC.parents[3]
  script=repo/re.search(r'python3 "\$TOOL_REPO(/[^" ]*lead-proc-attribution.py)"',DOC.read_text())[1].lstrip('/')
  with tempfile.TemporaryDirectory() as d:
   root=pathlib.Path(d);stamp='Thu Sep 10 00:00:00 2026'
   row={'pid':42,'ppid':41,'lstart':stamp,'command':command,'attribution':'NONSLOT'}
   proc={'status':'needs-attribution','mode':'post-teardown','removed':[row] if removed else [],'added':[] if removed else [row],'unexplained':[row] if removed else []}
   (root/'proc.json').write_text(json.dumps(proc))
   lines=f'41 1 {stamp} {parent}\n42 41 {stamp} {command}\n'
   (root/'before').write_text(lines if removed else f'41 1 {stamp} {parent}\n')
   (root/'after').write_text(f'41 1 {stamp} {parent}\n' if removed else lines)
   r=subprocess.run([sys.executable,str(script),str(root/'proc.json'),str(root/'before'),str(root/'after'),'/tmp/flywheel-test-slot-4','/tmp/drill-checkout',str(root/'out.json')],capture_output=True,text=True)
   self.assertEqual(r.returncode,0,r.stderr)
   return json.loads((root/'out.json').read_text())
 def test_production_signature_cannot_be_hidden_by_transient_or_ancestor(self):
  for command in ['codex resume --remote unix:///Users/xiaorongli/.flywheel/cdx-sock/test.sock','claude --agent-id runner-fixture@flywheel-eng-lead','bash /Users/xiaorongli/.claude/shell-snapshots/x.sh /Users/xiaorongli/Dev/flywheel/']:
   with self.subTest(command=command):
    r=self.classify(command);self.assertEqual(r['status'],'fail');self.assertEqual(r['rows'][0]['kind'],'production_casualty')
 def test_generic_tool_ancestor_does_not_exempt_unknown_removed_process(self):
  r=self.classify('unidentified-worker',parent='git status')
  self.assertEqual(r['status'],'fail')
 def test_slot_ancestry_and_narrow_host_transient_remain_accepted(self):
  self.assertEqual(self.classify('worker',parent='node /tmp/drill-checkout/daemon.js')['status'],'pass')
  self.assertEqual(self.classify('sleep 5',parent='launchd')['status'],'pass')
 def test_post_teardown_added_unknown_remains_informational(self):
  r=self.classify('unidentified-worker',parent='launchd',removed=False)
  self.assertEqual(r['status'],'pass');self.assertEqual(r['rows'][0]['kind'],'added_unattributed')
if __name__=='__main__':unittest.main()
