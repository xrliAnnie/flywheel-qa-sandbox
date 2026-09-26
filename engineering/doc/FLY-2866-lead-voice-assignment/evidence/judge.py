"""FLY-2866: blind AI listening pass over trimmed clips with gpt-audio-1.5.

The judge is not told which voice or engine produced a clip. This is a model's listening proxy,
not a human verdict. Usage: python3 judge.py <outdir> [<outdir> ...]  -> writes judge.json per dir.
"""

import base64
import json
import pathlib
import re
import shlex
import subprocess
import sys

PROMPT = (
    "你是一名配音导演。只根据这段音频本身回答（不要猜测是哪个产品或声线名）。"
    "只输出一个 JSON 对象，字段："
    '"gender": "男声"|"女声"|"难以判断"; '
    '"age": 例如 "青年"/"中年"/"中老年"; '
    '"pace": "偏慢"|"适中"|"偏快"; '
    '"mandarin_naturalness": 1-5 的整数（5=母语者自然，1=明显外国口音或机器感）; '
    '"accent": 一句话描述口音; '
    '"timbre": 不超过 12 个字的音色/性格描述; '
    '"content": 你听到的完整文字; '
    '"issues": 截断、吞字、改词、杂音等问题，没有就写 "无"。'
)


def key() -> str:
    for line in (pathlib.Path.home() / ".flywheel/.env").read_text().splitlines():
        if re.match(r"(?:export\s+)?OPENAI_API_KEY\s*=", line):
            return shlex.split(line.split("=", 1)[1], comments=True)[0]
    raise SystemExit("key missing")


def judge(path: pathlib.Path) -> dict:
    body = {
        "model": "gpt-audio-1.5",
        "modalities": ["text"],
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {
                        "type": "input_audio",
                        "input_audio": {"data": base64.b64encode(path.read_bytes()).decode(), "format": "wav"},
                    },
                ],
            }
        ],
    }
    r = subprocess.run(
        [
            "curl", "-sS", "https://api.openai.com/v1/chat/completions",
            "-H", "Authorization: Bearer " + key(), "-H", "Content-Type: application/json",
            "--data-binary", "@-",
        ],
        input=json.dumps(body), capture_output=True, text=True, timeout=180,
    )
    try:
        text = json.loads(r.stdout)["choices"][0]["message"]["content"]
        m = re.search(r"\{.*\}", text, re.S)
        return json.loads(m.group(0)) if m else {"raw": text}
    except Exception:
        return {"error": r.stdout[:300]}


def main():
    for d in sys.argv[1:]:
        out = pathlib.Path(d)
        rows = {}
        for clip in sorted(out.glob("[AB]-*-trim.wav")):
            if clip.stat().st_size < 2000:
                rows[clip.stem] = {"error": "empty clip"}
                continue
            rows[clip.stem] = judge(clip)
            print(clip.parent.name, clip.stem, json.dumps(rows[clip.stem], ensure_ascii=False), flush=True)
        (out / "judge.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
