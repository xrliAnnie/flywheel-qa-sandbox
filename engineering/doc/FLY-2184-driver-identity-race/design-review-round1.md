# Design Review — plan.md (Round 1)

Date: 2026-08-31
Author: Codex
Status: CHANGES REQUESTED

## Summary

身份修复主线可行且方向正确：复用 `lead-identity resolve --format env`、统一 slot-local summary home、pin lease DB，能够在不改 validator 的前提下消除 FLY-2030 类镜像漂移。当前计划仍有 PR poll 调用方语义冲突、首次空观察处理缺口，以及真 validator 反向探针实际无法到达 validator 等阻塞，因此尚不能直接实施。

## What's Good (Keep)

- 保持 `lead-lease.ts`、`lead-identity.ts` 和 CLI 行为不变，修复严格落在 driver/stub/room handoff 一侧，符合 owner scope。
- 用现有 `identityEnvProjection` 的 CLI 输出替代 driver 手写投影，且 overlay 顺序确保 ambient/overrides 压不过 canonical identity 与 slot 坐标；这是对根因的结构性删除，而不是再补一份镜像。
- `FLYWHEEL_SUMMARY_CONFIG_HOME` 在 resolve 与写时再解析两侧统一，和 `canonicalIdentityHomeDir` 的真实行为一致；`FLYWHEEL_LEAD_LEASE_DB` pin 也能阻止 deny audit 落入生产库。
- required-key fail-closed 守卫明确区分三个合法空值键，且 dist 缺失不 skip，符合边界校验与“两态一痕”要求。
- 保留 exact-head authority 比较、用有界等待吸收 eventual consistency，并把真机验收归 QA 节点而非 implement 自证，整体风险边界合理。

## Issues & Recommendations

1. **共享 poll 的失败契约无法同时满足 stub 与 driver，且会改变现有 A3 出口。** 计划 C4 先规定 `pollRemotePrAuthority` 遇到 classifier `fatal` 或重试耗尽都抛错（plan.md:113-119），随后又要求 driver 使用同一函数时“超时不抛，取最后一次观察”交给 `validateQaShipPreconditions`（plan.md:126-129）。真实 driver 目前把 `remotePrFromStub` 的结果送入 preflight，并在 head mismatch、draft、closed/missing 等情况下统一落 A3 diagnosis exit 20（`qa-529-generalized-e2e.mjs:1100-1171`）；共享 helper 若在 draft 或耗尽时先抛，会绕过该合同。**建议：**让 poll 返回判别联合类型，例如 `{kind:"converged", pr}`、`{kind:"fatal", observation, reason}`、`{kind:"exhausted", observation, reason}`，不在共享层替调用方决定进程语义；stub 将 fatal/exhausted 转成原 authority error，driver 将最后 observation（空 rows 映射为 `null`）送入现有 preflight/A3。分别补 stub-throws 与 driver-preserves-A3 两组测试。

2. **首次 `rows === []` 仍把“已有 PR 的滞后观察”误当成“需要 create”，没有实现计划自己的 retry 矩阵。** classifier 把空 rows 定义为 retry，但 `ensurePullRequest` 仍拟“list 为空先 `gh pr create`”（plan.md:122-124）。在 attempt 2 推送到既有 PR 后，若第一次 PR 读模型返回空数组，代码会尝试创建第二个 PR并在进入 poll 前失败；真实流程确实复用同一 run-scoped branch/PR（`qa-529-generalized-stub.mjs:378-405`）。**建议：**在 `commitFile`/push 之前先发现并记录该 branch 的现有 PR（或使用 durable `lastCompletion.prNumber` 并以 pre-push lookup 补 crash adoption）；已知 PR 路径只 poll，不 create；确认为 fresh branch 时才 create 一次，然后 poll。增加“existing PR + first post-push observation empty → 不调用 create、随后收敛”的测试。

3. **C5 的“删键必 deny”探针会被 assembler 守卫提前截断，证明不了真 validator 在场。** C1 明确规定 projection 缺任一 required key 时 `buildSlotCommEnv` 立即抛（plan.md:63-64），但 C5 又要求从 projection 删除 `FLYWHEEL_LEAD_SUMMARY_ROLE`、重组 env 后断言 `authorizeLeadWrite` 抛 `identity_env_conflict`（plan.md:146-147）。按该顺序，`authorizeLeadWrite` 根本不会执行。**建议：**保留一个独立测试证明 assembler 对缺键 fail-closed；validator 反向探针则先用完整 projection 生成合法 env，再从最终 env 删除该键，直接调用 dist `authorizeLeadWrite`，并断言 `LeadLeaseDeniedError.reason === "identity_env_conflict"`。这样正向通过与反向 deny 都确实经过真 validator。

4. **新测试文件选项没有 CI 消费合同，可能产生本地有证据、CI 未执行的假绿。** C5 允许新建 `qa-generalized-slot-env-authority.test.mjs`，但当前 `script-tests-2` 只显式运行 `qa-generalized-e2e-lib.test.mjs` 等固定文件（`.github/workflows/ci.yml:562-568`），不会自动发现 sibling；C6 的“(+新文件)”也没有对应 workflow/ci-structure 改动。**建议：**为保持最小改动，直接钉死对照组放入现有 `qa-generalized-e2e-lib.test.mjs`；若坚持拆文件，则把 `.github/workflows/ci.yml` 和必要的 `ci-structure` 断言列入改动面与测试命令，不能只在 PR body 手工运行。

5. **room handoff 只校验 `summaryConfigHome` 非空，没有执行 D2 声称的 slot-local 路径合同，且 writer 测试目前不存在。** 计划要求它等于 `<slot>/identity-home`，但 C1/C2 只调用 `requiredString`；这样任意非空/任意绝对路径都能进入 resolve，不能从 consumer 侧证明不会读 operator HOME。现有 `test-deploy-generalized.test.sh` 只静态断言 `flywheelRepo` 与 `flywheelProjectsFile` handoff（:498-503），所以“若断言字段集合再更新”不会新增 writer coverage。**建议：**在 room validation/driver setup 中断言 `summaryConfigHome` 是绝对路径且等于由 `room.slot` 推导的 canonical slot path（或至少 realpath 后位于该 slot root）；更新 `ROOM` fixture，补 missing/wrong-path/rebuild-guidance 用例，并在 deploy shell test 中明确断言 jq writer 同时传参与落字段，而不是条件性更新。

## Verdict

CHANGES REQUESTED — address items above
