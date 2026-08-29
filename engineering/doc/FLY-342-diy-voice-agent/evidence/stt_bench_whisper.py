#!/usr/bin/env python3
"""FLY-342 evidence: whisper.cpp large-v3-turbo STT benchmark on the中英混说 eval set.

For each eval sentence (spoken by edge-tts, converted to 16kHz mono wav):
  - run whisper-cli, capture transcript + wall time
  - RTF = whisper_wall / audio_duration
  - slot scoring per plan §3b acceptance lines:
      * high-risk action reversal (negation flip / positive action) — 0 tolerance
      * issue/PR number + hash accuracy
      * command-token accuracy

HONESTY: input audio is edge-tts *clean synthesized* speech, not real mic. So slot
accuracy here is an UPPER BOUND on real-world STT; real-mic zh-en eval is a FLY-543
action item. If whisper fails even on clean audio, that is a strong negative signal.
"""
import json
import re
import subprocess
import time
from pathlib import Path

LAB = Path.home() / "fly342-voice-lab"
WHISPER = LAB / "whisper.cpp" / "build" / "bin" / "whisper-cli"
MODEL = LAB / "whisper.cpp" / "models" / "ggml-large-v3-turbo.bin"
WAVDIR = LAB / "wav"
SENTENCES = (LAB / "eval-sentences.txt").read_text().strip().splitlines()

# per-sentence slot spec: (must-contain-any tokens, high_risk_negation_word_or_None,
#                          forbidden-token-if-negation-flips)
SLOTS = {
    1:  {"tokens": ["FLY-342", "342"], "neg": None},
    2:  {"tokens": ["approve", "PR", "ship"], "neg": None, "must_positive": ["approve", "ship"]},
    3:  {"tokens": ["ship", "QA"], "neg": "别", "flip_forbidden_pattern": r"(先|可以)\s*ship"},
    4:  {"tokens": ["pnpm", "lint", "CI"], "neg": None},
    5:  {"tokens": ["PR", "conflict", "rebase", "main"], "neg": None},
    6:  {"tokens": ["FLY-435", "435", "FLY-354", "354", "epic"], "neg": None},
    7:  {"tokens": ["merge", "review"], "neg": "不要", "flip_forbidden_pattern": r"^\s*要\s*merge"},
    8:  {"tokens": ["Bridge", "Lead"], "neg": None},
    9:  {"tokens": ["CosyVoice", "MPS", "TTS"], "neg": None},
    10: {"tokens": ["Codex", "code review", "xhigh"], "neg": None},
    11: {"tokens": ["commit", "hash", "cd753eb9", "cd753", "753eb9"], "neg": None},
    12: {"tokens": ["model", "Fable", "Opus"], "neg": None},
    13: {"tokens": ["Runner", "awaiting", "review", "verify"], "neg": None},
    14: {"tokens": ["E2E", "test", "部署", "生产"], "neg": None},
    15: {"tokens": ["feature", "hold", "上线"], "neg": "别", "flip_forbidden_pattern": r"^(?!.*别).*上线"},
    16: {"tokens": ["Groq", "API", "key"], "neg": None},
    17: {"tokens": ["whisper", "三十", "30", "十分钟", "10"], "neg": None},
    18: {"tokens": ["research.md", "research", "结果", "填"], "neg": None},
    19: {"tokens": ["Discord", "bot", "token", "commit"], "neg": "别", "flip_forbidden_pattern": r"要\s*commit"},
    20: {"tokens": ["standup", "八点", "8", "报告"], "neg": None},
}


def audio_duration(path: Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def transcribe(wav: Path) -> tuple[str, float]:
    t0 = time.perf_counter()
    out = subprocess.run(
        [str(WHISPER), "-m", str(MODEL), "-f", str(wav),
         "-l", "zh", "-nt", "-np"],
        capture_output=True, text=True)
    dt = time.perf_counter() - t0
    return out.stdout.strip().replace("\n", " ").strip(), dt


def score(idx: int, ref: str, hyp: str) -> dict:
    spec = SLOTS[idx]
    hyp_l = hyp.lower()
    # token coverage (case-insensitive, tolerant of missing hyphens/spaces)
    def present(tok: str) -> bool:
        t = tok.lower()
        if t in hyp_l:
            return True
        # tolerate FLY-342 vs FLY342 vs 342
        return t.replace("-", "").replace(" ", "") in hyp_l.replace("-", "").replace(" ", "")
    covered = [t for t in spec["tokens"] if present(t)]
    # loose partial coverage: ≥ floor(N/2) key tokens present (so ≥1 for 2-3-token
    # slots, ≥2 for 4-5). This is a floor threshold, NOT "≥half" and NOT strict
    # token accuracy — a tolerant "did the STT surface roughly some right words"
    # signal. Real accuracy is the degradation noted qualitatively (pnpm→PMPM etc.).
    token_hit = len(covered) >= max(1, len(spec["tokens"]) // 2)
    # high-risk reversal check
    reversal_ok = True
    reversal_note = ""
    if spec.get("neg"):
        neg_present = spec["neg"] in hyp
        flip = False
        fp = spec.get("flip_forbidden_pattern")
        if fp and re.search(fp, hyp):
            flip = True
        reversal_ok = neg_present and not flip
        reversal_note = f"neg('{spec['neg']}')={neg_present} flip={flip}"
    if spec.get("must_positive"):
        mp_ok = all(present(t) for t in spec["must_positive"])
        reversal_ok = reversal_ok and mp_ok
        reversal_note += f" positive={spec['must_positive']}:{mp_ok}"
    return {
        "idx": idx, "ref": ref, "hyp": hyp,
        "tokens_covered": covered, "tokens_total": spec["tokens"],
        "token_hit": token_hit,
        "reversal_ok": reversal_ok, "reversal_note": reversal_note.strip(),
        "high_risk": bool(spec.get("neg") or spec.get("must_positive")),
    }


def main():
    rows, times = [], []
    for i, ref in enumerate(SENTENCES, 1):
        wav = WAVDIR / f"edgetts_{i:02d}.wav"
        hyp, dt = transcribe(wav)
        dur = audio_duration(wav)
        rtf = round(dt / dur, 3) if dur else None
        times.append(rtf)
        r = score(i, ref, hyp)
        r["rtf"] = rtf
        r["whisper_s"] = round(dt, 3)
        r["audio_s"] = round(dur, 3)
        rows.append(r)
        mark = "OK " if r["reversal_ok"] else "!!!"
        print(f"[{i:02d}] {mark} rtf={rtf} risk={r['high_risk']} rev={r['reversal_ok']} "
              f"tok={len(r['tokens_covered'])}/{len(r['tokens_total'])}")
        print(f"      ref: {ref}")
        print(f"      hyp: {hyp}")
        if r["reversal_note"]:
            print(f"      {r['reversal_note']}")
    (LAB / "logs").mkdir(exist_ok=True)
    (LAB / "logs" / "whisper_bench.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2))
    # aggregates
    hr = [r for r in rows if r["high_risk"]]
    hr_fail = [r for r in hr if not r["reversal_ok"]]
    tok_hit = sum(1 for r in rows if r["token_hit"])
    rtfs = [t for t in times if t]
    print("\n=== AGGREGATE ===")
    print(f"model: large-v3-turbo (Metal)  sentences: {len(rows)}")
    print(f"RTF: min={min(rtfs):.3f} median={sorted(rtfs)[len(rtfs)//2]:.3f} max={max(rtfs):.3f}")
    print(f"HIGH-RISK reversal (0-tolerance): {len(hr)-len(hr_fail)}/{len(hr)} passed "
          f"{'-> FAIL' if hr_fail else '-> PASS'}")
    if hr_fail:
        for r in hr_fail:
            print(f"   FAIL #{r['idx']}: {r['reversal_note']} | hyp={r['hyp']}")
    print(f"token loose partial-coverage (≥ floor(N/2) key tokens, NOT ½ / NOT accuracy): {tok_hit}/{len(rows)}")


main()
