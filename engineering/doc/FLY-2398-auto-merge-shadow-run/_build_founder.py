#!/usr/bin/env python3
"""Build founder-design.html from founder-design.template.html by inlining the
mmdc-rendered SVGs. No network, no runtime mermaid. Run from this directory."""
from pathlib import Path

HERE = Path(__file__).resolve().parent
tpl = (HERE / "founder-design.template.html").read_text(encoding="utf-8")
for n, name in ((1, "d1-flow"), (2, "d2-model"), (3, "d3-table")):
    svg = (HERE / "diagrams" / f"{name}.svg").read_text(encoding="utf-8")
    svg = svg.replace('width="100%"', 'width="100%"', 1)
    tpl = tpl.replace(f"{{{{D{n}}}}}", svg)
assert "{{D" not in tpl, "unresolved diagram placeholder"
assert 'nonce="__CSP_NONCE__"' in tpl
out = HERE / "founder-design.html"
out.write_text(tpl, encoding="utf-8")
print(out, out.stat().st_size, "bytes")
