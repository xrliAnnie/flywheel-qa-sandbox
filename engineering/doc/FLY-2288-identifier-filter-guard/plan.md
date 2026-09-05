# FLY-2288 identifier 过滤静默忽略 — 实施计划
Issue: FLY-2288 (https://linear.app/geoforge3d/issue/FLY-2288/bridge-apilinearissues-的-identifier-过滤被静默忽略-查-a-单拿到-b-单格式完好无报错)
日期: 2026-09-04
基于: research.md

## 目标

让 `GET /api/linear/issues` 对未声明 query 参数 fail loud。`identifier` 以及任何其他未知 key 返回 HTTP 400，不再执行未过滤 Linear 列表查询；现有六个参数和响应合同保持不变。

## 非目标

- 不在列表端支持 `identifier`；精确查询继续使用 `/api/linear/issue?query=`。
- 不修改 `queryLinearIssues()` 或 GraphQL 查询。
- 不普查/修复 `project=` 等现有过滤器的完整性。
- 不修改认证、部署、Bridge 进程、数据库或 migration。

## 变更文件

| 文件 | 变更 |
| --- | --- |
| `packages/teamlead/src/__tests__/linear-issues.test.ts` | 增加未知 query 参数的 HTTP 负向回归测试 |
| `packages/teamlead/src/bridge/plugin.ts` | 增加列表端 query key allowlist 与 400 guard |
| `engineering/doc/milestones/FLY-2288.md` | PR 前最后一个 commit 记录里程碑 |

## TDD 步骤

### 1. RED：锁定危险复现

在 `linear-issues.test.ts` 添加参数化测试，分别请求：

- `?identifier=FLY-2140`
- `?identifier=FLY-999999`

每个请求断言：

1. HTTP status 为 400；
2. JSON error 明确包含 `identifier`；
3. `mockRawRequest` 未被调用。

先仅运行该测试文件，确认当前实现返回 200 且调用 Linear mock，测试以预期原因失败。

### 2. GREEN：最小边界校验

在 `plugin.ts` 定义模块级 `Set`，成员严格为当前已接线参数：

```text
project, state, labels, limit, slim, projectName
```

在 `/api/linear/issues` handler 的既有 `LINEAR_API_KEY` 检查之后、任何参数归一化和 Linear 调用之前：

1. 读取 `Object.keys(req.query)`；
2. 过滤 allowlist 外的 key 并排序；
3. 若非空，返回 HTTP 400 JSON，列出不支持的 key 后立即 `return`。

把 501 检查留在原位置，保持未配置 Bridge 的既有错误优先级。重复的已知 query key 仍只有一个对象 key，因此继续走现有数组归一化。

重新运行聚焦测试，确认新测试与现有 `/api/linear/issues` 合同全部通过。

### 3. REFACTOR：只消除必要重复

保持 guard 内联于该单一路由；不抽象新子系统。确认错误字符串确定性、JSON 序列化、无用户输入进入 HTML、无 Linear side effect。

## 验证

遵守 Lead 指定的单包、单线程测试约束，并排除真实 macOS Terminal 测试：

```bash
VITEST_MAX_THREADS=1 VITEST_MIN_THREADS=1 pnpm --filter flywheel-teamlead exec vitest run src/__tests__/linear-issues.test.ts
pnpm --filter flywheel-teamlead build
pnpm lint
```

现有测试同时覆盖无参数 200、已知 filter 传递、重复 state/labels、limit、slim、projectName binding、501/502。没有 migration 或持久状态，本变更的 restart/replay/rollback 证明分别为：新 app 实例在每个测试启动时重新挂载同一 guard；同请求可重复得到 400 且不触发 upstream；回滚只需 revert 实现 commit。

按 Lead 指令不运行 `pnpm -r` 或 packages-wide 测试；PR test plan 明确列出实际执行的命令。

## 交付顺序

1. plan 提交后设置 `design_review`，按注入流程注册设计 review，等待 APPROVED。
2. 设计批准后尽早 push 并创建面向 `main` 的 PR，body 含 Linear 链接和 test plan。
3. 严格执行 RED → GREEN → REFACTOR，小 commit 推送并更新进度账本。
4. 完成聚焦测试、teamlead build、lint；运行 `codex:rescue` code review。
5. 注册 `review_code` gate；review 期间不 push。若 CHANGES_REQUESTED，批量修复、一次 push、开新 review。
6. code review APPROVED 后不再运行会移动 head 的 progress 命令，也不追加 docs-only commit；用 PR body 补充最终证据。
7. `engineering/doc/milestones/FLY-2288.md` 必须在 code review 前作为字面最后一个 commit 创建，随后保持 reviewed head 不变。
8. 最终运行 `complete --route needs_review --pr <NUMBER>`；不 dispatch QA、不 merge、不 deploy。
