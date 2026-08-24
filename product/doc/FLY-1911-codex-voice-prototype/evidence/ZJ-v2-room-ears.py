# 量「房间里(她耳朵)那一侧到底响没响」—— 用录音的实际音量包络,不是字节总数。
# ⚠️ 前一版用「收到的字节数涨不涨」当判据是错的:那条流是连续的(静音也在传),
#    字节每一拍都在涨,所以它测的是「有没有流」,不是「有没有声音」。
# 录音时间轴是连续的(时长 ≈ 录音窗口,已核),所以 wav 的秒 = 墙上的秒。
import json, wave, sys, numpy as np

FRAME = 0.1        # 100ms 一帧
for r in sys.argv[1:]:
    m = json.load(open(f'{__import__("os").environ["HOME"]}/.fly1911/{r}-asker-manifest.json'))
    w = wave.open(f'{__import__("os").environ["HOME"]}/.fly1911/{r}-asker-room.wav')
    sr, ch = w.getframerate(), w.getnchannels()
    a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
    if ch == 2: a = a.reshape(-1, 2).mean(axis=1)
    n = int(sr * FRAME)
    rms = np.sqrt((a[:len(a)//n*n].reshape(-1, n) ** 2).mean(axis=1))
    # 门限:取最响的 5% 的 3%,足以把「真说话」和「静音底噪」分开
    thr = max(np.percentile(rms, 95) * 0.03, 30.0)
    voiced = rms > thr
    t_askdone = (m['askDoneAt'] - m['recStartAt']) / 1000
    # 分段
    segs, i = [], 0
    while i < len(voiced):
        if voiced[i]:
            j = i
            while j < len(voiced) and voiced[j]: j += 1
            if (j - i) * FRAME >= 0.3: segs.append((i * FRAME, j * FRAME))
            i = j
        else: i += 1
    after = [s for s in segs if s[0] > t_askdone + 0.3]
    print(f"── {r}  (门限 rms>{thr:.0f};她问完在录音的 {t_askdone:.1f}s)")
    if not after:
        print("   问完之后录音里再没有响过"); continue
    for s, e in after[:4]:
        print(f"   房里响起 {s - t_askdone:5.1f}s → {e - t_askdone:5.1f}s  (持续 {e - s:.1f}s)")
    # ⚠️ 不写「这中间 0 段」—— after[0] 按定义就是第一段,那句话恒真,是句空话。
    print(f"   ⇒ 问完到房里第一声:{after[0][0] - t_askdone:.1f}s")
