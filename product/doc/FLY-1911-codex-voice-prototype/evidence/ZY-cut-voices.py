# 从每个音色那一场的房间录音里,把【它回答那一段】截出来存成 mp3。
# ⚠️ 录音里还有它的开场白 —— 要的是问话之后那一段,所以从 ASK-DONE 起算。
import json, wave, os, numpy as np, subprocess
LAB = os.environ["HOME"] + "/.fly1911"; OUT = LAB + "/voices"
os.makedirs(OUT, exist_ok=True)
VOICES = "alloy ash ballad cedar coral echo marin sage shimmer verse".split()
rows = []
for v in VOICES:
    wp, mp = f"{LAB}/vf-{v}-asker-room.wav", f"{LAB}/vf-{v}-asker-manifest.json"
    if not (os.path.exists(wp) and os.path.exists(mp)): rows.append((v, None, "没有录音")); continue
    m = json.load(open(mp)); t0 = m["recStartAt"]; askdone = (m["askDoneAt"] - t0) / 1000
    w = wave.open(wp); sr, ch = w.getframerate(), w.getnchannels()
    a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64)
    if ch == 2: a = a.reshape(-1, 2).mean(axis=1)
    FR = 0.02; nf = int(sr * FR)
    rms = np.sqrt((a[:len(a)//nf*nf].reshape(-1, nf) ** 2).mean(axis=1))
    # ⚠️ 门限不能取自「问话之前那段」—— 它自己的【开场白】就在里面,
    #    于是门限被开场白抬到比回答还高 ⇒ 五个音色被误判成「问完之后没录到声音」。
    #    改成取整段录音的低分位当本底(录音里绝大多数时间是静的)。
    floor = np.percentile(rms, 30)
    thr = max(floor * 4, np.percentile(rms, 95) * 0.08, 40)
    idx = np.where((np.arange(len(rms)) * FR > askdone + 0.3) & (rms > thr))[0]
    if not len(idx): rows.append((v, None, "问完之后没录到声音")); continue
    GAP = int(1.2 / FR); s = idx[0]; j = s
    for k in idx:
        if k - j <= GAP: j = k
        else: break
    s_t, e_t = max(0, s * FR - 0.15), min(len(a)/sr, j * FR + 0.45)
    x = a[int(s_t*sr):int(e_t*sr)]
    pk = max(abs(x).max(), 1)
    x = x / pk * 0.85 * 32767          # 十段统一归一 ⇒ 她比的是音色不是录音电平
    n = int(sr*0.02); x[:n] *= np.linspace(0,1,n); x[-n:] *= np.linspace(1,0,n)
    tmp = f"{OUT}/{v}.wav"
    ww = wave.open(tmp,"w"); ww.setnchannels(1); ww.setsampwidth(2); ww.setframerate(sr)
    ww.writeframes(x.astype(np.int16).tobytes()); ww.close()
    subprocess.run(["ffmpeg","-y","-loglevel","error","-i",tmp,"-c:a","libmp3lame","-b:a","96k",f"{OUT}/{v}.mp3"],check=True)
    rows.append((v, e_t - s_t, "ok"))
    print(f"  {v:9s} 截出 {e_t-s_t:4.1f}s")
print("\n=== 核每个 mp3 真的能解回有声音的音频 ===")
for v, d, st in rows:
    if st != "ok": print(f"  {v:9s} ❌ {st}"); continue
    p = subprocess.run(f"ffmpeg -v error -i {OUT}/{v}.mp3 -f s16le -ac 1 -ar 48000 - 2>/dev/null",
                       shell=True, capture_output=True).stdout
    b = np.frombuffer(p, dtype=np.int16).astype(float)
    print(f"  {v:9s} {len(b)/48000:4.1f}s  峰值 {int(abs(b).max()) if len(b) else 0:6d}  有声占比 {(abs(b)>300).mean()*100 if len(b) else 0:4.0f}%")
