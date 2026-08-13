#!/usr/bin/env python3
"""FLY-1704 —— 每个角色色是否**真的出现在页面截图上**（Lead 的第 2 条硬要求）。

跟另外两个检查分工，三条不同的问题：
  validate.py    配色方案本身成立吗？（角色色两两够不够远）—— 查计划
  verify.py      色板图画出来的色 == 打算要的色吗？—— 查保真度
  verify-pages.py（本文件）这些色**在真页面上露脸了吗**？—— 查落地

为什么必须单独查这条：分类色 CAT-X 可以在 palettes.json 里定义得好好的、
在色板图上画得漂漂亮亮，但页面 CSS 里没接上 → 页面上一次都不出现。
**「定义了」不等于「用上了」。** 图像模型那三轮的 CAT-X 就是这么消失的。

判定：整张图里存在 ≥ N 个像素与该角色色的距离 < TOL，就算「露脸了」。
"""
import json, pathlib, sys
from PIL import Image

DIR = pathlib.Path(__file__).parent
SPEC = json.loads((DIR / "palettes.json").read_text())["palettes"]

# 这几个必须在页面上肉眼可见地出现。BASE/SURFACE 是底色另算，MUTED 是灰字不强求。
MUST_SHOW = ["INK", "PRIMARY", "SECONDARY", "ACCENT", "CAT-GITHUB", "CAT-X"]
# 阈值这次是**校准过**的，不是调到能过为止：
#   证据 —— 肉眼在图上明确看得见的色（studio 的 GitHub 药丁 #00A88F 是个实心色块）
#   在旧阈值下报 0 命中。JPEG 的色度子采样对高饱和色偏移很大，曼哈顿 42 太紧。
# 改用感知色差 ΔE(Lab)，并且**加反向对照**：拿别套配色的颜色测这张图，必须测不到。
# 没有反向对照的「松阈值」= 把结果调绿，那是今晚反复出现的那个病。
DE_TOL = 11.0   # 感知上「就是这个色」
MIN_PX = 25


def rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def _lab(c):
    r, g, b = (x / 255 for x in c)
    f = lambda t: t / 12.92 if t <= 0.04045 else ((t + 0.055) / 1.055) ** 2.4
    r, g, b = f(r), f(g), f(b)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
    k = lambda t: t ** (1 / 3) if t > 0.008856 else 7.787 * t + 16 / 116
    fx, fy, fz = k(x), k(y), k(z)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def count_near(px, want, tol=DE_TOL, cap=MIN_PX):
    wl = _lab(want)
    n = 0
    for q in px:
        dl = _lab(q)
        if (dl[0]-wl[0])**2 + (dl[1]-wl[1])**2 + (dl[2]-wl[2])**2 < tol * tol:
            n += 1
            if n >= cap:
                return n
    return n


bad = 0
if not SPEC:
    print("✗ 解析到 0 套配色 —— 真空通过")
    sys.exit(1)

for p in SPEC:
    f = DIR / f"page-{p['id']}.jpg"
    if not f.exists():
        print(f"✗ {p['id']:<10} 没有页面截图")
        bad += 1
        continue
    img = Image.open(f).convert("RGB")
    px = list(img.getdata())
    if len(px) == 0:
        print(f"✗ {p['id']:<10} 图为空 —— 真空通过")
        bad += 1
        continue

    print(f"\n{p['id']:<10} {p['name_cn']}  ({img.size[0]}x{img.size[1]}, {len(px):,} px)")
    miss = []
    for role in MUST_SHOW:
        want = rgb(p["colors"][role])
        n = count_near(px, want)
        ok = n >= MIN_PX
        print(f"  {'✓' if ok else '✗'} {role:<11} {p['colors'][role]}  命中 {'≥' if ok else ''}{n} px")
        if not ok:
            miss.append(role)
    # ── 反向对照:别套配色里、跟本套所有色都不接近的颜色,必须在这张图上测不到 ──
    #    它证明的是「这把尺子还能说不」。少了它,全绿只说明阈值够松。
    mine = [rgb(v) for v in p["colors"].values()]
    ctrl, ghosts = [], []
    for other in SPEC:
        if other["id"] == p["id"]:
            continue
        for role2 in MUST_SHOW:
            c = rgb(other["colors"][role2])
            if all(sum((a - b) ** 2 for a, b in zip(_lab(c), _lab(m))) ** 0.5 > 30 for m in mine):
                ctrl.append((other["id"] + "/" + role2, other["colors"][role2], c))
    for name, hexv, c in ctrl[:3]:
        n = count_near(px, c)
        if n >= MIN_PX:
            ghosts.append(f"{name} {hexv} 命中 {n}")
    print(f"  反向对照 {len(ctrl[:3])} 个外来色: " +
          ("全部测不到 ✓ 尺子能说不" if not ghosts else "✗ 误报 " + "; ".join(ghosts)))
    if ghosts:
        bad += 1
    if miss:
        print(f"  ✗ 这些角色色在页面上没露脸: {', '.join(miss)}")
        bad += 1

print("\n" + "=" * 60)
print(f"{len(SPEC) - bad}/{len(SPEC)} 套：{len(MUST_SHOW)} 个角色色全部在页面上真的出现")
sys.exit(1 if bad else 0)
