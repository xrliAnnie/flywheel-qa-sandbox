# Design Review — plan.md (Round 5)

Date: 2026-09-06
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 5 已关闭 Round 4 的六个架构与生命周期 blocker：stateful/single-flight health probe、Bridge 存活的 owned-pause migration、pause 后二次 legacy gate、纯 Lead authority、write-ahead sweep receipt 和 canonical path 校验现在都具备可实现合同；四条 Eng Lead directive 也已进入假设、runbook、验收与证据段。最终源码核对仍发现两个会让生产路径直接失败的合同错误，以及 forced-refresh 与逐 home approval 的两个交付缺口，因此尚不能批准实施。

## What's Good (Keep)

- 保留只实例化一次的 `credentialProbe`，让 boot 与 tick 复用同一引用，并用 single-flight 避免重叠调用重复计数；composition 测试覆盖 warning→severe、healthy reset 和引用同一性，足以锁住 debounce 生命周期。
- 保留 keyed migration 全程不停止 Bridge 的简化：owned pause、`quiescent === true`、空 lease 集合和 admission 同一把 `withMkdirLock` 已构成完整 fence，并允许续租与 resume API 始终可用。
- 保留 pause 后再次执行完整 legacy authority scan，并枚举所有有效 marker/pending keyed homes；这正确关闭了 forecast 与 mutation gate 之间的 admission/reown 窗口。
- 保留 `resident-codex-lead-recover.sh --authority` 与 `--probe` 的分层：projects/manifest/plist/wrapper 决定 home/label，进程证明只属于 patrol；停机时仍能诊断 credential drift。
- 保留 sweep 的 intent → reverify → unlink → parent fsync → applied 协议、启动对账和 partial-progress 汇总；managed homes 与 deletion targets 的隔离仍然清晰。
- 保留 canonical absolute truth path、realpath 后的 segment-safe containment、`lstat + O_NOFOLLOW + fstat`、0600 和原子 symlink rename 组合。
- 保留 business 作为唯一 truth、Lead/companion 逐 home 批准、配额集中后果原文、独立的 9/12 风险段，以及可追溯的 N=6 实验报告/脚本/ledger 路径。

## Issues & Recommendations

1. **[HIGH] 三个 `set -u` launcher 的计划示例引用了不存在的 `FLYWHEEL_PROJECT`，真实启动会在调用迁移脚本前直接退出。** `canonical_lead_identity_resolve` 当前只导出 `FLYWHEEL_PROJECT_NAME`（以及 `PROJECT_NAME`）和 `FLYWHEEL_LEAD_ID`；仓内生产 launcher 也只消费 `FLYWHEEL_PROJECT_NAME`。计划第 119 行却调用 `--lead "$FLYWHEEL_PROJECT/$FLYWHEEL_LEAD_ID"`，且全仓没有其他生产定义，因而会触发 unbound variable。改为 `"$FLYWHEEL_PROJECT_NAME/$FLYWHEEL_LEAD_ID"`，并让 launcher shape test 在清空 `FLYWHEEL_PROJECT` 的环境里真正执行到 fake link-truth、断言收到三个准确 tuple，而不只 grep 文本。同步修正 CLI 合同：当前 synopsis 仍是 `<home> [--unlink] [--keep-backup]`，示例却把 `--lead` 放在 home 前；应定义并测试唯一参数顺序/解析规则。退出码表也必须加入已经使用的 `6 = uncertain`，让 launcher、cutover driver 和 Raya handoff 都能一致处理。

2. **[HIGH] 新增的 `link-missing` 告警目前没有可执行的 relink 写路径。** health 将家内 `auth.json` 缺失（例如 `codex logout` 删除 symlink）分类为 `link-missing`，remediation 要求停进程后运行 `codex-home-link-truth.sh`；但 WS-B 的 keyed helper 锁内目标重验只允许“普通文件/错链”，测试也没有 destination-missing 用例。按该合同，operator 完成 drain 后仍可能被 helper 拒绝，Lead launcher 也会持续因 launchd running 退出 3。请把 missing 明确加入 `migrateCodexAgentHomeCredential` 和 `migrateCodexHomeCredential` 的写入决策：通过同一 process/launchd/lease fence 后，以 temp symlink + rename/create 恢复；keyed 路径仍须在锁内最终重验。增加 keyed/Lead/legacy 的 missing destination 测试，以及 active lease/running job 下仍拒绝的负例。并在 severity 表中显式把 `link-missing` 列为 severe；当前 reason/remediation 有它，但 severe 集合漏列。

3. **[HIGH] 9/12 的 forced-refresh fallback 仍不是一个可安全执行、可测试的交付物。** §4.2 要求在生产 truth 中改写 access-token JWT 的 `exp`，但没有指定实现脚本、原子/原地写细节、失败后的 truth 状态或 token-redaction 测试；§4A 引用的 `exp-evidence/run-wave.sh` 只对已经准备好的六个 home 启动 Codex 并记录 hash/stat，它既不修改 `exp`，也不创建/清理隔离 home，因此不能直接充当该 runbook 步骤。手工编辑完整 `auth.json` 还与“不打印 token”的边界冲突，并可能在刷新失败时留下签名已被改写的 access token。建议二选一：首选只保留 founder `codex login` 为受支持的生产动作；若 Eng Lead 要求必须保留无人值守 fallback，则把一个专用、默认 dry-run/显式 `--apply` 的 force-refresh helper 列入 WS-B，复用 truth 的 O_NOFOLLOW/0600/business-identity 校验，在内存中只改 exp、原地写且不输出 token，创建并清理 0700 隔离 home，最后验证 account 不变、`last_refresh` 前进、exp gate、inode/mode/JSON，并定义任何失败后的 fail-loud 恢复状态。用假 JWT/假 Codex 做成功、刷新失败、进程中断和零 token 输出测试；不能把实验 driver 当作生产 mutation 工具。

4. **[MEDIUM] Lead 的逐 home 授权范围仍与 A6、launcher 接线和验收表不完全一致。** A6 声称覆盖“三个生产 Lead home + Raya home”，WS-B 也修改三个生产形态 launcher；第三个仓内 Raya launcher 实际推导 `~/.codex-raya`，而 §4.3 清单只列 Mufasa、infra-bot 和另一个跨仓 authority `~/.flywheel/raya/codex-home`。exploration 已说明 `~/.codex-raya` 当前不存在，但它不能因此与跨仓 Raya home 合并为同一清单项。请明确选择：若仓内 Raya launcher 只是 dormant/future-safe，则在 A6/§4.3 写明它当前不属于 active managed set、首次启用前仍需独立 Lead 批准；若属于范围，则增加单独的 `.codex-raya` 批准、迁移、health 与验收行。与此同时，把 §5 的“Lead 部分全绿”限定为“已批准 homes”，并为未批准项记录预期 `copy-pending`/deadline disposition；否则“本单只切已批项”和“mufasa、infra-bot 全绿”无法同时验收。全局 `FLYWHEEL_CODEX_LINK_DEADLINE` 的后移也不应被表述成永久的单-home waiver，因为它会同时放宽所有 copy-pending homes。

## Verdict

CHANGES REQUESTED — address items above
