# 量那个常数本身:从「桥把音频交出去」到「房里真的响」有多久?
# ⇒ 用提示音那几场:CUE 是一个 200ms 的纯音,落盘日志里有它被推出去的精确时刻。
# ⛔ 不新跑任何一场 —— 这几份录音早就在盘上了。
import json, wave, os, datetime, numpy as np, glob
LAB = os.environ["HOME"] + "/.fly1911"
rows = []
for bo in sorted(glob.glob(f"{LAB}/*-bridge.out")):
    base = bo[:-11]
    cue = None
    for ln in open(bo):
        try: o = json.loads(ln)
        except Exception: continue
        if o.get("dir") == "CUE":
            cue = datetime.datetime.fromisoformat(o["t"].replace("Z","+00:00")).timestamp()*1000; break
    if cue is None: continue
    for mp, wp in ((base+"-asker-manifest.json", base+"-asker-room.wav"),
                   (base.replace("-bridge","")+"-asker-manifest.json", base.replace("-bridge","")+"-asker-room.wav")):
        if os.path.exists(mp) and os.path.exists(wp): break
    else: continue
    m = json.load(open(mp)); t0 = m["recStartAt"]
    w = wave.open(wp); sr, ch = w.getframerate(), w.getnchannels()
    a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(float)
    if ch == 2: a = a.reshape(-1, 2).mean(axis=1)
    t_pred = (cue - t0)/1000
    # 在预测位置前后 2 秒里,用 5ms 分辨率找 880Hz 那一声的起点
    lo, hi = max(0, t_pred-2), min(len(a)/sr, t_pred+2)
    seg = a[int(lo*sr):int(hi*sr)]
    n = int(sr*0.005)
    e = np.sqrt((seg[:len(seg)//n*n].reshape(-1, n) ** 2).mean(axis=1))
    base_lv = np.percentile(e, 20); thr = max(base_lv*6, e.max()*0.15, 30)
    idx = np.where(e > thr)[0]
    if not len(idx): continue
    onset = lo + idx[0]*0.005
    rows.append((os.path.basename(base), t_pred, onset, (onset-t_pred)*1000))
print("  场次              日志里推出去的时刻   房里真的响的时刻   延迟(毫秒)")
for name, p, o, d in rows: print(f"  {name:18s} {p:8.3f}s        {o:8.3f}s      {d:7.0f}")
if rows:
    ds = np.array([r[3] for r in rows])
    print(f"\n  ⇒ n={len(ds)}  中位 {np.median(ds):.0f}ms  范围 {ds.min():.0f}-{ds.max():.0f}ms")
    print("  ⚠️ 5ms 分辨率;这是【桥交出去 → 房里响】的端到端延迟(播放缓冲+opus+抖动+传输)")
