#!/usr/bin/env python3
"""Assemble founder-design.html from the template + locally rendered Mermaid SVGs.

Fails loudly (exit 1) if any placeholder is left, any SVG is missing/too small, a
diagram lost its <svg id="FLY-2141-dN"> root, or a diagram lost its inner width
attributes — never ship a visual artifact you did not check."""
import pathlib, re, sys

here = pathlib.Path(__file__).resolve().parent
tpl = (here / "founder-design.template.html").read_text(encoding="utf-8")
review_log = (here / "review-log.html").read_text(encoding="utf-8")
out = tpl.replace("<!--REVIEW_LOG-->", review_log)
diagrams = {1: "d1-core-flow.svg", 2: "d2-data-model.svg", 3: "d3-boundary.svg"}
for n, name in diagrams.items():
    p = here / "diagrams" / name
    svg = p.read_text(encoding="utf-8")
    if len(svg) < 2000:
        sys.exit(f"diagram {name} too small ({len(svg)} bytes)")
    if f'id="FLY-2141-d{n}"' not in svg:
        sys.exit(f"diagram {name} lacks svgId FLY-2141-d{n}")
    if svg.count(" width=") < 10:
        sys.exit(f"diagram {name} lost its inner width attributes ({svg.count(' width=')})")
    if "viewBox=" not in svg:
        sys.exit(f"diagram {name} lacks viewBox")
    svg = re.sub(r"^\s*<\?xml[^>]*>\s*", "", svg)
    svg = re.sub(r"^\s*<!DOCTYPE[^>]*>\s*", "", svg)
    placeholder = f"<!--DIAGRAM_{n}-->"
    if placeholder not in out:
        sys.exit(f"placeholder {placeholder} missing in template")
    out = out.replace(placeholder, svg)
leftover = re.findall(r"<!--DIAGRAM_\d+-->|<!--REVIEW_LOG-->|\{\{?[A-Z_0-9]+\}?\}", out)
if leftover:
    sys.exit(f"unfilled placeholders: {leftover}")
if out.count('<script nonce="__CSP_NONCE__">') != 1 or out.count("<script") != 1:
    sys.exit("exactly one nonced script block required")
if "Content-Security-Policy" in out:
    sys.exit("no CSP meta allowed")
if re.search(r"\son[a-z]+=\"", out):
    sys.exit("inline event handler attribute found")
if re.search(r'(src|href)="https?://(?!linear\.app/)', out):
    sys.exit("external resource reference found")
textareas = out.count('<textarea data-key="')
sections = out.count("data-title=") - textareas
if textareas < 11 or sections < 11:
    sys.exit(f"comment layer incomplete: sections={sections} textareas={textareas}")
target = here / "founder-design.html"
target.write_text(out, encoding="utf-8")
size = target.stat().st_size
print(f"wrote {target.name} ({size} bytes); svg roots: {out.count('<svg')}; sections: {sections}; textareas: {textareas}")
if size > 512 * 1024:
    sys.exit(f"HTML exceeds publish-report 512KB limit: {size}")
