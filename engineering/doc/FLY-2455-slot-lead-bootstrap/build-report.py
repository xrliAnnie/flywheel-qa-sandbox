#!/usr/bin/env python3
"""Build the issue's self-contained report; SVGs must be rendered locally first."""
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent
template = (ROOT / "report.template.html").read_text()
for name in ("flow", "model"):
    svg = ROOT / f"{name}.svg"
    if svg.exists():
        diagram = svg.read_text()
    else:
        diagram = (
            '<div class="pending" role="note"><strong>DIAGRAM PENDING LOCAL RENDER</strong>'
            '<p>本机图形渲染被系统权限拒绝；标准参数重试后仍失败。图源已保留，未使用远程渲染。</p></div>'
        )
    source = escape((ROOT / f"{name}.mmd").read_text(), quote=True)
    template = template.replace("{{" + name.upper() + "}}", diagram)
    template = template.replace("{{" + name.upper() + "_SOURCE}}", source)
assert "{{" not in template
(ROOT / "founder-design.html").write_text(template)
print("Built founder-design.html:", len(template.encode()), "bytes")
