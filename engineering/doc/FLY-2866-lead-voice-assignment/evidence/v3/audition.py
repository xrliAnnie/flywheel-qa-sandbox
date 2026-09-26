"""FLY-2866 v3 audition: record each v3 voice (retrying until the read is verbatim) and post-process.

Usage: python3 audition.py <outDir> [voice ...]
  Needs a runner dir with werift/opusscript node_modules: set FLY2866_V3_RUNDIR (default /tmp/fly2866-v3),
  which gets a copy of record-v3-voice.mjs and a node_modules symlink to /tmp/fly2884-proto/node_modules.
Per voice: up to MAX_ATTEMPTS recordings; each is trimmed, transcribed (gpt-4o-transcribe, API key only
for ASR — the voice itself runs on the subscription), pitched (YIN), and scored against the line.
The first verbatim take (Chinese-body CER <= 0.05) wins; otherwise the lowest-CER take, flagged.
Writes <outDir>/audition.json and <outDir>/mp3/<voice>.mp3 (mono 24 kHz, 24 kbps).
"""

import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import wave

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from pitch import f0  # noqa: E402  (YIN median, FLY-2866 evidence/pitch.py)
from analyze import asr, trim  # noqa: E402

V3 = ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"]
LINE = "你好，我是你的 Lead，今天由我来跟你同步进度。我这边有两件事已经做完，还有一件在等你拍板，我一件一件跟你说。"
MAX_ATTEMPTS = int(os.environ.get("FLY2866_MAX_ATTEMPTS", "3"))
RUNDIR = pathlib.Path(os.environ.get("FLY2866_V3_RUNDIR", "/tmp/fly2866-v3"))
# 42 Chinese syllables + "Lead" (1)
SYLLABLES = len(re.findall(r"[一-鿿]", LINE)) + 1


def han(s):
    return "".join(re.findall(r"[一-鿿]", s))


def cer(ref, hyp):
    r, h = han(ref), han(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = d[j]
            d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev = cur
    return round(d[len(h)] / max(1, len(r)), 3)


def prepare_rundir():
    RUNDIR.mkdir(parents=True, exist_ok=True)
    shutil.copy2(HERE / "record-v3-voice.mjs", RUNDIR / "record-v3-voice.mjs")
    (RUNDIR / "package.json").write_text('{ "name": "fly2866-v3", "private": true, "type": "module" }\n')
    nm = RUNDIR / "node_modules"
    if not nm.exists():
        nm.symlink_to("/tmp/fly2884-proto/node_modules")


def take(out, voice, attempt):
    r = subprocess.run(
        ["node", str(RUNDIR / "record-v3-voice.mjs"), str(out), voice, str(attempt)],
        cwd=RUNDIR, capture_output=True, text=True, timeout=150,
    )
    d = out / f"{voice}-{attempt}"
    res = json.loads((d / "result.json").read_text()) if (d / "result.json").exists() else {"why": "no_result", "stderr": r.stderr[-400:]}
    if res.get("why") != "done":
        return res
    with wave.open(str(d / "downlink.wav")) as w:
        rate = w.getframerate()
        x = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
    t, voiced = trim(x, rate)
    tp = d / "trim.wav"
    with wave.open(str(tp), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes((np.clip(t, -1, 1) * 32767).astype(np.int16).tobytes())
    text = asr(tp)
    hz, frames = f0(tp)
    res.update(
        clipSeconds=round(len(t) / rate, 2), voicedSeconds=round(voiced, 2),
        sylPerSec=round(SYLLABLES / max(0.1, voiced), 2), f0MedianHz=hz, f0Frames=frames,
        asr=text, cer=cer(LINE, text),
    )
    return res


def main():
    out = pathlib.Path(sys.argv[1]).resolve()
    voices = sys.argv[2:] or V3
    out.mkdir(parents=True, exist_ok=True)
    (out / "mp3").mkdir(exist_ok=True)
    prepare_rundir()
    path = out / "audition.json"
    summary = json.loads(path.read_text()) if path.exists() else {}
    for v in voices:
        takes = []
        for a in range(1, MAX_ATTEMPTS + 1):
            res = take(out, v, a)
            takes.append(res)
            print(json.dumps({k: res.get(k) for k in ("voice", "attempt", "why", "cer", "f0MedianHz", "sylPerSec", "asr", "error")}, ensure_ascii=False), flush=True)
            if res.get("why") == "done" and res.get("cer", 1) <= 0.05:
                break
        ok = [t for t in takes if t.get("why") == "done"]
        best = min(ok, key=lambda t: t["cer"]) if ok else None
        if best:
            subprocess.run(
                ["ffmpeg", "-loglevel", "error", "-y", "-i", str(out / f"{v}-{best['attempt']}" / "trim.wav"),
                 "-ac", "1", "-ar", "24000", "-c:a", "libmp3lame", "-b:a", "24k", str(out / "mp3" / f"{v}.mp3")],
                check=True,
            )
        summary[v] = {"best": best, "verbatim": bool(best and best["cer"] <= 0.05), "takes": takes}
        path.write_text(json.dumps(summary, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
