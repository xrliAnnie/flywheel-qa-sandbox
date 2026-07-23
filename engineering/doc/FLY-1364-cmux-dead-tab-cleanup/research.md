# FLY-1364 cmux 死 tab 不清理 — 调研

Issue: FLY-1364 (https://linear.app/geoforge3d/issue/FLY-1364/bug-cmux-死-tab-不清理-cleanup-mutator-被单写锁lease-unverifiable挡死log-已退出-579)
日期: 2026-07-18
基于: exploration.md

> Brainstorm gate 已过(Lead 证据级认同根因;A+B+D+E+F+G 全批,不做 C)。本篇回答 exploration 的 5 个开放问题 + Lead 的 3 个追加要求((a) 能力级真机 E2E、(b) flag 四组合记账 + 半开态防呆、(c) 与 FLY-1365 的 PR 顺序/rebase 约定),为 plan 提供全部事实依据。

## R1 · flag 四组合行为矩阵(现状代码事实)

A = `FLYWHEEL_CMUX_LINKED_VIEW`(isolated linked-view 创建,FLY-1272 kill-switch),B = `FLYWHEEL_CMUX_VIEW_INVARIANT`(串台收敛 pass,默认 1)。

| 组合 | create 路径 | 写 ledger? | cleanup 路径(gate = A‖B,`:1144` 等 8 处) | 结果 |
|------|------------|-----------|------------------------------------------|------|
| A1B1(1272 出货默认) | isolated staging WAL(`:2861-2868`) | ✅ prepared→committed(`:2965/:2992`) | dismantle_view_display(ledger 授权) | ✅ 自洽 |
| A1B0 | isolated | ✅ | dismantle(gate 因 A=1 仍走新路径) | ✅ 自洽 |
| **A0B1(生产现状)** | **legacy grouped(`:2870-2872`),rename 不记账(`:3003`)** | **❌** | **dismantle:ledger 空 → 一律拒(foreign/unledgered)** | 💀 **死 tab 永不清(本 bug)** |
| A0B0 | legacy | ❌ | legacy close(title 匹配 close_workspace_by_ref + tmux kill,`:1150-1164`) | ✅ 能清,但含 1272 要防的 title-only 误杀旧 bug |

**结论**:四组合中只有 A0B1 是「写读不对称」的死角。而 A0B1 恰是 FLY-1272 plan 自己定义的**合法回滚/过渡态**(plan §1「A0B1 时 B 把旧串台压到 ≤2 pass」、§5 回滚矩阵第 6 行)——1272 的回滚矩阵 QA 只断言了**串台收敛**,从未断言**stale 清理**在该态下仍工作。B 的本职是 `repair_view_invariants`(串台收敛);把 stale-cleanup 也挂上 `A‖B` gate 是 1272 计划→实现之间的缺口,不是其安全模型的本意。**修法应补对 A0B1 态,不推翻 1272 的「title 永远不是 authority」立场。**

`LINKED_VIEW=0` 的来源:即 1272 §6 定义的 kill-switch 回滚语义(A=0 = 回旧行为)。生产 `.env:148-149` 正是 A0B1。是否可直接重开 A=1:**不属于本单**——1272 有自己的部署次序硬约束(先 A-aware Bridge 后 watcher、maintenance marker 人工流程,qa-report:103),重开是 1272 域的运维决定;本单必须让 A0B1 本身正确,因为 kill-switch 的意义就是这个态要能长期安全运行。

## R2 · 收养(Fix A)证据链的数据源盘点

**约束(实测)**:cmux `--json list-workspaces` 每行仅 5 字段 `index/pinned/ref/selected/title` —— **没有 attach command / 关联 session 字段**。「这个 workspace attach 的是谁」无法从 cmux 侧证明,证据链必须从 tmux 侧 + 调用方语义构建。

可用证据(全部现存机制,零新数据源):

| 证据 | 来源 | 证明力 |
|------|------|--------|
| E-a 清理入参本身 | cleanup_workspace_for(agent_name) 的入参只来自:①cleanup_stale_workspaces(存在 `cmux-<name>` 视图会话但源窗口消失,`:3041-3047`)②event/conservative cleanup(STALE_STATE 行,pane_dead 观测) | 「这个名字曾被 Flywheel 管理」的一手证据 |
| E-b exact-ref 唯一性 | 当前 JSON 中 ref+title 恰好匹配 1 个(复用 `_ledger_close_guard` 的校验形态 `:2380-2393`) | 防错杀:多于 1 个同 title → 不收养该 title 的歧义 ref |
| E-c 视图会话侧 | `cmux-<title>` 会话存在时:grouped(`session_group` == 源 session)或带 `@flywheel_cmux_owner`;不存在时(create 半途/已杀)= workspace 是 attach 失败的裸壳 tab | 区分「我们的显示壳」vs founder 自建 tab(founder tab 不叫 `cmux-*` 视图、也不在 STALE_STATE) |
| E-d 源窗口死证据 | `window_source_pane_alive` / get_tmux_agent_windows 无该名 | 「确实该清」 |
| E-e 两遍确认 latch | 复用 `view_mismatch_confirmed`(`:2634-2655`)签名机制:两个连续 conclusive pass 同签名才授权 | 防瞬态读数授权破坏性动作 |

**dual-session 同名碰撞(1342 形态)的判定**:同 title 出现 ≥2 个 ref 时,E-b 直接令收养对该 title 失效 → 保持拒 + 告警(升级人工)。这与 1272 R19/R20 的「域外碰撞=告警+人工」冻结契约一致(Tadashi 书面接受 f2b5be93)。**不做 tie-break 自动裁决**——歧义即人工,杜绝错杀。

**收养后的走向**:补写 `committed|<当前generation>|<ref>|<title>` 行 → 走现有 `close_ledger_workspace_ref`(guarded close + ledger remove)正路。dismantle 主逻辑不分叉。

## R3 · generation 孤儿(Fix F)

`cmux_socket_identity` = socket 文件 `stat %d:%i:%B`(`:1563-1566`),cmux Electron 重启即换代。ledger 行按 generation 键控,`ledger_refs_for_title` 只认当前代(`:2370-2375`);`reconcile_prepared_ledger` 只 GC 当前代 committed 行(`:2463`)→ 旧代行**永久滞留**且当前代查不到 = 换代后全量 tab 变 foreign(与 A0B1 同一症状的第二触发器)。

处理(与 A 共用证据链):reconcile 增加 stale-generation pass —— 旧代行的 ref 在当前 JSON 中 title 一致且 exact-ref 唯一 → 迁移(re-adopt)为当前代 committed;ref 已消失 → GC 删行。两遍 latch 同样适用于迁移(它授权后续 close)。

## R4 · P3:tmux-server-rescue 锁争用现状与 instrumentation 落点(Fix G)

现状(`scripts/lib/tmux-server-rescue.sh`):
- 锁 = per-socket kernel flock/lockf(`~/.flywheel/locks/tmux-<hash>.lockf`,`:799-812`),`flock -w <FLYWHEEL_TMUX_RESCUE_LOCK_TIMEOUT_SEC>` 超时 → `hold_lock_unavailable/acquire_timeout`(`:822`)。
- owner 元数据(`:710-731`)只有 `pid/startIdentity/token` —— **无 verb、无 acquiredAt、无调用方身份**;bridge log 的 acquire_timeout 行(实测 19 次)**无时间戳** → 事后无法定位长持锁方。这就是「无法定位」的结构原因。
- 串行域:ensure(codex-runner-tui-window)、inspect、spawn(TmuxAdapter)、claude-lead.sh、sync-flywheel-hooks 全走同一把锁;cmux-sync **不**走它(仅注释)。

G 的落点(instrumentation 先行,结构收敛后置):
1. owner 文件加 `verb=/acquiredAt=/caller=` 字段(写侧向后兼容:只加行,读侧无人依赖行数)。
2. 释放路径记 hold-duration;超阈值(如 >5s)打审计 log + lead-alert。
3. `acquire_timeout` 的 evidence JSON **加字段不改字段**(向后兼容):带上当时读到的 owner(pid/verb/acquiredAt/持有时长),让每次超时自带「谁占着」。
4. 结构收敛(hold budget / 拆锁 / 公平性)**明确不在本单实现**:等 instrumentation 数据落地后另开 issue——避免在没有持锁分布数据时盲改锁语义。

## R5 · 与 FLY-1365 的边界与 PR 顺序(Lead 要求 c)

- 分界双向已互认:1365 plan §0.4 原文「不修 tmux-server-rescue 锁争用为何发生(FLY-1364 域)」;1365 修调用侧(ensure 异步化 + 可见性,让 stall 不再卡死 Bridge main loop → 锁争用从「死」降级为「慢」)。
- 改动面**零文件重叠**:1365 = `packages/claude-runner/src/codex-runner-tui-window.ts` + CodexTmuxAdapter;1364 = `scripts/flywheel-cmux-sync.sh` + `scripts/lib/tmux-server-rescue.sh`(+ lead-alert 调用)。1365 当前为纯 docs 分支(implement 未开始)。
- 唯一接触点 = rescue 的 evidence JSON 格式(1365 的 ensure 只透传 log)。约定:**1364-G 对 evidence/owner 格式只加字段、不改不删既有字段**(向后兼容合同,写进 plan 验收);**后 merge 方负责 rebase**,预期冲突面为零;若 1365 implement 期间要消费 G 的新字段,以 merge 到 main 的格式为准。

## R6 · 告警通道(Fix D/E 落点)

watcher 现状:**零告警能力**(纯 log,`manual resolution required` 从未到过人眼——本次静默失败的直接原因之一)。现成管道:`scripts/lead-alert.sh` —— gated Discord 告警(queue/deadletter/claims 去重,FLY-368 统一 #flywheel-alerts),converge-flywheel-bin.sh 与 flywheel-bridge-wrapper.sh 已在用;支持 FLY-529 的 env 隔离镜像(`FLYWHEEL_ALERT_QUEUE_DIR`/`FLYWHEEL_CLAIMS_DB`),QA 可全隔离实测「实发实收」。

D 的形态:拒清(foreign/unledgered 且收养证据不满足)与 flag 半开检测各自**按稳定键去重**(title+ref / flag 组合)告警一次,恢复后清 latch;绝不按 tick 刷屏(FLY-1220 回声风暴教训:episode-latch 报一次就停)。

## R7 · 半开态防呆(Lead 要求 b)

- B(Fix B)后,四组合的 create 全部记账(A0 分支补 `_ledger_upsert prepared→committed`,复用 A1 分支的 generation 三点一致 + 恰一 ref diff + 写失败留 unnamed 的既有合同形态,`:2958-2995`)→ A0B1 从「结构性死角」变为「自洽组合」。
- 防呆不做「拒启」:A0B1 是 1272 合法回滚态,必须能跑。做**启动自检 + 一次性告警**:watcher 启动(及 flag 变化)时检测 create/cleanup 模式组合,A0B1 → 打审计 log + lead-alert 一次(键=组合值),说明该态已由本单补正但属于过渡态、提示回正 A1B1 走 1272 runbook。
- 未来新 flag 的通用防呆(半启用检查框架)超出本单 scope,不做。

## R8 · 能力级真机 E2E 验收方案(Lead 要求 a)

参考 FLY-873 配方(watcher swap-in:record state → reversible swap → E2E → restore)+ FLY-529 alert 镜像:

1. **隔离段(529 Room 形态)**:隔离 env(独立 LOCK_DIR/VIEW_LEDGER/STALE_STATE/ALERT_QUEUE_DIR + 测试 tmux session)注入四场景:①unledgered 死 tab → 数分钟内被收养并清掉;②同 title 双 ref → 拒清 + 告警实达(隔离 alert channel 实收);③stale-generation 行 → re-adopt/GC;④A0B1 半开告警一次性。突变验证:把收养证据故意弄缺(如伪 founder tab:无视图会话、无 STALE_STATE 记录)→ 断言**不**清 + 告警,防「收养」退化成 title-only 盲杀。
2. **生产段(存量收敛)**:production watcher swap-in(FLY-873 纪律:记录现状、可回退、杀显示壳 ≠ 杀 runner):新版 watcher 接管后,断言当下真实存量死 tab(FLY-1338/1342/1356-implement 等)在 ≤2 个 conservative 周期(~10 分钟)内清零、活 tab 一根手指不碰、≥10 分钟无 appear/disappear 振荡(FLY-873 判据);拒清告警在生产 #flywheel-alerts 实收(若存量里真有歧义 tab,它就是天然的告警正例)。
3. 验收断言全部对**行为**(tab 真消失/真保留/消息真到达),不对 log 词(「工具说它成了」不是证据——家规)。

## R9 · 存量收敛方式(开放问题 5 收口)

不加一次性 operator 入口(`--adopt-sweep`):收养逻辑挂在现有清理路径(event/conservative/reconcile)上,存量死 tab 会被 conservative cleanup(300s)自然逐个收敛——E2E 生产段即验证此路径。零新入口、零新周期负载(FLY-129 纪律)。
