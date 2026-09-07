#!/usr/bin/env python3
"""FLY-2385: inline the mmdc-rendered SVGs into founder-design.html (no runtime mermaid)."""
import pathlib, re
here = pathlib.Path(__file__).parent
src = (here / "founder-design.src.html").read_text(encoding="utf-8")
for n, name in ((1, "d1-shuttle-flow"), (2, "d2-data-model"), (3, "d3-detection")):
    svg = (here / "diagrams" / f"{name}.svg").read_text(encoding="utf-8")
    svg = re.sub(r"^<\?xml[^>]*\?>\s*", "", svg)
    assert f'id="FLY-2385-d{n}"' in svg, name
    src = src.replace(f"%%SVG_D{n}%%", svg)
assert "%%SVG_" not in src
(here / "founder-design.html").write_text(src, encoding="utf-8")
print("wrote founder-design.html", len(src), "bytes")
