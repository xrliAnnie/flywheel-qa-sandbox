# 音乐盒变体。⛔ 只在音乐盒这一族里变 —— 她已经排掉气流那一族了。
# 变的四条轴:音阶色彩 / 疏密 / 音区+音色 / 单音还是和音。
import numpy as np, wave, os
SR = 48000; DUR = 35.0
OUT = os.environ["HOME"] + "/.fly1911/box"; os.makedirs(OUT, exist_ok=True)
t = np.arange(int(SR * DUR)) / SR

def render(scale, step, decay, partials, chord=0, seed=1911, amp=0.5):
    """scale: 音高表 · step: 每个音的间隔秒 · decay: 衰减 · partials: 泛音配方 · chord: 同时叠第几度"""
    rng = np.random.default_rng(seed)
    x = np.zeros_like(t); idx = len(scale) // 2
    for k in range(int(DUR / step) + 1):
        idx = int(np.clip(idx + rng.integers(-1, 2), 0, len(scale) - 1))
        base = [scale[idx]]
        if chord: base.append(scale[int(np.clip(idx + chord, 0, len(scale) - 1))])
        s0 = int(k * step * SR); n = int(min(2.6, step * 3.2) * SR)
        if s0 + n > len(t): break
        tt = np.arange(n) / SR; env = np.exp(-decay * tt)
        for f in base:
            if rng.random() < 0.25: f *= 2
            v = np.zeros(n)
            for mult, a, d in partials: v += a * np.sin(2*np.pi*f*mult*tt) * np.exp(-decay*d*tt)
            x[s0:s0+n] += v * env * amp / len(base)
    return x

def save(name, x, peak=0.22):
    x = x / max(abs(x).max(), 1e-9) * peak
    n = int(SR*0.4); x[:n] *= np.linspace(0,1,n); x[-n:] *= np.linspace(1,0,n)
    w = wave.open(f"{OUT}/{name}.wav","w"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((x*32767).astype(np.int16).tobytes()); w.close(); print("  " + name)

PENTA  = [261.63, 293.66, 329.63, 392.00, 440.00]                 # 五声(她听过的那个)
YO     = [293.66, 311.13, 392.00, 440.00, 466.16]                 # 日式阴音阶,偏沉静
MALLET = [(1, 1.0, 1.0), (4, 0.28, 2.2)]                          # 木琴:四次泛音
BOXY   = [(1, 1.0, 1.0), (2, 0.45, 1.6), (3, 0.22, 2.4), (5, 0.12, 3.0)]  # 八音盒:泛音更多更亮

print("做好了:")
save("A-原版-你听过的那个", render(PENTA, 0.75, 2.6, MALLET))
save("B-更疏更慢-最安静",   render(PENTA, 1.50, 1.5, MALLET, seed=7))
save("C-高音八音盒-最清亮", render([f*2 for f in PENTA], 0.75, 3.0, BOXY, seed=21))
save("D-日式阴音阶-更沉静", render(YO,    0.95, 2.2, MALLET, seed=33))
save("E-双音和声-更厚",     render(PENTA, 1.00, 2.0, MALLET, chord=2, seed=45))
