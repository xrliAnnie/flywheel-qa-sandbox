# 验的不是「我 push 了」,是「房里那一刻真的响了」。
# 证据来自坐在房里那个 bot 的录音(另一个进程、另一个 Discord 客户端)。
import json, wave, sys, os, numpy as np
LAB = os.environ["HOME"] + "/.fly1911"
run = sys.argv[1]
cue_at = None
for ln in open(f"{LAB}/{run}-bridge.out"):
    try: o = json.loads(ln)
    except Exception: continue
    if o.get("dir") == "CUE": cue_at = o["t"]; break
if not cue_at: print("❌ 这一场没有 CUE 事件"); sys.exit(1)
import datetime
cue_ms = datetime.datetime.fromisoformat(cue_at.replace("Z", "+00:00")).timestamp() * 1000
m = json.load(open(f"{LAB}/{run}-asker-manifest.json"))
w = wave.open(f"{LAB}/{run}-asker-room.wav")
sr = w.getframerate(); ch = w.getnchannels()
a = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)
if ch == 2: a = a.reshape(-1, 2).mean(axis=1)
dur = len(a) / sr; win = (m["marks"][-1][0] - m["recStartAt"]) / 1000
print(f"录音时长 {dur:.1f}s / 录音窗口 {win:.1f}s  ⇒ 时间轴{'连续,秒=墙上的秒' if abs(dur-win)<3 else '不连续,下面的定位不可信'}")
t_cue = (cue_ms - m["recStartAt"]) / 1000
FR = 0.02
rms = np.sqrt((a[:len(a)//int(sr*FR)*int(sr*FR)].reshape(-1, int(sr*FR)) ** 2).mean(axis=1))
def band(t0, t1):
    i0, i1 = max(0, int(t0/FR)), min(len(rms), int(t1/FR))
    return rms[i0:i1] if i1 > i0 else np.array([0.0])
print(f"提示音应该落在录音的 {t_cue:.2f}s")
before = band(t_cue - 3.0, t_cue - 0.3)      # 提示音之前的空窗 = 本底
at     = band(t_cue - 0.1, t_cue + 0.6)      # 提示音那一刻
after  = band(t_cue + 1.0, t_cue + 4.0)      # 提示音之后又回到空窗
print(f"  提示音之前 3 秒的本底   最大 {before.max():7.1f}")
print(f"  提示音那 0.7 秒         最大 {at.max():7.1f}   ← 要明显高过本底")
print(f"  提示音之后 1~4 秒       最大 {after.max():7.1f}   ← 应该回到本底(证明它是一声,不是一直在响)")
loud = at.max() > max(before.max() * 4, 50)
short = after.max() < at.max() * 0.5
print("⇒ " + ("✅ 房里那一刻真的响了" if loud else "❌ 那一刻没响") +
      " / " + ("✅ 而且是一声,响完就停" if short else "⚠️ 之后仍然有声音,不能证明它是一声"))
