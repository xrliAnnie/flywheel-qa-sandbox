"""FLY-2866 voice probe: synthesize one Chinese sentence per voice on engine A and engine B.

Engine A = public GPT Live (`gpt-live-1`, wss://api.openai.com/v1/live/sessions), same protocol
FLY-2799 verified (session.start + session.commentary.append).
Engine B = Codex 0.156.1 app-server realtime V2 + `gpt-realtime-2.1` (thread/realtime/start with
`voice`, then thread/realtime/appendSpeech).

The key is read from ~/.flywheel/.env (OPENAI_API_KEY) and passed only through the environment of
this process / the codex child. It is never written to logs or arguments.

Usage: PYTHONPATH=<deps with websockets> python3 voice-probe.py <outdir> <engine:A|B> <voice> [...]
"""

import asyncio
import base64
import hashlib
import json
import os
import pathlib
import queue
import re
import shlex
import signal
import subprocess
import sys
import threading
import time
import wave

import numpy as np

SENTENCE = "Annie 你好，我是 Tadashi，现在有两件事要你看。"
CODEX_BIN = os.environ.get("FLY2866_CODEX_BIN", "codex")
# Silence tolerated after the last audible Live frame before closing (run2 used 3.0).
A_TAIL_SECONDS = float(os.environ.get("FLY2866_A_TAIL", "6.0"))
# Engine B realtime model; gpt-realtime-1.5 reproduces the model behind the FLY-1911 samples / legacy prod.
B_MODEL = os.environ.get("FLY2866_B_MODEL", "gpt-realtime-2.1")


def load_key() -> str:
    for line in (pathlib.Path.home() / ".flywheel/.env").read_text().splitlines():
        if re.match(r"(?:export\s+)?OPENAI_API_KEY\s*=", line):
            values = shlex.split(line.split("=", 1)[1], comments=True)
            if len(values) != 1:
                raise SystemExit("unsupported key assignment format")
            return values[0]
    raise SystemExit("authorized voice key missing")


KEY = load_key()


class Log:
    def __init__(self, path: pathlib.Path):
        self.f = open(path, "w")

    def __call__(self, direction, message):
        def safe(v):
            if isinstance(v, dict):
                return {
                    k: (
                        {"b64Length": len(x), "sha256": hashlib.sha256(x.encode()).hexdigest()[:16]}
                        if k in ("audio", "delta", "data") and isinstance(x, str) and len(x) > 300
                        else safe(x)
                    )
                    for k, x in v.items()
                    if k not in ("accessToken", "idToken", "refreshToken", "apiKey", "email")
                }
            if isinstance(v, list):
                return [safe(x) for x in v]
            return v.replace(KEY, "[REDACTED]") if isinstance(v, str) else v

        row = {"at": round(time.time(), 3), "direction": direction, "message": safe(message)}
        self.f.write(json.dumps(row, ensure_ascii=False) + "\n")
        self.f.flush()

    def close(self):
        self.f.close()


def write_wav(path: pathlib.Path, pcm: bytes, rate: int = 24000, channels: int = 1):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(pcm)


async def engine_a(voice: str, out: pathlib.Path) -> dict:
    from websockets.asyncio.client import connect

    log = Log(out / f"A-{voice}.jsonl")
    chunks: list[bytes] = []
    transcript: list[str] = []
    result = {"engine": "A", "model": "gpt-live-1", "voice": voice}
    try:
        async with connect(
            "wss://api.openai.com/v1/live/sessions",
            additional_headers={"Authorization": "Bearer " + KEY},
            open_timeout=20,
            max_size=8 * 1024 * 1024,
        ) as ws:

            async def send(m):
                log("send", m)
                await ws.send(json.dumps(m))

            await send(
                {
                    "type": "session.start",
                    "event_id": f"fly2866-start-{voice}",
                    "session": {
                        "model": "gpt-live-1",
                        "instructions": "你是语音声线测试朗读器。收到的每段文字都用自然的普通话一字不改地读出来，不要加任何别的话，也不要翻译。",
                        "audio": {
                            "format": {"type": "audio/pcm", "rate": 24000},
                            "output": {"voice": voice},
                        },
                        "delegation": {"type": "client"},
                    },
                }
            )
            started = None
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                m = json.loads(await asyncio.wait_for(ws.recv(), deadline - time.monotonic()))
                log("recv", m)
                if m.get("type") in ("session.started", "error", "session.closed"):
                    started = m
                    break
            if not started or started.get("type") != "session.started":
                result["status"] = "startup_failed"
                result["error"] = started
                return result
            result["serverVoice"] = (
                started.get("session", {}).get("audio", {}).get("output", {}).get("voice")
            )
            await send(
                {
                    "type": "session.commentary.append",
                    "event_id": f"fly2866-speak-{voice}",
                    "delegation_id": None,
                    "content": SENTENCE,
                }
            )

            stop = asyncio.Event()

            async def feed_silence():
                # Keep a real-time input clock running (100 ms silent frames), as FLY-2799 did.
                begin = time.monotonic()
                i = 0
                while not stop.is_set():
                    await ws.send(
                        json.dumps(
                            {
                                "type": "session.input_audio.append",
                                "audio": base64.b64encode(bytes(4800)).decode(),
                            }
                        )
                    )
                    i += 1
                    await asyncio.sleep(max(0, begin + i * 0.1 - time.monotonic()))

            feeder = asyncio.create_task(feed_silence())
            last_audio = None
            end = time.monotonic() + 30
            while time.monotonic() < end:
                if last_audio and time.monotonic() - last_audio > A_TAIL_SECONDS:
                    break
                try:
                    m = json.loads(await asyncio.wait_for(ws.recv(), 1.0))
                except asyncio.TimeoutError:
                    continue
                t = m.get("type")
                if t == "session.output_audio.delta":
                    pcm = base64.b64decode(m["delta"])
                    chunks.append(pcm)
                    # Live streams silent frames continuously; only audible frames count as speech.
                    if pcm and int(np.abs(np.frombuffer(pcm, dtype=np.int16)).max()) > 300:
                        last_audio = time.monotonic()
                elif t == "session.output_transcript.delta":
                    transcript.append(m.get("delta", ""))
                log("recv", m)
                if t in ("error", "session.closed"):
                    result["error"] = m
                    break
            stop.set()
            await feeder
            await send({"type": "session.close", "event_id": f"fly2866-close-{voice}"})
            try:
                end = time.monotonic() + 10
                while time.monotonic() < end:
                    m = json.loads(await asyncio.wait_for(ws.recv(), end - time.monotonic()))
                    if m.get("type") != "session.output_audio.delta":
                        log("recv", m)
                    if m.get("type") == "session.closed":
                        result["closed"] = True
                        break
            except Exception as e:  # close-path observation only
                log("closeObservation", {"type": type(e).__name__})
    except Exception as e:
        result["status"] = "exception"
        result["error"] = {"type": type(e).__name__, "message": str(e).replace(KEY, "[REDACTED]")}
        log("exception", result["error"])
    finally:
        pcm = b"".join(chunks)
        if pcm:
            write_wav(out / f"A-{voice}.wav", pcm)
        result.setdefault("status", "ok" if pcm else "no_audio")
        result["pcmBytes"] = len(pcm)
        result["modelTranscript"] = "".join(transcript)
        log("result", result)
        log.close()
    return result


def engine_b(voice: str, out: pathlib.Path, codex_home: pathlib.Path, work: pathlib.Path) -> dict:
    log = Log(out / f"B-{voice}.jsonl")
    env = {k: v for k, v in os.environ.items() if k in ("HOME", "PATH", "TMPDIR", "USER", "LANG", "SSL_CERT_FILE", "SSL_CERT_DIR")}
    env.update({"CODEX_HOME": str(codex_home), "RUST_LOG": "error", "OPENAI_API_KEY": KEY})
    p = subprocess.Popen(
        [CODEX_BIN, "app-server"], cwd=work, env=env, stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True,
    )
    q: queue.Queue = queue.Queue()
    responses: dict = {}
    events: list = []
    chunks: list[bytes] = []
    transcript: list[str] = []
    rate = [24000, 1]
    last_audio = [None]
    result = {"engine": "B", "model": B_MODEL, "version": "v2", "voice": voice}
    tid = None
    n = [0]

    def reader():
        for line in p.stdout:
            try:
                q.put(json.loads(line))
            except Exception:
                pass

    threading.Thread(target=reader, daemon=True).start()

    def send(x):
        log("send", x)
        p.stdin.write(json.dumps(x) + "\n")
        p.stdin.flush()

    def poll(timeout):
        try:
            m = q.get(timeout=timeout)
        except queue.Empty:
            return None
        method = m.get("method")
        if method == "thread/realtime/outputAudio/delta":
            a = m["params"]["audio"]
            rate[0], rate[1] = a["sampleRate"], a["numChannels"]
            chunks.append(base64.b64decode(a["data"]))
            last_audio[0] = time.monotonic()
        elif method and "transcript" in method.lower():
            d = m.get("params", {})
            if method.endswith("delta"): transcript.append(str(d.get("delta") or ""))
        log("recv", m)
        if "id" in m and "method" not in m:
            responses[m["id"]] = m
        else:
            events.append(m)
            if method == "turn/started":
                send({"id": 9000 + len(events), "method": "turn/interrupt", "params": {"threadId": m["params"]["threadId"], "turnId": m["params"]["turn"]["id"]}})
            if "id" in m and method:
                send({"id": m["id"], "error": {"code": -32601, "message": "probe executes no tools"}})
        return m

    def rpc(method, params, timeout=30):
        n[0] += 1
        ident = n[0]
        send({"id": ident, "method": method, "params": params})
        end = time.monotonic() + timeout
        while ident not in responses and time.monotonic() < end:
            poll(min(1, max(0, end - time.monotonic())))
        return responses.pop(ident, {"error": {"message": "local observation timeout"}})

    try:
        rpc("initialize", {"clientInfo": {"name": "fly2866_voice_probe", "version": "0.1.0"}, "capabilities": {"experimentalApi": True}})
        send({"method": "initialized", "params": {}})
        r = rpc("thread/start", {"cwd": str(work), "approvalPolicy": "never", "sandbox": "read-only", "ephemeral": True, "environments": [], "baseInstructions": "Voice capability test. No tools, no files, no tasks.", "config": {"features.shell_tool": False, "features.memories": False}})
        if "error" in r:
            result.update(status="thread_start_failed", error=r["error"])
            return result
        tid = r["result"]["thread"]["id"]
        r = rpc("thread/realtime/start", {
            "threadId": tid, "outputModality": "audio", "clientManagedHandoffs": True,
            "includeStartupContext": False, "version": "v2", "model": B_MODEL, "voice": voice,
            "prompt": "你是语音声线测试朗读器。不要调用任何工具。以 [BACKEND] 开头的消息：只把 [BACKEND] 后面的文字用自然的普通话一字不改地读出来，不要读出前缀，不要加别的话。没有输入时保持安静。",
            "transport": {"type": "websocket"},
        })
        result["startResponse"] = r.get("error") or "ok"
        if "error" in r:
            result["status"] = "realtime_start_rejected"
            return result
        end = time.monotonic() + 8
        while time.monotonic() < end:
            poll(0.5)
        errs = [m for m in events if m.get("method") == "thread/realtime/error"]
        if errs:
            result.update(status="realtime_error", error=errs[0].get("params"))
            return result
        rpc("thread/realtime/appendSpeech", {"threadId": tid, "text": SENTENCE})
        end = time.monotonic() + 25
        while time.monotonic() < end:
            if last_audio[0] and time.monotonic() - last_audio[0] > 3.0:
                break
            poll(0.5)
        errs = [m for m in events if m.get("method") == "thread/realtime/error"]
        if errs:
            result["error"] = errs[0].get("params")
    finally:
        if tid:
            try:
                rpc("thread/realtime/stop", {"threadId": tid}, timeout=5)
            except Exception:
                pass
        try:
            p.stdin.close()
            p.wait(timeout=5)
        except Exception:
            os.killpg(p.pid, signal.SIGTERM)
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(p.pid, signal.SIGKILL)
        pcm = b"".join(chunks)
        if pcm:
            write_wav(out / f"B-{voice}.wav", pcm, rate[0], rate[1])
        result.setdefault("status", "ok" if pcm else "no_audio")
        result["pcmBytes"] = len(pcm)
        result["sampleRate"] = rate[0]
        result["modelTranscript"] = "".join(transcript)
        log("result", result)
        log.close()
    return result


def main():
    out = pathlib.Path(sys.argv[1])
    engine = sys.argv[2]
    voices = sys.argv[3:]
    out.mkdir(parents=True, exist_ok=True)
    results = []
    for v in voices:
        if engine == "A":
            r = asyncio.run(engine_a(v, out))
        else:
            home = out / "codex-home"
            work = out / "work"
            home.mkdir(exist_ok=True)
            work.mkdir(exist_ok=True)
            r = engine_b(v, out, home, work)
        print(json.dumps({k: r.get(k) for k in ("engine", "voice", "status", "pcmBytes", "serverVoice", "modelTranscript", "error")}, ensure_ascii=False), flush=True)
        results.append(r)
    with open(out / f"results-{engine}.json", "w") as f:
        json.dump(results, f, ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
