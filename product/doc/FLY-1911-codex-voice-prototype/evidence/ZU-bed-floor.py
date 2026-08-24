# 换过的尺子:量【地板】不量平均。等待音是持续纯音 ⇒ 只要在响,220Hz 就有下限;
# 人说话是断续的 ⇒ 词缝里会掉下去。判据和阈值在算之前写死(decisions.md)。
import json, wave, os, datetime, numpy as np
LAB = os.environ["HOME"] + "/.fly1911"

def load(run):
    ev = {}
    for ln in open(f"{LAB}/{run}-bridge.out"):
        try: o = json.loads(ln)
        except Exception: continue
        d = o.get("dir")
        if d in ("BED", "ANSWER", "STREAM-END"):
            ms = datetime.datetime.fromisoformat(o["t"].replace("Z", "+00:00")).timestamp() * 1000
            k = d + (":" + str(o.get("obj", {}).get("state")) if d == "BED" else "")
            ev.setdefault(k, ms)
    m = json.load(open(f"{LAB}/{run}-asker-manifest.json"))
    w = wave.open(f"{LAB}/{run}-asker-room.wav"); sr, ch = w.getframerate(), w.getnchannels()
    a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64)
    if ch == 2: a = a.reshape(-1, 2).mean(axis=1)
    return ev, m, a, sr

def speech_seg(a, sr, askdone, after_t):
    """阈值从【问话之前】那段取 —— 不从全段取(全段被等待音抬高过)"""
    FR = 0.02; nf = int(sr * FR)
    rms = np.sqrt((a[:len(a)//nf*nf].reshape(-1, nf) ** 2).mean(axis=1))
    pre = rms[:int((askdone - 1) / FR)]
    thr = max(np.percentile(pre, 97) * 1.5, 60)
    idx = np.where((np.arange(len(rms)) * FR > after_t) & (rms > thr))[0]
    if not len(idx): return None
    # ⚠️ 不能一遇到安静就收尾 —— 说话中间本来就有词缝(上一版就是在等待音关掉那一拍的
    #    低谷处把说话段切断了,切出 0.4 秒、峰值 751 的假结果)。
    #    改成:把相隔小于 1.5 秒的响声并成同一段。
    GAP = int(1.5 / FR)
    s = idx[0]; j = s
    for k in idx:
        if k - j <= GAP: j = k
        else: break
    return s * FR, j * FR, thr

def floor_at(x, sr, f, win=0.1):
    """把这一段切成 100ms 子窗,量每个子窗在 f Hz 的窄带幅度,取最小值 = 地板"""
    n = int(sr * win); vals = []
    for i in range(0, len(x) - n, n):
        c = x[i:i + n]; t = np.arange(n) / sr
        vals.append(float(np.hypot((c * np.cos(2*np.pi*f*t)).mean(), (c * np.sin(2*np.pi*f*t)).mean())))
    return (min(vals), float(np.median(vals))) if vals else (0.0, 0.0)

out = {}
for run, has_bed in (("bed1", True), ("bed2", True), ("tiv3", False)):
    ev, m, a, sr = load(run)
    t0 = m["recStartAt"]; askdone = (m["askDoneAt"] - t0) / 1000
    after = (ev["BED:off"] - t0) / 1000 + 0.2 if has_bed else (ev["ANSWER"] - t0) / 1000
    seg = speech_seg(a, sr, askdone, after)
    if not seg: print(f"{run}: 找不到说话段"); continue
    s, e, thr = seg
    x = a[int(s*sr):int(e*sr)]
    f220 = floor_at(x, sr, 220); f330 = floor_at(x, sr, 330)
    out[run] = dict(s=s, e=e, pk=float(abs(x).max()), f220=f220[0], f330=f330[0])
    print(f"── {run}{'(有等待音)' if has_bed else '(没有等待音,对照组)'}")
    print(f"   说话段 {s:.1f}→{e:.1f}s ({e-s:.1f}s)  峰值 {abs(x).max():.0f}  检出阈值 {thr:.0f}")
    print(f"   220Hz 地板 {f220[0]:7.2f}(中位 {f220[1]:.1f})   330Hz 地板 {f330[0]:7.2f}(中位 {f330[1]:.1f})")
    if has_bed:
        bs, be = (ev["BED:on"]-t0)/1000, (ev["BED:off"]-t0)/1000
        bx = a[int((bs+1)*sr):int((be-0.5)*sr)]
        b220 = floor_at(bx, sr, 220); b330 = floor_at(bx, sr, 330)
        print(f"   参照:等待音响着那 {be-bs:.0f} 秒里 220Hz 地板 {b220[0]:.2f} · 330Hz 地板 {b330[0]:.2f}")
        out["bedseg"] = (b220[0], b330[0])

for R in ("bed1","bed2"):
  if R in out and "tiv3" in out:
    b, c = out[R], out["tiv3"]
    print(f"\n════ {R} 对判据(算之前写死的)════")
    for f, k in ((220, "f220"), (330, "f330")):
        ok = b[k] <= c[k] * 2
        print(f"  {f}Hz 地板:有等待音 {b[k]:.2f} vs 对照 {c[k]:.2f}  ⇒ 判据 ≤2倍 ⇒ {'✅' if ok else '❌'}")
    okpk = b["pk"] >= c["pk"] * 0.5
    print(f"  说话峰值:有等待音 {b['pk']:.0f} vs 对照 {c['pk']:.0f}  ⇒ 判据 ≥一半 ⇒ {'✅' if okpk else '❌'}")
