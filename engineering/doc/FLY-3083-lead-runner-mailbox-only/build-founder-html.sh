#!/bin/bash
# FLY-3083: inline the locally rendered Mermaid SVGs into founder-design.html.
# Usage: bash build-founder-html.sh "<review meta text>"
set -euo pipefail
cd "$(dirname "$0")"
META="${1:-设计评审进行中}"
python3 - "$META" <<'PY'
import sys, pathlib
meta = sys.argv[1]
html = pathlib.Path("founder-design.template.html").read_text(encoding="utf-8")
for n, name in [(1, "d1-two-paths"), (2, "d2-hook-flow"), (3, "d3-data-model"), (4, "d4-channel-fault")]:
    svg = pathlib.Path(f"diagrams/{name}.svg").read_text(encoding="utf-8")
    html = html.replace(f"__SVG_D{n}__", svg)
html = html.replace("__REVIEW_META__", meta.replace("&", "&amp;").replace("<", "&lt;"))
assert "__SVG_D" not in html and "__REVIEW_META__" not in html
assert html.count("__CSP_NONCE__") == 1
pathlib.Path("founder-design.html").write_text(html, encoding="utf-8")
print("built founder-design.html", len(html), "bytes")
PY
