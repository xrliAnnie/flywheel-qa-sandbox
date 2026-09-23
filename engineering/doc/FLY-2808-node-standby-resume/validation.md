# FLY-2808 全节点退下与原会话拉起 — 调研
Issue: FLY-2808 (https://linear.app/geoforge3d/issue/FLY-2808/节点生命周期n1-设计主动退下与意外死亡的区分信号-六个会把退下当死亡的打断点怎么改-拉起的身份模型工作目录核对)
日期: 2026-09-23
基于: plan.md

## 当前交付边界

Lead 以 `[lead-instruction 3ee3f5da-9019-4fbe-8b2d-c6270a9b7308]` 授权在本单完成设计中 N2–N5 的默认关闭实现。当前分支交付 process-body 生命周期、Claude/Codex 精确原会话恢复、恢复失败兜底和预算分账、死亡消费者 guards、founder 三态投影及定向测试；`FLYWHEEL_NODE_STANDBY_RESUME` 默认关闭。

以下都是本机源码证据，不是 exact-head full CI、真实服务重启、真实 Claude/Codex 长会话、浏览器 QA、生产启用或部署证据。本节点没有派 QA、merge 或 deploy。

## TDD 与定向验证

| 范围 | 命令/结果 | 结论 |
|---|---|---|
| teamlead 新合同 | StateStore/process-body、resume/fallback、rework coordinator、Heartbeat、pane-loss、reowner、founder display 等精确测试：219 PASS | 新增正负路径绿 |
| adapter | `vitest related` 覆盖 TmuxAdapter、CodexTmuxAdapter、daemon client：596 PASS，2 个依赖真实环境的既有用例 SKIP | 两 vendor 精确 ID/model/cwd 与 manifest 合同绿 |
| edge-worker | `vitest related src/Blueprint.ts --run`：345 PASS | launch context 传递绿 |
| core | `vitest related src/adapter-types.ts --run`：23 PASS，2 个既有 terminal 环境用例 SKIP | 共用 adapter 类型合同绿 |
| flywheel-comm | recipient 精确测试及 related：17 PASS | standby 非终态收件语义绿 |
| 本轮发现的 legacy migration | `StateStore.workflow-rework.test.ts` 精确 migration 用例：1 PASS | 重建 runtime 表前移除依赖 trigger，rename 后恢复 |
| 本轮发现的既有故障预算回归 | `StateStore.fly1385-dead-exec.test.ts` 三个精确用例：3 PASS | budget 只数 `fault_replacement`；审计 `launchCount` 仍报告全部物理 launch |
| strict retention registry | `fly-2413-retention-registry.test.ts` 两个 schema 分类用例：2 PASS；两个新增 JSON 的 Biome check PASS | 新表登记为 `protectedCurrentOrReference` |
| 整单终态关闭 | `StateStore.generalized-execution.test.ts` 精确用例：1 PASS | 只有 whole-run terminal 才 close process body |
| teamlead exact code-head related | 574/575 files PASS；8121 tests PASS、4 SKIP、1 FAIL。唯一红是无关 chat-thread 404 响应的一次空 JSON 解析；同头失败用例 1/1、整文件 68/68 重跑 PASS | 生命周期相关测试无红；保留首次 related 红与定向清除记录，不把它改写成一次性全绿 |

最初的 teamlead related 运行在上述修正前，最终为 572 files / 8116 tests PASS、4 SKIP、6 FAIL；红项恰为 1 个 legacy migration、3 个故障替换断言和 2 个 retention registry 分类断言。这次红不是最终证据。修正后先精确复现转绿，再以 exact code head 重跑 related；最终大套件只有上述无关瞬态红，已用同头的精确用例和整个 owning test file 清除。

## 构建、类型与静态检查

- exact code head 的 `pnpm --filter 'flywheel-teamlead...' build`：13 个受影响包及依赖构建通过。
- `pnpm --filter flywheel-voice-bridge build` 后，`pnpm --filter '...flywheel-core' typecheck`：9 个 core 反向依赖包通过。首轮仅因 sibling `voice-bridge/dist` 尚未生成而失败，补建该 workspace 输出后同一检查通过；不把首轮红藏掉。
- teamlead、edge-worker、claude-runner、flywheel-comm 各自 typecheck 通过。
- `pnpm lint` 按角色要求执行但全仓红：命中本分支外旧 research scripts/config/core/scripts 诊断；本分支最初 3 个格式问题已用现有 Biome 修复。对全部 changed TypeScript 的标准 `biome check` 无 error，仅报告 plugin.ts 两处既有 `let` warning；默认 1 MiB 限制跳过 2.8 MiB 的 StateStore。将上限提到 3 MiB 检查整个 StateStore 会命中该巨型旧文件既有 import 排序/格式和一处旧字符串拼接，故不能把它宣称为全绿，也不为本单机械重排约九千行。
- `git diff --check`：当前通过，final exact head 再复核；没有添加依赖或秘密。

## 消费者发现与取舍

按角色要求，对每个改动源码分别以完整路径、文件名、父目录执行 `git grep -lF`。命中数（完整路径/文件名/父目录）如下：

| 源文件 | 命中数 | 保留的实际消费者 |
|---|---:|---|
| CodexTmuxAdapter | 1/2/7 | runner tests、Blueprint/dispatcher |
| TmuxAdapter | 4/5/7 | runner tests、Blueprint/dispatcher |
| codex-daemon-client | 0/0/7 | Codex adapter 与直接测试 |
| core adapter-types | 0/0/3 | adapters、Blueprint、dispatch context |
| Blueprint | 3/9/8 | edge-worker tests、teamlead launch paths |
| HeartbeatService | 3/6/43 | Bridge wiring、直接/parked tests |
| StateStore | 3/15/43 | workflow dispatcher/rework/display/guards 与直接 tests |
| codex-session-reown | 0/0/29 | plugin wiring、直接 tests |
| issue-display-refresher | 0/2/29 | plugin refresh 与 display tests |
| issue-display | 0/0/29 | title/tools/refresher 与直接 tests |
| issue-title-state | 0/0/29 | plugin title refresh 与 tests |
| pane-loss-reconcile | 0/0/29 | plugin lifecycle sweep 与直接 tests |
| plugin | 12/89/29 | Bridge bootstrap/runtime tests |
| retry-dispatcher | 0/1/29 | run/workflow dispatch paths |
| run-dispatcher | 0/6/29 | plugin、retry、prebound tests |
| tools | 0/5/29 | Bridge API/status tests |
| workflow-engine-dispatcher | 2/6/29 | plugin、engine transition tests |
| workflow-rework-coordinator | 0/1/29 | plugin、rework e2e/直接 tests |

排除项逐类说明：`engineering/doc` 和 `product/doc` 是历史设计/调研引用，不是运行时消费者；generated child-process census/inventory 是快照清单；大量同名 `plugin.ts`/`tools.ts` 命中属于其它 package；只复述文件名的 fixture/文档不形成调用关系。真正的运行时命中、直接依赖测试、新增测试和 changed TypeScript owning-package related 均保留执行；没有把历史文档命中误算成需要执行的测试。

## 设计、HTML 与评审沿革

- 设计 R2 gate `d0cf1a21-fa94-4d23-9663-63df581f0d15` / request `1f35923f-ea52-4f3b-8e4b-53650e105e75`：当时冻结的设计 plan effective `APPROVED`；3 MEDIUM + 2 LOW 非阻塞建议在 follow-ups.md 有 disposition。Lead 授权实施后追加的状态与落地记录不冒充原设计摘要，随当前 exact-head code review 一并审阅。
- 浅色 design.html 已静默发布到 <https://fw-reports-356a6d.vercel.app/r/26fd140eb5edba1cbc40ad3555a79561/>；publish receipt 证明 hosted source/nonce/无外部资源，但不冒充真实浏览器视觉/CSP QA。
- 本地 Mermaid 四次均因 Chromium MachPort sandbox permission 在启动前失败，保留 `.mmd` 源与明确 pending 标识；未使用远程渲染、未冒领图形完成。
- 旧 docs-only code review 已被后续实现头替代；完成本地验证和 literal-last milestone 后必须对新的 exact head 重新请求有效 code review。

## 最终需求审计

| 原要求 | 当前源码落点 | 尚未证明 |
|---|---|---|
| 主动退下 vs 意外死亡 | process body generation/state + completion/retirement evidence；六个死亡入口读取同一事实 | 真实进程释放与资源曲线 |
| 六处打断点 | completion、rework、TURN/dispatch、recipient、Heartbeat/pane-loss/reowner/expiry、fault budget 均接线 | 真实 Bridge 重启矩阵 |
| 拉起身份/model/cwd | 两 adapter manifest + exact resume；pre/post identity；HEAD/dirty 重读提示 | 真实 provider 长会话连续性 |
| 拉不起与兜底 | 两次 resume、一次原子 fresh fallback、route/node/delivery rebind、独立 purpose | 真实 transcript 损坏和 fallback 端到端 QA |
| founder 三态 | working/standby/problem DTO 接 title/refresher/status tool | 真实浏览器和移动端视觉 |
| 默认值与并发 | 无墙钟 TTL；同目录串行、跨目录最多2；预算默认落入冻结合同 | 压力/饥饿 QA |
| 默认关闭和旧 run | 仅新 admission 在 flag=1 时纳入；旧 run 维持旧语义 | 发布/回滚演练 |

最终 code review、PR checks 和 completion receipt 在 exact head 形成后记录到 PR；本文件不会把 focused/related 本地检查称为全量 CI。
