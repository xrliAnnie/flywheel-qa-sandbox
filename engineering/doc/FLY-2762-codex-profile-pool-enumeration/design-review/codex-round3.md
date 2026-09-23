# Design Review — plan.md (Round 3)

Date: 2026-09-22  
Author: Codex  
Status: CHANGES REQUESTED

## Summary

本轮只核验了 Round 2 的 6 个阻断项及这些修改直接引入的回归，并将结论绑定到 commit `6b24c59805d9eb41d9ebdda4e2e59e641938db42`。

第 1、2、3、5 项已经闭合：ready-slot `save` 现在按完整 account key fencing；CLI 的 `identityKey` parser 与正向用例一致；global/private 两个 shim 都传显式 snapshot；派生 identity label 的生成域与校验域也已统一。第 4 项的大部分和第 6 项的 package Vitest 门同样正确。

仍有 2 个会改变实现结果的窄缺口：removal-only capacity fact 没有规定用 surviving members 子集重放，时间越过已删除成员的 reset 后仍可能清掉 guard；§3.5 声称列全 fixture，但遗漏 5 个 CI 实际执行的 v1 registry shell suites，而且 residue `rg` 匹配不到这些 fixture。故本轮仍不能批准。

Round 2 disposition 核验：

| R2 项 | 结论 |
|---|---|
| 1. `save` account identity / lease | 已解决 |
| 2. CLI `identityKey` parser | 已解决 |
| 3. private/global `--snapshot` | 已解决 |
| 4. identity-bound capacity evidence | 部分解决：新成员、同名换号、异常 fail-closed、立即重探已闭合；removal-only 的子集重放未闭合 |
| 5. derived identity label 上限 | 已解决 |
| 6. 测试/fixture 验证闭环 | 部分解决：package Vitest 已闭合；CI shell fixtures 与 residue gate 未闭合 |

## What's Good (Keep)

- `save` 先读 home 与 slot、要求 `codexInstallAccountKey` 全等，在单一 account lease 与 home install lock 内重读双方再写；这与现有 key 的 `profile + accountId/email` 语义一致，并覆盖了“同 email、不同 accountId”的原反例。
- CLI parser 现在只取 `name/identityKey/authHealth/note/planType/fiveH/weekly/observedAt`，ready row 要求 64 位小写 hex；同 key 正向显示与缺失、错形、mismatch 降级均有测试合同，非 PII 边界没有回退。
- global shim 固定 `$HOME/.flywheel/...`，private launcher 从 `FLYWHEEL_STATE_DIR` 推导 snapshot，且通过 `PROFILE_BIN` 验证 refresh 前后使用同一路径；两个真实入口已对齐。
- v2 capacity evidence 绑定排序后的 `{profile, accountKey}`，因此新目录和同名换号都能识别为新成员；coordinator 明确绕过旧 `next_attempt_at` 立即 observe，provider 缺失、抛错或非法时保持旧 guard，方向正确。
- identity label 的 80 字符安全域与超长派生名的截断/hash 生成器共享合同；长 local-part 的 `account-* -> shopping` 全链测试覆盖了原失败边界。
- §3.5 已认识到 claude-runner typecheck 排除测试，补了两个真实 package Vitest 命令及 non-zero test-count 检查；选中的两个 package 不会收集 core 的 `tmux-viewer.macos.test.ts`。
- Round 2 advisory 均已纳入：`recover()` 使用一次 pool getter、登录提示使用实际 profiles root 并 shell-safe 展示、`identityKey` 严格 hex 校验。

## Issues & Recommendations

1. **Issue: removal-only capacity fact 仍未锁定 surviving-members 子集重放。**

   **Why:** plan.md:176-183 已正确按 `{profile, accountKey}` 比较成员，但对删号只写“旧事实仍然有效”；没有规定重放时同时把 stored pool 与 observations 过滤到仍在 current pool 的成员。当前 store 将整份旧 observations 交给 selector（`packages/teamlead/src/bridge/codex-quota-store.ts:1464-1485`），selector 又要求每个 stored member 的 reset 仍在未来（`candidate-selector.ts:91-101,130-147`）。反例：A/B 都打满，A 在 `t+10s` reset、B 在 `t+50s` reset；`t+5s` 删除 A，`t+15s` 重放旧全池时 A 的 past reset 会令结果不再是 `pool_exhausted`，虽然 surviving member B 仍被旧证据证明打满。现有“删除成员不解锁”测试文字（plan.md:202-203）若不跨过 A 的 reset，无法杀死这个实现；guard 变 false 还会影响 `canRecordManualDisposition` 等安全判定。

   **Fix:** 在规范中明确：v2 与 legacy fact 遇到 removal-only 时，将 stored members 和 observations 一起按 current `{profile, accountKey}` 取交集，再交给 selector；当前为空时也要定义 fail-closed 行为。把测试固定成上述时序：删除最早 reset 的成员，推进到它 reset 之后、剩余成员 reset 之前，断言 guard 仍为 true；再推进到 surviving member 的 reset 后才允许事实失效并重探。

2. **Issue: §3.5 仍未列全真实 fixture，且 residue 断言可以在旧 v1 registry 尚存时假绿。**

   **Why:** plan.md:256-268 列出的迁移对象遗漏了 5 个现存 shell suites：`scripts/__tests__/codex-home-link-truth.test.sh`、`codex-home-reconcile.test.sh`、`codex-home-launch-fence.test.sh`、`flywheel-lead.test.sh`、`package-onboard-smoke.test.sh`。它们都写入 v1 Codex registry，且没有建立新的 `profiles/<slot>/auth.json`；删除旧 loader、强制目录枚举后会失败。这些不是死 fixture：CI 在 `.github/workflows/ci.yml:550-553,732-733,961-968` 明确执行。§3.5 的两个 Vitest 命令不会运行它们，也没有明确运行已列出的 `codex-quota-client.test.mjs` / `codex-guard.test.sh`。此外 plan.md:268 的正则要求同一行出现带空格的 `"version": 1`，既漏掉上述 shell 的 compact JSON `"version":1`，也漏掉 TypeScript 的未加引号 `version: 1`；旧 loader 删除后，该命令可以错误返回零残留。

   **Fix:** 将上述 5 个 CI suites 加入迁移清单，为每个 fixture 建 v2 policy 与临时 `profiles/<slot>/auth.json`；在 §3.5 明列并执行它们的现有 CI 命令，同时显式运行已列出的 Node/shell tests。把 residue gate 改成 scoped、支持 multiline/quoted/unquoted/任意空白的检查，例如在限定的 Codex fixture 路径上同时查 `loadCodexAccountRegistry|CodexAccountRegistry`，并用 `rg -U -P` 匹配 `(?s)"?version"?\s*:\s*1.{0,600}?"?primary"?\s*:`。先在当前基线证明该 gate 能命中所有已知 v1 fixture，再在实现后要求为零。

## Advisory

- 给 `save` 再加一条锁等待期间 home 或 slot 身份发生变化、写前二次断言拒绝写入的并发测试，可直接锁住计划已经明确的正确语义。
- 在 `scripts/__tests__/codex-guard.test.sh` 断言生成的 global shim 命令确实包含 `--snapshot`；private launcher 已有 `PROFILE_BIN` 正向测试。
- 派生名兼容性依赖“当前没有需要截断的既有 derived identity”这一部署事实。按既有禁止读取真实凭据的边界，本轮未现场复核；建议将该前提作为部署前只读检查记录在 PR body。

## Verdict

**CHANGES REQUESTED**

下一轮无需重开其它设计，只需验证两个 delta：removal-only 的 surviving-members 时序重放，以及遗漏的 CI shell fixture + 能实际杀死 v1 残留的 gate。
