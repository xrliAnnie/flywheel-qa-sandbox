#!/usr/bin/env python3
"""Render the v2 mockup block from live data (epic-page document + Linear).

Hard rules this script enforces, because they are PRD requirements:
  · zero personal names anywhere in the output (F13)
  · the Epic status is SETTLED (founder 2026-09-09T20:26Z): the badge is Linear's
    state and nothing else; child counts sit beside it as detail, never as a
    second status
  · the lead_note row is labelled as a sample; nobody has written one yet, and a
    fabricated judgement on a founder page would be a lie
Exits non-zero rather than emitting a block that breaks any of them.
"""
import json, html, sqlite3, datetime, pathlib, sys, re

S = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(".")
GUILD_ENV = pathlib.Path.home() / ".flywheel" / ".env"
doc = json.load(open(S / "epic2.json"))["result"]["document"]
lin = {n["identifier"]: n for n in json.load(open(S / "roots2.json"))["data"]["issues"]["nodes"]}
items = {i["identifier"]: i for i in doc["items"]}
roots = {r["identifier"]: r for r in doc["header"]["roots"]["value"]}
stuck = doc["stuck_items"]["value"]
gen = doc["generated_at"]

m = re.search(r"^(?:export )?DISCORD_GUILD_ID=(.+)$", GUILD_ENV.read_text(encoding="utf8"), re.M)
GUILD = m.group(1).strip().strip('"').strip("'") if m else None
db = sqlite3.connect("file:" + str(pathlib.Path.home() / ".flywheel/teamlead.db") + "?mode=ro", uri=True)

def thread_url(idf):
    if not GUILD:
        return None
    r = db.execute("select thread_id from chat_threads where issue_id=? order by created_at desc limit 1", (idf,)).fetchone()
    return f"https://discord.com/channels/{GUILD}/{r[0]}" if r else None

def esc(s): return html.escape(s or "")

SHORT = {"FLY-2441": "通路统一 + Raya 重建", "FLY-2355": "Codex 记忆落地",
         "FLY-2309": "自动合并怎么落地", "FLY-1143": "Release CI/CD 发布流程",
         "FLY-2369": "日常筐(bug / 小需求)"}

OPEN = ("backlog", "unstarted", "triage")

def all_terminal(kids):
    """Only used to drop finished Epics (her rule 4). Never rendered as a status —
    the badge is Linear's state and nothing else (founder 2026-09-09T20:26Z)."""
    ts = [k["state"]["type"] for k in kids]
    return bool(ts) and not any(t == "started" or t in OPEN for t in ts)

def step_of(idf):
    x = items.get(idf)
    if not x: return None
    run = (x.get("run") or {}).get("value") or []
    att = (x.get("attempt") or {}).get("value") or []
    ses = ((x.get("session") or {}).get("value") or {}).get("latest") or []
    if not run: return None
    who = ses[0]["role"] if ses else "?"
    what = ses[0]["status"] if ses else ""
    return f'到「{run[0]["current_node_label"]}」· 第 {att[0]["attempt"] if att else "?"} 次 · {who} {what}'.strip()

# ---------------- 现在要你看 ----------------
now = datetime.datetime.fromisoformat(gen.replace("Z", "+00:00"))
def waited(since):
    mins = int((now - datetime.datetime.fromisoformat(since.replace("Z", "+00:00"))).total_seconds() // 60)
    return f"自 {since[11:16]}Z 起,已等 {mins//60} 小时 {mins%60} 分" if mins >= 60 else f"自 {since[11:16]}Z 起,已等 {mins} 分钟"

# 一张单可能同时命中多个信号;一张单只出一行,取最重的那类,其余做小标签挂在同一行。
RANK = {"waiting_founder": 0, "question_pending": 1, "runner_stopped": 2}
KIND = {
    "waiting_founder": ("在等你按一下(门开着)", "去 thread 里回一句「同意」或「打回」", "k-gate"),
    "question_pending": ("体在问你一句话", "去 thread 里回答它的问题", "k-ask"),
    "runner_stopped": ("体自己停了", "不用你动手 —— 这条本不该占你的位置", "k-stop"),
}
# 读 items[].signals,不读 stuck_items —— stuck_items 里没有 waiting_founder,
# 只读它会把「门开着等她按」错报成「体在问你一句话」。
by_issue = {}
for x in items.values():
    idf = x["identifier"]
    for sig in (x.get("signals") or []):
        if sig["kind"] not in KIND: continue
        cur = by_issue.setdefault(idf, {"sigs": {}})
        prev = cur["sigs"].get(sig["kind"])
        if prev is None or sig["since"] < prev:
            cur["sigs"][sig["kind"]] = sig["since"]
ATT = []
for idf, v in by_issue.items():
    x = items.get(idf, {})
    ordered = sorted(v["sigs"].items(), key=lambda kv: RANK[kv[0]])
    top, since = ordered[0]
    kind, action, cls = KIND[top]
    extra = "".join(f'<span class="u-scope">{esc(KIND[k][0])}</span>' for k, _ in ordered[1:])
    ATT.append({"idf": idf, "title": (x.get("title") or {}).get("value", ""), "kind": kind,
                "action": action, "cls": cls, "since": waited(since), "scope": "Epic 内",
                "extra": extra, "thread": thread_url(idf) is not None})
ATT.append({"idf": "FLY-2244",
            "title": "[流程·designer] product_design 节点规范写错了:高保真 mockup 的形态与交付方式",
            "kind": "你点过名要回来找你", "action": "去看一眼,决定继续还是停", "cls": "k-named",
            "since": "—", "scope": "⚠️ 没挂任何 Epic", "extra": "",
            "thread": thread_url("FLY-2244") is not None})
ATT.sort(key=lambda a: (0 if a["cls"] == "k-gate" else (1 if a["cls"] == "k-ask" else
                        (2 if a["cls"] == "k-named" else 3)), a["idf"]))

rows = []
for a in ATT:
    why = "thread 已存,但跳转链接还没接通" if a["thread"] else "这张单还没有 thread"
    rows.append(f'''<div class="u-row">
<div class="u-l"><span class="u-kind {a['cls']}">{esc(a['kind'])}</span><span class="mono">{esc(a['idf'])}</span>
<span class="u-t">{esc(a['title'][:38])}</span><span class="u-scope">{esc(a['scope'])}</span>{a['extra']}</div>
<div class="u-act">▶ {esc(a['action'])}</div>
<div class="u-r"><span class="u-since">{esc(a['since'])}</span>
<span class="jump-off" title="{esc(why)}">跳 Discord · 还没接通</span></div></div>''')

# ---------------- Epic 卡 ----------------
cards_live, cards_rest = [], []
SAMPLE_ON = "FLY-2441"   # 唯一一张演示 lead_note 形状的卡,明确标为示例
for rid in roots:
    kids = lin[rid]["children"]["nodes"] if rid in lin else []
    linear_state = roots[rid]["state"]["name"]
    if all_terminal(kids): continue
    live = [k for k in kids if k["state"]["type"] == "started"]
    openk = [k for k in kids if k["state"]["type"] in OPEN]
    done = [k for k in kids if k["state"]["type"] == "completed"]
    canc = [k for k in kids if k["state"]["type"] == "canceled"]

    # 状态只有一个来源 = Linear;计数是细节,不是第二个状态(founder 2026-09-09T20:26Z 裁定)。
    badge = f'<span class="e-st st-linear">{esc(linear_state)}</span>'

    body = []
    if rid == SAMPLE_ON:
        body.append('''<div class="leadnote sample"><b>💬 判断</b>
<span class="sample-tag">示例 · 还没有任何人写过</span>
<div class="ln-body">某个 Lead 写下的一句话会出现在这里,例如「这块是别的都建在它上面,它不收后面都没落点」。</div>
<div class="ln-meta">工程 Lead · 2 小时前写</div></div>''')

    for k in live + sorted(openk, key=lambda z: (z.get("priority") or 9, z["identifier"])):
        idf = k["identifier"]; st = k["state"]["type"]
        bl = [r["issue"]["identifier"] for r in k["inverseRelations"]["nodes"] if r["type"] == "blocks"
              and r["issue"]["state"]["type"] not in ("completed", "canceled")]
        if st == "started":
            badge_k, auto = '<span class="s s-live">在跑</span>', (step_of(idf) or "在跑(引擎未报节点)")
        elif bl:
            names = " / ".join(bl)
            badge_k, auto = f'<span class="s s-wait">等 {esc(names)}</span>', f"被 {names} 挡着,没起跑"
        else:
            badge_k, auto = '<span class="s s-idle">未开始</span>', "还没起跑"
        body.append(f'''<div class="kid"><div class="kid-h">{badge_k}<span class="mono">{esc(idf)}</span>
<span class="kid-t">{esc(k["title"][:58])}</span></div><div class="kid-a">↳ {esc(auto)}</div></div>''')

    tail = []
    if done: tail.append(f"{len(done)} 张已完成")
    if canc: tail.append(f"{len(canc)} 张已取消")
    tailhtml = f'<div class="kid-tail">另有 {" · ".join(tail)}(不展示)</div>' if tail else ""
    card = f'''<details class="epic {"e-live" if live else "e-idle"}"><summary>
{badge}<span class="mono e-id">{esc(rid)}</span><span class="e-n">{esc(SHORT.get(rid,""))}</span>
<span class="e-c">{len(live)} 在跑 · {len(openk)} 未开始 · 共 {len(kids)}</span></summary>
<div class="e-b">{"".join(body) or '<div class="empty">没有未完成的子单。</div>'}{tailhtml}</div></details>'''
    (cards_live if live else cards_rest).append(card)

cards = "".join(cards_live + cards_rest)
out = f'''<div class="mock">
<div class="mock-bar">🔒 一个固定链接 · 手机能开 · 系统自己刷新 —— 下面是<b>真数据</b>,{esc(gen[:16].replace("T"," "))}Z</div>
<div class="m-h"><p class="m-t">Flywheel · 现在在做什么</p><div class="note">全部默认收起,点开才展开</div></div>
<div class="sec">⚡ 现在要你看 · {len(ATT)} 件</div>
<div class="urgent">{"".join(rows)}</div>
<div class="sec">在跑的 Epic(全做完的已拿掉;状态直接照抄 Linear)</div>
{cards}
</div>'''

NAMES = ["塔大", "Tadashi", "Honey Lemon", "Annie", "Flavio"]
bad = [n for n in NAMES if n in out]
if bad: sys.exit(f"personal name leaked into the mockup: {bad}")
# The question closed on 2026-09-09T20:26Z. Gate on the settled shape, not on the
# words that used to express the open question: one phrasing disappearing is not
# the same as the question being closed.
for stale in ("等你裁", "两种读法", "⬜", "按子单算", "undecided"):
    if stale in out:
        sys.exit(f"the block still speaks as if the Epic status were open: {stale!r}")
if out.count('class="e-st') != out.count("<details"):
    sys.exit("an Epic card carries more or fewer than exactly one status badge")
if 'class="jump"' in out or "跳 Discord ↗" in out:
    sys.exit("a Discord jump is rendered as if it worked; nobody has opened one")
if out.count('class="u-row') != len(ATT):
    sys.exit("attention rows drifted from the deduped list")
if "示例 · 还没有任何人写过" not in out:
    sys.exit("the lead_note sample lost its label; an unlabelled judgement would read as real")
(S / "mock2.html").write_text(out, encoding="utf-8")
print(f"wrote mock2.html ({len(out.encode())} bytes) · attention={len(ATT)} · epics={len(cards_live)+len(cards_rest)} · guild={'yes' if GUILD else 'no'}")
