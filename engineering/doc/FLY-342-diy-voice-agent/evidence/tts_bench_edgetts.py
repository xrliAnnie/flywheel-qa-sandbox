#!/usr/bin/env python3
"""FLY-342 evidence: edge-tts synthesis benchmark on the中英混说 eval set.

Measures, per sentence, on a cloud TTS (Microsoft Edge online synthesis, no credential):
  - first-audio-chunk latency (streaming) = perceived "首包延迟"
  - full-synthesis wall time
  - output audio duration (ffprobe)
  - RTF = full-synthesis / audio-duration  (< 1.0 means faster than realtime playback)

NOTE (honesty): edge-tts is a *cloud* service, so these numbers are network+server
latency, NOT local-compute RTF. They validate the pipeline's no-credential fallback
component (plan §5.2 A-档过渡期 / §3 matrix priority 5), not local CosyVoice.
"""
import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

import edge_tts

LAB = Path.home() / "fly342-voice-lab"
SENTENCES = (LAB / "eval-sentences.txt").read_text().strip().splitlines()
OUTDIR = LAB / "samples"
OUTDIR.mkdir(exist_ok=True)
VOICE = sys.argv[1] if len(sys.argv) > 1 else "zh-CN-XiaoxiaoNeural"


def audio_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True,
    )
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


async def synth(idx: int, text: str) -> dict:
    out = OUTDIR / f"edgetts_{idx:02d}.mp3"
    comm = edge_tts.Communicate(text, VOICE)
    t0 = time.perf_counter()
    first_chunk_at = None
    with open(out, "wb") as f:
        async for chunk in comm.stream():
            if chunk["type"] == "audio":
                if first_chunk_at is None:
                    first_chunk_at = time.perf_counter() - t0
                f.write(chunk["data"])
    total = time.perf_counter() - t0
    dur = audio_duration(out)
    return {
        "idx": idx, "text": text, "chars": len(text),
        "first_chunk_s": round(first_chunk_at or total, 3),
        "synth_s": round(total, 3),
        "audio_s": round(dur, 3),
        "rtf": round(total / dur, 3) if dur else None,
        "file": out.name,
    }


async def main():
    rows = []
    for i, s in enumerate(SENTENCES, 1):
        r = await synth(i, s)
        rows.append(r)
        print(f"[{i:02d}] first={r['first_chunk_s']:.2f}s synth={r['synth_s']:.2f}s "
              f"audio={r['audio_s']:.2f}s rtf={r['rtf']} :: {s[:28]}")
    log = LAB / "logs" / f"edgetts_bench_{VOICE}.json"
    log.parent.mkdir(exist_ok=True)
    log.write_text(json.dumps(rows, ensure_ascii=False, indent=2))
    # aggregates
    fc = [r["first_chunk_s"] for r in rows]
    rtf = [r["rtf"] for r in rows if r["rtf"]]
    print("\n=== AGGREGATE ===")
    print(f"voice: {VOICE}  sentences: {len(rows)}")
    print(f"first-chunk latency: min={min(fc):.2f}s median={sorted(fc)[len(fc)//2]:.2f}s max={max(fc):.2f}s")
    print(f"RTF: min={min(rtf):.3f} median={sorted(rtf)[len(rtf)//2]:.3f} max={max(rtf):.3f}")
    print(f"log: {log}")


asyncio.run(main())
