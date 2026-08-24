# 判「等待音会不会挡到它自己说话」—— 判据和阈值在打开这份录音之前就写死了(decisions.md)。
import json, wave, os, datetime, numpy as np
LAB = os.environ["HOME"] + "/.fly1911"; run = "bed1"
ev = {}
for ln in open(f"{LAB}/{run}-bridge.out"):
    try: o = json.loads(ln)
    except Exception: continue
    d = o.get("dir")
    if d in ("BED","ANSWER","STREAM-END") :
        ms = datetime.datetime.fromisoformat(o["t"].replace("Z","+00:00")).timestamp()*1000
        ev.setdefault(d + (":" + str(o.get("obj",{}).get("state")) if d=="BED" else ""), ms)
m = json.load(open(f"{LAB}/{run}-asker-manifest.json"))
w = wave.open(f"{LAB}/{run}-asker-room.wav"); sr, ch = w.getframerate(), w.getnchannels()
a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64)
if ch == 2: a = a.reshape(-1,2).mean(axis=1)
t0 = m["recStartAt"]
rel = lambda ms: (ms - t0)/1000
bed_on, bed_off = rel(ev["BED:on"]), rel(ev["BED:off"])
askdone = (m["askDoneAt"]-t0)/1000
print(f"录音 {len(a)/sr:.1f}s / 窗口 {(m['marks'][-1][0]-t0)/1000:.1f}s")
print(f"她问完 {askdone:.1f}s · 等待音 {bed_on:.1f}→{bed_off:.1f}s ({bed_off-bed_on:.1f}s)")

def seg(t1, t2):
    return a[max(0,int(t1*sr)):min(len(a),int(t2*sr))]
def narrow(x, f):
    """那一段里 f Hz 附近的能量(Goertzel 式:和该频率的正余弦做内积)"""
    if len(x) < sr//10: return 0.0
    n = np.arange(len(x))/sr
    return float(np.hypot((x*np.cos(2*np.pi*f*n)).mean(), (x*np.sin(2*np.pi*f*n)).mean()))
# 说话段:等待音关掉之后第一段有声音的地方
FR=0.02; nf=int(sr*FR)
rms = np.sqrt((a[:len(a)//nf*nf].reshape(-1,nf)**2).mean(axis=1))
thr = max(np.percentile(rms,95)*0.05, 40)
after = np.where((np.arange(len(rms))*FR > bed_off+0.2) & (rms > thr))[0]
if not len(after): print("❌ 等待音关掉之后房里没有声音"); raise SystemExit(1)
sp_start = after[0]*FR
j = after[0]
while j+1 < len(rms) and rms[j+1] > thr*0.5: j += 1
sp_end = j*FR
print(f"它说话 {sp_start:.1f}→{sp_end:.1f}s ({sp_end-sp_start:.1f}s)")

bedseg, spseg = seg(bed_on+1, bed_off-0.5), seg(sp_start, sp_end)
print("\n=== ① 可听性:220/330/440 三条窄带的能量 ===")
ratios = []
for f in (220, 330, 440):
    b, s = narrow(bedseg, f), narrow(spseg, f)
    r = (s/b*100) if b > 0 else float("inf")
    ratios.append(r)
    print(f"  {f:>4d} Hz   等待音段 {b:8.1f}   说话段 {s:8.1f}   说话段是等待音段的 {r:5.1f}%")
ok1 = all(r <= 10 for r in ratios)
print(f"  判据:三条都 ≤ 10%  ⇒ {'✅ 达标' if ok1 else '❌ 不达标'}")
pk = float(abs(spseg).max()); print(f"  说话段峰值 {pk:.0f}  (无等待音那八场峰值最小 ~1800,判据 ≥900)")
ok1b = pk >= 900
print(f"  ⇒ {'✅' if ok1b else '❌'} 说话本身没有被削弱")
print("\n=== ② 技术层 ===")
gap = sp_start - askdone
print(f"  她问完 → 它开口:{gap:.1f}s   判据 19.3–26.4s ⇒ {'✅' if 19.3 <= gap <= 26.4 else '❌'}")
