#!/usr/bin/env bash
# FLY-2782 原型 3：量「节点空等多久」和「每个常驻节点占多少内存」
# 全部只读。teamlead.db 是 3.3GB 生产库，绝不复制、绝不写。
set -euo pipefail
DB="file:$HOME/.flywheel/teamlead.db?mode=ro"

echo "=== 1. 哪些节点类型跑完后真的常驻（近 30 天）==="
sqlite3 -header -column "$DB" "
WITH comp AS (SELECT execution_id, MIN(ts) completed_at FROM session_events
              WHERE event_type='session_completed' AND ts>datetime('now','-30 days') GROUP BY execution_id)
SELECT s.workflow_node_id node, COUNT(*) n_completed,
 SUM(CASE WHEN julianday(s.terminal_at)>julianday(c.completed_at) THEN 1 ELSE 0 END) parked_then_closed,
 SUM(CASE WHEN julianday(s.terminal_at)<=julianday(c.completed_at) THEN 1 ELSE 0 END) closed_immediately
FROM comp c JOIN sessions s ON s.execution_id=c.execution_id
GROUP BY node ORDER BY n_completed DESC;"

echo; echo "=== 2. 空等时长分桶 ==="
sqlite3 -header -column "$DB" "
WITH comp AS (SELECT execution_id, MIN(ts) completed_at FROM session_events
              WHERE event_type='session_completed' AND ts>datetime('now','-30 days') GROUP BY execution_id),
d AS (SELECT (julianday(s.terminal_at)-julianday(c.completed_at))*24 h
      FROM comp c JOIN sessions s ON s.execution_id=c.execution_id
      WHERE s.terminal_at IS NOT NULL AND s.workflow_node_id IS NOT NULL
        AND julianday(s.terminal_at)>julianday(c.completed_at))
SELECT CASE WHEN h<0.25 THEN 'a <15min' WHEN h<1 THEN 'b 15-60min' WHEN h<3 THEN 'c 1-3h'
            WHEN h<12 THEN 'd 3-12h' ELSE 'e >12h' END bucket,
       COUNT(*) n, ROUND(SUM(h),1) total_h FROM d GROUP BY bucket ORDER BY bucket;"

echo; echo "=== 3. 并发常驻数（按小时采样）==="
sqlite3 -header -column "$DB" "
WITH comp AS (SELECT execution_id, MIN(ts) completed_at FROM session_events
              WHERE event_type='session_completed' AND ts>datetime('now','-30 days') GROUP BY execution_id),
iv AS (SELECT c.completed_at a, s.terminal_at b FROM comp c JOIN sessions s ON s.execution_id=c.execution_id
       WHERE s.terminal_at IS NOT NULL AND s.workflow_node_id IS NOT NULL
         AND julianday(s.terminal_at)>julianday(c.completed_at)),
hrs AS (SELECT datetime(julianday('now')-(n+0.0)/24) t
        FROM (WITH RECURSIVE k(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM k WHERE n<719) SELECT n FROM k))
SELECT ROUND(AVG(cnt),2) avg_parked, MAX(cnt) peak_parked
FROM (SELECT (SELECT COUNT(*) FROM iv WHERE julianday(iv.a)<=julianday(h.t) AND julianday(iv.b)>julianday(h.t)) cnt FROM hrs h);"

echo; echo "=== 4. 每个 runner 窗口的真实内存（整棵进程树）==="
for s in $(tmux ls -F '#{session_name}' 2>/dev/null | grep '^cmux-FLY' || true); do
  for p in $(tmux list-panes -t "$s" -F '#{pane_pid}' 2>/dev/null); do
    total=$(ps -Ao pid,ppid,rss | awk -v root="$p" '
      { pid[NR]=$1; ppid[NR]=$2; rss[NR]=$3; n=NR }
      END { keep[root]=1; changed=1
            while (changed) { changed=0
              for (i=1;i<=n;i++) if (!keep[pid[i]] && keep[ppid[i]]) { keep[pid[i]]=1; changed=1 } }
            s=0; for (i=1;i<=n;i++) if (keep[pid[i]]) s+=rss[i]; printf "%.0f", s/1024 }')
    echo "$s  treeRSS=${total}MB"
  done
done
echo "--- 另算：codex app-server 常驻守护进程（不在 tmux 进程树里，reparent 到 init）---"
ps -Ao pid,rss,args | grep "app-server" | grep -v grep | awk '{printf "pid=%s RSS=%.0fMB\n",$1,$2/1024}'

echo; echo "=== 5. 空闲多久之后 prompt cache 失效（真实 runner transcript 统计）==="
python3 - <<'PY'
import json,glob,os,datetime
def ts(s): return datetime.datetime.fromisoformat(s.replace('Z','+00:00'))
buckets={}
for d in glob.glob(os.path.expanduser('~/.claude/projects/-Users-xiaorongli-Dev-flywheel-FLY-27*')):
    for f in glob.glob(d+'/*.jsonl'):
        if os.path.getsize(f) < 500_000: continue
        prev=None
        for line in open(f,errors='ignore'):
            try: d2=json.loads(line)
            except: continue
            if d2.get('type')!='assistant': continue
            u=(d2.get('message') or {}).get('usage') or {}
            t=d2.get('timestamp')
            if not u or not t: continue
            cc=u.get('cache_creation_input_tokens',0); cr=u.get('cache_read_input_tokens',0)
            if prev and (cc+cr)>20000:
                gap=(ts(t)-ts(prev)).total_seconds()
                if gap>300:
                    b='<15min' if gap<900 else ('15-60min' if gap<3600 else ('1-3h' if gap<10800 else '>3h'))
                    buckets.setdefault(b,[]).append(cc/(cc+cr))
            prev=t
for b in ['<15min','15-60min','1-3h','>3h']:
    v=buckets.get(b,[])
    if v: print(f"  空闲 {b:>9}: n={len(v):4d}  平均需要重写的缓存比例 = {sum(v)/len(v):.1%}")
PY
