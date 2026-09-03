#!/usr/bin/env python3
"""Assemble founder-design.html from the template + locally rendered Mermaid SVGs.

Fails loudly (exit 1) if any placeholder is left, any SVG is missing/too small, or any
diagram lost its <svg id="FLY-2144-dN"> root — never ship a visual artifact you did not
check (FLY-2238 lesson)."""
import pathlib
import re
import sys

here = pathlib.Path(__file__).resolve().parent
tpl = (here / "founder-design.template.html").read_text(encoding="utf-8")
review_log_path = here / "review-log.html"
review_log = (
    review_log_path.read_text(encoding="utf-8")
    if review_log_path.exists()
    else '<p class="note">(评审记录待评审完成后填入)</p>'
)
out = tpl.replace("<!--REVIEW_LOG-->", review_log)
diagrams = {
    1: "d1-core-flow.svg",
    2: "d2-structure.svg",
    3: "d3-sequence.svg",
    4: "d4-retire.svg",
}
for n, name in diagrams.items():
    p = here / "diagrams" / name
    svg = p.read_text(encoding="utf-8")
    if len(svg) < 2000:
        sys.exit(f"diagram {name} too small ({len(svg)} bytes)")
    if f'id="FLY-2144-d{n}"' not in svg:
        sys.exit(f"diagram {name} lacks svgId FLY-2144-d{n}")
    # strip only an XML prolog / doctype if present; never touch width/height attributes
    svg = re.sub(r"^\s*<\?xml[^>]*>\s*", "", svg)
    svg = re.sub(r"^\s*<!DOCTYPE[^>]*>\s*", "", svg)
    placeholder = f"<!--DIAGRAM_{n}-->"
    if placeholder not in out:
        sys.exit(f"placeholder {placeholder} missing in template")
    out = out.replace(placeholder, svg)
leftover = re.findall(r"<!--DIAGRAM_\d+-->|<!--REVIEW_LOG-->", out)
if leftover:
    sys.exit(f"unfilled placeholders: {leftover}")
if out.count('<script nonce="__CSP_NONCE__">') != 1 or out.count("<script") != 1:
    sys.exit("exactly one nonced script block required")
if "Content-Security-Policy" in out:
    sys.exit("no CSP meta allowed")
if re.search(r"\son[a-z]+=\"", out):
    sys.exit("inline event handler attribute found")
if re.search(r'(src|href)="https?://', out):
    sys.exit("external resource reference found")
if "【页面意见汇总】FLY-2144" not in out:
    sys.exit("summary marker literal missing")
target = here / "founder-design.html"
target.write_text(out, encoding="utf-8")
size = target.stat().st_size
print(
    f"wrote {target} ({size} bytes); svg roots: {out.count('<svg')}; sections: {out.count('data-title=')}"
)
if size > 512 * 1024:
    sys.exit(f"HTML exceeds publish-report 512KB limit: {size}")
