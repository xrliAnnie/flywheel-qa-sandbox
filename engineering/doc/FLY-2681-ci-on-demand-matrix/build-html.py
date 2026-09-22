#!/usr/bin/env python3
"""Inline the locally rendered Mermaid SVGs into the founder HTML template.

Usage: python3 build-html.py   (run from this doc folder)
Reads founder-design.template.html, replaces <!--SVG:dN--> with diagrams/dN-*.svg,
writes founder-design.html. No network, no runtime mermaid.
"""
import glob
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
template_path = os.path.join(HERE, "founder-design.template.html")
out_path = os.path.join(HERE, "founder-design.html")

with open(template_path, encoding="utf-8") as fh:
    html = fh.read()


def svg_for(tag: str) -> str:
    matches = sorted(glob.glob(os.path.join(HERE, "diagrams", f"{tag}-*.svg")))
    if len(matches) != 1:
        sys.exit(f"expected exactly one diagrams/{tag}-*.svg, found {matches}")
    with open(matches[0], encoding="utf-8") as fh:
        svg = fh.read()
    # Strip any XML prolog so the SVG embeds cleanly in HTML.
    svg = re.sub(r"^<\?xml[^>]*\?>\s*", "", svg)
    if "<script" in svg.lower():
        sys.exit(f"{matches[0]} contains a script element; refusing to inline")
    return svg


def replace(match: "re.Match[str]") -> str:
    return svg_for(match.group(1))


html, count = re.subn(r"<!--SVG:(d\d+)-->", replace, html)
if count == 0:
    sys.exit("no <!--SVG:dN--> placeholders found in template")
if "__CSP_NONCE__" not in html:
    sys.exit("template lost the __CSP_NONCE__ placeholder")
if "<meta http-equiv=\"Content-Security-Policy\"" in html:
    sys.exit("template must not carry its own CSP meta")

with open(out_path, "w", encoding="utf-8") as fh:
    fh.write(html)
print(f"wrote {out_path} ({len(html.encode('utf-8'))} bytes, {count} diagrams inlined)")
