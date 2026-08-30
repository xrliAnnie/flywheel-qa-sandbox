# FLY-127 部门范围启动守卫 — 探索
Issue: FLY-127 (https://linear.app/geoforge3d/issue/FLY-127/lead-spawns-runner-for-tasks-not-assigned-to-its-department)
日期: 2026-08-30
基于: 无

## 问题复述

2026-05-05 的事故里，Annie 把 GEO-366、GEO-101 指给 Oliver（ops），把 GEO-371 指给 Peter（product），但 Peter 也为两个 ops issue 启动了 Runner。正确不变量是：一个 issue 只能由其 department label 对应的、具备启动权限的 Lead 启动；其他 Lead 对被明确指给别人的启动消息保持安静，任何误入服务端的越权请求也必须在 dispatch 前被拒绝。

## 当前仓库事实

本次 worktree 基于较新的 `origin/main`，已经包含 FLY-127 的原始三层修复：

1. `packages/teamlead/lead-rules-base/cos-lead-rules.md` 要求 CoS 按 Lead 拆分启动指令。
2. `packages/teamlead/lead-rules-base/department-lead-rules.md` 定义 Action Gate、被动跨部门消息静默和多 Lead 启动指令拒绝规则。
3. `packages/teamlead/scripts/claude-lead.sh` 只给非 CoS department Lead 注入上述规则。
4. `packages/teamlead/src/department-registry.ts` 以项目、Lead 和 Linear department label 判定启动权限。
5. `packages/teamlead/src/bridge/runs-route.ts` 在 `POST /api/runs/start` 的 dispatch 前执行硬校验，越权返回 `403 DEPT_SCOPE_REJECT`。
6. `packages/teamlead/src/__tests__/start-e2e.test.ts` 已分别覆盖 Peter→Ops 拒绝和 Oliver→Ops 放行。

因此本节点不能诚实地把现有实现当作新代码重写。需要补的最小、对验收有价值的证据，是把两个独立断言合并成同一事件序列：同一个 Ops issue 先收到 Peter 的请求，再收到 Oliver 的请求，最终 dispatcher 恰好调用一次且归 Oliver 的请求所有。

## 约束与假设

- department 归属继续以项目配置中的 Lead label 映射为唯一真相，不引入消息文本关键词授权。
- 服务端守卫继续 fail-closed；不把 prompt 自律当作唯一安全边界。
- 不修改已经上线的响应契约或 feature-flag 语义。
- 本任务没有 UI/rendered surface，因此不需要 proofshot；验证面是 HTTP 路由、dispatcher 调用和规则文件注入。
- 角色指令明确要求不改 `CLAUDE.md`。验收中的“CLAUDE.md / docs”采用 docs 分支：现有 `department-lead-rules.md` 是运行时规则文档，本 PR 再以 `engineering/doc/milestones/FLY-127.md` 固化交付摘要。

## 方案比较

### 方案 A（推荐）：保留现有实现，补精确的成对回归证据

在现有 route-level e2e suite 中增加一个场景，连续向同一 Ops-labelled issue 发出 product-lead 与 ops-lead 两次请求。断言前者 403、后者 200、dispatcher 最终只启动一次。优点是直接对应 acceptance 3，且不改变已上线行为；代价是它是回归强化，不会产生新的 production code diff。

### 方案 B：重写或另加一层 department scope 实现

会与 `DepartmentRegistry` 和 `runs-route.ts` 重复，增加双重真相和漂移风险，也不改善已满足的验收。否决。

### 方案 C：只写文档并重跑现有测试

风险最低，但现有 Peter-reject 与 Oliver-allow 是两个独立 case；读者需要自己推导“同一消息只有 Oliver 启动”。证据不如方案 A 直接。否决。

## 设计结论

采用方案 A。生产实现保持不动；新增一个精确 acceptance regression，随后执行 focused suite、全仓 gate 和 code review。文档明确说明本节点是在较新基线上的验收补强，避免虚报“新实现”。
