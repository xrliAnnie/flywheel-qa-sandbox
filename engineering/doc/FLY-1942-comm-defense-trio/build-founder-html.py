"""Build the founder-facing design HTML for FLY-1942 (static artifact only)."""
from pathlib import Path
from html import escape

ROOT = Path(__file__).resolve().parent
DIAGRAMS = ROOT / "diagrams"
ISSUE = "FLY-1942"
ISSUE_URL = "https://linear.app/geoforge3d/issue/FLY-1942/通信层防线-三件套发信短-id-静默死信-bot-永久偷听-guard-误拦并-19431953"


def diagram(stem: str, caption: str) -> str:
    svg = DIAGRAMS / f"{stem}.svg"
    if svg.exists():
        return f'<div class="diagram">{svg.read_text()}</div><div class="cap">{escape(caption)}</div>'
    src = (DIAGRAMS / f"{stem}.mmd").name
    return (
        '<div class="pending" role="note"><strong>DIAGRAM PENDING LOCAL RENDER</strong>'
        f'<p>{escape(caption)}</p><p>图源保存在 diagrams/{escape(src)},本机渲染失败,未使用任何远程渲染服务。</p></div>'
    )


def table(headers, rows):
    h = "".join(f"<th>{escape(x)}</th>" for x in headers)
    b = "".join("<tr>" + "".join(f"<td>{c}</td>" for c in r) + "</tr>" for r in rows)
    return f'<div class="scroll"><table><thead><tr>{h}</tr></thead><tbody>{b}</tbody></table></div>'


sections = []

sections.append(("summary", "green", "01 · 一句话结论",
    '<p class="summary-line">三个通信层缺陷共用一个病根:<b>做判定的地方离真相太远,而失败的结果没有回到做决定的人手里。</b>这次把三处判定拉回可核的事实源,并让每一次拒绝或死信都带着读数回到发信方。</p>'
    '<p class="note">这是设计交付,不是实现完成。实现、测试与上线由后续阶段完成;文末「诚实边界」写明哪些验收要等条件成熟才能在生产回放。</p>'))

sections.append(("problem", "red", "02 · 出了什么事(全部有实测证据)",
    '<p><b>死信</b>是「投进信箱但永远没人收」的消息。<b>Lead</b> 是负责推进工作的组长 AI;<b>Runner</b> 是干活的执行体 AI;它们之间用一个共享数据库当信箱。</p>'
    + table(["件", "症状", "证据(2026-09-11 只读生产快照)"], [
        ["一 · 发信收件人", "Lead 用 8 位短编号给 Runner 发指令,命令行打印出消息 id 看起来成功,18 秒后静默变死信,零报错。", "近 30 天 206 条「收件人已终结」死信;其中 24 条收件人是 8 位短编号,全部来自工程 Lead,最近一条在 9-10 晚上,内容是给替身 Runner 的返工清单。每一个短编号当时都对应着一个正在运行、前缀唯一的完整会话。另有 141 条是引擎自己给刚结束的节点发的清理指令。"],
        ["二 · 订阅", "Codex 组长在圆桌频道被 @ 了一次,从此永久收听那个讨论线程并抢答创始人;订阅只存在进程内存里,磁盘上查不到,只能重启进程清掉。", "代码里订阅是一个内存集合:没有到期时间、没有上限(生产配置下)、没有落盘、没有审计;退订函数存在但没有任何运维入口能调到。"],
        ["三a · 部署护栏", "一条保护「不许手动重启 Flywheel 服务」的 Bash 护栏,按<b>字面有没有关键词</b>拦命令:文档正文、发给组长的消息里提到关键词也被拦;纯日历触发的内容定时任务因为名字前缀相同也被拦。", "护栏日志近 14 天 129 次判定:拦下的包括 heredoc 里写笔记的命令、给组长汇报的消息正文;子内容组长要重新启用一个日历任务只能走绕行通道,而绕行通道的告警腿又是死信。设计过程中本 runner 自己也被它拦了两次(编辑脚本正文引用了关键词)。"],
        ["三b · 回复路由守卫", "Discord 回复守卫以「Bridge 不健康」拒发跨部门消息,而同一刻三次探测 Bridge 都是毫秒级 200。", "守卫根本没有健康探针:它就是一次 1.5 秒超时的请求,超时或任何非 2xx(含 401)都当「不健康」,然后本地只看正文有没有单号——与 8-22 产品组长的实测推断完全一致。代码在插件 fork 仓,不在本仓。"],
    ])))

sections.append(("overview", "blue", "03 · 全景:一个病根,三处修法",
    diagram("d1-overview", "图 1 · 三个缺陷的共同病根与对应修法")
    + '<p>左侧是共同病根,中间是三件事今天的样子,右侧是修法方向。三处修法互不依赖,可以并行实现,但都遵守同一条原则:<b>判定用离真相最近的事实源,失败要带读数回到发信方。</b></p>'))

sections.append(("recipient", "blue", "04 · 第一件:发信前把收件人查清楚",
    diagram("d2-recipient", "图 2 · 发信路径的三层校验与死信通知回落")
    + '<p><b>三层校验</b>都在本地完成,不依赖网络:① 形态——只接受完整 UUID(36 位唯一编号)或至少 8 位的十六进制前缀;② 存在——查「会话血统表」(每个会话出生时登记、永不删除的表),前缀恰好命中一条才展开,零条或多条都当场报错;③ 终结——读 Bridge 状态库的只读快照,用<b>和信箱队列同一个判定函数</b>判「已终结」。</p>'
    '<p>为什么第三步要用同一个函数:队列在下一轮巡检里正是按这个函数决定要不要把消息标成死信。命令行用同一把尺子,就不会出现「命令行放行、队列却杀掉」或反过来「命令行拒掉一个其实还活着的 Runner」。特别地,一个<b>完成任务后停在原地等审阅的 Runner</b>(状态叫 awaiting_review)在这把尺子下算活的,仍然可以直接给它发信继续用,不必新开一个——这是现有的重接管合同,原样保留。</p>'
    '<p><b>引擎自己发的信</b>也过同一道门:发布后清理指令、账号切换唤醒这两处,发前先看收件人是否还活着,不活就跳过并在会话事件表里留一条痕迹,而不是先入队再死信。</p>'
    '<p><b>失败要回到发信方</b>:死信通知原来只发给「收件人所属的组长」,收件人不存在就永远发不出去。现在找不到所属组长时,按「收件人 + 发信方」分别回落给发信的组长,每位组长只看到自己的那些。</p>'
    '<p><b>规则同步</b>:组长的公共规则里新增一段——发信只用完整编号或 ≥8 位前缀;命令行会当场报四种错;记住消息 id,下一次巡检用 <code>message-status</code> 核对是否 ACKED(已被收下);打印出 id 不等于送达。</p>'))

sections.append(("subscription", "purple", "05 · 第二件:订阅变成有到期、可查可退的账本",
    diagram("d3-subscription", "图 3 · 订阅生命周期:只有一种方式进入,四种方式离开")
    + '<p><b>圆桌频道</b>是所有组长与创始人共处的跨部门协调频道;在里面 @ 某个组长会开一条话题线程。今天「被 @ 一次」就把那条线程永久加进组长的收听集合。</p>'
    '<p>改动后:① 订阅只能由<b>显式声明</b>的圆桌频道铸造,启动器不再把「第一个跨部门频道」偷偷当圆桌;② 订阅在消息<b>持久接受之后</b>才写入,重投递、写日志失败、过期后的旧消息重放都铸不出订阅;③ 写入顺序固定为「先写账本文件 → 再改内存 → 再开始轮询」,账本写失败时内存和轮询都不变,重启时若账本写不进去就干脆不启动,绝不带着空内存接流量把旧账本冲掉;④ 默认 24 小时无活动到期,每 60 秒巡检,上限 50 条;⑤ Discord 侧的线程发现只负责剔除已归档的条目、修复轮询槽,<b>不再新增</b>——到期或退订后想重新收听,必须再被 @ 一次;⑥ 提供 <code>list</code>(直接读账本文件,运行时不在也能看)与 <code>unsubscribe</code>(经认证的本地 socket)两个运维入口;每次变更都追加一行审计。</p>'))

sections.append(("guard-a", "amber", "06 · 第三件 a:部署护栏按「命令形态」判,不按字面",
    diagram("d4-guards", "图 4 · 护栏的新判定:命令头 + 目标形状 + 载荷是否会被执行")
    + '<p><b>PreToolUse 护栏</b>是每条 Bash 命令执行前都会先过的一道检查。它的目的没变:不许手动重启或杀掉 Flywheel 的常驻服务、不许绕过正规发布流程直起 Bridge。变的是<b>怎么判</b>。</p>'
    '<p>三条新规则:① <b>只看命令头</b>——把命令拆成管道段,每段真正执行的那个程序才是命令头;引号里带空格的整段文字、heredoc(多行文本块)正文都是「载荷」,不参与匹配。② <b>只有载荷会被执行时才把它当命令再扫一遍</b>——喂给 shell、eval、xargs,或者未引用定界符的 heredoc 里有 <code>$( )</code> 命令展开,这些形态照拦。③ <b>目标按形状而不是名字前缀</b>——核心服务(Bridge、各组长、独立更新器等)直接受保护;其他名字看它的 launchd 配置文件(plist)有没有常驻字段(KeepAlive / RunAtLoad / StartInterval),纯日历触发的内容定时任务不受保护;配置文件找不到时按受保护处理(宁可多拦)。</p>'
    '<p><b>拒绝要带读数</b>:拦下时写明命中哪条模式、哪一段命令、哪个目标、为什么算受保护,审计日志同样记录。既有的 84 条必拦样例、51 条必放样例与发布演练手册的零命中检查全部保留为合并门,另加 14 条新样例(含未引用 heredoc 展开与 eval)。</p>'))

sections.append(("guard-b", "amber", "07 · 第三件 b:回复路由守卫拒发时给可核的读数",
    diagram("d5-reply-guard", "图 5 · 回复守卫:问 Bridge;问不到时按频道分类,只拒真正该拒的")
    + '<p>这段代码在 Discord 插件的 fork 仓(不是本仓),要单独提 PR、走受管更新上线。三条改动:① 超时从写死的 1.5 秒改为可配(默认 4 秒),网络错重试一次,HTTP 状态不重试;401/403 单独归类为「凭证失效」,不再和「不可达」混成一个理由。② Bridge 问不到时,本地按频道分类,<b>镜像 Bridge 健康时的同一规则</b>:只有「自己聊天频道顶层 + 带单号」才拒;跨部门频道、圆桌线程、核心频道一律放行并记审计——跨组长的机制讨论再也不会因为引用了单号被断路。③ 拒绝文本附探针读数(地址、尝试次数、超时、状态或错误、延迟、时间、本地分类),并落一行审计到插件状态目录,事后可核。</p>'
    '<p>本仓要配合注入一个环境变量,告诉插件「你自己的聊天频道是哪个」。没注入时插件维持今天的宽拒绝但同样附读数,所以两个仓先后上线的顺序都安全。</p>'))

sections.append(("model", "gray", "08 · 数据与结构:新增了哪些稳定标识",
    table(["类别", "值", "含义"], [
        ["命令行错误码", "<code>recipient_malformed</code> / <code>recipient_not_found</code> / <code>recipient_ambiguous</code> / <code>recipient_terminal</code>", "形态不对 / 从未存在 / 前缀多义 / 已终结;另有 stderr 告警 <code>liveness_unverified</code>(状态库快照读不到时)"],
        ["死信原因", "新 <code>recipient_missing</code>;既有 <code>recipient_terminal</code> 收窄", "「收件人从未存在」与「收件人已终结」分开计数"],
        ["终态判定函数", "<code>isMailboxTerminalStatus</code>(下沉到 flywheel-comm 包,Bridge 状态库 re-export)", "命令行与队列共用的唯一一把尺子"],
        ["会话事件", "<code>instruction_skipped_recipient_missing</code> / <code>…_terminal</code>", "引擎跳过发信时的留痕,带项目、单号、来源"],
        ["死信通知 id", "所属组长路径不变;回落路径 <code>dead_letter:&lt;收件人&gt;:&lt;发信方&gt;:&lt;序号&gt;</code>", "按收件人 + 发信方隔离,互不覆盖"],
        ["订阅账本", "<code>roundtable-subscriptions.json</code> + <code>…-audit.jsonl</code>(组长状态目录)", "条目含线程、父频道、来源、订阅时间、最后活动、到期时间;审计 op:add / remove / expire / evict / restore / restore_failed / reject / persist_failed / source_failed"],
        ["环境变量", "<code>FLYWHEEL_ROUNDTABLE_CHANNEL_ID</code>(改为必需)、<code>FLYWHEEL_ROUNDTABLE_SUBSCRIPTION_TTL_MS</code>、<code>TEAMLEAD_REPLY_GUARD_TIMEOUT_MS</code>、<code>DISCORD_OWN_CHAT_CHANNEL</code>", "全部有默认值;缺失时行为向后兼容"],
        ["守卫理由", "<code>guard_unavailable</code> / <code>guard_unauthorized</code> / <code>guard_unavailable_legacy_broad</code>", "不可达 / 凭证失效 / 旧启动器未注入频道信息"],
        ["护栏审计字段", "<code>match: {pattern, segment, target, protected_by}</code>", "protected_by ∈ core / plist_shape:&lt;字段&gt; / plist_missing / restart_script"],
        ["插件版本", "0.0.7 → 0.0.8", "fork 仓 PR"],
    ])
    + '<p class="note">零数据库迁移:死信原因列没有约束,会话事件用现有接口,账本是新文件。回滚各自独立:命令行回到非空即过;订阅回到内存集合、账本成孤儿;护栏 revert 后重跑安装脚本即时生效;插件按既有回滚合同(revert 除版本号外全部并 +1)。</p>'))

sections.append(("tradeoffs", "purple", "09 · 关键取舍与放弃的方案",
    '<ul>'
    '<li><b>选:命令行在本地校验;放弃:在数据库写入函数里校验。</b> 写入函数被引擎多处复用,有「会话登记前先入队」的既有合同,改它会误伤引擎;命令行是组长和执行体真正用的入口。</li>'
    '<li><b>选:终结判定读 Bridge 状态库的只读快照;放弃:读信箱库自己的会话状态。</b> 执行体的适配器会独立把信箱库写成「completed」,而状态库那时可能是「等审阅」——用信箱库会把一个还能继续用的执行体拒掉。快照只可能少报终结,不会把活的报成死的。</li>'
    '<li><b>选:不提供任何「强行发给已终结收件人」的开关。</b> 队列下一轮就会杀掉它,开关是假的逃生口;测试用环境变量或依赖注入,不暴露公开参数。</li>'
    '<li><b>选:订阅账本留在组长进程里;放弃:集中到 Bridge。</b> 「持久接受」与「唤醒处理」必须在同一进程,这是既有设计;Bridge 挂了组长也得能读线程。</li>'
    '<li><b>选:线程发现只剔除不新增;放弃:靠 Discord 归档自动回收。</b> 后者依赖频道设置,还会在到期或退订后一个周期内把订阅复活。</li>'
    '<li><b>选:护栏按命令头 + 目标形状判;放弃:只把超时改大、或不可达时全放行。</b> 前者不解决跨部门被拦的根因,后者放弃了守卫的目的(单号内容漏到自己频道顶层)。</li>'
    '</ul>'))

sections.append(("boundary", "gray", "10 · 诚实边界:做什么、不做什么、哪些要等条件",
    '<div class="callout green"><b>做:</b>第一件(含引擎侧两处写入者)、第二件、第三件 a(优先)与 b、公共规则段;本仓一个 PR,插件 fork 一个 PR。</div>'
    '<div class="callout amber"><b>不做(记为边界,建议另开单):</b>巡检指标「积压归零假阴性」、告警脚本无凭证时的静默放行、护栏对「首次安装新服务」的放行、Claude 插件侧的线程成员缓存、把订阅集中到 Bridge、改「已订线程里人类无需 @」的语义。</div>'
    '<div class="callout red"><b>条件性验收:</b>「驱动一次回话,到期后订阅消失」在实现阶段只能用单元测试(假时钟、假消息源)证明;截至 2026-09-11 本机没有 Codex 组长运行时在跑(Codex 账号池已耗尽),生产回放要等 Codex 组长重新上线。</div>'
    '<p><b>评审轨迹:</b>Codex 设计评审 R1 6 项 HIGH → R2 4 项 → R3 2 项,每轮全部并入;R3 是工程组长设定的轮次上限,组长授权了唯一一轮 R4 确认轮(只核 R3 两项)。R4 结论:护栏一项已关闭;账本一项还剩一个启动时序窗口(网关先启动并读积压,恢复失败只是事后停)——已按 v5 改为两阶段启动(先恢复账本,成功后才启动网关),并按组长裁定以 leadAcceptance 交接,不再开 R5。计划最终版本 v5。</p>'
    '<p><b>上线顺序:</b>本仓 PR 合入 → 组长受管重启 → fork PR 合入 → 受管插件更新。fork 先上也安全。合并不等于部署,只有独立更新器在它的窗口部署。</p>'))

cards = []
for key, color, title, body in sections:
    cards.append(
        f'<section class="card {color}" id="{escape(key)}"><h2>{escape(title)}</h2>{body}'
        f'<div class="cbox"><label for="c-{escape(key)}">这一节的意见(自动保存在本机浏览器)</label>'
        f'<textarea id="c-{escape(key)}" data-key="{escape(key)}" data-title="{escape(title)}" placeholder="写下你希望调整的地方"></textarea></div></section>'
    )
cards.append(
    '<section class="card blue" id="comments"><h2>11 · 页面意见汇总</h2>'
    '<p class="note">下面实时汇总每一节非空的意见,前缀是节标题。复制后贴回讨论串才会被组长收到;汇总标记表示修改意见,不表示通过。</p>'
    '<div class="cbox"><label for="c-comments">对整体的意见</label><textarea id="c-comments" data-key="comments" data-title="11 · 页面意见汇总" placeholder="整体看法"></textarea></div>'
    '<div class="btnrow"><button type="button" class="btn" id="copy-all">复制全部意见</button><button type="button" class="btn sec" id="clear-all">清空</button><span id="copy-status" aria-live="polite" class="status"></span></div>'
    '<div id="comment-chunks"></div></section>'
)

CSS = """
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin:0; background:#f5f5f7; color:#1d1d1f; font-family:-apple-system,system-ui,"PingFang SC","Hiragino Sans GB",sans-serif; line-height:1.7; }
  .wrap { max-width:960px; margin:0 auto; padding:24px 16px 80px; }
  h1 { font-size:26px; margin:8px 0 4px; color:#1a365d; }
  .meta { color:#86868b; font-size:13px; margin-bottom:20px; }
  .meta code, code { font-family:'SF Mono',Menlo,monospace; font-size:12.5px; background:#f2f2f5; padding:1px 5px; border-radius:4px; }
  .card { background:#fff; border-radius:12px; box-shadow:0 1px 3px rgba(0,0,0,0.06); padding:20px 22px; margin:18px 0; border-left:4px solid #007aff; }
  .card.green { border-left-color:#34c759; } .card.red { border-left-color:#ff3b30; } .card.amber { border-left-color:#ff9500; } .card.purple { border-left-color:#af52de; } .card.gray { border-left-color:#86868b; }
  .card h2 { font-size:19px; margin:0 0 10px; color:#1a365d; }
  .summary-line { font-size:17px; line-height:1.6; }
  .note { color:#515154; font-size:14px; }
  .diagram { overflow-x:auto; padding:10px 0; text-align:center; }
  .diagram svg { max-width:100%; height:auto; }
  .cap { color:#86868b; font-size:12px; text-align:center; margin-top:4px; }
  .pending { border:2px dashed #ff9500; border-radius:8px; padding:14px; background:#fff8ec; }
  .scroll { overflow-x:auto; }
  table { border-collapse:collapse; width:100%; font-size:14px; margin:10px 0; }
  th,td { border:1px solid #e5e5ea; padding:8px 10px; text-align:left; vertical-align:top; }
  th { background:#fafafa; color:#1a365d; }
  ul { margin:8px 0; padding-left:22px; } li { margin:6px 0; }
  .callout { padding:10px 14px; margin:12px 0; border-radius:8px; font-size:14px; }
  .callout.red { background:#fff5f5; border-left:3px solid #ff3b30; color:#c0392b; }
  .callout.amber { background:#fff8ec; border-left:3px solid #ff9500; color:#8a5200; }
  .callout.green { background:#f0fbf3; border-left:3px solid #34c759; color:#1d7a3d; }
  .cbox { margin-top:16px; padding-top:12px; border-top:1px dashed #e5e5ea; }
  .cbox label { display:block; font-size:12px; color:#86868b; margin-bottom:4px; }
  .cbox textarea { width:100%; min-height:64px; border:1px solid #d2d2d7; border-radius:8px; padding:8px 10px; font:inherit; font-size:14px; resize:vertical; background:#fbfbfd; }
  .cbox textarea:focus { outline:none; border-color:#007aff; background:#fff; }
  .btnrow { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:10px 0; }
  .btn { background:#007aff; color:#fff; border:0; border-radius:8px; padding:8px 14px; font:inherit; font-size:14px; cursor:pointer; }
  .btn.sec { background:#e5e5ea; color:#1d1d1f; }
  .status { color:#86868b; font-size:13px; }
  .summary-box { white-space:pre-wrap; font-family:'SF Mono',Menlo,monospace; font-size:12.5px; background:#f2f2f5; border-radius:8px; padding:12px; min-height:60px; max-height:360px; overflow:auto; margin:8px 0; }
"""

SCRIPT = r"""
(function () {
  "use strict";
  var MARKER = "【页面意见汇总】FLY-1942";
  var CHUNK_LIMIT = 1800;
  var PREFIX = "flywheel:design-comments:" + location.pathname + ":";
  var areas = Array.prototype.slice.call(document.querySelectorAll("textarea[data-key]"));
  var chunksEl = document.getElementById("comment-chunks");
  var statusEl = document.getElementById("copy-status");
  function storageGet(k) { try { return localStorage.getItem(PREFIX + k) || ""; } catch (e) { return ""; } }
  function storageSet(k, v) { try { localStorage.setItem(PREFIX + k, v); } catch (e) {} }
  function storageDel(k) { try { localStorage.removeItem(PREFIX + k); } catch (e) {} }
  function collect() {
    var lines = [];
    areas.forEach(function (ta) {
      var v = ta.value.trim();
      if (v) lines.push("[" + ta.getAttribute("data-title") + "] " + v);
    });
    return lines;
  }
  function buildChunks(lines) {
    var chunks = [];
    if (lines.length === 0) return [MARKER + "\n(暂无意见)"];
    var current = MARKER;
    lines.forEach(function (line) {
      var candidate = current + "\n" + line;
      if (candidate.length > CHUNK_LIMIT && current !== MARKER) { chunks.push(current); current = MARKER + "\n" + line; }
      else { current = candidate; }
    });
    chunks.push(current);
    return chunks;
  }
  function copyText(text, onDone) {
    function fallback() {
      var ok = false;
      try {
        var ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.top = "-1000px";
        document.body.appendChild(ta); ta.select(); ok = document.execCommand("copy"); document.body.removeChild(ta);
      } catch (e) { ok = false; }
      onDone(ok);
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(function () { onDone(true); }, function () { fallback(); });
    } else { fallback(); }
  }
  function setStatus(msg) { statusEl.textContent = msg; window.setTimeout(function () { if (statusEl.textContent === msg) statusEl.textContent = ""; }, 4000); }
  function render() {
    var chunks = buildChunks(collect());
    while (chunksEl.firstChild) chunksEl.removeChild(chunksEl.firstChild);
    chunks.forEach(function (chunk, index) {
      var box = document.createElement("div");
      var pre = document.createElement("div"); pre.className = "summary-box"; pre.textContent = chunk; box.appendChild(pre);
      if (chunks.length > 1) {
        var btn = document.createElement("button"); btn.type = "button"; btn.className = "btn sec";
        btn.textContent = "复制第 " + (index + 1) + " / " + chunks.length + " 段";
        btn.addEventListener("click", function () { copyText(chunk, function (ok) { setStatus(ok ? "已复制第 " + (index + 1) + " 段" : "复制失败,请手动全选复制"); }); });
        box.appendChild(btn);
      }
      chunksEl.appendChild(box);
    });
  }
  areas.forEach(function (ta) {
    var key = ta.getAttribute("data-key");
    ta.value = storageGet(key);
    ta.addEventListener("input", function () { storageSet(key, ta.value); render(); });
  });
  document.getElementById("copy-all").addEventListener("click", function () {
    var text = buildChunks(collect()).join("\n\n");
    copyText(text, function (ok) { setStatus(ok ? "已复制全部意见" : "复制失败,请手动全选复制"); });
  });
  document.getElementById("clear-all").addEventListener("click", function () {
    areas.forEach(function (ta) { ta.value = ""; storageDel(ta.getAttribute("data-key")); });
    render(); setStatus("已清空");
  });
  render();
})();
"""

html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>FLY-1942 · 通信层防线三件套 — 设计</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">
<h1>FLY-1942 · 通信层防线三件套 — 设计</h1>
<div class="meta">Issue: <a href="{escape(ISSUE_URL)}">{ISSUE}</a> · 日期 2026-09-11 · 计划版本 v5(Codex 设计评审 3 轮 + 1 轮确认,leadAcceptance)· 文档:engineering/doc/FLY-1942-comm-defense-trio/</div>
{''.join(cards)}
</div>
<script nonce="__CSP_NONCE__">{SCRIPT}</script>
</body>
</html>
"""

out = ROOT / "founder-design.html"
out.write_text(html)
print(out, len(html.encode("utf-8")), "bytes")
