#!/usr/bin/env python3
"""FLY-342 evidence: CosyVoice2-0.5B on-Mac (Apple Silicon) inference benchmark.

Runs zero-shot TTS over the中英混说 eval set and measures, per sentence:
  - first-audio-chunk latency (streaming) = perceived首包
  - full-synthesis wall time
  - RTF = synth / audio-duration   (< 1.0 = faster than realtime playback)

Device selectable via COSYVOICE_DEVICE env (cpu | mps). The stock CosyVoice code
hardcodes cuda-or-cpu (cli/model.py:36); we patched it to respect COSYVOICE_DEVICE
so we can fairly test Apple Silicon MPS. For MPS also set PYTORCH_ENABLE_MPS_FALLBACK=1
(CosyVoice uses ops MPS doesn't implement; they fall back to CPU).

Usage: COSYVOICE_DEVICE=cpu  arch -arm64 .venv-arm64/bin/python cosy_bench.py cpu
       COSYVOICE_DEVICE=mps PYTORCH_ENABLE_MPS_FALLBACK=1 ... cosy_bench.py mps
"""
import json, os, sys, time
from pathlib import Path

LAB = Path.home() / "fly342-voice-lab"
# add CosyVoice repo root + Matcha submodule to path (script lives in evidence/, not repo)
_COSY = LAB / "CosyVoice"
sys.path.insert(0, str(_COSY / "third_party" / "Matcha-TTS"))
sys.path.insert(0, str(_COSY))
import os as _os
_ms = LAB / "models" / "cosyvoice" / "CosyVoice2-0.5B"
_hf = LAB / "models" / "cosyvoice-hf" / "CosyVoice2-0.5B"
MODEL = str(_hf if (_hf / "llm.pt").exists() else _ms)  # prefer HF mirror (modelscope throttled)
DEV = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("COSYVOICE_DEVICE", "cpu")
LIMIT = int(sys.argv[2]) if len(sys.argv) > 2 else 20   # allow a quick subset
SENTENCES = (LAB / "eval-sentences.txt").read_text().strip().splitlines()[:LIMIT]
OUT = LAB / "cosy-samples" / DEV
OUT.mkdir(parents=True, exist_ok=True)

import torch, torchaudio
from cosyvoice.cli.cosyvoice import CosyVoice2
from cosyvoice.utils.file_utils import load_wav

print(f"[cosy_bench] device={DEV} torch={torch.__version__} mps={torch.backends.mps.is_available()}", flush=True)
t_load0 = time.perf_counter()
cosy = CosyVoice2(MODEL, load_jit=False, load_trt=False, fp16=False)
print(f"[cosy_bench] model loaded in {time.perf_counter()-t_load0:.1f}s device={cosy.model.device}", flush=True)

# zero-shot prompt (shipped asset): reference voice PATH (frontend loads it) + transcript
prompt_wav = str(_COSY / "asset" / "zero_shot_prompt.wav")
prompt_text = "希望你以后能够做的比我还好呦。"

rows = []
for i, text in enumerate(SENTENCES, 1):
    t0 = time.perf_counter(); first = None; chunks = []
    for j in cosy.inference_zero_shot(text, prompt_text, prompt_wav, stream=True):
        if first is None:
            first = time.perf_counter() - t0
        chunks.append(j["tts_speech"])
    total = time.perf_counter() - t0
    speech = torch.cat(chunks, dim=1)
    dur = speech.shape[1] / cosy.sample_rate
    out = OUT / f"cosy_{i:02d}.wav"
    torchaudio.save(str(out), speech, cosy.sample_rate)
    r = {"idx": i, "text": text, "chars": len(text),
         "first_chunk_s": round(first, 3), "synth_s": round(total, 3),
         "audio_s": round(dur, 3), "rtf": round(total / dur, 3) if dur else None,
         "file": out.name}
    rows.append(r)
    print(f"[{i:02d}] first={r['first_chunk_s']:.2f}s synth={r['synth_s']:.2f}s "
          f"audio={r['audio_s']:.2f}s rtf={r['rtf']} :: {text[:26]}", flush=True)

log = LAB / "logs" / f"cosy_bench_{DEV}.json"
log.parent.mkdir(exist_ok=True)
log.write_text(json.dumps(rows, ensure_ascii=False, indent=2))
rtf = [r["rtf"] for r in rows if r["rtf"]]
fc = [r["first_chunk_s"] for r in rows]
print("\n=== AGGREGATE ===", flush=True)
print(f"device={DEV}  sentences={len(rows)}", flush=True)
print(f"first-chunk: min={min(fc):.2f} median={sorted(fc)[len(fc)//2]:.2f} max={max(fc):.2f} s", flush=True)
print(f"RTF: min={min(rtf):.3f} median={sorted(rtf)[len(rtf)//2]:.3f} max={max(rtf):.3f}", flush=True)
print(f"log: {log}", flush=True)
