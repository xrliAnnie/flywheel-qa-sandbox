# FLY-1751 控制指令不可靠修复 — 探索

Issue: FLY-1751 (https://linear.app/geoforge3d/issue/FLY-1751/控制指令不可靠founder停手指令无优先通道最坏延迟-8-小时9-条因租约超时判死-换代对账只是其中一腿)
日期: 2026-08-13
基于: 无

## 一句话

founder 的 Discord 消息会因两类机制性问题到不了 Lead 手上——(a)攒批参数过保守放大排队延迟、(b)Lead `/clear` 换代后在途批(LEASED)无人签收把 3 个在途位占死、整条队列冻结;本单按 founder 8-13 深夜二次定稿,只动两刀:攒批参数 5→10 条 / 60s→30s,和给 FLY-1708 已建好的 `adopt-inflight` 出生对账机制补挂 `/clear` 换代触发腿。

## 问题全景(背景,非本单 scope)

Issue 正文积累了四层证据,量级从「聊天有点慢」升级到「控制指令不可靠」:

- **证据 A(无优先通道)**:同一条 founder 消息扇出三个 Lead,送达耗时 3.0s / 4.6s / **751s**(12m31s)。Lead 在消息送达前 41 秒执行了该消息要求阻止的动作。
- **证据 B(最坏延迟 8 小时)**:多条消息(含一条 RUNNER-STOPPED 停手类通知)排队 7-8 小时才送达。
- **证据 C(租约超时判死)**:单日 30 条进 DEAD,其中 9 条死因 `lease_expired_unacked` —— 消息不是传输失败,是没人看就被判死。
- **证据 D(死锁自指)**:关于本缺陷的分析报告本身卡在本缺陷里(QUEUED 冻结)。
- **8-13 直接触发事故**:flywheel-eng-lead `/clear` 换代,换代前 3 个批已 LEASED 投进旧对话现场;旧现场永远不会 ack → 3 个在途位(上限恰好 3)全部占死 → Bridge 按协议停止投递新批 → founder 之后发的 4 条消息全堵 QUEUED,「Lead 聋了」。手工修复=新身体查 `state='LEASED'` → 逐批 `flywheel_inbox_ack_batch` → 20 秒内恢复流动。这是**第二次**踩同一坑(第一次 2026-08-11 舰队重启后全舰 77 条积压,同一签名)。

## 裁决史(三版 scope,只有最后一版有效)

本单 scope 经历了三轮收敛,前两轮的刀**全部作废**,记录在此只为防止实现时从旧章捡刀:

1. **第一版(重写)**:founder 优先通道 + 租约超时告警/重投 + 换代自动对账。→ 被第二版取代。
2. **第二版(8-13 晚定稿)**:「修法一」= 未读消息不占在途位、租约/重试预算从 Lead 真正认领(claim)才起算、`delivered` 拆成 persisted/claimed/admitted 里程碑时间戳列;捎带 batchMaxSize 5→10。→ **被 founder 深夜裁决整体推翻**,判词原话:「I do not think this makes sense at all..... you basically call ack as leased」—— claim 与 ack 只差几秒,LEASED 沦为 ack 的别名,冗余中间态,状态机手术不做,时间戳列一并不做。
3. **第三版(8-13 深夜二次定稿,唯一权威)**:见下节。

同时被明确押后/不做的:

- **修法二(human 免攒批 + STOP 控制面)**:founder 原话「这个有点增加复杂度的东西还是先不要加」→ 押后不做。
- **修法三(死信分诊)**:主体不做;死讯回流通知/信箱堵死独立报警两条尾巴降级为落地后观察项,不进本单。
- **founder 优先通道**:不进本单(证据 A/B 描绘的病灶留给同族后续 issue)。

## 唯一权威 scope(founder 逐字裁决,两条,不许扩)

> 「for 1751, I am thinking the only change I would made, for each batch, increase from 5 to 10, also previously it is either every 5 msg or 60s we make a batch right? could we make it every 10 msg or 30s we make a batch?」

1. **攒批参数**:batchMaxSize 5→**10**,batchWindowMs 60s→**30s**(「攒够 10 条或等满 30 秒,先到先封箱」)。
2. **死锁修(/clear 换代腿)**:FLY-1708 已建好的 `adopt-inflight`(出生自动接管在途批)只挂在**进程重启**触发点(`claude-lead.sh` 在 fork claude 前调用一次);`/clear` 只换对话、不重启进程 → launcher 不重跑 → adoption 原地睡觉。补挂**会话级触发点(Lead SessionStart hook,幂等)**,使 `/clear` 换代同样命中。保留 launcher 现有调用不动。

## 方案空间探索(为什么是 SessionStart hook)

`/clear` 换代腿的候选触发点:

| 候选 | 判定 |
|---|---|
| **A. Claude Code SessionStart hook**(选定) | `/clear` 触发 SessionStart(source=clear),进程重启也触发(source=startup/resume)→ 一个钩子覆盖所有会话诞生形态;仓里已有三个成熟先例(PostCompact / Stop / PreToolUse hook 全走 `claude-lead.sh` 里 jq merge 进 `~/.claude/settings.json` 的安装模式);hook 继承 Lead 进程 env(`LEAD_ID`/`FLYWHEEL_COMM_DB`/`FLYWHEEL_COMM_CLI` 全在),零新配置。founder 定稿点名即此方案。 |
| B. Bridge 侧检测换代(投递失败→自动 adopt) | 属于第二版「状态机手术」家族——Bridge 无法区分「旧现场死了」与「Lead 忙没 ack」,要判就要引入新信号,复杂度正是 founder 否掉的方向。 |
| C. Lead 规则文本要求模型 `/clear` 后自查 | 依赖模型自觉,不可证伪,且 `/clear` 后新对话根本不知道自己是换代来的。 |

## 关键风险(探索期识别,研究阶段求证)

1. **共享 settings.json 半径**:hook 装在全机共享的 `~/.claude/settings.json`,对**所有** Claude 会话生效(runner、QA slot、founder 终端)。runner pane 带 `FLYWHEEL_LEAD_ID`(=所属 Lead)——若 hook 判别用错变量,每个 runner 开工都会把 Lead 的在途批抢回 QUEUED,等于制造新事故。判别锚必须是 runner pane 被显式清空的变量(研究阶段确认为裸 `LEAD_ID`)。
2. **幂等与重试预算**:adoption 每次把 LEASED 翻回 QUEUED 都 `lease_retry_count + 1`;SessionStart 与 launcher 在进程重启时会先后各跑一次——需确认二次扫描是零行无害,且不会误耗尽重试预算把消息推进 DEAD。
3. **攒批语义与 founder 心智模型的差异**:founder 表述「每 5 条或 60 秒封一箱」;真实现里 window 是**并箱横界**(head 之后 60s 内同 sender 消息并进一箱),不是「憋满 60 秒才发」。改参数前必须确认改的就是 founder 要的效果(研究阶段逐行核)。
