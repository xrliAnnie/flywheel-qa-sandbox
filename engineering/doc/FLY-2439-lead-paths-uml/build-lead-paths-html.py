import os, io, html, json, sys, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mmd_edges
D = "diagrams"
import re as _re
def svg(name):
    s = open(os.path.join(D, name + ".svg"), encoding="utf-8").read()
    i = s.find("<svg")
    s = s[i:]
    m = _re.search(r'viewBox="([-\d.]+) ([-\d.]+) ([\d.]+) ([\d.]+)"', s)
    natural = float(m.group(3)) if m else 1000.0
    # 保证文字可读:图按自然宽度渲染,窄屏靠容器横向滚动,不缩到看不清
    return s

CSS = """
*{box-sizing:border-box}
body{margin:0;overflow-x:hidden;background:#f5f5f7;color:#1d1d1f;font:16px/1.65 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"PingFang SC","Hiragino Sans GB",sans-serif;-webkit-text-size-adjust:100%}
.wrap{max-width:960px;margin:0 auto;padding:28px 16px 80px;min-width:0}
h1{overflow-wrap:anywhere;font-size:27px;line-height:1.3;margin:0 0 6px;letter-spacing:-.4px}
h2{font-size:21px;margin:44px 0 12px;letter-spacing:-.2px;padding-top:14px;border-top:1px solid #e3e3e6}
h3{font-size:17px;margin:26px 0 10px}
p{margin:10px 0}
.sub{color:#86868b;font-size:14px;margin:0 0 22px}
.card{background:#fff;max-width:100%;overflow-wrap:anywhere;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:14px 16px;margin:10px 0;border-left:4px solid #86868b}
.card.red{border-left-color:#ff3b30}.card.amber{border-left-color:#ff9500}.card.blue{border-left-color:#007aff}
.card.green{border-left-color:#34c759}.card.purple{border-left-color:#af52de}.card.navy{border-left-color:#1a365d}
.card-title{font-weight:600;font-size:15px;margin-bottom:4px}
.card-body{font-size:14.5px;color:#3a3a3c}
.ref{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:12.5px;color:#1a365d;background:#f0f2f7;border-radius:5px;padding:1px 6px;display:inline-block;margin:3px 4px 0 0;word-break:break-all}
.badge{display:inline-block;font-size:11.5px;font-weight:600;border-radius:999px;padding:2px 9px;margin-right:6px;vertical-align:2px}
.b-no{background:#ffe5e3;color:#c1271c}.b-part{background:#fff2dc;color:#a35c00}.b-yes{background:#e2f7e8;color:#1f7a37}
.b-same{background:#e6f0ff;color:#0b4fa8}.b-diff{background:#ffe5e3;color:#c1271c}.b-one{background:#f3e8ff;color:#7226b5}
.b-gone{background:#ececed;color:#5b5b60}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:10px;margin:14px 0}
.stat{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:14px}
.stat .k{font-size:13px;color:#86868b;margin-bottom:4px}
.stat .v{font-size:15px;font-weight:600;line-height:1.4}
.fig{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:12px;margin:16px 0;min-width:0;position:relative;left:50%;transform:translateX(-50%);width:min(calc(100vw - 24px),1520px)}
.fig .cap{font-size:13px;color:#86868b;margin:0 0 8px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}
.scroll svg{width:100%;height:auto;display:block;max-width:none;min-width:1100px}
.hint{font-size:12.5px;color:#86868b;margin-top:6px}
ul{margin:8px 0;padding-left:20px}li{margin:5px 0;font-size:14.5px}
.quote{background:#fbfbfd;border:1px solid #e8e8ec;border-radius:8px;padding:10px 12px;font-size:14px;color:#3a3a3c;margin:10px 0}
.lead-in{font-size:16px;background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:16px 18px;border-left:4px solid #1a365d}
details.ledger{margin-top:10px;border-top:1px solid #ececee;padding-top:8px}
details.ledger summary{cursor:pointer;font-size:13.5px;color:#1a365d;font-weight:600;list-style:revert}
ol.hops{margin:10px 0 4px;padding-left:22px}
ol.hops li{margin:9px 0;font-size:13.5px;line-height:1.55}
.hop{display:block;font-weight:600;color:#1d1d1f}
.hop b{color:#007aff;font-weight:700}
.hoplab{display:block;color:#5b5b60;margin:1px 0 3px}
.ref i{font-style:normal;opacity:.55;margin-left:5px;font-size:10.5px}
.cbox{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:12px 14px;margin:14px 0 4px;border-left:4px solid #af52de}
.cbox label{display:block;font-size:13px;font-weight:600;color:#1a365d;margin-bottom:6px}
.cbox textarea{width:100%;min-height:76px;resize:vertical;border:1px solid #dcdce0;border-radius:8px;padding:9px 10px;
font:14.5px/1.55 -apple-system,system-ui,"PingFang SC",sans-serif;color:#1d1d1f;background:#fbfbfd}
.cbox textarea:focus{outline:none;border-color:#af52de;background:#fff}
.cbox .saved{font-size:12px;color:#86868b;margin-top:5px;min-height:16px}
.copyout{width:100%;min-height:140px;margin:14px 0 0;border:1px solid #af52de;border-radius:10px;padding:10px;font:12.5px/1.55 'SF Mono',ui-monospace,Menlo,monospace;background:#fff;color:#1d1d1f}
.cbar{position:sticky;bottom:0;background:rgba(245,245,247,.94);backdrop-filter:saturate(180%) blur(12px);
border-top:1px solid #e3e3e6;padding:10px 16px;margin:34px -16px 0;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.cbar button{font:600 14px -apple-system,system-ui,sans-serif;color:#fff;background:#007aff;border:0;
border-radius:999px;padding:9px 18px;cursor:pointer}
.cbar button.ghost{background:#e8e8ed;color:#1d1d1f}
.cbar .st{font-size:13px;color:#86868b}
footer{margin-top:50px;font-size:13px;color:#86868b}
footer .k{color:#1d1d1f;font-weight:600}
@media(max-width:600px){h1{font-size:22px}.wrap{padding:20px 12px 64px}.grid{grid-template-columns:1fr}}
"""

SECTIONS = []
def commentbox(sid, label):
    SECTIONS.append((sid, label))
    return (f'<div class="cbox"><label for="c-{sid}">✍️ 对「{html.escape(label)}」的评论 —— '
            f'边看边写,自动存在你这台设备的浏览器里,不会上传</label>'
            f'<textarea id="c-{sid}" data-sec="{sid}" data-label="{html.escape(label)}" '
            f'placeholder="想到什么写什么;写完到页面底部点「复制全部评论」,粘给 Tadashi 或直接发在 thread 里。"></textarea>'
            f'<div class="saved" id="s-{sid}"></div></div>')

def card(cls, title, body, refs=(), badge=None):
    b = f'<span class="badge {badge[0]}">{badge[1]}</span>' if badge else ''
    r = "".join(f'<span class="ref">{html.escape(x)}</span>' for x in refs)
    return (f'<div class="card {cls}"><div class="card-title">{b}{title}</div>'
            f'<div class="card-body">{body}{"<div>"+r+"</div>" if r else ""}</div></div>')

# 人/平台侧的物理跳:代码里本来就没有对应物,不能算「未验证」,单独标出来
PHYSICAL = (
    "回复出现在频道", "答复出现在 #raya", "消息进频道", "语音房音频",
    "Lead 看到", "Lead 回复", "player 播回房间",
)
SECTION_NOTE = ("主链", "分支一", "分支二")
# 阴性结论:这条边的「依据」就是「找不到」本身,不能当成漏了依据
NEGATIVE = ("✗", "未在代码中找到", "零命中", "只被测试", "无生产写入方", "没有箭头指进来")

def ledger_html(name):
    rows = mmd_edges.ledger(os.path.join(D, name + ".mmd"))
    items, missing = [], 0
    for i, r in enumerate(rows, 1):
        lab = r["label"] or "(无标签)"
        arrow = "⇢" if r["dashed"] else "→"
        if r["refs"]:
            refs = "".join(
                f'<span class="ref">{html.escape(t)}<i>{o}</i></span>' for t, o in r["refs"])
            tag = ""
        elif any(k in lab for k in PHYSICAL):
            refs = ""
            tag = '<span class="badge b-gone">非代码跳(人 / Discord 平台侧)</span>'
        elif any(k in lab for k in NEGATIVE) or any(k in r["from"] + r["to"] for k in NEGATIVE):
            refs = ""
            tag = ('<span class="badge b-no">阴性结论</span>'
                   '<span class="hint" style="display:inline">依据 = 全目录 grep 零命中本身,见 research.md 的搜索口径</span>')
        elif any(lab.startswith(k) for k in SECTION_NOTE):
            refs = ""
            tag = '<span class="badge b-gone">分节标题,非箭头</span>'
        else:
            refs = ""
            tag = '<span class="badge b-no">未验证</span>'
            missing += 1
        items.append(
            f'<li><span class="hop">{html.escape(r["from"])} <b>{arrow}</b> {html.escape(r["to"])}</span>'
            f'<span class="hoplab">{html.escape(lab)}</span>{tag}{refs}</li>')
    head = (f'共 {len(rows)} 条边' + (f' · <b>{missing} 条标为「未验证」</b>' if missing
            else ' · 每条都有 file:line 依据,或已标注为阴性结论 / 非代码跳'))
    return (f'<details class="ledger"><summary>箭头 → 依据清单({head})</summary>'
            f'<ol class="hops">{"".join(items)}</ol>'
            f'<p class="hint">本清单由 <code>{name}.mmd</code> 源码<b>自动抽取</b>,'
            f'所以它与图不可能对不上。「依据」= 边标签上的 <code>file:line</code> + 两端节点自带的 '
            f'<code>file:line</code>,标注了各自来自 边 / 起点 / 终点。</p></details>')

def fig(name, cap):
    return (f'<div class="fig"><p class="cap">{cap}</p>'
            f'<div class="scroll">{svg(name)}</div>'
            f'<p class="hint">图较宽时可左右滑动。完整逐箭头账本在 research.md。</p>'
            f'{ledger_html(name)}</div>')

out = io.StringIO()
w = out.write
w('<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
  '<title>FLY-2439 Lead 通路现状 — 四条路逐箭头实证</title>\n')
w(f'<style>{CSS}</style>\n</head>\n<body>\n')
w('<div class="wrap">')
w('<h1>Lead 通路现状 —— 四条路,逐箭头实证</h1>')
w('<p class="sub">FLY-2439 · 2026-09-08 · 只陈述现状,不提方案 · 零代码改动<br>'
  '完整逐箭头账本在 <code>engineering/doc/FLY-2439-lead-paths-uml/research.md</code>,本页只放结论、图与主锚点。</p>')

w('<div class="lead-in"><b>一句话:</b> 四条通路的 Discord 入站第一跳<b>都不在 Bridge</b> —— '
  '网关/轮询连接和 bot token 各自握在四个不同的进程手里。Bridge 唯一必经的位置,是 Claude Lead 与 Codex Lead 的'
  '「comm.db → 大脑」那一段;Raya 的文字与语音两条路<b>连 comm.db 都没有</b>。</div>')

w('<h2>Bridge 到底在不在路上</h2>')
w('<div class="grid">')
for k,v,c in [
  ("A · Claude Lead(flywheel-eng-lead)","入站第一跳 ✗ 不经过<br>comm.db→模型 ◐ 必经<br>出站 ✗ 只有一次可 fail-open 的守卫","amber"),
  ("B · Codex Lead(mufasa-lead)","入站第一跳 ✗ 不经过 · 连门铃都不敲<br>comm.db→大脑 ◐ 必经<br>出站 ✗ 生产默认 direct","amber"),
  ("C · Raya 文字(PR #26)","✗ 全程无 Bridge<br>✗ 无 comm.db<br>自己的网关 + 自己的 REST","red"),
  ("D · Raya 语音(main b1b5a64)","✗ 全程无 Bridge<br>✗ 无 comm.db<br>侧通道的「收」那一端是断的","red"),
]:
    w(f'<div class="stat" style="border-left:4px solid {"#ff9500" if c=="amber" else "#ff3b30"}">'
      f'<div class="k">{k}</div><div class="v">{v}</div></div>')
w('</div>')
open('/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-2439/c3b027ac-fdf0-4456-8243-1850e98105fd/scratchpad/part1.html','w',encoding='utf-8').write(out.getvalue())
print("part1 bytes", len(out.getvalue()))

# ---------------- A ----------------
w(commentbox('overview', '总览 / Bridge 在不在路上'))
w('<h2>A · Claude Lead — 以 flywheel-eng-lead 为例</h2>')
w(card("navy","持有 Discord 网关连接的,是 Lead 自己的 Claude 会话",
  "启动器把两个 channel 写死进 argv;Discord 适配器是一个 bun 进程,由 Claude Code 作为 MCP/channel 直接拉起,"
  "并且 <code>exec</code> 掉自己好让它成为 Claude 的<b>直接子进程</b>。",
  ["packages/teamlead/scripts/claude-lead.sh:2559","插件 0.0.6 .mcp.json","start-adapter.sh:44",
   "server.ts:494 / :1593 / :1793"]))
w(fig("a-component","组件图 —— 方框是进程边界"))
w(fig("a-sequence","时序图 —— 一条消息从 founder 到回复"))
w('<h3>入站关键跳</h3>')
w(card("blue","① 适配器先把意图原子落盘,再 spawn CLI",
  "崩溃恢复边界在本地 spool;共 2 次即时尝试(1 次重试),都失败才交给 worker 按退避重放。"
  "⚠️ spool <b>写失败</b>时会绕过持久化,直接试一次 CLI,再失败就只打一行 <code>unrecoverable</code> 后放弃。",
  ["chat-receipt-runtime.ts:92-94","chat-receipt-runtime.ts:135","chat-receipt-runtime.ts:119-133"]))
w(card("blue","② chat-ingest 直接打开 sqlite 写统一信箱",
  "CLI 里 <code>ingestDiscordChat</code> → <code>MailboxQueue.claimDiscordLane</code>,<code>carrier=inbox</code>。"
  "整个过程<b>没有任何服务参与</b>,就是打开一个文件写一行。",
  ["packages/flywheel-comm/src/index.ts:747","discord-chat-ingest.ts:77 / :114 / :127","mailbox-schema.ts:193"]))
w(card("amber","③ 之后才轮到 Bridge —— 但那一下只是门铃",
  "代码注释自己写着「队列行才是权威,这个请求只是缩短下一次自适应轮询的间隔」。没配 <code>BRIDGE_URL</code> 就直接 return,消息照样送达。",
  ["lead-inbox-nudge.ts:34-36","lead-inbox-nudge.ts:41-42 / :56","plugin.ts:3017"],("b-no","门铃可丢")))
w(card("green","④ Bridge 的 LeadInboxLoop 是这一段的必经泵",
  "活跃 1s / 空闲 30s 轮询 comm.db、认领、组 <code>mailbox-batch</code> 头,再交给投递适配器。"
  "没有它,队列行永远变不成 JSON 文件里的一条。",
  ["lead-inbox-loop.ts:29-30","lead-inbox-loop.ts:444 / :449 / :467"],("b-yes","必经")))
w(card("purple","⑤ 「Claude 用一个 JSON file」这句话在代码注释里就有",
  "投递适配器按后端分叉:Claude 写文件,Codex 走 socket。原文:"
  "<div class=\"quote\">Codex consumes one packaged turn; Claude writes members atomically and its stock poller packages the unread snapshot into one turn.</div>"
  "落盘是两阶段:先写 <code>.flywheel.jsonl</code> sidecar,再在文件锁内原子改写主 JSON 数组,最后 finalize sidecar。",
  ["lead-delivery-adapter.ts:29-31 / :56 / :75","lead-inbox-runtime.ts:1252-1270","path-helpers.ts:116",
   "ClaudeMailboxCodec.ts:273 / :283 / :290"]))
w(card("amber","⑥ 读侧不在本仓,不能当生产判据",
  "<code>useInboxPoller</code> 是 Claude Code 二进制内部实现。本机有一份源码检出写着 1000ms 轮询,"
  "但它的 <code>package.json</code> 版本是 <code>0.0.0-leaked</code>,而生产跑的是 <code>claude 2.1.263</code> —— 两者对应关系<b>未验证</b>。",
  ["ClaudeCodeAdapter.ts:11 / :255","types.ts:308"]))
w('<h3>还有一条完全绕开一切的车道</h3>')
w(card("red","legacy fail-open:三个 env 缺一,消息直推模型",
  "缺 <code>FLYWHEEL_COMM_CLI</code> / <code>FLYWHEEL_COMM_DB</code> / <code>FLYWHEEL_LEAD_ID</code> 时,"
  "适配器用 <code>notifications/claude/channel</code> 把消息直接推进会话 —— <b>不进 comm.db,不经 Bridge</b>,"
  "只在 stderr 打一行「inbound delivery remains fail-open」。这条车道开没开,<b>在 Discord 侧看不出来</b>。",
  ["server.ts:1750-1753 / :1768-1782","server.ts:109-112","chat-receipt-recorder.ts:87-116"],("b-no","隐形旁路")))
w('<h3>出站</h3>')
w(card("amber","发送前问一次 Bridge 守卫,但守卫可 fail open",
  "插件的 <code>reply</code> 工具先 POST <code>/api/discord/reply-guard</code>(规则:带 issue token 的内容不许发在 chat 频道顶层)。"
  "Bridge 返回 404、或四个 env 少一个,都直接放行。放行后由 Lead 会话内的适配器直发 Discord REST。",
  ["server.ts:1171 / :375-376 / :370 / :391","tools.ts:1276","reply-guard.ts:1-22","server.ts:1339-1342"]))
w(card("blue","另有一条真的经过 Bridge 的出站:issue thread",
  "<code>POST /api/chat-threads/send</code> 的数据面确实经过 Bridge。但它<b>不是插件工具</b> —— 是提示词引导模型自己发 HTTP,所以不是通路里的强制环节。",
  ["tools.ts:711","server.ts:443"]))
w(card("green","Bridge 引擎事件确实先进 Bridge",
  "<code>session_completed</code> 这类事件由 Bridge 自己产生并入队到<b>同一个 MailboxQueue</b>,之后与 Discord 聊天共用同一条 batch 管道、落进<b>同一个 JSON 文件</b>。一个 batch 不允许混装两类。",
  ["plugin.ts:5825","lead-inbox-runtime.ts:573","lead-inbox-loop.ts:414 / :449"]))

# ---------------- B ----------------
w(commentbox('a', 'A · Claude Lead'))
w('<h2>B · Codex Lead — 以 mufasa-lead 为例</h2>')
w(card("navy","它是一个独立的 launchd 守护进程,不是 Bridge 的一部分",
  "生产用的是<b>窗口化 TUI</b> 形态(<code>FLYWHEEL_CODEX_LEAD_MODE=tui</code>),连的是一个共享的 "
  "<code>codex remote-control</code> daemon;founder 自己的 <code>codex resume --remote</code> 窗口是<b>同一个 thread 的另一个客户端</b>。",
  ["run-codex-lead-mufasa-tui-fullaccess.sh:36 / :75 / :140","codex-lead-tui-runtime.ts:1-6 / :539-541","daemon-ws.ts:13-14 / :36"]))
w(fig("b-component","组件图 —— 与 A 只有中间一段共用代码"))
w(fig("b-sequence","时序图"))
w(card("blue","入站是 3s REST 轮询,不是网关 websocket",
  "文件顶上的注释直接写着轮询形状:<code>GET /channels/{id}/messages?after=&lt;lastSeenId&gt;</code>。",
  ["RestPollDiscordInboundSource.ts:7 / :121","codex-lead-tui-runtime.ts:665 / :749"]))
w(card("red","B 连门铃都不敲",
  "门铃写在 <code>flywheel-comm</code> 的 <b>CLI 子命令</b> 里,只有 spawn CLI 的一方(也就是 A)才执行得到。"
  "B 是<b>进程内直接调库函数</b>;<code>packages/teamlead/src/lead-backends/codex/</code> 下 grep "
  "<code>nudgeLeadInbox</code> / <code>lead-inbox/nudge</code> <b>零命中</b>。",
  ["CodexDiscordMailboxStrategy.ts:1 / :72","CodexDiscordGateway.ts:233","index.ts:781-789"],("b-no","无门铃")))
w(card("green","Bridge 在这里的角色:把队列行泵过一条 unix socket",
  "Bridge 是 socket 的<b>客户端</b>,Lead 守护进程是<b>服务端</b>。为什么不能直写?"
  "<div class=\"quote\">The Codex Lead router lives in the windowed TUI sidecar process. The Bridge therefore cannot mutate journal.db directly…</div>",
  ["CodexLeadInboxSocket.ts:4-7 / :64 / :78 / :202","lead-delivery-adapter.ts:92 / :103 / :146"],("b-yes","必经")))
w(card("purple","进大脑前还要先落一次 journal.db",
  "socket 收到批之后先 <code>journal.acceptBatch()</code> 持久化,<b>只有 accepted_new 才入队起泵</b>,再 <code>turn/start</code>。",
  ["LeadInputRouter.ts:218 / :219-225 / :291 / :297","LeadJournal.ts:240 / :260","CodexTurnExecutor.ts:156-161"]))
w(card("red","出站生产默认 direct —— 启动脚本自己写着「绕开 Bridge 出站授权」",
  "<div class=\"quote\">DIRECT (Mufasa's production mode) — … bypasses Bridge outbound authorization.</div>"
  "Lead 守护进程用自己的 bot token 直发 <code>discord.com/api/v10</code>。"
  "代码里确实有一条经 Bridge 的出站(<code>POST /api/lead-outbound/send</code>),但<b>没有任何在用的 launcher 把它打开</b>。",
  ["run-codex-lead-mufasa-tui-fullaccess.sh:101-104","DirectDiscordOutboundSender.ts:4 / :57","discord-utils.ts:10","CodexOutboundSender.ts:180"],("b-no","不经 Bridge")))
w(card("amber","运行时旁证(2026-09-08T03:13Z 观察,非代码结论)",
  "<code>launchctl list</code> 显示 <code>com.flywheel.lead.growth-mufasa-lead</code> 与 "
  "<code>com.flywheel.lead.flywheel-codex-infra-bot-lead</code> 的 PID 均为 <code>-</code>、last exit <code>3</code>;"
  "<code>pgrep -f codex-lead-tui-runtime</code> 无结果 —— 当时两个 Codex Lead 守护进程都没在跑。"))

# ---------------- C ----------------
w(commentbox('b', 'B · Codex Lead'))
w('<h2>C · Raya 文字通路(raya PR #26,分支 fly-2379-raya-text-chat)</h2>')
w(card("red","这条路上没有 Bridge,也没有 comm.db",
  "在 <code>apps/brain/src/</code> 全目录 grep <code>9876</code> / <code>bridge</code> / <code>flywheel-comm</code> / "
  "<code>chat-ingest</code> —— <b>零命中</b>(2026-09-08 复核)。入站是自己的 discord.js 网关,出站是自己的 REST。",
  ["voice-mode.ts:632-638 / :643 / :658","cli.ts:392-404","discord-rest.ts:6 / :25 / :38-41"],("b-no","全程无 Bridge")))
w(fig("c-component","组件图"))
w(fig("c-sequence","时序图 —— 含「问 Lead」的完整回路"))
w(card("blue","大脑是自己 spawn 的 codex app-server,一轮对话真正的调用是 turn/start",
  "线程连续性<b>有条件</b>:正常复用/恢复;只有「一开始没有 resumeId」或「resume 报的错被判定为 rollout 不存在」才新建。"
  "普通 resume 错误会重连再试一次,第二次仍失败就抛错,<b>不新建</b>。",
  ["codex-client.ts:118-121 / :143 / :222","controller.ts:404-445 / :595","codex-session.ts:20 模型 gpt-6-astra"]))
w(card("purple","「问 Lead」是另一套协议:模型在自己的回答里写一行文本标记",
  "正则解析出 <code>【问 Lead】名字:问题</code> → 往 roundtable 频道发一条 @mention 明文 → 每 30s REST 轮询捞回 → "
  "校验答复者确实是那个 Lead 的 bot → 落 <code>answer_observed</code> → 再跑一轮 <code>turn/start</code> 合成后发回 <code>#raya</code>。",
  ["lead-ask.ts:44","controller.ts:802 / :928 / :1027 / :1063-1071 / :1089-1095 / :1170-1180","config.ts:151 askPollMs 30s"]))
w(card("green","有一道 flywheel 侧没有的硬门:凭据读隔离",
  "开服前必须证明 Codex 沙箱<b>读不到</b> <code>.env</code>,证明不了就直接拒绝提供文字聊天。",
  ["secret-isolation.ts:59-67","codex-sandbox-probe.ts:28-37","cli.ts:213-217 / :234","controller.ts:264-268"]))
w(card("amber","生产配置实测:这条路今天还没通电",
  "PR #26 <b>尚未合并</b>(HEAD <code>34c8794</code>,生产 checkout 在 <code>b1b5a64</code>);"
  "而且 <code>~/.flywheel/raya/raya.env</code> 的 18 个 key 里<b>没有</b> <code>RAYA_LEADS_ROUNDTABLE_CHANNEL_ID</code> —— "
  "即便合并,roundtable 分支也拿不到频道 id。launchd plist 只注入 <code>RAYA_ENV_FILE</code>,没有别的 env 来源。"))

w('<h3>C 与 B 逐项对照 —— founder 直问「它和 Codex 的区别是什么」</h3>')
CB = [
 ("b-diff","不同","入站机制","B:REST 轮询 3s · C:discord.js 网关 websocket",["RestPollDiscordInboundSource.ts:121","voice-mode.ts:632-643"]),
 ("b-diff","不同","入站落点","B:写 comm.db 统一信箱 · C:无信箱,回调直接进控制器",["CodexDiscordMailboxStrategy.ts:72","cli.ts:392-404"]),
 ("b-diff","不同","Bridge 参与","B:LeadInboxLoop 泵 + socket 投递 · C:完全没有",["lead-inbox-runtime.ts:341","apps/brain/src 零命中"]),
 ("b-diff","不同","投递给大脑","B:unix socket → Router → Executor · C:同进程直接函数调用",["CodexLeadInboxSocket.ts:202","cli.ts:399"]),
 ("b-diff","不同","大脑连接","B 生产是 TUI 连共享 daemon · C 是自己 spawn stdio(与 B 的 headless 形态相同)",["codex-lead-tui-runtime.ts:539-541","codex-client.ts:118-121"]),
 ("b-same","相同","JSON-RPC 方法","两边都用 thread/start · thread/resume · turn/start",["CodexLeadProcess.ts:372,380,415","controller.ts:408,415,595"]),
 ("b-same","相同","出站形态","两边都是直发 Discord REST,都没有出站守卫",["DirectDiscordOutboundSender.ts:57","discord-rest.ts:38-41"]),
 ("b-diff","不同","超时","B:60s 管<b>单次 RPC</b>,awaitCompletion <b>没有超时</b> · C:300s/900s 管<b>整轮生成</b>并会 turn/interrupt",["CodexLeadProcess.ts:141","config.ts:147-148","controller.ts:617-619"]),
 ("b-diff","不同","问 Lead","B:comm.db 的 ask/gate,有 admission 与超时语义 · C:文本标记 + @mention + 30s 轮询 + 同 thread 合成",["lead-ask.ts:44","controller.ts:928,1027,1170-1180"]),
 ("b-diff","不同","Lead 名册","B:~/.flywheel/projects.json · C:Raya 自有 profile.json(生产 14 份,可各自漂移)",["meeting.ts:431-436"]),
 ("b-diff","不同","MCP 注入","B 有(按 profile 不同)· C 代码里不注入任何 MCP",["buildCodexLeadMcpArgv.ts","codex-session.ts:110-133"]),
 ("b-diff","不同","daemon 监督","B:launchd + WS 断连代际围栏重建 · C:launchd + 进程内 onExit 重建(无围栏无退避)",["DaemonConnectionSupervisor.ts","controller.ts:557-571"]),
 ("b-diff","不同","凭据隔离","B 生产 full-access profile 下<b>没有</b> broker/confinement · C 有读隔离硬门",["codex-lead-runtime.ts:1385-1390","secret-isolation.ts:59-67"]),
]
for badge,label,dim,body,refs in CB:
    cls = "blue" if badge=="b-same" else "amber"
    w(card(cls, dim, body, refs, (badge,label)))

# ---------------- D ----------------
w(commentbox('c', 'C · Raya 文字'))
w('<h2>D · Raya 语音通路(raya main b1b5a64)</h2>')
w(fig("d-component","组件图 —— 侧通道的两个方向彼此不相连"))
w(fig("d-sequence","时序图 —— 主链 + 两条分支"))
w('<h3>founder 直问:语音会议里,Raya 要和别人交流 / 做别的事,走哪条路?现在能不能?</h3>')
w(card("red","「问别人并把答案接回本次会议」—— 没有这条路",
  "回流口是 <code>&lt;stateDir&gt;/voice-inbox/items.jsonl</code>,<code>InboxReader</code> 完整实现了轮询与五种处置。"
  "但 <b>写入方在生产不存在</b>:<code>appendVoiceInboxItem</code> 在 <code>b1b5a64</code> 全仓的调用点只有测试、探针和一个夹具脚本;"
  "raya 自己的计划文档把 producer 记为待办;生产盘上 <code>voice-inbox/</code> 目录<b>根本不存在</b>。",
  ["voice-inbox.ts:228-235","InboxReader.ts:203 / :210 / :386-389","FLY-2031 plan.md:399"],("b-no","不具备")))
w(card("amber","「向某个 Lead 转达一句话」—— 有,但语义是 opt-out,不是 opt-in",
  "流程:Codex 模型写一个 <code>*.action.json</code> 提案 → OutboxWatcher 认领并<b>逐字比对 founder 转写</b>取证 → "
  "Raya 口头复述 → <b>等一个「反对窗口」超时</b> → 发出。",
  ["OutboxWatcher.ts:372-396 / :444-462","ReadbackGate.ts:160-174 / :192-194 / :197","RoomText.ts:57-103 / :105-137"],("b-part","有条件")))
w(card("red","🔴 而且 Raya 念给 founder 听的那句话,和真正的执行语义不一致",
  "播报稿原文同时说了两件事:"
  "<div class=\"quote\">确认后我会真的把消息发给对方;如果不对就说取消,我就不发。</div>"
  "执行上<b>只有后半句成立</b> —— 没有任何代码在等「确认」。反对词只有 <code>不对 / 等等 / 取消</code> 三个,"
  "且必须是 founder 本人说的;反对窗口<b>超时返回「未取消」就直接发送</b>。",
  ["ReadbackGate.ts:87-96(:94 是这句原文)","ReadbackGate.ts:244-253","ReadbackGate.ts:291-295"],("b-no","语义相反")))
w(card("blue","还能做的两件事(都不是「主动找人」)",
  "① <b>自动字幕</b>:VoiceTextMirror 把转写镜像到一个固定文本频道,是运行时副作用,不是 Raya 的意图;"
  "② <b>ship 审批投票</b>:由外部一条 <code>ship_gate</code> inbox item armed,再由 founder <b>口头说「确认/不批」</b>才发 —— "
  "这一条才是真的 affirmative 确认。⚠️ 生产 env 里<b>没有</b> <code>RAYA_APPROVAL_ENDPOINT_URL</code>,该路径当前拿不到 baseUrl。",
  ["VoiceTextMirror.ts:42-100","InboxReader.ts:422","runtime.ts:907","ShipGateFlow.ts:333-484 / :541-552","ApprovalClient.ts:228-230 / :252-265"]))
w(card("purple","查 Flywheel 状态(issue / runner / PR)",
  "<code>apps/voice</code> 里没有专门的 Flywheel 状态集成:<code>git grep -ni \"linear\\|runner\"</code> 零命中,"
  "<code>flywheel-comm</code> 零命中。唯一的状态读取是 <code>ApprovalClient.getGateBinding/getContext</code>,"
  "只读<b>一条已 armed 的 ship-gate</b> 的元数据。⚠️ 本行不排除 Codex 线程自身的 tool surface 能做别的事 —— 那超出 <code>apps/voice</code> 代码范围,<b>未验证</b>。",
  ["ApprovalClient.ts:238-250"]))

# ---------------- G ----------------
w(commentbox('d', 'D · Raya 语音'))
w('<h2>G · 统一化实证 —— 把 Raya 变成一个普通 Codex Lead,现状能撑住多少</h2>')
w(card("navy","先说一件会影响全局判断的事:Codex Lead 壳不是一种形态,是三条 profile",
  "同一份壳按 <code>codexProfile</code> 走完全不同的路径。注释原文:"
  "<div class=\"quote\">full-access shares the workspace-write sandbox but takes a SEPARATE path — NO release gate / gateway / broker / confinement</div>"
  "<b>生产 Mufasa 就是 full-access</b>。所以任何「壳有 X」的说法,都必须写明它适用于哪条 profile。",
  ["codex-lead-runtime.ts:1385-1390","run-codex-lead-mufasa-tui-fullaccess.sh"]))
w('<h3>G.1 逐维度:哪些是同一件事的两份实现</h3>')
w('<p class="sub">壳:<code>packages/teamlead/src/lead-backends/codex/</code> — 57 个非测试 <code>.ts</code> / 16 761 行。'
  'Raya 文字侧:<code>apps/brain/src/text-chat/</code> 6 个文件 / 1 964 行 + contracts 241 行。'
  '行数口径:<code>.ts</code>、只排除 <code>*.test.ts</code>、<code>wc -l</code>。</p>')
G1 = [
 ("b-same","两份实现","入站","壳:REST 轮询 3s + Gateway 过滤 + mention-gate;Raya:discord.js 网关 + classify 分流。做的是同一件事,机制不同。",
   ["RestPollDiscordInboundSource.ts:512 行 / :121","CodexDiscordGateway.ts:233","voice-mode.ts:626-658"]),
 ("b-one","只有一边有","信箱 / durable 入站","🔴 <b>Raya 没有 durable 入站信箱。</b> <code>store.ts</code>(194 行)只存三样:Codex thread 身份、ask 状态、metadata-only 事件;入站消息只在进程内串行处理。壳侧是 comm.db <code>mailbox</code> 表 + LeadJournal/SqliteJournalStore 双层 durable。",
   ["store.ts:107 / :110-112","controller.ts:244","mailbox-schema.ts:193","LeadJournal.ts:500 行"]),
 ("b-same","两份实现","路由","壳:socket → Router(先 journal accept)→ Executor → TurnDemux;Raya:<code>controller.ts</code> 一个类全包。壳多一层跨进程 socket,因为 Bridge 与 Lead 是两个进程。",
   ["LeadInputRouter.ts:218 / :219-225","controller.ts:244 / :390-445 / :587-624"]),
 ("b-same","两份实现","大脑连接","壳:TUI 连共享 daemon / headless spawn stdio;Raya:只有 spawn stdio(缺 daemon 形态)。",
   ["CodexLeadProcess.ts:642 行","daemon-ws.ts:36","codex-client.ts:118-121"]),
 ("b-same","两份实现","出站","壳:direct(生产默认)或 bridge 模式 + send guard;Raya:<code>send()</code> 一个函数。",
   ["DirectDiscordOutboundSender.ts:57","discord-rest.ts:38-41"]),
 ("b-diff","不是同一件事","超时","🔴 壳的 60s 管的是<b>每次 JSON-RPC 请求</b>,<code>awaitCompletion()</code> 只 <code>await</code>、<b>没有超时</b>;Raya 的 300s/900s 管的是<b>整轮生成</b>,超时会 <code>turn/interrupt</code>。壳侧的轮级超时<b>未在代码中找到</b>。",
   ["CodexLeadProcess.ts:141","config.ts:147-148","controller.ts:617-619"]),
 ("b-one","只有一边有","MCP 注入","壳有,Raya 代码里没有。⚠️ 但「壳允许什么」要分两层:builder 的非 gateway 分支注释说 chrome 可共存,<b>而生产 Mufasa 走 TUI,TUI 另有一道 exact config gate</b> —— 要求 effective config <b>EXACTLY</b> 只含受信任的 <code>lead_actions</code>,任何额外 MCP 一律 fail-closed。所以「Chrome 可共存」只是 builder 的潜在能力,<b>不是生产事实</b>。",
   ["buildCodexLeadMcpArgv.ts:158-159 / :163 / :181-190","lead-actions/mcp-config.ts:204-210","codex-lead-runtime.ts:686"]),
 ("b-same","两份实现","daemon 监督","壳:launchd + WS 断连的代际围栏 + 有界退避重建;Raya:launchd(KeepAlive Crashed、Throttle 60s)+ <b>进程内也有一层</b> <code>client.onExit</code> → 拒绝 in-flight turn → 下次 <code>ensureClient()</code> 重建。差别是围栏与退避,不是「Raya 只有 launchd」。",
   ["DaemonConnectionSupervisor.ts:263 行","installer.ts:24","launchd.ts:34-37 / :62-63","controller.ts:557-571 / :419-425"]),
 ("b-diff","不是同一件事","凭据隔离","🔴 <b>不能说「flywheel 一定更严」。</b> broker/confinement 只在 confined write-capable 路径上;生产 full-access 路径两者都没有,而且 TUI 的 daemon env 直接携带 <code>DISCORD_BOT_TOKEN</code>。Raya 反而有一道读隔离硬门。两者互补,都不覆盖对方。",
   ["codex-lead-runtime.ts:1385-1390","codex-lead-tui-runtime.ts:215","secret-isolation.ts:59-67"]),
 ("b-diff","不是同一件事","问 Lead / roundtable","🔴 重叠的只是「接答复 + 回灌」。<b>不重叠的是主动发起</b>:壳的主动 roundtable 发送当前被明确<b>拒绝</b> —— roundtable 配置存在时 <code>autoContinue</code> 固定为 <code>true</code>,此时 <code>discord-send-core</code> 返回 <code>REFUSED: proactive roundtable posts are deferred…(FLY-680 未接通)</code>。Raya 有完整的发起→关联答复→合成闭环。",
   ["codex-lead-runtime.ts:676","discord-send-core.ts:123-143","controller.ts:928 / :1063-1071 / :1170-1180"]),
 ("b-same","两份实现","Lead 名册","壳:<code>~/.flywheel/projects.json</code>;Raya:<code>&lt;stateDir&gt;/leads/&lt;id&gt;/profile.json</code>(生产 14 份),多 4 个壳没有的字段。两份数据可各自漂移。",
   ["meeting.ts:431-436"]),
]
for badge,label,dim,body,refs in G1:
    cls = {"b-same":"blue","b-diff":"red","b-one":"purple"}[badge]
    w(card(cls, dim, body, refs, (badge,label)))
w(card("green","只有壳有 / 只有 Raya 有",
  "<b>只有壳有:</b> CodexLeadInboxSocket(411)、CodexDiscordMailboxStrategy、ExternalReceiptSaga(154)、"
  "CodexDiscordRuntimeOwnership(309)、CodexLeadOutboundHandler(287)、gateway/*(约 3 300 行)、lead-actions/*、"
  "buildCodexLeadMcpArgv、tui-window*。<br>"
  "<b>只有 Raya 有:</b> meeting.ts(1 230)+ meeting-calendar.ts(284)会议编排、语音房编排、"
  "身份/记忆文件注入(baseInstructions)、完整的 ask 生命周期。"))

w('<h3>G.2 若把 Raya 接到壳上,raya 仓哪些文件会被删 / 保留</h3>')
w(card("red","读这一节前先看两条硬声明",
  "① 这是按 G.1 的对应关系做的<b>归类推演</b>,不是实施计划,<b>没有验证可行性</b>;"
  "② 本节不提方案,凡是「若统一则会怎样」的句子都只是归类,不是代码事实。"))
w('<div class="grid">')
for k,v in [("壳里有对应物,原则上可由壳承担","≈ 890 – 1 090 行"),
            ("壳里没有对应物,必须保留(不含 apps/voice)","≈ 4 270 行"),
            ("其中 apps/voice 单独","13 683 行 / 45 个非测试 .ts"),
            ("必须保留合计","≈ 17 950 行")]:
    w(f'<div class="stat"><div class="k">{k}</div><div class="v">{v}</div></div>')
w('</div>')
w(card("blue","可由壳承担(≈ 890–1 090 行)",
  "<ul>"
  "<li><code>text-chat/codex-client.ts</code> 301 → <code>CodexLeadProcess</code>(642)</li>"
  "<li><code>text-chat/discord-rest.ts</code> 96 → <code>RestPollDiscordInboundSource</code> + <code>DirectDiscordOutboundSender</code>/<code>discord-send-core</code></li>"
  "<li><code>text-chat/fallback.ts</code> 14 → 已是死代码(全仓只有它自己和它的测试引用)</li>"
  "<li><code>controller.ts</code> 的<b>传输与轮次</b>部分,1 291 中约 400–600 → <code>LeadInputRouter</code> + <code>CodexTurnExecutor</code> + <code>TurnDemux</code></li>"
  "<li><code>voice-mode.ts</code> 的 <code>messageCreate</code>/<code>classify</code> 分流段,691 中约 80 → <code>CodexDiscordGateway</code> + <code>mention-gate</code></li>"
  "</ul>"))
w(card("amber","必须保留(≈ 17 950 行)",
  "<ul>"
  "<li><code>apps/voice/**</code> 全部 —— <b>13 683 行 / 45 文件</b>,壳完全不覆盖(见 G.3)</li>"
  "<li><code>packages/contracts/src/meeting.ts</code> 1 282 —— 会议契约 + Lead registry</li>"
  "<li><code>apps/brain/src/meeting.ts</code> 1 230 · <code>meeting-calendar.ts</code> 284 —— 会议编排</li>"
  "<li><code>metrics.ts</code> 293 —— Raya 自己的指标口径</li>"
  "<li><code>secret-isolation.ts</code> + <code>codex-sandbox-probe.ts</code> 112 —— 与 broker/confinement <b>不是同一件事</b>,且生产 full-access profile 下壳里没有等价物</li>"
  "<li><code>lead-ask.ts</code> 68 + <code>controller.ts</code> 的 ask 生命周期约 400 —— 壳当前<b>没有</b>主动提问闭环</li>"
  "<li><code>voice-mode.ts</code> 的语音房编排段,691 中约 600</li>"
  "</ul>"
  "算式:1 282 + 1 230 + 293 + 284 + 112 + (68 + 约 400) + 约 600 ≈ 4 270;再加 13 683 ≈ 17 950。"))
w(card("purple","既不能简单删、也不能原样留 —— 四个取舍点(需要 founder 定)",
  "<ul>"
  "<li><b>launchd.ts(73)+ installer.ts(60)</b>:<code>installer.ts:24</code> 生成 brain job、<code>:30</code> 生成 <b>voice</b> job,"
  "<code>launchd.ts</code> 是两者共用的 plist renderer。只要 <code>apps/voice</code> 保留,这两个文件就不能整文件删。</li>"
  "<li><b>config.ts(380)</b>:同时供应文字、会议、语音三块配置,只有文字那部分与壳的 env 约定重叠。</li>"
  "<li><b>store.ts(194)</b>:只有 <code>thread.json</code> 那部分有壳侧对应物,而且对应的<b>不是 LeadJournal</b> —— "
  "是壳里独立的 thread-id 文件(<code>codex-lead-runtime.ts:891 / :1140 / :1149</code>)。ask 状态与事件账本壳里没有。</li>"
  "<li><b>Lead 名册</b>:两份数据,后者多 4 个字段。合一会丢字段,不合一会继续漂移。</li>"
  "</ul>"))
w('<h3>G.3 语音(apps/voice)能不能同样通用化</h3>')
w(card("red","结论:按现状不能,阻碍是结构性的,不是配置",""))
w(card("amber","① Codex Lead 壳里没有任何实时音频协议",
  "全目录 grep <code>realtime</code> / <code>appendAudio</code> / <code>@discordjs/voice</code> <b>零命中</b>。"
  "壳封装的 RPC 是 <code>thread/start</code>、<code>thread/resume</code>、<code>turn/start</code>、<code>thread/read</code>,"
  "另外还封装了 <code>turn/steer</code> 但<b>全目录没有调用方</b> —— 准确说法是「当前接线未使用 turn/steer」,不是「壳只有四个方法」。",
  ["CodexLeadProcess.ts:372,380,415 / :427-428","CodexTurnExecutor.ts:195","LeadInputRouter.ts:21"]))
w(card("amber","② 壳的入站载荷是「文本 + 附件清单」,没有音频通道",
  "统一信箱的信封是 <code>normalizeChatDeliveryEnvelope({ v:1, … text, attachments })</code>。",
  ["discord-chat-ingest.ts:97-110"]))
w(card("amber","③ 壳是「一问一答、一次一个 active turn」,语音是「连续会话 + 随时抢话」",
  "壳的 <code>awaitCompletion(turnId)</code> 要求 turnId 匹配当前 active turn,否则抛错;"
  "语音要在生成途中清 downlink 队列、估算 founder 听到了哪儿、并压制最长 11 秒。",
  ["CodexTurnExecutor.awaitCompletion","runtime.ts:980-1063","Downlink.ts:12 SUPPRESSION_MAX_MS=11000"]))
w(card("amber","④ flywheel 已经有另一套语音栈,而且它<b>也有实时能力</b> —— 但走的是 Gemini Live",
  "<code>packages/voice-bridge</code> + <code>voice-core</code> + <code>voice-headphone</code>:"
  "<b>90 个非测试 .ts / 20 319 行</b>(若再排除两个 9 行的 <code>vitest.config.ts</code> 则 88 / 20 301),"
  "依赖 <code>@discordjs/voice 0.19.2</code> + <code>prism-media 1.3.5</code>。"
  "它的实时走 <b>Gemini Live</b>:<code>genaiConnector.ts</code> 用 <code>sendRealtimeInput</code> 发实时 PCM / 文字 / <code>audioStreamEnd</code>。"
  "所以「不是 Codex thread/realtime 那条协议」是对的,但不能写成「它没有 realtime」。",
  ["voice-bridge/package.json:23,29","voice-core/src/backends/gemini/genaiConnector.ts","最近改动 56e1d899a(2026-08-30)"]))
w(card("amber","⑤ 语音的侧通道方向与壳相反,而且一端是断的",
  "壳的侧通道是「Bridge → Lead」(事件、门);语音的 <code>relay_to_lead</code> 是「Lead → 别的 Lead」,"
  "而回流口 <code>voice-inbox</code> 没有生产写入方。"))
w(card("blue","哪些面在结构上是可分离的(只描述边界,不给方案)",
  "<ul>"
  "<li>语音的<b>文字侧通道</b> —— voice-inbox 的入、relay_to_lead 的出、ship 审批的 HTTP —— 载荷都是文本,"
  "与音频主链之间只有函数调用耦合(<code>InboxReader</code> / <code>OutboxWatcher</code> / <code>ApprovalClient</code> 各自独立于 <code>RealtimeTransport</code>)。</li>"
  "<li>语音的<b>音频主链</b>(DiscordAdapter → Uplink → SileroVad → RealtimeTransport → Downlink)在 Codex Lead 壳里<b>没有任何对应物</b>;"
  "flywheel 侧唯一的对应能力在 voice-bridge/voice-core,但那是 Gemini Live 协议,与 Raya 的 Codex realtime 不是同一条。</li>"
  "</ul>"))

# ---------------- E ----------------
w(commentbox('g', 'G · 统一化实证'))
w('<h2>E · 与 founder 期望的差距</h2>')
w(card("navy","founder 的期望(2026-09-08 02:48–03:03Z,FLY-2379 thread)",
  "① 所有 Lead 的 Discord 入站都<b>先进 Bridge</b>,再由 Bridge 进大脑;"
  "② Codex Lead(含 Raya)的文字与语音通路应<b>完全同构</b>,不给 Raya 特殊待遇。<br>"
  "以下逐条对照现状。<b>只陈述差距,不提方案。</b>"))
GAPS = [
 ("G1","入站第一跳没有一条是 Bridge",
  "Claude Lead 的网关在 Lead 自己的 Claude 会话里;Codex Lead 的轮询在 Lead 自己的 launchd 守护进程里;"
  "Raya 文字的网关在 brain 进程里;Raya 语音的 <code>@discordjs/voice</code> 在 voice 进程里。"
  "<b>四条通路各自持有一份 bot token,四个进程各自直连 Discord。</b>",
  ["server.ts:1793","codex-lead-tui-runtime.ts:665","voice-mode.ts:632-643","DiscordAdapter.ts:174-183"]),
 ("G2","Bridge 只在「comm.db → 大脑」这一段必经,而且只对 A/B 成立",
  "这一段没有替代路径。但写进 comm.db 那一步 Bridge 不参与(两边都直接打开 sqlite 文件);"
  "A 还有一条 legacy fail-open 车道整条都不经过 Bridge;C、D 连 comm.db 都没有。",
  ["lead-inbox-loop.ts:29-30 / :444 / :467","discord-chat-ingest.ts:77"]),
 ("G3","Bridge 唯一的入站 HTTP 触点是一个可丢弃的门铃,而且只有 A 会敲",
  "注释就是判据;没配 <code>BRIDGE_URL</code> 直接 return,消息照样送达。B 走进程内库调用,连这个门铃的调用点都没有。",
  ["lead-inbox-nudge.ts:34-36 / :41-42"]),
 ("G4","出站基本不经过 Bridge,而且守卫可 fail-open",
  "Claude Lead 问一次守卫但 404/env 缺失都放行;Codex Lead 生产默认 <code>direct</code>,启动脚本自己写着「绕开 Bridge 出站授权」;"
  "Raya 两条都直发 REST。<b>当前生产配置下</b>,经 Bridge 的出站只剩 issue thread 一条,而它靠提示词引导,不是强制环节。",
  ["server.ts:370 / :391","run-codex-lead-mufasa-tui-fullaccess.sh:101-104","tools.ts:711","CodexOutboundSender.ts:180"]),
 ("G5","Claude 与 Codex 的投递机制本来就不同构,而且是设计如此",
  "注释把两者写成两种消费语义;而且 Bridge <b>不能</b>直接改 Codex 的 journal.db,所以必须走 socket。",
  ["lead-delivery-adapter.ts:29-31","CodexLeadInboxSocket.ts:4-7"]),
 ("G6","Raya 的两条通路与 A/B 都不同构,差异是结构性的",
  "无 comm.db、无 Bridge、无 LeadInboxLoop、无 mailbox-batch;「问 Lead」是另一套协议;Lead 名册重复了一份;守护进程是另一套安装器。"
  "⚠️ 注意:D 的 voice inbox <b>自己有一套 ack</b>(<code>acks.jsonl</code>),只是与 A/B 的 mailbox-batch ack 互不相通、语义也不同。",
  ["lead-ask.ts:44","meeting.ts:431-436","installer.ts:24","voice-inbox.ts:228-235"]),
 ("G7","Raya 语音的「收」侧通道在生产是断的;「发」侧存在但是 opt-out 语义",
  "收:InboxReader 完整实现,但生产写入方不存在,生产盘上目录都没有。"
  "发:「Raya 主动向别的 Lead 转达一句话」只有 <code>relay_to_lead</code> 一条,且是「founder 不反对就发」,"
  "而她<b>念给 founder 听的那句话却说「确认后我会真的把消息发给对方」</b>。审批端点在生产 env 里不存在。",
  ["ReadbackGate.ts:94 / :291-295","FLY-2031 plan.md:399"]),
 ("G8","Codex Lead 这条通路当时不在运行(运行时观察,非代码结论)",
  "2026-09-08T03:13Z:两个 Codex Lead 的 launchd PID 均为 <code>-</code>、last exit <code>3</code>;"
  "<code>pgrep -f codex-lead-tui-runtime</code> 无结果。这不改变 B 段的代码事实,但意味着当时没有活体在跑。",[]),
 ("G9","Claude Lead 入站存在一条完全绕开 comm.db 与 Bridge 的 fail-open 车道",
  "三个 env 缺失时消息被直推模型,只在 stderr 打一行。<b>这条车道开没开,在任何 Discord 侧可见的信号里都看不出来。</b>",
  ["server.ts:1768-1782","server.ts:109-112"]),
]
for gid,title,body,refs in GAPS:
    w(card("red", f"{gid} · {title}", body, refs))
w('<h3>一览</h3>')
for k,v,b in [
 ("Discord 入站<b>第一跳</b>先进 Bridge","四条通路的第一跳都在各自的大脑侧进程,各持一份 bot token","A ✗ / B ✗ / C ✗ / D ✗"),
 ("Bridge 再进大脑","A、B 的「comm.db → 大脑」这一段必经 Bridge(A 的 legacy fail-open 车道除外)","A ◐ / B ◐ / C ✗ / D ✗"),
 ("出站经 Bridge","仅 issue thread 一条可选路径,靠提示词引导","A ◐ / B ✗ / C ✗ / D ✗"),
 ("Codex Lead 与 Claude Lead 同构","入站 / 投递 / 出站三段都不同构(设计如此)","不符合"),
 ("Raya 与 Codex Lead 同构","结构性不同构:无信箱、无 Bridge、自有名册、自有问 Lead 协议、自有守护进程","不符合"),
 ("Raya 会议中可与他人交流","收侧无生产写入方;发侧仅单向,且是「不反对即发」而非明确确认","不具备闭环"),
]:
    w(card("amber", k, v + ' &nbsp;— <b>' + b + '</b>'))

w(commentbox('e', 'E · 与 founder 期望的差距'))
w('<footer>'
  '<p><span class="k">取证锚点(供独立复核)</span></p>'
  '<p>flywheel 主仓:worktree <code>flywheel-FLY-2439</code>,基线 main <code>790355137</code> · '
  'Discord 插件:<code>~/.claude/plugins/cache/flywheel-plugins/discord/<b>0.0.6</b>/</code>(本机实际运行的字节,非 fork main) · '
  'Claude Code 二进制:<code>claude 2.1.263</code> · '
  'raya 语音:raya main <code>b1b5a64</code> 的 blob · '
  'raya 文字:PR <b>#26</b> 分支 <code>fly-2379-raya-text-chat</code>,HEAD <code>34c8794</code> · '
  'raya 生产 checkout <code>~/.flywheel/raya/code</code> 只读未改动 · '
  '运行时观察时刻 <code>2026-09-08T03:13Z</code>。</p>'
  '<p>所有行号用 <code>grep -n</code> / <code>sed -n</code> 在上述锚点上取过。'
  '共 <b>7 轮 Codex xhigh 设计评审</b>,逐条复算行号,发现并修正了 9 处引用偏移、1 处语义反向错误(语音复述门)、'
  '多处结论口径过宽与漏跳;第 7 轮 APPROVED。<b>零代码改动。</b></p>'
  '<p>完整逐箭头账本:<code>engineering/doc/FLY-2439-lead-paths-uml/research.md</code>;'
  'mermaid 源码:<code>engineering/doc/FLY-2439-lead-paths-uml/diagrams/*.mmd</code>。</p>'
  '</footer>')
# ---------- 评论条 + 脚本(CSP nonce 由 publish-report 替换) ----------
w('<div class="cbar">'
  '<button id="copy-all" type="button">复制全部评论</button>'
  '<button id="clear-all" type="button" class="ghost">清空</button>'
  '<span class="st" id="cbar-st">评论只存在你这台设备的浏览器里 · 不会上传</span>'
  '</div>')
w('</div>')

SCRIPT = r'''
(function () {
  var KEY = 'fly2439-comments-v1';
  var boxes = Array.prototype.slice.call(document.querySelectorAll('textarea[data-sec]'));
  var st = document.getElementById('cbar-st');

  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
  }
  function write(o) {
    try { localStorage.setItem(KEY, JSON.stringify(o)); return true; }
    catch (e) { return false; }
  }
  function stamp(el, text) {
    var n = document.getElementById('s-' + el.dataset.sec);
    if (n) n.textContent = text;
  }

  // 载入已存的内容
  var saved = read();
  boxes.forEach(function (b) {
    if (saved[b.dataset.sec]) {
      b.value = saved[b.dataset.sec];
      stamp(b, '已恢复上次输入');
    }
  });

  // 输入即存(防抖 400ms)
  var timers = {};
  boxes.forEach(function (b) {
    b.addEventListener('input', function () {
      clearTimeout(timers[b.dataset.sec]);
      timers[b.dataset.sec] = setTimeout(function () {
        var o = read();
        if (b.value.trim()) { o[b.dataset.sec] = b.value; } else { delete o[b.dataset.sec]; }
        stamp(b, write(o) ? ('已保存 · ' + new Date().toLocaleTimeString()) :
                            '⚠️ 这个浏览器不让存(无痕模式?)—— 请自己先复制走');
      }, 400);
    });
  });

  function collect() {
    var out = ['# FLY-2439 通路现状 —— 评论', ''];
    var any = false;
    boxes.forEach(function (b) {
      if (b.value.trim()) {
        any = true;
        out.push('## ' + b.dataset.label, '', b.value.trim(), '');
      }
    });
    return any ? out.join('\n') : '';
  }

  document.getElementById('copy-all').addEventListener('click', function () {
    var text = collect();
    if (!text) { st.textContent = '还没有写任何评论'; return; }
    function reveal() {
      // 复制不了就把汇总文本摊开、全选好,让人自己 Cmd+C —— 绝不让人白点一下
      var box = document.getElementById('copy-out');
      if (!box) {
        box = document.createElement('textarea');
        box.id = 'copy-out';
        box.className = 'copyout';
        box.setAttribute('readonly', '');
        document.querySelector('.cbar').insertAdjacentElement('beforebegin', box);
      }
      box.value = text;
      box.hidden = false;
      box.focus();
      box.select();
      st.textContent = '这个浏览器不让脚本写剪贴板 —— 文本已摊在上面并全选好,按 Cmd/Ctrl+C';
    }
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) { st.textContent = '已复制到剪贴板 ✅ 直接粘给 Tadashi 或发在 thread 里'; }
      else { reveal(); }
    }
    // clipboard API 在没有焦点/没有权限时可能既不 resolve 也不 reject,
    // 所以加一个 1s 兜底计时器,保证按钮永远给出反馈。
    var settled = false;
    function done(msg) { if (settled) return; settled = true; st.textContent = msg; }
    function runFallback() { if (settled) return; settled = true; fallback(); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      setTimeout(runFallback, 1000);
      navigator.clipboard.writeText(text).then(function () {
        done('已复制到剪贴板 ✅ 直接粘给 Tadashi 或发在 thread 里');
      }, runFallback);
    } else { runFallback(); }
  });

  document.getElementById('clear-all').addEventListener('click', function () {
    var out = document.getElementById('copy-out');
    if (out) out.hidden = true;
    if (!collect()) { st.textContent = '本来就是空的'; return; }
    if (!window.confirm('清空所有评论?这一步不能撤销。')) return;
    boxes.forEach(function (b) { b.value = ''; stamp(b, ''); });
    write({});
    st.textContent = '已清空';
  });
})();
'''
w('<script nonce="__CSP_NONCE__">' + SCRIPT + '</script>')
w('</body>\n</html>\n')
open('lead-paths.html','w',encoding='utf-8').write(out.getvalue())
print("HTML bytes:", len(out.getvalue()))
