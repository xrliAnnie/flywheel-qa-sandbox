import glob, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
tpl = open("design-report.template.html", encoding="utf-8").read()
for n in (1, 2, 3):
    svg = open(glob.glob(f"d{n}-*.svg")[0], encoding="utf-8").read()
    tpl = tpl.replace(f"<!--SVG{n}-->", svg)
assert "<!--SVG" not in tpl, "unreplaced SVG marker"
assert tpl.count("__CSP_NONCE__") == 1, "nonce placeholder count wrong"
assert "Content-Security-Policy" not in tpl, "must not carry own CSP"
open("design-report.html", "w", encoding="utf-8").write(tpl)
print("assembled", len(tpl), "bytes")
