import sqlite3, datetime as dt
RO="file:/Users/xiaorongli/.flywheel/teamlead.db?mode=ro"
con=sqlite3.connect(RO,uri=True); cur=con.cursor()
ARMS=[('FLY-1392','A·superpowers'),('FLY-1385','B·matt'),('FLY-1393','C·bare')]
def parse(t):
    t=t.strip()
    for f in ("%Y-%m-%d %H:%M:%S.%f","%Y-%m-%d %H:%M:%S"):
        try:return dt.datetime.strptime(t,f)
        except:pass
def hm(s):
    s=int(round(s));h=s//3600;m=(s%3600)//60
    if h: return f"{h}h{m:02d}m"
    return f"{m}m{s%60:02d}s" if s<600 else f"{m}m"
def stages(ex):
    cur.execute("SELECT ts,json_extract(payload,'$.stage') FROM session_events WHERE execution_id=? AND event_type='stage_changed' ORDER BY ts",(ex,))
    return [(parse(t),s) for t,s in cur.fetchall()]
def sess(iss,role):
    cur.execute("SELECT execution_id,started_at,terminal_at,status FROM sessions WHERE issue_identifier=? AND session_role=? ORDER BY started_at",(iss,role))
    return cur.fetchall()
def firstpass(st,end_stages):
    if not st: return None
    t0=st[0][0]
    for t,s in st:
        if s in end_stages: return (t-t0).total_seconds()
    return None
def count_stage(st,name):
    return sum(1 for _,s in st if s==name)
def qa_result_times(iss):
    cur.execute("""SELECT e.ts, json_extract(e.payload,'$.verdict') FROM session_events e JOIN sessions s ON s.execution_id=e.execution_id
      WHERE s.issue_identifier=? AND e.event_type='qa_result' ORDER BY e.ts""",(iss,))
    return [(parse(t),v) for t,v in cur.fetchall()]

for iss,lbl in ARMS:
    print("="*70); print(lbl, iss)
    # design
    ds=sess(iss,'design'); dst=stages(ds[0][0]) if ds else []
    d_fp=firstpass(dst,{'design_review'})
    # implement: may be multiple sessions; first-pass = first session onboard->first pr_created
    imps=sess(iss,'implement')
    imp_first=[s for s in imps if s[3]!='failed']
    ist=stages(imp_first[0][0]) if imp_first else []
    i_fp=firstpass(ist,{'pr_created'}) or firstpass(ist,{'code_review'})
    # code_review rounds across ALL implement sessions
    cr_rounds=sum(count_stage(stages(s[0]),'code_review') for s in imps)
    impl_reentry=sum(count_stage(stages(s[0]),'implement') for s in imps)
    # qa first pass: first test -> first qa_result
    qas=[s for s in sess(iss,'qa') if s[3]!='failed']
    qst=stages(qas[0][0]) if qas else []
    qres=qa_result_times(iss)
    q_test0=next((t for t,s in qst if s=='test'),None)
    q_fp=None
    if q_test0 and qres:
        first_res=next((t for t,v in qres if t>=q_test0),qres[0][0])
        q_fp=(first_res-q_test0).total_seconds()
    fails=sum(1 for _,v in qres if v=='fail'); passes=sum(1 for _,v in qres if v=='pass')
    print('    qa verdicts:', [ (t.strftime('%H:%M'),v) for t,v in qres])
    # approve wait: sum approve segments across all sessions in arm
    appr=0
    for role in ('design','implement','qa'):
        for s in sess(iss,role):
            stl=stages(s[0])
            for i in range(len(stl)-1):
                if stl[i][1]=='approve': appr+=(stl[i+1][0]-stl[i][0]).total_seconds()
    # wall clock arm
    cur.execute("SELECT MIN(started_at),MAX(terminal_at) FROM sessions WHERE issue_identifier=? AND status!='failed'",(iss,))
    a,b=cur.fetchone(); wall=(parse(b)-parse(a)).total_seconds()
    # code output
    cur.execute("SELECT session_role,files_changed,lines_added,lines_removed FROM sessions WHERE issue_identifier=? AND status!='failed'",(iss,))
    outs=cur.fetchall()
    print(f"  design first-pass active (onboard->design_review): {hm(d_fp) if d_fp else 'n/a'}")
    print(f"  implement first-pass build (onboard->pr_created):   {hm(i_fp) if i_fp else 'n/a'}")
    print(f"  QA first-pass (first test->first qa_result):        {hm(q_fp) if q_fp else 'n/a'}")
    print(f"  code_review rounds (total across impl):             {cr_rounds}")
    print(f"  implement stage re-entries (fix cycles):            {impl_reentry}")
    print(f"  qa_result: FAIL={fails}  PASS={passes}")
    print(f"  founder approve-wait (sum approve segments):        {hm(appr)}")
    print(f"  arm wall-clock:                                     {hm(wall)}  ({a} -> {b})")
    tot_la=sum((o[2] or 0) for o in outs); tot_fc=sum((o[1] or 0) for o in outs)
    for r,fc,la,lr in outs: print(f"      {r:<10} files={fc or 0} +{la or 0}/-{lr or 0}")
    print(f"    TOTAL output: {tot_fc} files, +{tot_la} lines")
