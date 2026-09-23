#!/usr/bin/env python3
"""Build founder-voice-architecture.html for FLY-2786 (docs-only, no network).

Every diagram arrow and its table row come from the same HOPS data, so the
self-check at the bottom can prove each arrow carries a citation or 未验证.
"""
import html, json, pathlib, re, sys

OUT = pathlib.Path(__file__).with_name("founder-voice-architecture.html")
E = html.escape

# category -> (css var, legend text)
CATS = {
    "listen": ("--c-listen", "听懂(语音→文字)"),
    "move":   ("--c-move",   "搬运 / 等待"),
    "think":  ("--c-think",  "Lead 想"),
    "drop":   ("--c-drop",   "丢失 / 没接通"),
    "fast":   ("--c-fast",   "快路(自己答)"),
    "info":   ("--c-info",   "其他"),
}

VC = "packages/voice-codex/src/"
TL = "packages/teamlead/src/"
RAYA = "raya 仓 apps/voice/src/"

# hop = (from, to, label, cat, cite, time, process, serial, note, new)
def H(frm, to, label, cat, cite, time="", proc="", serial="串", note="", new=False):
    return dict(frm=frm, to=to, label=label, cat=cat, cite=cite, time=time,
                proc=proc, serial=serial, note=note, new=new)

DIAGRAMS = {}

DIAGRAMS["rg"] = dict(
    title="现状 ① 随身语音(rg)· 今天每一句话的路径",
    lanes=[("F", "你 · 语音房"), ("V", "语音进程"), ("O", "OpenAI Realtime"),
           ("D", "Discord thread"), ("B", "Bridge · 邮箱"), ("L", "Raya(Lead)")],
    hops=[
        H("F", "V", "收音,Opus 解码", "listen", VC+"discord-room.ts:325-395", "流式", "语音进程", "流"),
        H("V", "V", "本地人声门 Silero", "listen", VC+"pipeline/UplinkSpeechGate.ts:121-129,399-429;"+VC+"discord-room.ts:135-137", "常量:延迟线 280ms", "语音进程", "串", "≥200ms 人声才开门,静音帧照发"),
        H("V", "O", "20ms 一帧上行", "listen", VC+"pipeline/Uplink.ts:167-182;"+VC+"realtime.ts:287-336", "周期 20ms", "语音进程→OpenAI", "周期"),
        H("O", "O", "静 500ms 才提交 + 转写", "listen", VC+"realtime.ts:170-177,608-698", "实测 2.1s / 1.2s", "OpenAI", "串", "说完到转写完成"),
        H("O", "V", "说话人归属,归不上整句丢", "drop", VC+"realtime.ts:739-761;"+VC+"speaker-attribution.ts:45-50", "实测:丢 1 段(约 5s 话)", "语音进程", "串", "只发一条「📻 有一句话没能确认说话人」"),
        H("V", "D", "先发 🗣️ 镜像文字", "move", VC+"delivery.ts:119-171;"+VC+"adapters.ts:17-51", "与下一跳合计 实测 2.1s / 0.6s", "语音进程→Discord", "串", "你在 thread 里先看到文字的原因"),
        H("V", "B", "起子进程写进 Raya 邮箱 + 按门铃", "move", VC+"delivery.ts:173-226;"+VC+"adapters.ts:103-161;packages/flywheel-comm/src/lead-inbox-nudge.ts:38-102", "(含在上一跳)", "语音进程→comm.db→Bridge", "串"),
        H("B", "L", "推给 Raya(活跃 1s / 空闲 30s 轮询)", "move", TL+"bridge/lead-inbox-loop.ts:30-31,187-219", "实测 12.7s / 2.1s", "Bridge→Lead", "串", "U1 这 12.7s 门铃为何没立刻生效:未定位"),
        H("L", "L", "Raya 一整轮 Codex turn", "think", TL+"lead-backends/codex/LeadInputRouter.ts:285-302;"+TL+"lead-backends/codex/CodexTurnExecutor.ts:136-138", "实测 12.5s / 8.2s", "Lead", "与她所有其他工作串行", "一次只跑一个 turn,语音无插队通道"),
        H("L", "D", "文字回复发进 thread", "move", TL+"lead-backends/codex/LeadInputRouter.ts:353-372;"+TL+"bridge/discord-utils.ts:212-260", "(含在上一跳)", "Lead→Discord", "串"),
        H("D", "B", "Bridge 每 3s 轮询 thread", "move", TL+"bridge/voice-session-services.ts:57-65;"+TL+"bridge/voice-session-poller.ts:64-111", "与下一跳合计 实测 6.8s / 3.8s", "Bridge", "轮询"),
        H("B", "V", "语音进程每 4s 拉一次", "move", VC+"daemon.ts:554-566;"+VC+"config.ts:135", "(含在上一跳)", "语音进程", "轮询"),
        H("V", "O", "≤80 字一段,请求逐字朗读", "move", VC+"speech.ts:81,174-192;"+VC+"realtime.ts:338-378", "", "语音进程→OpenAI", "逐段串行"),
        H("O", "V", "整段生成完才放行", "move", VC+"realtime.ts:997-1022", "实测 1.7s / 2.1s", "OpenAI→语音进程", "串", "不是边生成边播"),
        H("V", "F", "20ms 一帧播放,播完才下一段", "info", VC+"session.ts:270-299;"+VC+"audio.ts:131-158;"+VC+"daemon.ts:781-788", "实测 音频长 5.7s / 9.2s", "语音进程→语音房", "逐段串行"),
    ])

DIAGRAMS["hp"] = dict(
    title="现状 ② 耳机模式(voice-headphone · 桌面试运行版,本机未部署)",
    lanes=[("F", "你"), ("D", "Discord 文字"), ("H", "耳机守护进程"),
           ("B", "Bridge"), ("S", "Mac 本机扬声器"), ("L", "Lead")],
    hops=[
        H("F", "D", "打字「芝麻开门」开启", "info", "packages/voice-headphone/src/daemon-core.ts:126-161", "", "Discord", "串", "开关靠打字口令"),
        H("H", "B", "启动先取 scope", "info", "packages/voice-headphone/src/daemon.ts:107;"+TL+"bridge/voice-routes.ts:231;"+TL+"bridge/plugin.ts:11259", "", "耳机进程→Bridge", "串", "接口存在、始终挂载;但本机没有这个进程(无 launchd / 无进程 / 无状态文件)"),
        H("D", "H", "收 Lead / 系统 bot 的文字消息", "info", "packages/voice-headphone/src/daemon.ts:223-237;packages/voice-headphone/src/daemon-core.ts:163-200", "", "Discord 网关→耳机进程", "事件"),
        H("H", "B", "查 gate-binding / context", "info", "packages/voice-headphone/src/bridge-client.ts:104-134;"+TL+"bridge/voice-routes.ts:264,295", "", "耳机进程→Bridge", "串"),
        H("H", "S", "念标题+正文(>400 字只念两句)", "info", "packages/voice-core/src/headphone/turn-machine.ts:13,240-244;packages/voice-headphone/src/local-announcer.ts:18-27", "未测", "耳机进程→本机", "串", "念到 Mac 扬声器,不进语音房(语音房接入 M-B4 未落地,cli.ts:3-4)"),
        H("F", "H", "开口说「要回 / 说吧」", "drop", "packages/voice-core/src/headphone/turn-machine.ts:17,245-250;packages/voice-headphone/src/daemon-core.ts:159", "语音输入未接", "—", "—", "全仓没有语音事件的生产者,唯一输入是打字口令"),
        H("H", "D", "把你的回复以文字 @Lead 发出", "move", "packages/voice-core/src/headphone/turn-machine.ts:500-514;packages/voice-headphone/src/null-audio-io.ts:67-88", "", "耳机进程→Discord", "串", "不等 Lead 回答"),
        H("L", "D", "Lead 之后回复,再被念出来", "think", "packages/voice-headphone/src/null-audio-io.ts:72-76(注释)", "未测", "Lead", "异步", "耳机进程里没有 LLM"),
    ])

DIAGRAMS["mt"] = dict(
    title="现状 ③ 会议模式(meeting)· 外层共用,Lead 那段分叉",
    lanes=[("R", "Raya · 排会"), ("B", "Bridge"), ("V", "语音进程"),
           ("D", "Discord thread"), ("L", "被挂的 Lead"), ("N", "会后纪要")],
    hops=[
        H("R", "B", "voice-session start --meeting-id", "info", "packages/raya-cos/src/meeting-voice.ts:22-38;packages/flywheel-comm/src/commands/voice-session.ts:216", "", "Raya→Bridge", "串", "会前"),
        H("B", "B", "读 meeting.json,按 leadId 选 Lead", "info", TL+"bridge/voice-session-start.ts:155-189", "", "Bridge", "串", "挂哪个 Lead 由会议记录决定"),
        H("B", "D", "Lead bot 建 thread,拉你进来", "info", TL+"bridge/voice-session-provisioner.ts:98,300-349", "", "Bridge→Discord", "串"),
        H("V", "B", "语音进程每 5s 领取会话", "move", VC+"daemon.ts:321-372;"+VC+"config.ts:177", "常量 5s", "语音进程", "轮询"),
        H("V", "D", "【共用】收音→转写→镜像→进邮箱(图① 1–7)", "listen", VC+"cli.ts:65-72,280-309;"+VC+"daemon.ts:703-706", "未测(生产从未跑过)", "语音进程", "串", "mode 只改 evidence 路径、信号文件、健康 id;其余同 rg"),
        H("B", "L", "【分叉】Raya:unix socket 推给 Codex sidecar", "move", TL+"lead-backends/codex/CodexLeadInboxSocket.ts:5-12;"+TL+"bridge/lead-inbox-loop.ts:30-31", "可参考 rg 实测", "Bridge→Lead", "串"),
        H("B", "L", "【分叉】Claude Lead:tmux 里收件", "move", "未验证(packages/teamlead/scripts/claude-lead.sh:2539,2781 只证明注册了收件器)", "未测", "Bridge→Lead", "串", "节奏、会不会把 🗣️ 镜像再吃一遍,都未验证"),
        H("L", "D", "【分叉】Lead 想完回帖(Codex / Claude 各自一轮)", "think", "Raya:"+TL+"lead-backends/codex/LeadInputRouter.ts:285-302;Claude:未验证", "未测", "Lead", "串"),
        H("D", "V", "【共用】两层轮询→整段朗读(图① 11–15)", "move", TL+"bridge/voice-session-poller.ts:64-111;"+VC+"daemon.ts:554-566,781-788", "未测", "Bridge→语音进程", "轮询"),
        H("V", "N", "会后写 voice-signal.json", "info", VC+"meeting-voice-signal.ts:88-123", "", "语音进程", "一次"),
        H("N", "N", "每 120s tick,派 Runner 写纪要", "info", "scripts/meeting-notes-scheduler.ts:437-439,525-548", "会后,不影响会中", "launchd→Bridge→Runner", "一次"),
    ])

DIAGRAMS["A"] = dict(
    title="方案 A · 前台快答 + 后台 Raya",
    lanes=[("F", "你 · 语音房"), ("V", "语音进程"), ("O", "OpenAI 前台(自带脑子)"),
           ("D", "Discord thread"), ("B", "Bridge · 邮箱"), ("L", "Raya / 任一 Lead")],
    hops=[
        H("F", "O", "收音 + 人声门 + 上行(复用 ①–③)", "listen", VC+"discord-room.ts:325-395;"+VC+"realtime.ts:287-336", "同今天", "复用", "流"),
        H("O", "O", "静 500ms 后前台自己答", "fast", "方案改动 "+VC+"realtime.ts:175(今天 create_response:false)", "未测;参考 0.86s", "OpenAI", "串", "0.86s 是另一条管线(Gemini Live)的真人实测,FLY-1347 voice-measurement-pack.md:17", True),
        H("O", "F", "边生成边播,她马上听到", "fast", "方案改动 "+VC+"realtime.ts:997-1022(今天整段缓冲)", "未测", "OpenAI→语音房", "流", "", True),
        H("V", "D", "发字幕「🤖 前台:…」", "info", "未验证(拟议);🤖 前缀不被回程轮询重念:"+TL+"bridge/voice-session-poller.ts:12,36-43", "", "语音进程→Discord", "并", "不进 Lead 邮箱。Lead 收件侧会不会读到这行:Codex Lead 有忽略作者名单(CodexDiscordGateway.ts:100,183),Claude Lead 未验证", True),
        H("O", "O", "要查/要做/要判断 → 先说一句「我去问下 Raya」", "fast", "未验证(方案新增);模式出处:openai-realtime-agents「Chat-Supervisor」", "未测", "OpenAI", "并", "", True),
        H("O", "V", "函数调用 ask_lead(她的原话)", "move", "未验证(方案新增);API:developers.openai.com guides/realtime-mcp(function_call_arguments.done)", "", "OpenAI→语音进程", "串", "", True),
        H("V", "B", "进 Lead 邮箱,门铃必达", "move", "复用 "+VC+"delivery.ts:173-226;需修 "+TL+"bridge/lead-inbox-loop.ts:187-219", "去掉 12.7s 空等", "语音进程→Bridge", "串", "", True),
        H("B", "L", "Lead 一整轮", "think", "复用 "+TL+"lead-backends/codex/LeadInputRouter.ts:285-302", "今天实测 8–12s", "Lead", "与她其他工作串行"),
        H("L", "V", "回复推送给语音进程(代替 3s+4s 轮询)", "move", "未验证(方案改动 "+TL+"bridge/voice-session-poller.ts:64-111、"+VC+"daemon.ts:554-566)", "去掉 3.8–6.8s", "Bridge→语音进程", "推送", "", True),
        H("V", "O", "function_call_output + response.create", "move", "未验证(方案新增);API:guides/realtime-mcp", "", "语音进程→OpenAI", "串", "", True),
        H("O", "F", "前台用自己的声音转述 Lead 的答案", "fast", "未验证(方案新增)", "预期 ≈ 10–15s(推断)", "OpenAI→语音房", "流", "", True),
    ])

DIAGRAMS["B"] = dict(
    title="方案 B · 9 月初「自带脑子」(Codex app-server realtime v2,历史代码)",
    lanes=[("F", "你 · 语音房"), ("R", "Raya 语音进程(raya 仓)"), ("A", "Codex app-server(第二个进程)"),
           ("O", "OpenAI Realtime"), ("T", "后台 Codex thread")],
    hops=[
        H("R", "A", "thread/start:IDENTITY + MEMORY", "info", RAYA+"codex/CodexLeg.ts:115-134@f669d1b", "", "Raya 语音进程→app-server", "串", "会话开始一次"),
        H("R", "A", "thread/realtime/start v2(同一 thread)", "info", RAYA+"codex/RealtimeTransport.ts:181@f669d1b", "", "Raya 语音进程→app-server", "串"),
        H("A", "O", "app-server 配会话:create_response:true + background_agent / remain_silent", "fast", "engineering/doc/FLY-2159-voice-response-recovery/evidence/i5-true-upstream-frames.jsonl:2;FLY-2249 plan.md@4a4bc2994:372", "", "app-server→OpenAI", "串"),
        H("F", "A", "收音 + 人声门 + appendAudio 每 20ms", "listen", RAYA+"pipeline/Uplink.ts:93@f669d1b;"+RAYA+"codex/RealtimeTransport.ts:220@f669d1b", "", "Raya 语音进程→app-server", "周期"),
        H("O", "F", "快路:静 500ms 后模型自己答,流式出声", "fast", RAYA+"codex/RealtimeTransport.ts:317@f669d1b(outputAudio/delta);口令 "+RAYA+"cli.ts:84@f669d1b", "未测(无逐句留痕)", "OpenAI→语音房", "流"),
        H("O", "T", "慢路:模型自己决定调 background_agent", "think", RAYA+"runtime.ts:1653-1674@b1b5a64(handoff_request);FLY-2031 research.md@a1b333bc4:35-45", "未测", "app-server→后台 thread", "串", "等待时有「思考中」底噪/字幕"),
        H("T", "O", "后台 Codex 推理/跑命令 → 结果交回实时模型说", "think", "engineering/doc/FLY-2031-raya-mobile-voice/research.md@a1b333bc4:35-45", "未测", "后台 thread→OpenAI", "串"),
        H("R", "F", "字幕 🗣️ 你 / 💭 正在思考 / 💬 Raya", "info", RAYA+"discord/VoiceTextMirror.ts:52,69,84@f669d1b", "", "Raya 语音进程→Discord", "并"),
    ])

DIAGRAMS["C"] = dict(
    title="方案 C · 不改架构,只修管道(对照组)",
    lanes=[("F", "你 · 语音房"), ("V", "语音进程"), ("O", "OpenAI Realtime"),
           ("B", "Bridge · 邮箱"), ("L", "Raya(Lead)")],
    hops=[
        H("F", "O", "收音 + 人声门 + 上行 + 转写", "listen", VC+"realtime.ts:170-177,608-698", "实测 1.2–2.1s(拿不掉)", "同今天", "串"),
        H("O", "V", "说话人归属失败不再整句丢弃", "listen", "未验证(方案改动 "+VC+"realtime.ts:739-761)", "少丢话", "语音进程", "串", "", True),
        H("V", "B", "进邮箱,门铃必达", "move", "未验证(方案改动 "+TL+"bridge/lead-inbox-loop.ts:187-219)", "去掉 最多 12.7s", "语音进程→Bridge", "串", "", True),
        H("B", "L", "Raya 一整轮", "think", TL+"lead-backends/codex/LeadInputRouter.ts:285-302", "实测 8–12s(拿不掉)", "Lead", "与她其他工作串行"),
        H("L", "V", "回复直接推给语音进程", "move", "未验证(方案改动 "+TL+"bridge/voice-session-poller.ts:64-111)", "去掉 3.8–6.8s", "Bridge→语音进程", "推送", "", True),
        H("V", "F", "边生成边播", "move", "未验证(方案改动 "+VC+"realtime.ts:997-1022)", "去掉 1.7–2.1s", "OpenAI→语音房", "流", "", True),
    ])


def tw(text, fs=13):
    """Rough rendered width: CJK/full-width ~1em, ASCII ~0.55em."""
    return sum(fs if ord(ch) > 0x2E7F else fs * 0.56 for ch in text)


def wrap(text, maxw, fs=11.5):
    lines, cur = [], ""
    for ch in text:
        if cur and tw(cur + ch, fs) > maxw:
            lines.append(cur); cur = ch
        else:
            cur += ch
    if cur: lines.append(cur)
    return lines[:2] if len(lines) <= 2 else [lines[0], lines[1][:-1] + "…"]


def svg_diagram(key, d):
    lanes = d["lanes"]; hops = d["hops"]
    lane_w, left, top, row_h, right = 132, 22, 58, 52, 170
    lanes_end = left + lane_w * len(lanes)
    width = lanes_end + right
    height = top + row_h * len(hops) + 20
    xs = {k: left + lane_w * i + lane_w / 2 for i, (k, _) in enumerate(lanes)}
    out = [f'<svg class="flow" viewBox="0 0 {width} {height}" style="min-width:{int(width*0.72)}px" role="img" aria-label="{E(d["title"])}">',
           '<defs>']
    for c, (var, _) in CATS.items():
        out.append(f'<marker id="ah-{key}-{c}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var({var})"/></marker>')
    out.append('</defs>')
    for k, name in lanes:
        x = xs[k]
        out.append(f'<rect class="lane-h" x="{x-lane_w/2+5}" y="8" width="{lane_w-10}" height="34" rx="8"/>')
        out.append(f'<text class="lane-t" x="{x}" y="30" text-anchor="middle">{E(name)}</text>')
        out.append(f'<line class="life" x1="{x}" y1="44" x2="{x}" y2="{height-8}"/>')
    out.append(f'<text class="col-t" x="{lanes_end+14}" y="30">耗时</text>')
    for i, h in enumerate(hops):
        n = i + 1
        y = top + row_h * i + 30
        var = CATS[h["cat"]][0]
        dash = ' stroke-dasharray="6 4"' if h["new"] else ''
        tip = f'{n}. {h["label"]} | 依据: {h["cite"]}' + (f' | {h["time"]}' if h["time"] else '')
        out.append(f'<g class="hop" data-hop="{key}-{n}" tabindex="0"><title>{E(tip)}</title>')
        x1, x2 = xs[h["frm"]], xs[h["to"]]
        lw = tw(h["label"])
        if x1 == x2:
            bw = max(lane_w - 20, lw + 20)
            bx0 = min(max(x1 - bw / 2, left + 20), lanes_end - bw)
            out.append(f'<rect x="{bx0}" y="{y-13}" width="{bw}" height="26" rx="7" style="fill:var(--card);stroke:var({var})"{dash} stroke-width="1.6"/>')
            out.append(f'<text class="hop-l" x="{bx0+bw/2}" y="{y+4}" text-anchor="middle">{E(h["label"])}</text>')
            bx = bx0 - 11
        else:
            sgn = 1 if x2 > x1 else -1
            out.append(f'<line x1="{x1+sgn*10}" y1="{y}" x2="{x2-sgn*4}" y2="{y}" style="stroke:var({var})" stroke-width="2"{dash} marker-end="url(#ah-{key}-{h["cat"]})"/>')
            lo, hi = min(x1, x2), max(x1, x2)
            bx = x1
            if lw <= hi - lo - 28:
                out.append(f'<text class="hop-l" x="{(lo+hi)/2}" y="{y-9}" text-anchor="middle">{E(h["label"])}</text>')
            else:
                sx = min(lo + 14, lanes_end - lw)
                out.append(f'<text class="hop-l" x="{max(sx, 4)}" y="{y-11}">{E(h["label"])}</text>')
        out.append(f'<circle cx="{bx}" cy="{y}" r="8.5" style="fill:var({var})"/><text class="badge" x="{bx}" y="{y+3.8}" text-anchor="middle">{n}</text>')
        if h["time"]:
            lines = wrap(h["time"], right - 20)
            y0 = y + 4 - (6.5 if len(lines) == 2 else 0)
            spans = "".join(f'<tspan x="{lanes_end+14}" y="{y0 + j*14}">{E(t)}</tspan>' for j, t in enumerate(lines))
            out.append(f'<text class="hop-time">{spans}</text>')
        out.append('</g>')
    out.append('</svg>')
    return "".join(out)


def cite_html(c):
    parts = [p for p in re.split(r"[;;]", c) if p.strip()]
    return "<br>".join(f"<code>{E(p.strip()).replace('/', '/<wbr>')}</code>" if re.search(r"\.(ts|md|jsonl|sh)\b|@[0-9a-f]{7}", p) else E(p.strip()) for p in parts)


def table(key, d):
    rows = []
    for i, h in enumerate(d["hops"]):
        n = i + 1
        lanes = dict(d["lanes"])
        route = lanes[h["frm"]] if h["frm"] == h["to"] else f'{lanes[h["frm"]]} → {lanes[h["to"]]}'
        tag = ' <span class="tag new">方案新增/改动</span>' if h["new"] else ''
        note = f'<div class="note">{E(h["note"])}</div>' if h["note"] else ''
        rows.append(f'<tr id="row-{key}-{n}"><td class="n"><span class="dot" style="background:var({CATS[h["cat"]][0]})">{n}</span></td>'
                    f'<td><b>{E(h["label"])}</b>{tag}<div class="route">{E(route)}</div>{note}</td>'
                    f'<td data-l="串/并">{E(h["serial"])}</td><td data-l="耗时">{E(h["time"] or "—")}</td><td class="cite" data-l="依据">{cite_html(h["cite"])}</td></tr>')
    return ('<div class="tbl-wrap"><table class="hops"><thead><tr><th>#</th><th>这一步做什么 · 从哪到哪</th><th>串/并</th><th>耗时</th><th>依据</th></tr></thead><tbody>'
            + "".join(rows) + '</tbody></table></div>')


def figure(key):
    d = DIAGRAMS[key]
    return (f'<figure class="diagram"><figcaption>{E(d["title"])}</figcaption>'
            f'<div class="svg-wrap">{svg_diagram(key, d)}</div>'
            f'<p class="hint">点编号或表格行可互相定位;虚线 = 方案新增/改动(今天不存在)。</p>'
            f'{table(key, d)}</figure>')


def legend():
    return '<div class="legend">' + "".join(
        f'<span><i style="background:var({v})"></i>{E(t)}</span>' for v, t in CATS.values()) + '</div>'


# measured timeline (exploration.md §2.1)
SEGS = [
    ("听懂", "listen", 2.1, 1.2),
    ("镜像+进邮箱", "move", 2.1, 0.6),
    ("等推给 Raya", "move", 12.7, 2.1),
    ("Raya 一整轮", "think", 12.5, 8.2),
    ("两层轮询", "move", 6.8, 3.8),
    ("整段合成", "move", 1.7, 2.1),
]

def timeline_svg():
    W, left, scale, bar_h = 940, 96, 19, 30
    out = [f'<svg class="flow" viewBox="0 0 {W} 170" style="min-width:640px" role="img" aria-label="实测时间线">']
    for row, (name, total) in enumerate([("U1 · 38s", 0), ("U2 · 18s", 1)]):
        y = 20 + row * 70
        out.append(f'<text class="lane-t" x="8" y="{y+20}">{E(name)}</text>')
        x = left
        for label, cat, a, b in SEGS:
            v = (a, b)[row]
            w = v * scale
            out.append(f'<g class="hop"><title>{E(label)} {v}s</title><rect x="{x}" y="{y}" width="{w}" height="{bar_h}" style="fill:var({CATS[cat][0]})" rx="3"/>')
            if w > 44:
                out.append(f'<text class="bar-t" x="{x+w/2}" y="{y+19}" text-anchor="middle">{E(label)} {v}s</text>')
            out.append('</g>')
            x += w
        out.append(f'<text class="hop-time" x="{x+8}" y="{y+19}">→ 第一个字</text>')
        out.append(f'<line class="life" x1="{left}" y1="{y+bar_h+6}" x2="{left + 40*scale}" y2="{y+bar_h+6}"/>')
    for s in range(0, 41, 5):
        out.append(f'<text class="tick" x="{left + s*scale}" y="164" text-anchor="middle">{s}s</text>')
    out.append('</svg>')
    return "".join(out)


def seg_note():
    return "分段(U1 / U2):" + " · ".join(
        f'<span style="color:var({CATS[c][0]})">■</span> {E(l)} {a}s / {b}s' for l, c, a, b in SEGS)


def comment(k, title, rows=2):
    return (f'<div class="reply"><label for="c-{k}">你的意见 · {E(title)}</label>'
            f'<textarea id="c-{k}" data-k="{k}" data-title="{E(title)}" rows="{rows}" placeholder="哪里不对、想怎么改,写在这里(可不填)"></textarea></div>')


def choice(k, title, opts):
    radios = "".join(f'<label class="opt"><input type="radio" name="r-{k}" value="{E(o)}" data-k="{k}" data-title="{E(title)}"> {E(o)}</label>' for o in opts)
    return f'<fieldset class="choice"><legend>{E(title)}</legend>{radios}</fieldset>'


def scheme_card(key, cls, rows, verdict):
    cells = "".join(f'<div class="kv"><div class="k">{E(k)}</div><div class="v">{v}</div></div>' for k, v in rows)
    return f'<div class="card {cls}">{figure(key)}<div class="kvs">{cells}</div><p class="verdict">{verdict}</p></div>'


CSS = r"""
:root{color-scheme:light only;--bg:#f5f5f7;--card:#ffffff;--ink:#1d1d1f;--dim:#86868b;--line:#d2d2d7;--navy:#1a365d;
--c-listen:#007aff;--c-move:#ff9500;--c-think:#af52de;--c-drop:#ff3b30;--c-fast:#34c759;--c-info:#8e8e93;
--shadow:0 1px 3px rgba(0,0,0,.06);--code:#f2f2f7}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 -apple-system,system-ui,"PingFang SC","Hiragino Sans GB",sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px 80px}
h1{font-size:26px;margin:8px 0 4px}h2{font-size:20px;margin:36px 0 10px;color:var(--navy)}h3{font-size:16px;margin:18px 0 6px}
.sub{color:var(--dim);font-size:13px}
.card{background:var(--card);border-radius:12px;box-shadow:var(--shadow);padding:16px;margin:14px 0;border-left:4px solid var(--line)}
.card.red{border-left-color:var(--c-drop)}.card.amber{border-left-color:var(--c-move)}.card.blue{border-left-color:var(--c-listen)}
.card.green{border-left-color:var(--c-fast)}.card.purple{border-left-color:var(--c-think)}.card.gray{border-left-color:var(--c-info)}
.big{font-size:17px}.big b{color:var(--navy)}
code{font:12px/1.4 "SF Mono",ui-monospace,Menlo,monospace;background:var(--code);padding:1px 4px;border-radius:4px;word-break:break-all}
.diagram{margin:0}.diagram figcaption{font-weight:600;margin-bottom:8px}
.svg-wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;border:1px solid var(--line);border-radius:10px;background:var(--card)}
svg.flow{display:block;width:100%;height:auto;font-family:-apple-system,system-ui,"PingFang SC",sans-serif}
.lane-h{fill:var(--bg);stroke:var(--line)}.lane-t{font-size:13.5px;font-weight:600;fill:var(--ink)}
.col-t{font-size:12px;font-weight:600;fill:var(--dim)}
.life{stroke:var(--line);stroke-dasharray:3 4}.hop-l{font-size:13px;fill:var(--ink);paint-order:stroke;stroke:var(--card);stroke-width:4px;stroke-linejoin:round}
.badge{font-size:10.5px;font-weight:700;fill:#fff}.hop-time{font-size:12px;fill:var(--dim)}.bar-t{font-size:11.5px;fill:#fff;font-weight:600}.tick{font-size:11px;fill:var(--dim)}
.hop{cursor:pointer;outline:none}.hop:focus circle,.hop.on circle{stroke:var(--ink);stroke-width:2}
.segs{font-size:13px;margin:8px 0 2px}.hint{font-size:12px;color:var(--dim);margin:6px 0}
.tbl-wrap{overflow-x:auto}
table.hops{width:100%;border-collapse:collapse;font-size:13px;margin-top:6px}
table.hops th{text-align:left;color:var(--dim);font-weight:600;border-bottom:1px solid var(--line);padding:6px}
table.hops td{border-bottom:1px solid var(--line);padding:6px;vertical-align:top}
table.hops tr.on td{background:rgba(0,122,255,.10)}
td.n{width:28px}.dot{display:inline-block;min-width:20px;height:20px;border-radius:10px;color:#fff;font-size:11px;font-weight:700;text-align:center;line-height:20px}
td.cite{min-width:220px;max-width:360px}td.cite code{word-break:normal;overflow-wrap:anywhere}.route{color:var(--dim);font-size:12px}.note{font-size:12px;color:var(--dim)}
.tag{font-size:11px;border-radius:6px;padding:1px 6px;margin-left:4px}.tag.new{background:rgba(52,199,89,.15);color:var(--c-fast)}
.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:12.5px;color:var(--dim);margin:6px 0 10px}
.legend i{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:5px;vertical-align:-1px}
.kvs{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin-top:12px}
.kv{background:var(--bg);border-radius:10px;padding:10px}.kv .k{font-size:12px;color:var(--dim);font-weight:600}.kv .v{font-size:13.5px}
.verdict{font-weight:600;margin:12px 0 0}
.reply{margin-top:12px}.reply label{display:block;font-size:12.5px;color:var(--dim);margin-bottom:4px}
textarea{width:100%;font:14px/1.5 inherit;font-family:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px}
fieldset.choice{border:1px solid var(--line);border-radius:10px;margin:12px 0 0;padding:8px 12px}
fieldset.choice legend{font-size:13px;font-weight:600;padding:0 4px}
.opt{display:inline-block;margin:4px 14px 4px 0;font-size:14px}
ul.ev{margin:6px 0;padding-left:20px;font-size:13.5px}ul.ev li{margin:3px 0}
.lbl{font-size:11px;font-weight:700;border-radius:5px;padding:1px 6px;margin-right:6px}
.lbl.fact{background:rgba(0,122,255,.12);color:var(--c-listen)}.lbl.inf{background:rgba(255,149,0,.15);color:#c77700}.lbl.nov{background:rgba(255,59,48,.12);color:var(--c-drop)}
.tl{list-style:none;padding:0;margin:0}.tl li{padding:8px 0 8px 14px;border-left:2px solid var(--line);position:relative}
.tl li:before{content:"";position:absolute;left:-6px;top:14px;width:10px;height:10px;border-radius:5px;background:var(--c-listen)}
.tl .d{font-weight:700;color:var(--navy);margin-right:6px}
#copy-box{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
button{font:600 15px inherit;font-family:inherit;background:#007aff;color:#fff;border:0;border-radius:10px;padding:10px 18px;cursor:pointer}
#out{margin-top:10px}#status{font-size:13px;color:var(--dim)}
@media (max-width:600px){h1{font-size:22px}.card{padding:12px}
table.hops thead{display:none}table.hops tr{display:grid;grid-template-columns:28px 1fr;border-bottom:1px solid var(--line);padding:6px 0}
table.hops td{border:0;padding:2px 4px}table.hops td.n{grid-row:span 4}
table.hops td[data-l]:before{content:attr(data-l) " · ";color:var(--dim);font-size:12px}
td.cite{min-width:0;max-width:none}}
"""

JS = r"""
(function(){
  var KEY='fly2786-reply-v1';
  function load(){try{return JSON.parse(localStorage.getItem(KEY)||'{}')}catch(e){return {}}}
  function save(s){try{localStorage.setItem(KEY,JSON.stringify(s))}catch(e){}}
  var st=load();
  document.querySelectorAll('textarea[data-k]').forEach(function(t){
    if(st['c:'+t.dataset.k]) t.value=st['c:'+t.dataset.k];
    t.addEventListener('input',function(){st['c:'+t.dataset.k]=t.value;save(st)});
  });
  document.querySelectorAll('input[type=radio][data-k]').forEach(function(r){
    if(st['r:'+r.dataset.k]===r.value) r.checked=true;
    r.addEventListener('change',function(){if(r.checked){st['r:'+r.dataset.k]=r.value;save(st)}});
  });
  function mark(id){
    document.querySelectorAll('.on').forEach(function(e){e.classList.remove('on')});
    var row=document.getElementById('row-'+id), g=document.querySelector('[data-hop="'+id+'"]');
    if(row){row.classList.add('on');row.scrollIntoView({block:'center',behavior:'smooth'})}
    if(g) g.classList.add('on');
  }
  document.querySelectorAll('g.hop[data-hop]').forEach(function(g){
    g.addEventListener('click',function(){mark(g.dataset.hop)});
    g.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();mark(g.dataset.hop)}});
  });
  document.querySelectorAll('tr[id^="row-"]').forEach(function(tr){
    tr.addEventListener('click',function(){
      var id=tr.id.slice(4);document.querySelectorAll('.on').forEach(function(e){e.classList.remove('on')});
      tr.classList.add('on');var g=document.querySelector('[data-hop="'+id+'"]');if(g){g.classList.add('on')}
    });
  });
  function build(){
    var lines=['FLY-2786 语音架构 · 我的意见',''];
    document.querySelectorAll('[data-order]').forEach(function(sec){
      var parts=[];
      sec.querySelectorAll('input[type=radio][data-k]:checked').forEach(function(r){parts.push(r.dataset.title+' → '+r.value)});
      sec.querySelectorAll('textarea[data-k]').forEach(function(t){var v=t.value.trim();if(v) parts.push('意见:'+v)});
      if(parts.length){lines.push('【'+sec.dataset.order+'】');parts.forEach(function(p){lines.push('- '+p)});lines.push('')}
    });
    if(lines.length<=2) lines.push('(还没有选择或填写任何意见)');
    return lines.join('\n');
  }
  var btn=document.getElementById('copy'),out=document.getElementById('out'),status=document.getElementById('status');
  btn.addEventListener('click',function(){
    var text=build();out.value=text;out.hidden=false;
    function fallback(){out.focus();out.select();status.textContent='自动复制没成功,文字已选中,按 ⌘C 复制'}
    try{
      if(navigator.clipboard&&navigator.clipboard.writeText){
        navigator.clipboard.writeText(text).then(function(){status.textContent='已复制,可以直接贴回 thread'},fallback);
      }else fallback();
    }catch(e){fallback()}
  });
})();
"""


def ev(items):
    return '<ul class="ev">' + "".join(f"<li>{i}</li>" for i in items) + "</ul>"


def c(s):
    return f"<code>{E(s)}</code>"


F = "<span class='lbl fact'>实证</span>"
I = "<span class='lbl inf'>推断</span>"
H1 = "<span class='lbl fact'>历史实证</span>"
P1 = "<span class='lbl fact'>生产实证</span>"
L1 = "<span class='lbl fact'>当前本机实证</span>"
N = "<span class='lbl nov'>未验证</span>"

body = []
body.append(f"""
<h1>语音架构:今天慢在哪 · 9 月初为什么快 · 往哪走</h1>
<p class="sub">FLY-2786 · 2026-09-23 · 只做调研和画图,没改任何代码、配置和服务 · 每个数字都注明出处,没有出处的写「未测」</p>

<section data-order="0 结论">
<div class="card blue big">
<p><b>① 今天慢,主要不是「听」慢,是每一句都要跑完 Raya 一整轮,再加好几层「搬运/轮询」。</b>
你 03:05Z 那场的留痕算出来:说完到听到第一个字,两句分别 <b>≈38s</b> 和 <b>≈18s</b>;其中「听懂」只占 1–2s,「Raya 想」8–12s,剩下全是搬运和空等(最长一段 12.7s 是话已经进了 Raya 的邮箱、在等被取走)。</p>
<p><b>② 漏听是真的:</b>03:07:11–16 你说了约 5 秒,识别出来了,但系统没对上「这是谁说的」,整句被丢掉。Raya 在下一句回答里也说了「中间还说了别的,那部分我没收到」。</p>
<p><b>③ 9 月初快,是因为语音模型自己答</b>:那版用 Codex 自带的实时语音,模型 {c("create_response:true")} 自己先回答,只有需要查/做的事才调 {c("background_agent")} 交给后台 Codex。</p>
<p><b>④ 建议方向(等你定):方案 A「前台快答 + 后台 Raya」</b>,就是把 9 月初的形状搬到今天能跑通的直连通道上,而且后台可以是任何 Lead。要你拍板的核心只有一件事:<b>允许前台用自己的话回答</b> —— 这会改掉你 09-08 定的「每句都进 mailbox、由 Lead 回答」,简单的话不再经过 Lead。</p>
</div>
{legend()}
</section>

<section data-order="1 实测时间线">
<h2>1 · 实测:你说完之后,时间花在哪</h2>
<div class="card amber">
<div class="svg-wrap">{timeline_svg()}</div>
<p class="segs">{seg_note()}</p>
<p class="sub">数据源(全部只读):会话 {c("c1b4b972")} 的 {c("~/.flywheel/voice/sessions/c1b4b972-…/events.jsonl")} 与 {c("journal.jsonl")};Raya 邮箱 {c("comm.db mailbox seq 283/285")};{c("teamlead.db voice_outbound seq 3/4")};Discord 消息 id 自带毫秒时间戳。U1=「你在念什么东西啊?…」,U2=「你有听见我刚才在说的话吗?」。「说完」取本地人声门关门的记录时间(误差 &lt;0.5s)。念完还要再加音频本身 5.7s / 9.2s。</p>
{ev([
 F+"这一场本地人声门记了 11 段,真放行 4 段 → OpenAI 合成 3 条输入 → 2 条到了 Raya。丢的那条状态是 "+c("skipped_unknown")+"(转写成功,说话人为空 → 丢弃,"+c("packages/voice-codex/src/realtime.ts:739-761")+")。",
 F+"一进房就先念「已进语音频道,正在等音频…」:那是 Raya 发在主频道的连接状态,语音进程同时轮询主频道和 thread,把它当回复念了("+c("packages/teamlead/src/bridge/voice-session-provisioner.ts:426")+";"+c("voice_outbound seq 2")+")。",
 I+"U1 那 12.7s 与「Bridge 空闲时 30s 才轮询一次」量级吻合;为什么门铃没立刻叫醒 Raya,还没定位。",
 N+"只有一场、两句,只能说明量级,不能当平均值。",
])}
{comment("timeline","实测时间线")}
</div>
</section>
""")

body.append(f"""
<section data-order="2 现状·随身语音">
<h2>2 · 现状三种模式</h2>
<div class="card gray">
{figure("rg")}
<p><b>为什么你「先看到文字、过一会儿才听到」</b>:第 6 步先把你的话以文字发进 thread;Raya 的回答也是先发成文字(第 10 步),语音这边要靠第 11、12 两层轮询<b>事后发现</b>它,再整段合成(第 14 步)。从 Lead 到语音进程没有推送。</p>
{comment("rg","现状 ① 随身语音")}
</div>
</section>

<section data-order="3 现状·耳机模式">
<div class="card red">
{figure("hp")}
<p><b>结论:耳机模式今天不是一个能用的语音通道。</b>它是 7 月 FLY-546 的设计:把 Discord 文字念给你、你的回复以文字 @ Lead 发出;它自己没有脑子。代码({c("packages/voice-headphone")})是「桌面试运行版」:念到 Mac 本机扬声器、不进语音房,语音输入也没接;本机没有部署它(无 launchd、无进程、无状态文件)。它要用的 Bridge 接口倒是一直在。</p>
{comment("hp","现状 ② 耳机模式")}
</div>
</section>

<section data-order="4 现状·会议模式">
<div class="card amber">
{figure("mt")}
<h3>会议的延迟来源(你怀疑它也有同样问题 —— 外层的等待确实一样;端到端会不会更慢,没测过,说不准)</h3>
{ev([
 F+"会中每一句<b>复用和随身语音同一个语音进程和 Bridge 外层</b>:镜像、邮箱、两层轮询、整段合成这些等待机制都在;"+c("mode")+" 在语音进程里只改 evidence 路径、会议信号文件、健康 id("+c("packages/voice-codex/src/cli.ts:65-72,280-309")+"、"+c("daemon.ts:703-706")+")。",
 F+"但「收件 → Lead 想 → 回帖」这段<b>随被挂的 Lead 而变</b>("+c("voice-session-start.ts:155-189")+" 按 "+c("meeting.leadId")+" 选):挂 Raya 时可参考第 1 节实测;挂别的 Lead 时这段没有任何测量。",
 F+"多人时:同一时刻只收一个人的声音,别人重叠说话直接不收("+c("packages/voice-codex/src/discord-room.ts:309-316")+");一句话里混了两个人,说话人归属就返回空 → 整句丢("+c("speaker-attribution.ts:45-50")+")。会议比随身更容易漏。",
 N+"挂 Claude Lead(Opus/Fable)时,「邮箱 → Lead」这一段走的是 tmux 里的收件轮询,节奏没读、没测;Claude Lead 会不会把 🗣️ 镜像文字当新消息再吃一遍,也没找到防护代码。",
 F+"生产库 "+c("voice_sessions")+" 一共只有 2 行,都是 rg;<b>会议模式从没在生产跑过</b>,所以会议端到端延迟「未测」,不能和随身语音比快慢。",
 F+"会后纪要是每 120s 一次的 tick 派 Runner 写("+c("scripts/meeting-notes-scheduler.ts:437-439,525-548")+"),不影响会中延迟。",
])}
{comment("mt","现状 ③ 会议模式")}
</div>
</section>

<section data-order="5 为什么变成这样">
<h2>3 · 为什么从「自带脑子」变成今天这样</h2>
<div class="card gray">
<ul class="tl">
<li><span class="d">08-26</span>Raya 仓 {c("apps/voice")}:独立进程 + Codex app-server 实时语音 v2,模型自己答、难的交后台 Codex(raya {c("6dc0b06")}「implement realtime Codex transport」)。</li>
<li><span class="d">09-02 前后</span>你亲测,体感好;这版<b>没有逐句延迟留痕</b>(Raya 数据目录只有 08-27 的 19 行)。</li>
<li><span class="d">09-08</span>你定了四条(F1–F4):一个独立 voice 进程,<b>任何 Lead(含 Claude Lead)开会都能挂</b>;语音转成文字进 mailbox,<b>和文字走完全同一条路</b>;Lead 回复经 Bridge 交给 voice 念;会议所有 Lead 都要有,随身先给 Raya({c("engineering/doc/FLY-2446-generic-voice-process/exploration.md:13-20")})。</li>
<li><span class="d">09-09</span>FLY-2446 落地:实时模型降成「前台」,脑子改成 Lead。当时还在 app-server 上,「不许自己答」只能靠提示词压({c("4eeaeda51")})。</li>
<li><span class="d">09-22</span>FLY-2655:app-server 的实时语音在生产收不到回话(「979 条真人音频已被 app-server 收到;session.created 被标记 unsupported realtime v2」,{c("FLY-2655 exploration.md:54")}),改为直连 OpenAI,并定「Realtime 只做 STT/TTS,不得独立回答」({c("realtime.ts:163-176")})。当时已登记「分段串行让回复延迟翻倍」待修。</li>
</ul>
<p><b>一句话:</b>拆成「嘴耳在前、脑子在 Lead」是为了满足 09-08 的四条(任何 Lead 可挂、语音文字一条路);代价是每一句都要付一整轮 Lead 的时间。这个代价当时没有被量出来,今天第一次量到了。</p>
</div>
</section>
""")

body.append(f"""
<section data-order="6 方案 A 前台快答+后台 Raya">
<h2>4 · 三个方向</h2>
{scheme_card("A", "green", [
 ("延迟预期", "简单问题:和 9 月初同一个模型、同样 500ms 静音判定后<b>自动回答</b>,本管线<b>未测</b>;参考值 0.86s 来自另一条自带脑子管线(Gemini Live)的真人实测("+c("FLY-1347 voice-measurement-pack.md:17")+")。交给 Lead 的问题:马上有一句口头回应;答案本身 ≈ 转写 1–2s + Lead 一轮 8–12s + 少量搬运 ≈ <b>10–15s</b>(推断,需要同时修管道)。"),
 ("记忆 / 能力从哪来", "快答只知道我们塞给它的:人设、记忆摘要、当前 thread 近况。<b>没有 Lead 的工具和实时状态</b>。凡是要事实、要动作、要承诺的,必须交给 Lead。"),
 ("和 Lead 在做的工作冲不冲突", "快答完全不碰 Lead;只有交办的那句占 Lead 串行队列里的一个 turn(和今天一样)。"),
 ("实现量", I+"中。改语音进程的会话配置与事件处理(工具调用、流式出声、打断);邮箱/Bridge 通路基本复用。"),
 ("风险", "① 前台会把能力说大、编事实、说「我已经做了」(FLY-1851 记录过;9 月初 Raya 靠「效果权威规则」压:"+c("raya apps/voice/src/cli.ts:98-104@b1b5a64")+");② 前台和 Raya 本人说法可能不一致,要让你分得清是谁在说;③ 打断要重新设计(今天是关的);④ Lead 事后看不到前台说过什么,除非做上面的留痕。"),
 ("对 Claude 系 Lead", "交办那头就是今天的文字邮箱,与厂商无关 ⇒ Opus / Fable Lead 也能挂。"),
 ("要推翻你之前的哪些决定", "<b>两条</b>:① 你 09-08 定的 F2/F3「语音转成文字进 mailbox、和文字走完全同一条路、由 Lead 回复」—— 快答句<b>不进</b> Lead 的 mailbox,Lead 不知道前台说了什么;② 09-22 定的「Realtime 不得独立回答」。仍保留:F1(独立语音进程、任何 Lead 可挂)、F4(会议通用);交办句仍走文字通路。"),
 ("快答说的话留在哪", N+"今天语音进程只把<b>你的</b>话镜像进 thread("+c("delivery.ts:119-171")+"),前台自己说的话没有去处。方案需新增「🤖 前台:…」字幕行(拟议);今天 Bridge 的回程轮询恰好排除 "+c("🤖")+" 开头的消息("+c("voice-session-poller.ts:12,36-43")+"),所以不会被当成 Lead 回复再念一遍。Lead 自己的收件会不会读到这行:Codex Lead 有忽略作者名单("+c("CodexDiscordGateway.ts:100,183")+"),Claude Lead 未验证。"),
], "推荐。它拿回「简单的马上答」,保留「任何 Lead 可挂」;代价是快答句不再走「每句都由 Lead 回答」这条你之前定的路。OpenAI 官方示例把这种形状列为第一种语音代理模式(Chat-Supervisor)。")}
{choice("A", "方案 A", ["要", "要,但要改(写在下面)", "不要"])}
{comment("A","方案 A")}
</section>

<section data-order="7 方案 B 9 月初自带脑子">
{scheme_card("B", "purple", [
 ("延迟预期", "快(模型自动回答),但<b>没有逐句实测留痕</b>,只有你 9 月初的体感。"),
 ("记忆 / 能力从哪来", "第二个 Codex 线程,启动时带 IDENTITY + MEMORY 文件,能跑命令;<b>不是 Raya Lead 那个正在工作的会话</b>,看不到 Raya 此刻在做什么。"),
 ("和 Lead 在做的工作冲不冲突", "不占 Lead(独立进程)。代价是<b>同时有两个 Raya 大脑</b>,这正是 09-09 要消掉的东西("+c("FLY-2445 plan.md@04ff8800a:150")+")。"),
 ("实现量", "代码在 raya 仓历史里,是「历史复原候选」,<b>不是今天能直接打开的功能</b>:生产实证 app-server 实时语音被标 unsupported("+c("FLY-2655 exploration.md:54")+");当前本机实证(2026-09-23)Raya 在跑的 Codex 0.154.0 "+c("codex features list")+" → "+c("realtime_conversation removed false")+"。要走通得换/锁 Codex 版本,那是全舰共用的载体。"),
 ("风险", "高,而且被上游版本卡住;只有 Codex Lead 能用。"),
 ("对 Claude 系 Lead", "不可用:只有 Codex 有这套实时语音。"),
], "不推荐:体验最像你喜欢的那版,但今天跑不通,且会重新长出第二个大脑。")}
{choice("B", "方案 B", ["要", "要,但要改(写在下面)", "不要"])}
{comment("B","方案 B")}
</section>

<section data-order="8 方案 C 只修管道">
{scheme_card("C", "blue", [
 ("延迟预期", "下限 ≈ 转写 1–2s + Raya 一轮 8–12s ≈ <b>10–15s</b>(推断,用第 1 节实测拆出来的)。"),
 ("记忆 / 能力从哪来", "完整的 Raya。"),
 ("和 Lead 在做的工作冲不冲突", "和今天一样:每句一个 turn,和其他工作排队。"),
 ("实现量", I+"小到中,风险低。"),
 ("风险", "低;但单做它到不了 9 月初的体感。"),
 ("对 Claude 系 Lead", "可用(文字邮箱)。"),
], "作为方案 A 的一部分一起做(A 交给 Lead 的那一半也要这些修复),不建议单独作为终点。")}
{choice("C", "方案 C", ["作为 A 的一部分", "先单独做它", "不要"])}
{comment("C","方案 C")}
</section>
""")

body.append(f"""
<section data-order="9 问题1 Raya 的 Codex 直接语音">
<h2>5 · 你的三个问题</h2>
<div class="card blue">
<h3>Q1 · 能不能直接让 Raya 的 Codex 用语音跟我聊天?</h3>
<p class="big"><b>历史上 Codex app-server 有过实验性的实时语音接口,9 月初那版(另起的第二个 Codex 进程)就是用它做的;但今天没有一条已证可用、受支持、能直接挂到 Raya 本人线程上的 Codex 原生语音。行得通的是方案 A。</b></p>
{ev([
 H1+"Codex app-server 有过 "+c("thread/realtime/{start,appendAudio,appendText,appendSpeech,stop,listVoices}")+" 与 "+c("outputAudio/delta")+"、"+c("transcript/*")+" 通知("+c("FLY-2446 exploration.md:56-70")+",源码 rust-v0.153.2 核过);9 月初 Raya 仓就是用它("+c("raya apps/voice/src/codex/RealtimeTransport.ts:181@f669d1b")+")。",
 H1+"但那是 Raya 仓<b>另起的第二个 Codex 进程</b>("+c("raya apps/voice/src/codex/CodexLeg.ts:115-134@f669d1b")+"),不是 Raya Lead 本人的会话。我们和 Raya Lead 之间只送文字("+c("packages/teamlead/src/lead-backends/codex/CodexTurnExecutor.ts:157-160")+")。",
 P1+"今天在生产不通:「979 条真人音频已被 app-server 收到;session.created 被标记 unsupported realtime v2」("+c("FLY-2655 exploration.md:54")+")。",
 L1+"截至 2026-09-23T03:46Z:Raya 在跑的 Codex("+c("~/.codex-raya/…/0.154.0")+")"+c("codex features list")+" → "+c("realtime_conversation removed false")+";本机另一个 0.153.2 → "+c("under development false")+"。两个都是关着的。",
 I+"就算修通,让 Raya 本人那个线程直接开口也会撞上:它同时在处理 Discord、督办 Runner,还和你在终端里的 TUI 共用同一个线程("+c("codex-lead-tui-runtime.ts:18-22")+")。",
])}
{comment("q1","Q1")}
</div>
</section>

<section data-order="10 问题2 Claude 系 Lead">
<div class="card blue">
<h3>Q2 · 其他用 Opus / Fable 的 Lead 没法原生用 Codex CLI 的功能,怎么办?</h3>
<p class="big"><b>你说得对,Codex 的原生语音只有 Codex Lead 有。所以语音不应该绑在 Codex 上 —— 方案 A / C 的「后台」接口就是文字邮箱,Opus / Fable Lead 一样能挂。</b></p>
{ev([
 F+"今天语音的「脑」接口已经是纯文字进出,与厂商无关:进 = "+c("chat-ingest")+" 写邮箱("+c("packages/voice-codex/src/delivery.ts:30-40")+"、"+c("adapters.ts:113-142")+");出 = Bridge 轮询 thread 里 Lead bot 发的文字("+c("packages/teamlead/src/bridge/voice-session-poller.ts:36-43")+")。",
 F+"起会不看 Lead 是 Codex 还是 Claude("+c("voice-session-start.ts:96-134")+");"+c("projects.json")+" 里所有 Lead 都开了 "+c("voiceModes.meeting")+",只有 Raya 开了随身。",
 N+"Claude Lead 收件那一段的节奏、以及会不会把 🗣️ 镜像当新消息再吃一遍(Codex 侧有防护 "+c("CodexDiscordGateway.ts:100,183")+",Claude 侧没找到)—— 都没验证。生产从没跑过一场 Claude Lead 会议。",
 I+"方案 B(Codex 自带实时语音)只能给 Codex Lead 用,这是它的硬伤之一。",
])}
{comment("q2","Q2")}
</div>
</section>

<section data-order="11 问题3 语音时其他工作能否继续">
<div class="card blue">
<h3>Q3 · Lead 过来跟我开耳机模式或开会时,原本的工作还能继续吗?</h3>
<p class="big"><b>今天:已派出去的 Runner 照跑;但 Lead 本人每听你一句就要停下来跑完这一轮,别的消息排在后面,反过来她在忙别的时你的话也要排队。</b></p>
{ev([
 F+"语音进程是独立进程、独立租约,不占 Lead("+c("packages/voice-codex/src/daemon.ts:432-444")+")。",
 F+"但你的每一句都是 Lead 串行队列里的一个 turn,和 Discord 回复、邮箱、Runner 督办是同一个循环、同一个线程,一次只跑一个("+c("LeadInputRouter.ts:2-8,285-302")+"、"+c("CodexTurnExecutor.ts:136-138")+");队列里没有给语音的优先通道。",
 F+"耳机模式今天没部署;按设计它本来就不进 Lead,只是把 Lead 的文字念给你。",
 I+"方案 A:快答不碰 Lead,只有交办的那句占一轮 —— 开会时 Lead 大部分时间可以继续干活。方案 B:完全不占,但那是另一个大脑。",
])}
{comment("q3","Q3")}
</div>
</section>

<section data-order="12 需要你拍板">
<h2>6 · 需要你拍板的事</h2>
<div class="card amber">
{choice("d1", "① 允许前台(OpenAI 实时模型)用自己的话回答简单问题吗?(会改掉你 09-08 的「每句进 mailbox 由 Lead 答」和 09-22 的「不得独立回答」)", ["允许", "只允许寒暄和确认,事实一律交 Lead", "不允许"])}
{choice("d2", "② 前台说的和 Raya 说的,你想怎么区分?", ["字幕里分开标(前台 / Raya)", "声音上区分", "不用区分"])}
{choice("d3", "③ 会议模式:先用一个 Claude Lead 在测试房真跑一场再说?", ["要", "不急", "不要"])}
{comment("decide","拍板项补充", 3)}
</div>
</section>

<section>
<h2>7 · 复制我的回复</h2>
<div class="card green">
<p>把上面所有的选择和意见汇总成一段文字,贴回 FLY-2781 thread 即可。没填的部分会自动跳过。</p>
<div id="copy-box"><button id="copy" type="button">复制我的回复</button><span id="status" role="status"></span></div>
<textarea id="out" rows="10" hidden readonly></textarea>
</div>
</section>

<section>
<h2>8 · 诚实边界</h2>
<div class="card gray">
{ev([
 "实测只有 09-23 03:05Z 一场、两句话;数字是量级,不是平均。",
 "9 月初那版没有逐句延迟留痕;「快」来自你的体感和代码形状(自动回答),不是测量。",
 "会议模式生产从没跑过,端到端延迟未测,不与随身语音比快慢;Claude Lead 收件那一段未读实现、未测。",
 "本机 Codex 版本与功能开关会变,文中的 Codex 事实均为 2026-09-23T03:46Z 的快照。",
 "方案 A / C 的「预期延迟」是用今天实测拆出来的推断;方案里标「未验证」的箭头今天都不存在。",
 "耳机模式:调研初稿曾误写「Bridge 缺接口 ⇒ 起不来」,评审时已核实接口存在并改正。",
 "本页引用的 raya 仓代码来自本机历史快照(raya 仓 "+c("f669d1b")+" / "+c("b1b5a64")+"),不在 flywheel 仓。",
 "本单没有改代码、配置、服务,没有开语音会话,没有跑付费探针。",
])}
</div>
</section>
""")

doc = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>语音架构讨论</title>
<style>{CSS}</style></head>
<body><main>
{''.join(body)}
</main>
<script>{JS}</script>
</body></html>
"""

OUT.write_text(doc, encoding="utf-8")

# ---- self-check: every arrow has a file:line citation or 未验证 ----
bad = []
for key, d in DIAGRAMS.items():
    for i, h in enumerate(d["hops"], 1):
        if not (re.search(r"[\w/.-]+\.(ts|md|jsonl|sh):\d", h["cite"]) or re.search(r"(:\d+@[0-9a-f]{7}|@[0-9a-f]{7,9}:\d)", h["cite"]) or "未验证" in h["cite"]):
            bad.append(f"{key}#{i}: {h['cite']}")
if bad:
    print("CITE-CHECK FAIL:\n" + "\n".join(bad)); sys.exit(1)
n = sum(len(d["hops"]) for d in DIAGRAMS.values())
print(f"wrote {OUT} ({OUT.stat().st_size} bytes); {len(DIAGRAMS)} diagrams, {n} arrows, all cited")
