#!/usr/bin/env python3
"""Assemble founder-design.html from the template + locally rendered Mermaid SVGs.

Fails loudly (exit 1) if any placeholder is left, any SVG is missing/too small, a
diagram lost its <svg id="FLY-2143-dN"> root, or a diagram lost its viewBox —
never ship a visual artifact you did not check."""
import pathlib, re, sys

here = pathlib.Path(__file__).resolve().parent
tpl = (here / "founder-design.template.html").read_text(encoding="utf-8")
review_log_path = here / "review-log.html"
review_log = review_log_path.read_text(encoding="utf-8") if review_log_path.exists() else ""
out = tpl.replace("<!--REVIEW_LOG-->", review_log)
diagrams = {1: "d1-core-flow.svg", 2: "d2-data-model.svg", 3: "d3-boundary.svg"}
for n, name in diagrams.items():
    p = here / "diagrams" / name
    svg = p.read_text(encoding="utf-8")
    if len(svg) < 2000:
        sys.exit(f"diagram {name} too small ({len(svg)} bytes)")
    if f'id="FLY-2143-d{n}"' not in svg:
        sys.exit(f"diagram {name} lacks svgId FLY-2143-d{n}")
    if "viewBox=" not in svg:
        sys.exit(f"diagram {name} lacks viewBox")
    svg = re.sub(r"^\s*<\?xml[^>]*>\s*", "", svg)
    svg = re.sub(r"^\s*<!DOCTYPE[^>]*>\s*", "", svg)
    placeholder = f"<!--DIAGRAM_{n}-->"
    if placeholder not in out:
        sys.exit(f"placeholder {placeholder} missing in template")
    out = out.replace(placeholder, svg)
if "<!--DIAGRAM_" in out or "<!--REVIEW_LOG-->" in out:
    sys.exit("unfilled placeholder remains")
if out.count('<script nonce="__CSP_NONCE__">') != 1:
    sys.exit("expected exactly one nonced script block")
if "Content-Security-Policy" in out:
    sys.exit("template must not carry its own CSP meta")
if re.search(r"\son[a-z]+=", out):
    sys.exit("inline event handler attribute found")
if re.search(r'<(script|link|img)[^>]+(src|href)="https?://', out):
    sys.exit("external resource found")
(here / "founder-design.html").write_text(out, encoding="utf-8")
print(f"wrote founder-design.html ({len(out.encode('utf-8'))} bytes)")
