# 等待音候选。她要的是「持续的、有连续性、又不特别 annoying」的声音,像客服 hold。
# ⚠️ 这些文件是【样品】—— 真跑的时候是实时连续生成的,不循环、没有接缝。
#    这里渲染 35 秒,是为了让她能判断「撑得住吗、会不会烦」。
import numpy as np, wave, os
SR = 48000; DUR = 35.0
OUT = os.environ["HOME"] + "/.fly1911/beds"; os.makedirs(OUT, exist_ok=True)
t = np.arange(int(SR * DUR)) / SR
rng = np.random.default_rng(1911)

def save(name, x, target_peak=0.22):
    x = x / max(abs(x).max(), 1e-9) * target_peak
    n = int(SR * 0.4); x[:n] *= np.linspace(0, 1, n); x[-n:] *= np.linspace(1, 0, n)  # 样品两头淡入淡出
    w = wave.open(f"{OUT}/{name}.wav", "w"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((x * 32767).astype(np.int16).tobytes()); w.close(); print(f"  {name}")

# 1 软垫:一层很轻的五度长音 + 很慢的呼吸(现在跑的就是这个)
breath = 0.72 + 0.28 * (0.5 + 0.5 * np.sin(2*np.pi*0.11*t))
save("1-软垫-最中性", (np.sin(2*np.pi*220*t)*0.55 + np.sin(2*np.pi*330*t)*0.32 + np.sin(2*np.pi*440*t)*0.13) * breath)

# 2 慢脉冲:软垫之上每 2 秒轻轻搏动一次 ⇒ 有「在动」的感觉,不只是「在响」
ph = (t % 2.0) / 2.0
pulse = np.exp(-6*ph) * (0.5 + 0.5*np.cos(2*np.pi*ph))
save("2-慢脉冲-在动", (np.sin(2*np.pi*220*t)*0.5 + np.sin(2*np.pi*330*t)*0.3) * (0.55 + 0.45*pulse))

# 3 音乐盒:五声音阶随机漫步的极轻琶音 —— 最像 hold music,但每个音都不一样,不循环
notes = np.array([261.63, 293.66, 329.63, 392.00, 440.00])
arp = np.zeros_like(t); idx = 0
for k in range(int(DUR / 0.75)):
    idx = int(np.clip(idx + rng.integers(-1, 2), 0, len(notes)-1))
    f = notes[idx] * (2 if rng.random() < 0.35 else 1)
    s0 = int(k * 0.75 * SR); n = int(1.6 * SR)
    if s0 + n > len(t): break
    tt = np.arange(n) / SR; env = np.exp(-2.6 * tt)
    arp[s0:s0+n] += (np.sin(2*np.pi*f*tt) + 0.25*np.sin(2*np.pi*2*f*tt)*np.exp(-6*tt)) * env * 0.5
save("3-音乐盒-最像holdmusic", arp)

# 4 气流:带通噪声(300-1200Hz),最不「音乐」—— 最容易被忽略,也最不容易烦
# ⚠️ 第一版用两次卷积做低通,量出来主频落在 13Hz —— 那是次声,喇叭根本放不出来。
#    改成在频域直接切带:留 300-1200Hz,两端各 200Hz 平滑过渡。
noise = rng.standard_normal(len(t))
F = np.fft.rfft(noise); fr = np.fft.rfftfreq(len(noise), 1/SR)
band = np.clip((fr-200)/200, 0, 1) * np.clip((1400-fr)/200, 0, 1)
air = np.fft.irfft(F * band, n=len(noise)) * (0.7 + 0.3*np.sin(2*np.pi*0.07*t))
save("4-气流-最不打扰", air)

# 5 双层:软垫 + 音乐盒 ⇒ 最接近真正的客服 hold
save("5-双层-软垫加音乐盒", (np.sin(2*np.pi*220*t)*0.5 + np.sin(2*np.pi*330*t)*0.28) * breath * 0.55 + arp * 1.0)
print("完成,35 秒 ×", len(os.listdir(OUT)) , "个 wav")
