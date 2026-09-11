# Design Review — plan.md (Round 3)

Date: 2026-09-11
Author: Codex
Status: CHANGES REQUESTED

## Summary

v3 已实质关闭 Round 2 的四个 gate：M1 改用 StateStore 的共享 mailbox 终态谓词并保住 parked-alive，M3 将 discovery 收敛为只修不铸且覆盖 batch touch，M4a 也补齐了上一轮点名的大多数 executable edge。当前仍有 2 项 HIGH：restore 写失败后的空状态可覆盖原账本，以及 shell IR 对未引用 heredoc 展开和 `eval` 参数仍存在真实执行漏判；其余问题均可在实现期按现有架构有界修正。

## What's Good (Keep)

- M1 不再读取 CommDB `sessions.status`，而是把 `isMailboxTerminalStatus` 下沉为 CLI 与 queue 的共同谓词；这与当前 StateStore WAL 持久化方式（`packages/teamlead/src/StateStore.ts:3618-3628,3969-3981`）及 `awaiting_review` mailbox-live 合同（`:11614-11628`）一致，交叉真值表也覆盖了上一轮两个错位状态。
- discovery 已改成只剔除失效账本项、修复账本已有 polling slot，accepted mention 成为唯一 mint 事件；TTL 和显式 unsubscribe 因而不会再被 Discord membership 自动撤销。
- `onInputAccepted` 改用两条 intake 路径共有的 `JournalEntry` 投影，并明确覆盖 `submit accepted` 与 `submitBatch accepted_new`、排除 duplicate/conflict，符合当前 router 的双分支结构。
- M2 保留了完整 `SessionEvent` provenance、窄 `Pick<CommDB,...>` 依赖和 per-(recipient,sender) dead-letter fallback；这些 Round 1/2 修正没有回退。
- M4a 保留兼容 `scan_block`、结构化 Match、84+51 既有矩阵、12 个新增样例和 FLY-2456 零命中回归；两仓上线顺序与 `legacy_broad` 回滚边界仍然清楚且有界。

## Issues & Recommendations

1. **HIGH — restore 的 persist 失败分支会让后续 accepted mention 覆盖仍然有效的旧账本。** 计划规定普通变更必须 `persist → commit → source`，但 restore 写失败时却“以空 registry 启动，不重试写”（`engineering/doc/FLY-1942-comm-defense-trio/plan.md:208-211`）。具体窗口是：磁盘已有订阅 A/B → 规范化 snapshot 的首次写因瞬时 I/O 故障失败 → runtime 继续以空 registry 接流量 → 故障恢复后 accepted mention C 从空状态生成 snapshot 并 rename → A/B 被永久抹掉。现有“persist 失败时内存/source 不变”测试不会捕获这次后续 clobber。当前 runtime 已能把 `replyInThread.start()` 的异常向上传播并停止 gateway（`packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:1848-1855`），因此最小修复是：非 missing ledger 的 restore persist 失败必须让该 generation 启动失败并由 ownership 重试；或者保留 A/B 为不可丢的 pending base，并禁止任何 mutation 在它成功落盘前提交。新增故障序列测试：有效旧账本 → restore persist fail → 写能力恢复 → accepted mention，断言 runtime 未接流量或新 snapshot 仍包含旧条目。

2. **HIGH — 新 IR 仍把两种会执行的 shell payload 当成普通文本，会从当前“拦截”回退为“放行”。** 计划抽走 heredoc body 后，只在接收 head 是 shell/eval/executor 时递归整个 body（`plan.md:238-244`）；但未引用 delimiter 的 heredoc 会先做 command substitution，即使消费者是 `cat`，所以 `cat <<EOF\n$(pkill -f run-bridge)\nEOF` 会真实执行 kill。相反，新增 MUST_PASS 使用的是引用 delimiter，正需要 parser 保留 quoted/unquoted 区别。另一个缺口是 `eval 'launchctl kickstart -k gui/501/com.flywheel.bridge'`：`eval` 执行 argv，不消费 stdin，而计划只为它定义了 static-stdin 递归。当前 hook 的粗粒度 P1/P2 会拦下这两个反例（`scripts/hooks/flywheel-restart-guard.py:854-868`；本轮直接调用现有 `scan_block` 分别得到 P2/P1），所以这是 narrowing 引入的安全回归。建议在 heredoc IR 中保留 delimiter quoting：quoted body 仅在 shell/executor 消费时作为代码扫描，unquoted body 无论 consumer 都先扫描 `$()`/反引号等 expansion edge；同时把 `eval` 的参数拼成 executable payload 递归。为这两例各加 RED 测试后再跑完整矩阵。

3. **MEDIUM — restore 校验尚未把“显式 roundtable 域”作为持久化不变量，cap 的归属接口也不闭合。** `parseLedgerFile(path)` 只校验 parent 是 Discord ID，却不可能知道当前配置的 `parentChannelId`，同时它的签名没有 cap 参数却承诺做 over-cap trimming（`plan.md:197-200`）。因此一个 schema 合法但属于其他 parent 的 entry 可在 restore 时调用 `source.addChannel`，绕过 `subscribeImmediate` 的域守卫；cap 也会在 parser 与 `planRestore` 间形成双重或缺失实现。建议让 parser 只做无上下文 schema 校验，把 `entry.parentChannelId === configuredParentChannelId`、TTL、去重和 cap 统一放进 `registry.planRestore(snapshot, expectedParent)`；wrong-parent fail-closed drop + `restore_failed`。补 wrong-parent、duplicate-id、over-cap restore 测试。

4. **MEDIUM — `--state-store` 是一个公开的事实 override，与“无 override”规则相冲突。** 计划一方面声明终态判定无 override，另一方面增加 `--state-store <path>`，且不可读 snapshot 明确放行（`plan.md:82-89`）；调用者只要指向不存在的文件即可稳定绕过本地 terminal 拒收，虽然 queue 最终仍会 DEAD 并告警。这不会突破 queue 安全边界，但会重新制造本单要消除的 terminal dead-letter 噪音。测试无需新增公开 flag：可直接设置既有 `TEAMLEAD_DB_PATH`，或给 `sendDetailed`/`respond` 注入 `StateStoreSnapshotReader`。建议删除 CLI flag，保留依赖注入测试 seam；若坚持保留，至少把它标成 debug-only 并要求显式测试环境门，而不是写成一般 CLI 合同。

5. **MEDIUM — 新共享模块与 discovery 的编译接口还缺两个明确接线步骤。** teamlead 若按包名导入 `flywheel-comm/session-terminal`，当前 export map 没有该 subpath（`packages/flywheel-comm/package.json:8-52`）；计划需把 `./session-terminal` 加到 `exports`。此外 discovery 新逻辑调用 `source.isSubscribed(id)`（`plan.md:212`），具体 `RestPollDiscordInboundSource` 已有该方法（`packages/teamlead/src/lead-backends/codex/RestPollDiscordInboundSource.ts:300-302`），但其注入接口 `ChannelSubscriber` 目前只声明 add/remove（`packages/teamlead/src/lead-backends/codex/RoundtableThreadDiscovery.ts:33-36`）。把 export-map 与窄接口更新列入 C2/C5，并让 fake source/typecheck 覆盖即可。

6. **MEDIUM — `research.md` 仍与 v3 的两个核心接口合同冲突，尚不能称为 synced。** research 仍要求 `resolveRunnerRecipient(db, ...)` 并以 CommDB `sessions.status/ended_at` 判 terminal、无 session 行即 finalized terminal（`engineering/doc/FLY-1942-comm-defense-trio/research.md:15-17,22-30,60-65`），而 v3 plan 明确只读 StateStore 且 StateStore 无行放行（`plan.md:75-89`）。research 的 ledger JSON 还带顶层 `leadId/parentChannelId`（`research.md:88-95`），plan 的 `RegistrySnapshot` 则只有 `version/entries`（`plan.md:172-190`）。计划本身足够明确，且现有真值表测试能阻止 M1 实现回旧方案，所以此项不单独 gate；但在实现前必须同步 research 或写明这些段落被 v3 覆盖，避免两份“interface-level contract”互相矛盾。

7. **LOW — source side-effect 自愈文案应按实际配置收窄。** 计划称 source 失败会由“下一次 sweep/restart”重放 add（`plan.md:208`），但 sweep 只做 expiry；真正的运行期 repair 是配置了 guild discovery 时的 reconcile，未配置 discovery 时只能靠 restart。改为“下一次 discovery reconcile（若启用）或 restart”，并分别测试/审计即可，不需要扩大设计。

## Verdict

CHANGES REQUESTED — address items above
