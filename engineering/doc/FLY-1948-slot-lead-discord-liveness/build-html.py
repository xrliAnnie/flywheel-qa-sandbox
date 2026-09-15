#!/usr/bin/env python3
"""Build founder-design.html: inline the mmdc-rendered SVGs into the page.

Zero external dependencies at runtime; a single nonced inline script.
Re-run after editing the Mermaid sources: mmdc -i dN-*.mmd -o dN-*.svg -w 1000 -b white --svgId FLY-1948-dN
"""
from html import escape
from pathlib import Path

HERE = Path(__file__).resolve().parent
ISSUE = "FLY-1948"
ISSUE_URL = "https://linear.app/geoforge3d/issue/FLY-1948/529房缺陷-slot-lead-的-discord-通道适配器无活连接-founderlead-整圈验不通"


def svg(name: str) -> str:
    p = HERE / name
    if p.exists():
        return p.read_text(encoding="utf-8")
    return (
        '<div class="pending">DIAGRAM PENDING LOCAL RENDER — Mermaid 源在 '
        + escape(name.replace(".svg", ".mmd"))
        + "</div>"
    )


SECTIONS = [
    {
        "id": "summary",
        "title": "1. 一句话",
        "color": "#1a365d",
        "body": """
<p><b>529 房</b>(用来在隔离环境里真机演练 Flywheel 的 QA 房间)判定「slot Lead 起来了」的依据,从来不包含 Discord 通道真的连上;这次设计给房间加一道 <b>fail-closed</b>(证据不全就判失败,而不是默认通过)的「通道活连接」门,并提供一条 founder → Lead → founder 的整圈探针,把「N 秒内进会话并可回」变成带时间戳的证据文件。</p>
<p class="dim">背景:8-20 两轮 QA 看到「横幅照打、但没有 Discord 适配器进程、也没有到 443 的连接」。今天在当前 main 上真机复现两次(冷启动、launchd 拉回),适配器都活着 —— 所以本设计不押注一个已经复现不了的根因,而是确保下次再坏时房间会在正确的门上变红,并留下足以定位的快照。</p>
""",
    },
    {
        "id": "gap",
        "title": "2. 缺口在哪:房间看的 vs 通道要的",
        "color": "#ff9500",
        "diagram": "d1-gap.svg",
        "body": """
<p>左边是房间今天判 ready 的全部依据。最后一步的 <b>lease</b>(inbox-mcp 这个进程写出的「我活着」标记文件)只证明<b>另一个</b> MCP 子进程起来了,和 Discord 适配器没有任何关系。右边三件事才是「通道活着」:</p>
<ul>
<li><b>E1 进程</b>:Discord 适配器(<code>bun server.ts</code>,由 Claude Code 的 channel 插件机制拉起)必须是 Lead 那个 <code>claude</code> 进程的直接子进程。</li>
<li><b>E2 套接字</b>:这个进程持有一条到 Discord 网关的 443 <b>ESTABLISHED</b>(已建立)TCP 连接。</li>
<li><b>E3 网关就绪</b>:适配器自己的 <code>gateway-health.log</code> 里,有一行<b>本次启动之后</b>的 <code>gateway shard 0 ready</code>(Discord 网关握手完成)。</li>
</ul>
<p>全仓 529 房的脚本里,对这三件事的引用是 <b>0</b>。「横幅不等于通道活着」在代码层是必然,不是偶发。</p>
""",
    },
    {
        "id": "evidence",
        "title": "3. 真机复现(2026-09-14,当前 main)",
        "color": "#34c759",
        "body": """
<table>
<tr><th>时刻(UTC)</th><th>冷启动</th><th>launchd 拉回(kill claude 后)</th></tr>
<tr><td>dev-channels 对话框自动确认</td><td>20:24:32 → :33 confirmed</td><td>20:26:33 → :35 confirmed</td></tr>
<tr><td>lease 出现</td><td>20:24:34.234</td><td>20:26:36.895</td></tr>
<tr><td>gateway shard 0 ready</td><td>20:24:35.459</td><td>20:26:37.157</td></tr>
<tr><td>适配器进程 / 443 ESTABLISHED</td><td>pid 87270 · 2 条</td><td>pid 40728 · 2 条 · 孤儿 0</td></tr>
<tr><td>房间判 ready</td><td>20:24:52</td><td>—</td></tr>
</table>
<p>两条路径都活。但 launcher 的启动账本显示:09-04 以来 30 次 slot 启动里有 <b>10 次</b>「90 秒内没看见 dev-channels 对话框」(<code>NOT_SEEN</code>),房间对这 10 次照样报 ready —— 无论那 10 次的适配器是死是活,<b>房间都没有证据</b>。这就是要修的东西。</p>
<p class="dim">dev-channels 对话框:Claude Code 加载非官方渠道插件时弹的一次性确认框;launcher 有个后台 poller 负责在 tmux 里替它按「1」。</p>
""",
    },
    {
        "id": "gate",
        "title": "4. 新的就绪门(核心流程)",
        "color": "#007aff",
        "diagram": "d2-gate.svg",
        "body": """
<ul>
<li>每条 Lead 起时先写一份 <code>lead-coordinates.json</code>(坐标文件:agentId、载体、启动时刻、Discord 状态目录、频道、bot 身份、comm.db 路径),main / extra Lead、Claude / Codex 载体都写,与房型无关。</li>
<li>lease 门保持不变;在它之后加一道 <b>通道门</b>:60 秒预算、每 2 秒判一次三件证据,并把证据绑到<b>当前这一代</b> claude 进程(有效起点 = max(请求起点, claude 进程 UTC 启动整秒, body 记录的毫秒启动时刻);再抬到当前适配器进程的启动整秒;与启动同一秒内的网关日志一律视为「分不清是哪一代」而不作证据;轮转出来的 .log.1 与当前日志按时间戳合并后再取最新状态),再看网关<b>最新</b>生命周期状态(ready / resumed 才算活;reconnecting / 永久断线不算)。</li>
<li>通过 → 写 <code>channel-liveness.json</code>(进程 pid、连接条数、ready 时刻、pane 与日志尾巴),并把 <code>lead</code> 字段写进 <code>room-info.json</code>(房间的坐标文件)。<code>--no-lead</code> 房型写 <code>lead: null</code>,让读者一眼看出这间房没有 Discord 腿。</li>
<li>超时 → 走现有的失败快照通道,新增 <code>channel</code> 阶段,快照里带<b>分型 reason</b>(对话框卡住 / 适配器没起 / 连不上网关 / 握手没完成 / 只看到上一代的 ready / 网关退化 / 孤儿进程 / claude 进程缺失或重名 / 同代多适配器 / 传感器坏 / Codex 载体不适用,共 12 种);快照只接受与 manifest 同目录、经过 schema 与身份校验的 liveness 文件,防止串线,然后与 lease 超时一样:停 launchd 单元、释放 slot 锁、exit 1。<b>不发 room-info.json</b>,九步 driver 自然起不来。</li>
<li>同一判定封装成独立命令 <code>qa-529-discord-liveness.sh &lt;slot&gt;</code>:枚举该 slot 全部坐标文件、逐条 Lead 判定(Codex 载体明示 N/A),QA 中途(比如 Bridge 重启演练后)随时重判,不必重装房,也不依赖只在 generalized 房才有的 room-info.json。</li>
</ul>
""",
    },
    {
        "id": "data",
        "title": "5. 数据 / 结构模型",
        "color": "#af52de",
        "body": """
<pre>launchd/&lt;agentId&gt;/lead-coordinates.json (schemaVersion 1, 0600, 每条 Lead 一份)
└─ slot, agentId, carrier, mode, startedAt, discordStateDir, socketPath, primaryChatChannelId, mirrorChannelId, roundtableChannelId,
   roundtripChannelId(按房型选定的探针频道:slot→primary · mirror→mirror · roundtable→roundtable), botUserId(来自 slots 的 botAppId), projectName, commDbPath, bodyStatusPath, livenessPath

launchd/&lt;agentId&gt;/channel-liveness.json (schemaVersion 1, 0600)
├─ agentId, carrier, live, reason, observedAt, since.{requested, effective, claudeStartSecond, bodyStartedAt, ambiguousLinesIgnored}
├─ claude.{pid, startedAt}
├─ adapter.{pid, ppid, startedAt, argv, others[], rejectedLegacyShapes[]}
├─ socket.{established, peers[]}
├─ gateway.{state ready|degraded, readyAt, logPath, lastLifecycle[]}
├─ pollerVerdict  confirmed | not_seen | send_failed | unverified | pane_gone | no_tmux | none
└─ evidence.{paneTail[], gatewayLogTail[], startupLogSince[]}   每项 ≤40 行、每行 ≤200 字节;含凭据关键词或疑似凭据串的行整行替换

reason 合同(12):not_applicable · probe_unavailable · claude_process_missing · claude_process_ambiguous · dev_channels_dialog_parked
                 adapter_missing · adapter_process_ambiguous · adapter_orphaned · gateway_socket_missing · gateway_ready_missing · gateway_ready_stale · gateway_degraded

room-info.json(仅 generalized 房)追加 lead: { agentId, carrier, coordinatesPath, livenessPath } | null

e2e-evidence/discord-roundtrip-&lt;nonce&gt;.json(nonce 只允许 [A-Za-z0-9-])
└─ T0 消息时刻(Discord) · ingestObservedAt 首次在 comm.db 看到该行(轮询上界) · T2 notified_at 进会话 · T3 delivered_at Lead 已确认 · T4 合格回帖(Discord)
   所有 deadline 都是 T0 + 超时 的绝对时刻;exit 0 全通过 · 30 没等到 founder 消息 · 31/32/33/34 入箱/进会话/确认/回帖超时 · 35 通道不活 · 39 Codex 载体不适用(零网络零 DB) · 36–38、40–43 配置/身份/参数/代发准入错误</pre>
<p class="dim">reason 的优先级、观测注入名、超时旋钮(<code>--lead-channel-timeout</code>,默认 60 秒)都写在 plan.md §3–§4。判定只读:不 kill、不按键、不写 Lead 的任何目录。mailbox 行用 <code>source_ref = chat:&lt;leadId&gt;:&lt;messageId&gt;</code> 精确定位,不用模糊匹配。</p>
""",
    },
    {
        "id": "roundtrip",
        "title": "6. founder → Lead → founder 整圈探针",
        "color": "#007aff",
        "diagram": "d3-roundtrip.svg",
        "body": """
<ul>
<li><b>挑战 / 应答</b>:探针生成随机 nonce,入站正文要求 Lead 在回复里原样带上 <code>529-rt-ack:&lt;nonce&gt;</code>;T4 只认「作者是本 slot bot + 带 ack + 落在 mailbox 行 envelope 解出的回复坐标(roundtable 下是 thread)+ 晚于 T0」的消息,频道里任何无关消息都不算。</li>
<li><b>slot 房型</b>(默认):founder 那条消息只能由人发(QA 节点用 Claude-in-Chrome 以 founder 登录态发)。原因:slot 频道的允许名单只有本 slot bot,而 bot 自己发的消息会被适配器当回声丢掉;别的 slot bot 在这个频道是 403。探针负责<b>等待与采证</b>,不负责「发」。</li>
<li><b>mirror / roundtable 房型</b>:允许名单含其他 slot bot,探针可用 <code>--send-as TEST_BOT_TOKEN_1</code> 代发,整圈全自动;代发前只读核对该 bot 确实在 slots 名册里、在目标适配器的 <code>allowBots</code> 里、探针频道在其 <code>groups</code> 里,否则以「代发未获准入」退出而不是等成入箱超时。roundtable 房的探针消息发在 roundtable 父频道,回复在 thread,回复坐标从 mailbox 行的 envelope 解出。</li>
<li>时间戳来源:T0/T4 用 slot bot token <b>只读</b> Discord 频道;T1/T2/T3 <b>只读</b> slot 自己的 comm.db(参数化查询)。绝不用 founder 凭据;token 不出现在任何输出。</li>
<li>阈值是探针参数,不是硬编码,且全部是锚定 T0 的<b>绝对</b> deadline:入箱观察 ≤10s、进会话 ≤60s(Bridge 投递环节奏约 30s)、Lead 确认(ACK)≤120s、可回 ≤180s(含模型一轮);等 founder 动手的时间单独计,不算入 SLA。首个真机基线由 QA 节点跑出来贴 issue。</li>
<li><b>诚实一句</b>:CommDB 没有「真正入箱时刻」这一列(<code>created_at</code> 是 Discord 消息时间),所以入箱只报「探针首次看到该行」的轮询上界,不伪造精度。</li>
</ul>
""",
    },
    {
        "id": "tradeoffs",
        "title": "7. 关键取舍与放弃的方案",
        "color": "#ff9500",
        "body": """
<table>
<tr><th>方案</th><th>结论</th><th>为什么</th></tr>
<tr><td>去改拉起链内部(对话框 poller、插件启动脚本)修 8-20 的根因</td><td class="no">放弃</td><td>今天复现不了;8-20 的房间目录已被 teardown 清掉。改一个证明不了的东西,QA 也验不了。</td></tr>
<tr><td>把「看见横幅 / confirmed=1」当活连接证据</td><td class="no">放弃</td><td>横幅在适配器就绪之前就打;confirmed 只证明按了键。</td></tr>
<tr><td>借适配器自带的 echo probe(DISCORD_ECHO_PROBE)当整圈证据</td><td class="no">放弃</td><td>它只在适配器自己出站时触发,房间外触发不了;且是 first-fleet opt-in 开关。</td></tr>
<tr><td>改 Discord 插件加一个「探针消息」入口</td><td class="no">放弃</td><td>跨仓改动 + 版本发布 + 生产 Lead 受影响;与本 issue「房间自检」的边界不符,另开 issue。</td></tr>
<tr><td>三件证据都要,缺一判失败</td><td class="yes">采用</td><td>E1 无 E2 是「起了没连上」,E2 无 E3 是「TCP 通了握手没过」,E3 无 E1 是上一代遗物。</td></tr>
<tr><td>传感器(ps/lsof/env/pane)全部可注入</td><td class="yes">采用</td><td>CI 是 ubuntu,lsof 格式与 /proc 与 macOS 不同;离线测试只跑注入版,真机由 QA 节点验。</td></tr>
<tr><td>poller 超时时把 pane 原文写进启动账本</td><td class="no">放弃(Codex R1)</td><td>该日志是生产共用、实测 0644;pane 可能含 founder 内容或凭据。改为只写一行<b>分类</b>(三句对话框文案各命中与否、横幅位、提示符位、pane 哈希),原文只进 slot 内 0600 的证据文件并整行脱敏。</td></tr>
<tr><td>让独立探针读 room-info.json 取坐标</td><td class="no">放弃(Codex R1)</td><td>room-info 只在 generalized 房存在,还参与 FLY-2211 的 reown 排除;普通双 Lead 房、mirror、roundtable 房都没有它。改为每条 Lead 各写一份坐标文件。</td></tr>
<tr><td>T4 = T0 之后第一条 slot bot 消息</td><td class="no">放弃(Codex R1)</td><td>无因果:频道里任何无关 Lead 消息都能让探针假绿;roundtable 的真实回复在 thread 里又会假红。改为 nonce 挑战/应答 + 从 mailbox envelope 解回复坐标。</td></tr>
</table>
""",
    },
    {
        "id": "boundary",
        "title": "8. 诚实边界:做到什么、做不到什么",
        "color": "#ff3b30",
        "body": """
<p><b>做到</b>:slot Lead 起来后,房间只在三件硬证据齐全时才报 ready;失败带分型快照与 slot 锁释放;QA 随时能重判;整圈探针把 T0–T4 落成证据文件;Codex 载体的 Lead(没有插件适配器)显式跳过而非静默。</p>
<p><b>做不到</b>:</p>
<ul>
<li>解释 8-20 那两次的根因 —— 证据已不在,本文只把「下次再坏会在哪里红」做实。</li>
<li>slot 房型下让 founder 那条消息自动发出 —— 需要 Discord 权限或插件改动,不在本 issue。</li>
<li>本次没拿到 founder 登录态的时延基线 —— 本 runner 的 Chrome 扩展未连接;基线由 QA 节点用探针跑出。</li>
<li>不改 Bridge、StateStore、CommDB 表、插件、launchd 生产单元、slot 环境白名单。回滚 = revert 本 PR,不留状态。</li>
</ul>
""",
    },
]


def render_section(s: dict) -> str:
    diagram = ""
    if s.get("diagram"):
        diagram = '<div class="diagram">' + svg(s["diagram"]) + "</div>"
    return f"""
<section class="card" data-section-id="{escape(s['id'])}" data-section-title="{escape(s['title'])}" style="border-left-color:{s['color']}">
  <h2>{escape(s['title'])}</h2>
  {diagram}
  {s['body']}
  <div class="comment">
    <label for="c-{escape(s['id'])}">对这一节的意见(自动保存在本浏览器)</label>
    <textarea id="c-{escape(s['id'])}" data-comment-for="{escape(s['id'])}" rows="3" placeholder="写在这里…"></textarea>
  </div>
</section>
"""


HEAD = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{ISSUE} slot Lead Discord 通道活连接 — 设计</title>
<style>
  body {{ margin:0; background:#f5f5f7; color:#1d1d1f; font-family:-apple-system,system-ui,sans-serif; line-height:1.55; }}
  .wrap {{ max-width:960px; margin:0 auto; padding:24px 16px 64px; }}
  header h1 {{ font-size:22px; margin:0 0 6px; }}
  header .meta {{ color:#86868b; font-size:13px; }}
  header .meta a {{ color:#007aff; text-decoration:none; }}
  .issue-id {{ font-family:'SF Mono',Menlo,monospace; color:#1a365d; font-weight:600; }}
  .card {{ background:#fff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,.06); border-left:4px solid #007aff; padding:18px 20px; margin:16px 0; }}
  .card h2 {{ font-size:17px; margin:0 0 10px; }}
  .card p, .card li {{ font-size:14.5px; }}
  .dim {{ color:#86868b; font-size:13px; }}
  code {{ font-family:'SF Mono',Menlo,monospace; font-size:12.5px; background:#f5f5f7; padding:1px 5px; border-radius:4px; }}
  pre {{ font-family:'SF Mono',Menlo,monospace; font-size:12.5px; background:#f5f5f7; padding:12px; border-radius:8px; overflow-x:auto; }}
  table {{ border-collapse:collapse; width:100%; font-size:13.5px; margin:8px 0; }}
  th, td {{ text-align:left; padding:6px 8px; border-bottom:1px solid #e5e5ea; vertical-align:top; }}
  th {{ color:#86868b; font-weight:600; }}
  td.yes {{ color:#34c759; font-weight:600; white-space:nowrap; }}
  td.no {{ color:#ff3b30; font-weight:600; white-space:nowrap; }}
  .diagram {{ margin:8px 0 14px; overflow-x:auto; }}
  .diagram svg {{ max-width:100%; height:auto; }}
  .pending {{ border:2px dashed #ff9500; color:#ff9500; padding:24px; text-align:center; border-radius:8px; }}
  .comment {{ margin-top:14px; border-top:1px dashed #e5e5ea; padding-top:10px; }}
  .comment label {{ display:block; font-size:12.5px; color:#86868b; margin-bottom:4px; }}
  textarea {{ width:100%; box-sizing:border-box; font:inherit; font-size:13.5px; border:1px solid #d2d2d7; border-radius:8px; padding:8px; resize:vertical; }}
  .summary pre {{ white-space:pre-wrap; }}
  button {{ font:inherit; font-size:13.5px; background:#007aff; color:#fff; border:0; border-radius:8px; padding:8px 14px; cursor:pointer; margin:6px 6px 6px 0; }}
  button.secondary {{ background:#e5e5ea; color:#1d1d1f; }}
  .status {{ font-size:12.5px; color:#86868b; margin-left:6px; }}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1><span class="issue-id">{ISSUE}</span> slot Lead 的 Discord 通道「活连接」断言与整圈探针 — 设计</h1>
  <div class="meta">Issue: <a href="{escape(ISSUE_URL)}">{ISSUE}</a> · 日期 2026-09-14 · 设计节点产物,配套 exploration.md / research.md / plan.md · 每节下方可留意见,页尾一键汇总复制</div>
</header>
"""

FOOT = """
<section class="card summary" data-section-id="__summary__" style="border-left-color:#1a365d">
  <h2>页面意见汇总</h2>
  <p class="dim">下面实时汇总每一节非空的意见,首行固定为 <code>【页面意见汇总】FLY-1948</code>;超过约 1800 字会分块,每块都带 marker。这是修订意见的载体,不是通过信号。</p>
  <div id="summary-chunks"></div>
  <button id="copy-all" type="button">复制全部意见</button>
  <button id="clear-all" type="button" class="secondary">清空本页所有意见</button>
  <span id="copy-status" class="status"></span>
</section>
</div>
<script nonce="__CSP_NONCE__">
(function () {
  'use strict';
  var ISSUE = 'FLY-1948';
  var MARKER = '【页面意见汇总】FLY-1948';
  var PREFIX = 'fly1948-comment:' + location.pathname + ':';
  var CHUNK = 1800;

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  var areas = Array.prototype.slice.call(document.querySelectorAll('textarea[data-comment-for]'));

  function sectionTitle(area) {
    var sec = area.closest('section');
    return sec ? (sec.getAttribute('data-section-title') || '') : '';
  }

  function collect() {
    var parts = [];
    areas.forEach(function (a) {
      var v = (a.value || '').trim();
      if (v) parts.push('[' + sectionTitle(a) + '] ' + v);
    });
    return parts;
  }

  function chunks() {
    var parts = collect();
    if (!parts.length) return [MARKER + '\\n(暂无意见)'];
    var out = [], cur = MARKER;
    parts.forEach(function (p) {
      var next = cur + '\\n' + p;
      if (next.length > CHUNK && cur !== MARKER) { out.push(cur); cur = MARKER + '\\n' + p; }
      else cur = next;
    });
    out.push(cur);
    return out;
  }

  var host = document.getElementById('summary-chunks');
  function render() {
    while (host.firstChild) host.removeChild(host.firstChild);
    chunks().forEach(function (c, i) {
      var pre = document.createElement('pre');
      pre.textContent = c;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = '复制第 ' + (i + 1) + ' 块';
      btn.addEventListener('click', function () { copyText(c); });
      host.appendChild(pre);
      host.appendChild(btn);
    });
  }

  var status = document.getElementById('copy-status');
  function setStatus(msg) { status.textContent = msg; setTimeout(function () { status.textContent = ''; }, 2500); }

  function fallbackCopy(text) {
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
    setStatus(ok ? '已复制' : '复制失败,请手动选中复制');
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { setStatus('已复制'); }, function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }

  areas.forEach(function (a) {
    var key = PREFIX + a.getAttribute('data-comment-for');
    var saved = lsGet(key);
    if (saved !== null) a.value = saved;
    a.addEventListener('input', function () { lsSet(key, a.value); render(); });
  });

  document.getElementById('copy-all').addEventListener('click', function () { copyText(chunks().join('\\n\\n')); });
  document.getElementById('clear-all').addEventListener('click', function () {
    areas.forEach(function (a) { a.value = ''; lsDel(PREFIX + a.getAttribute('data-comment-for')); });
    render();
    setStatus('已清空');
  });

  render();
})();
</script>
</body>
</html>
"""


def main() -> None:
    html = HEAD + "".join(render_section(s) for s in SECTIONS) + FOOT
    out = HERE / "founder-design.html"
    out.write_text(html, encoding="utf-8")
    print(f"wrote {out} ({len(html.encode('utf-8'))} bytes)")


if __name__ == "__main__":
    main()
