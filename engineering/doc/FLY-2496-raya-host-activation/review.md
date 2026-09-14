# FLY-2496 Raya 宿主激活 — 设计评审记录（Lead leadAcceptance）
Issue: FLY-2496 (https://linear.app/geoforge3d/issue/FLY-2496/raya宿主激活-生产-raya-卡在旧壳-0f77e977班车判-host-capability-absent缺)
日期: 2026-09-13
基于: plan.md

## 过程

| 轮 | 结论 | 条数 | 原文 |
|---|---|---|---|
| R1 | CHANGES REQUESTED | 10 | `codex-review/round1.md` |
| R2 | CHANGES REQUESTED | 6（重开） | `codex-review/round2.md` |
| R3 | CHANGES REQUESTED | 3（重开） | `codex-review/round3.md` |
| R4（Lead 授权的确认轮，只验 R3 三条处置） | CHANGES REQUESTED | 3 | `codex-review/round4.md` |

Codex thread：`01a09cfd-7133-7911-898c-a3d400c417e3`。Lead 裁定（问题 `f67cbc81-084e-4d32-ad1f-17ec2bf46f5c`）：R4 仍非 APPROVED 则 leadAcceptance——R4 条目逐字进本文件，只修其中阻断级，不开 R5；`baseline=quiet15m` + 停机窗口人类消息一律 unresolved 交 Lead 对账，认可为设计，最终由 founder 通过授权行确认（founder HTML 已单列一卡）。

## R4 条目（逐字）与处置

### 1. stop-window 的 processed resolution 仍没有形成最终连续 cursor。（`FLY2496-R1-CURSOR-BOUNDARY`）

> **Issue:** v4 正确拒绝 processed/unprocessed 交错，但 §5 B 仍固定 `B = 最后一条时间 < T0 的消息`（`:154`）；§5 C（`:155`）只说明 `confirmed_unprocessed` 会把 B 压到最早 unprocessed 之前，没有说明 `confirmed_processed` 如何把 B 向前推进。反例：m1 是 [T0,T1] 内唯一的人类消息，Lead 人工确认它已经由旧壳完成副作用并标为 `confirmed_processed`；unresolved 被清空后，seed 仍是 `<T0` 的 B，真实单标量 cursor 会再次拉取 m1。若 m1 processed、m2 unprocessed，正确 cut 应在 m1 与 m2 之间，当前公式仍停在 T0 前。`confirmed_processed` resolution 因而没有兑现"留在连续前缀"的语义。
> **Why it matters:** P4b 会在 `unresolved=[]` 后继续，但已确认完成的 stop-window 输入仍被新 owner 重放，calendar/meeting/回复可能重复；这正是该 finding 要避免的副作用。
> **Suggested fix:** 明确定义 `B_final`：从授权 baseline `B0` 开始，按 snowflake 排序验证 stop-window resolution 必须是零个或多个 processed/reconciled 项组成的前缀，随后才允许 unprocessed 后缀。存在 unprocessed 时，`B_final` 是最早 unprocessed 之前的最后一条频道消息；全部 processed 时，`B_final` 是 T1 之前的最后一条消息。任何 processed 出现在 unprocessed 后仍拒绝。把 `B_final` 落账本并用真实 seed CLI 覆盖"processed-only""processed→unprocessed""unprocessed→processed 拒绝"三例。

**处置：阻断级，采纳。** plan v5 §5 B/C 按建议逐字定义 `B_final`，账本记 `cutover_probe.boundary_message_id = B_final`，三例进批次 B/C 测试。

### 2. ff 后的 legacy owner 复验按现有 matcher 会确定性失败。（`FLY2496-R1-PRESTOP-PREFLIGHT`）

> **Issue:** 目标 `9d63a2b2…` 已删除 `apps/brain` 和 `apps/voice`。现有 `raya_legacy_plist_matches` 从当前 `$RAYA_CODE_DIR/apps/$app/dist/cli.js` 构造期望 argv，并要求 `args[0]` 仍是存在、非 symlink、可执行的普通文件（`updater-raya-deploy.sh:196-216`）；`raya_quiesce_legacy_owner` 在每次 bootout 前直接调用它（`:220-230`）。v4 却先把同一 checkout ff 到删除这些路径的目标 SHA，再"复验两份 legacy owner identity"并进入现有 quiesce。届时 matcher 在 `os.path.isfile(args[0])` 必然失败，两个旧 job 不会被停，班车也到不了 P3/P5。
> **Why it matters:** 这不是残余概率风险，而是给定固定 target SHA 的确定性不可达路径；"ff 是最后一个可逆步骤"的 disposition 尚未与真实 destructive identity fence 对齐。
> **Suggested fix:** 在计划中选择并写死一种可实现的 fence。最小改法是在 ff 前持久记录并核验 plist SHA、label/argv/cwd/env、旧 CLI digest 及 live PID/start tuple；ff 后不再要求已删除路径仍存在，而是 CAS 核验 plist 字节和同一 live PID/start 未变，再凭该快照授权精确 bootout。若不愿改变 legacy matcher，则 main checkout 必须保持旧头直到 quiesce，候选晋升和后续 frozen-source 校验需与 main HEAD 解耦。新增一条使用真实 0f77e977→9d63a2b2 删除布局的测试，证明 ff 后的身份 fence能通过且任何 plist/PID/start 漂移仍零 bootout。

**处置：驳回（事实错误），不改设计。** `raya_legacy_plist_matches`（`scripts/lib/updater-raya-deploy.sh:196-218`）对 cli 路径的检查是 `args[1:] != [cli, "run"]` 的**字符串比较**，不检查文件存在；`os.path.isfile(args[0])` 检查的是 `args[0]`，生产 plist 里 `args[0]` 是 `/opt/homebrew/Cellar/node/25.6.1/bin/node`（`plutil -p ~/Library/LaunchAgents/com.xrli.raya.brain.plist` 实核），`args[1]` 才是 cli.js。ff 删除 `apps/brain` 不影响该 matcher。为保险，plan v5 §5 B 增加一条测试："真实 0f77e977→9d63a2b2 删除布局下 ff 后 matcher 仍通过、且 plist/PID/start 任一漂移零 bootout"（Codex 建议的测试保留，前提修正）。

### 3. rebind 的 ledger/proof 双文件变更仍不是 crash-resumable。（`FLY2496-R1-SHA-FREEZE`）

> **Issue:** 共享 `deploy.lock.d` 能排除并发 writer，但不能让两个文件原子更新。§4/§5 A（`:142,153`）按文字顺序先 CAS 更新 ledger 的 `flywheel_deployed_sha`/checkpoint，再把旧 `proof.json` 改名。若进程在 ledger rename 成功后、proof rename 前崩溃，下一班看到 ledger SHA 已等于 current，因而不再进入 rebind；随后现有 `raya_standard_collect_proof` 会读取仍绑定旧 Flywheel SHA 的 proof，`raya_validate_proof` 失败并走 `proof-invalid` severe。现有测试清单覆盖"P6 后 crash 再 rebind"，但没有注入 rebind 自身两个持久写之间的 crash。
> **Why it matters:** 合法 Flywheel 漂移仍可能因一个明确的 crash point 变成 severe 且不能自动续跑，违反该 disposition 的 `awaiting_rebind_proof`、无 severe 合同。
> **Suggested fix:** 在同一锁内先把旧 proof 原子 quarantine，再 CAS ledger；此顺序中任一点崩溃都可重试：若只完成 quarantine，ledger 仍漂移，下一班继续 rebind；ledger 提交后则不存在可被误读的旧 proof。或者增加持久 rebind intent 并让 pass 在 collect 前收敛 intent。P6→P5 的同一 manifest CAS 应同时清除或明确标记旧 proof-derived fields。增加 proof quarantine 前、quarantine 后、ledger CAS 后三个 crash-injection 用例，并断言恢复结果均为 `awaiting_rebind_proof`、零 severe。

**处置：阻断级，采纳。** plan v5 §4 N+1 / §5 A(4)：同锁内先原子 quarantine 旧 proof，再一次 CAS 同时写 `flywheel_deployed_sha`、`flywheel_rebinds[]`、checkpoint→P5 并清空 `lead/checks/cutover` 中 proof 派生字段；三处 crash-injection 用例进批次 A。

## R4 advisory（非阻塞）处置

- research §4 措辞收窄：`runtime.ts:279-305` 是 voice 告警裸 POST；voice/meeting gateway 用 discord.js `message.reply`（带引用）。结论改为"没有逐条处理的持久账；reply 引用只能证明'被回过'，不能证明 calendar/meeting 副作用完成或全入口 drain"。已改。
- exploration §2.7 / §4.3 残留旧算法措辞：已同步为"零处理推断 + founder 授权的 out-of-scope 基线"。
- pre-stop quiet check 分页：v5 改为分页直到覆盖 15 分钟窗口（≤5 页），否则 fail-closed。已改。
- 稳定 activation 的诚实边界：v5 §9 明示"rebind 后 text/summary 证据属于同一 activation，不保证来自当前 PID；当前进程证据是 restart-status + live verify"。已改。

## 有效结论

按 Lead 裁定，本文件即 leadAcceptance 记录：R4 三条中两条阻断级已修入 plan v5，一条经源码实核驳回；advisory 全部处理。设计评审 effective verdict = APPROVED（Lead acceptance，Codex 未给出 APPROVED）。
