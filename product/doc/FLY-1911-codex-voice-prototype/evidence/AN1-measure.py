# FLY-1911:「她听不到」两格对照的尺子。
# 负对照 = 没人说话时录同一个房 ⇒ 必须逐样本 0;正对照 = 它回答时录 ⇒ 必须有波形。
# ⛔ 不用 discord 的「开始说话」事件判 —— 下行是常开流,服务端眼里它一直在说话。
import wave, array, json, sys

def load(p):
    w = wave.open(p, "rb")
    a = array.array("h"); a.frombytes(w.readframes(w.getnframes()))
    return w.getframerate(), w.getnchannels(), a

def perSecondPeak(rate, ch, a):
    step = rate * ch
    return [max(max(a[s:s+step]), -min(a[s:s+step])) for s in range(0, len(a) - step, step)]

def stat(p):
    rate, ch, a = load(p)
    return {"file": p, "sampleRate": rate, "channels": ch,
            "seconds": round(len(a) / ch / rate, 2),
            "peak": max(max(a), -min(a)),
            "nonZeroSamplePct": round(sum(1 for x in a if x) / len(a) * 100, 3),
            "perSecondPeak": perSecondPeak(rate, ch, a)}

def cut(src, dst, t0, t1):
    """截出说话那一段,并降成 24k 单声道 —— 只为了能塞进给她看的那张卡里放出来。
    ⚠️ 降采样只影响这份【副本】的音质,原始 48k 立体声录音一并留着。"""
    rate, ch, a = load(src)
    seg = a[int(t0*rate*ch):int(t1*rate*ch)]
    mono = array.array("h", [seg[i*ch] for i in range(len(seg)//ch)])
    out = array.array("h", [mono[i] for i in range(0, len(mono), 2)])  # 48k→24k
    w = wave.open(dst, "wb"); w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate//2)
    w.writeframes(out.tobytes()); w.close()
    return {"file": dst, "seconds": round(len(out)/(rate//2), 2)}

if __name__ == "__main__":
    r = {"negativeControl": stat(sys.argv[1]), "positive": stat(sys.argv[2])}
    r["clip"] = cut(sys.argv[2], sys.argv[3], float(sys.argv[4]), float(sys.argv[5]))
    print(json.dumps(r, ensure_ascii=False, indent=2))
