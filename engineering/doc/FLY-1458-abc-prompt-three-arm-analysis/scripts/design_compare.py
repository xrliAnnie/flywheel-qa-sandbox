import sqlite3, datetime as dt
RO="file:/Users/xiaorongli/.flywheel/teamlead.db?mode=ro"
con=sqlite3.connect(RO,uri=True); cur=con.cursor()
def parse(t):
    t=t.strip()
    for f in ("%Y-%m-%d %H:%M:%S.%f","%Y-%m-%d %H:%M:%S"):
        try:return dt.datetime.strptime(t,f)
        except:pass
def mmss(s):
    s=int(round(s));m=s//60;return f"{m}m{s%60:02d}s" if m<60 else f"{s//3600}h{(s%3600)//60:02d}m"
def stages(ex):
    cur.execute("SELECT ts,json_extract(payload,'$.stage') FROM session_events WHERE execution_id=? AND event_type='stage_changed' ORDER BY ts",(ex,))
    return [(parse(t),s) for t,s in cur.fetchall()]

ISSUES=['FLY-1392','FLY-1385','FLY-1393','FLY-1150','FLY-1448','FLY-1456','FLY-1374']
cur.execute(f"""SELECT issue_identifier,execution_id,skill_framework_mode,skill_framework_mode_via,status,started_at
  FROM sessions WHERE session_role='design' AND issue_identifier IN ({','.join('?'*len(ISSUES))}) ORDER BY skill_framework_mode,issue_identifier,started_at""",ISSUES)
rows=cur.fetchall()
print(f"{'ARM(sfm)':<13}{'issue':<10}{'via':<9}{'status':<11}{'design first-pass':>18}   exec")
print("-"*78)
from collections import defaultdict
byarm=defaultdict(list)
for iss,ex,sfm,via,status,started in rows:
    st=stages(ex)
    # first-pass onboard(or first stage) -> first design_review
    t0=st[0][0] if st else parse(started)
    dr=next((t for t,s in st if s=='design_review'),None)
    fp=(dr-t0).total_seconds() if dr else None
    print(f"{sfm:<13}{iss:<10}{via:<9}{status:<11}{(mmss(fp) if fp else 'n/a (no dr)'):>18}   {ex[:8]}")
    if fp: byarm[sfm].append((iss,fp))
print("="*78)
print("DESIGN first-pass by arm (each design-role pass = one sample):")
order=['superpowers','matt','bare']
for sfm in order:
    vals=[v for _,v in byarm[sfm]]
    if not vals: continue
    mn,mx=min(vals),max(vals); mean=sum(vals)/len(vals)
    lst=", ".join(f"{iss.split('-')[1]}:{mmss(v)}" for iss,v in byarm[sfm])
    print(f"  {sfm:<12} N={len(vals)}  range {mmss(mn)}–{mmss(mx)}  mean {mmss(mean)}   [{lst}]")
