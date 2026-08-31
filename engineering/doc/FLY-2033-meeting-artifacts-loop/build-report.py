#!/usr/bin/env python3
"""Assemble founder-design.html = template + inlined mermaid SVGs (FLY-2033)."""
import pathlib

root = pathlib.Path(__file__).parent
tpl = (root / "founder-design.template.html").read_text(encoding="utf-8")
for n, name in ((1, "d1-flow"), (2, "d2-data"), (3, "d3-feedback")):
    svg = (root / "diagrams" / f"{name}.svg").read_text(encoding="utf-8")
    tpl = tpl.replace(f"<!--SVG_D{n}-->", svg)
assert "<!--SVG" not in tpl, "unreplaced SVG placeholder remains"
assert tpl.count("__CSP_NONCE__") == 1, "exactly one nonce placeholder required"
assert "Content-Security-Policy" not in tpl, "page must not carry its own CSP meta"
(root / "founder-design.html").write_text(tpl, encoding="utf-8")
print("OK", len(tpl), "bytes")
