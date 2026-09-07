# Design Review — plan.md (Round 3)

Date: 2026-09-06
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 3 已实质解决 Round 2 的大部分安全问题：provision 不再隐式迁移，keyed migration 与 admission 使用同一把锁，幂等检查前置，备份顺序、权威 home 清单和 sweep 的 mutation-time revalidation 也明显更扎实。当前仍有三组会阻断实现或使运维合同失效的高优先级问题：admission pause 的真实 API/租约生命周期没有进入 runbook，sweep 使用了错误的鉴权与不足的静默性证明，且计划依赖的 Lead `codexHome` authority 在现有 roster API 中不存在。

## What's Good (Keep)

- 保留“只有缺失的 `auth.json` 才由 provision 建链接；普通文件仅写 pending marker；错误或悬空链接零写拒绝”的边界。这消除了出生路径隐式迁移活体 home 的风险。
- 保留 keyed helper 与 admission 共用 `agents/<project>/.locks/<role>` 锁，并在锁内复核 marker、lease 和目标的设计；这是正确的 admit/migrate 串行化边界。
- 保留正确链接的只读幂等判断先于 drain/launchd 检查，以及“首次迁移必须在 bootout 窗口”的合同。
- 保留 truth 的 `lstat + O_NOFOLLOW + fstat` 校验、legacy 目录 symlink guard、`home === truth home` 拒绝、临时链接加 rename，以及相应 fault-injection 测试。
- 保留 `--keep-backup` 先以 `O_EXCL` 创建并同步备份、原文件仍留在位、备份成功后才替换的顺序；默认不留凭据备份和七天清理边界也合理。
- 保留 health 分类拆分、严重度优先级、unparseable 两 tick debounce、按 reason 共用 remediation，以及 fallback 对 benign refresh race 使用相同 truth-health 判定。
- 保留 Raya 作为阻塞性跨仓依赖、managed active homes 与历史 inventory 的范围区分，以及切换前清空/逐项处置 active legacy execution 的 gate。

## Issues & Recommendations

1. **[HIGH] runbook 尚未实现 admission pause API 的真实租约合同，正常切换、延迟 sweep 和回滚都可能直接失败。** 当前 `POST /api/admission/pause` 必须携带 `durationSeconds`（1–3600），并返回后续 `/api/admission/resume` 必须提交的 `leaseId`；计划只写了 POST pause/resume，没有请求体、lease 保存、续租或剩余 TTL 校验。等待所有 keyed execution 终态可能超过一小时；而 runbook 第 1 步已经 resume，第 5 步一周后直接执行 `sweep --apply`，又与 sweep 要求“pause 已 active 且脚本不自行获取”的前置条件矛盾。回滚仍是先停 Bridge 再 `--unlink`，但 durable `.flywheel-leases` 不会因进程停止自动消失，helper 会按新合同拒绝。建议把切换、sweep、回滚统一写成一个 owned-pause protocol：以 master token 创建 pause、持久保存 `leaseId`、在等待期间按该 lease 续租并校验 TTL，等待 quiescence 和 lease 归零后执行变更，最后用同一 `leaseId` resume；一周后的 sweep 必须重新获取独立 pause。增加无 body、错误 lease、TTL 续租、超时、回滚仍有 lease 的 runbook/fixture 测试。

2. **[HIGH] sweep 的 fence 既没有证明系统真正 quiescent，也使用了错误的 Bearer token，且“任一后续失败都零写”无法由逐 home mutation 保证。** 现有 Bridge 已提供 `/api/admission/quiescence`，在 active pause 下检查 readopt candidates、dispatcher inflight、durable launch claims 和 admission crossing；仅检查 pause active 与 `/health` uptime ≥ 300s 不能排除设置 pause 时已经跨过 admission 的工作。计划指定的 `FLYWHEEL_INGEST_TOKEN` 也不是这些 master API 的凭据：`/api/admission/*` 由 `TEAMLEAD_API_TOKEN` 对应的 `config.apiToken` 保护。并且逐项 unlink 后若 pause 到期、Bridge 查询失败或后续 authority 漂移，脚本已经不可能满足“non-zero 且 zero writes”；逐 home 复核清单还漏掉初始判定使用的 Bridge `/api/sessions` authority。建议要求调用 `/api/admission/quiescence` 且 `quiescent === true`，使用 `TEAMLEAD_API_TOKEN`，由调用方传入并由脚本验证/续租预期 `leaseId`；每次写前复核完整同一组 authorities。将失败语义改为：首次 mutation 前的 fence 失败保证零写；首次 mutation 后用 durable per-home receipt 报告 partial progress，或在整个有限操作期间持有可证明不会过期的 owned lease。

3. **[HIGH] 计划引用的 Lead home authority 在当前 `findResidentCodexLeadTargets(projects)` 返回值中不存在，且 health 的现有调用点拿不到 `projects`。** `ResidentCodexLeadTarget` 当前只有 `projectName`、`projectRoot`、`leadId`、`leadKey`，没有计划所称的 `codexHome`；Mufasa/infra-bot 的 home key 也不能从其 agent id 无歧义推导。另一方面，`plugin.ts` 目前只调用 `reportCodexGlobalHealth(metaAlertNotifier)`，计划又声明该调用不改，因此默认 probe 无从以已验证的 project roster 构造 Lead home 清单。建议选择并写死一个真实 authority：优先给 validated resident target/config 增加显式 `codexHomeKey`/`codexHome`，或复用 patrol 已加载的 resident manifest；再由 `plugin.ts` 用已经验证的 `projects` 构造并注入 credential probe（或显式传入 projects）。同时让 bash launchd guard 与 health 使用同一 mapping，并补 Mufasa、infra-bot、未知 home、重复 home 的测试；不能继续声称 `plugin.ts` 调用点不变。

4. **[MEDIUM] 新 Node helper 依赖的 keyed-home 内部常量/函数没有可导入的公开 API，且并发测试的预期自相矛盾。** `CODEX_AGENT_HOME_LEASES`、`CODEX_AGENT_HOME_LOCKS`、marker reader 和 lease lister 当前都在 `codex-home.ts` 内私有；一个独立 `.mjs` 不能可靠地“读取 TS 常量”而不复制实现或新增导出。计划同时写“admit 与 migrate 恰好一个成功”，又写 migrate 先拿锁时，迁移成功且后续 admit 看到正确链接也成功；后者显然是两个操作都成功。建议在 `codex-home.ts` 导出一个类型化的 `migrateCodexAgentHomeCredential`，由它封装 path、marker、lock、lease 和重验证，CLI 只作薄包装，并补 `src/index.ts`/构建产物接线。并发测试改为验证两个可串行化结果：admit 先行时 migrate 因 lease 拒绝；migrate 先行时 migrate 与随后 admit 均成功；共同断言不存在无锁迁移或活 lease 下替换。

5. **[MEDIUM] historical inventory 的声明仍未落实到 WS-E 的扫描合同。** health 章节说 `~/.codex-*` 只进入 WS-E inventory，A6 又包含 profile pool 和旧 execution homes；但 WS-E 明确只处理 legacy execution homes 与备份目录，并声明不碰 profile pool/Lead/Raya，没有定义对历史 `~/.codex-*` 或 profile pool 的只读盘点。建议明确拆分 `inventoryRoots` 与 `deletionTargets`：inventory 可覆盖 legacy、历史 dot-codex、profile pool 和隔离备份且只记录路径/chain fingerprint；删除目标仍严格限于已证明 inactive 的 legacy `auth.json` 和过期备份。补测试证明 Lead/profile/Raya 即使被盘点也绝不删除。

6. **[MEDIUM] `--keep-backup` 的“先 durable 再替换”合同还缺目录元数据同步。** 对备份文件本身 `fsync` 后，如果未同步新文件所在的 0700 目录，掉电后目录项仍可能丢失，而原 `auth.json` 已被 rename 成链接。建议在 backup close 后、替换原文件前 `fsync` backup parent directory；链接 rename 后也同步 home directory，并把目录 fsync 失败纳入 fault-injection/partial-progress 语义。

## Verdict

CHANGES REQUESTED — address items above
