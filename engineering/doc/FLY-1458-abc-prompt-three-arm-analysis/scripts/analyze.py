import sqlite3, datetime as dt, json
RO="file:/Users/xiaorongli/.flywheel/teamlead.db?mode=ro"
con=sqlite3.connect(RO, uri=True)
cur=con.cursor()

ARMS={'FLY-1392':'A·superpowers','FLY-1385':'B·matt','FLY-1393':'C·bare'}
ACTIVE={'onboard','brainstorm','research','plan','implement','test','pr_created'}
REVIEW={'design_review','code_review'}
APPROVE={'approve'}

def parse(t):
    t=t.strip()
    for f in ("%Y-%m-%d %H:%M:%S.%f","%Y-%m-%d %H:%M:%S"):
        try: return dt.datetime.strptime(t,f)
        except: pass
    raise ValueError(t)

# get sessions
cur.execute("""SELECT issue_identifier, session_role, execution_id, started_at, terminal_at, status
  FROM sessions WHERE issue_identifier IN ('FLY-1392','FLY-1385','FLY-1393') ORDER BY issue_identifier, started_at""")
sessions=cur.fetchall()

def stages(exec_id):
    cur.execute("""SELECT ts, json_extract(payload,'$.stage') FROM session_events
      WHERE execution_id=? AND event_type='stage_changed' ORDER BY ts""",(exec_id,))
    return [(parse(t),s) for t,s in cur.fetchall()]

arm_tot={a:{'active':0,'review':0,'approve':0} for a in ARMS}
role_rows=[]
for iss,role,exec_id,started,terminal,status in sessions:
    st=stages(exec_id)
    active=review=approve=0
    # inter-stage segments (bounded by two stage_changed) — exclude trailing-to-terminal park
    for i in range(len(st)-1):
        (t0,s0),(t1,_)=st[i],st[i+1]
        d=(t1-t0).total_seconds()
        if d<0: continue
        if s0 in ACTIVE: active+=d
        elif s0 in REVIEW: review+=d
        elif s0 in APPROVE: approve+=d
    # boot segment: started_at -> first stage (runner booting) counts as active
    if st:
        boot=(st[0][0]-parse(started)).total_seconds()
        if 0<boot<1800: active+=boot   # cap boot at 30min sanity
    wall=(parse(terminal)-parse(started)).total_seconds() if terminal else 0
    last_stage=st[-1][1] if st else None
    trailing=(parse(terminal)-st[-1][0]).total_seconds() if st and terminal else 0
    role_rows.append((iss,role,exec_id[:8],status,active,review,approve,wall,last_stage,trailing,len(st)))
    if role!='main' and status!='failed':
        # aggregate design/implement/qa; for arms with 2 implement sessions both count
        arm_tot[iss]['active']+=active; arm_tot[iss]['review']+=review; arm_tot[iss]['approve']+=approve

def hm(s):
    s=int(round(s)); h=s//3600; m=(s%3600)//60
    return f"{h}h{m:02d}m" if h else f"{m}m"

print("="*118)
print(f"{'ARM':<14}{'role':<10}{'exec':<9}{'status':<11}{'ACTIVE':>9}{'REVIEW':>9}{'APPROVE':>9}{'WALL':>9}  {'last_stage':<14}{'trail':>7}")
print("-"*118)
for r in role_rows:
    iss,role,ex,status,a,rv,ap,wall,ls,tr,n=r
    print(f"{ARMS[iss][:13]:<14}{role:<10}{ex:<9}{status:<11}{hm(a):>9}{hm(rv):>9}{hm(ap):>9}{hm(wall):>9}  {str(ls):<14}{hm(tr):>7}")
print("="*118)
print("PER-ARM active/review/approve totals (design+implement+qa active work, park excluded):")
for iss,lbl in ARMS.items():
    t=arm_tot[iss]
    print(f"  {lbl:<16} active={hm(t['active']):<8} review_wait={hm(t['review']):<8} approve_wait={hm(t['approve']):<8}")

# arm-level wall clock (first session start -> last session terminal)
print("-"*60)
print("ARM-LEVEL WALL CLOCK (first start -> last terminal):")
for iss,lbl in ARMS.items():
    cur.execute("""SELECT MIN(started_at), MAX(terminal_at) FROM sessions
      WHERE issue_identifier=? AND status!='failed'""",(iss,))
    a,b=cur.fetchone()
    span=(parse(b)-parse(a)).total_seconds()
    print(f"  {lbl:<16} {a}  ->  {b}   = {hm(span)}")
