#!/usr/bin/env python3
"""FLY-1704 轮 3 —— 从生成图的**真实像素**取色，跟 palettes.json 的意图值对偏差。

为什么要这一步：图像模型改色是它的已知习性（codex-image 的 skill 自述就写了
"often picks pretty defaults over the prompt's exact hex"）。
图里印出来的 hex 文字**也可能跟它实际画的颜色不一致** —— 文字对不代表色对。
所以不看图上的字，直接读色块中心的像素。

这正是今晚反复出现的那条：**我检查的东西 ≠ 我要保证的属性。**
"要保证的属性" 是「她看到的那个颜色」，那就得读像素，不能读标签。

    python3 verify.py
"""
import json, pathlib, sys
from PIL import Image

DIR = pathlib.Path(__file__).parent
SPEC = json.loads((DIR / "palettes.json").read_text())["palettes"]


def hex_of(rgb):
    return "#%02X%02X%02X" % rgb[:3]


def dist(a, b):
    """sRGB 空间的欧氏距离 —— 粗糙但够用：只要能分出「基本是这个色」和「换了个色」。"""
    return sum((x - y) ** 2 for x, y in zip(a, b)) ** 0.5


def sample(img, n=9):
    """色块是一条等宽横排。取每格中心一小片的中位数，避开圆角、描边和渐变。"""
    w, h = img.size
    # 色块带大致在竖直方向 26%–70%（标题在上、标签在下）
    y0, y1 = int(h * 0.32), int(h * 0.62)
    out = []
    for i in range(n):
        cx = int(w * (0.055 + (0.89 / n) * (i + 0.5)))
        px = [img.getpixel((x, y))
              for y in range(y0, y1, max(1, (y1 - y0) // 12))
              for x in range(cx - 12, cx + 13, 6)]
        px.sort(key=lambda p: (p[0], p[1], p[2]))
        out.append(px[len(px) // 2])
    return out


bad = 0
for p in SPEC:
    hits = list(DIR.glob(f"palette-{p['id']}.*"))
    img_p = next((h for h in hits if h.suffix in (".png", ".jpeg", ".jpg", ".webp")), None)
    if not img_p:
        print(f"✗ {p['id']:<10} 没有图")
        bad += 1
        continue
    img = Image.open(img_p).convert("RGB")
    got = sample(img, len(p["colors"]))
    print(f"\n{p['id']:<10} {p['name_cn']}  ({img_p.name}, {img.size[0]}x{img.size[1]})")
    worst = 0
    for (role, want), rgb in zip(p["colors"].items(), got):
        wr = tuple(int(want[i:i + 2], 16) for i in (1, 3, 5))
        d = dist(wr, rgb)
        worst = max(worst, d)
        flag = "  " if d < 24 else ("~ " if d < 60 else "✗ ")
        print(f"  {flag}{role:<11} 意图 {want}   实际 {hex_of(rgb)}   Δ{d:5.1f}")
    print(f"  最大偏差 Δ{worst:.1f}  → {'一致' if worst < 24 else '有肉眼可见偏色' if worst < 60 else '模型换了色'}")
    if worst >= 60:
        bad += 1

print(f"\n{'=' * 60}\n{len(SPEC) - bad}/{len(SPEC)} 套的图与意图色一致（Δ<60）")
sys.exit(0)
