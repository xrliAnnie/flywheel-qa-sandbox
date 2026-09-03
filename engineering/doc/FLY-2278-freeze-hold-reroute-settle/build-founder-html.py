#!/usr/bin/env python3
"""Assemble founder-design.html from the template + locally rendered Mermaid SVGs.
Usage: python3 build-founder-html.py "<review meta text>"
Asserts: every __SVG_Dn__ placeholder replaced; exactly one __CSP_NONCE__; no CSP meta;
no external script/style/font/img fetches; total size under the publish-report cap."""
import re, sys, pathlib
here = pathlib.Path(__file__).resolve().parent
tpl = (here / "founder-design.template.html").read_text(encoding="utf-8")
meta = sys.argv[1] if len(sys.argv) > 1 else "Codex 设计评审进行中"
svgs = {
    "__SVG_D1__": "d1-core-flow.svg",
    "__SVG_D2__": "d2-data-model.svg",
    "__SVG_D3__": "d3-three-conditions.svg",
    "__SVG_D4__": "d4-hold-door.svg",
}
def shrink_numbers(svg: str) -> str:
    # Only path/coordinate numerics carry >=3 decimals; ids and text never do.
    return re.sub(r"-?\d+\.\d{3,}", lambda m: f"{float(m.group(0)):.1f}", svg)
out = tpl.replace("__REVIEW_META__", meta)
for ph, fn in svgs.items():
    svg = (here / fn).read_text(encoding="utf-8")
    assert svg.lstrip().startswith("<svg"), fn
    m = re.search(r'id="([^"]+)"', svg)
    assert m and m.group(1) == "FLY-2278-" + ph[6:8].lower(), (fn, m and m.group(1))
    svg = shrink_numbers(svg)
    assert ph in out, ph
    out = out.replace(ph, svg, 1)
    assert ph not in out, ph
assert "__SVG_" not in out
assert out.count("__CSP_NONCE__") == 1
assert "Content-Security-Policy" not in out
assert not re.search(r'<(script|link|img)[^>]+(src|href)="https?://', out)
assert "@import" not in out and "fonts.googleapis" not in out
assert re.search(r"on(click|input|load)=", out) is None
ids = re.findall(r'<svg[^>]*id="([^"]+)"', out)
assert len(ids) == 4 and len(set(ids)) == 4, ids
dst = here / "founder-design.html"
dst.write_text(out, encoding="utf-8")
size = dst.stat().st_size
assert size < 512 * 1024, size
print(f"built {dst.name}: {size} bytes; svg ids {ids}")
