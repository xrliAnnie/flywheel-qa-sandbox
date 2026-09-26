"""FLY-2866: YIN fundamental-frequency estimate per trimmed clip (median over voiced frames).

Replaces the crude autocorrelation F0 in analyze.py, which octave-jumped between runs.
Usage: python3 pitch.py <outdir> [...]  -> prints and writes pitch.json per dir.
"""

import json
import pathlib
import sys
import wave

import numpy as np


def yin(frame, rate, fmin=70, fmax=400, threshold=0.15):
    tau_min, tau_max = int(rate / fmax), int(rate / fmin)
    n = len(frame) - tau_max
    d = np.array([np.sum((frame[:n] - frame[t : t + n]) ** 2) for t in range(tau_max + 1)])
    cmnd = np.ones_like(d)
    cmnd[1:] = d[1:] * np.arange(1, len(d)) / np.maximum(np.cumsum(d[1:]), 1e-12)
    for t in range(tau_min, tau_max):
        if cmnd[t] < threshold:
            while t + 1 < tau_max and cmnd[t + 1] < cmnd[t]:
                t += 1
            return rate / t
    return None


def f0(path):
    with wave.open(str(path)) as w:
        rate = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float64) / 32768
    if rate != 16000:  # decimate 24k -> 12k for speed; F0 range unaffected
        x, rate = x[::2], rate // 2
    size, hop = int(rate * 0.04), int(rate * 0.01)
    vals = []
    for i in range(0, len(x) - size, hop):
        fr = x[i : i + size]
        if np.sqrt((fr**2).mean()) < 0.02:
            continue
        v = yin(fr - fr.mean(), rate)
        if v:
            vals.append(v)
    if not vals:
        return None, 0
    return round(float(np.median(vals)), 1), len(vals)


def main():
    for d in sys.argv[1:]:
        out = pathlib.Path(d)
        res = {}
        for clip in sorted(out.glob("[AB]-*-trim.wav")):
            if clip.stat().st_size < 2000:
                continue
            hz, n = f0(clip)
            res[clip.stem.replace("-trim", "")] = {"f0MedianHz": hz, "frames": n}
            print(out.name, clip.stem, hz, n, flush=True)
        (out / "pitch.json").write_text(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
