#!/usr/bin/env python3
"""FLY-1704 —— 配色方案**本身**是否成立（不是图渲得像不像）。

Lead 抓到的缺陷：六套里 CAT-GITHUB 全都 == PRIMARY，press 还多一处 CAT-X == PRIMARY。
分类色的全部作用就是让 GitHub 和 X 一眼分得开；它等于主色，就等于没有。
色板上看着九个色，渲成页面塌回两三个 —— 正是 Annie 那句「只有两个颜色」。

verify.py 抓不到这个，因为它验的是**保真度**（画出来的 == 打算要的），
不是**区分度**（打算要的这些彼此不同）。**它验的是图符合计划，不是计划本身成立。**

两条断言（第二条是 Lead 自己踩坑后给的）：
  A 同一套里的彩色角色两两拉开，用感知色差 ΔE(Lab) —— 纯不等号挡不住 #2563C9 vs #2563CA
  B **解析到的色值数必须 > 0**，否则「没发现问题」是空集合上的真空通过
"""
import json, pathlib, sys, itertools

DIR = pathlib.Path(__file__).parent
SPEC = json.loads((DIR / "palettes.json").read_text())["palettes"]

# 彩色角色:这几个必须两两分得开。BASE/SURFACE/INK/MUTED 是结构色，另算。
CHROMA = ["PRIMARY", "SECONDARY", "ACCENT", "CAT-GITHUB", "CAT-X"]
MIN_DE = 20.0          # 彩色角色之间的最小感知色差
MIN_DE_STRUCT = 6.0    # 结构色之间只要不肉眼相同即可


def srgb_to_lab(hexs):
    r, g, b = (int(hexs[i:i + 2], 16) / 255 for i in (1, 3, 5))

    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    r, g, b = lin(r), lin(g), lin(b)
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 1.00000
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883

    def f(t):
        return t ** (1 / 3) if t > 0.008856 else (7.787 * t + 16 / 116)

    fx, fy, fz = f(x), f(y), f(z)
    return (116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz))


def de(a, b):
    la, lb = srgb_to_lab(a), srgb_to_lab(b)
    return sum((x - y) ** 2 for x, y in zip(la, lb)) ** 0.5


fail = []

# ── 断言 B:先证明这个检查真的在检查东西 ──────────────────────────
if len(SPEC) == 0:
    print("✗ 解析到 0 套配色 —— 这个检查是真空通过，不是通过")
    sys.exit(1)
print(f"解析到 {len(SPEC)} 套配色")

for p in SPEC:
    n = len(p["colors"])
    if n == 0:
        fail.append(f"{p['id']}: 解析到 0 个色值 —— 真空通过")
        continue
    missing = [r for r in CHROMA if r not in p["colors"]]
    if missing:
        fail.append(f"{p['id']}: 缺角色 {missing}")
        continue

    print(f"\n{p['id']:<10} {p['name_cn']}  ({n} 个色值)")

    # ── 断言 A:彩色角色两两拉开 ──
    worst = (999, None)
    for a, b in itertools.combinations(CHROMA, 2):
        d = de(p["colors"][a], p["colors"][b])
        if d < worst[0]:
            worst = (d, (a, b))
        if d < MIN_DE:
            fail.append(f"{p['id']}: {a} 与 {b} 太近 ΔE={d:.1f} "
                        f"({p['colors'][a]} / {p['colors'][b]}) —— 门槛 {MIN_DE}")
    print(f"  彩色角色最接近的一对: {worst[1][0]} ↔ {worst[1][1]}  ΔE={worst[0]:.1f}")

    # 全部角色两两不得完全相同（含结构色）
    for a, b in itertools.combinations(p["colors"], 2):
        if p["colors"][a].upper() == p["colors"][b].upper():
            fail.append(f"{p['id']}: {a} 与 {b} 完全相同 {p['colors'][a]}")

    # 底色必须是浅的（Apple 浅色底线）
    for role in ("BASE", "SURFACE"):
        L = srgb_to_lab(p["colors"][role])[0]
        if L < 90:
            fail.append(f"{p['id']}: {role} 亮度 L*={L:.0f} 偏暗，浅底线要求 L*≥90")

print("\n" + "=" * 62)
if fail:
    print(f"✗ {len(fail)} 条不通过：")
    for f_ in fail:
        print("   " + f_)
    sys.exit(1)
print(f"✓ {len(SPEC)} 套全部通过：彩色角色两两 ΔE≥{MIN_DE}、无重复色、底色 L*≥90")
