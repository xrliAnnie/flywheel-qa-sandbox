#!/usr/bin/env python3
"""Inline the mmdc-rendered SVGs into founder-design.template.html → founder-design.html.

Run from this folder: python3 build-html.py
Zero external dependencies; the template keeps a single <script nonce="__CSP_NONCE__"> block.
Diagrams are rendered locally with mmdc (see *.mmd); no runtime mermaid.js.
"""
from pathlib import Path
import re

here = Path(__file__).resolve().parent
template = (here / "founder-design.template.html").read_text(encoding="utf-8")


def svg(name: str) -> str:
    text = (here / f"{name}.svg").read_text(encoding="utf-8")
    text = re.sub(r"^\s*<\?xml[^>]*\?>\s*", "", text)
    text = re.sub(r"^\s*<!DOCTYPE[^>]*>\s*", "", text)
    assert text.lstrip().startswith("<svg"), f"{name}.svg does not start with <svg"
    assert "http://" not in text.replace("http://www.w3.org", ""), f"{name}.svg has external http refs"
    assert "https://" not in text, f"{name}.svg has external https refs"
    return text


out = template
for name in ("incident", "flow", "model"):
    marker = f"<!--SVG:{name}-->"
    assert marker in out, f"missing marker {marker}"
    out = out.replace(marker, svg(name), 1)

assert out.count('<script nonce="__CSP_NONCE__">') == 1, "exactly one nonced script block required"
assert "Content-Security-Policy" not in out, "do not ship a CSP meta; publish-report injects it"
assert "onclick=" not in out and "onload=" not in out, "no inline handlers"
assert "<script src" not in out and "<link rel=\"stylesheet\"" not in out, "zero external deps"
(here / "founder-design.html").write_text(out, encoding="utf-8")
size = (here / "founder-design.html").stat().st_size
print(f"founder-design.html written: {size} bytes")
assert size < 512 * 1024, "publish-report limit is 512KB"
