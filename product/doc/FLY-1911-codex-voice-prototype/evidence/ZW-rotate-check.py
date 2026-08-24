# 验交替:两轮等待,房里录到的两段等待音必须【真的不一样】。
# ⚠️ 不能只看日志说放了哪一段 —— 那是声明。要从录音里量出两段的性格不同。
import json, wave, os, datetime, numpy as np
LAB = os.environ["HOME"] + "/.fly1911"
beds = []
for ln in open(f"{LAB}/rot1-bridge.out"):
    try: o = json.loads(ln)
    except Exception: continue
    if o.get("dir") == "BED":
        beds.append((datetime.datetime.fromisoformat(o["t"].replace("Z","+00:00")).timestamp()*1000,
                     o["obj"].get("state"), o["obj"].get("kind","")))
spans = []
for i, (ms, st, kind) in enumerate(beds):
    if st == "on":
        off = next((m for m, s, _ in beds[i+1:] if s == "off"), None)
        if off: spans.append((ms, off, kind))
print(f"日志里的等待音段:{len(spans)} 段 ⇒ " + " / ".join(k for _, _, k in spans))

for tag, run in (("第一轮", "rot1-a1"), ("第二轮", "rot1-a2")):
    fp = f"{LAB}/{run}-room.wav"
    if not os.path.exists(fp): print(f"{tag}: 没有录音"); continue
    m = json.load(open(f"{LAB}/{run}-manifest.json")); t0 = m["recStartAt"]
    w = wave.open(fp); sr, ch = w.getframerate(), w.getnchannels()
    a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(float)
    if ch == 2: a = a.reshape(-1, 2).mean(axis=1)
    hit = [(s, e, k) for s, e, k in spans if t0 < s < t0 + len(a)/sr*1000]
    if not hit: print(f"{tag}: 这段录音里没有等待音"); continue
    s, e, kind = hit[0]
    x = a[int((s-t0)/1000*sr)+sr : int((e-t0)/1000*sr)-sr//2]
    if len(x) < sr: print(f"{tag}: 等待音太短量不了"); continue
    N = min(len(x), 1 << 15); seg = x[:N] * np.hanning(N)
    S = np.abs(np.fft.rfft(seg)); fr = np.fft.rfftfreq(N, 1/sr)
    band = (fr > 60) & (fr < 5000)
    cen = (S[band]*fr[band]).sum()/S[band].sum()
    nn = int(sr*0.1); r = np.sqrt((x[:len(x)//nn*nn].reshape(-1, nn)**2).mean(axis=1))
    print(f"{tag}(日志说是 {kind}):时长 {(e-s)/1000:.1f}s  RMS {r.mean():.0f}  谱心 {cen:.0f}Hz  响度起伏 {r.std()/r.mean():.2f}")
