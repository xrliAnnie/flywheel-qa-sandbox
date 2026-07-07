# FLY-915 Flywheel infra alerts & notification pipeline — 探索(痛点梳理 + ground truth)

Issue: FLY-915 (https://linear.app/geoforge3d/issue/FLY-915/flywheel-infra-alerts-and-notification-pipeline-痛点梳理-产品定义prd)
日期: 2026-07-06
基于: 无(本 issue 起点;ground truth 来自 codebase 审计 + 历史 issue)

> 这是 Mode A 产品共创的**输入**(把现状摸清),不是 PRD 正文。PRD 正文在 prd.md,先过 brainstorm gate 确认方向再写。

## 0. 这活儿是什么(先对齐意图)

Annie 要的**不是**再修一个 bug,而是把「Flywheel 内部的 alert / 通知 / infra bot / profile 自动切换」这一摊**当成一个产品重新定义清楚**,出一份 eng 照着能建的细节 PRD。流程严格:先定 PRD → 找 Tadashi 沟通 → 回 Annie 确认「产品长这样行不行」→ OK 后才拆 eng issue。**本 issue 不写实现代码**,产出物 = PRD(频道架构图 / 两 bot 分工表 / 通知体验定义 / profile 切换流程图 / 每条痛点→产品解法→eng workstream)。

## 1. Ground truth(codebase 审计,不是从零猜)

### 1.1 alert 现状
- **单一 Bridge 出口** `LeadAlertNotifier.ts`;生产用统一频道 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID=…661254`(= #flywheel-alerts,FLY-368)。所有项目(geoforge3d / sub / joycon / growth / tidal-echo / flywheel)的 alert 都汇进这一个频道 —— 这是**有意设计**,不是泄漏。
- **第二条独立 shell 出口** `scripts/lead-alert.sh`:Bridge 挂掉时用 curl 直发。**它不认识统一频道**,按 per-lead `alertChannel`→`generalChannel` 走(FLY-368 §9 明确留作 follow-up,**仍 open**)。
- **auto-repair**:`AlertChannelHub` + `AutoRepairBot`(Cass 身份)—— bot 坏了先自 nudge/单 Enter 修,修不好才 `@Annie needs_human`。这就是 issue 说的「自动修复 bot」愿景,已建。
- **谁能发**:**没有代码级发送方门禁**。任何能读 `~/.flywheel/.env` 的进程 + 任意 fleet bot token 都能往 alert 频道写。唯一约束 = Discord 频道权限(手工管)。→ **痛点 1 的一个根因**。
- **消息体不含 projectName**:`formatContent()` 只渲染 `(leadId / eventType)`,跨项目靠认 lead 名字区分 → 观感上「GeoForge3D 的 alert 刷我 Flywheel 频道」。

### 1.2 刷屏的真实来源(逐条查过)
| 事故 | 根因 | 状态 |
|---|---|---|
| FLY-193 idle pane 假 frozen | 识别器扫全 200 行 scrollback,残留 thinking 字样骗过 | **已修**(live-region 识别器 default-ON);已知盲点:frozen-mid-thinking 被抑制 |
| FLY-218 529 限流误判成 usage_limit | 匹配到「not your usage limit」里的子串 + 画面churn 绕过去重 | **已修** |
| FLY-220 rate_limit 回声自放大(隔夜 276+) | 告警回声进 pane 又被 classify → 自我放大 | **已修**(echo immunity + episode latch) |
| FLY-628 runner idle 假告警 | 30s 唤醒 parked runner | **band-aid**(poll 拉到 ~1h),非根治 |
| auto_qa_stuck 去重缺口 | eventId 带 timestamp → claims.db 永不收敛 | **潜在结构缺口**(未见事故,但代码层真存在) |
| QA-slot / test-bridge 漏进生产 alert 频道 | 测试进程写共享 queue / 读生产 projects.json | **已修**(FLY-529 env 隔离),但**opt-in**:临时测试进程仍打生产默认 |

**结论**:历史上最响的几发刷屏(193/218/220)都已根治;**剩下的刷屏风险是结构性的** —— ① 无发送方门禁 ② shell 路径不认统一频道/隔离 opt-in ③ 无「频道级速率上限」④ 部分 eventId 带时间戳去重失效 ⑤ 消息不带 project 归属。治刷屏 = 定义「什么算真 alert + 谁能发 + 频道级兜底」,不是再打一个补丁。

### 1.3 alert ≠ notification(已确立铁律,但没写进任何 spec)
- FLY-523 **revert**(Annie 原话):「alert != notification。报错进 alert 频道;ready-to-ship 通知该进对应 issue thread。」
- FLY-818 **redirect**:founder page 也不许进 alert 频道,要进 stuck runner 自己的 `[FLY-XX]` thread(`founder-thread-notifier.ts`)。
- **现状路由**:错误→统一 alert 频道;founder 通知(milestone / ship-ready / stuck page)→ per-issue chat thread。**缺口**:这条铁律只活在两个 revert commit 里,没有一份产品 spec 固化它 → PRD 要补。

### 1.4 通知 / token report / Simba(已查清)
- **Token Report 不是「停了」,是每晚跑、每晚静默失败**:launchd `com.flywheel.token-usage-daily.plist`(00:30)照常聚合+生成 HTML,`publish-report` 最后一步报 `delivered:false, FLYWHEEL_BRIDGE_URL 必需` —— 无人值守 launchd 路径缺 `FLYWHEEL_BRIDGE_URL` 环境变量(env/plist 都没)。唯一成功那次 = 交互 shell 手动测(带 BRIDGE_URL)。修 = 补一行环境变量。
- **Simba 是「全局默认 bot」顶上来的**:token report 走 Bridge `/api/reports`,用 `DISCORD_BOT_TOKEN` = Simba token(没有 infra bot 身份 → 默认顶上);频道 `1521630422918758472`。
- **系统重启通知**:`restart-services.sh` 硬编码 `NOTIFY_BOT_TOKEN=SIMBA_BOT_TOKEN` → `DISCORD_CORE_CHANNEL`,`com.flywheel.updater.plist`(06:00)触发,纯 curl 不过 Bridge。
- **附带**:GEO-288 standup 也坏了(`STANDUP_PROJECT_NAME` 缺 → 多项目下 fail-closed → 404),独立小 workstream。
- **产品含义**:痛点 2「发一天就停」的真根不是「没排」,是「排了、失败了、没人知道」→ 解法核心 = infra bot 自我健康检查 + 迁走发送方。

### 1.5 profile 自动切换 —— **对 issue 前提的重大修正**
- **Codex 侧**:`codex-with-fallback` + `codex-profile`(5 账号轮转)**全建好、自动**(reactive retry-on-limit)。per-runner fork `flywheel-codex-with-fallback` 也建好,轮转会发「🔁 账号轮转」进 alert 频道。
- **Codex Infra Bot(FLY-871)**:代码 **已 merged(PR #465)**,Discord 身份也占了(pool-03)—— 但 **没部署、没启用**(launchd 没装、flag 没开)。
- **Claude Code 额度自动切换**:issue 说「半成品、Annie 手动切」。**实际更准确的说法是**:切换机器(检测 usage_limit → 排队 → flock+CAS 切 Keychain 账号 → 通知)**已全建好、已 merged**,但**默认关**(`FLYWHEEL_ACCOUNT_SELF_HEAL` 未开),且**上线/QA 那一窗从没执行过**。生产今天只做到 **DETECT + NOTIFY**(弹「Top up billing」),**没 ACT** → 所以 Annie 手动切。**这不是缺代码,是缺「启用 + 真机 QA + Annie GO」这一步。**
- **「第二个 bot / Cloud Infra Bot」**:代码里**零处** `Cloud Infra Bot`。FLY-696/871 的设计里第二个 bot 叫 **Claude Infra Bot**(按背后模型命名:Codex Infra Bot 看/切 Claude 侧,Claude Infra Bot 看/救 Codex 侧;铁律 = 谁都不救自己)。**Annie 说的「Cloud Infra Bot」极可能就是「Claude Infra Bot」的口误/别名 —— 需当面确认。** 第二个 bot **完全没建**(只在 plan 里作 follow-up)。pool-04/05/06 空槽可即时开一个。

## 2. 需要 Annie 拍板的关键分歧(brainstorm 要问的)

1. **「第二个 bot」到底叫什么、职责边界**:是不是 = Claude Infra Bot?两 bot 是「按 provider 交叉互看」(现有设计)还是 Annie 想要「一个主力 Cloud bot 管全部 infra 通知/alert + Codex bot 打辅助」(issue 里的措辞)?这俩架构不一样,得先定。
2. **profile 自动切换**:机器已建好只差启用 —— PRD 是定义「启用 + QA + 兜底」的产品行为,还是 Annie 心里还有别的行为(切换顺序 / 通知 / 失败兜底)要重新定?
3. **通知体验**:哪些打断 Annie(紧急)、哪些攒 digest(非紧急),她有没有定见的清单?
4. **频道数**:统一 alert 频道 + 通知频道 + per-issue thread —— 够不够?要不要再拆(如 infra 通知单独一个)?

## 3. Topic tree(大主题 → 子块,逐块钻)

- **A. 频道架构**(几个 channel × 每个发什么 × 谁发)← 建议第一块,它是其它块的骨架
  - A1 频道清单 & 职责
  - A2 alert ≠ notification 铁律固化
- **B. 通知体验定义**(signal/noise、紧急 vs digest、alert 准入规则/治刷屏)
- **C. 两 infra bot 分工**(Codex Infra Bot vs 第二个 bot;命名 + 边界表)
- **D. profile 自动切换产品行为**(触发→顺序→通知→失败兜底,流程图)
  - D1 Claude 额度切换(启用已建机器)
  - D2 Codex 额度(已自动)+ 交叉互看
- **E. token report / Simba 迁走**(为啥停 + 挪给 infra bot)
- **F. 收敛 → 每条痛点→产品解法→eng workstream 拆分**

## 4. 当前进度
- [x] Ground truth 审计(alert / 刷屏源 / profile 切换 / infra bot)
- [x] 修正 issue 两处前提(Claude 切换=建好待启用,非半成品;「Cloud Infra Bot」疑=Claude Infra Bot)
- [ ] Brainstorm gate 确认意图 + topic tree(**下一步,阻塞**)
- [ ] 逐块钻 → prd.md 收敛
- [ ] 拆 build issue 清单
