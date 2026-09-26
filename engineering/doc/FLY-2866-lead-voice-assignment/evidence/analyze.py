"""FLY-2866: measure each synthesized clip — voiced duration, speech rate, median F0, independent ASR.

These are measured proxies for "听感"; they are not a human listening verdict.
Usage: python3 analyze.py <outdir>   (reads A-*.wav / B-*.wav, writes analysis.json + trimmed clips)
"""

import json
import pathlib
import re
import shlex
import subprocess
import sys
import wave

import numpy as np

SENTENCE = "Annie 你好，我是 Tadashi，现在有两件事要你看。"
# 12 Chinese syllables + An-nie (2) + Ta-da-shi (3)
SYLLABLES = 17


def key() -> str:
    for line in (pathlib.Path.home() / ".flywheel/.env").read_text().splitlines():
        if re.match(r"(?:export\s+)?OPENAI_API_KEY\s*=", line):
            return shlex.split(line.split("=", 1)[1], comments=True)[0]
    raise SystemExit("key missing")


def read(path):
    with wave.open(str(path)) as w:
        rate = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    return x, rate


def trim(x, rate):
    frame = int(rate * 0.02)
    n = len(x) // frame
    rms = np.sqrt((x[: n * frame].reshape(n, frame) ** 2).mean(axis=1))
    voiced = np.where(rms > 0.01)[0]
    if len(voiced) == 0:
        return x[:0], 0.0
    a = max(0, voiced[0] - 5) * frame
    b = min(len(x), (voiced[-1] + 10) * frame)
    return x[a:b], float(len(voiced) * 0.02)


def f0_median(x, rate):
    frame, hop = int(rate * 0.04), int(rate * 0.01)
    lo, hi = int(rate / 400), int(rate / 70)
    f0s = []
    for i in range(0, len(x) - frame, hop):
        s = x[i : i + frame]
        if np.sqrt((s**2).mean()) < 0.02:
            continue
        s = s - s.mean()
        ac = np.correlate(s, s, "full")[frame - 1 :]
        if ac[0] <= 0:
            continue
        lag = lo + int(np.argmax(ac[lo:hi]))
        if ac[lag] / ac[0] > 0.45:
            f0s.append(rate / lag)
    return (float(np.median(f0s)) if f0s else None), len(f0s)


def asr(path) -> str:
    r = subprocess.run(
        [
            "curl", "-sS", "https://api.openai.com/v1/audio/transcriptions",
            "-H", "Authorization: Bearer " + key(),
            "-F", "model=gpt-4o-transcribe", "-F", "language=zh",
            "-F", "file=@" + str(path),
        ],
        capture_output=True, text=True, timeout=120,
    )
    try:
        return json.loads(r.stdout).get("text", "") or json.dumps(json.loads(r.stdout))[:200]
    except Exception:
        return "ASR_ERROR"


def norm(s):
    return re.sub(r"[\s，。,.!?！？、:：\[\]]", "", s).lower()


CORE = "你好我是现在有两件事要你看"


def core(hyp):
    """Chinese body only: ASR renders the two names inconsistently (安妮 / 田中 / 达达西)."""
    h = norm(hyp)
    h = re.sub(r"^.*?(你好)", r"\1", h, count=1)  # drop anything before 你好 (name, stray words)
    h = re.sub(r"(我是).*?(现在)", r"\1\2", h, count=1)  # drop the self-name
    return h


def cer(ref, hyp):
    r, h = CORE, core(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = d[j]
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev = cur
    return round(d[len(h)] / max(1, len(r)), 3)


def main():
    out = pathlib.Path(sys.argv[1])
    rows = []
    for wav in sorted(out.glob("[AB]-*.wav")):
        if wav.stem.endswith("-trim"):
            continue
        x, rate = read(wav)
        t, voiced_s = trim(x, rate)
        tp = out / f"{wav.stem}-trim.wav"
        with wave.open(str(tp), "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
            w.writeframes((np.clip(t, -1, 1) * 32767).astype(np.int16).tobytes())
        f0, frames = f0_median(t, rate)
        text = asr(tp)
        engine, voice = wav.stem.split("-", 1)
        rows.append({
            "engine": engine, "voice": voice,
            "rawSeconds": round(len(x) / rate, 2), "clipSeconds": round(len(t) / rate, 2),
            "voicedSeconds": round(voiced_s, 2),
            "sylPerSec": round(SYLLABLES / max(0.1, voiced_s), 2),
            "f0MedianHz": round(f0, 1) if f0 else None, "f0Frames": frames,
            "asr": text, "cerCore": cer(SENTENCE, text),
            "extraBeforeGreeting": norm(text).split("你好")[0] if "你好" in norm(text) else None,
        })
        print(json.dumps(rows[-1], ensure_ascii=False), flush=True)
    (out / "analysis.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
