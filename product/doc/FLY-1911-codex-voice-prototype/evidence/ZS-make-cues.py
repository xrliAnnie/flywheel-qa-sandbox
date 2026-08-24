# 做几段候选提示音给她挑。每段 ≤1 秒,48k 单声道 16bit wav(Discord 里能直接点开听)。
# 设计依据(通知音的通用做法):短、柔、有敲击感的起音 + 指数衰减、带一点泛音。
# ⚠️ 现在在跑的那个是 200ms 880Hz 纯正弦 + 平包络 —— 纯正弦 + 不衰减 = 「电子仪器」,
#    多半就是她说「奇怪」的原因。所以把它原样做成第 0 号,当对照一起给她听。
import numpy as np, wave, os
SR = 48000
OUT = os.environ["HOME"] + "/.fly1911/cues"
os.makedirs(OUT, exist_ok=True)

def save(name, x):
    x = np.clip(x, -1, 1)
    n = int(0.004 * SR)                      # 收尾 4ms 淡出,杜绝爆音
    x[-n:] *= np.linspace(1, 0, n)
    w = wave.open(f"{OUT}/{name}.wav", "w"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((x * 32767).astype(np.int16).tobytes()); w.close()
    print(f"  {name}.wav   {len(x)/SR:.2f}s")

def t(ms): return np.arange(int(SR * ms / 1000)) / SR

def mallet(f, ms, decay=18, amp=0.32):
    """敲击感:基频 + 一点 4 次泛音(木琴的特征),指数衰减"""
    tt = t(ms); env = np.exp(-decay * tt)
    return (np.sin(2*np.pi*f*tt) + 0.28*np.sin(2*np.pi*4*f*tt)*np.exp(-decay*2.2*tt)) * env * amp

def seq(parts, gap_ms=0):
    out = []
    for p in parts:
        out.append(p)
        if gap_ms: out.append(np.zeros(int(SR*gap_ms/1000)))
    return np.concatenate(out)

print("做好了:")
# 0 对照:现在正在用的那个
tt = t(200); cur = np.sin(2*np.pi*880*tt) * 0.18
f = int(0.015*SR); cur[:f] *= np.linspace(0,1,f); cur[-f:] *= np.linspace(1,0,f)
save("0-现在这个-纯正弦", cur)
# 1 双音上行:轻快,「我开始了」
save("1-双音上行-轻快", seq([mallet(659.25, 130), mallet(987.77, 380)]))
# 2 双音下行:沉稳,「收到了」
save("2-双音下行-沉稳", seq([mallet(783.99, 130), mallet(523.25, 420)]))
# 3 单声软槌:存在感最低
save("3-单声软槌-最轻", mallet(880, 420, decay=16, amp=0.28))
# 4 五度和音:温暖,像乐器不像提示
save("4-五度和音-温暖", mallet(523.25, 520, decay=11, amp=0.20) + mallet(783.99, 520, decay=11, amp=0.14))
# 5 两声轻叩:最不打扰,像敲两下桌子
save("5-两声轻叩-最不打扰", seq([mallet(1046.5, 55, decay=55, amp=0.22), mallet(1046.5, 180, decay=55, amp=0.22)], gap_ms=45))
