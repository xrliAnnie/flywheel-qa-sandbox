# Design Review — plan.md (Round 1)
Date: 2026-08-17 / Author: Codex / Status: CHANGES REQUESTED

## Summary

整体方向是对的：冻结生产现值、Wave B 等 D-2、D-3 明确排除、两条无单一值的 env 搬到 exemption，都是合理边界。但当前计划还不能实施。两个阻断问题是：`cmux_linked_view` 的真实调用图与计划相反，且 Wave B 的 B-1 只改 registry、没有改解析器真缺省，违反本计划自己的硬门①/③。另有 D-2 征询口径、workflow 历史 run 兼容、founder-UX 拆除清单、AutoContinue 死代码和 exemption 载体等缺口。

## What's Good (Keep)

- 保留 Wave A / Wave B 分割；Wave B 在 founder 明确答 A 前零代码，答 B 则退回重新立项。这是正确的授权边界。
- 生产 `.env` 的方向已由本轮只读复核确认：五个 workflow env 都为 `1`，`FLYWHEEL_CMUX_LINKED_VIEW=0`，D-3 的 `FLYWHEEL_MAILBOX_DISCORD=1` 仍在且不应触碰。
- `lead_dry_run` 搬迁是正确处置：它有大量逐次调用读点，并有 `scripts/verify-anna-isolation.sh:122`、`scripts/lib/buddy-captain-preview.sh:148` 两个真实 setter，无法写出单一冻结值。
- `done_thread_reconcile` 搬迁也合理：生产 absent=ON，而 `scripts/test-deploy.sh:916` 的 `=0` 是 QA slot 防扫真实 Linear 的隔离接缝，不能焊死掉。
- “输掉的值变 inert”行为断言与全仓零读点 sweep 组合起来，原则上能证明选择已消失；应保留这个测试形状，但必须落在真实生产 seam 且在实现前确实 RED。
- founder-UX 当前被 fleet killswitch 短路，整体退役方向合理；保留历史 DB 列、不做破坏性迁移的保守姿态也应保留。

## Issues & Recommendations (numbered: issue, why it matters, suggested fix)

1. **[BLOCKER] `cmux_linked_view` 并不控制计划声称的拓扑分支；按“26 处 linked 死分支”清理会误删活的 watcher 生命周期代码。**

   **Why it matters:** 当前唯一真实 env 读点是 `scripts/flywheel-cmux-sync.sh:3386-3391` 的 `linked_view_enabled()`；它唯一被 `check_cmux_flag_state()` 在 `:6843-6881` 调用，用来计算 A0B1 信息告警 latch，主循环在 `:8651` 调它。实际 view 构建/恢复代码没有用该 flag 分支：`_linked_view_matches()`、`prepare_linked_view_state()`、WAL 恢复和 `repair_view_invariants` 都是无条件活链（例如 `:7006`、`:7014`）。因此计划里的“env=1 时拓扑仍独立”测试在改代码前就会 GREEN，不是 RED；函数名含 `linked_view` 也不等于它是 flag 的死分支。

   **Suggested fix:** 重写 3.4 的调用图。保留全部无条件 view/WAL/receipt/lifecycle machinery；只处理真实控制面：autostart/sync 的两个 env 读点，以及 `check_cmux_flag_state` 的当前值语义。若要严格冻结当前 `0`，可在 A-1 把真缺省改为 0；A-2 把 latch 状态固化为当前 A0B1、删 env 读点并把告警改成事实文案。对应 RED 应清空 latch、注入 `=1`，仍要求得到固化后的 A0B1 结果。若决定连 flag-state 告警族一起删，必须把这是有意删除观测行为写成单独 disposition，并清理 `CMUX_FLAG_STATE`、`cmux_flag_state` kind/文案/测试；不能称为拓扑“零行为变化”。

2. **[BLOCKER] Wave B 的 B-1 只改 `registry.default`，没有先改解析器真缺省，违反硬门①/③并制造 registry 与 runtime 不一致的中间 commit。**

   **Why it matters:** 五个真实解析器仍全部是 default-OFF：`workflow-template-dispatch.ts:16,21`、`workflow-template.ts:17`、`workflow-claims.ts:123,128` 都使用 `=== "1"`；CLI/live-`.env` 的 claims-read 在 `ship-eligibility.ts:70-100` 和 `verify-approval.ts:145-162` 也把 absent 判 OFF。仅把 registry 五行写成 `true` 不会改变这些真缺省，却会让 dashboard/台账声称 default-ON。B-2 才突然恒 ON，不是“先改值再删”。

   **Suggested fix:** B-1 同时把所有真实 resolver 改成 default-ON、仍保留显式 `=0` opt-out：TS 谓词改为 `!== "0"`，claims-read 的 argsEnv/live-`.env`/processEnv 三层也改成 absent=ON；同 commit 更新 registry 与条款文案。B-1 测试锁定“absent→ON、显式 0→OFF”。B-2 再先落 RED：“显式 0 也不再改变行为”，随后删除所有读点/谓词。这样 B-2 只删除最后的选择，不承担真缺省翻转。

3. **[HIGH] D-2 征询卡包含一个证据不支持的结论，且运行量数字已经漂移。**

   **Why it matters:** 卡片写“查不到批准记录……只代表当初没人拍”，但 `audit.md §5` 明确结论是：现有审计通路不记录这类 flag 批准，所以沉默既不能证明批过，也不能证明没人拍；只能说“没有可援引的批准出处”。此外，本轮对 live `teamlead.db` 的只读查询得到 312 个 workflow run / 261 个 claim，而不是卡片里的 22 / 31；当前 5 个已发布、未退役模板确实全为 schema 2。DB 正在变化，不带时间点的数字会很快再次失真。

   **Suggested fix:** 把“没人拍”改为“当前找不到可援引的批准出处，无法证明当时由谁批准”；在设计交付/实际 relay 前重新执行同一只读 census，并把数字写成“截至 <timestamp> 的快照 + 查询出处”。D-2 的开工门应绑定到修正后的卡片原文，而不是当前版本。

4. **[HIGH] Wave B 消费者清单不完整，且没有把历史 `epoch-0` / non-enrolled run 的保留合同变成可执行测试。**

   **Why it matters:** `ship-eligibility.ts` 不是纯 CLI helper；`packages/teamlead/src/bridge/merge-ship-gate.ts:300` 和 `external-merge-reconcile.ts:750` 都直接消费 `resolveWorkflowClaimsReadEnabled`，不在“8 个消费文件 + 两个 CLI 文件”的清单里。当前生产快照中活跃 engine run 均为 `claims_read_enrolled=1`、`gate_carrier_epoch=1`，另有活跃 legacy/non-engine run；这说明当前没有需要迁移的活跃 engine epoch-0 run，但不能替代历史重放合同。现有 `StateStore.workflow-templates.test.ts:217-244` 的 epoch-0 用例靠 env=0 创建；删 flag 时若把它当“可配置性测试”删除，就会丢失历史 epoch-0 行为保护。

   **Suggested fix:** 重做完整 import/caller inventory，至少纳入 `merge-ship-gate.ts`、`external-merge-reconcile.ts` 及其恢复/完成路径。B-2 前保存一份带时间点的 active/held census。测试矩阵必须分开证明：新 run 恒 `gate_carrier_epoch=1`；DB fixture 中既有 epoch-0 run 仍走 legacy prompt/fence/holder/scanner；`claims_read_enrolled=0` 仍不从 ledger 或 live flag 推断；legacy non-engine completion/finalization 仍走当前已部署的 ON 语义；enrolled engine run 仍走 claims/head-authority。保留 `ship-eligibility.test.ts` 现有“READ on + unenrolled → fail-closed”负例。

5. **[HIGH] founder-UX “整机拆除”清单漏了公开 CLI、retry/engine 传播和第三个 StateStore 历史列。**

   **Why it matters:** 计划列了 founder-ux 目录和部分 Bridge 接线，但真实机制还包括 `packages/flywheel-comm/src/commands/founder-ux.ts`、`flywheel-comm/src/index.ts` 的三条 CLI 命令、`commands/stage.ts` 的 implement fail-close 解释、`bridge/actions.ts:1320` 的 retry 传播、`workflow-engine-dispatcher.ts:2682` 的 successor 传播，以及 plugin route mount。StateStore 也不是“两列”：`founder_facing_ux`、`founder_ux_signoff_json`、`founder_ux_gate_mode` 三列都有 ADD COLUMN migration（`StateStore.ts:2912,2919,2928`）和 TS/read/write wiring。只按当前清单实施会留下半拆状态，或把活引用留到 build 才发现。

   **Suggested fix:** 在 3.1 增加逐文件手术表，明确删除三条 CLI surface、stage 特判、route mount、retry/successor 传播、全部三列的 TS/read/write wiring；若“历史列清理不在本单”成立，就保留三条 migration，而不是两条。增加非空泛测试：旧 CLI 命令不再注册；`stage set implement` 不再识别 founder-UX 专用错误；合法和畸形 stale `founder_ux_gate` config 都不再影响 config load/launch；claude-lead 与 route 测试均显式注入输掉值 `FLYWHEEL_FOUNDER_UX_GATE_ENABLED=1`，确保实现前 RED。最后的 sweep 还要覆盖 `founder_facing_ux`、CLI 命令名和 `FOUNDER_UX_SIGNOFF_REQUIRED`，不只三种大小写符号。

6. **[MEDIUM] `runner_autocontinue` 计划只删 315 行 armer，会留下整个无消费者的机制和一条 stale truth ledger。**

   **Why it matters:** `autocontinue-armer.ts` 是 `autocontinue-arming.ts`、`autocontinue-goal.ts`、`autocontinue-state.ts` 的唯一生产消费者；四个文件合计 683 行。删除 armer 后后三个文件约 368 行全变 dead。`FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS` 也只在 plugin/armer 链消费，却仍登记在 `truth.ts:512` 的 NON_FLAG_ALLOWLIST。计划宣称冻结为“机制不存在”，留下这些与 companion knob 相矛盾。

   **Suggested fix:** 3.2 明确删除四个 autocontinue 模块、全部对应测试、plugin import/boot wiring，以及 `FLYWHEEL_AUTOCONTINUE_ARM_WINDOW_MS` 的 NON_FLAG_ALLOWLIST 行；对 runner-state 中既有 goal/armed 文件只声明惰性残留、不做破坏性清理。用符号和 companion env sweep 证明 FLY-818①全灭，同时保留 FLY-818②的独立路径。

7. **[MEDIUM] 两条 exemption 的处置方向正确，但计划描述的落账形状与现有 `exemptions.ts` 不兼容。**

   **Why it matters:** 当前 `QA_AND_INVOCATION_SEAMS` 是私有 string array，再统一 map 成 `owner: "flywheel-eng-lead"`、`issue: "FLY-1455"`、通用 reason、`persistentEnvAllowed:false`；它不能直接为 `lead_dry_run` / `done_thread_reconcile` 写计划要求的逐条 `issue: FLY-1808` 和专属 reason。只把名字追加到数组会丢掉本单要求的归因与 QA 防火墙解释。

   **Suggested fix:** 计划先选定可实现的数据形状：要么把该列表改成逐条 record/tuple 并保留既有 17 项字节等价，要么在 `FLAG_EXEMPTIONS` 里追加两个显式 object。两条都应是 `kind:"env"`、`persistentEnvAllowed:false`、canonical owner，并各自带 FLY-1808 reason；集合守卫同时断言“不在 registry、不在 tombstone、在 exemption、生产读点仍存在”。

## Verdict

CHANGES REQUESTED

在修正 cmux 调用图、Wave B 的真实 default-on 过渡、D-2 卡片证据口径，以及上述消费者/历史合同清单后再进入实现评审。当前版本不应开始 Wave A 或 Wave B 代码。
