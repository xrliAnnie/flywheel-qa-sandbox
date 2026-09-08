# -*- coding: utf-8 -*-
"""FLY-2439 v3 回答页:逐条回答 founder R1 评论。每个小问题一个评论框。"""
import os, io, html, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
D = "diagrams"

def svg(name):
    s = open(os.path.join(D, name + ".svg"), encoding="utf-8").read()
    return s[s.find("<svg"):]

CSS = """
*{box-sizing:border-box}
body{margin:0;overflow-x:hidden;background:#f5f5f7;color:#1d1d1f;
font:16px/1.68 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,"PingFang SC","Hiragino Sans GB",sans-serif;-webkit-text-size-adjust:100%}
.wrap{max-width:960px;margin:0 auto;padding:26px 16px 40px;min-width:0}
h1{overflow-wrap:anywhere;font-size:26px;line-height:1.32;margin:0 0 6px;letter-spacing:-.4px}
h2{font-size:21px;margin:40px 0 8px;letter-spacing:-.2px;padding-top:14px;border-top:1px solid #e3e3e6}
h3{font-size:16.5px;margin:22px 0 6px}
p{margin:9px 0}
.sub{color:#86868b;font-size:14px;margin:0 0 20px}
.quote{background:#fff;border-left:4px solid #86868b;border-radius:0 12px 12px 0;
box-shadow:0 1px 3px rgba(0,0,0,.06);padding:12px 15px;margin:12px 0;font-size:14.5px;color:#3a3a3c}
.quote b{color:#1d1d1f}
.q{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:15px 16px;margin:16px 0 0;
border-left:4px solid #1a365d;max-width:100%;overflow-wrap:anywhere}
.q .qid{font:700 12px 'SF Mono',ui-monospace,monospace;color:#fff;background:#1a365d;border-radius:5px;padding:2px 7px;margin-right:7px}
.q .qt{font-weight:600;font-size:15.5px}
.verdict{display:inline-block;font-size:12.5px;font-weight:700;border-radius:999px;padding:3px 11px;margin:9px 0 2px}
.v-yes{background:#e2f7e8;color:#1f7a37}.v-no{background:#ffe5e3;color:#c1271c}
.v-part{background:#fff2dc;color:#a35c00}.v-info{background:#e6f0ff;color:#0b4fa8}
.fact{background:#f3f8f4;border:1px solid #d6ece0;border-radius:10px;padding:11px 13px;margin:9px 0;font-size:14.5px}
.fact::before{content:"现状 · 已验证";display:block;font-size:11.5px;font-weight:700;color:#1f7a37;letter-spacing:.4px;margin-bottom:5px}
.prop{background:#faf5ff;border:1px dashed #d9c2f0;border-radius:10px;padding:11px 13px;margin:9px 0;font-size:14.5px}
.prop::before{content:"建议 / 设计 · 未验证 · 待你拍";display:block;font-size:11.5px;font-weight:700;color:#7226b5;letter-spacing:.4px;margin-bottom:5px}
.ref{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:12px;color:#1a365d;background:#eef1f7;
border-radius:5px;padding:1px 6px;display:inline-block;margin:4px 4px 0 0;word-break:break-all}
ul{margin:7px 0;padding-left:19px}li{margin:5px 0;font-size:14.5px}
.fig{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:12px;margin:14px 0;min-width:0;
position:relative;left:50%;transform:translateX(-50%);width:min(calc(100vw - 24px),1520px)}
.fig .cap{font-size:13px;color:#86868b;margin:0 0 8px}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%}
.scroll svg{width:100%;height:auto;display:block;max-width:none;min-width:1000px}
.hint{font-size:12.5px;color:#86868b;margin-top:6px}
details.old{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:12px 15px;margin:14px 0}
details.old summary{cursor:pointer;font-weight:600;font-size:14.5px;color:#1a365d}
.cbox{background:#fff;border-radius:0 0 12px 12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:11px 14px 13px;
margin:0 0 4px;border-left:4px solid #af52de}
.cbox label{display:block;font-size:12.5px;font-weight:600;color:#7226b5;margin-bottom:5px}
.cbox textarea{width:100%;min-height:64px;resize:vertical;border:1px solid #dcdce0;border-radius:8px;padding:8px 10px;
font:14.5px/1.55 -apple-system,system-ui,"PingFang SC",sans-serif;color:#1d1d1f;background:#fbfbfd}
.cbox textarea:focus{outline:none;border-color:#af52de;background:#fff}
.cbox .saved{font-size:11.5px;color:#86868b;margin-top:4px;min-height:15px}
.copyout{width:100%;min-height:150px;margin:14px 0 0;border:1px solid #af52de;border-radius:10px;padding:10px;
font:12.5px/1.55 'SF Mono',ui-monospace,Menlo,monospace;background:#fff;color:#1d1d1f}
.cbar{position:sticky;bottom:0;background:rgba(245,245,247,.95);backdrop-filter:saturate(180%) blur(12px);
border-top:1px solid #e3e3e6;padding:10px 16px;margin:30px -16px 0;display:flex;gap:9px;align-items:center;flex-wrap:wrap}
.cbar button{font:600 14px -apple-system,system-ui,sans-serif;color:#fff;background:#007aff;border:0;
border-radius:999px;padding:9px 17px;cursor:pointer}
.cbar button.ghost{background:#e8e8ed;color:#1d1d1f}
.cbar .st{font-size:12.5px;color:#86868b}
footer{margin-top:36px;font-size:12.5px;color:#86868b}
@media(max-width:600px){h1{font-size:22px}.wrap{padding:20px 12px 30px}.cbar{margin-left:-12px;margin-right:-12px;padding:10px 12px}}
"""

SECTIONS = []
out = io.StringIO(); w = out.write

def refs(items):
    return "".join(f'<span class="ref">{html.escape(x)}</span>' for x in items)

def cbox(qid, label):
    SECTIONS.append((qid, label))
    return (f'<div class="cbox"><label for="c-{qid}">✍️ 对 {qid} 的回馈</label>'
            f'<textarea id="c-{qid}" data-sec="{qid}" data-label="{html.escape(label)}" '
            f'placeholder="这条答得对不对?哪里还没说清?"></textarea>'
            f'<div class="saved" id="s-{qid}"></div></div>')

def q(qid, title, verdict, vclass, blocks, label=None):
    w(f'<div class="q"><div><span class="qid">{qid}</span><span class="qt">{title}</span></div>')
    w(f'<div class="verdict {vclass}">{verdict}</div>')
    for b in blocks: w(b)
    w('</div>')
    w(cbox(qid, label or f'{qid} {title}'))

def fact(body, rs=()):  return f'<div class="fact">{body}{refs(rs)}</div>'
def prop(body, rs=()):  return f'<div class="prop">{body}{refs(rs)}</div>'
def fig(name, cap):
    return (f'<div class="fig"><p class="cap">{cap}</p><div class="scroll">{svg(name)}</div>'
            f'<p class="hint">图较宽时可左右滑动。</p></div>')
def old(name, cap):
    return (f'<details class="old"><summary>展开 v2 的{cap}</summary>'
            f'<div class="scroll" style="margin-top:10px">{svg(name)}</div></details>')

w('<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
  '<title>FLY-2439 回答页 v3 — 逐条答你的四段评论</title>\n')
w(f'<style>{CSS}</style>\n</head>\n<body>\n<div class="wrap">')

w('<h1>逐条回答你的四段评论</h1>')
w('<p class="sub">FLY-2439 v3 · 2026-09-08 · 每个小问题下面各有一个评论框<br>'
  '<b style="color:#1f7a37">绿底 = 现状,代码里查得到,带 file:line</b> · '
  '<b style="color:#7226b5">紫底虚线 = 建议/设计,还没实现,等你拍</b></p>')

# ============ A ============
w('<h2>A · Claude Lead</h2>')
w('<div class="quote">你原话:「这个<b>适配器</b>和<b>本地 spawn</b> 是什么东西?…… 1. 我的 message 发进来,进到这个 thread ingest 子进程。'
  '2. 这相当于我的信息发进来,并不会直接发给 lead,对不对?3. 它其实还是进那个 mailbox,mailbox 以一定的 batch 投向那个 lead 的 mailbox,'
  '然后 lead 在那里去读。这个是我的理解,对吧?」</div>')

q('A1', '「适配器」和「本地 spawn」到底是什么', '两个都是进程,不是抽象概念', 'v-info', [
  fact('<b>适配器</b> = 一个 <code>bun</code> 跑的小程序(<code>server.ts</code>),它握着 Discord 的网关 websocket。'
       '关键点:它<b>跑在 Lead 自己的 Claude 会话里</b>,是 <code>claude</code> 进程的直接子进程 —— 不是 Bridge 的一部分。<br>'
       '启动链是:launchd → <code>lead-body.sh</code> → <code>claude ...</code> → 它按 <code>.mcp.json</code> 把适配器拉起来,'
       '适配器 <code>exec</code> 掉自己好让自己成为 claude 的直接子进程(这样 claude 一死它也死,不会变孤儿)。',
       ['packages/teamlead/scripts/lead-body.sh', 'claude-lead.sh:2559',
        '插件 0.0.6 .mcp.json', 'start-adapter.sh:44', 'server.ts:494 / :1593']),
  fact('<b>「本地 spool」</b>(图里那个圆桶,不是 spawn)= 适配器在本机磁盘上的一个小暂存目录。'
       '它先把「这条消息我要入库」这个意图原子写进去,再去调 CLI;调失败了还能按退避重放,所以适配器崩了消息也不丢。<br>'
       '<b>而 spawn</b> 指的是下一步:适配器<b>另起一个 node 子进程</b>跑 <code>flywheel-comm chat-ingest</code>,'
       '正文走 stdin 传进去。',
       ['chat-receipt-runtime.ts:92-94', ':106,116-118', ':135', ':266-274', ':349']),
])

q('A2', '你的第 1 点:消息先进 ingest 子进程', '对', 'v-yes', [
  fact('顺序是:Discord 网关 → 适配器 → 先落本地 spool → 再 spawn <code>chat-ingest</code> 子进程。'
       '你说的「thread ingest 子进程」就是这个 <code>chat-ingest</code>。',
       ['server.ts:1593', 'chat-receipt-runtime.ts:106,116-118', ':266-274']),
])

q('A3', '你的第 2 点:不会直接发给 lead', '对 —— 但有一个例外,你需要知道', 'v-part', [
  fact('正常情况下<b>不会</b>直接给 Lead。适配器把消息写进 comm.db 就返回了,不碰模型。',
       ['discord-chat-ingest.ts:114', ':127', 'mailbox-schema.ts:193']),
  fact('🔴 <b>例外:有一条 fail-open 旁路。</b> 如果 <code>FLYWHEEL_COMM_CLI</code> / <code>FLYWHEEL_COMM_DB</code> / '
       '<code>FLYWHEEL_LEAD_ID</code> 这三个环境变量缺了任何一个,适配器就<b>直接把消息推进会话</b> —— '
       '不进 comm.db、不经 Bridge。而且这条旁路开没开,<b>在 Discord 这边一点都看不出来</b>,只在 stderr 打一行日志。',
       ['server.ts:1750-1753', ':1768-1782', ':109-112', 'chat-receipt-recorder.ts:87-116']),
])

q('A4', '你的第 3 点:进 mailbox,再按 batch 投给 lead,lead 在那里读', '对,而且「lead 的 mailbox」就是一个 JSON 文件', 'v-yes', [
  fact('三段都对。补两个具体的东西:<br>'
       '① 中间那个「按 batch 投递」的是 <b>Bridge 里的 LeadInboxLoop</b>,活跃时 1 秒轮询一次、空闲 30 秒,'
       '认领若干条拼成一个 <code>[mailbox-batch …]</code> 头;<br>'
       '② 「lead 的 mailbox」对 Claude Lead 来说就是磁盘上一个 JSON 数组文件 '
       '<code>~/.claude/teams/&lt;lead&gt;/inboxes/&lt;lead&gt;.json</code>,'
       '写的时候两阶段(先写 <code>.flywheel.jsonl</code> 边车记成员,再在文件锁里原子换掉主文件);<br>'
       '③ 「lead 在那里去读」——读的不是我们的代码,是 <b>Claude Code 二进制自带的 poller</b>,'
       '它把未读的一批打包成会话里的一条消息。',
       ['lead-inbox-loop.ts:29-30', ':444', ':467', 'lead-delivery-adapter.ts:56 / :75',
        'path-helpers.ts:116', 'ClaudeMailboxCodec.ts:273 / :283 / :290', 'ClaudeCodeAdapter.ts:11']),
])
w(old('a-sequence', 'A 时序图(消息从你到回复)'))

# ============ B ============
w('<h2>B · Codex Lead</h2>')
w('<div class="quote">你原话:「你们说叫做这个 <b>kodiak-cli</b> 不是 Bridge 的一部分,你专门提出来反而让我觉得有点奇怪。'
  '我本来以为像 Claude Code 它也不是 Bridge 的一部分…… 那是指它和 Claude 是不一样的吗?'
  '为什么 Claude 的链路比较简单,就经过 commdb mailbox 就没有其他 database 了?但 Codex 这里还有一个 <b>journal DB</b>。'
  '为什么 Codex 的线路如此复杂?我们可以把 Codex 的线路也做得比较简单吗?」</div>')

q('B1', '先纠一个名字:仓库里没有 kodiak-cli', '没有这个东西', 'v-no', [
  fact('我全仓 grep 过 <code>kodiak</code>,<b>零命中</b>。你说的应该是 <b>Codex CLI</b>('
       '那个 <code>codex</code> 可执行文件),或者是我 v2 里说的「Codex Lead 守护进程」。下面我按后者答。'),
  fact('<b>而且你的直觉是对的:我那句「不是 Bridge 的一部分」说得不好。</b> Claude Lead 也不是 Bridge 的一部分 —— '
       '两边都是<b>各自独立的进程</b>,Bridge 只负责把信投过去。这一点上两者<b>没有</b>区别,我不该单独强调它。<br>'
       '真正的区别在<b>「谁去 Discord 取信」</b>:Claude Lead 那边取信的适配器住在 claude 会话里;'
       'Codex Lead 那边取信的轮询器住在它自己的 launchd 守护进程里。两边都不在 Bridge 里。',
       ['claude-lead.sh:2559', 'start-adapter.sh:44',
        'codex-lead-tui-runtime.ts:665', 'run-codex-lead-mufasa-tui-fullaccess.sh:36 / :140']),
])

q('B2', '为什么 Claude 只有 mailbox,Codex 多一个 journal DB', 'Claude 其实也有第二层,只是它是文件不是 DB', 'v-part', [
  fact('<b>Claude 侧也有第二层记账</b>,你之所以觉得它简单,是因为那一层不是 sqlite 而是一个边车文件:'
       '写 batch 是两阶段的 —— 先把成员名单写进 <code>&lt;inbox&gt;.flywheel.jsonl</code>,'
       '再在文件锁里原子替换主 JSON,最后 finalize 边车。它干的事和 journal 的「幂等入账」是同一类。',
       ['ClaudeMailboxCodec.ts:268', ':273', ':283', ':290']),
  fact('<b>Codex 侧那一层之所以更重,原因写在代码注释里,而且不是「没设计好」:</b><br>'
       '<div style="background:#fff;border-radius:8px;padding:9px 11px;margin:7px 0;font-size:13.5px;color:#3a3a3c">'
       'a Codex app-server thread can execute arbitrary shell/MCP side-effects (gh merge, flywheel-comm). '
       'On a crash, naively replaying an input could double-fire those side-effects.</div>'
       '也就是:Codex Lead 的一个 turn 可能真的去 <code>gh merge</code> 了。崩溃后如果盲目重放,'
       '就会<b>把合并干两遍</b>。journal 存的是「这条输入到底走到哪一步了」,让恢复时能<b>证明</b>该不该重跑,'
       '而不是猜。它明确<b>不</b>保证工具调用 exactly-once,只保证:入账幂等、'
       '<code>turn/start</code> 之前先落 <code>dispatching</code> 标记、'
       '只有 <code>accepted</code> 状态可以自动重派,<code>dispatching/dispatched</code> 一律走人工对账。',
       ['LeadJournal.ts:1-30', 'LeadInputRouter.ts:218', ':219-225', 'LeadJournal.ts:240 / :260']),
])

q('B3', 'Codex 的线路能不能做简单一点', '能砍一段,但有两段是 harness 逼的,砍不掉', 'v-part', [
  fact('<b>harness 逼的、砍不掉的两段:</b><br>'
       '① <b>投递方式不同。</b> Claude Code 二进制自带会话内 poller,我们写个文件它自己会读('
       '契约里叫 <code>builtin-receiver</code>);Codex 没有这个,必须由外部把包好的一轮塞进去('
       '叫 <code>external-watcher</code>)。这就是为什么 Claude 那头是「写文件」、Codex 那头是「走 unix socket」。<br>'
       '② <b>Bridge 改不了 Codex 的 journal。</b> Codex Lead 的 router 住在窗口化 TUI 那个进程里,'
       'Bridge 是另一个进程,注释原话:<i>The Bridge therefore cannot mutate journal.db directly</i>。'
       '所以必须有一条 socket 把批交过去,由拥有它的那个进程自己入账。',
       ['agent-team-transport/src/types.ts:308', 'lead-delivery-adapter.ts:29-31',
        'CodexLeadInboxSocket.ts:4-7', ':64', ':202']),
  fact('<b>可以砍、而且和 harness 无关的一段:出站。</b> 现在 Codex Lead 生产默认走 <code>direct</code> —— '
       '守护进程拿自己的 bot token 直发 Discord,启动脚本自己写着 <i>bypasses Bridge outbound authorization</i>。'
       '代码里其实<b>已经有</b>一条经 Bridge 的出站(<code>POST /api/lead-outbound/send</code>),只是没有任何 launcher 打开它。'
       '这一段是配置选择,不是 harness 限制。',
       ['run-codex-lead-mufasa-tui-fullaccess.sh:101-104', 'DirectDiscordOutboundSender.ts:57',
        'CodexOutboundSender.ts:180']),
  prop('<b>如果要「简化 Codex 链路」,我的读法是这样分三类(未验证,等你拍):</b>'
       '<ul>'
       '<li><b>不能砍</b> —— socket 投递 + journal 入账。砍了会丢的是「崩溃后能证明该不该重跑」,'
       '代价是可能把 <code>gh merge</code> 这类动作干两遍。</li>'
       '<li><b>可以统一</b> —— 出站改成和 Claude 一样经 Bridge(把 <code>FLYWHEEL_CODEX_LEAD_OUTBOUND</code> 打到 <code>bridge</code>)。'
       '这条不用写新代码,是开关。</li>'
       '<li><b>可以统一</b> —— 入站取信这一段两边形状不同(Claude 网关 websocket / Codex 3 秒 REST 轮询),'
       '但它们都只是「把新消息写进 comm.db」,原则上可以收敛成一份。</li>'
       '</ul>'
       '我没有验证过砍完之后系统还能跑 —— 这需要真做一遍才知道。'),
])
w(old('b-component', 'B 组件图(Codex Lead 现状链路)'))

# ============ C ============
w('<h2>C · Raya 文字</h2>')
w('<div class="quote">你原话:「Raya 看起来完全是和其他 Codex Lead 不一样的进程,甚至都没有进 Mailbox。'
  '为什么我们要给 Raya 搞特殊呢?…… 我希望所有 Codex Lead 用的信息连接模式都是统一的,大家做一套通用的方案即可。'
  '…… 比如信件都是先投到 Mailbox,然后再 batch 投到 Claude Code 或 Codex,'
  '只是投递过程中因为 Harness 不同会有一些区别,大概是这个样子」</div>')

q('C1', 'Raya 为什么单独一套', '不是设计决定,是历史长出来的', 'v-info', [
  fact('如实说,没有粉饰:<br>'
       '① Raya <b>住在另一个 git 仓</b> —— <code>xrliAnnie/raya</code>,不在 flywheel 主仓里;<br>'
       '② 她有<b>自己的守护进程和安装器</b> —— <code>com.xrli.raya.brain</code> / <code>com.xrli.raya.voice</code>,'
       '由 raya 仓自己的 <code>installer.ts</code> 装,和 flywheel 的 <code>com.flywheel.lead.*</code> 是两套;<br>'
       '③ 她<b>自己维护一份 Lead 名册</b> —— <code>&lt;stateDir&gt;/leads/&lt;id&gt;/profile.json</code>,生产盘上 14 份,'
       '和 <code>~/.flywheel/projects.json</code> 是两份可以各自漂移的数据;<br>'
       '④ 文字通路是<b>昨天(FLY-2379)才在她自己那套壳上补出来的</b>,PR #26 还没合。'
       '所以它自然长成了 raya 仓的形状,而不是 flywheel Codex Lead 壳的形状。',
       ['installer.ts:22-37', 'meeting.ts:431-436', 'raya PR #26 分支 fly-2379-raya-text-chat']),
  fact('结论上你看到的是对的:<b>Raya 文字这条路完全没有 comm.db、没有 Bridge。</b>'
       '我在 <code>apps/brain/src/</code> 全目录 grep 过 <code>9876</code> / <code>bridge</code> / '
       '<code>flywheel-comm</code> / <code>chat-ingest</code> —— <b>零命中</b>。'
       '入站是她自己的 discord.js 网关,出站是她自己的 REST,中间没有信箱。',
       ['voice-mode.ts:632-638 / :643', 'discord-rest.ts:38-41']),
])

q('C2', '你的主张:统一成「先进 Mailbox,再按 harness 投递」', '这个形状今天已经存在,而且 Raya 就差接上去', 'v-part', [
  fact('<b>你描述的形状不用新发明 —— Claude Lead 和 Codex Lead 现在就是这么跑的。</b>'
       '两边共用同一张 <code>mailbox</code> 表、同一个 <code>LeadInboxLoop</code> 泵、同一个投递适配器接口;'
       '分叉只发生在最后一跳:Claude 写 JSON 文件,Codex 走 unix socket。'
       '注释里那句话就是你说的意思:<i>Codex consumes one packaged turn; Claude writes members atomically…</i>',
       ['mailbox-schema.ts:193', 'lead-inbox-loop.ts:29-30 / :467',
        'lead-delivery-adapter.ts:29-31 / :56 / :92', 'lead-inbox-runtime.ts:1252-1270']),
  fact('<b>差在哪:Raya 没接进这个形状。</b> 她的入站直接进了自己的控制器,没有经过 mailbox 那一跳。'
       '所以「统一」对她来说不是重写大脑,是<b>把入站那一头改接到 comm.db</b>。',
       ['cli.ts:392-404', 'controller.ts:244']),
  prop('<b>统一之后 raya 仓的删 / 留(这是按对应关系做的归类推演,不是实施计划,没验证过可行性):</b>'
       '<ul>'
       '<li><b>壳里已有对应物、可以不自己写(≈890–1090 行)</b>:'
       '<code>codex-client.ts</code> 301 行 → 壳的 <code>CodexLeadProcess</code>;'
       '<code>discord-rest.ts</code> 96 行 → 壳的轮询器 + 出站器;'
       '<code>fallback.ts</code> 14 行(已经是死代码);'
       '<code>controller.ts</code> 里传输与轮次那部分约 400–600 行 → 壳的 Router + TurnExecutor。</li>'
       '<li><b>壳里没有、必须留(≈17950 行)</b>:'
       '<code>apps/voice/**</code> 单独就 13683 行;会议编排 <code>meeting.ts</code> 1230 + 契约 1282;'
       '她的指标 293;凭据读隔离硬门 112(壳在生产 full-access profile 下<b>没有</b>等价物);'
       '完整的「问 Lead」生命周期约 470(壳当前<b>没有</b>主动提问闭环)。</li>'
       '<li><b>要你拍的四个取舍点</b>:launchd/installer 同时生成 voice job,只要语音留着就不能整删;'
       '<code>config.ts</code> 同时供文字/会议/语音三块;<code>store.ts</code> 只有 thread 那部分有对应物;'
       'Lead 名册两份数据合一会丢 4 个字段,不合一会继续漂移。</li>'
       '</ul>'),
  prop('<b>「Raya 特有的东西能不能当插件挂在通用 Codex Lead 上」:</b>'
       '文字侧的答案偏乐观 —— 她和壳的差异集中在传输层,大脑那一层(<code>thread/start</code>、'
       '<code>thread/resume</code>、<code>turn/start</code>)两边调的是<b>同一组 JSON-RPC 方法</b>。'
       '语音侧的答案是否定的,见 D 段。这两句都是我的读法,没有实现验证。',
       ['CodexLeadProcess.ts:372,380,415', 'controller.ts:408,415,595']),
])
w(old('c-component', 'C 组件图(Raya 文字现状,标了「无 Bridge / 无 comm.db」)'))

# ============ D ============
w('<h2>D · Raya 语音</h2>')
w('<div class="quote">你原话:「假设 Raya 的文字部分已经写好了…… 这个时候我们如果要把语音加进来,'
  '它是用<b>同一个 Codex CLI</b>(文字和语音都在同一个 Codex CLI 上面),还是说必须要做两套才可以?」</div>')

q('D1', '今天的现状:文字和语音是不是同一个 Codex 会话', '不是。今天是两个进程、两个 codex、两个 thread', 'v-no', [
  fact('三个层面都是分开的:<br>'
       '① <b>两个 launchd job = 两个 OS 进程</b>:<code>com.xrli.raya.brain</code> 跑 <code>apps/brain/dist/cli.js</code>,'
       '<code>com.xrli.raya.voice</code> 跑 <code>apps/voice/dist/cli.js</code>;<br>'
       '② <b>各自 spawn 自己的 codex app-server 子进程</b>,而且<b>启动参数都不一样</b> —— '
       '文字是 <code>app-server --strict-config</code>,语音是 '
       '<code>--enable realtime_conversation app-server --strict-config</code>;<br>'
       '③ <b>各存各的 thread</b>:文字存 <code>thread.json</code>,语音存自己的 session 状态。',
       ['installer.ts:22-37', 'codex-client.ts:81-87 / :120',
        'AppServerClient.ts:91-98', 'voice config.ts:21-26', 'brain store.ts:110', 'voice store.ts:26']),
  fact('两边唯一共用的东西是 <code>RAYA_CODEX_HOME</code> 这一个环境变量(同一个 codex 家目录)。'
       '但<b>家目录相同不等于会话相同</b> —— 进程不同、thread 不同,'
       '所以<b>语音里说过的话,文字侧那个会话并不知道</b>。',
       ['brain config.ts:242', 'voice config.ts:345']),
])
w(fig('d-highlevel-now', '现状(已验证)—— 两个进程、两个 codex、两个 thread'))

q('D2', '往前看:一套 CLI 两个 I/O 适配器,还是两套', '技术上可以合成一套,但有一个具体的硬约束', 'v-part', [
  prop('<b>选项一:一个脑子,两个输入适配器。</b> 文字适配器把消息变成一轮 turn,'
       '语音适配器把音频接成 realtime 流,两者喂进<b>同一个 Codex 会话</b>。'
       '好处很直接:<b>只有一份上下文</b> —— 你在语音里交代的事,文字侧立刻就知道,不需要额外同步机制。'),
  fact('<b>但有一个已验证的硬约束:realtime 能力是在 spawn 那一刻由参数决定的。</b>'
       '语音那份 argv 里多一个 <code>--enable realtime_conversation</code>,文字那份没有。'
       '所以「合成一个会话」意味着<b>这个共享会话从一开始就得带 realtime 起</b>,'
       '不能等到要说话了再加。',
       ['voice config.ts:21-26', 'codex-client.ts:120']),
  prop('<b>选项二:维持两套(= 今天的形状)。</b> 好处是互不影响,语音崩了不影响文字;'
       '代价是<b>记忆天然分裂</b>,而且两套守护进程、两套配置要各自维护。'),
  prop('<b>我的读法(未验证,等你拍):</b>如果目标是「Raya 是一个人,不是两个」,那选项一才对得上;'
       '选项二怎么打补丁都还是两个脑子。但选项一要先解决三件事,我都没验证过:'
       '<ul><li>共享会话要常开 realtime,空闲时的成本和稳定性我没测过;</li>'
       '<li>抢话/超时语义要合一 —— 现在语音是整轮 300s/900s 会 <code>turn/interrupt</code>,'
       '壳那边 <code>awaitCompletion</code> 根本没有轮级超时,这两套语义得先统一;</li>'
       '<li>语音的音频主链(约 13683 行)在 Codex Lead 壳里<b>没有任何对应物</b>,合并不等于接口对齐。</li></ul>',
       ['controller.ts:617-619', 'CodexTurnExecutor.ts:177-188']),
])
w(fig('d-highlevel-opt', '两个选项的形状对照(紫色框内都是建议,未实现)'))

q('D3', '你说评论框太少', '这一版每个小问题下面都有一个', 'v-yes', [
  fact('这一页 A1–A4、B1–B3、C1–C2、D1–D3 每一条下面各有一个框,'
       '写完到页面底部点「复制全部评论」,会拼成带小标题的 markdown 进剪贴板。'
       '草稿存在你这台设备的浏览器里,不会上传,刷新也还在。'),
])

w('<h2>还没答的 / 我不知道的</h2>')
w(fact('说清楚边界,免得你把没验证的当成已验证:'
       '<ul>'
       '<li><b>「砍掉 Codex 那两段之后系统还跑不跑」我没验证。</b> 要真做一遍才知道。</li>'
       '<li><b>Raya 统一后的删/留行数是归类推演</b>,不是实施计划,也没验证可行性。</li>'
       '<li><b>共享 realtime 会话的成本和稳定性我没测过。</b></li>'
       '<li>Raya 文字侧「代码里不注入 MCP」只证明<b>代码</b>不注入;'
       '<code>RAYA_CODEX_HOME</code> 下的 <code>config.toml</code> 是否另配了 MCP,<b>未验证</b>。</li>'
       '<li>「Raya 语音查不到 Flywheel 状态」限定在 <code>apps/voice</code> 代码范围内,'
       '不排除 Codex 线程自身的 tool surface 能做别的事。</li>'
       '</ul>'))
w(cbox('X', '还没答的 / 其他'))

w('<div class="cbar">'
  '<button id="copy-all" type="button">复制全部评论</button>'
  '<button id="clear-all" type="button" class="ghost">清空</button>'
  '<span class="st" id="cbar-st">草稿只存在你这台设备的浏览器里 · 不会上传</span>'
  '</div>')

w('<footer><p>取证锚点:flywheel main <code>790355137</code> · Discord 插件 <code>0.0.6</code>(本机实际运行的字节)· '
  '<code>claude 2.1.263</code> · raya 语音 raya main <code>b1b5a64</code> 的 blob · '
  'raya 文字 PR <b>#26</b> HEAD <code>34c8794</code>。'
  '所有行号用 <code>grep -n</code> / <code>sed -n</code> 复核过。'
  '完整逐箭头账本在 <code>engineering/doc/FLY-2439-lead-paths-uml/research.md</code>;'
  'v2 那页(四张图 + 每条边的依据清单)仍然有效。</p></footer>')
w('</div>')

SCRIPT = r'''
(function () {
  var KEY = 'fly2439-v3-comments-v1';
  var boxes = Array.prototype.slice.call(document.querySelectorAll('textarea[data-sec]'));
  var st = document.getElementById('cbar-st');
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; } }
  function write(o) { try { localStorage.setItem(KEY, JSON.stringify(o)); return true; } catch (e) { return false; } }
  function stamp(el, t) { var n = document.getElementById('s-' + el.dataset.sec); if (n) n.textContent = t; }
  var saved = read();
  boxes.forEach(function (b) {
    if (saved[b.dataset.sec]) { b.value = saved[b.dataset.sec]; stamp(b, '已恢复上次输入'); }
  });
  var timers = {};
  boxes.forEach(function (b) {
    b.addEventListener('input', function () {
      clearTimeout(timers[b.dataset.sec]);
      timers[b.dataset.sec] = setTimeout(function () {
        var o = read();
        if (b.value.trim()) { o[b.dataset.sec] = b.value; } else { delete o[b.dataset.sec]; }
        stamp(b, write(o) ? ('已保存 · ' + new Date().toLocaleTimeString())
                          : '⚠️ 这个浏览器不让存(无痕模式?)—— 请自己先复制走');
      }, 400);
    });
  });
  function collect() {
    var out = ['# FLY-2439 v3 · 我的回馈', ''], any = false;
    boxes.forEach(function (b) {
      if (b.value.trim()) { any = true; out.push('## ' + b.dataset.label, '', b.value.trim(), ''); }
    });
    return any ? out.join('\n') : '';
  }
  document.getElementById('copy-all').addEventListener('click', function () {
    var text = collect();
    if (!text) { st.textContent = '还没有写任何评论'; return; }
    var settled = false;
    function done(m) { if (settled) return; settled = true; st.textContent = m; }
    function reveal() {
      if (settled) return; settled = true;
      var box = document.getElementById('copy-out');
      if (!box) {
        box = document.createElement('textarea');
        box.id = 'copy-out'; box.className = 'copyout'; box.setAttribute('readonly', '');
        document.querySelector('.cbar').insertAdjacentElement('beforebegin', box);
      }
      box.value = text; box.hidden = false; box.focus(); box.select();
      st.textContent = '这个浏览器不让脚本写剪贴板 —— 文本已摊在上面并全选好,按 Cmd/Ctrl+C';
    }
    function fallback() {
      if (settled) return;
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (ok) { done('已复制到剪贴板 ✅ 直接粘回 thread'); } else { reveal(); }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      setTimeout(fallback, 1000);
      navigator.clipboard.writeText(text).then(function () { done('已复制到剪贴板 ✅ 直接粘回 thread'); }, fallback);
    } else { fallback(); }
  });
  document.getElementById('clear-all').addEventListener('click', function () {
    var out = document.getElementById('copy-out'); if (out) out.hidden = true;
    if (!collect()) { st.textContent = '本来就是空的'; return; }
    if (!window.confirm('清空所有评论?这一步不能撤销。')) return;
    boxes.forEach(function (b) { b.value = ''; stamp(b, ''); });
    write({}); st.textContent = '已清空';
  });
})();
'''
w('<script nonce="__CSP_NONCE__">' + SCRIPT + '</script>')
w('</body>\n</html>\n')
open('lead-paths-v3.html', 'w', encoding='utf-8').write(out.getvalue())
print("v3 bytes:", len(out.getvalue()), "| comment boxes:", len(SECTIONS))
