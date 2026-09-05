# FLY-2142 依赖账本 — 实现证据
Issue: FLY-2142 (https://linear.app/geoforge3d/issue/FLY-2142/2108c-依赖账本初始批次-三类动态更新减法不许丢)
日期: 2026-09-04
基于: implementation-notes.md

## A7 · 真 Linear 写读闭环

实例：隔离端口的本机临时 Bridge，运行本分支构建产物；关系、历史与评论写入真实 Linear。只使用 Lead 已授权的两张一次性探针单 `FLY-2325`（blocker）和 `FLY-2326`（blocked），未触碰 FLY-2108 及其四条现有边，也未给任何真实子单加评论。临时快照只把这两张 Backlog 探针投影为本地 active scope，不改变远端 issue 状态或 parent。

操作序列与结果：

| 步骤 | operation / relation | 结果 |
|---|---|---|
| add | `149d78b5-fabf-4506-931f-68a681662d27` | exit 0；`status=added`；`ledger.recorded=now`；写后环复查 `cycle=false` |
| show | — | exit 0；只输出 `ready=[]` 与一条 `all_blocked` 审阅项，边为 `FLY-2325 → FLY-2326` |
| remove | op `8f17f718-9cb6-4d29-9e5a-e50cc19604e0`，relation `149d78b5-…` | exit 0；`status=removed`；`kind=not_needed`；`ledger.recorded=now` |
| note（同 remove op、同内容重放） | `8f17f718-9cb6-4d29-9e5a-e50cc19604e0` | exit 0；`ledger.recorded=already`；复用评论 `7b4ea8c4-…` |
| log | `FLY-2326` | exit 0；同时列出裸 Linear 历史与两条可解析 ledger 评论；`truncated=false` |

GraphQL 对照：

- add 前 `inverseRelations=[]`；add 后为 `[149d78b5-fabf-4506-931f-68a681662d27]`；remove 后再次为 `[]`。
- 本次 add 历史：`2026-09-04T09:28:18.994Z`，code `ab`，other `FLY-2325`，actor `Xiaorong Li`。
- 本次 remove 历史：`2026-09-04T09:28:21.471Z`，code **`rb`**，other `FLY-2325`，actor `Xiaorong Li`。
- add 评论 `47ff87fc-7c8d-418a-9c1f-9a284149d83b`；remove 评论 `7b4ea8c4-7ee5-4869-98ad-bf43be6f6adb`。note 重放后仍只有这两条本次评论。

## Linear 评论渲染结构

两条评论经 Linear GraphQL 重新读取，`body` 首行分别原样为：

```text
[dependency-ledger] missed: FLY-2325 blocks FLY-2326 — added · FLY-2142 A7 missed dependency drill
[dependency-ledger] not_needed: FLY-2325 blocks FLY-2326 — removed · FLY-2142 A7 not-needed subtraction drill
```

第二行均以 `dl1:ey…` 开头。Linear 自己生成的 `bodyData` 对两条评论均为：

```json
{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"[dependency-ledger] …\\ndl1:…"}]}]}
```

该 ProseMirror 结构只有纯文本节点、无 marks，证明首行方括号和完整 base64url 机器行未被改写为链接、强调或其它富文本节点，可按原文复制。浏览器 MCP 导航因本执行的 `approval policy=never` 被拒，故没有伪造 UI 截图；采用 Linear 返回的实际渲染文档结构作为可执行对照证据。

## 探针清理

archive 前 fail-closed 复核：两张单标题仍以 `[FLY-2142 探针·可删]` 开头，且各自 `relations=0`、`inverseRelations=0`。`archiveIssue` 两次均返回 `success=true`；fresh GraphQL 读回 `FLY-2325.archivedAt=2026-09-04T09:30:27.179Z`、`FLY-2326.archivedAt=2026-09-04T09:30:27.486Z`。探针已清理，关系和评论仍由 Linear archive 历史保留。

## 最终门禁

代码审阅前的自查另补了三条负向保护：`dependency_review` 的 5000 上限按三类合并结果计算；`discover` 的关系已写但评论失败会保留响应并打印完整 `note --backfill`；建单 5xx 视为结果未知并提示查重，写后成环或复查超界分别打印减边或 `show` 命令。每项都先见到定向测试失败，再做最小实现并转绿。

所有 Vitest 均以 `VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1` 且 `--maxWorkers=4` 运行，并显式排除 `packages/core/test/tmux-viewer.macos.test.ts`。遵照 Lead 的 2026-09-04 并行度红线，未运行 `pnpm test:packages:run` 或任何全仓并行测试；`pnpm -r build` 改为三个相关包按依赖顺序逐个构建。此次没有新增 `scripts/__tests__/*.test.sh`。

`pnpm lint`（exit 0；以下为原始尾部）：

```text
Checked 2830 files in 2s. No fixes applied.
Found 14 warnings.
```

14 条均是本分支外的既有 warning；首轮曾唯一报错为本分支新增 export 顺序，机械重排后重跑为 exit 0。

相关测试（全部 exit 0；原始尾部）：

```text
packages/config
Test Files  1 passed (1)
Tests       3 passed (3)

packages/teamlead（本单 11 个测试文件 + 不变的 lead-rules-bundle）
Test Files  11 passed (11)
Tests       214 passed (214)

packages/teamlead（scoped-token 反向兼容）
Test Files  1 passed (1)
Tests       23 passed (23)

packages/flywheel-comm（dependency + shell-quote）
Test Files  2 passed (2)
Tests       31 passed (31)

packages/flywheel-comm（qa-result shell-quote 回归）
Test Files  1 passed (1)
Tests       92 passed (92)
```

合计 363 项通过。

顺序构建（全部 exit 0；原始尾部）：

```text
> flywheel-config@0.1.0 build
> tsc && rm -f dist/three-stage-phases.* dist/__tests__/three-stage-phases.test.*

> flywheel-teamlead@0.5.0 build
> tsc && node -e "...build-identity.json..." && ... && cp -r static dist/static

> flywheel-comm@0.1.0 build
> tsc
```

CLI 帮助探针输出六个稳定子命令 `add|remove|note|discover|log|show`；`dependency --help` 按当前通用参数解析合同同时返回 `invalid_arguments`/exit 1。

## Code review R1 修复后的验证

处置提交：`b08c447eb`（Backlog descendant scope）、`33cbd48e6`（其余 review gaps）与 `b585abafe`（显式证明 timeout 后同 project 队列继续）。每项行为修复都先观察定向测试红，再做最小实现转绿。

- `pnpm lint`：exit 0；2830 files，14 条均为既有 warning。
- `flywheel-teamlead` 定向 11 文件：199/199 通过，包含 dependency route、真实 active-scope 查询、Epic 生成/守卫/渲染和 create-issue。
- `flywheel-comm` 定向 2 文件：31/31 通过；discover partial failure 不再回显注入的 token/path detail。
- `flywheel-config` 合同测试：3/3 通过。合计 233/233。
- 逐 package `typecheck`：`flywheel-config`、`flywheel-teamlead`、`flywheel-comm` 全部 exit 0。
- 逐 package `build`：上述三个 package 按依赖顺序全部 exit 0。
- 没有新增 `scripts/__tests__/*.test.sh`。

Lead 交接明确要求 `VITEST_MAX_THREADS=4 VITEST_MIN_THREADS=1`、单 package、禁止 `pnpm -r` 与 `pnpm test:packages:run`；本轮严格遵守，没有用较窄测试冒充被禁止的全仓门。
