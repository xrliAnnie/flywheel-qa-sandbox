# FLY-1456 plan.md — Codex design review 记录(3 轮,APPROVED)

复核轮次证据原文(由 /tmp 归档)。

---

# Design Review — FLY-1456 plan.md (Round 1)

Date: 2026-07-24
Author: Codex
Status: CHANGES REQUESTED

## Summary

方案采用 registry 删除 + truth tombstone + 生产读点收敛的总体路径可行，PR 按内聚家族串行切分、保留 legacy delivery 巷道机器的边界也基本合理。主要阻塞在 PR-4：计划没有闭合 quota 永久 cutover 后的运维模式、shell 测试和 dormant route 收敛；另外验收命令与 62-row 交接台账目前不可执行。

## What's Good (Keep)

- 唯一裁决源钉在 `67b35748:tab-decisions.js`，13/1/46/2 的高层分类与该提交及 snapshot 的互斥分桶一致。
- RESERVED 两个 work-kind 急停杆被明确排除，且 founder-gated merge、独立 review/QA、四个 PR 串行落地的控制面清楚。
- shell deletion 与 lane demolition 的切线总体正确：保留 `legacyDeliveryWatchdogsOn` 及 20+ 下游，避免把 flag 治理扩大成 FLY-1261 量级重构。
- `park_watch_n2_ms` 虽另有 `parkFounderGraceMs` caller，但该 caller 位于 `detectionReconcileTick`；`runDetectionReconcileCohorts` 只在 `legacyEnabled=true` 时调用这个 pass，而生产传入的是恒 false 总闸，故 park 五条的死壳结论成立。
- `registry.ts` 删除、`truth.ts` 墓碑、相关测试和生产读点同步收敛，符合 FLY-1243 与双向 drift guard 的既有机制。
- PR-4 的 retired truth table 与当前生产 `CUTOVER=1` 路径一致；认证层仍在 router 外，认证缺失时保持 503、认证通过后才是 410。

## Issues & Recommendations

1. **[BLOCKER] PR-4 只删两处 env 写入，会破坏 `setup-quota-monitor.sh` 的运维合同并可能形成自动切号真空。**
   `--disable` 当前是“停 daemon → 删除 CUTOVER → 重启 Bridge → 恢复 Bridge switch path”（脚本 `:169-176`）；`--monitor-only` 当前依赖 Bridge legacy path 继续承担切号（`:253`、`:357`）。永久 410 后，仅删除 `:172/:351` 会让 `--disable` 停掉唯一 executor、让 `--monitor-only` 使用空 order，同时日志仍谎称旧路径已恢复/仍活。配套 CI shell suite `scripts/__tests__/setup-quota-monitor.test.sh` 还逐字断言旧语义（`:112-116`、`:229-235`、`:283-289`），且 `.github/workflows/ci.yml:381` 会运行它；`pnpm test:packages:run` 不覆盖该根目录 shell suite。`scripts/qa-fly-1252-quota-state-e2e.sh:310-318` 也仍要求 CUTOVER-off legacy truth table。
   **建议：**在计划里先明确永久 cutover 后 `--disable`、`--monitor-only` 的新权威语义并请 Lead确认：要么移除/拒绝会造成 executor vacuum 的模式，要么保留“明确停止自动切号、绝不声称回退”的 fail-loud 运维动作。同步更新 usage、日志、restart 行为、setup shell suite，并把 `bash scripts/__tests__/setup-quota-monitor.test.sh` 加为 PR-4 本地硬门；删除或改写 legacy rollback E2E。回滚说明也应钉死为“revert PR-4 + 重启 Bridge”，而不是旧 env 翻转。另请消除 §3 中 `quotaDaemonCutover: () => true` 与“删除 `cutoverEnabled` dep”的二选一措辞：若 router 固化成静态 410，就明确收敛 `getRuntime`、唯一服务该 route 的 holder/legacy body；若刻意保留 dormant machinery，则列入边界和 follow-up。

2. **[HIGH] 当前 grep 验收不可满足，也不足以证明 RESERVED 零触碰。**
   §2/§6 要求目标 envVar 在 `packages/*/src` 零命中，但同一计划又要求把 14 个字符串加入 `packages/config/src/feature-flags/truth.ts`；所示 `grep -rE ... packages/*/src` 也没有真正排除 `__tests__`。因此命令按字面必红。反过来，现有 drift scanner 主要抓直接 `process.env.X` 和布尔比较，不能替代对 `positiveEnv(name)` / `envPositiveInt(name)` 这类动态 value 读的精确 residue scan。RESERVED 的“diff 中出现字符串即 fail”也不如直接证明两个读点文件及两个 registry spec 未变。
   **建议：**给出可复制执行的三段门：① runtime residue scan 显式排除 `**/__tests__/**`、`registry.ts`、`truth.ts`，并单独覆盖 `scripts/setup-quota-monitor.sh`；② registry 中目标定义为零、truth 中恰有 14 个 `retiredBy: "FLY-1456"` 墓碑；③ 对 RESERVED 直接要求 `packages/teamlead/src/workflow-template-dispatch.ts`、`packages/teamlead/src/workflow-template.ts` 零 diff，并用现有 registry contract test（或固定 spec snapshot）证明两个完整 spec 原样。不要用自然语言括号代替真实 path exclusion。

3. **[HIGH] “62 条逐条台账”目前不可复现，且没有完成 FLY-1405 的逐 flag 交接。**
   §1 说 `execution-ledger.md` 初始内容等于下表，但表里没有列出 40 个 `default_only` 名字；“名单见 research.md §2 取数脚本”这一引用不存在，research §2 只有 13 个死壳读点。5 个 keep 与 `cmux_linked_view` 也没有逐条填写 `1405-migrate-candidate` 的 yes/no 与去向，和 exploration §5 Q4 的逐条列合同不一致。实现过程中 registry 会连续删除条目，若届时再凭当前 registry 取数，更容易漏账或漂移。
   **建议：**在开工前从 pinned `67b35748` 的 `snapshot.json` + `tab-decisions.js` 生成并提交完整 62-row ledger，每行至少包含 flag、verdict、action/owner、PR、`1405_candidate`、reason、merge SHA；加 guard 证明 62 个唯一名字、无漏无重、分桶总数正确。40 个 default-only 必须字面落表，keep/frozen/RESERVED 也必须逐条给出 1405 yes/no，而不是整桶口头标记。

4. **[HIGH] 活的运维文档仍会指导操作者设置即将墓碑化的 flag。**
   `doc/architecture/infra-alerts-spec.md:146` 仍把 `FLYWHEEL_CHECKPOINT_WATCHDOG` 写成生产值 `1`，并把 `engineering/doc/FLY-1049-fly915-alerts-closeout/enable-window-runbook.md` 称为单一权威；后者仍包含设置该 env 的步骤。PR-3 墓碑后，照此操作会被 `check-flag-truth` 拒绝。计划目前只说最后更新 CLAUDE milestone，未区分活规范/活 runbook 与历史归档证据。
   **建议：**PR-3 同步修正当前 architecture spec，并将仍被引用的 enable runbook 更新为“checkpoint patrol 已移除/不得再设置该变量”或明确标记 superseded；历史 issue 文档可保留。PR-4 同理清理当前 setup help/log/测试中的 CUTOVER 旧合同。最终 residue audit 应把“活文档/运维脚本”与“历史归档证据”分开列证，避免为了 grep-zero 改历史材料。

## Verdict

CHANGES REQUESTED — address items above

---

# Design Review — FLY-1456 plan.md (Round 2)

Date: 2026-07-24
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 对四项原反馈都有实质闭环：62 条名单可复现、RESERVED 证据更直接、PR-4 三种运维模式与本地 shell gate 已写清、checkpoint 活文档也纳入了 PR-3。当前仍不能批准，主要因为 PR-4 的验收与 stale-key cleanup 自相矛盾，且既定 rollback 在生产 env 已清理后会同时复活 Bridge executor 与仍在运行的 daemon；另外 route 消费链、当前 quota recovery runbook 和最后一个 merge SHA 的台账闭环仍未写完整。

## What's Good (Keep)

- 已用 pinned `67b35748` snapshot 复核：字面 40 条 `default_only` 加 13 条删除、1 条固化、5 条 keep、1 条 frozen、2 条 RESERVED，恰好覆盖 62 个唯一名字，无漏项或额外项。
- `execution-ledger.md` 的固定取数源、逐行字段和 1405 candidate 归属比 Round 1 明确得多，避免实现过程中随 registry 连续删除而漏账。
- `--monitor-only` 与 `--disable` 不再谎称 Bridge fallback，三种 setup mode 的终态、本地 shell suite 和手工 E2E 收敛方向正确。
- residue scan 已显式区分 runtime、tests、truth tombstone；RESERVED 也改为直接核对两个读点文件和 registry 定义，符合 founder 红线。
- PR-1/2/3 的 shell-deletion 与 lane-demolition 切线仍然合理；串行删除叶子旋钮、最后收总闸，符合 FLY-1240–1243 的落地方式。
- PR-3 将当前 architecture spec 与仍会指导操作的 FLY-1049 runbook 一起改掉，同时保留历史审计材料，范围控制正确。

## Issues & Recommendations

1. **[BLOCKER] PR-4 的 setup 脚本合同与验收条件互相排斥。**
   §3.4b 明确要求保留 `set_env_key FLYWHEEL_QUOTA_DAEMON_CUTOVER` 作为 `--disable` 的 stale-tombstone cleanup（plan `:151`），但每 PR gate 与整单验收又要求 `scripts/setup-quota-monitor.sh` 对该字符串零命中（`:81`、`:174`）。按当前文字实现，两项不可能同时通过；而且所示 zero-output grep 正常情况下返回 1，也不是可直接放进 `set -e` gate 的成功命令。
   **建议：**二选一并统一 research/plan/gate：若保留 cleanup，就把验收改成“恰好一个 deletion-only allowlisted occurrence，且 `set_env_key ... 1` 为零”，并断言它只位于 `--disable` 分支；若坚持源码零引用，就删除该 cleanup。将 residue/RESERVED 检查写成 `if grep ...; then exit 1; fi` 或等价自失败命令，使“通过”返回 0。

2. **[BLOCKER] `revert PR-4 + Bridge restart` 不能保证 single-executor，当前顺序会形成双执行者。**
   §5 会删除生产 `FLYWHEEL_QUOTA_DAEMON_CUTOVER=1`（plan `:169`），而 §3.4b 的 rollback 只写 revert + restart（`:158`），没有停止仍由 launchd 运行的 quota daemon。revert 后的现有 `resolveQuotaDaemonBridgeMode(poolConfigured, {})` 会返回 `attachAccountSwitch=true`、`runAccountSwitchWatchdog=true`、route 未退役（`quota-daemon-cutover.ts:35-41`）；Bridge 重启后旧 executor 会与 daemon 同时活跃。
   **建议：**把 rollback 写成有序、可验证的 single-executor 事务。若只是回滚代码而继续用 daemon，应先在 reverted code 下恢复 `CUTOVER=1` 再重启 Bridge；若要恢复 legacy executor，则必须按受控顺序 quiesce/bootout daemon，再启用 legacy Bridge，并验证 daemon PID/job 不在、Bridge mode 正确。这里可以继续禁止“env-only rollback”，但不能禁止 reverted code 为保持单执行者所需的 env 配置。

3. **[HIGH] “route consumer chain 全闭合”仍只列了 flag 谓词链，没有列完静态 410 后唯一服务旧 route 的 holder 链。**
   plan `:139-140` 删除的是 `quotaDaemonCutover` option、`cutoverEnabled` dep 和旧 route body；当前源码还另有 `AccountSwitchRouteDeps.getRuntime` / `AccountSwitchRuntime`（`account-switch-route.ts:69-112`），以及 `BridgeAppOptions.accountSwitchRoute`、`accountSwitchRouteHolder`、`:5920` 传入、`:9845` runtime 绑定、`:10059` success hook（`plugin.ts`）。静态 410 后这些全部只服务已删除的 legacy route，但不会由类型检查自动消失，实施者仍可合法留下 dormant machinery，正是 Round 1 要消除的二义性。
   **建议：**在 4a 加一行逐项删除上述 route-only type/dep/holder/pass/bind/hook，并同步收敛 route tests 与注释；共享给 watchdog 的 `accountSwitchRepair` / `postSwitchResult` 可按既定 lane 边界保留。

4. **[HIGH] PR-4 漏了仍被指定为当前权威的 quota recovery runbook。**
   `engineering/doc/FLY-1182-quota-switch-ignition/qa-report.md:7-10` 明确让当前 GO 判断使用 `recovery-runbook.md`；该 runbook `:31-34` 仍说“生产已设置 `FLYWHEEL_QUOTA_DAEMON_CUTOVER=1`”，`:147-154` 也把 route 退役表述成该 env 条件下的状态。flag 墓碑并清理生产 env 后，这份 operator runbook 会立即失真，不能归入普通历史 issue 文档。
   **建议：**将该 recovery runbook 纳入 PR-4 活文档：把条件式 CUTOVER 说明改成“FLY-1456 后永久退役、不得设置该变量、无 Bridge fallback”，并在 §6 的 live-docs 栏明确列出；其他确属历史证据的 FLY-1182/1256 文档继续不动。

5. **[HIGH] ledger 要求最后一个 PR 自己记录自己的 merge SHA，时间上不可满足。**
   §1e 要求每个 PR merge 后回填 `PR# + merge_sha`（plan `:50`），但 §5 又要求“台账终版随最后一个 PR”（`:170`）。PR-4 分支内容无法预知 PR-4 的最终 merge SHA；同理，“第一个 PR 之前生成并提交”（`:45`）也需要说明究竟是独立 preflight PR，还是 PR-1 的首个 commit。
   **建议：**明确文档生命周期：初始 62-row ledger 是 PR-1 的首个 commit（或单独 PR-0）；PR-2/3/4 各自回填此前已 merge 的 PR；PR-4 自身 merge SHA 与“全部落地”里程碑由明确的 post-merge docs closure PR/commit 回填。若硬约束只有四个 PR，则最后一行必须允许暂记 `pending`，并指定 merge 后由谁、在哪个可审计载体完成最终回填。

## Verdict

CHANGES REQUESTED — address items above

---

# Design Review — FLY-1456 plan.md (Round 3)

Date: 2026-07-24
Author: Codex
Status: APPROVED

## Summary

Round 3 已闭合 Round 2 的全部五项问题：PR-4 的源码 residue 合同自洽、rollback 维持 single-executor、静态 410 的 route-only holder 链完整收敛、当前 quota recovery runbook 纳入活文档、PR-5 也解决了最终 merge SHA 的时间悖论。方案与当前源码、FLY-1240–1243 的 registry/truth/drift 模式及 RESERVED 红线一致，可以交给 implement node 执行。

## What's Good (Keep)

- pinned `67b35748` snapshot 与计划名单复核为 62/62 个唯一 flag：40 个 default-only、13 个删除、1 个固化、5 个 keep、1 个 frozen、2 个 RESERVED，无漏项或额外项。
- PR-4 删除 setup 脚本内 CUTOVER 的两处写/删引用后，脚本源码零引用与 residue gate 完全一致；生产 `.env` 清理由独立 ops 步骤和 check-flag-truth 负责，责任边界清楚。
- rollback 明确分为 daemon 继续权威和 legacy Bridge 恢复两条事务，并把 env、restart、daemon quiescence 与 exactly-one-executor 验证按顺序钉死，消除了双执行者风险。
- 静态 410 不只删除 flag 谓词，还明确删除 `getRuntime`、`AccountSwitchRuntime`、Bridge option、holder、runtime binding 和 success hook；共享 watchdog machinery 保留，符合局部死代码删除边界。
- PR-4 同步当前权威的 FLY-1182 recovery runbook，并将活文档与历史证据分栏审计，既防止运维误导，也不篡改历史材料。
- PR-1 首 commit 建初始 ledger、PR-2/3/4 回填已合入项、PR-5 做最终 docs closeout 的生命周期可执行且可审计。
- RESERVED 验收直接检查两个 runtime 文件和两个 registry spec；五个 PR 都保持 founder-gated、独立 review，控制面充分。

## Issues & Recommendations

1. **[NON-BLOCKING] PR-4 实现时顺手删除 setup 脚本失去全部调用者的局部 helper。**
   当前 `set_env_key` 只服务即将删除的 CUTOVER 两个调用点，`RESTART_BIN` 也只服务即将删除的两次 Bridge restart；两处调用收敛后应按 §4 死代码纪律一并删除，避免留下误导性的 dormant ops machinery。测试里的 fake restart 可以保留为“绝不调用”的负向哨兵。另将 §2 的 config-first TDD 统一步骤理解为 PR-1–PR-4；PR-5 是纯文档 closeout，只需执行适用的 residue/docs/ledger 验收。

## Verdict

APPROVED — ready to implement
