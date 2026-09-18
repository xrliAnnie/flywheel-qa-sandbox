# Design Review — plan.md (Round 2)

Date: 2026-09-17
Author: Codex
Status: CHANGES REQUESTED

## Summary

Round 1 的七项问题大多已得到实质修正，尤其是 CI 接线、lockfile 结构比较、tsconfig 单覆盖守卫和 AST 依赖守卫；§3.7 对现有 CI 结构约束的判断也已由源码与两条守卫测试验证。当前仍有两个会让施工或验收直接失真的阻断项，以及一处必须补全的 CI 证据时序，因此尚不能按本文原样实施。

## What's Good (Keep)

- CI 注册方式现在正确：构建在 `.github/workflows/ci.yml:125-126`，既有 root Node suites step 在 `.github/workflows/ci.yml:128-155`；枚举守卫只要求每个根级 `*.test.mjs` 被 workflow 字面列出（`scripts/__tests__/ci-shell-suite-enumeration.test.sh:26-36`），而 shard 的精确 step 清单只覆盖五个 script shard（`scripts/__tests__/ci-structure.test.sh:770-885,910-940`）。本轮实际执行两条守卫均通过。
- §2.2 已先拒绝 D/R/C/T 等非 A/M 状态，并对既有文件的 M 集合做精确等值，关闭了 Round 1 中删除或改名 updater 文件逃逸的问题（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:44-52`）。
- C5 已改为语义级 lockfile 比较：只允许新增 `packages/raya-cos` importer、保持所有旧 importer 不变，并要求其余顶层结构深等（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:227-250`）。本轮用当前 lockfile 模拟目标 importer 后完整运行该断言，得到 `LOCKFILE STRUCTURAL CHECK OK`。
- C4-a 已把此前可能 vacuous 的约束变成可核合同：AST 收集器有三个违规正向对照，tsconfig 对每个键和值、include/exclude 及 base 中的原始开关都做精确断言，`PO_PACKAGES` 也要求唯一、单行、可解析的赋值（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:195-205`; `tsconfig.base.json:2-20`; `scripts/package-onboard.sh:42-47`）。
- 三 commit 方案把 package-gate receipt 自带的 HEAD 与代码 SHA 绑定，且不再尝试把 CI 运行产物回写到同一个被测 commit；这是正确的证据方向（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:271-278,310-317`）。

## Issues & Recommendations

1. **[Blocker] C3 的目标 README 文案必然被同一节的收尾检查判失败。** 新段落明确包含字面量 ``business/current``（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:179-186`），但紧接着要求 `grep -n 'business/current\|@raya/cos' ...` 必须无输出（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:188-191`）。这不是边缘条件：按计划逐字施工就一定在 C3 停住。建议只禁止旧的具体调用路径，例如检查 `business/current/packages/cos` 与 `@raya/cos`；或者从说明段中彻底移除 `business/current` 字样，二选一并保持判据与目标文本一致。

2. **[Blocker] §2.2 仍未实现 §2.1 声称的“变更集必须恰好等于表格”，QA ⑤ 仍可被额外的包内文件绕过。** A 集合检查允许 `packages/raya-cos/` 下任意路径，最后的 raya/updater sweep 又整体豁免该前缀（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:53-60`）；C1 只证明 `src/` 等于上游 120 文件加守卫，不约束包根的其他文件（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:108-119`）。本轮按 §2.2 原脚本执行合成 diff，加入未列入白名单的 `packages/raya-cos/scripts/updater-raya-extra.sh` 后仍得到 `S1-BOUNDARY OK`，与精确白名单（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:22-34`）和“纯 additive 的有界 S1”不一致。建议在 §2.2 对 `packages/raya-cos/` 的非 `src/` A 集合做精确等值，只允许 `README.md`、`package.json`、`tsconfig.json`；`src/` 则继续由 C1 证明为上游全集加唯一 guard。这样三部分合并后才真正得到完整 A 集合。

3. **[High] “commit ② 是被测 SHA”的远端 CI 时序还缺少不可省略的 push/wait 步骤。** 计划要求 PR 引用绑定到 commit ② 的 light/Quick Gate checks（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:271-277,282-288`），但 §7 只列出三个 commit，没有要求在创建或推送 commit ③ 前先推送 ② 并等待其 CI 完成（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:310-317`）。workflow 只在 push/PR head 上触发（`.github/workflows/ci.yml:3-7`），同一 PR ref 的新运行会取消旧运行（`.github/workflows/ci.yml:19-21`）；因此一次推送三个 commit 不会产生 ② 的 checks URL，② 尚在跑时推送 ③ 还会取消它。建议把顺序写死为“推送 ② → 等待 light 与 Quick Gate 在 ② 上完成并记录 URL → 创建并推送 ③ → 在最终 PR head 重跑 §2.2 并仅把这次输出贴到 PR”；或者把最终 commit ③ 定义为远端 CI 被测 SHA，并单独称 ② 为 package-gate receipt 的 code SHA。

4. **[Minor] 两处“精确”描述仍应做机械修正。** C1 声称按完整路径“只排除” guard，却用了正则模式 `grep -vx "$GUARD"`；路径中的 `.` 会作为正则通配符，应改为 `grep -Fvx -- "$GUARD"`（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:108-113`）。另外 §3.3 把 vitest reporter 分支引用为 `package-gate.mjs:157`（`engineering/doc/FLY-2694-raya-cos-landing/plan.md:81`），当前实际判断和参数追加位于 `scripts/package-gate.mjs:164-173`；更新行号可避免施工者查错位置。

## Verdict

CHANGES REQUESTED — address items above
