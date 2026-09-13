# FLY-2459 Codex 部门 Lead — 实施证据
Issue: FLY-2459 (https://linear.app/geoforge3d/issue/FLY-2459)
日期: 2026-09-11
基于: plan.md、migration-decision.md

## 实现范围与当前状态

已实现批准的 A–D 和 E 的本地隔离测试/生产路书。代码审查、PR 和 QA 交接尚待完成；没有部署、重启、真实 Discord 发信或验收 runner 派单。以下证据不能替代生产验收。

| 块 | 实现与验证边界 |
| --- | --- |
| A 能力 | 单一 raw capability resolver；显式 codexRunnerActions + canSpawnRunners/full-access 才启用；canonical digest 的 capability 投影独立；generic launcher/selector/fleet 接线，未新增 residency lane |
| B 工具链 | 六工具共享 schema/handler；两个已有 MCP 入口；full-access/TUI 保持静态配置检查；write-capable broker 保持身份和权限合同 |
| C 读写派单 | 采纳菜单、部门/项目/exact execution 限制；send 稳定 ID；respond 四保留门拒绝；pending/unknown 不自动 POST 重试。Lead 裁定的 Discord source key 作为只读因果对账锚点 |
| D 手动迁移 | planner、真实窗口权威检查、短配置锁 CAS、精确目标文件、停旧 owner、持久 cutoff/标准 mailbox/cursor、有限启动与 preflight 特定回滚、同轮防重启、窗口外 verifier 和成功 intent 原子退休 |
| E 隔离/QA | 两 profile child MCP harness、本地 SQLite/脚本/HTTP fixture；路书含 QA 明确未执行项。真实 @/派单/403/可见 TUI/Astra high/获授权重启后复验由 QA 与部署责任人执行 |

管理台保留跨厂商在线写入禁用，增加固定受控迁移文档链接，说明配置值和生效状态的区别。未修改 implement 模板、tpl_code/tpl_simple_code 或 CLAUDE.md。

## 最终本地验证

最终产品代码提交 `6d2d6d08e`；随后仅证据、进度和 fixture 文档变更。

- `pnpm lint`：exit 0，15 warnings。日志 `/tmp/fly2459-final-lint.log`。
- `pnpm -r build`：exit 0。日志 `/tmp/fly2459-final-build.log`。
- 本分支相对 origin/main 改动的测试文件，逐包 `VITEST_MAX_FORKS=1 pnpm --filter <pkg> exec vitest run <paths>`：config 2 文件/27 passed；comm 22 文件/207 passed/1 skipped；TeamLead 28 文件/430 passed，三个命令均 exit 0。日志 `/tmp/fly2459-final-affected-{config,flywheel-comm,teamlead}.log`。
- comm 唯一 skip 为真实 ancestor 进程探测在沙箱 EPERM 下无法执行；模拟窗口/进程负例通过不代表真实 host 权威证明。
- `runs-route.dag-entry.test.ts`：57 passed，exit 0，包含 `WORK_KIND_ROUTE_DECISION_CONFLICT`。日志 `/tmp/fly2459-dag-route-final.log`。
- `start-e2e.test.ts`：42 passed，exit 0，包含部门 label mismatch/no label/multiple labels/cannot spawn 的 403 与无派单副作用。日志 `/tmp/fly2459-start-e2e-final.log`。
- 新增四个 shell suite 均通过并登记 CI：`codex-runner-capability-env.test.sh`、`lead-backend-migration.test.sh`、`lead-backend-migration-load.test.sh`、`lead-backend-migration-wave.test.sh`。
- 原 admission/restart 接缝 suite：52 passed；generic launcher：33 passed。compiled public verifier 的非法参数返回 64、passed-only evidence 返回 78，无成功 stdout。

## 聚合失败保留，不作绿色声明

`pnpm test:packages:run` 已执行但 **exit 1**：claude-runner 50 文件/1256 passed/2 skipped，另有 onTaskUpdate timeout 未处理错误。日志 `/tmp/fly2459-full-packages-r2.log`。Lead 指令 `[lead-instruction 7029315a-ddf5-43a5-8e7d-65ec85ed3542]` 裁定保留此 host-concurrency false-red 形状，不重跑聚合，未覆盖包单 fork 各跑一次，exact-head CI 为最终依据。

另一次 TeamLead 包聚合也为 **exit 1**：972 文件 passed、5 failed；13133 tests passed、9 failed、7 skipped，另有 timeout。日志 `/tmp/fly2459-teamlead-package.log`。修复本分支的 census/环境 fixture 后，对原五个失败文件单 fork 复跑 51 passed（exit 0），这不改变原聚合红灯。

补包：edge-worker 1321 passed/14 skipped（exit 0）；voice-bridge 649 passed（exit 0）；voice-codex 日志为 122 passed，但未保留原进程 exit receipt，不补造 exit 0。对应日志 `/tmp/fly2459-{edge-worker,voice-bridge,voice-codex}-singlefork.log`。

## 视觉与生产边界

**视觉验收交 QA（真浏览器）。** Lead `[lead-instruction 3aae03fb-a6fd-4fc0-ae62-b8b96dfb3819]` 已裁定不再尝试 ProofShot/Chrome MCP；沙箱不可截屏不算代码缺陷。`console-migration-fixture.html` 保留实际 renderLeadRows 文案/链接的本地 fixture，模型控件为明确标注的 stub，不是生产截图或整页验收。

ProofShot 视频启动失败（recording already active）；独立 Chrome MCP 页面被 approval-policy-never 拒绝。临时预览 Python PID 60974、localhost:53291、cwd `/private/tmp/fly2459-preview` 为本轮创建，停止操作被 EPERM 拒绝，清理尚未确认。未关闭其他浏览器/录制会话。

迁移机器回执仅证明其核验到的来源/账本/当前 host 状态；真实模型/effort、视觉、部门负例和下一次获授权班车复验仍按 `honey-lemon-cutover.md` 交 QA，不以 fixture 或机器状态冒充验收完成。

## R1 阻塞返工（2026-09-11）

`92698c90c` 修正两种真实 carrier argv 与 observer 不匹配的问题；详细 RED/GREEN、执行型 launcher 参数捕获、45 个迁移相关测试、全 lint/build 与四个新增 shell suite 的 exit 0 回执见 `code-review.md`。四条非阻塞 advisory 仅归档。此前“最终产品代码 6d2d6d08e”为 R1 前的历史验证点；新审查需绑定含该修复的新 HEAD。

## R2 与 PR CI

R2 对 `53fefb6fd` 已 APPROVED，无 blocking finding；5 条 advisory 仅归档于 `code-review.md`。草稿 PR 为 https://github.com/xrliAnnie/flywheel/pull/1162。该头的 CI Quick Gate 暴露本单新增 step 未登记进结构测试固定清单，已按原失败→一行补登记→结构及枚举双绿修复；最终头的 review/CI 必须重新核验，不能沿用旧头批准或当前未完成的 CI 结果。

## R4 前完整本地复核

PR #1162 已按 Lead 要求为 ready。R3 对 ebf8fc50d APPROVED；旧 CI 34592040517 的 Quick Gate 与 packaging smoke 失败已按授权同批补齐，详见 code-review.md。最终完整 Quick Gate exit 0，真实 packaging smoke 24 passed/0 failed（含真实安装、isolated Bridge health、真实 auth inspector 和未链接负例）；相关行为55、Gate4 masking13全部通过。历史聚合 exit 1 和旧 CI 红灯保留；新头仍须 R4 与精确头 CI。生产 Honey Lemon 切换不在当前 QA 范围，真浏览器验收由 QA 完成。
