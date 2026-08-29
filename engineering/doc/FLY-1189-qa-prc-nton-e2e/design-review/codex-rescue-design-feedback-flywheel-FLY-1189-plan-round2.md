# Design Review — FLY-1189 plan.md (Round 2)

Date: 2026-07-11
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 2 已实质吸收 Round 1 的方向：ACK 枚举、S4 page/no-page 时间线、H5c targetKey 结论、跨 phase 证据保存与 attribution-based E5 都明显更准确。但当前仍有几个按现有 529 代码无法执行的硬点：Phase D 没有真正的 pre-boot config 写入窗口，S7 选了永远不会进入 CLEARING 的 ESCALATED target，borrowed-slot lock 会在 5 分钟后被当成 stale，fault-inject 子命令也无法独自持有跨场景 trap。修正以下项目后，整体方案可接近可实施状态。

## What's Good (Keep)

- 保留 S4a/S4b 的拆分：同一 episode 不再同时承担“已 page”和“ACK 后不得 page”两个互斥判据。
- S6 已对齐真实 route：`ack → ACKED`、`resolve → RESOLVED`，并保留 401/403/200 的 auth 三联验证；fingerprint 从持久行读回而非猜格式。
- H5c 已从伪 blocker 改为源码已定事实 + PR-C runtime preflight；真实 Linear labels、`sessions.issue_labels`、owner route 与 chat-thread binding 的组合是正确剩余边界。
- 四个 fresh-deploy phase 和 SLOT_DIR 外的 campaign evidence root 修复了 teardown 删除 DB/runner/证据的问题；S9 也已移动到首次 teardown 前。
- S7 不再用 DB 篡改伪造 TTL E2E，并诚实记录“cleanup-started-but-not-terminal”缺少真实入口；把不可达 TTL rebound 降为单测 spot-check 是合理范围收缩。
- 三锚之外加入 PID start-time/inode、动作 journal、exactly-one descendant、component-boundary 与中断恢复，方向上足以把误伤生产的风险从“约定”推进到可测试机制。
- S11 从活跃生产机的集合绝对相等改为 taint attribution，避免把正常生产 churn 当成 QA 污染。

## Issues & Recommendations

1. **Phase D 的“部署前写 canonical config”在当前 `test-deploy.sh` 中没有可用时点。** Phase C teardown 会删除整个 `${SLOT_DIR}`（`scripts/test-teardown.sh:427-441`）；下一次 `test-deploy` 又会先 `rm -rf`/clone host repo（`scripts/test-deploy.sh:601-607`），随后无条件重写 `.flywheel/config.yaml`（`:626-678`），并在同一次不可暂停的调用中启动 Bridge（`:1058-1123`）。所以 plan `:154-156` 所说的“部署前写 projectRoot config”要么写不到尚不存在的 repo，要么会被 deploy 覆盖；Phase D 实际仍会使用全局 30min。**建议：**接受一个最小、受测的 pre-boot seam：给 `test-deploy.sh` 增加如 `--detection-lead-grace-ms 120000`（或专用 `TEST_DETECTION_LEAD_GRACE_MS`），在脚本生成 canonical YAML 时追加 `detection.lead_grace_ms`；缺省时生成内容必须逐字不变。H1 hermetic 测试同时断言缺省 config byte-identical、合法正整数准确落 YAML、非法值 fail-fast。Phase D 明确通过该 seam 部署，launch manifest 记录 effective project override。

2. **S7 仍选错 target：B1 在 S4a 后已经 ESCALATED，close-runner 不会把它改成 CLEARING。** S4a 要求 B1 无 ACK 并成功 page（`plan.md:140`），因此 B1 行最终是 ESCALATED；但 `markDetectionEscalationsClearingForTarget` 明确只更新 `NEW | LEAD_NOTIFIED | ACKED`，刻意排除 ESCALATED 防止已 page episode rebound 后再 page（`StateStore.ts:6485-6507`）。S7 的“对 B1 close-runner → 行短暂 CLEARING”（`plan.md:143`）实际第一步就不成立。**建议：**为 S7 建一个专用 target E1：先触发 episode 并在 grace 前 `disposition:"ack"` 得到 ACKED，再对仍 running/awaiting 的 E1 调真实 `/close-runner`，body 明确带 `done:true` + 正确 owner leadId，使同一个 HTTP 调用先 transition completed、再成功 kill、再把 ACKED 行标 CLEARING（`close-runner.ts:146-250`, `:373-416`）；最终再断言下一次 reconcile RESOLVED。由于 CLEARING 可能在 route 返回后立刻被并发 reconcile 收口，不要把“轮询必须看到中间行”做成易抖硬门；用同步 bridge.log `detection episode(s) marked CLEARING` + close response success 证明中间 transition，再以最终 DB RESOLVED 证明收口。

3. **强制恢复 trap 的所有者没有定义，按当前子命令接口会立即恢复或根本不恢复。** H2 定义的是一次性 `fault-inject.sh freeze <execId>`/`break-worktree` 子命令（`plan.md:78`），但 `EXIT` trap 属于启动它的 shell 进程：若 injector 自己注册 trap，它发完 SIGSTOP 后正常退出就会立刻 SIGCONT，场景无法保持故障；若期待 trap 留给 parent driver，子进程 trap 又不会传播。H4 的“kill -INT driver”其实隐含 driver 才是生命周期 owner。**建议：**把合同写死为：driver 在任何 mutation 前注册自己的 `EXIT INT TERM` trap，并持续存活到场景恢复；injector 只提供原子、journaled、幂等的 `freeze/thaw/break/restore/recover-from-journal` 操作。driver trap 调 `recover-from-journal`，恢复成功前不得 teardown。测试要 kill 真正的 driver process，验证 child injector 已退出后仍能由 parent trap SIGCONT + restore；同时测试正常场景结束显式恢复后，EXIT trap 二次运行是 no-op。

4. **worktree 的安全根合同自相矛盾。** §A 要求“目标 cwd 与待移 worktree 都必须落在 slot sandbox 前缀”（`plan.md:38-40`），但 H2 又把 worktree 移到 SLOT_DIR 外的 campaign root（`:78`）。rename 后 inode/cwd 的 canonical path 会位于 campaign root，按三锚原文 `restore-worktree` 必须拒绝；而 `--campaign-root` 是 caller 输入，若不约束还可指向 symlink/生产路径。**建议：**最简单是把 quarantine 改回 `${SLOT_DIR}/qa-moved-worktrees/<execId>`，campaign root 只存证据，恢复必须发生在 teardown 前；这与路径锚完全一致。若确实需要 SLOT_DIR 外 quarantine，则必须单独定义并验证第二安全根：只能是 canonical `/private/tmp/qa-fly-1189-campaign-<validated-id>/qa-moved-worktrees/`，拒 symlink、拒 group/world-writable ownership 异常，并在 journal 中绑定 source root、destination root、inode；restore 允许“source=validated quarantine、destination=exact journaled slot path”这一种方向，其他组合全拒。

5. **extra slot lock 若继续保留 `claiming`，5 分钟后会被现有逻辑主动回收。** 当前 `claim_slot` 把新锁写成 `claiming`，超过 300 秒就判 stale 并调用 teardown（`scripts/test-deploy.sh:71-114`）；现代码只在 Bridge 起后把主 slot lock 的 PID 改为长存 Bridge PID（`:1124-1128`）。Round 2 虽要求原子 claim 全 slot（`plan.md:61-65`），但没有要求 finalize 每个 borrowed lock；3.5h campaign 中 slot 3 仍可能在第 5 分钟后被另一 deploy 回收。**建议：**Bridge PID 获得后，把同一存活 PID 写入主 + 每个 borrowed lock 的 `pid`，并写 `ownerSlot/campaignId/borrowed=true` sidecar；任一 finalize 失败则回滚整个 deploy。`test-teardown.sh 3` 遇到 borrowed lock 应 fail-loud 指向 owner slot（或按 owner manifest 做完整 teardown），不能只删 slot3 lock。hermetic 测试模拟 lock age >300s，证明 campaign Bridge 存活时第二 deploy 仍无法 reclaim。

6. **两个场景/证据合同仍可能产生不确定 verdict。** 第一，S1b 的合法分支 (ii) `detection_suspicious` 只写 `session_events + lead_events`，不会创建 `detection_escalations` 行（`detection-suspicious.ts:169-221`）；因此 S9 无条件要求 A2 的“对应 episode 自动 RESOLVED”（`plan.md:137`, `:144`）在该分支必然失败。第二，S6 的 resolve 腿仍只写“另一独立 episode”，没有 ID、trigger、owner、kind 或执行时点，driver 无法确定创建哪个 episode且如何避免它先 page。**建议：**S9 改成 branch-aware：A1 必须 auto-RESOLVE；A2 仅当 S1b 走 unified c 分支才断言 detection row RESOLVED，走 suspicious 分支则断言进程恢复、原 suspicious event 不重发且不存在需 RESOLVE 的 detection row。给 resolve 腿命名 C2'，写清 trigger/kind/owner，读回 fingerprint 后在 grace 前 resolve，并将它纳入 founder-page 总量与 no-cross 断言。

7. **`grep` 不能作为 production SQLite taint 的硬判据。** `teamlead.db` 与 CommDB 都使用 WAL（`packages/teamlead/src/StateStore.ts:795-845`; `packages/flywheel-comm/src/db.ts:96-120`）；活跃提交可能只在 `-wal` frames，二进制页编码/分片也不保证普通 grep 能找到完整 campaign/test string。这样 S11 `生产 DB ... grep 零命中`（`plan.md:98`, `:160`）会给出假绿。**建议：**queue/deadletter JSON 可继续文本扫描；SQLite 必须通过 readonly `sqlite3`/better-sqlite3 查询明确的 text columns，并让连接读取 WAL：production StateStore 至少查 sessions/session_events/lead_events/chat-thread 相关表，CommDB 至少查 sessions/messages/questions/declared-state 相关表，按 campaign id、test project、test execIds、marker 参数化匹配。缺表可按已知 schema 跳过，DB 打不开/查询异常则 E5 fail-closed。另把 action journal 的全量 invariant 设为硬门：每个 acted PID 的 canonical cwd 均在 slot/quarantine 安全根且没有任何 production PID；这才覆盖“误发 SIGSTOP 但没有写 production DB”的伤害面。

## Verdict

CHANGES REQUESTED — address items above
