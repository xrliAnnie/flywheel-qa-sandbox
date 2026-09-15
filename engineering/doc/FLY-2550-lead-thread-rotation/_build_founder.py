import pathlib, re, sys
here = pathlib.Path(__file__).resolve().parent
out = (here / "founder-design.template.html").read_text(encoding="utf-8")
review_line = sys.argv[1] if len(sys.argv) > 1 else "Codex design review: pending"
svgs = {"D1": "d1-why-zero.svg", "D2": "d2-rotation-flow.svg", "D3": "d3-data-model.svg"}
for key, name in svgs.items():
    svg = (here / name).read_text(encoding="utf-8")
    svg = re.sub(r"^<\?xml[^>]*\?>\s*", "", svg)
    assert f'id="FLY-2550-{key.lower()}"' in svg, name
    assert 'id="my-svg"' not in svg and "#my-svg" not in svg, name
    out = out.replace("{{" + key + "}}", svg)
out = out.replace("{{REVIEW_LINE}}", review_line)
assert "{{" not in out, "unreplaced placeholder"
assert "__CSP_NONCE__" in out and "Content-Security-Policy" not in out
assert out.count("<script") == 1 and "onclick=" not in out
assert "【页面意见汇总】FLY-2550" in out
assert not re.search(r"(src|href)=\"https?://", out) and "https://cdn" not in out
(here / "founder-design.html").write_text(out, encoding="utf-8")
print("founder-design.html", len(out.encode("utf-8")), "bytes")
