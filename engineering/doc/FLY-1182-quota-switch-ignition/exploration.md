# FLY-1182 Claude 账号 quota 自动切换点火 — 探索

Issue: FLY-1182 (https://linear.app/geoforge3d/issue/FLY-1182/enable-claude-账号-quota-自动切换点火-开关配置-fly-696-8-真机-qa-go-卡-常开)
日期: 2026-07-11（初版）· 2026-07-15（§R Re-ignition 追加，第二次 design phase）
基于: 无（上游资料 = FLY-696/FLY-929/FLY-1049/FLY-1071 各自 doc 文件夹；§R 追加基于 FLY-1256 doc 文件夹 + PR #562/#603 现场审计）

## R. Re-ignition 2026-07-15 — 世界已变，本单重定位（第二次 design phase 追加）

> 本节之后的 §1-§7 是前任 runner（2026-07-11~13）的初版探索，保留作历史与证据索引。
> 本节是重新 dispatch 后的现状审计与重定位主张，是后续 research/plan 修订的依据。

### R.1 为什么重新设计

前任 runner 已把初版计划做完：PR #562（head 分支 origin/flywheel-FLY-1182，86 commits）
implement 19/19，Codex code review 最终轮 APPROVED + CI 绿，2026-07-13 11:21 PARKED
等 Tadashi 把 enable gate 交给 Annie —— 之后 session 消亡（07-13 之后 fleet 连续事故窗），
GO 卡从未开出。本单以三段式重新 dispatch，我是新的 design phase。

**但不能简单「续接 PR #562」—— 07-13 → 07-15 之间世界发生了三个实质变化（R.2）。**

### R.2 三个世界变化

1. **Founder 三实锤评论**（07-13 09:23，Linear FLY-1182 评论）：① Fable **模型级**配额
   静默（07-11 夜，4+ runner 卡死，引擎设计内正确但对她无用 —— qa-report §9 已 root-cause）；
   ② 01:20 `personal1→business` 是手切，引擎台账零记录（generation 恒 1）；③ FLY-1038 runner
   撞 **weekly** 封顶卡在「1 等 / 2 买 credits / 3 升 Team」付费选择题。结论原话：**「GO 卡
   不能给，而且修复不能再排在后面」**。
2. **FLY-1256（PR #603）已 merge**（07-15 17:37Z，issue Done，Opus QA PASS）：**体外**
   quota-monitor daemon（launchd KeepAlive）——直读 Anthropic OAuth usage API（five_hour /
   seven_day utilization + resets_at，不再依赖 pane 文本解析）、阈值触发、**切前验目标账号
   配额**、切换仍走 flywheel-claude-profile（FLY-696 C1 Keychain 机制保留）、切换后 revive
   quota-stuck tmux panes、Bridge-independent Discord alerts。同时 **retire Bridge 三个
   legacy 切换面**（`FLYWHEEL_QUOTA_DAEMON_CUTOVER=1` 门控），只保留 runner quota detection。
   动机 = 07-14 两实证：statusline 配额滞后 + **切号器不能是 Claude 自己**（Claude 断粮时
   一切 Claude agent 失能，daemon 必须在体外）。hermetic e2e 铁证 `fake claude invocation
   count=0`（Claude 全员假死时 daemon 独立完成切号）。
3. **daemon 未点火**：实测无 launchd 项、无进程、无 `FLYWHEEL_QUOTA_DAEMON_CUTOVER` env、
   无 state 文件。生产 Bridge（07-15 13:57 启动）仍跑旧 Bridge 管线（main 版 = **无** PR #562
   的模型级识别修复）。旧引擎的 env（`FLYWHEEL_ACCOUNT_SELF_HEAL=1` + PROFILE_BIN）仍在。

### R.3 现状矩阵 — founder 三实锤 × 三套机器

| 实锤 | 旧 Bridge 引擎（生产现状） | PR #562（未 merge） | FLY-1256 daemon（已 merge 未点火） |
|---|---|---|---|
| ① 模型级 Fable/Opus/Sonnet 封顶 | ❌ 盲（只认账号级 gauge 100%） | ✅ 已修+已验（tri-state model-cap 识别器，Track C 44/44 真机，事故当晚逐字 pane） | ❌ **仍盲**：usage API payload 只有 five_hour/seven_day，无模型维度；revive classifier（quota-revive-scan.ts:24-28）只认账号级句 `Claude usage limit reached` + 100% gauge |
| ② 账号级封顶检测 + 手切后台账失真 | ❌（pane 解析覆盖窄 + 台账无对账） | ✅（machine-account 唯一权威 + incident ledger） | ✅ **架构性根治**（直读 API，不猜 pane；statusline cache 顺带修滞后） |
| ③ weekly 封顶 + 付费选择题 pane | ❌ | 检测 ✅ / 选择题 pane 形态未验 | 检测 ✅（seven_day utilization + 切前验目标）/ revive ❌（classifier 不认选择题形态） |

**要点**：FLY-1256 根治了「账号级窗口」类（实锤②、③的检测半边），但 **模型级（实锤①，
Annie 的头号真实痛点、「1182 从来没修好过」的真因）在 daemon 世界依旧是盲区** —— 模型级
封顶时 5h/7d utilization 才 10~88%，阈值永不触发；卡死 pane 也不被 revive classifier 认。
恰好 PR #562 里有已验证的模型级识别资产可移植。

### R.4 重定位主张（brainstorm gate 待确认）

**FLY-1182 对 Annie 的交付不变**（点火 + 真机 QA + 三问答卷 + GO 卡 + 常开），
**但交付对象从「旧 Bridge 引擎」换成「FLY-1256 daemon」**：

1. 点火 = 跑 `scripts/setup-quota-monitor.sh`（launchd bootstrap + 健康探活 + 持久化
   `FLYWHEEL_QUOTA_DAEMON_CUTOVER=1`）+ Bridge 重启（搭今晚 unified restart 班车）。
2. 真机 QA = 生产点火后验证（daemon 活 + 真 OAuth usage 读到 + 通知落道 + 红线「绝不弄坏
   claude 登录」沿用 FLY-696 verify-before-commit 机制不变）。FLY-696 §8 的机制面大头已被
   前任三层 QA + FLY-1256 Opus QA 覆盖，不重跑；只补「生产实机点火面」。
3. 三问答卷 = 按新架构重写（detect=daemon 直读 usage API；switch=daemon 经
   flywheel-claude-profile Keychain swap；stuck runner=daemon revive tmux pane ——
   注意 v1「不自动搬」的 D2 边界已被 FLY-1256 的 revive 能力**部分取代**，答卷要如实更新）。
4. PR #562 处置 = **关闭留档**（其 Bridge 内检测/切换/翻活管线整个被 FLY-1256 架构性
   retire；86 commits 在 GitHub PR 里永久可见；docs/evidence 已 checkout 进本分支随新 PR
   进 main）。其中仍有效的资产（model-cap tri-state 识别器、选择题形态、机制答卷素材）按
   R.5 的 scope 决策移植。

### R.5 scope 决策点（gate 请 Lead 拍）

- **方案 A（最小点火）**：只做 R.4 的 1-3 + GO 卡。模型级盲区（R.3①）如实写进 GO 卡 +
  立 follow-up issue（把 PR #562 的 model-cap 资产移植进 daemon 的 pane 扫描）。
  优点：最快兑现 Annie 的「打开吧」；风险：GO 卡上她的头号痛点仍写着「未覆盖」——
  正是 07-13 她挡 GO 卡的理由，可能再次被挡。
- **方案 B（点火 + 模型级补课，一单闭环）**：A + 把模型级封顶检测并入 daemon 的 revive
  pane 扫描（classifier 扩模型级句式 + 有界 TTL bench + per-(账号,模型) 维度，资产从
  PR #562 移植，Track C fixture 直接复用）→ 模型级封顶 = daemon 检测 → 切号 → revive
  一条链。代价：中等体量代码（daemon 侧新增识别路径）+ daemon QA 重跑 + Codex re-review。
- **推荐 B**：founder 原话「修复不能再排在后面」+ issue 红线「一单完整不许 phase-split」。
  若今晚点火窗（unified restart）时间紧，可 A 先上车、B 段随后在同一单内继续（不开新单、
  不算 phase-split —— GO 卡在 B 完成后才开）。

### R.6 分支与 push 纪律（操作事实）

- 本 worktree 分支 `flywheel-FLY-1182`（基新 main，含 FLY-1256）与 origin 同名分支
  （= PR #562 head）**同名分叉**：merge dry-run 实测冲突 5 文件（feature-flags registry +
  drift test + account-store + switch-executor + plugin.ts）。
- 处置：随 PR #562 关闭，删/重建远端分支由 Lead 认可后执行（绝不 force push 覆盖）；
  在那之前本分支**不 push**。前任 docs 已经 `git checkout origin/flywheel-FLY-1182 --
  engineering/doc/FLY-1182-quota-switch-ignition/` 引入本分支（纯文件新增，零冲突）。

## 1. 问题定义

Annie GO（2026-07-11 #core：「那你现在就把它打开吧」）。FLY-696 切换引擎（PR #439）+
FLY-929 enable surface（PR #490）+ FLY-865 身份修复 + FLY-1049 Infra Bot 全部已 merge。
本单 = 点火：配置开关 → FLY-696 §8 真机 QA → 机制答卷（Annie 三问）→ GO 卡 → 常开。
一单完整，不许 phase-split。

## 2. 关键事实修正（brainstorm 阶段现场审计发现）

**issue 假设「dormant 出厂待点火」已过时 —— 引擎此刻已在生产点亮运行。**

| 项 | 实测（2026-07-11） | 证据 |
|---|---|---|
| env 配置 | `~/.flywheel/.env` 已写全：`FLYWHEEL_ACCOUNT_SELF_HEAL=1`、`FLYWHEEL_CLAUDE_PROFILE_BIN=<主仓>/packages/claude-runner/bin/flywheel-claude-profile`、`FLYWHEEL_AUTO_REPAIR=1`、`FLYWHEEL_NOTIFY_CHANNEL`、`FLYWHEEL_NOTIFY_DIGEST_EXPECT=1`、双 infra-bot token/user-id、`FLYWHEEL_ALERT_ROUTING/TICKETS=1` | grep `~/.flywheel/.env` |
| 账号池 | `~/.flywheel/claude-profiles/` 已 provision 4 账号（business/personal/school/shopping，0700/0600），`.active`=business | ls + cat |
| 账号状态 | `~/.flywheel/claude-accounts.json`：generation=1、activeAccount=business、全员 quotaExhaustedUntil=null（**至今零切换**） | cat |
| 活 Bridge | PID 10469（Jul 11 06:06 启动）进程 env 实测已带 SELF_HEAL/PROFILE_BIN/NOTIFY 全套 → plugin.ts:5988 的 `accountSwitchRepair` 装配条件满足，watchdog tick 已在 30s poll 上跑 | ps eww |

来龙去脉：env 是 FLY-1049 统一 enable 窗（步 2）写入的；FLY-1071 收尾窗把双 infra bot
拉起并跑了探针与演练①（工单注入），但**明确不做** runbook 步6 ②③④（账号封顶/全封顶/
approve-park 演练）；Jul 11 06:06 的 Bridge 重启把 env 带了进去 → 引擎 live。
FLY-929 的 QA 报告也明确写了「真机激活面（真发 Discord / 真封顶注入）不在 dormant PR
gate，归 enable 窗」——**这块 QA 至今没人跑过，正是本单的活**。

推论：交付 1「配置」收缩为**核对 + 留证据**；本单重心 = §8 真机 QA + 三问答卷 + GO 卡。
风险窗口如实记录：从 Jul 11 06:06 到 QA 绿之间，真实封顶会触发一次未经本机 E2E 验证的
切换（缓解：开发侧 QA-1~6 冒烟 + Codex review 2 轮 APPROVED 已过；观察至今零切换）。

## 3. 方案空间（QA 怎么做才既「真机」又不碰红线）

### 3.1 备选

- **A-only（全隔离）**：529 Room 隔离 Bridge + scratch keychain + dummy service 跑全部
  §8 项。❌ 不满足 §8 注记「真 Keychain/真新-claude 端到端（mock 不算）」——scratch
  keychain 验不了「生产 Bridge 实例真装配好了」和「通知真落 #flywheel-notify」。
- **生产-only**：全部项直接在生产 Bridge 上注入。❌ 双触发/全废/重启恢复/fail-closed
  这类项要反复扰动生产 Keychain 和 Alerts 频道，违反「不打断在飞 runner」红线。
- **三轨混合（选定）**：见 §4。隔离轨吃掉高频扰动项，生产轨只做一次最小真切换演练。

### 3.2 生产演练的注入点选择

| 注入点 | 评价 |
|---|---|
| 伪造生产 Lead pane 显示 cap 文案 | ❌ 要篡改真 Lead 的 tmux pane，扰动大、不可控 |
| 直接手跑 `flywheel-claude-profile use` | ❌ 只验脚本不验生产 Bridge 装配/watchdog/通知链 |
| **写一条 due 的 pending 记录（选定）** | ✅ `account-switch-pending.json` 是 durable 注入面：生产 Bridge 30s watchdog 读到 due 未 claim 记录 → 真跑 executeSwitch → 真 Keychain 切换 → 真贴 #flywheel-alerts 🔧 + #flywheel-notify 🟡 digest。检测层（pane→parser）绕过，但那层由轨A 全链 + 单测覆盖 |

pending 记录 schema（`pending-store.ts`）字段齐全可手工构造（key=sourceAlertId+
observedAccount+generation、scope、resetAt、deadlineAt）；写入必须持共享 flock
（`mkdir-lock` 协议）——与生产 watchdog 天然互斥，安全。

## 4. 选定方案：三轨 QA

- **轨A — 529 Room 隔离全链**（覆盖 §8 #1链路/#3/#4/#5/#6/#7/#8/#9/#10/#11/#12/#13/#16）：
  隔离 slot Bridge + 引擎现成隔离旋钮（`FLYWHEEL_CLAUDE_PROFILES_DIR`/`_ACCOUNTS_PATH`/
  `FLYWHEEL_ACCOUNT_PENDING_PATH`/`_ACCOUNTS_LOCK`/scratch keychain via
  `FLYWHEEL_CLAUDE_KEYCHAIN`+dummy `_KEYCHAIN_SERVICE`/`FLYWHEEL_CLAUDE_JSON`）+ 隔离
  测试频道。真 pane 注入 cap fixture → 真检测 → enqueue → watchdog → 真 security CLI
  切换 scratch keychain。
- **轨B — 生产真切换短窗演练**（覆盖 §8 #1 真 Keychain/真 claude、#2 登录不坏、#3 真通知
  落 #flywheel-alerts + #flywheel-notify；= FLY-1049 runbook 步6② 欠账）：pending 注入 →
  生产 Bridge 真切 business→next → 新 claude 读新账号（含 FLY-865 显示身份）→ 立刻切回 +
  状态复原。
- **轨C — 观察期**：常开后首次自然封顶 = 终验（不阻塞 GO 卡；观察项交 Tadashi）。

## 5. Lead 裁定（brainstorm gate，Tadashi APPROVED 2026-07-11）

1. **轨B 授权**：不需单独等 Annie 批演练（issue 文本 + 她的「打开吧」已覆盖），但四条件：
   (a) **轨A 全绿后才进轨B**；(b) 安静窗口 + 事前基线 + resetAt 兜底；(c) **执行前 ask
   Tadashi 一次**（他核当下机器状态，如语音 venue 在跑就推迟）；(d) 轨B 开跑时 Tadashi 在
   thread 给 Annie 一句知会（透明但不设 gate）。
2. **如实说明**：GO 卡必须写明「引擎已随 Jul 11 06:06 重启点亮、至今零切换、QA 是补验」。
   （Tadashi 同时先行向 Annie 修正他早前的「dormant 待点火」说法，不等 GO 卡。）
3. 三问答卷方向已确认准确（30s pane 扫描+parseUsageGauge / Bridge 内 executor+flock+CAS+
   verify / v1 不搬+恢复手册），写进 qa-report 人话版。

## 6. 边界（初版，被 §7 scope 更新部分推翻——以 §7 为准）

- §8 只做 **M1 项（1-13、16）**，与 FLY-1049 runbook 步7 一致；~~#14（infra-bot 深度
  claim 演练）归 M2/FLY-841~~（**§7 ② 改判：bot 交叉互救真路径 IN SCOPE**）；#15
  （re-login）仍归 M3。
- ~~预期零生产代码改动~~（**§7 ① 改判：quota-stuck 翻活是新能力，本单要写代码**）；
- founder 打扰预算：只在 GO 卡打扰 Annie 一次。

## 7. Scope 更新（Annie 直令，lead-instruction a861ef01，压过 issue 原文 v1 边界）

design_review 阶段收到 Tadashi 转达的 Annie 直令，三点：

1. **交付新增第 6 项 — Codex InfraBot 逐个翻活卡住的 session（IN SCOPE，不许
   follow-up 化）**：换完 profile 后，由 Codex InfraBot（LLM 值班 bot）识别所有卡在
   quota 的 session 并逐个恢复（新 session 自动用新账号；旧 session 由它判断
   close+redispatch 或注入恢复）。**PRD 的 D2「v1 不搬」被 Annie 撤销**（PRD §6.2 边界、
   §9 D2、CMP-1/CMP-3 ⑤ 三处失效）。
2. **切换执行者按 PRD CMP-1 交叉互救**：Claude 侧切换由 Codex InfraBot 执行（谁都不救
   自己）—— enable 时验证这条真路径（即 §8 #14 的 bot-claim 演练回到本单）。
3. **策略调优记录（先不实现，写进 doc）**：5h 封顶时也优先切「reset 最近且有余量」的
   账号（Annie 提议；v1 先按 PRD 现行选择逻辑跑通再调）。

### 7.1 现状机器 vs 新交付的差距审计（研判见 research.md §8-§9）

- **交付 6 = 真·新能力**。现有 rescue 机制（FLY-871，rescue.ts/rescue-runtime.ts/
  rescue-route.ts）的守卫**只认 login_expired / runner_login_expired** confirmed
  alert —— quota-stuck（usage_limit）session 不在可救范围；founder-only-authority 的
  R3 carve-out 也只豁免 login 救援。→ 需要：rescue 守卫扩 quota-stuck 类别 + R3 式
  carve-out 扩展 + Codex InfraBot persona 扩展 + 测试 + QA 演练。
- **交付 ② 的真实偏差（design review 已核）**：成功 enqueue 路径**有** @-bot
  assignment（AlertChannelHub 对 account_switch 明确 mention Codex bot）—— 真偏差是
  pending 的 bot-claim deadline 默认 20s + watchdog 30s poll 兜底，LLM bot 实际几乎
  抢不到 claim。QA 用加长 deadlineAt 的注入让 bot 真跑一次 claim 路径，20s 时序偏差
  写成 finding（deadline 改动 = follow-up）。

### 7.2 交付 6 的 actor 设计（本 runner 的选型，re-gate 请 Tadashi 确认）

- **bot-owned（贴 Annie 原话）**：Codex InfraBot 看到切换成功证据 → 本机直读状态识别
  quota-stuck session 清单 → 逐个经 **rescue-route（现成 fail-closed bot 入口）扩展的
  quota_stuck 类别**恢复：runner = close + resumed-successor（复用 FLY-871 现成原语，
  新 audit reason）；lead = launchctl kickstart 原地重启（同 FLY-871 原语）。
- **「注入恢复」的诚实边界**：D1 语义下活 session 握旧账号内存 token —— 换号后 retry
  是否能拿到新凭据（token refresh 是否重读 Keychain）是**经验问题,QA 阶段实测**;
  v1 可证有效的杠杆 = close+redispatch / kickstart（新进程必读新 Keychain）。bot 的
  「判断」= 先试 nudge（若实测有效）、不行走 close+redispatch。
- **不做 Bridge 自动 sweep**（v1）：翻活的 owner 是 bot（Annie 点名）;bot 挂了的退化
  行为 = 现状（等 reset），可接受。
- **无独立开关（lead-instruction flag-removal,后补）**：翻活不设自己的 flag,与
  切换共用 self-heal enable 路径;merge + 重启直接生效,GO 卡即批准点;缺陷时
  revert PR（Annie 已接受该权衡）。
- 影响 ship 形态：**本单出代码 PR → 需 batched 生产 Bridge 重启**才生效（重启纪律照
  memory 规则，与其他待 ship PR 攒一次）。
