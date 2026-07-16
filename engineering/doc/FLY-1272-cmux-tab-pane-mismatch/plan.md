# FLY-1272 cmux tab 名↔pane 内容串台 — 实施计划

Issue: FLY-1272 (https://linear.app/geoforge3d/issue/FLY-1272/fix-cmux-tab-名pane-内容串台-一个-tab-显示错的会话codex-单显示成-claude-husk今晚坑-founder)
日期: 2026-07-16
基于: research.md（v24，含 §10 R1-R25 修正史）
版本: plan v27（R25 收尾：清除最后两个活跃段裸词冲突（版本行不写旧 refresh-ACK success token 本体；@id follow-up 改叫 generation-scoped authority guard），P8 baseline=0 已实跑证明）

## 0. 一句话

cmux tab 显示层改为 **link-window 隔离**（view session 只含自己的目标窗，串台物理不可能）+ **invariant 校验兜底**；显示层拆除按 linked/grouped 分叉（linked=tmux unlink 原子拒绝；grouped=escrow rename 永不删除）；view 建造走 **staging WAL + 原子 rename 认领**；TS 侧只改一件事：**A=1 下一律跳过按名杀 view**（跳过 kill 永远非破坏性，无 TOCTOU）。杀 runner 窗仍是 lifecycle 既有权威与既有行为，本单不碰。

## 1. 目标与验收（真机；产品保证的适用模式如实声明）

起一个真 Codex implement 单 + 一个 weekly-limit Claude husk 共存：cmux 里 Codex 单的 tab 点进去显示的就是那个 Codex 会话，**绝不显示成别的 husk**。kill Codex 窗后 tab 允许显示自己的 dead pane / 掉壳 / 被关闭，但永不显示别的 issue 的会话；同名重生后 ≤2 个 conclusive additive pass 内恢复**安全拓扑 + 权威 ref**——**无孤儿 client 且 post-create 读取结论明确**的普通场景经 FLY-169 自愈收敛回正确会话；**任何 attachment_unverified 分支**（历史遗留 unnamed 孤儿 client，或 post-create 读取失败——含 pre=0 变体）的**显式接受终态=裸壳/缺 surface + ref 绑定告警**（R20-R23：验收不承诺这些分支收敛回正确会话——告警≠收敛、无重试 owner——但承诺不假绿）；全程 ≥10min 无 tab appear/disappear 振荡（FLY-873 E2E 模式）。

**保证的域边界（R19 #2 + R20 #2 升格为硬停 gate）**：本单的「绝不显示别人」保证覆盖 **ledger-committed 的 Flywheel 管理 tab**。founder 自建的同名 tab（unledgered）不在保证域内：它保持可见、不被本单触碰、其显示内容由其自建 attach 决定；发生同名冲突时权威 tab 缺位+告警等人工。此边界为第三次降海拔的显式代价——曾设 **pre-P0 硬停 gate（见 §4 开头）**，**Lead 已书面接受（f2b5be93，2026-07-16，原文见 §4）**：「告警+人工解决」契约冻结照此实现。gate 已 resolved，不给 B 加处置权。
**保证的模式边界（如实，R6 #1）**：上述「绝不」适用于**出货默认配置 A1**（link 拓扑收敛完成后——linked view 单窗，fallback 物理不存在，**与 B 无关**）；迁移过渡窗内的 grouped 残留由 B（默认 on）≤2 个 conclusive additive pass 收敛。**A=0 回滚模式 = 回到旧行为，包含旧 bug**（kill-switch 的定义即如此——Tadashi 钉子②「=0 回旧行为」；A0B1 时 B 把旧串台压到 ≤2 pass，A0B0 为完整 legacy 含事故行为）。QA 按模式分别断言。

## 2. 统一决策表（唯一权威合同）

### 2.1 显示层拆除（杀伤边界，Lead 钉子原文）

B 校验不一致且无同名活窗时，杀的是 view session + 关 tab——**只杀显示层，底层 tmux 真窗/runner 进程一根手指都不碰**（家规：kill 显示壳 ≠ kill runner；FLY-873 血史）。

| view 拓扑 | 拆除方式 | 安全根据 |
|---|---|---|
| linked（session_grouped=0） | 关权威 ref（2.4）→ 逐窗 `unlink-window` 无 `-k` | tmux 对最后引用**原子拒绝**（action-time）；被拒 → keeper |
| grouped（=1） | 关权威 ref → **escrow rename**（永不 unlink/kill 其窗） | E7：grouped unlink 波及整组 |
| 读不确定 | 零 mutation，本 tick 停 | fail-closed |

适用：全部新增路径。A=0 既有 shell 调用方保留历史裸 `kill-session`（byte-compat legacy）。

### 2.2 A×B×拓扑 行为矩阵

| | A=1 | A=0 |
|---|---|---|
| create/view 建造 | staging 原语（P1） | grouped 分支逐字 legacy |
| 修复派发 | linked 收敛（原语） | grouped 修复（组内 select/旧式重建）；永不产生 link 拓扑、永不调用 unlink 拆除器 |
| bootstrap 收敛目标 | 独立 ∧ 窗集{赢家} ∧ active ∧ owner ∧ 无 marker | grouped ∧ current 指赢家 |
| B=0 关闭（且仅此） | verify 修复与拆除、bootstrap absent 拆除、跨 tick 闩 | 同左 |
| A0B0 | — | 完整 legacy（legacy 清理照常）+ 一次 bootstrap 反向收敛；keeper 不可反迁移如实 pending。**限定（R10 #5，标记版）**：maintenance 标记是 A/B 之外的运维联锁——标记存在时任何模式（含 A0B0）的 mutator 都退让；「完整 legacy」以标记已清除为前提 |

### 2.3 TS 侧改动（R7 终形）

**唯一行为改动**：`killCmuxLinkedSession(tmuxWindow)`（签名沿现状，入参 tmux target）按 **A flag** 分支——

| A | 行为 | 理由 |
|---|---|---|
| A=1 | **一律跳过按名杀**（任何拓扑，含观测 grouped/uncertain），返回 `{killed:true, viewSkipped:true, cmuxSession?}`（可缺省，见下） | 观测→按名杀之间存在 name-rebind TOCTOU（R7 #1：watcher 可在间隙 escrow 旧 view 并原子认领同名新 linked view——按名杀会打中替身，甚至杀掉 sole-holder 窗）。跳杀是唯一无 TOCTOU 的选择：**跳过 kill 永远非破坏性**。flag 判定在 fail-safe 方向上安全——与 R4 否掉的「flag 判定是否杀」本质不同（那是破坏性方向）。skew 代价：A=1 Bridge × A=0 watcher 时 grouped view 未被预杀 → 窗杀后 fallback → 由事件清理/conservative/B 收敛（事件丢失可到 conservative 路径——**rollout 的真正上界是 §6 的 watcher 静默次序，不是延迟数字**，R8 #1），无 runner/新 view 伤害 |
| A=0 | **legacy helper 逐字**（解析→按名杀） | byte-compat 回滚语义 |

- **返回合同冻结（R7 #2 + R8 #5）**：签名沿用现状（入参 tmuxWindow target，非 title）。A=1 分支仍需 display-message 解析窗名以构造 cmuxSession（close-runner pin marker 用）——解析失败/源已亡/名为空时该字段**可缺省**：`{killed:true, viewSkipped:true, cmuxSession?:string, resolutionError?:string}`；`killed:true` 语义=「cmux 前置步完成，lifecycle 可继续」（保住 crash-reaper/stale-blocker 的 killed==false 硬门）；cmuxSession 缺省时 close-runner 跳过 pin-close marker、交 ledger reaper 收敛。A=1 下一切解析结局均为 lifecycle-permitting 且零破坏。六 caller 在 skip/解析失败/legacy-failure 下回归测试（含 missing window/空名/display 失败）。
- **部署次序（R7 #2）**：正向=先部署/重启 A-aware Bridge、后开 A1 watcher 收敛（旧 Bridge 的无条件按名杀不得与新 linked 拓扑共存）；回滚反序（watcher 先收敛回 grouped、Bridge 后回 legacy helper）。写进 rollout/rollback runbook（§6）。
- **不引入**：条件化杀源窗、全局裸 @id 杀、cleanup_pending、staged lifecycle 事务、拓扑读数依赖。`killTmuxWindow` 一字不动。
- **显式登记的既有缺陷 follow-up（不在本单修）**：(a) `killTmuxWindow` 对 session-not-found 报 killed:true 而 E6 sole-holder 态窗仍活——今天的生产行为即如此，runner-lifecycle 域，报 Lead 建单；(b) tmux @id 跨 server generation 复用 → 任何未来 kill 权威设计必须带 **generation-scoped authority guard**（tmux-generation 核验门），备忘入 follow-up。
- 后置收敛依据：A1 稳态无 grouped view（结构性）；过渡窗残留由 B ≤2 conclusive pass 收敛（§1 模式边界）；A0B0=legacy 接受。
- 交错测试（R7 #1）：观测 grouped → watcher escrow+认领新 linked view → 断言新 view 与其窗存活（A=1 跳杀使该测试天然通过；A=0 下断言 legacy 行为原样）。

### 2.4 workspace ref 权威（R6 #7 + R7 #3/#5 终形）

- ledger 行=`state|socket_generation|ref|title`，**prepared/committed 两态**（R7 #5）：create 在取得恰一 ref diff 后先落 `prepared`（此刻 workspace 还是 unnamed——prepared 行只授权「恢复该确切 ref 的 unnamed 态」：rename 成功读回后升 `committed`；rename 失败/crash → 恢复**只**按 prepared 行处置该确切 unnamed ref（重试 rename 或 guarded 关；绝无「通用 ghost 路径」兜底——无行的 unnamed 一律 leak+告警），**GC 不删 prepared 行**（只删「committed ∧ ref 亡或 title 变」的行；uncertain 全保留）。
- **guarded chokepoint**：新模式下每个破坏性关 ref 动作走一个 `cmux_call_guarded` 式收口（既有模式，行 221-263）——IPC 前最后一步重验 socket generation、权威行、当前 ref/title 绑定；任一不符 → 放弃本次关。
- **prepared 行对账分支（R8 #4）**：确切 ref 仍 unnamed → 重试 rename 或 guarded 关闭；确切 ref 已带预期 title（rename-executed-but-output-lost）→ 读回升 committed；ref 已亡 → 安全退休该行；title/generation 不符或 uncertain → 保留+告警。ledger 写失败的 create 孤儿 → leak+告警（绝不落入通用 ghost 清理）。
- title-only 准入（`is_managed_runner_title`）仅存于 A0B0 legacy 分支。**不做破坏性 backfill**。
- **pre-upgrade 存量的迁移解（R12 后第二次降海拔，Lead 拍板）**：**不建迁移辅助命令、不建迁移 fence、不建 manifest 协议**——为一次性迁移 ~20 个 tab 配一套分布式协议是尾巴摇狗（R10-R12 的 findings 全部产自这套可选装置）。最笨路径：
  - **maintenance 标记**（唯一新增机制，几行）：**固定生产路径 `$HOME/.flywheel/state/cmux-maintenance`**（durable；R13 #2；实现用 $HOME 展开不存字面 ~）。**provision（R14 #3）**：runbook touch 前 `mkdir -p "$HOME/.flywheel/state"` 并读回确认（目录建失败/标记读不回 → runbook 停）；installer 现状只建 ~/.flywheel/bin，故此步由 runbook 自带。env 覆盖仅供测试。watcher 启动（launchd/autostart 两路径）、--once、dead-watcher --refresh、一次性 reaper、test-teardown 的入口检查：标记存在 → supervised launchd=非持有有界轮询等待（transition-only 日志，防 KeepAlive 30s respawn churn）、.zshrc autostart 与 one-shot=一次性退出并提示、teardown=整体拒跑（含进程杀与 FS 清理，R11 #2 语义保留）。
  - **迁移 runbook（全人工，权威无可置疑）**：① 置 A=1 → restart-services 重启 Bridge → 验证 skip 分支；② `touch` maintenance 标记；③ `launchctl bootout` 旧 watcher + `pgrep` 确证进程退出 + **静默探测三态合同（R14 #2 + R15 #2 定名 `flywheel-cmux-sync --probe-lease`，只读、绝不偷锁/收锁，复用同一 lease 校验器）**：锁目录 absent → rc=0 通过；**良构且身份核验的活 owner → 有界轮询等待（操作员可取消），仅在目录转为 absent 后 rc=0**；畸形/不可读/身份不明/stale-but-present → rc≠0 停下人工诊断。测试：活 owner 释放、轮询中记录变化、畸形/截断记录后有活进程、stale-but-present（停不放行）；④ 操作员**在场**于 cmux UI 里手关全部 Flywheel tab（约 2 分钟、~20 个 tab；人手点 X = display-only + 人工授权 + 零代码权威问题；关错了也只是 tab、会被重建）——此步为 Tadashi 批准的显式人工环节，不做自动化。「关错会被重建」仅适用于**有活源窗的 Flywheel 管理 tab**——founder 自建/非 Flywheel tab 不在重建范围，操作员先截图留存并**不碰它们**（R13 #4）；⑤ **完成后置条件（操作员 stop 条件）**：用只读 cmux 列表核对 **Flywheel workspace ref 已清零**（漏一个=该 tab 无 ledger 行、新模式关不掉、还挡住 create 重建——覆盖窗就没闭合）；有剩余或不确定 → 保持标记继续手清，中断后**恢复核对而非盲目清标记**；核对通过才翻 env、`rm` 标记 → `launchctl bootstrap` A1 watcher → bootstrap 收敛 + create 全量重建自动入账（新 tab 全部走 create 路径落 ledger——**无破坏性 backfill 的空窗就此闭合**）→ 验证 lock owner PID + knobs 行。
  - 回滚同型反向：**同一 marker 窗人工流程**（touch 标记 → bootout+静默 gate → 视需要手清 → A=0 → rm 标记 → bootstrap 反向收敛）；发现已有标记残留=上次人工流程未完成 → **恢复核对续走**，绝不盲清（R13 #4/#5）。
  - 测试：标记存在时各入口行为（launchd 零 churn 轮询、autostart/one-shot 退出、teardown 拒跑）、标记窗内 .zshrc 新 shell 不拉起 watcher、标记清除后正常 bootstrap。

### 2.5 keeper（descope 范围扩大，R6 #6）

- 产生：escrow 事务（owner option 先派生持久化——legacy grouped 从 validated `#{session_group}` 派生 → 权威 ref 关闭确认 → **inventory 行先写 state=prepared** → rename `fwkeeper-<session_id>-<原名>` → 复读 → inventory 更新 state=committed；任一不确定停 tick）。
- **inventory = 本单完整 operator 合同**（R6 #8 + R7 #7 对账分支）：行=`tmux_generation|session_id|exact_name|owner|窗@id集|state|epoch`；mkdir 锁原子 RMW。bootstrap 对账三分支：缺行 × live keeper → 重建；**prepared 行 × 匹配 live keeper**（generation/session_id/名/owner/窗集读回全符）→ 原子升 committed；prepared 行 × 原 session 仍在（rename 未发生）→ 保持 pending 等重试或以已证明的非 mutation 结局退休；不符/uncertain → 保留 + 告警。畸形行保留不授权；GC 只删「session 已不存在」的 committed 行。Discord 可见性 = 具名 follow-up（FLY-368 bot 读 inventory；请 Lead 建单，与 keeper-GC follow-up 同批）。
- **无自动 GC**（Tadashi 批的显式 descope）。**人工 grouped reclaim 辅助命令同样 descope**（R6 #6：guard 协议自身需要 WAL/teardown 认知/组变异防护，超出本单价值密度；Codex 建议的选项一）。归属：QA 槽 keeper → test-teardown（本单已接）；生产 keeper 滞留 → runner-lifecycle 域 follow-up（与 keeper-GC 同单，Lead 已记）。容量诚实：迁移产生 ≈tab 数个 detached keeper session，持有的窗在源 session 存活期间本就存在，增量=空 session 结构，等 follow-up 收。
- teardown 认权杀不受影响（owner 明确=本槽即可杀，teardown 是所有权明确的既有回收方）。

### 2.6 快照与负载

additive pass 顶部一次严格 tri-state 源快照；任一新 flag 开启且 uncertain → 本 pass 缺席型 mutation 全跳（测试断言零 mutation）；两 flag 均 0 不启用门。零新 timer；每 pass 一次快照 + 每 view 一次 display-message。显式例外：FLY-293 关前即时重读保留。absent settle=跨 tick 闩（两次 conclusive）。

### 2.7 破坏性入口清单（R6 #9——每个入口的门与行为）

| 入口 | 新 flag 模式下 | A0B0 |
|---|---|---|
| watch 60s additive（reconcile/conservative/reaper/B） | 严格快照门 + ledger 权威 + 2.1 拆除 | legacy 逐字 |
| bootstrap（收敛 + gc_*） | 同上 + 终态判定 | legacy 逐字 + 反向收敛 |
| 事件驱动 30s pending cleanup | is_pane_alive 判定沿用；执行段走 2.1 拆除 | legacy 逐字 |
| **事件驱动 create（drain create 事件臂）** | **A=1 下不加快速重建分支（R18 第三次降海拔）**——create 事件对已存在 workspace 维持 attach-only 现状（两模式零改动）。同名重生走既有 additive 机制：reconcile（workspace 在 ∧ linked session 死 → **新模式只关本单 ledger-committed 的 ref**——reconcile 现源码关全部同 title ref，此处为适配点；unledgered 同 title ref 留+告警）→ create 全流程重建。**收敛合同（R19 #1 诚实收窄）**：健康 ≤2 个 conclusive additive pass 内证明**安全拓扑 + 权威 ref 重建**；surface attach 在既有 verify-at-create 的弱证明角落（session 级 client 计数——**它在任何地方都不被称为 attach 证明**：一个历史遗留的 unnamed 孤儿 client attach 在 cmux-T 上时，计数为正会让重试停止而新 tab 仍是裸壳）下可能失败——**任何 attachment_unverified 分支**（孤儿 client 角落或 post-read 失败，含 pre=0）的**终态=裸壳/缺 surface + 操作员告警**（可接受的显式终态，告警≠收敛、无重试 owner；**无孤儿且 post-create 读取结论明确**的普通场景由既有 FLY-169 self-heal 的 0-client 门自愈）。**告警的实现载体（R20 #1 + R21/R22 fail-closed 补全——最小 create 时歧义分类器，非状态机）**：create 在发 new-workspace **之前**严格捕获 canonical view（cmux-T）的 client 集/计数快照。归类规则两条：**(i)** 预捕获**非 0 或不可读** → 事后任何正计数一律归类 `attachment_unverified`（预捕获=0 时事后正计数按既有弱证明沿用）；**(ii)** **任何 post-create 读取失败/不可读**——**不依赖预捕获值，pre=0 同样适用**（现源码 2201 行对 view_session_client_count 失败直接 break：普通无孤儿场景也会静默停在裸壳且 sync_additive 常规路径无人补救，R22 #1）——一律归类 `attachment_unverified`。归类为 unverified 时：拓扑/权威 ref 建账照常完成、不设重试 owner，但函数结果/日志/测试**永不把该 surface 标为 attached**，并在**函数退出前**发出**按 generation+新权威 ref+title 键控**的告警（既有「unledgered unnamed 孤儿」通用 WARN 不算数——它不绑定新 ref、也不证明 surface 被归类 unverified）。期间与终态下 tab **永不显示别的 issue**（A 结构保证与时延/attach 无关）。回归（突变验证）：**① 预置孤儿 client + 新 attach 失败 → 断言不假绿 + 断言该 ref 绑定告警本体**（不是任意 WARN 行）；**② attach 失败 + post-create 读取失败 → 断言权威 ref 保留、无 attached 假绿、精确告警本体仍发出——pre=0 与 pre 非零两变体都必须覆盖**（R21+R22：post-read 失败无条件 fail-closed） | legacy 逐字 |
| **`--refresh`** | **A=1 下其存在理由消失（R12 后定稿）**：--refresh 修的是 grouped view 的 current-window 指针漂移（FLY-98），linked view 单窗**无指针可修**；Lead/Runner 重启后 tab 经 additive pass 的 reconcile+create 重建（≤2 conclusive pass，如实合同见上行——R18 后不设事件快速分支）。故 A=1：watcher 活 → **诚实 no-op**（打一行说明）；watcher 亡 → 取 mutator lease 跑收敛；maintenance 标记在 → 退出提示。`restart-services.sh` **零改动**（其 +5s --refresh 调用无害 no-op；+10s refresh-surfaces 纯重绘照旧）。**不建请求/ACK 协议**（R12 #1 的版本 skew、#4 的 scope 语法、#5 的 caller 合同随之整体消失） | legacy 逐字（tmux-only select 修复） |
| **迁移**（§2.4 runbook） | 无代码装置：maintenance 标记 + 停 watcher + 操作员 UI 手关 tab（human display-only 动作，不是脚本入口） | 同型反向 |
| FLY-293 reaper 一次性入口（reap_orphan_pins_oneshot） | ledger 权威 + 关前重读（guarded） | title-only legacy |
| test-teardown（QA 槽） | **以 `qa_teardown` lease 模式取共享 mutator lease**（R12 #2：入口裸检查是 check-then-act；持锁下检查 maintenance 标记，标记在 → 整体拒跑，含进程杀与 FS 清理——R11 #2：杀 session ≠ 杀窗，E6 下 view 引用可保窗与 runner 进程存活）；持锁至全部 tmux/worktree/slot mutation 结束（owner-only 释放；两向 barrier 测试 + teardown 持锁中进程死亡测试） | 同（标记与 lease 是 A/B 之外的运维联锁，同样适用） |
| TS killCmuxLinkedSession | A=1 一律跳杀（2.3 表，零破坏） | A=0：legacy 按名杀逐字 |

## 3. 变更总览

| 文件 | 改动 |
|---|---|
| `scripts/flywheel-cmux-sync.sh` | A+B：staging 原语（WAL intent/completion 对）、分叉拆除、escrow+inventory、ledger（generation 键、无破坏性 backfill）、快照门、收敛 sweep、reaper ledger 化、keeper inventory 重建、--probe-lease、maintenance 标记检查、**create 时 attachment 歧义分类器**（R20-R22：new-workspace 前预捕获 canonical view client 集 → 非 0/不可读时事后正计数归类 attachment_unverified；**任何 post-create 读取失败/不可读无条件归类**（不依赖预捕获值）；unverified 一律函数退出前发 ref 绑定告警；**无事件快速重建分支**——R18 后砍除） |
| `packages/teamlead/src/bridge/tmux-lookup.ts` | §2.3：killCmuxLinkedSession 按 A flag 分支（A=1 一律跳杀 + 冻结返回合同；A=0 legacy 逐字）；六 caller 零流程改动，仅回归测试 |
| `scripts/test-teardown.sh` | qa_teardown lease 模式 + maintenance 标记整体拒跑 + owner 解析 + 三命名空间（`^cmux-`/`^fwkeeper-`/`^fwstage-`，stage 以 owner option 或匹配 WAL intent 认权）+ 只杀本槽 |
| `scripts/flywheel-cmux-autostart.sh` | 两 flag 提取（precedence/bool-only/fail-closed；绝不 source 整 .env）+ maintenance 标记检查（.zshrc 路径一次性退出；supervised 由 sync 脚本内有界轮询承担） |
| （已撤）迁移辅助/install --migrate/restart-services 改动 | R12 后降海拔：迁移走人工 runbook，无新脚本；restart-services 零改动 |
| `packages/config/src/feature-flags/registry.ts` + registry 测试 | 两行注册；readSite per-flag 如实（A=3：sync/autostart/tmux-lookup；B=2）；per-flag 精确断言 |
| `scripts/test-cmux-sync.sh` | 文件承载状态机 mock + 新单测 |
| `scripts/test-cmux-sync-hooks-integration.sh` | 真 tmux 事件过滤 + 源侧阳性对照 + grouped 身份 oracle + unlink 拒绝回归 |
| `scripts/__tests__/test-cmux-autostart-flags.test.sh`（新） | 提取器 hermetic（stub exec） |
| teardown 测试（落位 PR 写明） | 所有权 + keeper/stage 正负例 |
| `engineering/doc/FLY-1272-cmux-tab-pane-mismatch/` | 三件套 + progress |

## 4. 实施步骤（TDD；负向断言全部突变验证）

**pre-P0 硬停 gate（R20 #2）——已 RESOLVED（2026-07-16）**：Lead（Tadashi）对决策问询 f2b5be93 的书面答复（原文）：「接受。founder 手动建同名未入账 tab 是极罕见的自造碰撞、非事故路径（事故里 husk 是 Flywheel 自己入账的 tab、已被 A 结构性修死）。域外碰撞用「告警+人工」足够，不值当为它加对 foreign tab 的处置权把复杂度拉回去。冻结现契约照此实现。」→ §1 域边界照现契约冻结，P0 可开工。Implement 阶段 Runner 开工前核对本段存在即可。

### P0 — mock harness
文件承载状态机（`-P -F` 子 shell 写不回父 shell——文件法）：窗引用/group 语义/unlink 拒绝/active/options/journal/失败注入。突变验证逐步覆盖。

### P1 — staging 原语（WAL intent/completion 对，R6 #5）
WAL 状态机：`create_intent(nonce|view|src|@wid)` → `created(stage_session_id|placeholder_@id)` → `link_intent` → `linked` → `claim_intent` → `claimed_complete`。**intent 先落、completion 在 mutation 验证后落**；恢复表按「WAL 状态 × 观测拓扑」二维对账：
- 仅 create_intent：探测确定性 stage 名（fwstage-<nonce>）——**证明 absent** 才清 WAL；存在 → 视作 created 续走恢复（stage 只可能含自有初始窗 → 按 stage session id 整杀）；
- created/link_intent：stage 成员集证明（{placeholder} 或 {placeholder,target}）→ 清理（unlink 我方引用，拒绝=escrow_required：stage 直接 rename 成 keeper）+ 按 marker 证明杀占位；矛盾读=零 mutation+告警（corrupted marker 覆盖于此）；
- linked/claim_intent：staging 终读证明 → 继续 claim 或按上清理；
- claim_intent 后的接受条件（R7 #6）：canonical 身份/拓扑/owner 全对 **∧ canonical 的 session_id == WAL 记录的 stage_session_id**（rename 保 session id——这是「就是我们那次建造」的身份证明）**∧ 确切 fwstage-<nonce> 已 absent** → 落 claimed_complete 清 WAL；canonical 与 stage 并存（rename 失败/撞名）→ 只按证明清理/escrow **stage**，WAL 留存 + 告警；canonical 存在但 session_id 不符 → 他人 canonical，留 WAL + 告警，绝不认领也绝不清；
- claimed_complete：清 WAL。
- WAL 行含 tmux server generation；版本化记录语法；畸形行=零 mutation+告警；teardown 依 WAL intent 认权杀 stage 时同样要求 generation/身份全配。
- **shell mutator 单一 lease（R8 #2 + R9 #2 身份与重入合同）**：现有 watcher 锁校验器（_pid_is_watcher 只认 --watch 命令行，行 2989-3106）会把持锁 one-shot 判成 stale 抢锁——**泛化锁记录**：`pid|进程 incarnation（PID+进程启动时间等可外部核验的开始身份）|mode|nonce`；PID 复用由 incarnation 拆穿，nonce 只用于 owner-only 释放。**API 分裂**（重入合同）：顶层 one-shot（--once、dead-watcher --refresh、一次性 reaper、qa_teardown）用 `acquire_mutator_lease`；watcher 体内调用（含 FLY-254 pre-heal reopen 消费）用 `assert_or_reuse_owned_lease`（断言自己已是 owner，绝不对自己的锁等待）。授权 mode 全量枚举；supervised watcher 对 live one-shot owner=有界等待（FLY-177 模式），只对确证死亡/PID 复用 owner 收锁。测试：同 owner 嵌套 prologue、trap/嵌套清理、同 mode PID 复用、畸形记录、owner-only 释放、supervised × 各 live one-shot。
- **mutator prologue（R8 #6，全 mutator 入口统一次序）**：取 lease（模式全枚举：watch / bootstrap / --once / dead-watcher --refresh / 一次性 reaper / qa_teardown）→ 检查 maintenance 标记（在 → 按 §2.4 各入口行为退让）→ 验 tmux generation → WAL/stage 恢复 → ledger prepared 对账 → inventory 对账 → 拓扑收敛 → reconcile/create/heal。per-view create 发新 nonce 前先恢复该 view 既有 WAL；watcher 体内路径（含 FLY-254 pre-heal reopen 消费）用 assert_or_reuse。每入口 crash-restart 测试。
occupied-name、rename 失败、终读-rename 间源亡（→escrow_required）各入测试；测试含 server-executed-but-output-lost 形态（命令成功但进程死于持久化前）。

### P2 — 拆除/escrow/inventory
按 §2.1/§2.5：dismantle_view_display（权威 ref 集限定）、escrow（prepared→committed 次序）、inventory RMW 锁 + bootstrap 重建 + GC。测试：分叉三态、身份 oracle、escrow 全 crash 点（含 rename→crash 的 prepared 自愈）、inventory 并发写、畸形行不授权。

### P3 — create 分叉 + ledger
A=1 走原语（终读即 ready-gate，defer 零残留零 TTL）；A=0 逐字。ledger prepared 先落（generation 三点一致 + 恰一 ref diff）→ rename 读回 → 升 committed（§2.4）；写失败留 unnamed；guarded chokepoint；GC 合同（prepared 不删）；**attachment 歧义分类器（§2.7 R20-R22）**：new-workspace 前预捕获 canonical view client 集/计数 → (i) 预捕获非 0/不可读时事后正计数归类 attachment_unverified；(ii) **任何 post-create 读取失败/不可读无条件归类 unverified（不依赖预捕获值，pre=0 同样覆盖）**；unverified 时拓扑/ref 建账照常、无重试 owner、结果/日志永不标 attached + 函数退出前发 generation+新权威 ref+title 键控告警；测试：rename-executed-but-output-lost、rename 失败、GC-during-prepared、generation 翻转于 guard 内、跨 generation 复用、founder 同名 ref 负例、pre-upgrade 工作簿不被 reaper 关（迁移由 runbook 关 tab 步覆盖），以及**三条具名突变验证回归**：① 预置孤儿 client + 新 attach 失败 → 断言不假绿 + 断言 ref 绑定告警本体（任意通用 WARN 不得使断言通过）；② attach 失败 + post-create 读取失败 → 权威 ref 保留、无假绿、精确告警——**pre=0 与 pre 非零两变体都必须覆盖**；③ 预捕获不可读 → 事后正计数同样归类 unverified。

### P4 — 修复统一 + B 校验
§2.2 派发；verify_view_bindings 两分支必经、@id 比对、跨 tick 闩（两次 conclusive）、二次全谓词、日志闩；B=0 精确边界逐条测试。

### P5 — bootstrap 双向收敛
最前置（两位点）；终态判定；grouped 退役=escrow；absent 仅 B=1 清理；uncertain 跳过；幂等零 mutation；inventory 落账/重建。测试：quiet-state / 全 crash 点 / pending-reopen 时序 / 反向收敛 / 迁移规模断言。

### P6 — TS 跳杀
按 §2.3 实现：**A flag 分支**（A=1 任何观测/拓扑下一律跳杀，无拓扑读数；A=0 legacy helper 逐字）+ 冻结返回形（cmuxSession 可缺省）+ 解析失败零破坏。测试：A=1 跳杀（close_runner 全流程：窗死 → view 自然亡 → pin marker 正常或安全缺省）、同名新旧兄弟（@old 杀 @new view 存留）、A=0 legacy 逐字、missing window/空名/display 失败三态、六 caller 现状回归、交错测试（watcher escrow+认领并发 → 新 view 存活）。

### P7 — teardown + reaper + flags
三命名空间认权杀 + 正负例（ownerless-intent stage、foreign-stage 保活）；reaper ledger 化（legacy 分支保 title-only）；registry per-flag 断言；autostart hermetic；四态矩阵。

### P8 — 收口
全量 shell 套件 + hooks-integration + `pnpm lint` + registry 测试 + `pnpm --filter flywheel-teamlead test`（package 名如此，错 filter 会零测假绿；PR 附测试数信号）。真 tmux 3.5a 回归。**文档验证 grep 断言（R15 #3 起，R24 定稿为可执行硬门）**——检查以脚本/命令形态入 PR checklist（写明实际命令与预期命中数），对 plan.md/research.md 跑行级 grep，**冻结的排除规则只有三类**：(a) §10 修正史整节；(b) 显式「不建/已撤」声明行（plan §8 清单与各「不建」句）；(c) 本断言自身的规则定义行（P8 本段）。规则：①**已撤合同关键词全局禁词**（manifest / fence / request-id / verified_ready / 迁移辅助命令 / converge_view_for_title / repair_create）== 排除后零命中——staging 成功态已定名 `staging_ready`（R24 改名），`verified_ready` 现在**只**属于已撤的 refresh ACK 合同，禁词无歧义、无需语境判断；②**无限定的 ≤15s 建/重建声称**==零命中；③**无限定的「重生收敛回正确会话」声称**（未带「无孤儿且 post-read 结论明确」限定 / 未带 attachment_unverified 分支例外的）== 零命中；④正向锚点：**三条 R19-R22 具名回归**（「预置孤儿 client + 新 attach 失败 → 不假绿 + ref 绑定告警」「attach 失败 + post-create 读取失败（pre=0 与非零两变体）→ ref 保留 + 精确告警」「B-foreign：A 关、B 可见不动、无替代 ref、告警」）必须出现在活跃测试摘要中 == 命中；⑤**门自身的突变验证（反例 fixture）**：向活跃段临时注入一句 refresh verified_ready ACK 合同文本 → 检查必须转红，移除后恢复绿（证明门既非永绿也非永红）。CI 诚实声明：macOS 专用套件=实现机全量跑+贴 PR+独立 QA 复跑的 pre-merge 硬门。PR + Codex code review（xhigh）→ 独立 QA。

## 5. QA / 验收清单（独立 QA，529 Room，Opus + 真机）

| # | 场景 | 断言 |
|---|---|---|
| 1 | Codex implement + weekly-limit husk 共存（A1B1 默认） | 各 tab 如实显示自己 |
| 2 | kill Codex 窗（A1 收敛后） | tab 永不渲染他人内容（结构性——linked 单窗，与 B 无关；A1B0 变体同断言） |
| 3 | 同名重生 | ≤2 个 conclusive additive pass 内：安全拓扑 + 权威 ref 重建（期间旧 tab 只显示自己的掉壳/dead surface，永不显示别人）；attach 弱证明角落（孤儿 client）=裸壳+告警终态，**断言不假绿 + 断言 attachment_unverified 分类与 generation+ref+title 键控告警本体**（任意通用 WARN 不得使断言通过，R20 #1；含 post-create 读取失败变体 pre=0 与非零——读失败同样分类+告警，R21/R22）；**无孤儿且 post-read 结论明确**时 FLY-169 自愈；**任何 attachment_unverified（含 pre=0+post-read 失败）=允许的裸壳+告警终态，不承诺收敛**（R23） |
| 3b | **B-foreign 同名共存（如实 UI 态断言，R19 #2）** | 权威 A 被关、B **既不被关也不被改名、保持可见**、无替代权威 ref 建立、告警发出——**B 是 founder 自建 tab，在 ledger 保证域外**：它显示什么本单不管也不碰（title 不是绑定），founder 点它看到什么由其自建时的 attach 决定；本单保证只覆盖 ledger-committed 的 Flywheel tab。若产品验收要求「任何叫 T 的可见 tab 都不得显示别的 issue」则本 descope 不满足——**已列入给 Lead 的设计报告决策项** |
| 4 | ≥10min 观察 | 无振荡、无兄弟打摆 |
| 5 | 迁移全流程（§6 人工 runbook 逐步排演） | Bridge 先行 → 标记 → bootout+确证退出+静默 gate（负例：一 one-shot 先持锁 → runbook 等待不偷锁）→ UI 手关 → **完成后置条件核对（负例：故意留一个 legacy tab → 断言不许宣告完成，直到清掉）**→ 清标记 → A1 bootstrap 收敛：keeper 数==预迁移 grouped view 数、inventory 齐全、身份 oracle、再重启零动作；标记窗竞态负例（.zshrc 新 shell 不拉 watcher、teardown 拒跑、one-shot 退出）；非 Flywheel tab 全程不碰断言 |
| 6 | 回滚矩阵 | A=0 反向收敛；A0B1 旧串台 ≤2 pass 收敛；A0B0=legacy 对照（**允许旧 bug**，如实断言）；B=0 精确边界 |
| 7 | sole-holder 保活（钉子①） | 源 session 亡 → 清理触发 → unlink 被拒、runner PID/pane/@wid 存活、tab 关、keeper 留、inventory 记账 |
| 8 | teardown 所有权 | 本槽 view/keeper/stage 回收；foreign 一律不碰（活 pane 存活断言） |
| 9 | 孤儿 + ref 权威 | 双锚点消失 → ledger reaper 收敛；stale-title 新 ref 不误关；跨 generation 旧账非权威；pre-upgrade 工作簿新模式下不被关 |
| 10 | TS 跳杀（skew + 交错 + 解析失败） | A=1：任何观测下不按名杀 view；close_runner 后窗亡 view 自然亡、pin marker 正常或安全缺省；同名兄弟 @old 杀 @new view 留；missing window/空名/display 失败零破坏；A=0：legacy 按名杀逐字；交错（watcher escrow+认领并发）新 view 存活 |

QA 注意（memory 配方）：tmux 探活别杀最后一窗；平台谓词真机验、fixture 真抓格式（FLY-1285）；「干净/通过」断言必须同尺打中已知阳性。

## 6. 回滚

- B=0：§2.2 精确边界，watcher 重启生效。
- A=0：代码路径回旧 + 下次 bootstrap 反向收敛；完整 legacy = 两 flag 均 0 + 一次收敛；keeper pending 如实。**回滚 = 回到旧行为含旧 bug（kill-switch 语义，Lead 钉子②）**。
- **正向 rollout runbook（= §2.4 的命令级渲染，R14 #4）**：
  1. 置 A=1 于 ~/.flywheel/.env → restart-services.sh 重启 Bridge → 验证 skip 分支生效；
  2. `mkdir -p "$HOME/.flywheel/state"` → `touch "$HOME/.flywheel/state/cmux-maintenance"` → 读回确认（任一步失败 → 停）；
  3. `launchctl bootout` 旧 watcher + pgrep 确证进程退出 + `flywheel-cmux-sync --probe-lease` 通过（三态合同见 §2.4：absent=过；良构活 owner=有界等待其释放；畸形/不明=停）；
  4. 操作员在场手关全部 Flywheel tab（非 Flywheel tab 截图留存不碰）；
  5. **完成后置条件**：只读 cmux 列表核对 Flywheel workspace ref 清零（有剩余/不确定 → 保持标记继续；中断后恢复核对不盲清）；
  6. 核对通过 → `rm` 标记 → `launchctl bootstrap` A1 watcher → bootstrap 收敛 + create 全量重建入账 → 验证 lock owner PID + knobs 行。
  QA 场景 5 按本 runbook 排演 + 标记窗竞态负例（.zshrc 新 shell、teardown、one-shot 均退让；一 one-shot 先持锁 → 步骤 3 等待；故意留一 legacy tab → 步骤 5 不许放行）。
- **回滚 runbook（与正向同型，逐步同款门，R14 #4 + R16 #3）**：⓪ 已有标记残留=上次流程未完成 → 恢复核对续走（绝不盲清）；① mkdir -p + touch 标记 + 读回；② bootout + 确证退出 + `flywheel-cmux-sync --probe-lease` 通过（同 §2.4 三态：absent=过；良构核验活 owner=有界可取消等待至 absent，取消/超时=非零；畸形/不明/stale=停）；③ 视需要手清（同款非 Flywheel 不碰 + 完成核对）；④ 置 A=0；⑤ rm 标记 → bootstrap → 反向收敛回 grouped；⑥ Bridge 重启拿 flag 回 legacy。改 env 均先于对应重启（FLY-193 纪律；单 kickstart 只换 waiter；FLY-913 拦 agent 时报 Lead 人工）；每步验证 lock owner PID + knobs 行。

## 7. 风险表

| 风险 | 概率 | 缓解 |
|---|---|---|
| 热路径回归（12 单史） | 中 | 双 flag + 双向收敛；状态机 mock + 突变验证；529 真机前置 |
| 迁移一次性 tab 闪断 + keeper 批量（≈tab 数） | 确定一次 | 收敛先于 heal 当轮重挂；inventory 可见；keeper 收编=lifecycle follow-up；低峰发布 |
| 迁移/回滚过渡窗内 grouped 残留串台 | 低 | B ≤2 conclusive pass 收敛（§1 模式边界如实声明；A0B0=接受的 legacy） |
| B 误杀重建中的窗 | 低 | 跨 tick 闩 + 全谓词重验 + 重生转修复 |
| keeper 堆积（无 GC 无 reclaim） | 中低 | inventory 可见 + teardown（QA 槽）+ lifecycle follow-up；增量仅空 session 结构 |
| ledger 覆盖率空窗 | 低 | rollout 标记窗内操作员 UI 手关全部旧 tab → create 重建全量入账；残余 unnamed 仅 prepared 行可处置，无行者 leak+告警 |
| 权威 tab 裸壳/缺 surface 终态（**所有 attachment_unverified 分支**：孤儿 client 角落 + post-read 失败含 pre=0，R20-R23 显式接受） | 低 | attachment_unverified 分类器 + ref 绑定告警（不假绿）；无重试 owner=如实声明（告警≠收敛）；人工按告警处理；tab 始终不显示别人 |
| 可见的未入账同名 foreign tab 等人工（域外碰撞） | 低 | 域边界告警 + 人工解决；本单不碰 B；**Tadashi 已书面接受（f2b5be93，§4 原文），契约已冻结** |

## 8. 明确不做（全部具名，防静默消失）

- runner 生命周期/respawn churn（FLY-1308 域）；显示层永不销毁带活 pane 的真窗。
- keeper 自动 GC（Tadashi 批 descope；归属 §2.5）。**人工 grouped reclaim 辅助命令**（R6 #6 descope，并入同一 lifecycle follow-up）。
- watcher 侧 Discord 告警凭证通道（inventory 文件为本单完整 operator 面；FLY-368 集成=具名 follow-up 请 Lead 建单）。
- 跨进程 per-view 锁 / 条件化杀源窗 / 全局裸 @id 杀 / cleanup_pending 重试机（R6 降海拔：TS 只做跳杀，杀窗语义一字不动）。
- `killTmuxWindow` 的 session-not-found 假成功（**既有生产缺陷**，E6 sole-holder 态窗仍活报 killed:true——grouped 时代同样存在；报 Lead 建 runner-lifecycle 域 follow-up）。
- 破坏性 ledger backfill（title 不是绑定；pre-upgrade 由 §2.4 人工 runbook 的 UI 手关一次性置换入账）。
- **refresh 请求/ACK 协议、迁移辅助命令/fence/manifest、事件快速重建分支（converge_view_for_title/repair_create/surface-repair 状态机/nonce 证明）——全部显式不建**（R12/R18 两次降海拔：A=1 下指针类缺陷不复存在；同名重生走既有 reconcile+create additive 路径 ≤2 conclusive pass；一次性迁移走人工 runbook + maintenance 标记。**理由入档防将来无意加回**：快速分支的 surface 证明问题会连锁出状态机与命名空间双主——R16-R18 实证）。
- exec-id 级 tab 绑定；「缺 tab」清理宽限节奏；A=0 legacy 裸 kill。
