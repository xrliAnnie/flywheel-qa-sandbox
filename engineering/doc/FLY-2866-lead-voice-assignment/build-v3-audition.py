"""Build the founder audition page for the 9 v3 voices (engine B, gpt-live-1-codex).

Usage: python3 build-v3-audition.py <audition-dir> <out.html>
  <audition-dir> holds audition.json and mp3/<voice>.mp3 (from evidence/v3/audition.py).

The report gateway serves pages under CSP `default-src 'none'; script-src 'nonce-…'`: there is no
media-src, so <audio> cannot load anything. Playback therefore uses Web Audio: each mp3 is embedded
as base64 inside the (auto-nonced) inline script and decoded with decodeAudioData on click — no fetch,
no media element. No inline event-handler attributes (the gateway rejects them).
"""

import base64
import html
import json
import pathlib
import sys

src = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
aud = json.loads((src / "audition.json").read_text()) if (src / "audition.json").exists() else {}

V3 = ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"]
LINE = "你好，我是你的 Lead，今天由我来跟你同步进度。我这边有两件事已经做完，还有一件在等你拍板，我一件一件跟你说。"
LEADS = [
    ("Raya", "raya", "耳机模式主管 Lead"),
    ("Tadashi", "flywheel-eng-lead", "Flywheel 工程"),
    ("Honey Lemon", "flywheel-product-lead", "Flywheel 产品"),
    ("Aunt Cass", "flywheel-cos-lead", "Flywheel 总管"),
    ("Claw", "claude-infra-bot-lead", "基础设施值守"),
    ("Codex Infra Bot", "codex-infra-bot-lead", "基础设施值守"),
    ("Simba", "cos-lead", "GeoForge3D 总管"),
    ("Peter", "product-lead", "GeoForge3D 产品"),
    ("Oliver", "ops-lead", "GeoForge3D 运营"),
    ("Hiro", "joycon-lead", "Joy-Con"),
    ("Belle", "belle-lead", "生活助理"),
    ("Mufasa", "mufasa-lead", "成长陪练"),
    ("Rafiki", "rafiki-lead", "玄学"),
    ("（未命名）", "reflection-lead", "Reflection"),
    ("Triton", "tidal-echo-cos-lead", "tidal-echo 总管"),
    ("Ariel", "tidal-echo-content-lead", "tidal-echo 内容"),
    ("Asha", "sub-lead", "Sub 内容"),
]

clips = {}
for v in V3:
    p = src / "mp3" / f"{v}.mp3"
    if p.exists():
        clips[v] = base64.b64encode(p.read_bytes()).decode()


def measured(v):
    a = aud.get(v) or {}
    b = a.get("best")
    if not b:
        return '<span class="dim">还没录</span>'
    rng = a.get("f0Range") or ([round(b["f0MedianHz"])] if b.get("f0MedianHz") else [])
    bits = []
    if rng:
        bits.append(f"音高 {rng[0]} Hz" if len(rng) == 1 or rng[0] == rng[-1] else f"音高 {rng[0]}–{rng[-1]} Hz（录了 {len(rng)} 次，每次不同）")
    if b.get("sylPerSec"):
        bits.append(f"{b['sylPerSec']} 字/秒")
    if b.get("cer") == 0:
        bits.append("念得一字不差")
    elif a.get("verbatim"):
        bits.append("照原句念了（识别有 1–2 字出入）")
    else:
        bits.append(f"有改词（识别出：{html.escape(b.get('asr', ''))}）")
    return " · ".join(bits)


sections = []
for i, v in enumerate(V3, 1):
    has = v in clips
    btn = (f'<button class="play" data-voice="{v}" type="button">▶ 播放</button>'
           if has else '<span class="dim">录音待补</span>')
    default = ' <span class="badge">默认</span>' if v == "cove" else ""
    sections.append(f"""
<section class="card" id="v-{v}">
 <div class="head"><span class="num">{i}</span><b class="mono">{v}</b>{default}{btn}</div>
 <div class="src">{measured(v)}</div>
 <textarea data-key="voice:{v}" rows="2" placeholder="听完写一句：像谁、适合谁、不喜欢哪里……"></textarea>
</section>""")

options = "".join(f'<option value="{v}">{v}</option>' for v in V3)
lead_rows = "".join(
    f'<tr><td><b>{html.escape(n)}</b><div class="src">{aid} · {html.escape(role)}</div></td>'
    f'<td><select data-key="lead:{aid}" data-name="{html.escape(n)}"><option value="">—</option>{options}</select></td></tr>'
    for n, aid, role in LEADS
)

page = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>新语音声线试听</title>
<style>
:root{{--bg:#f5f5f7;--card:#fff;--ink:#1d1d1f;--dim:#86868b;--blue:#007aff;--green:#34c759;--amber:#ff9500;--navy:#1a365d;--line:#e5e5ea}}
*{{box-sizing:border-box}}
body{{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,system-ui,sans-serif}}
.wrap{{max-width:760px;margin:0 auto;padding:24px 16px 96px}}
h1{{font-size:23px;margin:0 0 4px;color:var(--navy)}}
h2{{font-size:17px;margin:28px 0 8px}}
.sub,.src{{color:var(--dim);font-size:13px}}
.card{{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:14px 16px;margin:10px 0;border-left:4px solid var(--blue)}}
.card.ask{{border-left-color:var(--amber)}}
.head{{display:flex;align-items:center;gap:10px;font-size:17px}}
.num{{color:var(--dim);font-size:13px;width:18px}}
.mono{{font-family:'SF Mono',ui-monospace,monospace}}
.badge{{font-size:11px;background:#e5e5ea;color:#3a3a3c;border-radius:8px;padding:1px 7px}}
.dim{{color:var(--dim)}}
button{{font:inherit;border:0;border-radius:10px;cursor:pointer}}
.play{{margin-left:auto;background:var(--blue);color:#fff;padding:5px 14px;font-size:14px}}
.play.on{{background:var(--green)}}
textarea{{width:100%;margin-top:8px;border:1px solid var(--line);border-radius:10px;padding:8px 10px;font:inherit;font-size:14px;resize:vertical}}
table{{width:100%;border-collapse:collapse}}
td{{border-bottom:1px solid var(--line);padding:8px 4px;vertical-align:middle}}
select{{font:inherit;font-size:15px;padding:4px 8px;border-radius:8px;border:1px solid var(--line);background:#fff;min-width:120px}}
.bar{{position:fixed;left:0;right:0;bottom:0;background:rgba(255,255,255,.95);border-top:1px solid var(--line);padding:10px 16px}}
.bar .in{{max-width:760px;margin:0 auto;display:flex;gap:10px;align-items:center}}
.copy{{background:var(--navy);color:#fff;padding:10px 18px;font-size:15px}}
#status{{font-size:13px;color:var(--dim)}}
#fallback{{display:none;width:100%;margin-top:8px}}
</style></head><body><div class="wrap">
<h1>新语音（引擎 B）9 个声线试听</h1>
<div class="sub">FLY-2866 · 模型 gpt-live-1-codex，走你订阅的 WebRTC 路径（和 FLY-2884 原型同一条）。每段念的是同一句话：</div>
<div class="card" style="border-left-color:var(--line)">「{LINE}」</div>

<div class="card ask"><b>你要做的</b>：戴耳机听完 9 段，每段写一句感受（可空）；再在下面的表里给每位 Lead 选一个声线（不选就保持默认 cove）。
写完点最下面的「复制全部评论」，贴回 Discord 就行。iPhone 没声音的话，先把静音开关拨开。<div class="src">旧的 marin / verse / alloy 在新模型上用不了，这 9 个是新模型能用的全部声线。</div></div>

<h2>逐个试听</h2>
{''.join(sections)}

<h2>每位 Lead 用哪个</h2>
<div class="card" style="border-left-color:var(--navy)"><table>{lead_rows}</table></div>

<h2>还有别的想法</h2>
<div class="card" style="border-left-color:var(--line)"><textarea data-key="overall" rows="3" placeholder="整体感受、想再听什么……"></textarea></div>
<div class="sub">音高：数越低越沉（大致上男声 85–155 Hz，女声 165–255 Hz）。字/秒：日常说话大约 4–5 字/秒。你的评论只存在这台设备的浏览器里，点「复制」才会带走。<br>iPhone 上点了播放却没声音：把侧边的静音开关拨开（这个页面的播放会被静音开关挡住）。</div>
</div>
<div class="bar"><div class="in"><button class="copy" id="copy" type="button">复制全部评论</button><span id="status"></span></div>
<div class="in"><textarea id="fallback" rows="6" readonly></textarea></div></div>
<script>
(() => {{
  const CLIPS = {json.dumps(clips)};
  const ORDER = {json.dumps(V3)};
  const KEY = "fly2866-v3-audition";
  let saved = {{}};
  try {{ saved = JSON.parse(localStorage.getItem(KEY) || "{{}}"); }} catch (e) {{ saved = {{}}; }}
  const fields = [...document.querySelectorAll("[data-key]")];
  for (const el of fields) {{
    if (saved[el.dataset.key] != null) el.value = saved[el.dataset.key];
    el.addEventListener("input", () => {{
      saved[el.dataset.key] = el.value;
      try {{ localStorage.setItem(KEY, JSON.stringify(saved)); }} catch (e) {{}}
    }});
    el.addEventListener("change", () => el.dispatchEvent(new Event("input")));
  }}

  let ctx = null, current = null, currentBtn = null;
  const decoded = {{}};
  const b64ToBuf = (s) => {{ const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; }};
  const stopCurrent = () => {{
    if (current) {{ try {{ current.stop(); }} catch (e) {{}} current = null; }}
    if (currentBtn) {{ currentBtn.textContent = "▶ 播放"; currentBtn.classList.remove("on"); currentBtn = null; }}
  }};
  for (const btn of document.querySelectorAll("button.play")) {{
    btn.addEventListener("click", async () => {{
      const same = currentBtn === btn;
      stopCurrent();
      if (same) return;
      try {{
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === "suspended") await ctx.resume();
        const v = btn.dataset.voice;
        if (!decoded[v]) decoded[v] = await new Promise((ok, bad) => ctx.decodeAudioData(b64ToBuf(CLIPS[v]), ok, bad));
        const node = ctx.createBufferSource();
        node.buffer = decoded[v]; node.connect(ctx.destination);
        node.addEventListener("ended", () => {{ if (current === node) stopCurrent(); }});
        node.start();
        current = node; currentBtn = btn; btn.textContent = "■ 停止"; btn.classList.add("on");
      }} catch (e) {{
        btn.textContent = "播放失败";
      }}
    }});
  }}

  const status = document.getElementById("status");
  document.getElementById("copy").addEventListener("click", async () => {{
    const lines = ["FLY-2866 新语音声线试听 — 我的选择", "", "【每位 Lead 用哪个】"];
    for (const el of document.querySelectorAll("select[data-key]")) {{
      lines.push(`${{el.dataset.name}}（${{el.dataset.key.slice(5)}}）：${{el.value || "默认 cove"}}`);
    }}
    lines.push("", "【每个声线的感受】");
    for (const v of ORDER) {{
      const t = (saved["voice:" + v] || "").trim();
      lines.push(`${{v}}：${{t || "—"}}`);
    }}
    const overall = (saved.overall || "").trim();
    if (overall) lines.push("", "【其他】", overall);
    const text = lines.join("\\n");
    try {{
      await navigator.clipboard.writeText(text);
      status.textContent = "已复制，去 Discord 粘贴吧";
    }} catch (e) {{
      const fb = document.getElementById("fallback");
      fb.style.display = "block"; fb.value = text; fb.focus(); fb.select();
      status.textContent = "自动复制不可用：已选中下面的文字，请手动复制";
    }}
  }});
}})();
</script>
</body></html>
"""
out.write_text(page)
print(out, len(page.encode()) // 1024, "KB", f"{len(clips)}/9 clips")
