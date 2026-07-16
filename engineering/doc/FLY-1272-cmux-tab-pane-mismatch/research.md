# FLY-1272 cmux tab 名↔pane 内容串台 — 调研（v24）

Issue: FLY-1272 (https://linear.app/geoforge3d/issue/FLY-1272/fix-cmux-tab-名pane-内容串台-一个-tab-显示错的会话codex-单显示成-claude-husk今晚坑-founder)
日期: 2026-07-16
基于: exploration.md

> 版本合同：本文与 **plan.md v27** 配套（plan §2 统一决策表为唯一权威合同）。历版下列**方案级合同**已被 Codex design review R1-R10 证伪或撤除，任何文档以方案形态出现即为陈旧残留、一律以 plan v27 §2 为准（R18 后追加撤除：事件快速重建分支 converge_view_for_title/repair_create/surface-repair 状态机/nonce attach 证明——同名重生走既有 reconcile+create additive 路径）（R12 后追加撤除：迁移辅助命令/迁移 fence/manifest 协议/refresh 请求 ACK 协议——整体不建，见 §10 R12）（注意区分：「session-not-found→killed:true」作为**成功合同**被否，但作为**具名既有缺陷**保留在 follow-up 清单——两种语境不同）：观测后按名杀 view（name-rebind TOCTOU，R7 #1）、靠 churn 完成迁移、无 prepared 态的 ledger/inventory、条件化杀源窗、全局裸 @id 杀、cleanup_pending 重试机、accepted-bounded 的 preflight→kill 条目（R6 裁定不安全，已随条件化杀窗整体撤除）、人工 grouped reclaim/guard 协议（descope）、破坏性 ledger backfill、通用 unlink 拆除（不分 grouped/linked）、keeper 自动 GC、单命令队列当事务、source-title 即 ledger 所有权、flag-only 的 TS 杀 view 决策、「结构性安全」的 preflight→kill 描述（实为 accepted-bounded + B 自愈）、session-not-found 即 killed:true、`ref|title` 不带 socket generation、lead-alert.sh 直发 keeper 告警、裸 check-then-kill 的 keeper 人工回收、byte-for-byte 源侧断言、双/三 readSite 一刀切（A=3 B=2）、`pnpm --filter teamlead`。修正史见 §10。

Brainstorm gate 已过：Tadashi 批准 Option C（A=link-window 隔离根治 + B=invariant 校验纵深），四钉子：① B 杀伤边界只到显示层、原文进 plan；② 存量迁移 + kill-switch（default on、=0 回旧、注册 registry）；③ 529 真机 QA + 振荡检查；④ scope 边界。3 轮安全阀时 Lead 复批：继续收敛路线；grouped 一律 escrow rename；keeper 自动 GC 显式 descope。

## 1. 结论摘要（v24）

1. **link-window 语义实测通过，带三条硬限制**（§2）：(a) 源 session 死后 view 可为窗的唯一 holder——kill-session 会连窗带 runner 一起杀；(b) linked（独立）view 的安全拆除根基 = `unlink-window` 无 `-k` 对最后引用的**原子拒绝**（快照授权有 TOCTOU，tmux 原子语义没有）；(c) **grouped view 不适用 unlink**（tmux 3.5a 源码：unlink 波及整组，可动源 session）——grouped 退役只能 escrow rename。
2. **兼容性审计**（§3）：shell 侧多数机制零改动（R7 补审：15s close-request drain、ghost/dedup 关闭、--refresh 锁外入口也入破坏性清单，plan §2.7）；TS 侧 = `killCmuxLinkedSession()` 按 A flag 分支（**A=1 一律跳杀**——观测后按名杀有 name-rebind TOCTOU，R7 #1；跳过 kill 永远非破坏性=唯一无 TOCTOU 选择；A=0 legacy 逐字）。杀 runner 窗仍是 lifecycle 既有无条件行为，本单不碰。
3. **原语 = staging + 原子认领**（§4）：tmux 命令列表是顺序执行**非事务**，canonical `cmux-T` 名下绝不允许半成品——在 `fwstage-<nonce>` 命名空间建全（owner/marker/link/终读）后 `rename-session` 原子认领；typed outcome（staging_ready/cleaned/escrow_required/uncertain——成功态定名 staging_ready，R24：避免与已撤 refresh ACK 合同的 success token 撞词，让 P8 全局禁词无歧义）。
4. **存量迁移 = 双向拓扑收敛**（§5）：bootstrap 最前、终态判定、幂等；**规模诚实**——首次迁移每个现存 grouped view 产生一个 escrow keeper（≈tab 数），keeper 收编=lifecycle follow-up（reclaim 已 descope）。
5. **kill-switch**（§6）：两 default-on flag；=0 需一次 bootstrap 反向收敛才是完整 legacy；registry readSite per-flag 如实（A=3：sync/autostart/tmux-lookup；B=2：sync/autostart）。
6. **B invariant 校验**（§7）：@window_id 比对、跨 tick 闩、全谓词二次确认、严格快照统一门（uncertain → 缺席型 mutation 全跳）。

## 2. tmux 3.5a 语义实证（隔离 socket 实验 + 源码核对）

| # | 事实 | 来源 | 对设计的意义 |
|---|---|---|---|
| E1 | 独立 session + link-window 源窗 → view 只含目标窗 | 实验 | create 可行；占位窗独占、unlink 无 -k 必被拒 → 按捕获 @id 精确 kill |
| E2 | kill-window 源窗 → 单窗 view session 整个死 | 实验 | fallback 物理不存在；lifecycle 杀源窗后 linked view 自然 collapse（TS 跳杀分支的依据） |
| E3 | remain-on-exit husk → view 如实显示 dead pane | 实验 | husk 显示真相 |
| E4 | unlink 只删引用、不碰其他 holder 的窗 | 实验 | linked 修复/补偿的安全基础 |
| E5 | `#{session_grouped}` 区分两代 view | 实验 | 拓扑判定输入之一（还需窗集/active/owner/marker） |
| E6 | kill 源 session → link 进 view 的窗**存活**（view 持引用） | 实验 | sole-holder 态真实存在——此后杀 view=杀 runner（R1 #1 实证） |
| E7 | grouped 成员的 unlink 波及整组（`session_is_linked()` 不计同组、`session_detach()` 同步剥离；最后 detach 可销毁 group） | tmux 3.5a session.c/server-fn.c（R3） | grouped view **永不 unlink**，退役=escrow rename |
| E8 | tmux 命令列表顺序执行非事务；detached new-session 不改后续命令默认 target；`-P -F` 输出不能回灌同一命令列表 | tmux 3.5a cmd-new-session.c/cmd-set-option.c（R4） | 原语必须 staging+原子 rename，不能靠单命令队列装事务 |

对照（exploration §3.1，grouped 事故机制）：kill 源窗 → grouped view 指针 fallback 到组内邻居窗；新 grouped session 初始指向最低 index 窗；同名重建不自动修复。

## 3. 兼容性审计（v24 结论，与 plan v27 §2/§3 一一对应）

| 机制 | 行号锚 | 结论 |
|---|---|---|
| create_workspace_for_window 步骤1-2 | 2109-2130 | **适配**：A=1 走 staging 原语（终读即 ready-gate；typed outcome；defer 零残留零 CREATE_STATE）；A=0 grouped 分支逐字 |
| create 步骤4-7（new-workspace/rename/verify-attach） | 2149-2206 | **适配（插一步 + 歧义分类器）**：取 new_ref → ledger `prepared\|generation\|ref\|title` 先落账+read-back（generation 三点一致 ∧ 恰一 ref diff）→ rename 读回 → 升 committed（R7 #5）；rename 失败/crash → **只**按 prepared 行处置该确切 unnamed ref；ledger 写失败孤儿 leak+告警（无「通用 ghost 路径」兜底，R8 #4/R9 #5）。**verify-attach（R20-R22 fail-closed）**：现源码 session 级 client 计数（1182-1185）在任何 client 存在时即停重试（2198-2203）、读取失败直接 break（2201）、自注「必要不充分」（1433-1438）——新模式 new-workspace **前**预捕获 canonical view client 集：(i) 预捕获非 0/不可读 → 事后正计数归类 `attachment_unverified`；(ii) **任何事后读取失败/不可读无条件归类 unverified（不依赖预捕获值，pre=0 同样覆盖——R22：普通无孤儿场景的静默裸壳同样被堵死）**；unverified 时建账照常、无重试 owner、结果/日志永不标 attached + 函数退出前发 generation+新权威 ref+title 键控告警 |
| refresh_linked_sessions / select_live_view_window | 2229-2262 / 1878-1889 | **适配**：A=1 按模式派发（linked 收敛）；A=0 逐字（含吞 select 失败 rc=0 语义）。修复目标由每 pass 一次严格快照 + title 去重赢家给出。`--refresh` 独立入口在 A=1 下**存在理由消失**（它修的是 grouped 指针漂移，linked view 单窗无指针；同名重生由 additive 的 reconcile+create 收敛——≤2 conclusive pass、attach 弱证明角落=告警终态，R19 #1 诚实合同）——watcher 活=诚实 no-op、亡=取 lease 跑收敛、标记在=退出提示；restart-services **零改动**；不建请求/ACK 协议 |
| cleanup_workspace_for | 1088-1117 | **适配**：A=1 显示层拆除走分叉 dismantle；A=0 既有调用方保留裸 kill（byte-compat，合同诚实收窄见 plan §2.1） |
| cleanup_stale_conservative / 30s pending | 2601-2643 | 缺席判定在新 flag 开启时过严格快照门；双锚点消失兜底交 ledger reaper |
| reap_orphan_workspace_pins（FLY-293） | 699-944 | **适配**：新 flag 模式下破坏性准入 **ledger-only**（`state\|generation\|ref\|title` 行，仅 committed 行授权；prepared 行只授权其确切 unnamed ref 恢复）；title-only 准入仅存 A0B0 legacy 分支；首轮 gate 与最终 revalidation 同行校验；**关前即时重读保留**（显式安全例外） |
| scripts/test-teardown.sh | 173-226, 384-457 | **适配**：以 **qa_teardown lease 模式**取共享 mutator lease（R12 #2：裸入口检查=check-then-act），持锁下检查 maintenance 标记——标记在 → 整个 teardown（含进程杀与 worktree/slot 删除）拒跑（R11 #2：杀 session ≠ 杀窗，E6 下 view 引用保窗保进程）；无标记时 owner option 优先/group 回退、枚举三命名空间、只杀 owner==本槽（foreign 活/死一律 skip） |
| **TS `killCmuxLinkedSession()`**（close-runner.ts:637 / crash-reaper.ts:289 / post-merge.ts:104 / stale-blocker-guard.ts:249 / actions.ts:1373 / plugin.ts:2066 六 caller 均先调 helper 再 killTmuxWindow） | tmux-lookup.ts:526-568 | **适配（R3 #2 发现 → R7 #1 定稿）**：按 **A flag** 分支——A=1 **一律跳过按名杀**（任何拓扑；观测后再杀有 name-rebind TOCTOU：watcher 可在间隙 escrow 旧 view + 原子认领同名新 linked view，按名杀打中替身甚至 sole-holder 窗），返回冻结合同 `{killed:true(=lifecycle 可继续), viewSkipped:true, cmuxSession?, resolutionError?}`（cmuxSession 解析失败可缺省，close-runner 安全跳 pin marker）；A=0 legacy 逐字。部署次序：Bridge 先、watcher 后（回滚反序）。**killTmuxWindow 一字不动**；其 session-not-found 假成功为具名既有缺陷 follow-up |
| self_heal / heal_send_attach（FLY-169/254） | 1391-1480 | 零改动 |
| reconcile_existing_workspaces | 2264-2301 | **适配（R19 #2）**：现源码关全部同 title ref——新模式只关 ledger-committed 行（unledgered 同 title ref 留+告警）；缺席判定过快照门 |
| dedup / ghost reap | 575-661 | **适配（R7 #4 + R8 #4）**：两者直接关 ref——新模式只允许关「确切 generation 匹配 prepared 行授权的 unnamed ref」或 committed 权威行；无行 unnamed（用户空白 tab/ledger 写失败孤儿）一律 leak+告警；A0B0 legacy 逐字（含通用 ghost reaper） |
| FLY-825 create dedup | 1314-1390 | 零改动（原语零 CREATE_STATE 写入） |
| FLY-254 reopen/bootstrap | 1482-1740, 2645-2731 | **适配（时序）**：拓扑收敛置 bootstrap 最前，两位点先收敛后 heal/消费 |
| hooks/事件 | 2305-2423, 2525-2599 | **零改动（R18 后回归）**：create 事件对已存在 workspace 维持 attach-only 现状（快速重建分支已砍除，同名重生由 additive 的 reconcile+create 收敛，≤2 conclusive pass）；view/staging/keeper 侧事件被 session 过滤器丢弃；真机回归钉死 |
| TS 其余（TmuxAdapter prune、tmux-viewer、cmux-close-request） | — | 零改动 |
| flywheel-cmux-autostart.sh | 全文 | **适配**：两 flag 提取（precedence/bool-only/fail-closed；绝不 source 整 .env）+ **maintenance 标记检查**（固定 durable 路径 ~/.flywheel/state/cmux-maintenance；.zshrc 路径一次性退出；supervised launchd=非持有有界轮询等待防 respawn churn） |

## 4. 原语与拆除（v24 权威形态，细节以 plan §2/§4 为准）

- **create_or_replace_view_session（staging WAL，R5 #5 + R6 #5 intent/completion 对）**：WAL 状态机 create_intent→created→link_intent→linked→claim_intent→claimed_complete（intent 先落、completion 在 mutation 验证后落；恢复按「WAL 状态 × 观测拓扑」二维对账，仅 create_intent 须证明确定性 stage 名 absent 才可清）→ `fwstage-<nonce>` 建全（owner/marker 显式 `-t` 写入 read-back；link → select → **占位杀前置证明**：WAL 相等 ∧ stage 成员集恰为期望 ∧ marker 合法且≠目标，矛盾读=零 mutation → 杀占位 → staging 终读）→ `rename-session` 原子认领 → 复读 → 清 WAL。恢复表覆盖每个 WAL 状态（含 corrupted marker=零 mutation+告警、pre-marker crash=按 stage id 整杀自有窗、post-rename crash=清 WAL、终读-rename 间源亡=escrow_required）。staging 永不可见；canonical 名下永无半成品。typed outcome 四态。
- **dismantle_view_display**：先关**权威 ref 集**（§5，绝非「同 title 全关」）→ 按 `#{session_grouped}` 分叉：linked → 逐窗 unlink 无 -k（拒绝=keeper）；grouped → escrow rename（永不 unlink）。源侧不变式=稳定身份 oracle（源 session id/名/options/current-window、窗 @id 集、group 身份/成员 id 集不变；唯一 delta=escrow 成员名；journal 零 unlink/kill 于源侧）。
- **escrow**：owner option 先派生持久化（legacy grouped 从 validated `#{session_group}` 派生）→ 权威 ref 关闭确认 → **inventory 行 state=prepared 先写** → rename `fwkeeper-<session_id>-<原名>` → 复读 → inventory state=committed；不确定即停。**inventory 文件 = 本单完整 operator 合同**（R6 #8 accepted deviation 落地：行含 tmux_generation/exact_name/owner/窗集/state；RMW 加锁；bootstrap 对账三分支（缺行×live keeper→重建；prepared×匹配 live keeper 读回全符→原子升 committed；prepared×原 session 仍在→pending 或以已证明非 mutation 结局退休；不符/uncertain→保留+告警——R8 #7：缺行重建≠prepared 恢复，两分支独立）；畸形行不授权；Discord 可见性=具名 FLY-368 follow-up 请 Lead 建单——lead-alert.sh 的 kind 契约与凭证不通向无 token 的 watcher）。**keeper 无自动 GC**（显式 descope）；**人工 grouped reclaim 辅助命令亦 descope**（R6 #6：guard 协议自身需 WAL/teardown 认知/组变异防护，并入 lifecycle follow-up）。

## 5. 存量迁移 = 双向拓扑收敛 + ref 权威

`converge_view_topology_once()`：bootstrap 最前（两位点先收敛后 heal/reopen 消费）；枚举全部 `cmux-*`（不依赖源窗）；终态判定（A=1：独立 ∧ 窗集{赢家} ∧ active ∧ owner==赢家 source ∧ marker 清洁；A=0：grouped ∧ current 指赢家）；不符 → 重建（grouped 旧 view escrow 退役）；赢家 absent → 仅 B=1 清理；uncertain 跳过；幂等（二次零 mutation）。**规模**：首次 A=1 迁移 keeper 数≈现存 tab 数——inventory 可见，收编归 lifecycle follow-up（reclaim 已 descope，R6 #6）。
**ref 权威（R5 #6 → R7 #5 定稿 schema）**：ledger 行=`state|socket_generation|ref|title`（prepared/committed 两态；generation 用既有 `cmux_socket_identity`——cmux 重启后 ref/title 可复用，generation 不匹配即非权威）。拆除/escrow/reaper 只关权威 ref 集；同 title 未入账/歧义 ref → 告警+defer 全不关。**无破坏性 backfill**（R6 #7：view 级证明 + 单 ref 仍非 ref→view 绑定——title 不是绑定，本单根因；founder 同名单 ref 场景无法排除）：新模式下破坏性关 ref 只认 create 路径落的 ledger 行（`state|generation|ref|title`，prepared/committed 两态，R7 #5/R8 #4）；title-only 准入仅存 A0B0 legacy 分支。**pre-upgrade 存量的置换 = 人工 runbook（R12 后 Lead 拍板降海拔）**：maintenance 标记（全 mutator 入口退让——「watcher 已退」只是时点观察的教训保留）→ 停 watcher（bootout+确证退出）→ **操作员 cmux UI 手关全部 Flywheel tab**（display-only 人手动作=权威无可置疑，零代码零 manifest 零 fence）→ 清标记 → A1 bootstrap 全量重建自动入账。迁移辅助命令/迁移 fence/manifest 协议不建（其催生了 R9-R12 全部协议级 findings）。新 create 落账条件：非空 generation ∧ 前后/动作时一致 ∧ 恰一 ref diff。GC：只删「committed ∧ ref 亡或 title 变」的行（prepared 不删）；uncertain 全保留。

## 6. kill-switch 与 registry

- `FLYWHEEL_CMUX_LINKED_VIEW`（A）/ `FLYWHEEL_CMUX_VIEW_INVARIANT`（B），`${VAR:-1} != 0` default-on。
- =0 真实语义：代码路径回旧；拓扑需一次 bootstrap 反向收敛；sole-holder keeper 不可反迁移，如实 pending。四态矩阵逐态测试（A0B0 = legacy 且 legacy reconcile/conservative/orphan 清理照常活动）。
- registry：readSite **按 flag 各自如实**（R5 #1）——A（LINKED_VIEW）三处：sync 脚本 + autostart（`dynamic`/`cli_invocation`）+ tmux-lookup.ts（`process.env`/`call_time`）；B（VIEW_INVARIANT）两处：sync + autostart；字段全（default:true/description/toggleable:"readonly"）；`feature-flags-registry.test.ts` per-flag 精确断言。
- 生效路径：watcher 经 autostart 从 `~/.flywheel/.env` 提取；重启走 install 链 `bootout → wait-for-watcher-exit → bootstrap`（单 kickstart 只换 launchd waiter 不换持锁 watcher）+ **静默判据=锁目录 conclusively absent**（三态：absent=过；**良构核验活 owner=有界可取消等待至 absent**；畸形/不可读/不明/stale=停下人工诊断——绝不偷锁；`--probe-lease` 只读命令入 sync 脚本复用 lease 校验器，正/反 runbook 同款渲染）+ lock owner PID/knobs 验证；迁移/回滚均走 marker 窗人工 runbook（provision：mkdir -p $HOME/.flywheel/state + touch 读回；完成后置条件=Flywheel ref 清零核对）；Bridge 经 restart-services.sh。TS 侧仅跳杀分支（R7 #1/R8 #5 定稿）：**A=1 任何观测/拓扑下一律跳过按名杀**（返回 {killed:true, viewSkipped:true, cmuxSession?, resolutionError?}，cmuxSession 解析失败可缺省、零破坏）；A=0 legacy 逐字。部署次序：Bridge 先 → marker 窗人工流程（provision/静默探测/手关/清零核对）→ A1 bootstrap（回滚同型反向）。杀窗语义一字不动，回滚窗内显示收敛由 §1 模式边界如实覆盖。

## 7. B invariant 校验

@window_id 比对（title → view active @id → 严格快照赢家 @id）；found→按 A 模式派发修复；conclusively absent→跨 tick 闩（连续两个 pass 独立严格快照 + 全谓词重验；期间同名新 @id → 转修复）→ 分叉拆除；uncertain→no-op。挂 sync_additive 两分支必经。B=0 关闭的精确集合：verify 的修复与拆除、bootstrap 的 absent 拆除、跨 tick 闩；legacy 清理不受影响。负载：零新 timer；每 pass 一次快照 + 每 view 一次 display-message；FLY-293 关前重读为显式 bounded 例外。transition 日志带闩。

## 8. 测试与 QA 形态

- 单测（文件承载状态机 mock——`-P -F` 走子 shell，普通变量写不回父 shell，沿现 harness 266-291 文件法；mock 含 group/unlink-拒绝语义 + 失败注入 + 命令 journal；**负向断言全部突变验证**）：原语每命令失败 + 每边界进程死亡；typed outcome 四态；dismantle 两分叉 + 身份 oracle；escrow 事务全 crash 点；快照门零 mutation；跨 tick 闩三段；四态矩阵；FLY-825 交叉；ledger 事务/GC/backfill 负例；teardown 四所有权 + keeper 正负例 + foreign-dead 保活；autostart hermetic；registry 精确断言；TS 跳杀（A=1 一律跳 + 解析失败三态 + A=0 legacy 逐字）+ 六 caller 现状回归 + 交错测试（`pnpm --filter flywheel-teamlead test`——package 名如此，错 filter 会零测假绿）。
- 真 tmux 3.5a 回归：E1-E8 相关谓词（unlink 拒绝、grouped 两场景身份 oracle、view/staging 侧事件过滤 + 源侧阳性对照）。
- CI 诚实声明：`test-cmux-sync.sh` 系 macOS/bash-3.2 专用，Linux CI 不覆盖 → 实现机全量跑 + 结果贴 PR + 独立 QA 复跑 = pre-merge 硬门。
- **R19/R20/R21 具名回归（三条都必须突变验证，缺一即测试摘要不完整）**：① 预置 unnamed 孤儿 client attach 在 cmux-T → 权威 create 的 attach 失败 → **断言不假绿 + 断言 attachment_unverified 分类与 generation+ref+title 键控告警本体**（任意通用 WARN 不得使断言通过）；② attach 失败 + **post-create 读取失败** → 断言权威 ref 保留、无 attached 假绿、精确告警本体仍发出——**pre=0 与 pre 非零两变体都必须覆盖**（R21+R22：post-read 失败无条件 fail-closed）；③ B-foreign 同名共存 → 权威 A 被关、B **既不被关也不被改名、保持可见**、无替代权威 ref、告警发出（plan §5 场景 3b 的真实 UI 态冻结）。
- 529 Room 真机 E2E：plan §5 十一场景（验收句、振荡、sole-holder 保活、skew、迁移规模、回滚矩阵、teardown、孤儿、keeper 告警、B-foreign 域外碰撞 3b）。

## 9. 残余风险

| 风险 | 缓解 |
|---|---|
| create/refresh 热路径回归（12 单史） | 双 flag + 双向收敛；状态机 mock + 突变验证；529 真机前置 |
| 迁移一次性 tab 闪断 + keeper 批量产生 | rollout ②步操作员一次性关全量旧 tab（display-only 人工授权，R7 #3）→ create 重建全量入账；收敛先于 heal 当轮重挂；keeper 收编=lifecycle follow-up；低峰发布 |
| tmux 语义平台差异 | E7/E8 源码核对 + 真机回归钉死（FLY-1285：不为假设平台写码） |
| B 误杀重建中的窗 | 跨 tick 闩 + 全谓词重验 + 重生转修复；unlink 原子语义兜底 |
| keeper 堆积（无 GC 无 reclaim） | inventory 文件可见 + teardown（QA 槽）+ lifecycle follow-up；增量仅空 session 结构 |
| ledger 膨胀/误权 | exact-ref 准入 + GC 合同（ref 亡/title 变才删、uncertain 全保留）+ 双点复验 |
| 权威 tab 裸壳/缺 surface 终态（**所有 attachment_unverified 分支**：孤儿 client 角落 + post-read 失败含 pre=0，R20-R23 显式接受） | attachment_unverified 分类器 + ref 绑定告警（不假绿、无重试 owner=如实声明，**告警≠收敛**）；人工按告警处理；tab 始终不显示别人 |
| 可见的未入账同名 foreign tab 等人工（域外碰撞，R19/R20） | 域边界告警+人工解决；本单不碰 B；**Tadashi 已书面接受（f2b5be93，plan §4 原文），契约已冻结** |

## 10. Design review 修正史（Codex xhigh；R1-R4 全采纳，R5 起含显式部分采纳/descope，逐条有记录）

### R1（8 条）：sole-holder 杀 runner 危险；test-teardown 所有权漏审；双锚点清理缺口→ledger；迁移挂点/复用/crash 收敛→拓扑收敛原语；=0 回滚不真实+launchd env；原语签名/占位/赢家去重；B 谓词 fail-closed+两分支必经+@id；测试模型/registry/负载诚实。
### R2（9 条）：快照授权 kill 的 TOCTOU→（当时）unlink 方案+合同收窄；独占占位 unlink 必拒→精确 kill+keeper escrow；A×B 矩阵矛盾→按 A 派发+B 统一门；缺席 mutation 统一快照门；owner 先写先读回+teardown 只杀本槽；ledger `ref|title`+先落账后 rename+backfill；rollback 走 bootout→wait→bootstrap 链；research v1 陈旧孪生→整体重写；负载预算+文件承载 mock。
### R3（9 条）：**grouped unlink 波及整组（源码级）→ 拆除分叉、grouped 一律 escrow**；**TS killCmuxLinkedSession 漏审→纳入 scope**；占位 marker 持久化；**keeper 自动 GC 砍出 scope（Lead 批显式 descope）**；fwkeeper 纳入 teardown 枚举；backfill 证明收窄+GC 合同；快照预算例外+B=0 精确边界；escrow 事务化；macOS 硬门+registry timing。
### R4（9 条）：research 再度陈旧孪生→v3 全文重写+版本合同；**TS 决策拓扑感知非 flag-only（正反 skew）**；**helper 拆 preflight+post-verify（6 caller 先 helper 后杀窗的次序事实）**；**单命令队列非事务→staging+原子 rename 认领**；post-link 源消失→typed outcome+escrow_required；keeper 迁移规模诚实+owner 派生+一次性人工收尾；ledger exact-ref 准入；grouped 断言改身份 oracle；`pnpm --filter flywheel-teamlead`（原 filter 零测假绿）。

### R5（9 条，7 全采纳 + 2 部分采纳有记录）

1. plan v6 内部陈旧孪生 → plan v7 以 §2 统一决策表为唯一合同 + 机械清扫；registry per-flag（A=3 B=2）。
2. preflight→kill 跨进程 TOCTOU → **部分采纳**：拒绝跨进程锁（Bridge TS × bash watcher 的死锁/liveness 面不成比例）；改为 preflight 紧邻 kill + accepted-bounded 风险条目 + B ≤2 pass 自愈的交错测试实证。
3. killTmuxWindow 假成功（session-not-found→killed:true，E6 sole-holder 态 runner 仍活）→ 成功=全局 @id 消失证明；裸 @id 全局精确杀或 cleanup_pending（不得 finalize）。
4. 拓扑关系需带目标身份 + 六 caller 合同 → 判别式关系六态各配杀法/后置条件；linked_other_winner（杀旧留新）显式建模；defer 时不 reap MCP 子状态。
5. staging 恢复不完备 → WAL 化（每步先落账）；占位杀前置证明；corrupted marker 零 mutation；post-rename/终读-rename 边界定义。
6. escrow 未接 ref 权威 + ref 跨 cmux 代可复用 → `socket_generation|ref|title` 键；只关权威集；歧义 defer；backfill 加 generation 条件。
7. fwstage 逃逸 teardown → 枚举加第三命名空间 + intent/owner 认权 + 正负例。
8. lead-alert.sh 不通（kind 契约 + 凭证不进 watcher 环境）→ **部分采纳**：operator 面改为 durable keeper inventory 文件 + transition log；Discord 告警=FLY-368 统一 bot 读 inventory 的 follow-up，不在本单建凭证通道。
9. 人工 grouped keeper 回收的 check-then-kill 危险 → （当时）guard 协议；R6 #6 进一步裁定协议自身不完备 → **整体 descope**。

### R6（9 条 → 触发降海拔重构，plan v8）

1. accepted-bounded 的 preflight→kill 被裁定**不安全**（B=0/watcher 异常时无界复现）→ 不加锁也不弱化保证，而是**撤掉条件化杀窗本身**：杀 runner 窗回归 lifecycle 既有无条件行为（今天即如此），显示层收敛由 A（结构性）/B（≤2 conclusive pass）/A0B0（=legacy 含旧 bug，kill-switch 语义）分模式如实声明（plan §1）。
2. 裸 @id 跨 tmux server generation 可复用（window.c 计数器 per-server）→ 全局裸 @id 杀**随条件化杀窗一并撤除**（本单不再有任何新 kill 权威）；generation 权威问题记入 follow-up 备忘。
3. cleanup_pending 无 durable retry owner → 机制整体撤除；killTmuxWindow 一字不动；session-not-found 假成功列为**具名既有缺陷 follow-up**（今天的生产行为，grouped 时代同样存在）。
4. 六 caller 事务化与 MCP-reap 次序矛盾 → TS 范围缩到 killCmuxLinkedSession 的**跳杀分支**一件事（观测 linked/absent/staging/uncertain → 不按名杀，fail-safe 方向；观测 grouped → legacy 逐字）；caller 零流程改动。
5. WAL write-before-mutation 悖论 → intent/completion 对 + 状态×拓扑二维对账（上文 §4）。
6. reclaim guard 协议不完备（隐藏 holder/组变异竞态）→ descope 并入 lifecycle follow-up。
7. backfill 仍无 ref→view 绑定证明 + P7 title-only 旁路 → 无破坏性 backfill；新模式破坏性路径 ledger-only；title-only 仅存 A0B0（上文 §5）。
8. inventory 崩溃一致性（accepted deviation 的补齐条件）→ prepared/committed 次序 + bootstrap 重建 + RMW 锁 + generation 字段。
9. 语义级陈旧残留 + 破坏性入口未穷举 → v5 修正 + plan §2.7 入口清单。

### R7（8 条全采纳，plan v9 定稿）

1. legacy_grouped 观测后按名杀仍有 name-rebind TOCTOU（watcher 可在间隙 escrow+原子认领同名新 view）→ **A=1 一律跳杀**（跳过 kill 永远非破坏性=fail-safe 方向的 flag 判定，与 R4 否掉的破坏性方向 flag 判定本质不同）；A=0 legacy 逐字；交错测试。
2. 正向部署 skew + 返回合同 → 部署次序（Bridge 先 watcher 后，回滚反序）；返回冻结 `{killed:true(=lifecycle 可继续), viewSkipped, cmuxSession}` 保住 caller 既有硬门语义。
3. no-backfill 与迁移承诺矛盾（grouped escrow 需关 ref 而 pre-upgrade 无权威）→ rollout 前置**操作员授权一次性全量关旧 tab**（display-only），create 重建全量入账；两 pass 承诺只覆盖 post-rollout 瞬态。
4. 破坏性入口漏项（15s close-request drain / ghost / dedup / --refresh）→ §2.7 补全；新模式 ghost/dedup 只关 unnamed 或权威行；--refresh 纳入 watcher 锁单一 mutator lease。
5. ledger 需 prepared/committed 两态 + guarded chokepoint（IPC 前最后一步重验 generation/行/绑定，复用 cmux_call_guarded 模式）。
6. WAL claim 接受必须证明 stage absent ∧ canonical session_id == stage_session_id（rename 保 id=身份证明）；WAL 带 generation + 版本化语法；shell mutator 单一 lease。
7. inventory prepared 行对账三分支（prepared×live keeper 升 committed / prepared×原 session 在=pending / 不符保留告警）。
8. research 语义残留（v4 标签/manual cleanup/killed:true 语境）→ v6 修正，版本合同区分「被否的成功合同」与「保留的具名既有缺陷」。

### R8（7 条全采纳，plan v10 定稿）

1. rollout 关 tab 时旧 watcher 未静默会立刻重建 + 批量关缺 exact-ref 授权 → 次序改为 Bridge 先行 → bootout+确证 watcher 退出 → **不可变 preview manifest（generation+确切 ref|title）操作员批准** → guarded 逐行关 → 复读 absent → A1 bootstrap；「30-45s skew 上界」措辞修正（事件丢失可到 conservative 路径，真正上界=静默次序）。
2. 现有 watcher 锁校验器把持锁 one-shot 判 stale 抢锁 → 锁记录泛化 pid|mode|nonce，校验器承认全部授权 mutator 模式；supervised 对 live one-shot 有界等待。
3. A1 --refresh no-op 会砍掉 FLY-98 即时修复 → 改为写 EVENT_FILE 入队（≤15s drain 收敛；~5s→≤15s 为已声明轻微回归 + QA 覆盖 Lead 重启窗）。
4. 「unnamed 即可关」重新引入所有权推断 → ghost/dedup 只关「generation 匹配 prepared 行授权的 unnamed」或 committed 行；ledger 写失败孤儿 leak+告警；prepared 对账四分支（unnamed→重试或关 / 已带 title→升 committed / ref 亡→退休 / 不符→保留告警）。
5. A=1 返回形在解析失败时不可实现 → cmuxSession 可缺省 + resolutionError；缺省时 close-runner 跳 pin marker 交 ledger reaper；签名入参如实为 tmuxWindow。
6. WAL 恢复未绑运行时入口次序 → mutator prologue（lease→generation→WAL/stage→ledger prepared→inventory→收敛→reconcile/create/heal），per-view create 先恢复既有 WAL 再发 nonce，全入口 crash-restart 测试。
7. plan/research 活跃段残留 v8 合同（拓扑读数/六观测/grouped-legacy 观测分支/churn 迁移）→ plan v10 + v7 修正。

### R9（5 条全采纳，plan v11 定稿）

1. 「watcher 已退出」非持续静默（autostart/+5s refresh 可在审批窗重入）→ **durable 迁移 fence** 全程持有，全 mutator 入口见 fence 拒跑，crash 留 migration-incomplete 态。
2. lease 身份不可核验 + prologue 会等自己的锁 → 记录带进程 incarnation（PID+启动时间）；API 分裂 acquire / assert_or_reuse；mode 全枚举。
3. queued refresh 破坏 FLY-129 次序与 ≤15s 承诺 → request-id/ack 协议 + restart-services 等 ack 后才 refresh-surfaces + 不健康 backoff 300s 如实声明。
4. manifest 审批缺持久绑定与断点续跑 → 版本+摘要、批准子集持久化、逐行 journal、resume 验摘要、generation 作废。
5. 活跃段残留（title 签名/无条件 cmuxSession/ghost 路径兜底/无 state ledger/no-op refresh/无条件 ≤15s）→ plan v11 + v8 修正。

### R10（5 条全采纳）

1. fence 与 lease 无原子交接（check-then-enter 竞态）→ 线性化协议：begin=持锁原子建 fence+采候选；普通 mutator 持锁重读 fence；resume/cancel 验 nonce/摘要。
2. refresh 完成标记 ≠ 收敛证明（修复函数有吞错返 0 路径）→ typed ACK（verified_ready|deferred|failed + 核验 generation），仅 verified_ready 放行重绘；迟到 ACK + 记录 GC 定义。
3. teardown 显示层动作漏出 fence + launchd 等待形态含糊 → teardown 显示层动作受 fence（lifecycle 杀显式分开）；supervised=非持有有界轮询（防 30s respawn churn）、.zshrc 一次退出。
4. runbook 未落到 §6（install 链无操作员暂停点）→ `flywheel-cmux-migrate` begin/approve/execute/resume/cancel/finish 子命令合同 + install 脚本拆步入变更表 + QA5 按 runbook 排演。
5. fence 与 A0B0 边界 → fence=A/B 之外的运维联锁，「完整 legacy」以 fence 解除为前提，回滚第一步 resolve/cancel fence；残留清扫。

### R11（5 条全采纳）

1. runbook 次序 bug：begin 要 lease 而活 watcher 是终身持有者 → 次序改为 bootout+确证退出 **先于** begin；.zshrc 抢锁间隙=零 mutation 停等重试，绝不窃活锁；install `--migrate` 模式承载过渡；真实终身锁 barrier 测试。
2. teardown 半 fence 不安全（杀 session≠杀窗；worktree 会在 E6 存活进程脚下被删）→ **整个 teardown 入口检查 fence**，含进程与 FS 清理。
3. deferred ACK 无重试 owner + scope 可漂移 → 不可变请求 scope 持久化 + durable 状态机（watcher=重试 owner；restart-services=有界等待者只对已证明集重绘恰一次）。
4. fail-closed fence 无恢复路径 → cancel（良构 fence 认证、不要求 manifest 摘要、零破坏放弃）与 recover-fence（畸形 fence break-glass：留存审计、操作员确认、零显示 mutation）分级。
5. 行为载体定名 + QA5/§2.7/回滚⓪步/研究 teardown 行对齐。（注：本条的 migrate 载体随 R12 降海拔一并撤除。）

### R12（6 条 → 触发第二次降海拔，Lead 拍板）

R12 抓出 refresh 协议版本 skew（旧 watcher 内存中的 parser 会丢新事件且删 .processing 批）、teardown 裸入口检查的 check-then-act、recover-fence 在部分执行后放开联锁、scope 语法 either/or、restart-services set -e caller 合同、活跃段 twins——前三条均为真缺陷，但全部产自「迁移辅助+refresh 协议」这套为一次性 ~20 tab 迁移而生的可选装置。**处置 = 撤除装置本身**（Lead 拍板）：
1. 迁移改人工 runbook + maintenance 标记（上文 §5）——manifest/fence/journal/cancel/recover-fence 全部不建，R12 #1/#3/#4/#5 随之消失。
2. --refresh 在 A=1 下 no-op 化（修的缺陷类不复存在；新窗事件 ≤15s 自建 tab）——协议版本 skew 无从谈起，restart-services 零改动。
3. teardown 以 qa_teardown lease 模式接入共享 lease（R12 #2 独立于装置，保留采纳）。
4. 活跃段 twins 清扫（本 v11）。
保留的核心不动：staging WAL、ledger prepared/committed、guarded chokepoint、分叉拆除、escrow+inventory、B 校验、TS 跳杀、四态矩阵。

### R13（5 条全采纳，plan v15 定稿；降海拔被 review 确认「方向正确、不要求恢复任何已撤装置」）

1. ≤15s 重建声称被源码证伪（create 事件对已存在 workspace 走 attach-only、view 缺失直接返回）→ **A=1 加 drain 分支**：workspace 在 ∧ view 缺失/无效 → 当次 drain 调 scoped 收敛原语（一个条件+一次原语调用，无协议）；回归测试钉死。
2. marker 移入 durable 固定路径 ~/.flywheel/state/cmux-maintenance（/tmp 不耐 reboot、env 分叉三入口看不同路径）；env 覆盖仅测试。
3. bootout+pgrep 不证明既有 one-shot 静默 → runbook 加只读静默 gate（等 lease 无 verified 活 owner，绝不偷锁）。
4. 手关是动作不是后置条件 → 完成核对=Flywheel workspace ref 清零（漏一个=无 ledger 行且挡住 create 重建）；非 Flywheel tab 截图留存不碰；标记残留=恢复核对续走不盲清；QA 故意留一个 legacy tab 的负例。
5. 活跃段对齐：回滚统一走 marker 窗人工流程；P1 模式表去掉已撤迁移模式；research fence/manifest 残句清扫；hooks 行改「create 臂适配」。

### R14（4 条全采纳；review 确认无需恢复任何已撤协议）

1. 事件元组可过期（.processing 重放/兄弟窗/死窗）→ converge_view_for_title 合同冻结：元组仅触发，mutation 前严格快照解析确定性赢家；过期元组绝不构成目标权威；uncertain 零破坏。
2. 「无 verified 活 owner」非 fail-closed → 静默判据改**锁目录 conclusively absent**；存在/畸形/不可读一律停（真活 owner 可能藏在坏记录后）；只读探测入 sync 脚本。
3. $HOME/.flywheel/state 无人 provision → runbook 自带 mkdir -p + touch 读回，失败即停；干净 home 测试。
4. §6 与 §2.4 不同步（跳过新门）→ §6 改为 §2.4 的命令级渲染（正/反两 runbook 全款门）；P1 残句、research manifest 残句清扫。

历轮同时确认保留：Option C 方向、杀伤边界原文、scope 边界、拓扑原语与 workspace create 分层、bootstrap 最前置、@id 比对、四态矩阵、owner 先写先读回、ledger 先落账后 rename、文件承载 mock、真机对照形态、macOS 硬门诚实声明。

### R15（3 条全采纳，plan v17 定稿）

1. 事件重建只证 tmux 层不证 surface attach → converge_view_for_title 成功=双层后置条件（view 终态 + 权威 committed ref 的 surface 经 ref-scoped heal 重挂并以 client 计数严格证明；rc=0 send ≠ 证明；foreign 同 title ref 不碰）；不确定=defer 不计成功。
2. lease 探测合同三态定名 `--probe-lease`（absent=过；良构核验活 owner=有界可取消等待至 absent；畸形/不明/stale=停），只读绝不偷锁；轮询中记录变化入测试。
3. 活跃残句（P1 迁移辅助 / research 部署句 manifest）清扫 + P8 加已撤合同关键词 grep 断言入 PR checklist。

### R16（3 条全采纳，plan v18 定稿）

1. session 级 client 计数不能证明具体 ref 的 surface attach（A 裸壳+B foreign 已 attach=假阳性，heal 见 client>0 即 rc=2 跳过）→ surface 层改**确定性路径**：guarded 关确切 committed ref + create 重建（自带 verify-at-create attach 验证）；真机能力 spike 允许换 target-bound 就地 heal；反例入突变验证测试。
2. tmux 层成功后 surface defer 无 additive 重试 owner（reconcile 见 view 活即跳、create 见 workspace 在即跳、B 见 invariant 已满足）→ durable surface-repair 行（generation|ref|title|winner）由 additive 消费有界重试；≤15s 表述限定为两层皆证。
3. rollback 未渲染 --probe-lease 三态命令 → 正/反 runbook 同款命令级渲染；research 探测语义补活 owner 等待态。

### R17（3 条全采纳，plan v19 定稿）

1. 「guarded 关 + 既有 create 重建」在 foreign 同名共存下不确定（title-exists 早退被 B 挡；verify-at-create session 计数被 B 污染）→ 专用 `repair_create_workspace` 合同（intent 旁路守卫、恰一 ref diff、prepared/committed、typed 终态）；attach 证明升级为实现前决策门（surface↔client 关联身份 / nonce-scoped view 证明 / 收窄合同三选一，session 计数任何分支不作证明）。
2. 四字段 surface-repair 行表达不了 old→new ref 替换事务 → 相位化状态机（close_pending→recreate_pending→verify_pending；write-ahead 先落行；旧 ref 消失=预期推进；后相位不确定绝不回关替代 ref 防重复闪断；winner/generation 变化、A=0 回滚、退避、GC、teardown、prologue 恢复全定义）。
3. 活跃段残留无条件 ≤15s → 全文限定为「两层皆证=成功」；状态机入变更表/风险表/研究测试摘要。

### R18（3 条 → 触发第三次降海拔，plan v20 定稿）

R18 抓出 nonce 证明撞已认领的 canonical 名、相位表「各有定义」实未定义、fwstage 命名空间双主——全部产自 R13 为保 ≤15s 引入的事件快速重建分支。**处置=砍除该分支本身**（与 R12 同型的判断：nicety 不配状态机；串台主 bug 由 A 结构性修复，与重建时延无关）：
1. converge_view_for_title / repair_create / surface-repair 状态机 / nonce attach 证明 / 能力决策门——全部不建，理由入档防将来加回。
2. 同名重生合同=既有 reconcile+create additive 路径，≤2 conclusive pass 如实声明；B-foreign 共存=告警+人工，永不破坏。
3. 活跃段（--refresh 行/QA3/§8/hooks 行/风险表）全部对齐如实时延合同。

### R19（3 条全采纳——诚实收窄路线，plan v21 定稿）

1. 保留的 create 路径的 verify-at-create 用 session 级 client 计数（源码自注「必要不充分」）——孤儿 unnamed client 会造成假绿裸壳且无重试 owner → **诚实收窄（选项 a，不重建状态机）**：≤2-pass 合同只证「安全拓扑+权威 ref 重建」；attach 弱证明角落=裸壳+告警的显式终态（普通场景 FLY-169 自愈）；session 计数在任何地方不被称为 attach 证明；孤儿反例入回归（不许假绿）。
2. B-foreign 不是「缺 tab」——它是可见且不受绑定保证的 founder 自建 tab → 保证域如实定界为 ledger-committed Flywheel tab（plan §1 域边界）；同名冲突=权威 tab 缺位+告警等人工；负例按真实 UI 态冻结（A 关、B 可见未动、无替代 ref、告警）；**若产品验收要求覆盖一切同名可见 tab 则本 descope 不满足——列入 Lead 设计报告决策项**。reconcile 审计行改「适配」（新模式 ledger 过滤，现源码关全部同 title）。
3. research :41 的 ≤15s 残句清除；P8 grep 断言扩展到「无限定 ≤15s 建/重建」类活跃声称；测试摘要纳入两条 R19 反例。

### R20（3 条全采纳，plan v22 定稿）

1. 「不假绿+告警」缺实现载体（现源码 session 计数任意 client 即停重试，R19 回归会在通用 WARN 上空转通过）→ **最小 create 时歧义分类器**（非状态机）：new-workspace 前预捕获 canonical view client 集/计数 → 非 0/不可读时事后正计数一律归类 `attachment_unverified`（建账照常、无重试 owner、结果/日志永不标 attached）+ 发 **generation+新权威 ref+title 键控**告警；回归断言告警本体（任意通用 WARN 不算）+ 突变验证。
2. B-foreign 域边界是未决产品决策，plan 不算 ready to implement → **pre-P0 硬停 gate**：开工前必须记录 Lead 明确决定（决策问询 f2b5be93 已发 Tadashi）；接受=冻结告警+人工契约，拒绝=退回设计。时序/授权 gate，不给 B 加处置权。
3. 活跃段滞后收窄合同 → plan §1 验收句加孤儿角落例外；research §8 补两条具名回归 + 场景数改 11；双风险表补「权威 tab 裸壳终态」「可见 foreign tab 等人工」两行；P8 grep 断言扩展到「无限定重生收敛回正确会话」类声称 + 正向锚点（两具名回归必须在活跃测试摘要命中）。

### R21（1 条采纳，plan v23 定稿）

1. 分类器缺 post-create 读取失败分支（源码 2201 行读失败直接 break——预捕获非零 + attach 失败 + 事后 list-clients 瞬时失败时，既无分类也无告警，留下无人工入口的裸壳终态）→ **fail-closed 补全**：事后读取失败/不可读同样归类 `attachment_unverified`，函数退出前发同一 generation+ref+title 键控告警；具名回归②（上文 §8）：预捕获非零 + attach 失败 + post-read 失败 → 权威 ref 保留、无假绿、精确告警本体存在（突变验证）。不恢复任何已撤机制。

### R22（2 条全采纳，plan v24 定稿；pre-P0 gate 已 RESOLVED）

1. R21 的 fail-closed 误绑在预捕获非零/不可读条件下——**pre=0 + attach 失败 + post-read 失败**仍静默绕过（普通无孤儿场景可停在无告警裸壳，sync_additive 常规 60s 路径无人补救）→ post-create 读取失败/不可读改**无条件**归类 `attachment_unverified`（不依赖预捕获值），退出前发同一 ref 绑定告警；回归②扩为 pre=0 与非零两变体（突变验证）。仍是单分支分类器，无 retry 状态机。
2. 实施载体/硬门滞后（P3、变更表、P8 仍写 v22 合同；双风险表仍写「gate 等 Lead 决定」）→ P3/变更表同步无条件分支 + 三条具名回归；P8 正向锚点升为三条；双风险表改「Tadashi 已书面接受（f2b5be93），契约已冻结」。同轮记录：**pre-P0 gate 已 RESOLVED**——Tadashi 书面接受域边界（原文入 plan §4），告警+人工契约冻结照此实现。

### R23（1 条采纳，plan v25 定稿）

1. 顶层「普通无孤儿场景会收敛」承诺与无条件 post-read-failure 分支矛盾——R22 反例正是 pre=0（无孤儿）+ attach 失败 + post-read 失败：正确分类+告警但**无 retry owner**（sync_additive 常规 60s 路径只在 workspace 缺失时 create（2703-2710），startup-only heal sweep 不跑（2669-2678）），告警≠收敛 → **诚实收窄全文一致化**：「会收敛回正确会话」只承诺给「无孤儿 **且** post-create 读取结论明确」的场景；**任何** attachment_unverified 分支（含 pre=0 post-read 失败）=允许的裸壳/缺 surface + ref 绑定告警终态；plan §1/§2.7/QA3 + 双风险表（风险范围从孤儿角落扩为所有 unverified 分支）同步。既有双变体测试已冻结此合同，无新增机制。

### R24（1 条采纳，plan v26 定稿）

1. P8「撤回合同关键词零命中」硬门自相矛盾不可执行——verified_ready 既是禁词又是 staging 原语的合法 typed outcome（research §1），且 P8 规则行自身含全部禁词，无自排除则门要么永红、要么靠实现者临时扩排除变得不可审计 → 双管齐下：**staging 成功态改名 `staging_ready`**（verified_ready 从此只属于已撤 refresh ACK 合同，禁词无歧义无需语境判断）+ **P8 冻结为可执行合同**（排除规则只有三类：§10 修正史 / 显式「不建/已撤」声明行 / P8 规则定义行自身；写明实际命令与预期命中数；⑤反例 fixture=门的突变验证：注入 refresh verified_ready ACK 文本必须转红、移除恢复绿）。

### R25（1 条采纳，plan v27 定稿；P8 门已实跑证明）

1. 按三类排除规则实套后 baseline 仍有 2 个活跃裸词命中（plan 版本行写了旧 refresh-ACK success token 本体；@id follow-up 的「generation fence」合法用词撞全局禁词 fence）→ 版本行改述不写 token 本体；follow-up 改名 **generation-scoped authority guard**（tmux-generation 核验门）；research §1 的改名说明同样去 token 本体。**门已按 P8 合同实跑**（行级过滤脚本，三类排除）：baseline=0 → 注入 refresh ACK fixture 命中 1（转红）→ 移除恢复 0（转绿），实现机输出留档 design 阶段记录。
