# FLY-2753 本机定向验证 — 调研
Issue: FLY-2753 (https://linear.app/geoforge3d/issue/FLY-2753/守则吞吐-实现qa-守则要求每具-runner-交卷前本机跑全量-pnpm-testpackagesrun-十几具同时跑每具-1-2)
日期: 2026-09-20
基于: exploration.md

## 可复核证据

所有生产源观察来自 `3d67d8350`，只读；当前 sandbox 起点 `1855f7a1a`。这是仓库内合同审计，不依赖外部产品文档或互联网建议。

| 消费者/源 | 观察 | 设计影响 |
|---|---|---|
| `.flywheel/agents/nodes/implement.md` 第 6 步 | `180bdaa3e^` 要求 lint、全仓 build、全量测试、PACKAGE_GATE_RECEIPT；当前源已是定向规则 | 在授权目标逐项核查，已满足就保留，不能重复重写 |
| `.flywheel/agents/nodes/engineer.md` 第 5 步 | 同一全仓门及 RPC 例外；当前源已改 | 与 implement 保持验证含义一致 |
| `.flywheel/agents/nodes/qa.md` 第 3 步 | 曾引用全量命令和回执；当前源已改 | QA 保留独立产品验证和红灯 FAIL |
| `scripts/sync-phase-protocols.mjs` | 5 个 canonical 类型；9 个投影映射；只同步 BEGIN/END 块，先校验再写 | 验证条款位于块外，不要无故改生成器 |
| `packages/teamlead/phase-protocols/{implement,qa}.md` | implement 不在普通头请求全量；QA 在冻结头 `ci-full ensure`，PASS 前必须 exit 0 | 保留原文和职责 |
| `packages/teamlead/package.json` prebuild | 强制 `sync-phase-protocols.mjs --check` | 同步检查不可削弱；显式检查足以验证投影 |
| `scripts/__tests__/package-gate.test.mjs` | 现有测试 `active runner handbooks require targeted local verification and CI-owned full evidence` 已覆盖三份条款 | 优先运行这个独立命名测试；不要重跑整个重型套件 |
| `scripts/__tests__/fly2533-phase-protocol-assets.test.sh` | 包含投影漂移、损坏标记、非法参数负例，也有构建/打包下游依赖 | 仅在改动相关协议/生成器/包资产时运行，并准备其定向构建前置 |
| `.github/workflows/ci.yml` | 当前生产存在分片和 `CI OK` / `CI Scope OK` 聚合分支 | job 数量不写死；核对实际完整任务集合与当前 head |

生产源只读运行 `node scripts/sync-phase-protocols.mjs --check` 返回 `phase protocols: 9 projections checked`。这是生产源投影一致性证据，**不是 sandbox 检查通过，也不是 CI 全绿**。

## 选测试的具体步骤

1. 从 PR base 与 head 的 diff 获取改动文件，按所属 `package.json` 确认真实包名。根脚本或角色文档不虚构 owning package。
2. 查同包中直接覆盖改动的测试；用改动文件完整路径、文件名、父目录分别 `git grep -lF` 找直接消费者。保留匹配测试，逐一记录无关匹配的排除依据。文本搜索不是完整依赖图，不将零匹配当成证明。
3. TypeScript 改动在所属包运行 `vitest related <files> --run` 辅助追踪导入关系；保留项目原有脚本必要参数。跨包接口变化继续追踪直接依赖包的相关测试和类型检查。
4. 所有新增 `scripts/__tests__/*.test.sh` 都运行。已有相关 shell/Node 测试同样纳入；不把整个包套件当默认兜底。
5. 记录命令、退出码、实际测试数量和 head。没有匹配项目、没有测试收集、跳过或未执行不得报绿。环境失败须据实报告，不能沿用 PACKAGE_GATE_RECEIPT 的本机全量例外判通过。

## 持久化、兼容与回退

没有数据库/API/身份变更。`implement`、`qa`、`engineer`、阶段标签、执行身份、门凭据均不更名。只删除角色验证段的本机全量回执要求；`scripts/package-gate.mjs` 及 CI 的旧回执格式仍可能有消费者，不删除、不迁移。

投影同步默认 `--check`，需要更新时先改 canonical，再 `--write`，随后 `--check`。本设计并不需要改 canonical，因为其冻结头语义已正确；如实施现场有旧文本才做最小修正。回退只还原本单验证段/定向测试，成对恢复任何实际改过的 canonical/投影，复跑检查，不回滚别人的提交，不重启服务。

## 仍需现场确认

sandbox 缺少目标机制且生产同 issue 已实现。Lead 的目标答复必须进交接记录；若授权目标是现有实现，则逐条验证并只补缺口。未获得目标不能宣称实施就绪/实现完成，更不能借生产只读检查关闭 sandbox 的验收项。
