# FLY-1182 Claude 账号 quota 自动切换点火 — QA 报告

Issue: FLY-1182 (https://linear.app/geoforge3d/issue/FLY-1182)
日期: 2026-07-11
基于: plan.md / research.md / exploration.md + evidence/ 全部证据文件

> **SUPERSEDED / 历史报告(2026-07-16)**:本文记录 PR #562 的旧 Bridge / Bot 架构。
> 当前生产执行者是 FLY-1256 外部 `quota-monitor` daemon,且
> `FLYWHEEL_QUOTA_DAEMON_CUTOVER=1`;GO 判断请以 `qa-report-phase3.md` 和
> `recovery-runbook.md` 为准。本文中的 Bridge watchdog、Bot 20 秒认领和自动 rescue
> 说法不得用于当前 GO 卡。当前生产另有止血冻结(`trigger5hPct: 100`,`order: []`),
> daemon 活着但处于 monitor-only,尚未常开。

---

## 0. 一句话结论(2026-07-12 终版 —— **门修好了,可以请 Annie 批**)

**它以前守错了门;现在两扇门都守。**

- **切换机制**:三层真机 QA 全绿(module 45/45 + 真 slot Bridge 13/13 + 2.9 bot 交叉互救),
  外加**轨B 生产真-Keychain 演练全绿**(§8):真 `switchAccount` 打生产 Keychain
  business→personal 成功,字节级还原,**19 个在飞 runner 一个没死**,还原后全新 claude
  真认证通过。红线零违背。
- **但检测口径覆盖不了 Annie 真实撞的封顶**(§9,2026-07-11 夜 Fable-5 事故实证):
  引擎只认**账号级** 5h/weekly gauge **打到 100%**;Annie 一直撞的是**模型级**
  (`You've reached your Fable 5 limit`),账号 gauge 当时才 10~88%。引擎**没坏 —— 它
  盯的是另一扇门**。这就是她说的「1182 从来没修好过」。
- **已修 + 已验**(§10,Eng Lead 批准扩单):模型级封顶检测(通用形状,Opus/Sonnet 同样触发)
  + 有界 TTL/backoff(永不永久停用、不 thrash)+ per-(账号,模型) bench + **检测器与执行器
  共用同一个身份权威**(后者是 Track C QA 现场从我第一版里抓出来的真 bug)。
  **Track C 真机 QA 25/25 全绿** —— 拿事故当晚逐字的 pane 喂进真 dist,全程无人,引擎自己
  发现并切换。**这一版对 Annie 的真实痛点是真会触发的。**

**Codex code review**:PR #562 head `1ef1de39` — 3 轮 APPROVED(xhigh)。R1 3 HIGH+2 MEDIUM、
R2 2 HIGH,逐条真修 + 补测(durable dispatching marker / 单调 phase / close 前 binding+live 重核 /
tri-state capState / 同-exec 并发单 successor claim / 单次 destructive close)。verdict 落
`.flywheel/runs/be8e3e48…/codex/code-review.json`(FLY-827 硬 gate artifact)。

## 1. 如实披露(GO 卡也会写)

- **引擎不是「dormant 待点火」——它 Jul 11 06:06 起已在生产 live**(env 是 FLY-1049
  enable 窗写入,那次 Bridge 重启带了进去)。至今 **零切换**(accounts.json
  generation 仍 =1、全员未标 exhausted)。本单 = 补做从没跑过的真机 QA + 新建翻活能力。
- 风险窗口(06:06 → QA 绿):其间真实封顶会触发未经本机 E2E 验证的切换。缓解:
  FLY-696 开发侧 QA-1~6 冒烟 + Codex review 2 轮 APPROVED 已过、freshness/verify/CAS
  全 fail-closed、观察至今零切换。本单 QA 现已把这块补齐。

## 2. §8 M1 逐项 verdict(证据文件对应)

| §8 项 | 覆盖轨 | verdict | 证据 |
|---|---|---|---|
| #1 全链真切换 | module S1 | ✅ | task2-track-a-45checks.log |
| #2 登录不坏 | module S1.7-S1.8 + epilogue | ✅ | 切后真 Keychain=目标凭据 + 显示身份变;红线 E.1-E.5 前后一致 |
| #3 通知真落 | module S2 + a2 D2.5 | ✅ | 🔧+🟡 真落隔离 529 频道(Discord re-fetch) |
| #4 529 不误切 | module S3 | ✅ | throttle-529-live → 零 pending/零切换/keychain 不动 |
| #5 双触发幂等 | module S4(a/b/c 两幕) | ✅ | 恰一次 committed switch、generation 恰 +1;watchdog-wins 后 late claim 拒 + 每目标 exactly-once |
| #6 runner-only cap | module S5 | ✅ | 只 runner 观察也切 |
| #7 fail-closed | module S6(a 持锁 / b 脏 verify) | ✅ | 上抛/tick 捕获/pending 保留;脏 verify → 回滚回 alpha,状态零变 |
| #8 argv 无泄密 | module S7 | ✅ | 真切换期 8 次 ps 采样,凭据 marker 零出现 |
| #9 ambiguous | module S8.1 | ✅ | 模糊 gauge → needs_human |
| #10 weekly 选号 | module S8.2-S8.4 | ✅ | weekly 挑最近 reset;both → weekly 主导 |
| #11 全废 | module S8.5-S8.6 | ✅ | needs_human + 最早 reset;profile bin 零调用(绝不 re-login) |
| #12 codex 轮转事件 | a2 D1 | ✅ | account-rotation-notify → /events → 隔离频道真落 |
| #13 重启恢复 | module S11 + a2 D3 | ✅ | durable pending 由重启后全新 tick 执行(真 Bridge 停→起) |
| #14 bot 交叉互救 | a2 D2 + 2.9 | ✅(带边界,§4) | 真 claim 切换活 Bridge 内执行;真 LLM 判断纪律;HTTP 链 operator-driven |
| #16 byte-compat | module S12 + a2 D4 | ✅ | self-heal off → needs_human + 原文案 + 两路由 409 dormant |

**#15(re-login)** 仍归 M3,不在本单。

## 3. 红线铁证(Annie 最在意的三条)

1. **绝不弄坏现有 claude 登录**:module 轮 epilogue E.1-E.5 —— 真 Keychain item
   hash、真 claude-accounts.json、真 pending、真 .active、真 ~/.claude.json 的
   oauthAccount 块,演练前后**逐一 hash 一致**。fail-closed 硬闸:任何隔离旋钮缺失/
   落 root 外/service 名撞生产 → harness 拒跑。verify-before-commit 脏读回 → 回滚回
   原账号(module S6.2-S6.3)。
2. **不打断在飞 runner**:全程隔离(scratch keychain/池/状态/频道 + slot Bridge +
   牺牲 session 只用 QA 自己起的 tmux);生产 Bridge/Keychain/频道零接触。
3. **529 不误切**:module S3 + FLY-218/220 守卫 —— 瞬时限流 fixture 零 pending 零切换。

## 4. #14 / 2.9 的诚实边界(Tadashi 裁定 05103e27,原样端给 Annie)

翻活(卡在旧额度的 session 逐个恢复)的验证分三块,**如实分层**:

- **真机已验**:① 真 Codex LLM(codex-rescue)的**判断纪律** —— 传输失败(≠409)时
  正确 fail-closed、不伪造 claim、不盲救;② 完整 claim→409→账本相邻性→quota-rescue
  的 **HTTP 决策链**对活 Bridge 跑通(绑定账本 switched_gen=observed+1、准入守卫
  200 活的、revalidateQuota 真捕真解析牺牲 pane);③ 服务端跨语义(codex-only actor)、
  per-kind flag(随 self-heal)、byte-compat dormant —— 全真机验。
- **原语等价 + HTTP 级验(接受不搭全栈)**:牺牲 session 真 close + resumed-successor
  的 **spawn 那一腿**。理由:与 FLY-871 login 救援**已真机验证的同一 close+dispatch
  原语**(只差 audit reason `quota_stuck_rescue`)+ 本单 rescue-quota 24 个单测(4 类
  部分失败可恢复 + per-kind reason 透传 + sweep 排除 quota + byte-compat)全绿 + a2
  #14 真 claim 切换活 Bridge 验。**full real-runner-spawn 段推迟**(需 FLY-115 sandbox
  repo+真 Linear issue+真 claude spawn 全栈,over-build)。
- **环境限制(非产品缺陷)**:codex 沙箱连不上 host localhost(挡真 LLM 的 HTTP
  happy-path,已由 operator-driven 复刻);revalidate 的 last-20 空白尾 = harness
  pane-layout artifact(full-pane 解析 100% 正确,生产真 TUI gauge 在末行会命中)。

- **actor 身份 trust assumption**(research §5.5):`/api/rescue` 与
  `/api/account-switch` 的 `actorBackend` 来自请求 body,HTTP 层只校验共享
  `TEAMLEAD_API_TOKEN` ⇒「只有 Codex actor 能调 Claude 侧翻活」是**协议约定不是密码学
  绑定**。本单接受(拿共享 token 的都是本机受管 agent);per-bot credential 绑定 =
  follow-up(§6 d)。

## 5. Task 0 接线审计 finding(F-0.4,如实条件化)

「成功切换的 pending 窗口内 Codex bot 有没有被点名?」**答:有 —— enqueue 即点名。**
`AlertChannelHub.ts:496-508` 对 `repair.action==="account_switch"` 显式
`mentionUserId: infraBotId()` @ bot。真偏差是**时序性**的:pending claim deadline 默认
20s(`account-switch-repair.ts:93`)、watchdog 30s poll 兜底 ⇒ 生产里 LLM bot 几乎
必输给 watchdog(a2/2.9 的 409 时序真实重现了这点)。PRD CMP-1「交叉互救」叙事与接线
**无结构性偏差**;deadline/接线调整 = follow-up(§6 c),不进本单。

## 6. Follow-up 清单(交 Tadashi;§6 a/b 也进 Linear)

- **(a) 选号策略调优**(scope ③,只记录):5h 封顶时也优先切「reset 最近且有余量」的
  账号(Annie 提议)。现行为 = 5h 挑任一已恢复,weekly 才挑最近 reset。→ 新 follow-up
  issue 挂 Tadashi(v1 跑通后调)。
- **(b) 🔴 轨C 观察期首次自然封顶验真翻活**(Tadashi 硬条件②,**显式有人接**):
  常开后第一次真额度封顶时,在 #flywheel-alerts / #flywheel-notify 观察 🔧+digest +
  新 spawn 用新账号 + **bot 真 close+resumed-successor 翻活牺牲的旧 session**(= 2.9-B
  推迟段的真机补验)+ 证据帖。owner = Tadashi 指派(Annie 极在意'真封顶真翻活')。
- **(c) bot-claim deadline / 通知接线**:20s claim 窗对 LLM bot 过紧(F-0.4)→ 调 deadline
  或改接线让 bot 真能抢到 claim。
- **(d) per-bot credential 绑定**:route 从认证上下文推导 actor 身份,替代 body 自报
  (§4 trust assumption 的结构性解)。
- **(e) shopping 池凭据 stale**(F-0.3):freshness 探测 rc=30(HTTP 400 拒 refresh)。
  需 Annie 在场重 capture(founder 动作)。不阻塞本单(personal/school fresh)。
- **(f) 529 Room sender 继承坑**:生产 `.env` 的 `FLYWHEEL_ALERT_SENDER_TOKEN_ENV`
  会被 source 过 .env 的父进程带给 slot Bridge → post 403;未来用房者 slot 必须
  pin 自己的 sender token env(a2 已踩,已在 driver 修)。

## 7. Annie 三问答卷 —— 见同文件夹 recovery-runbook.md「三问人话版」章节

---

## 8. 轨B —— 生产真-Keychain 切换演练(2026-07-12,全绿)

轨A 用的是 scratch keychain,**证明不了**「写生产那一个共享 Keychain item 会不会
把 fleet 的登录搞坏」。轨B 就是补这一刀。驱动的是**真 `switchAccount` 执行器**
(不是裸调脚本),跑到 lock → CAS → freshness gate → verify-before-commit → ledger
→ 身份同步 的完整生产路径。脚本:`scripts/qa-fly-1182-track-b.mjs`。

**结果**:`{outcome: switched, from: business, to: personal, generation: 1→2}`
- 目标由引擎自己的 `selectNextAccount` 挑(未干预),挑中 personal;
- freshness gate 对 personal 做了**真 HTTP token refresh 并通过**(stale 会 exit 30)
  → 这本身就证明切进来的号是**真能用的登录**;
- keychain 指纹 `6de5c3ee…` → `d6a20bb8…`;ledger / 池 `.active` / `~/.claude.json`
  身份三者同步翻到 personal。

**红线①「绝不弄坏现有 claude 登录」—— 铁证**
- 字节级还原后:keychain 指纹**逐字回到 `6de5c3ee…`**、身份回 `xrliannie.b@gmail.com`、
  `.active`=business、ledger 回 `activeAccount=business`/gen=1。生产状态与演练前逐字一致。
- 起一个**全新 claude 进程**走生产 config dir(= 新 runner 真正的路径)→ 真认证成功、
  真调通 API、exit 0(`evidence/track-b-restored-login.log`)。

**红线②「不打断在飞 runner」—— 铁证**
- 基线 19 runner / 36 claude → 演练后 19 runner / 37 claude,**消失的 PID:0 个**
  (`evidence/track-b-fleet-intact.log`)。Bridge health OK。
- 机理(实测,非推测):claude 只在**启动**和 **token refresh** 时读 Keychain;演练时
  access token 还有 **~7h50m** headroom,窗口内无人到 refresh 点。已认证的 session
  把 token 拿在内存里,换 keychain 不会追溯性打断它们。
- ACL 不是雷:`security find-generic-password -w` **无提示**直接读出生产凭据 → 该 item
  ACL 宽松,`-U` 覆写不会被拒、也不会把 Claude Code 踢出信任列表。

**方法学坑(记下来,别再踩)**:在**空的隔离 `CLAUDE_CONFIG_DIR`** 里起 claude 会报
`Not logged in`,**即使机器 Keychain 是好的** —— claude 的登录态不只看 Keychain,还看
config dir 里的账户状态。我第一次就是这么误判成「登录坏了」的。**验登录必须用生产
config dir**。这也说明 FLY-865 往 `~/.claude.json` 同步身份**不只是显示用**,是新进程
认账号的一部分 —— 引擎做对了。

---

## 9. 🔴 检测覆盖缺口 —— 「1182 从来没修好过」的答案

2026-07-11 夜实证:Fable 5 配额爆了,**4+ 个 runner 悄无声息卡死**,引擎(`FLYWHEEL_ACCOUNT_SELF_HEAL=1`,
已 live)**全程静默**,最后是 Annie 手动一个个救活的。证据见 `evidence/track-c-detection-gap.log`。

### ③ 模型级配额:**不覆盖。这是根因。**(缺功能 / 范围缺口)

| 事实 | 证据 |
|---|---|
| 卡死文本是**模型级** | 6 个 pane 逐字抓到 `You've reached your Fable 5 limit. Run /usage-credits to continue or switch models with /model.` |
| 同一时刻账号级 gauge **远未封顶** | 5h 10~75%、7d 25~88% |
| 引擎唯一封顶判据 = **账号级 gauge ≥100%** | `usage-gauge.ts:238-243` → `scope = fiveh>=100 ? … : weekly>=100 ? … : null`;`null` → `account-limit.ts:42 return null` → 不 enqueue → 不切 |
| 全模块**没有任何模型级识别器** | `grep -riE "fable\|usage-credits\|reached your .* limit" packages/teamlead/src/account-heal/` = **零命中** |
| 引擎从没记录过任何一次封顶 | 台账 4 个账号 `quotaExhaustedUntil` 全 `null` |

**结论**:引擎**没坏 —— 它守的是另一扇门**。它盯账号级 5h/weekly,Annie 一直撞的是模型级 Fable。
今晚的静默是它设计内的**正确**行为,但对她**完全无用**。

**关键杠杆**:**切账号本来就能解模型级封顶** —— Annie 自己就是靠手切账号恢复 Fable 额度的。
所以补救手段现成,缺的只是**触发口径**。加一个模型级识别器,整台已验证的机器立刻对她的真实
痛点生效。小改动、高杠杆。

**待拍的设计点**:Fable 那句话**不带 reset 时间**,而台账 `quotaExhaustedUntil` 需要一个
`resetAt`。模型级封顶的 reset 策略要单独设计(复用 5h gauge 的 reset?标 unknown?)。

### ① 真封顶 → 引擎自主检测 + 自动切:**机制已验,但它是 ③ 的下游**

- 机制**不缺**:轨A 45/45(注入 100% gauge 走完 检测→enqueue→watchdog→自动切 全链)
  + 轨B 真生产 Keychain 切换执行成功。
- 生产零自动触发**是真的,但不是因为坏**:账号级 100% 封顶**从来没发生过**(她撞的都是模型级)。
- **诚实边界**:③ 修好前,**给不出**「真封顶自主翻活」的生产证据 —— 那个封顶形态引擎压根不看。

### ② 手动/外部换账号 → 台账对账:**机制缺口真实,但当下没 stale**(缺功能,严重性低于 ③)

- **先纠正**:此刻台账 `activeAccount=business` / 池 `.active`=business / 机器身份=business
  **三者一致**(Annie 手切的目标恰好就是 business),所以「对不上」这个前提**当下不成立**。
- **但缺口是真的**:检测器 `derive-account-limit.ts` **直接读台账 `activeAccount`,零对账**;
  而切换执行器**有** crash-recovery 对账(`switch-executor.ts:136-141`,真实 `.active` 压过台账)。
- **后果**:若 Annie 用 `claude /login` 换号(不走 `flywheel-claude-profile`),keychain 变了但
  池 `.active` 和台账都不会变 → 检测器盖上**错的 `observedAccount`** → 执行器 CAS 名字对不上 →
  **真封顶被静默丢弃**。今晚只是碰巧目标同为 business 才没暴露。
- **建议**:检测器也用执行器那套权威做对账。同一个文件、边际成本近零。

### 自查纠错(留档)

调查中我一度误判台账 `activeAccount` 是 `null`(**我 `jq` 查错了键名 —— 真实键是
`activeAccount`,我查的 `.active`**),据此差点报出一个错误的根因。已在发出前自证推翻。
真根因是 ③,与该误判无关。

---

## 10. ✅ 修复 + 验证(2026-07-12,Eng Lead 批准扩单)

### 10.1 实现(TDD)

| 口径(Eng Lead 裁定) | 落地 |
|---|---|
| ① 识别器**不写死 Fable** | `model-cap.ts` 通用形状 `reached your <MODEL> limit` + **必须带** `switch models with /model` 判别标记(用它排除账号级 `Claude usage limit reached` 和 `Context limit reached`)。Opus / Sonnet 封顶同样触发。 |
| ② **不复用 5h 的 reset** | 改用**有界 TTL + 到点重探 + backoff**:BASE 30min → 重探失败翻倍 → **MAX 4h 封顶**。两条硬约束都落地:**永不永久停用**(TTL 恒有限)、**不许 thrash**(重探窗内再封顶就退避)。 |
| ③ 记 model 维度 | `AccountEntry.modelCaps`(model → {until, backoffMs})。 |
| ④ 检测器身份对账 | 见 10.2 —— 比原计划更深。 |

**per-(账号,模型) vs 整号 bench —— 我选了做对的那版,理由**:成本确实低(台账加一个字段 +
选号加一个过滤条件);而整号 bench 会把该号**还没封顶的 Opus/Sonnet 额度一起停掉** —— 在
混模型 fleet(design/implement 走 Fable、QA 走 Opus/Sonnet)上会直接缩小可用池。而且切换
决策的**正确语义**本来就是「挑一个**该模型**没封顶的号」,不是「挑任一健康号」。

### 10.2 🔴 QA 抓出的真 bug(在我自己的第一版里)

**Track C QA 的 S7 一开始是红的**,抓出一个我漏掉的结构性洞:

> 我只在**检测器**做了身份对账,**执行器的 CAS 仍然拿池子 `.active` 当权威**。而
> `.active` 只有 `flywheel-claude-profile` 会写 —— **事故当晚 Annie 用的是 `claude /login`**,
> 它只改 Keychain + `~/.claude.json`,**台账和 `.active` 一个都不碰**。于是两边对「当前是哪个号」
> 给出**不同答案** → CAS 不匹配 → **真封顶依然被静默丢弃**。正是本单要杀的那个失败。

**修**:抽出 `machine-account.ts` 作**唯一权威**(`~/.claude.json` 身份 → 池子账号名),
检测器和执行器**共用同一个**,永不再各说各话。执行器的 resolver 设计成**只认注入**
(默认 null)—— 库函数不该偷读 `~/.claude.json`;生产在 `makeClaudeProfileSwitchDeps`
里显式接线,未接线的调用方保持 pre-1182 行为(测试因此天然 hermetic)。已补回归单测。

### 10.3 Track C 真机 QA —— **25/25 全绿**(`evidence/track-c-autonomous-chain.log`)

把**事故当晚逐字的 pane 文本**喂进**真 dist** 的完整链路(检测 → enqueue → 切换 → 台账),
**全程无人**:

| 场景 | 结论 |
|---|---|
| S1 事故画面被识别 | ✅ 从前 `null`(→ 静默 → 4 个 runner 卡死),现在 scope=model / model=Fable 5;resetAt 是**有界 TTL,不是 5h 的 23:09** |
| S2 自主全链 | ✅ 检测 → enqueue(带 model)→ 切换 → generation 自增。**没有人参与** |
| S3 只 bench 封顶的模型 | ✅ `modelCaps['Fable 5']` 记上,`quotaExhaustedUntil` **原样不动**(该号 Opus/Sonnet 还能用);bench **有限** |
| S4 选号认模型 | ✅ 跳过 Fable 已 bench 的 personal → 挑 school |
| S5 账号级 100% 仍主导 | ✅ scope=5h(字节兼容 FLY-696) |
| S6 529 红线 | ✅ 瞬时限流 → 零检测零切换 |
| S7 外部 `/login` 后台账 stale | ✅ 对账成机器真值 **且 CAS 真的放行 —— 封顶不再被丢弃**(这条一开始是红的,见 10.2) |
| E 生产零污染 | ✅ 三个生产文件 hash 前后一致 |

### 10.4 三条前置的最终答卷

- **③ 模型级覆盖** = ✅ **已修**(本节)。这是「从来没修好过」的真因。
- **① 真封顶自主检测 + 自动切** = ✅ **已验**(Track C S1+S2,可信注入真实事故画面走完真 dist 全链,零人工)。
- **② 手动/外部换账号对账** = ✅ **已修 + 已验**(10.2 + S7)—— 而且比原计划更深:执行器侧的洞是 QA 现场抓出来的。

## 11. Codex 审查 R5–R8 —— 每一轮都抓出真 bug(其中 4 轮抓的是我自己引入的)

这一节如实记录 Codex code review 从 R5 到 R8 的收敛过程。**每一轮都不是空转**,而且**其中 4 轮抓的是我在修这单时自己新引入的缺陷** —— 这本身就是「拿局部证据当全链结论」这个病的连续现形。GO 卡会带这段。

| 轮次 | 严重度 | 抓到的真 bug | 修法 |
|---|---|---|---|
| R5 | HIGH-1 | `quotaCapState` 对模型级封顶的画面返回 "clear" → **revive 会把一个仍卡在封顶上的 runner 判成已恢复**:解决 alert、永不重启。正是 founder 那四个 runner 那一半。 | `quotaCapState` 里模型级 cap 短路;Track C 扩 S8–S11 |
| R6 | HIGH-1 | 我第一版用 **mtime 先后**做身份仲裁 —— 活的 claude session 会改写 `~/.claude.json` 的无关字段、顶高 mtime 但 `oauthAccount` 还是旧的 → 仲裁翻回**错的账号** | 删掉旁证推断;改成台账里**记录**的 `identityStale` 事实(H1 律:有显式信号绝不用旁证猜) |
| R6 | HIGH-2 | detector 用机器真值、执行器却仍信 `.active` —— 机器解析到一个**台账不认识**的账号时两侧又分叉 | 两侧一起 fail-closed |
| R6 | HIGH-3 | `cap===null` 把「没封顶」和「封顶但绑不到账号」混为一谈 → 真封顶但绑定不明时**零 alert** | 拆开:绑不到 → needs_human,不静默 |
| R7 | — | 我谎报「150/150」:python 补丁把隔离块插进了一个**没闭合的 `import {`** 里 → 该测试文件根本没 parse → 贡献 0 个测试。我只看了 vitest 输出的尾巴,没看到 "Test Files 1 failed"。 | 块移到 imports 之后;从**完整 summary**读真数 |
| R7 | — | 固定 12 行窗口两个方向都错:cap 后成功一轮仍在窗内(误杀健康)/ 真封顶被 12 行噪音挤出窗(漏报) | 「行数不是问题,后面有没有成功才是」 |
| R8 | HIGH-1 | 我上一版把「行数窗口」换成「后面有没有成功」—— 方向对,但**漏了「进行中」第三态**:`✻ Cooking… esc to interrupt` 不是成功,于是一个正干活的 runner 仍读成 capped → 会被销毁性关闭 | **换类型,不是补 case**:parseModelCap → tri-state `capped\|clear\|unknown` |
| R8 | HIGH-2 | `identityStale=true` 且身份文件读不到 → 旧代码返回 resolved-via-active,绕过 conflict | 「读不到=不知道」+ identityStale = conflict,fail-closed |
| R8 | MEDIUM-3 | `resolveLeadForIssue` 抛错 → 只 log+return → 真 model-cap **静默**(「LeadWatchdog 兜底」这句在混合模型 fleet 上是假的) | 回退 fleet-default lead 并**照样发**;绑不到 issue thread 也进 ticket queue |

**最贵的一课**(写进 GO 卡):**二元判断装不下「我不知道」。** 凡是「要不要销毁/关闭一个活物」的判断,必须三态;`unknown` 语义定死 = **不动它,但也不沉默**。这是 R5→R8 一路收敛出来的结构性结论,不是某一行的补丁。

## 12. 系统性「静默 return」扫描(Tadashi 直令)

Tadashi 点出:**「静默 return」是这套代码的系统性坏习惯** —— 这一单里已经出现三次(H3 / M3 / 以及 7-11 那晚 4 个 runner 悄无声息卡死本身)。按令扫了 `account-heal` + `bridge` 的 rescue/detect 全部 `catch`/`return` 路径,判定标准:**有没有别的路径把「真事件」变成「什么都没发生」。**

| 路径 | 判定 | 说明 |
|---|---|---|
| `runner-quota-scan` `resolveLeadForIssue` 抛错 | 🔴 **是** → 已修(M3) | 回退 fleet-default lead 并照发 |
| `runner-quota-scan` cap===null 不再分三态 | 🔴 **是** → 已修(H3 + R8 in-flight) | clear=静默(唯一正确的静默);capped-绑不到 / in-flight = 照发 |
| `account-store` / `account-ledger` / `pending-store` 读损坏 → 空 | ✅ 否 | 配置读取 fail-soft;且 cap 现在经 `classifyRunnerCap` **独立**于 store 浮现,台账损坏也不吞 cap |
| `machine-account` 读文件失败 → null | ✅ 否 | 汇入 `resolveMachineAccount`,叠加不确定 → conflict(fail-**closed**),不是静默 |
| `freshness` 读/网络失败 → "stale" | ✅ 否 | fail-**closed** 方向(不谎报 fresh) |
| `account-switch-repair` `onSwitchCommitted` 抛错 → swallow | ✅ 否 | 按契约:switch 已提交,只是台账戳失败,action 照返 |
| `account-switch-watchdog` `executeSwitch` 抛错 → log + 下一个 | ✅ 否 | pending 是**持久**的(未 resolve)→ 下 tick 重试,不丢 |
| `RunnerIdleWatchdog` 包 `runnerQuotaScan` 的 try/catch → warn | ⚠️ 可接受 | best-effort 兜底;scan 内部已各自处理抛错(lead 解析 / alert 发送) |

**结论:cap 流里会把真信号变成「什么都没发生」的路径,只有 H3 + M3 两处,均已修。** 其余 catch/return 要么是配置读取 fail-soft(且 cap 独立于它浮现)、要么是 fail-**closed**(方向正确)、要么是持久重试(不丢)。

## 13. R8 三条修复 + 重跑 QA(2026-07-12)

**改动**(TDD,先 RED 后 GREEN):
- **HIGH-1** `parseModelCap` 换 **tri-state** `ModelCapVerdict = capped|clear|unknown`。cap 检测按**字符预算**归一化(不再依赖固定行数,窄终端 4 行 wrap 也能识别);cap 后有 active spinner / 未完成操作 → `unknown`。下游:revive(`quotaCapState`)unknown → 抛错 → 拒绝+升级(绝不关活 runner);detector(`classifyRunnerCap`)unknown → 不切换、但发 in-flight alert(不沉默)。**顺手修了一个反向潜藏 bug**:旧 `PROGRESS_AFTER_CAP` 把 spinner 字形 `✳`/`·` 当「成功」,会把转圈的 runner 误判成「已恢复」—— 已从「成功」标记里剔除。
- **HIGH-2** `machine-account`:`identityStale=true` 且身份文件缺失/读不到 → **conflict(fail-closed)**;无 sync 失败记录时身份文件缺失仍 resolved-via-active(字节兼容,fresh/QA 机器)。
- **MEDIUM-3** `runner-quota-scan`:`resolveLeadForIssue` 抛错 → 回退 fleet-default lead 并**照发**;真无 lead 可路由时 **loud log**(不是安静 skip)。

**验证**:
- 单测:model-cap-detection 37 + runner-quota-detector 9(含 `classifyRunnerCap` 三态)+ runner-quota-scan 6(含 fleet-fallback + in-flight)+ 全部 quota/account/rescue 相关 12 文件 **172/172 绿**(降并发聚焦跑)。新增三个反例回归:**spinner 活体 / 窄终端 4 行 wrap / 身份读不到**。
- Track C 真机 QA:**44/44 全绿**(36→44,新增 S8b 三反例 5 条 + S11b spinner 走真 revive seam 拒绝+升级+不关闭 3 条);生产零污染(只比对 `~/.claude.json` 的 `oauthAccount` 块)。
- Codex R8 三条 findings 全部修复 → 待 R9。

**仍 HELD**:轨D(529 Room 真机全栈翻活,含真 Keychain 切换)—— 已获 Tadashi 批准但**排在 545 的 Chrome 语音验收之后**(切号会当场打断全机 claude-in-chrome)。GO 卡 founder-gated,绝不自 merge。

## 14. Codex R9 四条修复(2026-07-12)

R9(xhigh)又抓出 4 个真洞,**全在我 R8 的修复里** —— 再一次「局部绿、全链没验」的现形:

- **HIGH-1 — machine-account 的对称缺口。** 我 R8 只给「身份读不到」和「两边不一致」两个分支加了 `identityStale` fail-closed,**漏了第三个对称分支**:`.active` 缺失、identity 可读、identityStale=true 时仍返回 resolved-via-identity。identity 已知可能过期、又是唯一信号 → 会 bench 错账号。**修**:该分支 identityStale=true → conflict(fail-closed);无 sync 失败记录时仍 resolved-via-identity(字节兼容)。
- **HIGH-2 — revive 的固定 20 行窗口废掉了我的字符窗修复。** `makeRunnerQuotaRevalidate` 在调 `parseModelCap` **前**先 `slice(-20)`。cap 后若有 20+ 行惰性 chrome,全 pane 判 capped、裁成 20 行后 cap 被顶出 → 健康 gauge 判 clear → **revive 误报 recovered、resolve alert、真 cap 再次静默失救**(R5 HIGH-1 换个入口复活)。**修**:runner revive 传**全 pane**(parseModelCap 自己判断 cap 是否当前,不需要也不能被行裁剪;Lead revive 本来就传全 pane,两边现在一致)。删掉误导性的 `recentLines` 死字段。
- **MEDIUM-3 — fleet-fallback 仍不可送达。** 我 R8 只换了 `leadId`,payload 仍带 `unknown-project`。真 notifier 的 `resolveLead(leadId, projectName)` 要 **project + lead 成对**匹配 → dead-letter 成 unknown-lead → 默认 Lead **收不到** cap。而我的 mock 测试只证了「alert 被调」、没证「可送达」。**修**:fallback 时 project + lead **一起**换成 fleet-default 对;测试加断言 `projectName === "flywheel"`。
- **MEDIUM-4 — §12 扫描漏了一处 + 一个 notifier 级隐患。**
  - **(a)已修**:`runner-quota-scan` 的 alert catch 用可选 `deps.log`,但生产装配没传 `log` → 生产里是**真静默**。改成 `deps.log ?? console.warn`,所有诊断路径生产可见。
  - **(b)记为 follow-up(不折进本单)**:`LeadAlertNotifier` 先写 dedup claim、再同步 `enqueue` retry queue;若 enqueue 抛错(磁盘满/权限),claim 已落 → 同一 eventId 之后只命中 duplicate → 该事件永不重试也永不送达。**这是共享 notifier 的既有行为,影响所有 alert 发射方,非 FLY-1182 引入**;正确修法是 claim/queue 原子性(enqueue 失败要能释放 claim),属 notifier 级重构,按 scope discipline **不在本单展开**,建单跟踪。

**R9 验证**:machine-account 分支 3 两方向 + runner-quota-scan project 配对 + rescue-runtime「capState 收全 pane 不裁剪」回归单测全绿;Track C 加 S11c(cap 上方 25 行 chrome → 无裁剪真 revive seam 仍判 capped)。→ 待 R10。

**Follow-up 新增**:notifier claim-then-enqueue 原子性(MEDIUM-4b,建 Linear 单)。
