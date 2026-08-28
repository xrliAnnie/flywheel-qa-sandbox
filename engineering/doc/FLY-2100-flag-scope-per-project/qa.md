# FLY-2100 flag scope 逐项目 — QA 报告

Issue: FLY-2100 (https://linear.app/geoforge3d/issue/FLY-2100/flaga地基-flag-values-加范围列全项目-项目名逐项目-名册-scope-生效-解析顺序-项目默认-管理台按项目读-db)
日期: 2026-08-27
基于: plan.md

## 结论

代码、数据迁移、CLI 与隔离真 Bridge 验收通过。`doc_flow` 的项目行、`*` 行、
config 回落三层解析结果与手机管理页的 DB 行状态一致；`mailbox_queue` 的项目 scope
写入由服务端以 400 拒绝。唯一未取得的验收物是浅色页面截图：本执行环境拒绝所有
Chromium/macOS 图形启动与本地页面 connector 导航，详见「视觉验证」。未伪造或以
markup 截图代替真实浏览器证据。

## 自动化验证

| 检查 | 结果 | 说明 |
| --- | --- | --- |
| 变更聚焦单测 | 通过 | config resolver/store policy/scan、StateStore migration/scoped CRUD、Bridge routes/enrich/render、CLI 与命令 builder 均通过 |
| `pnpm lint` | 通过 | 0 error；15 个 warning 均位于本单未修改的既有文件 |
| `pnpm -r build` | 通过 | 全 workspace 拓扑构建完成 |
| `pnpm test:packages:run` | 环境性非零，逐项复验通过 | 首轮只有 macOS Terminal Apple Events 失败及并行资源超时；禁用真实 `osascript` 并把 workspace concurrency 降为 1 后，仅剩 1/1642 个 `flywheel-comm` CLI 用例触发 5 秒超时；该精确用例单独运行 1.389 秒通过 |

首轮并行执行中出现的 `claude-runner` profile / real-tmux 超时均在单 worker 下精确
复验通过（6 个原失败用例全绿）。第二次全包执行的唯一失败为与本单无关的
`FLY-1715: runner ask/check/gate/ack use ingest nudges without reading the disk master token`；
单独复验结果为 1 passed、49 skipped、exit 0。真实 macOS Terminal 用例需要 Apple
Events 权限，本 sandbox 无该权限，因此第二次全包执行通过 PATH shim 让测试按其
既有「无 osascript 平台」分支跳过；shim 未进入版本库。

## 隔离真 Bridge 验收

Bridge 使用独立 HOME、独立 `projects.json`、独立 SQLite DB 与端口 `19876` 启动，
未接触生产 Bridge。名册包含 `flywheel` 与 `sandbox`；config 基线分别为
`doc_flow=false` 与 `doc_flow=true`。

| 操作后状态 | DB `*` 行 | DB `flywheel` 行 | flywheel effective | sandbox effective | 来源验证 |
| --- | --- | --- | --- | --- | --- |
| 初始 | 无 | 无 | false | true | 两项目均回落 config |
| `set doc_flow off --project '*'`；`set doc_flow on --project flywheel` | false | true | true | false | 项目行 → `*` 行 |
| `clear doc_flow --project flywheel` | false | 无 | false | false | `*` 行覆盖两个项目 config |
| `clear doc_flow --project '*'` | 无 | 无 | false | true | 无 DB 行后逐项目回落 config |

使用真实 CLI 经 `/api/fleet/flag/stage` → `/api/fleet/flag/apply` 完成上述写入。SQLite
直接核对得到 `doc_flow/* raw=0` 与 `doc_flow/flywheel raw=1`；手机管理页原始 HTML
同时含相同的 `data-ffp-state`（`*` present/off、`flywheel` present/on、
`sandbox` absent）、项目下拉与带 shell quoting 的 `--project` 命令。

清值后两行均从 `flag_values` 删除。`flag_value_changelog` 保留四条带 scope 的
`set/set/clear/clear` 记录；clear 的 `to_effective` 为约定哨兵 `inherit`。

负向验收：

- `feature-flags set mailbox_queue on --project flywheel` 返回 exit 1，stage 为 HTTP 400。
- 未登记项目、非 project-store 白名单 flag 与 scoped CAS 过期路径由路由/StateStore
  单测覆盖并 fail-closed。

## 视觉验证

页面 markup 与状态机测试通过，且真 Bridge 返回的浅色 phone report HTML 已人工核对
结构（卡片、项目下拉、继承/on/off/clear 状态映射、命令预览）。但无法产出真实页面
截图：

- `proofshot` skill 在本 runtime 未安装；
- Google Chrome 直接 headless 启动 exit 134；Playwright Chromium 因
  `MachPortRendezvousServer ... Permission denied (1100)` 退出；
- Chrome connector 对 `http://127.0.0.1:19876` 的页面导航要求交互 approval，而本
  runner 的 approval policy 为 `never`；
- 原始 report 文件仍含服务端发布时才替换的 `__CSP_NONCE__`，因此不把 raw HTML
  交给 `verify-report` 冒充已发布页面。

因此本报告不附截图；需由具备浏览器/Screen Recording 权限的 QA 节点在同一管理页
补拍浅色证据。功能与 HTML 合同的验收不受该宿主权限限制。

## 清理

隔离 Bridge 已正常停止，端口确认释放。QA HOME、SQLite/WAL 与临时 Chrome profile
均已移出 worktree，未进入提交。
