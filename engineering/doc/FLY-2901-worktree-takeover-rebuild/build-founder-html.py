#!/usr/bin/env python3
"""Assemble founder-design.html from css/body/script parts + locally rendered Mermaid SVGs
+ review-log snippet. Fails loudly on any contract violation (CSP nonce, handlers, external refs,
comment layer, placeholders, diagram ids)."""
import pathlib, re, sys

ISSUE = "FLY-2901"
here = pathlib.Path(__file__).resolve().parent
css = (here / "founder-design.css.part").read_text(encoding="utf-8")
body = (here / "founder-design.body.html").read_text(encoding="utf-8")
script = (here / "founder-design.script.part").read_text(encoding="utf-8")
out = ("<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\">\n"
       "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n"
       f"<title>{ISSUE} · 接管失败自动保全重建 — 设计</title>\n{css}</head>\n<body>\n{body}{script}")
diagrams = {1: "d1-core-flow.svg", 2: "d2-data-model.svg", 3: "d3-target.svg"}
for n, name in diagrams.items():
    svg = (here / "diagrams" / name).read_text(encoding="utf-8")
    if len(svg) < 2000 or f'id="{ISSUE}-d{n}"' not in svg or "viewBox=" not in svg:
        sys.exit(f"diagram {name} invalid")
    svg = re.sub(r"^\s*<\?xml[^>]*>\s*", "", svg)
    ph = f"<!--DIAGRAM_{n}-->"
    if ph not in out:
        sys.exit(f"placeholder {ph} missing")
    out = out.replace(ph, svg)
review = (here / "review-log.snippet.html").read_text(encoding="utf-8").strip()
if not review or "<!--REVIEW_LOG-->" not in out:
    sys.exit("review-log snippet or placeholder missing")
out = out.replace("<!--REVIEW_LOG-->", review)
if re.findall(r"<!--DIAGRAM_\d+-->|<!--REVIEW_LOG-->", out):
    sys.exit("unfilled placeholders")
if out.count('<script nonce="__CSP_NONCE__">') != 1 or out.count("<script") != 1:
    sys.exit("exactly one nonced script block required")
if "Content-Security-Policy" in out:
    sys.exit("no CSP meta allowed")
if re.search(r"\son[a-z]+=\"", out):
    sys.exit("inline event handler attribute found")
if re.search(r'(src|href)="https?://', out):
    sys.exit("external resource reference found")
textareas = out.count('<textarea data-key="')
if textareas < 9:
    sys.exit(f"comment layer incomplete: textareas={textareas}")
if "【页面意见汇总】" not in out or f'ISSUE = "{ISSUE}"' not in out or "fly-comments:" not in out or "location.pathname" not in out:
    sys.exit("summary marker / issue id / pathname-scoped storage key missing")
target = here / "founder-design.html"
target.write_text(out, encoding="utf-8")
size = target.stat().st_size
print(f"wrote {target.name} ({size} bytes); svg roots: {out.count('<svg')}; textareas: {textareas}")
if size > 512 * 1024:
    sys.exit(f"HTML exceeds 512KB: {size}")
