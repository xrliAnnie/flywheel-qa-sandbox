#!/usr/bin/env python3
"""Inline the locally rendered Mermaid SVGs into the founder HTML (no runtime fetches)."""
import pathlib, re
here = pathlib.Path(__file__).parent
t = (here / "founder.template.html").read_text()
for key, name in (("D1", "d1-flow"), ("D2", "d2-gate"), ("D3", "d3-structure")):
    svg = (here / "diagrams" / f"{name}.svg").read_text()
    svg = re.sub(r"^<\?xml[^>]*>\s*", "", svg)
    t = t.replace("{{" + key + "}}", svg)
assert "{{" not in t
(here / "founder-design.html").write_text(t)
print("wrote founder-design.html", len(t))
