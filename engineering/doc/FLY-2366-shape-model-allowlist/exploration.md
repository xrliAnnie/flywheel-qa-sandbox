# FLY-2366 Shape 模型白名单 — 探索
Issue: FLY-2366 (https://linear.app/geoforge3d/issue/FLY-2366/2356s2-后端开一个只读口暴露-menusshapes-白名单每节点允许的模型effort前端下拉只列模板允许的选项qa-只准)
日期: 2026-09-05
基于: 无

## 问题

管理台 DAG 节点会显示当前模板派发值，但复用 workflow 全局模型目录来生成下拉。模板节点自己的允许范围没有传给浏览器，因此用户可以在 QA 节点选到模板不允许的型号或 effort，直到 `/api/runs/start` 才收到 `INVALID_MODEL` / `INVALID_EFFORT`。

FLY-2071 S2 明确要求把失败前移：Bridge 暴露模板节点白名单，DAG 下拉只渲染白名单，并在界面显示策略来自哪份 shape。

## 当前事实

- S2 成文时的 `menus/shapes/*.yaml` 已在 FLY-2121 后收敛为 `.flywheel/agents/registry.yaml`；当前仓库不存在旧目录。
- `packages/teamlead/src/workflow-menu.ts` 的 `loadWorkflowMenuLibrary()` 直接加载该注册表，把 `graphs.*.policies.<node>.models` 映射为节点 `models`，没有第二份白名单。
- `code.qa` 仅允许 `opus`，effort 为 `low / medium / high / max`，确实不含 `xhigh`。
- `/api/capacity` 在配置 `TEAMLEAD_API_TOKEN` 时使用 `tokenAuthMiddleware`，无 token 时返回 503；新只读口应保持同类鉴权与 fail-closed 行为。
- 管理台当前从 `/api/fleet/snapshot` 读取 DAG 当前值和全局 `modelCatalog.workflow`，`modelControl()` 对 DAG 节点仍用全局目录。

## 边界与假设

- 仅收窄 DAG 模板节点下拉；Lead、Runner 默认和 Cron 的下拉不属于 shape 策略，不改变。
- API 返回 runtime 可提交的 `{vendor, model, effort}` 组合，同时保留 shape/template/node/source 元数据；客户端不自行解析 alias 或猜 vendor。
- 结构节点（如 founder gate、land）没有模型下拉，也不应出现在允许组合中。
- 注册表读取或解析失败应显式失败，不能回退为全目录，否则会重新制造非法可选项。
- 本任务不修改模板允许范围，也不修改 `/api/runs/start` 的最终服务端校验；前端约束是额外的早期防线。

## 成功判据

1. 修改注册表里某个节点的一行白名单，API 输出与管理台下拉同步变化，无手工映射更新。
2. 每个 DAG 节点呈现的型号/effort 与其 taskCategory 对应 graph policy 完全一致。
3. 管理台 DAG 编辑路径无法构造 shape 不允许的 model/effort 组合，并显示白名单来源。
4. API 与 `/api/capacity` 使用同类鉴权；无 Bridge token 时明确 503。
