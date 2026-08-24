# -*- coding: utf-8 -*-
"""生成给 Annie 看的那张卡。
⭐ 卡里每一个数字都从 AN1-result.json 现读 —— 不手抄。手抄过的数字会在下一次测量之后
   变成一个看起来仍然可信的旧值,而没有任何东西会变红。
⚠️ 托管页的 CSP 是 default-src 'none' + img-src data:,【没有 media-src】
   ⇒ 内嵌音频会被静默拦掉。所以波形用【内联 SVG】画,音频文件另外走 Discord 附件。"""
import json, html

D = json.load(open("evidence/AN1-result.json"))
NEG, POS, CLIP = D["negativeControl"], D["positive"], D["clip"]

def bars(peaks, color, w=760, h=64):
    n = len(peaks) or 1
    bw = w / n
    top = 32767.0
    out = [f'<rect x="0" y="0" width="{w}" height="{h}" fill="#fafafa"/>']
    for i, p in enumerate(peaks):
        bh = max(1.0, (p / top) * (h - 6))
        out.append(f'<rect x="{i*bw:.2f}" y="{h-bh-3:.2f}" width="{max(bw-0.8,0.6):.2f}" '
                   f'height="{bh:.2f}" fill="{color}"/>')
    return (f'<svg viewBox="0 0 {w} {h}" width="100%" height="{h}" role="img" '
            f'preserveAspectRatio="none">' + "".join(out) + "</svg>")

E = html.escape
neg_svg = bars(NEG["perSecondPeak"], "#c7c7cc")
pos_svg = bars(POS["perSecondPeak"], "#34c759")

TPL = open("evidence/AN1-card.tpl.html", encoding="utf-8").read()
out = (TPL
    .replace("{{NEG_SVG}}", neg_svg).replace("{{POS_SVG}}", pos_svg)
    .replace("{{NEG_SEC}}", str(NEG["seconds"])).replace("{{NEG_PEAK}}", str(NEG["peak"]))
    .replace("{{NEG_NZ}}", str(NEG["nonZeroSamplePct"]))
    .replace("{{POS_SEC}}", str(POS["seconds"])).replace("{{POS_PEAK}}", str(POS["peak"]))
    .replace("{{POS_NZ}}", str(POS["nonZeroSamplePct"]))
    .replace("{{POS_HEARD_SEC}}", f'{POS["seconds"]*POS["nonZeroSamplePct"]/100:.2f}')
    .replace("{{CLIP_SEC}}", str(CLIP["seconds"])))
assert "{{" not in out, "模板还有没换掉的占位符"
open("codex-voice-silence.html", "w", encoding="utf-8").write(out)
print("wrote codex-voice-silence.html", len(out), "bytes")
