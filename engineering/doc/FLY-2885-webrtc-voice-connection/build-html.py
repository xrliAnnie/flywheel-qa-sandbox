#!/usr/bin/env python3
"""Build the FLY-2885 founder design page: inline local mmdc SVGs, one nonced script, no external fetches."""
import html
import pathlib
import re

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE / "fly2885-webrtc-voice-design.html"


def svg(n: int) -> str:
    path = HERE / f"d{n}.svg"
    if not path.exists():
        return ('<div class="pending">DIAGRAM PENDING LOCAL RENDER — Mermaid 源文件 '
                f'd{n}.mmd 保留在同目录</div>')
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"<\?xml[^>]*>", "", text)
    # shrink long float coordinates (stateDiagram bloat) without changing the picture
    text = re.sub(r'="[^"]*"', lambda m: re.sub(r"(\d+\.\d{2})\d+", r"\1", m.group(0)), text)
    # stateDiagram edge/node ids are not scoped by --svgId; scope every id per diagram
    ids = sorted(set(re.findall(r'\sid="([^"]+)"', text)), key=len, reverse=True)
    for ident in ids:
        if ident.startswith(f"FLY-2885-d{n}"):
            continue
        scoped = f"d{n}-{ident}"
        text = text.replace(f'id="{ident}"', f'id="{scoped}"')
        text = text.replace(f"#{ident})", f"#{scoped})").replace(f'#{ident}"', f'#{scoped}"')
    return text


def esc(s: str) -> str:
    return html.escape(s, quote=True)


SECTIONS = []


def card(key: str, title: str, color: str, body: str) -> None:
    SECTIONS.append(
        f'<div class="card {color}" data-section="{esc(title)}">'
        f"<h2>{esc(title)}</h2>{body}"
        f'<div class="comment-box"><label for="c-{key}">对这一节的评论(自动保存在本机浏览器)</label>'
        f'<textarea id="c-{key}" data-key="{key}" placeholder="写下你的意见…"></textarea></div></div>'
    )


card("summary", "一句话结论", "green", """
<p class="lead-line"><b>把引擎 B 的连接从「WebSocket + API key」换成「WebRTC + ChatGPT 订阅」,音频在我们进程里直连 OpenAI,
你一开口我们就先在本地把它的声音静音;不需要 API key,延迟目标不劣于上次原型。</b></p>
<ul>
<li><b>WebRTC</b>:浏览器和视频会议用的实时音频连接方式,声音直接走网络,不经过文字消息通道。</li>
<li><b>ChatGPT 订阅</b>:用 Codex 已登录的 ChatGPT 账号计费(按说话时长计),不再用按量付费的 API key。</li>
<li>改动只影响「引擎 B」(现在只在测试语音房用);生产默认的旧引擎不动。</li>
</ul>
<div class="kpis">
<div class="kpi"><div class="v">0</div><div class="k">需要的 API key</div></div>
<div class="kpi"><div class="v">≤1.18 s</div><div class="k">说完→开口(程序端)上限</div></div>
<div class="kpi"><div class="v">≤1.0 s</div><div class="k">你插话后旧声音停下</div></div>
<div class="kpi"><div class="v">3 次</div><div class="k">断线自动重连上限</div></div>
</div>
""")

card("flow", "核心流程:声音怎么走", "blue", f"""
<div class="diagram">{svg(1)}</div>
<ul>
<li><b>房间进程</b>:我们在 Discord 语音房里的机器人进程,只听你(和测试白名单)的声音。</li>
<li><b>Opus</b>:一种语音压缩格式,Discord 和 WebRTC 都用它;上行我们只压一次,下行完全不解压、原样转交。</li>
<li><b>句首补 0.2 秒(pre-roll)</b>:人声检测判定你开口时,把判定前 0.2 秒也一起送出,避免吞掉第一个字——FLY-2799 已有,保留。</li>
<li><b>Codex 内核</b>:每场新开一个临时 Codex 进程,负责建会话、把需要动手的事交给 Lead 本体、朗读 Lead 的回复;它不碰音频。</li>
</ul>
""")

card("model", "数据与结构:一场会话里有什么", "purple", f"""
<div class="diagram">{svg(2)}</div>
<ul>
<li><b>软链</b>:一个指向别处文件的「快捷方式」。临时目录里的登录文件只是指向舰队共用的订阅凭据,<b>绝不复制</b>——复制会让两份凭据互相作废。</li>
<li><b>token</b>:模型计算文字长度的单位,中文大约一个字一个 token。</li>
<li><b>prompt / initialItems</b>:开场时交给模型的两类资料。prompt 放身份、边界、当前状态;initialItems 是「开场对话历史」,用来放记忆文件。</li>
<li><b>liveVoice</b>:新加的每个 Lead 的声线字段;旧引擎继续用原来的 realtimeVoice。你已选好的映射(Raya=sol、Tadashi=cove、Honey Lemon=breeze、CoS=vale 等 9 个,其余 cove)会写进 projects.json 这一处,运行时只读这里。</li>
</ul>
""")

card("findings", "实测发现:三件事改变了设计", "amber", """
<p>本单做了一个零额度探针 + 三场各几秒的实测会话(全程订阅、无 API key)。</p>
<div class="scroll"><table class="tbl">
<tr><th>发现</th><th>证据</th><th>设计怎么改</th></tr>
<tr><td><b>开场资料上限 16,384 token</b></td><td>约 17,000 token 的资料被服务端拒绝;13,700 token 通过,且模型答对了资料里的名字和暗号</td><td>Raya 的身份 + 记忆已约 15,600 token,必超。改为:身份/状态留在 prompt(≤15,500),记忆文件放进 initialItems(实测模型能用上)</td></tr>
<tr><td><b>新模型只有 9 个声线</b></td><td>juniper、maple、spruce、ember、vale、breeze、arbor、sol、cove;现在配置里的 marin / verse / alloy 全被拒</td><td>新增 liveVoice 字段,先全部用 cove;由 FLY-2866 改成请你试听这 9 个后分配</td></tr>
<tr><td><b>朗读不保证逐字</b></td><td>让它念「测试已经完成,谢谢你的配合」,一次念成「谢谢」,一次逐字</td><td>协议说明改成新模型的写法;朗读回执改用新协议的回合编号来对账,对不上就老实报「没确认念出来」;QA 量逐字率</td></tr>
</table></div>
""")

card("barge", "插话:你一开口,它的声音先停", "red", f"""
<div class="diagram">{svg(3)}</div>
<ul>
<li><b>为什么要本地做</b>:新协议<b>没有「取消回答」的指令</b>,服务端要听清你第一个字才判定插话(上次实测平均 1.16 秒)。我们在本地检测到你开口(约 0.3 秒)就<b>清空还没播出去的声音</b>并换成静音,你耳朵里约 0.5 秒就停了。</li>
<li><b>「取消」谁来做</b>:服务端判定插话后自己截断旧回答(上次 10/10 截断)。我们不重开连接(旧做法要 1 秒以上还会丢上下文)。</li>
<li><b>什么时候恢复播放</b>:静音期间我们把它发来的声音<b>录在一个 1.5 秒的小缓冲里</b>。服务端确认你在说话、你也停口之后,在录下的声音里找一段最长的空档(≥0.4 秒,截断旧回答后到新回答开始之间通常就是最长的那段):空档后面已有声音,就从那里回放,新回答从第一个字起完整;还没有,就等空档之后直接放。</li>
<li><b>为什么不用服务端的通知</b>:「开始新回答」的通知比声音晚约 0.9 秒,「你在说话」的确认有时也晚于新回答开头;通知里的时间戳和声音对不齐(偏差 0.77–0.93 秒且不固定)。所以只按声音本身找边界。</li>
<li><b>代价与上限</b>:确认来晚时,新回答会晚最多 1.5 秒才被听到(下一段停顿里追平);空档被挤出缓冲就只能从当下开始放,记录为「句首丢失」——这是有上限的失败,QA 会统计。</li>
<li><b>误判怎么办</b>:如果你只是咳了一声、服务端没当回事,3 秒后在它的一段长空档之后接着播,不会从半个字冒出来。</li>
<li><b>「先把旧句说完」</b>(上次 4/10):这是模型自己的选择,属于「大脑」层;本单只在协议说明里加一句「被打断就放弃没说完的话」,并在 QA 里量。</li>
</ul>
""")

card("guard", "朗读守卫:它编内容或不出声时怎么办", "red", """
<p>FLY-2866 试听时,新模型在 23 次朗读里有 <b>4 次念完原句后自己编了一段「工作汇报」</b>(「需求文档已补齐」之类),还有 1 次整段没声音。这是 Lead 的回复被念错,你会直接听到,所以本单专门防守:</p>
<ul>
<li><b>边播边比</b>:朗读 Lead 回复时,我们一边收它的文字转写一边和原文逐字对齐;对不上原文的字累计到 8 个(小改一两个字不算),就<b>立刻把后面的声音静音</b>,直到这一段回答结束;最坏 15 秒还在说,就重开连接把它掐断。</li>
<li><b>不外传</b>:编出来的内容不写进 thread 文字,只在审计记录里留长度和指纹;这一句的回执标为「没确认念对」。</li>
<li><b>无声</b>:能确认这一轮结束了、而且一个有声包都没播出,才自动重试一次;还不行就报「没能念出」,thread 里仍有文字。<b>说不清念没念</b>(对不上是哪一轮)时不重试,免得同一句念两遍。</li>
<li><b>做不到的</b>:文字转写比声音晚一点,编造的开头可能已经播出一小段。验收两项:我们判定后到声音停下 <b>≤0.2 秒</b>;你在房里听到编造内容的总时长(人工听录音标注)<b>≤1 秒</b>(≥20 次朗读,含最容易出问题的 spruce / vale / sol)。</li>
<li>自由聊天里的编造属于「大脑」层,这一单只守 Lead 回复的朗读。</li>
</ul>
""")

card("reconnect", "断线与收尾:不留锁、不留孤儿进程", "navy", f"""
<div class="diagram">{svg(4)}</div>
<ul>
<li><b>断线</b>:网络断、服务端断开或连接失败(几个信号同时来只算一次)→ 先确认旧会话已经关掉,再在同一个容器里重开一条连接,最多 3 次(间隔 0 / 2 / 5 秒);确认不了旧会话已关、或 3 次都失败,就干净结束并在 thread 里说一声。</li>
<li><b>为什么要先确认旧的关了</b>:服务端的「关闭 / 出错」通知不带是第几条连接,旧连接迟到的通知会被误当成新连接失败。</li>
<li><b>收尾顺序</b>:停上行 → 清空待播声音 → 通知服务端结束 → 关连接 → 停 Codex 进程(不听话就强杀)→ 删临时目录(只删软链本身,不伤凭据)。</li>
<li><b>孤儿进程</b>:实测我们的进程被强杀后,Codex 进程 1 秒内自己退出,不会残留。可能残留的只有临时目录,下次启动时先清掉;某个目录若还有进程在用就只记录不动。</li>
<li>重连后是一段<b>新的</b>实时会话:开场资料会重新带上,但刚才几句对话的上下文不会回放。</li>
</ul>
""")

card("noise", "远处人声:按音量把关", "amber", """
<p>新协议<b>没有可调的人声检测参数</b>,所以只能在我们这边把关。<b>dBFS</b> 是数字音频的音量刻度,0 最响,越负越轻。</p>
<div class="scroll"><table class="tbl">
<tr><th>声音(来自上次实测录音)</th><th>最响的一帧</th><th>结果</th></tr>
<tr><td>远处人声 60 秒(合成)</td><td class="n">−34.1 dBFS</td><td><span class="badge no">被拒</span> 低于门限</td></tr>
<tr><td>你最轻的一句(真人)</td><td class="n">−26.2 dBFS</td><td><span class="badge ok">放行</span></td></tr>
<tr><td>你平常说话</td><td class="n">−13 ~ −9 dBFS</td><td><span class="badge ok">放行</span></td></tr>
</table></div>
<p>门限默认 −30 dBFS,两边各约 4 dB 余量;看的是<b>一整句开头的最大音量</b>,不是每一帧,所以不会把你轻声的句子切碎。余量不大、远处人声是合成的,<b>可配置、可关</b>,QA 用你的真麦复核。</p>
""")

card("latency", "延迟:为什么要改人声检测的放行方式", "blue", """
<p>FLY-2799 的人声检测是一条「延迟线」:每一帧都要等 0.48 秒才放出去(0.28 秒判定 + 0.2 秒句首补音)。原型没有这一段,所以它的说完→开口是 0.98 秒;照搬会变成约 1.6 秒,超过验收上限 1.18 秒。</p>
<p><b>改法</b>:句首照旧判定和补音;一旦确认你在说话,后面的声音判完就放,并以两倍速把积压的 0.5 秒追平(原型用过同样的追赶方式)。你说完时,我们这边只剩一两帧没送出。</p>
<p>这个改动只在 WebRTC 房间打开,旧引擎的行为一个字节都不变。</p>
""")

card("tradeoffs", "关键取舍与否决的方案", "purple", """
<div class="scroll"><table class="tbl">
<tr><th>问题</th><th>选择</th><th>否决的做法与原因</th></tr>
<tr><td>上行怎么转</td><td>保留现有声音管线,只在末端压一次 Opus</td><td>真·零转码直转:要把人声检测改成逐包处理,动已回归的代码,收益只是少一次压缩</td></tr>
<tr><td>下行怎么转</td><td>Opus 原样推给 Discord 播放器</td><td>先解码再进旧播放器:多一次解码和压缩,还要自己切分句子</td></tr>
<tr><td>插话</td><td>本地先静音,服务端自己截断</td><td>整条连接重开:WebRTC 重连 1 秒以上,还丢对话上下文</td></tr>
<tr><td>Codex 版本</td><td>继续用已固定的 0.156.1</td><td>升级到 0.157.0:相关代码逐字相同,换版本只增加风险</td></tr>
<tr><td>登录</td><td>临时目录软链到舰队订阅凭据</td><td>复制凭据:会分叉刷新令牌,让舰队所有 Codex Lead 掉线</td></tr>
<tr><td>远处人声</td><td>句级最大音量门</td><td>每帧音量门:会把你轻声的句子切碎;调高人声阈值:先伤到你的轻声</td></tr>
<tr><td>声线</td><td>新字段 liveVoice,先全用 cove</td><td>自己拍脑袋把 marin 映射成某个新声线:应该由你亲耳选</td></tr>
</table></div>
""")

card("boundary", "诚实边界:做什么、不做什么", "red", """
<h3>这一单做</h3>
<ul>
<li>引擎 B 的连接换成 WebRTC + 订阅,环境里去掉 API key 仍能跑。</li>
<li>本地插话静音、断线重连、干净收尾、孤儿清扫、远处人声音量门、声线字段、朗读编造/无声守卫。</li>
<li>开场资料拆成 prompt + initialItems,让 Raya 这种大记忆的 Lead 也装得下。</li>
</ul>
<h3>这一单不做</h3>
<ul>
<li>「大脑」层:它说自己能做什么、只在被叫到时才回答、要不要叫你「小蓉」——另单。</li>
<li>切生产默认引擎、多人同时说话、旧引擎。</li>
<li>替你挑声线:9 个新声线需要你试听后分配(Lead 已并入 FLY-2866)。</li>
</ul>
<h3>做了也保证不了的</h3>
<ul>
<li>朗读 Lead 回复不一定逐字,编造的开头可能漏播一小段(≤1 秒);服务端判定插话仍约 1.2 秒(我们只是让你先听不到);插话后新回答的起点是估计的,偶尔会丢句首。</li>
<li>音量门余量约 4 dB,真人环境要复核。重连后刚才的对话上下文不回放。</li>
</ul>
""")

card("qa", "验收怎么证明", "green", """
<div class="scroll"><table class="tbl">
<tr><th>#</th><th>验收</th><th>怎么测</th></tr>
<tr><td class="n">1</td><td>无 API key 真人问答</td><td>检查语音进程和 Codex 进程的环境里都没有 API key;替身 5 问 + 你至少 3 问</td></tr>
<tr><td class="n">2</td><td>延迟不劣于原型 +20%</td><td>5 次短问:程序端 ≤1,182 ms,房里 ≤1,890 ms</td></tr>
<tr><td class="n">3</td><td>断网/杀连接</td><td>测试开关断一次连接 → 自动重连;强杀 Codex 进程 → 干净结束;两次后查无锁、无残留进程和目录</td></tr>
<tr><td class="n">4</td><td>2799 三项回归</td><td>回环排除、首帧即播、句首补音的测试全绿 + 听感</td></tr>
<tr><td class="n">5</td><td>插话</td><td>≥10 次:旧声音 1 秒内停 10/10;新回答从第一个字起听得到 ≥8/10;「找不到边界」「句首丢失」各 ≤1 次;新回答多等的时间中位数 ≤0.5 秒</td></tr>
<tr><td class="n">6</td><td>远处人声</td><td>放 60 秒远处人声零误触发;你轻声 3 句都被听到</td></tr>
<tr><td class="n">7</td><td>朗读守卫</td><td>≥20 次朗读:编造都被截住;判定后 ≤0.2 秒停;你听到的编造 ≤1 秒;thread 里没有编造内容;确认无声才重试</td></tr>
<tr><td class="n">8</td><td>9 个声线</td><td>各开 5 秒会话说一句,交给 FLY-2866 让你试听分配</td></tr>
</table></div>
""")

HEAD = """<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>语音 B WebRTC 设计</title>
<style>
:root{--bg:#f5f5f7;--card:#fff;--text:#1d1d1f;--dim:#86868b;--line:#e5e5ea;--red:#ff3b30;--amber:#ff9500;--blue:#007aff;--green:#34c759;--purple:#af52de;--navy:#1a365d;--greenbg:#eefaf1;--redbg:#fff1f0}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.65 -apple-system,system-ui,"PingFang SC","Hiragino Sans GB",sans-serif}
.wrap{max-width:960px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:24px;line-height:1.3;margin:0 0 6px;color:var(--navy)}h2{font-size:19px;margin:0 0 8px;color:var(--navy)}h3{font-size:15px;margin:14px 0 6px}
.sub{color:var(--dim);font-size:13px}
.card{background:var(--card);border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.06);padding:16px;margin:16px 0;border-left:4px solid var(--line)}
.card.red{border-left-color:var(--red)}.card.amber{border-left-color:var(--amber)}.card.blue{border-left-color:var(--blue)}.card.green{border-left-color:var(--green)}.card.purple{border-left-color:var(--purple)}.card.navy{border-left-color:var(--navy)}
ul{padding-left:20px;margin:6px 0}li{margin:3px 0}
.lead-line{font-size:16px}
.kpis{display:flex;flex-wrap:wrap;gap:10px;margin-top:10px}.kpi{flex:1 1 150px;background:#fafafc;border-radius:10px;padding:10px 12px}
.kpi .v{font-size:22px;font-weight:700;color:var(--navy)}.kpi .k{font-size:12px;color:var(--dim)}
.badge{display:inline-block;font-size:12px;line-height:1;padding:4px 8px;border-radius:10px;font-weight:600;white-space:nowrap}.ok{background:var(--greenbg);color:#1e7d32}.no{background:var(--redbg);color:#c4271d}
.scroll{overflow-x:auto;-webkit-overflow-scrolling:touch}
.tbl{width:100%;border-collapse:collapse;font-size:14px}.tbl th,.tbl td{text-align:left;vertical-align:top;padding:7px 6px;border-top:1px solid var(--line)}
.tbl th{font-size:12px;color:var(--dim);font-weight:600;border-top:none;white-space:nowrap}.tbl td.n{font-family:"SF Mono",ui-monospace,Menlo,monospace;font-size:13px;white-space:nowrap}
.diagram{background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px;margin:12px 0;overflow-x:auto}.diagram svg{display:block;margin:0 auto;max-width:100%;height:auto}
.pending{padding:24px;text-align:center;border:2px dashed var(--amber);border-radius:10px;color:#a35a00;font-weight:600}
.comment-box{margin-top:16px;padding-top:12px;border-top:1px dashed var(--line)}.comment-box label{font-size:13px;color:var(--dim);display:block;margin-bottom:6px}
.comment-box textarea{width:100%;min-height:60px;border:1px solid #d2d2d7;border-radius:8px;padding:10px;font-family:inherit;font-size:14px;resize:vertical;background:#fbfbfd;color:var(--text)}
.chunk{margin:10px 0;padding:10px;border:1px solid var(--line);border-radius:8px;white-space:pre-wrap;font-size:13px;background:#fbfbfd}
.chunk-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:12px;color:var(--dim)}
.btn{background:var(--navy);color:#fff;border:none;border-radius:8px;padding:8px 14px;font-size:14px;cursor:pointer}.btn.small{padding:4px 10px;font-size:12px}
#copy-status{margin-left:10px;font-size:13px;color:var(--dim)}.empty-note{color:var(--dim)}
</style></head><body><div class="wrap">
<h1>语音 B · 连接层:引擎 B 改走 WebRTC + ChatGPT 订阅</h1>
<div class="sub">FLY-2885 · 设计 · 2026-09-25 · 基于 FLY-2884 闸门结论 + 本单源码核对与三场几秒的实测</div>
"""

SUMMARY = """
<div class="card navy" id="summary-card"><h2>💬 你的评论汇总</h2>
<p class="sub">上面每一节的评论会实时汇总到这里(存在本机浏览器)。复制出来的文字以「【页面意见汇总】FLY-2885」开头;太长会自动分段,每段都带这个开头。这是修改意见,不代表通过。</p>
<div id="summary-list"></div>
<button class="btn" id="copy-all" type="button">复制全部评论</button><span id="copy-status"></span>
</div>
"""

SCRIPT = r"""
<script nonce="__CSP_NONCE__">
(function () {
  'use strict';
  var MARK = '【页面意见汇总】FLY-2885';
  var LIMIT = 1800;
  var PREFIX = 'fly2885:' + location.pathname + ':comment:';
  function lsGet(k) { try { return localStorage.getItem(PREFIX + k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(PREFIX + k, v); } catch (e) {} }
  var areas = Array.prototype.slice.call(document.querySelectorAll('textarea[data-key]'));
  function titleOf(a) { var c = a.closest('.card'); return (c && c.getAttribute('data-section')) || '未命名'; }
  function entries() {
    var out = [];
    areas.forEach(function (a) { var v = a.value.trim(); if (v) out.push('【' + titleOf(a) + '】' + v); });
    return out;
  }
  function chunks() {
    var list = entries(); if (!list.length) return [];
    var parts = [], cur = '';
    list.forEach(function (e) {
      while (e.length > LIMIT) { if (cur) { parts.push(cur); cur = ''; } parts.push(e.slice(0, LIMIT)); e = e.slice(LIMIT); }
      if (cur && (cur.length + e.length + 2) > LIMIT) { parts.push(cur); cur = ''; }
      cur = cur ? cur + '\n\n' + e : e;
    });
    if (cur) parts.push(cur);
    var n = parts.length;
    return parts.map(function (p, i) { return MARK + (n > 1 ? ' (' + (i + 1) + '/' + n + ')' : '') + '\n' + p; });
  }
  function fallbackCopy(t) {
    var ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta); return ok;
  }
  function setStatus(m) { var el = document.getElementById('copy-status'); el.textContent = m; setTimeout(function () { el.textContent = ''; }, 3000); }
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(t).then(function () { setStatus('✅ 已复制'); },
        function () { setStatus(fallbackCopy(t) ? '✅ 已复制' : '❌ 复制失败'); });
    } else { setStatus(fallbackCopy(t) ? '✅ 已复制' : '❌ 复制失败'); }
  }
  function render() {
    var list = document.getElementById('summary-list');
    while (list.firstChild) list.removeChild(list.firstChild);
    var cs = chunks();
    if (!cs.length) { var p = document.createElement('p'); p.className = 'empty-note'; p.textContent = '还没有评论。'; list.appendChild(p); return; }
    cs.forEach(function (c, i) {
      var box = document.createElement('div'); box.className = 'chunk';
      var head = document.createElement('div'); head.className = 'chunk-head';
      var lab = document.createElement('span'); lab.textContent = '第 ' + (i + 1) + ' 段 / 共 ' + cs.length + ' 段';
      var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn small'; btn.textContent = '复制这一段';
      btn.addEventListener('click', function () { copyText(c); });
      head.appendChild(lab); head.appendChild(btn);
      var body = document.createElement('div'); body.textContent = c;
      box.appendChild(head); box.appendChild(body); list.appendChild(box);
    });
  }
  areas.forEach(function (a) {
    a.value = lsGet(a.getAttribute('data-key'));
    a.addEventListener('input', function () { lsSet(a.getAttribute('data-key'), a.value); render(); });
  });
  render();
  document.getElementById('copy-all').addEventListener('click', function () {
    var cs = chunks(); if (!cs.length) { setStatus('没有可复制的评论'); return; }
    copyText(cs.join('\n\n'));
  });
})();
</script>
"""

page = HEAD + "".join(SECTIONS) + SUMMARY + "</div>" + SCRIPT + "</body></html>\n"
OUT.write_text(page, encoding="utf-8")
print(OUT, len(page.encode("utf-8")))
