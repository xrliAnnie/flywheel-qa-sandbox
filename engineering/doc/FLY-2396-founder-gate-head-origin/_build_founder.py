#!/usr/bin/env python3
"""Inline the locally rendered Mermaid SVGs into founder-design.html (zero external fetches)."""
import pathlib, re, sys
here = pathlib.Path(__file__).parent
tpl = (here / "founder-design.template.html").read_text(encoding="utf-8")
review_line = sys.argv[1] if len(sys.argv) > 1 else "Codex 设计评审:进行中"
svgs = {"D1": "d1-core-flow.svg", "D2": "d2-data-model.svg", "D3": "d3-author-rule.svg"}
out = tpl.replace("{{REVIEW_LINE}}", review_line.replace("&", "&amp;").replace("<", "&lt;"))
for key, name in svgs.items():
    svg = (here / name).read_text(encoding="utf-8")
    svg = re.sub(r"^<\?xml[^>]*\?>\s*", "", svg)
    assert f'id="FLY-2396-{key.lower()}"' in svg, name
    out = out.replace("{{" + key + "}}", svg)
assert "{{" not in out, "unresolved placeholder"
assert "__CSP_NONCE__" in out and "Content-Security-Policy" not in out
assert not re.search(r"\son[a-z]+=", out), "inline handler attribute"
assert not re.search(r'(src|href)="https?://', out), "external reference"
(here / "founder-design.html").write_text(out, encoding="utf-8")
print("founder-design.html", len(out), "bytes")
