#!/usr/bin/env python3
"""Stream edge-tts encoded audio to stdout; read all sensitive text on stdin."""

import argparse
import asyncio
import sys

import edge_tts


async def run() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice", required=True)
    parser.add_argument("--rate", default="+0%")
    parser.add_argument("--pitch", default="+0Hz")
    args = parser.parse_args()
    text = sys.stdin.read()
    if not text.strip():
        raise ValueError("empty text")
    communicate = edge_tts.Communicate(
        text,
        args.voice,
        rate=args.rate,
        pitch=args.pitch,
    )
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            sys.stdout.buffer.write(chunk["data"])
            sys.stdout.buffer.flush()


def main() -> None:
    try:
        asyncio.run(run())
    except Exception as error:
        print(
            f"edge-tts stream failed: {type(error).__name__}",
            file=sys.stderr,
            flush=True,
        )
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
