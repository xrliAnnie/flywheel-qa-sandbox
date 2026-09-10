#!/usr/bin/env python3
"""Assemble founder-prd.html = prd.template.html + the real-data mockup block.

Fails loudly if any placeholder is left, the mockup is missing/too small, the
nonce contract is broken, or an inline handler / external resource sneaks in —
never publish a founder artifact you did not check."""
import pathlib, re, sys

here = pathlib.Path(__file__).resolve().parent
mock_path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else here / "mock2.html"
tpl = (here / "prd.template.html").read_text(encoding="utf-8")
mock = mock_path.read_text(encoding="utf-8")

if len(mock) < 3000:
    sys.exit(f"mockup too small ({len(mock)} chars) — did the data fetch fail?")
for needle in ("现在要你看", "在跑的 Epic", 'class="epic', "示例 · 还没有任何人写过"):
    if needle not in mock:
        sys.exit(f"mockup lacks {needle!r}")
if "<!--MOCKUP-->" not in tpl:
    sys.exit("placeholder <!--MOCKUP--> missing in template")

out = tpl.replace("<!--MOCKUP-->", mock)
if "<!--MOCKUP-->" in out:
    sys.exit("unfilled placeholder remains")
if out.count('<script nonce="__CSP_NONCE__">') != 1:
    sys.exit("expected exactly one nonced script block")
if "Content-Security-Policy" in out:
    sys.exit("template must not carry its own CSP meta")
if re.search(r"\son[a-z]+=", out):
    sys.exit("inline event handler attribute found")
if re.search(r'<(script|link|img)[^>]+(src|href)="https?://', out):
    sys.exit("external resource found")
if "【页面意见汇总】FLY-2457" not in out:
    sys.exit("comment-summary marker missing")
for stale in ("等你裁", "两种读法", "⬜", "按子单算", "甲 / 乙 / 丙", "undecided"):
    if stale in out:
        sys.exit(f"the page still speaks as if the Epic status were open: {stale!r}")
leaked = [n for n in ("塔大", "Tadashi", "Honey Lemon", "Annie", "Flavio") if n in out]
if leaked:
    sys.exit(f"personal name in a founder artifact (F13 forbids it): {leaked}")
keys = re.findall(r'data-comment-key="([^"]+)"', out)
if len(keys) != len(set(keys)):
    sys.exit("duplicate comment keys")
(here / "founder-prd.html").write_text(out, encoding="utf-8")
print(f"wrote founder-prd.html ({len(out.encode('utf-8'))} bytes, {len(keys)} comment boxes)")
