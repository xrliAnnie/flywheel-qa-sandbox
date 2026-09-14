# Design Review — plan.md (Round 1)

Date: 2026-09-13
Author: Codex
Status: CHANGES REQUESTED

## Summary

总体方向可在现有 FLY-2393 架构内实现：取源点、事务性 `reserve()`、receiver 祖先守卫、回执核验和 B3 的本机 SHA 读取器都与计划假设一致，默认路径也能保持行为兼容。当前有两处会让实施/QA 合同与已验证事实不一致，修正文档即可，不需要扩大设计或重开 Lead 已裁定的候选。

## What's Good (Keep)

- 取源分支放在 `due()` 之后、`reserve()` 之前是正确的最小插入点；失败时不会产生 occurrence，也不会推进 lane cursor。
- `local_deployed_sha` 路径不回退 `head()`，并把文件无效、祖先不成立和 GitHub 传输/响应故障分开处理，保持 fail-closed。
- `source_origin` 与 `source_commit` 在同一 occurrence INSERT 中冻结，且不改变 `occurrenceId` / 唯一约束，符合 FLY-2393 的稳定身份和 active occurrence 恢复模型。
- 复用未合并 B3 分支导出的 `readLocalDeployedSha()` 是可行的；该函数确实读取 `FLYWHEEL_DEPLOYED_SHA_FILE ?? ~/.flywheel/deployed-sha`，严格接受 40 位小写 hex，否则返回 `null`。
- GitHub compare 方向正确：候选 SHA 作 base、默认分支作 head；`ahead | identical`、`behind_by === 0`、`merge_base_commit.sha === sha` 能证明候选等于或祖先于默认分支。官方 compare 合同也确认 `BASE...HEAD` 形状且所需权限为 Contents read。
- receiver 的 `assessBetaSource()` 已在 checkout 冻结 SHA 前用 `git merge-base --is-ancestor` 做第二道守卫，并已有 `no_change` / `covered_by_newer`，本单无需修改 workflow 或 publisher。
- #1156 合入、workflow 恢复、部署、`paused → drained → bridge` 接管的总体先后关系正确；生产配置和接管保持在本 PR 之外也符合范围约束。

## Issues & Recommendations (blocking)

1. **计划仍引用已被 Lead 更新的 workflow 故障归因和 ownership。** `plan.md` §8.2 仍写“疑似 #1160 加的 `concurrency.queue: max`”，§12 F1 仍写“另开单”；但当前 `exploration.md` §2/§6 与 `research.md` §9 已明确：该前置是 **FLY-2534**，Lead 已认领且实现中，已验证根因是 job 级 `env` 引用 `runner.temp`，本单不得另开单或碰 workflow。当前 checkout 的 `actionlint` 也确实在 workflow 第 91 行报告该 context 不可用。错误描述会把实现者导向错误修复/重复建单，并违反最新 Lead scope。**建议：**只做文字同步——把 §8.2、§10 和 F1 统一改为“FLY-2534（Lead 已认领/实现中）是 QA 前置；本单不修”，删除旧猜测和“另开单”；不要把 FLY-2534 的修法纳入本单。

2. **部署/QA 步骤没有处理合法的 `covered_by_newer`，因此首轮验收并不总是可达。** §5 已要求覆盖“deployed SHA 比现有 beta 旧 → `covered_by_newer`”，receiver 也允许该 outcome 且此时 `publishedSourceCommit` 是后代、并不等于 occurrence 的 deployed SHA；但 §8.5 假定首个回执只能是 `published | no_change`，§8.6 随即拿 `publishedSourceCommit` 要求 B3 不含 `not_currently_deployed`。若首轮正好走 `covered_by_newer`（回滚或 urgent 部署旧 SHA 都可能触发），B3 按既定精确身份合同必然 fail-closed，这不是 FLY-2508 对齐成功证据。**建议：**在 §8 明确三分支：`published | no_change` 才进入对齐 QA；`covered_by_newer` 只证明未回退且本 occurrence 安全结算，不算本单验收通过，需等待后续 deployed SHA/到期 occurrence 产生 `published | no_change` 后再执行 §8.6；非法/缺回执仍按现有 attention。给该 QA 分支补一个非 vacuous 测试/验收断言即可，不改 receiver。

## Advisory (non-blocking)

1. `fleet-console-html.ts` 的标签渲染发生在浏览器内嵌脚本中，不能直接调用服务端 `beta-release-management.ts` 的 TypeScript 标签函数。实施前最好把数据流写成二选一：DTO 额外携带服务端派生且已验证的展示字符串，或由前端对已校验枚举做固定映射；避免计划一边要求 DTO 只有 `sourceOrigin`，一边要求标签只在服务端函数中定义。

2. 请把管理台文案的语义说成“当前配置的取源策略”。`BetaScheduleObservation.sourceOrigin` 来自当前 config，而 active occurrence 的 `sourceOrigin` 可能仍是切换前冻结值；若文案意图描述 active/最近发布来源，就必须从 occurrence 投影，不能用当前 observation。现有计划选择前者即可，无需新增历史查询。

3. 本机文件读取与远端 compare 之间存在小的 TOCTOU 窗口：updater 若在请求期间推进 `deployed-sha`，本轮可能冻结刚刚退出运行的旧 SHA。B3 的 `not_currently_deployed` 会阻止错误 green，因此这不是安全阻塞；建议至少把它记录为 residual availability risk。只有产品要求“reserve 时刻严格相等”时，再考虑 compare 后同步复读一次并在变化时不 reserve。

4. 统一 404 的原因码说明。计划 §2.2 的实现会把 compare 404 保留为 `beta_github_http_404`，而 `research.md` §7 把 404 写成 `beta_source_not_on_default_branch`。前者更保守，因为 404 也可能表示仓库/权限不可见；保持该实现即可，只需修正文档和测试期望。

5. C1/C6 的定向回归清单应显式包含 `packages/teamlead/src/bridge/__tests__/beta-release-config-source.test.ts`：解析后配置对象新增必填默认字段，现有配置源夹具也会受到类型/期望值影响。这里属于测试清单完整性，不改变设计。

## Verdict

CHANGES REQUESTED — address blocking items above
