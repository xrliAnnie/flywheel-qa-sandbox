# FLY-2366 Shape 模型白名单 — 调研
Issue: FLY-2366 (https://linear.app/geoforge3d/issue/FLY-2366/2356s2-后端开一个只读口暴露-menusshapes-白名单每节点允许的模型effort前端下拉只列模板允许的选项qa-只准)
日期: 2026-09-05
基于: exploration.md

## 1. 权威数据链

当前 main 的生产链是：

```
.flywheel/agents/registry.yaml graphs.*.policies
  → loadWorkflowMenuLibrary()
  → compileWorkflowMenuSeed()
  → workflow template revision / run materialization
```

旧 S2 所称 `menus/shapes/*.yaml` 已由 FLY-2121 合并进注册表；恢复旧目录会重新引入双真源。`loadWorkflowMenuLibrary({registryPath})` 已有可注入入口，适合让 API、管理台和变更对照测试共享同一解析器。

每个可执行节点的 policy 包含 alias、`allowedEfforts`、`defaultEffort`。`flywheel-config` 的同一代 model snapshot 能把 alias 解析成 canonical model、runtime vendor、provider 与显示名。因此浏览器无需猜 alias/vendor。

## 2. 既有 API 与缺口

`GET /api/workflow/menus?projectName=...&leadId=...` 已存在，但服务的是 Lead 菜单采用流程：

- 只返回该 Lead 采用的菜单；不是 taskCategory 全局 policy catalog。
- 返回 alias / resolvedModel / allowedEfforts，未返回扁平 canonical `{vendor, model, effort}` 集合。
- 只校验 loopback Host，没有 `/api/capacity` 的 master bearer/fail-closed 503 合同。
- `menuVersion` 来自目标项目 Git HEAD，而实际全局菜单来自 Bridge bundled registry，不是准确的白名单 revision。

直接改变这个旧口会影响 generalized deploy smoke 与现有调用合同。因此新增 `GET /api/workflow/menu-policies`，旧口保持不动；新口只读、无 query、只输出 allowlisted DTO。

## 3. 管理台读边界

管理台浏览器刻意不持有 `TEAMLEAD_API_TOKEN`：`/api/fleet/*` 依靠 loopback + same-origin + confirm token。让浏览器直接 fetch 新 bearer API 会破坏这个安全边界。

现有管理台又要求一个聚合读边界 `/api/fleet/snapshot`。最小一致方案是建立一个纯 `buildWorkflowMenuPolicyCatalog()`：

- 新 bearer GET 直接序列化它；
- `readManagementDags()` 同次调用它，并把匹配 taskCategory/template/node 的 policy 嵌入 DAG node DTO；
- HTML 继续只 fetch `/api/fleet/snapshot`。

这不是复制白名单：两条出口都在请求时解析同一注册表并走同一 builder。

## 4. 当前前端为什么会越界

`fleet-console-html.ts` 的 `modelControl()` 不区分普通 workflow catalog 与 shape policy。所有 DAG 节点都使用 `snapshot.modelCatalog.workflow`，并且 effort 总会额外出现“账户默认”。因此 `code.qa` 会看到全局所有 provider/model 以及 `xhigh`，尽管 shape 只允许 Opus 的 `low / medium / high / max`。

约束后的 DAG 控件需要：

- provider 只来自该节点 policy 的 model 集；
- model 只来自所选 provider 下的 policy models；
- effort 只来自所选 model 的 `allowedEfforts`，不插入“账户默认”；
- 切 provider/model 时自动落到该 model 的 `defaultEffort`，不制造瞬时 null；
- 在控件下显示 `shape <taskCategory> · .flywheel/agents/registry.yaml#graphs.<shape>.policies.<node>`。
- 若持久化 current 已越界（包括 model 不在 policy、effort=`xhigh` 或 effort 缺席），必须用 disabled marker 如实显示原值；不能因没有 matching option 让浏览器自动把第一项伪装成 current。
- 渲染和 change handler 必须共用按 `targetId` 建立的 policy index；只收窄 HTML options 而 handler 仍读全局 catalog 会继续制造非法 draft。

Lead、Runner、Cron 仍使用各自全局 model catalog。

## 5. 服务端负向守卫

前端不可达不能替代 HTTP 写边界校验。`applyManagementDagEdit()` 当前只验证全局 workflow model catalog，因此伪造管理台请求仍可把 shape 外的 model/effort 发布进模板。

写入时应在 templateId/nodeId 能唯一匹配内建 shape policy 时，再验证 canonical `{vendor, model, effort}` 是否属于 policy；不认识的历史/自定义模板保留现有全局校验语义。第一道 guard 必须在 management writer preflight，避免 shape 非法值拿到 confirm token；apply 直接调用仍复核，防 TOCTOU/绕过。两处调用同一个从 `resolveMenuOverrides()` 提取的 selection resolver，不能各写一份 membership 判断。另发现 `workflowEffort()` 漏接已被 shape 合法使用的 `max`，本单必须补齐，否则 UI 展示的合法项无法落盘。

## 6. 可执行验证

强对照应复制真实 registry 到临时目录，只改一行（例如从 `code.qa` 删除 `max`），然后证明：

1. policy GET builder 的 QA tuples 立即少一项；
2. 同 catalog 注入 `readManagementDags()` 后，happy-dom 中 QA effort `<option>` 同样少一项；
3. QA 型号只有 canonical Opus，`xhigh` 始终不存在；
4. 伪造 QA→Fable 或 QA→Opus+xhigh 的 management change 被服务端拒绝且 revision/audit 零变化；
5. 合法 QA→Opus+max 能发布。
6. 已持久化 xhigh/null/model 越界时 DOM 如实显示 marker，provider 不静默 fallback；真实 change event 产生的 draft 始终在 policy 内。
7. menu override 与 management writer 对 alias/canonical 等价 selection 使用同一 resolver、给出同一 verdict。

## 7. 风险

- 动态 `models.json` alias 绑定可能改变 canonical model；builder 必须在一次决策中只捕获一次 model snapshot。
- 已持久化的历史非法值可能不在 policy catalog。UI 要显式标出越界值，不能静默回退为全目录；写边界仍允许用户改回合法值。
- 多项目可绑定同一全局 template；policy 按 taskCategory + templateId + nodeId 匹配，避免仅按 nodeId 串形状。
- policy 文件不可读/解析失败时，API 500；管理台仍可显示 manifest/current，但所有 DAG picker fail-closed 为只读并显示 unavailable 原因。历史模板的 no-policy 状态必须与故障状态分开。
- shape alias 是 picker/write identity；canonical model 是 runtime/receipt identity。当前 canonical spelling 映射到同一 alias option 只用于显示，不在无操作时改写；明确切换 model 才落 alias。
- per-node policy 不覆盖 producer/QA 不同 vendor 的跨节点约束；若当前组合同 vendor，UI 明示运行时会拒绝。本单不做联动组合求解。
