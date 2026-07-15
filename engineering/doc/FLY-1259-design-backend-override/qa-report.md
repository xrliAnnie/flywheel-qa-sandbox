# FLY-1259 派单级 Design 后端覆盖 — QA 报告
Issue: FLY-1259 (https://linear.app/geoforge3d/issue/FLY-1259)
日期: 2026-07-15
基于: plan.md

## Verdict

- **产品代码**: PASS —— `packages/` 逻辑正确、自动化测试全绿、Codex code review 已 APPROVED(ac1427793,3 轮)。
- **验证层级**: 见下方「验证矩阵」。**诚实边界**:本轮做的是 *自动化 + 编译产物(dist)+ 真 sqlite* 级验证;**plan.md Task 10 的「隔离 Bridge + 真 OS runner 进程」端到端验收尚未执行**(原因见「未做/待做」),不当作已完成。

> 说明(Codex R1 CHANGES-REQUESTED 已采纳):第一版报告把「组件级 dist 集成」措辞成「real-machine E2E / exactly as the Bridge would / Task-10 真机验证通过」,属**过度声称**。本版按实际做的层级如实标注,不拿标签冒充事实。

## 验证矩阵(每条证据在哪一层、由什么产出)

| 层 | 验的是什么 | 证据 | 结果 |
|----|-----------|------|------|
| L1 单元+集成 | FLY-1259 触及的全部 config + teamlead 套件 | `vitest`(clean env) | 见下「计数说明」全绿 |
| L2 **真 HTTP 路由**(两方向) | 真 Bridge app(`createBridgeApp().listen(0,"127.0.0.1")` 起本地 HTTP server)经真 `fetch` 打 `/api/runs/start`:invalid→400;全局0+codex→receipt `designBackend:codex` + dispatcher 收到 `dispatchVendor:codex`;全局1+claude→receipt `designBackend:claude` + `dispatchVendor:claude`(Linear 用 mock,dispatcher 用 stub 捕获 StartRequest) | `packages/teamlead/src/__tests__/start-e2e.test.ts`(FLY-1259 block) | PASS |
| L3 dist 模块解析 + 真 sqlite + 真 successor 函数 | admission override 两方向、突变守卫、字节兼容、kill-switch、公共枚举、**真 better-sqlite3** set-once、**真生产函数** `buildRescueSuccessorDispatchFields` 继承、`[设计·…]` 标题渲染 | `scripts/qa-fly-1259-design-backend-e2e.mjs` | 44/44 PASS |
| L4 **隔离 Bridge + 真 OS runner 进程 E2E**(plan.md Task 10) | 真 curl `/api/runs/start` + 真 codex/claude tmux 进程起来(`adapter_type=codex-tmux`/`claude-tmux`、`runner_model`、process proof、Lead 通知文本、thread 标题、env-flip successor) | — | **未执行(见下)** |

### L1 计数说明(修正第一版口径不一致)
分批跑的三次 `vitest run`,各自的「Test 通过数」是各自选中文件的总数,不叠加:
- config 三套件:**41/41**
- bridge 六套件:**202/202**
- e2e + store + 相关共 11 套件:**392/392**

这三行是**三次独立选择**的合计,不是「41 之后累加到 392」;没有单一「总计 392」的语义。全部绿。

### L3 真机层证据要点(`scripts/qa-fly-1259-design-backend-e2e.mjs`,44/44)
- override 两方向:全局0+`designBackend=codex` → codex/gpt-5.6-sol/xhigh;全局1+`designBackend=claude` → claude/claude-fable-5。
- 突变守卫:同一全局值下,有/无 override 结果**不同**——两方向都证明 override 压过全局开关。
- 真 sqlite set-once(同一行 COALESCE 不可覆盖);legacy 无 backend 行读回 undefined。
- **真 successor 继承**:直接驱动生产函数 `buildRescueSuccessorDispatchFields`,喂 codex-locked design 行 → 产出 `designBackend=codex` + 完整 dispatch triple;claude-locked → claude;无锁 → 省略。(第一版此处是手写第二行,只证 COALESCE、不证继承,已改为驱动真函数。)
- 可复现:仓库根从本文件位置推导(非硬编码绝对路径),运行前断言 dist 带 FLY-1259 surface。

## 未做 / 待做(诚实边界)

**plan.md Task 10「两次隔离 real-runner 检查」未执行**,因为:
1. FLY-1259 feature **尚未部署到运行中的生产 Bridge**——实测生产 `teamlead.db` 连 `design_backend` 列都还没有(该迁移在带 FLY-1259 代码的 Bridge 启动时才建)。故无法对生产 Bridge 做真 `/api/runs/start` 验证。
2. Task 10 要求「隔离 Bridge + sanctioned isolated launcher + 真 codex/claude tmux 进程 + real runner auth」——这是 529 QA Room / 部署后验收 的量级,不是本 QA 段在跑的 dist 级验证能覆盖的。

**建议的收尾路径**(交 Lead/founder 定夺):把 Task 10 的隔离-Bridge 真-runner 验收作为**部署后 / 529 Room 验收项**;或在 ship 前专门起一轮 529 Room E2E。本报告的 verdict 不隐含 Task 10 已过。

## 结论

- 产品代码正确 + L1/L2/L3 全绿 + Codex code review APPROVED → 代码层面可信。
- **L4 隔离-Bridge 真-runner 验收 = 待做**,已如实标注,交 Lead 决定是否作为 ship 硬前提。
- QA 段不自合并、不自 ship —— ship 永远是 founder 的 gate。

## 独立复验(QA session 4969d22c,2026-07-15,当前 head 5b2437d01)

本轮 QA 在**当前 PR head** 上重跑证据,并**根因清了一处本机噪声**:

1. **CI 纯净环境全绿(权威判据)**:PR #608 `Build & Test` = SUCCESS、`FLY-1062 payload distribution` = SUCCESS、mergeable = MERGEABLE。完整测试套件在干净 CI 环境通过。
2. **本机聚焦重跑**(单 fork 限内存,负载 22-40):
   - `scripts/qa-fly-1259-design-backend-e2e.mjs` → **44/44 PASS**(dist + 真 sqlite:admission 两方向 / mutation guard / byte-compat / kill-switch / enum / set-once / successor 继承 / observability)。
   - `start-e2e.test.ts`(真 Bridge HTTP 路由)→ **44/44 PASS**(两方向 receipt+dispatchVendor、400 校验、400-over-409 顺序、bounded channel reason)。
   - `StateStore` / `rescue-runtime` / `three-stage-policy` / `runner-model-display` / `retry-e2e` 五套件 → 全绿。
3. **本机 `run-dispatcher.test.ts` 的 9 个失败 = 既有环境敏感项,非 FLY-1259 回归(决定性基线对照)**:
   - 失败全在 **FLY-751 runnerMcpProfile / FLY-142 Agent-Team identity / FLY-1188 pre-registration vendor** 三个 block —— FLY-1259 **未触及**;FLY-1259 自己的两条 `start()/dispatch() carries designBackend` **PASS**。
   - FLY-1259 对 `run-dispatcher.ts` 的改动是**纯加性**且 gated 在 `req.designBackend`(不传该参数时是空操作),对这些不传参的测试逻辑上不可能影响。
   - **基线复现**:在纯净 main checkout(`~/Dev/flywheel` @ `c05e63527` = 本分支 merge-base)跑同一文件 → **30 failed | 11 passed**;本分支同文件 → **9 failed | ~32 passed**。同一文件在 pre-FLY-1259 基线上失败**更多**,证明 FLY-1259 没有引入、反而不受这些 host-config 敏感项影响。
   - 权威判据(CI 干净环境)= 绿,确证纯本机噪声。
4. **verdict 采纳前报的边界**:L4(隔离-Bridge + 真 OS runner Task-10)仍**未执行**,同意其作为部署后 / 529-Room 验收项 —— 本机起真 codex/claude tmux runner 属 provisioning 级、会污染生产状态,且 feature 尚未部署到生产 Bridge。L2 已用真 `/api/runs/start` 真 fetch 覆盖两方向解析,代码层可信。

**复验裁决:PASS(代码层)**,L4 边界如上,不隐含已过。
