# FLY-2366 Shape 模型白名单 — 实施计划
Issue: FLY-2366 (https://linear.app/geoforge3d/issue/FLY-2366/2356s2-后端开一个只读口暴露-menusshapes-白名单每节点允许的模型effort前端下拉只列模板允许的选项qa-只准)
日期: 2026-09-05
基于: research.md

## 目标

Bridge 从当前唯一 shape 权威 `.flywheel/agents/registry.yaml` 动态构建节点模型 policy；受 master bearer 保护的只读 GET 与管理台 DAG 下拉共享该投影。管理台只能提交 shape 允许的 model/effort，服务端写边界再做同一 policy 的负向校验。

## API 合同

新增 `GET /api/workflow/menu-policies`：

- 鉴权与 `/api/capacity` 同形：配置 `TEAMLEAD_API_TOKEN` 时只接受 master bearer；未配置时固定 503，不继承 token middleware 的 tokenless no-op。
- 成功体 `schemaVersion: 1`，包含 policy projection revision、显示安全的源路径和 `taskCategories[]`。
- 每个 taskCategory 包含 `taskCategory / templateId / label / source`；每个可执行 node 包含 `nodeId / label / type / defaultModel / models[] / allowedSelections[] / source`。
- `allowedSelections[]` 是 canonical `{vendor, model, effort}` tuple；`models[]` 额外携带 provider、显示名、alias、allowedEfforts、defaultEffort 供 UI 使用。
- DAG `<option value>` 明确使用 shape 声明的 **alias**，与 `resolveMenuOverrides()` 的输入身份一致；canonical model 只用于当前值等价匹配和 runtime tuple。当前模板若存 canonical spelling，单纯渲染或选择同一等价项不得静默改写；用户切到另一个 policy model 时才持久化那个 model 的 shape alias。
- 不返回 agent file、项目配置、token、绝对路径或完整 registry。

旧 `GET /api/workflow/menus` 保持语义与鉴权不变，避免把 Lead 菜单 API 扩成另一个职责。

## TDD 批次

### A. Policy builder 与只读 GET

先新增失败测试：

1. master bearer 得到 200，未认证/错误 token 得到 401，未配置 master token 得到 503；
2. `code.qa.allowedSelections` 精确等于当前 shape 的 Opus × `low/medium/high/max`，不含 Fable/Codex/xhigh；
3. response 不含绝对路径或敏感键，source 指向注册表中的具体 shape/node；
4. 临时 registry 删除一行 effort 后 builder 输出立即变化。

最小实现：新增纯 `workflow-menu-policy.ts`，捕获一个 model snapshot，直接调用 `loadWorkflowMenuLibrary()` 把每个 node 的 shape model/effort 展平为稳定 DTO 与 digest；不复制白名单、不另建通用 resolver/校验框架，也不改 `resolveMenuOverrides()` 的既有 alias-only 合同。新增窄 handler，并在 `plugin.ts` 的 capacity 路由旁按相同 auth/fail-closed 结构挂载。

### B. 管理台 projection 与下拉

先扩充失败的 source/DOM 测试：

1. `readManagementDags()` 按 binding.task_category + templateId + nodeId 嵌入同一 node policy；历史/自定义模板无匹配时不伪造来源；
2. `code.qa` DOM 只有 Anthropic/Opus；model option 的 `value` 明确是 shape alias `opus`，label 可显示解析后的 canonical id；effort 只有 `low/medium/high/max`，无“账户默认”和 xhigh；
3. `code.eng_design`/`implement` 精确反映各自 shape model 列表；
4. source 文案显示 shape 与 registry fragment；
5. 临时 registry 单行变化同时改变 builder 与 DOM options；
6. 分别把 `code.qa` 已持久化为 `xhigh` 和 effort 缺席，DOM 必须用不可选的「当前值不在 shape 白名单」marker 原样显示 `xhigh` / `未设置`，不能把首个合法项 `low` 伪装成当前值；model 越界也用同类不可选 marker；
7. 当前 provider 不在 policy 时不得由 `selectedProvider()` 静默选 `catalog.providers[0]`；显示越界 provider/model marker，直到用户明确选合法项；
8. 驱动真实 provider/model `change` event，断言 draft 的 alias、provider 与 defaultEffort 始终属于同一 node policy；
9. 临时 registry 将已绑定具名 taskCategory 的 `templateId` 改名或删除该 shape 后，该 DAG 的 policy 状态是 unavailable 且只读，绝不落入历史模板的全局 catalog 分支；删除用例先把绑定模板设为 `seed_owner=founder`，再断言 `unavailable: policy_shape_removed`、只读且既有 writer preflight 因 readonly 拒绝，与 seed ownership 无关。

最小实现：`ManagementDagNodeView` 增加判别联合 `policy: {status:"ready", ...} | {status:"unavailable", reason} | {status:"not_applicable", reason}`。`readManagementDags()` 在 project/binding 循环外只捕获一次与 GET 共用的 catalog；具名 binding 必须精确匹配 `(taskCategory, templateId, nodeId)` 才是 ready，任一缺失/改名都是 unavailable/read-only。shape 整体缺失使用稳定 reason `policy_shape_removed`。只有既有通配 binding（`*`）是明确的 `not_applicable` 历史路径，保留全局 catalog。policy 解析失败时仍投影 manifest/graph/current value，但所有具名 DAG dispatch 只读，绝不退回全局 catalog。既有 writer 从 node 的 `writeCapability` 得到 readonly 并拒绝，无需新增 policy 校验框架；这里也不引入 binding/template ownership 分类框架。

客户端 `rebuildIndex()` 除 `targetIndex` 外建立 `policyIndex[targetId]`，渲染与 `handleModelChange()` 都从同一 key 取受限 catalog。provider/model 变化从该 policy 选 model，并立即写入对应 defaultEffort；受限 effort 不加入“账户默认”。当前值越界时，model 与 effort 都插入 disabled selected marker（显示真实 persisted spelling/null），合法 options 仍逐项等于 whitelist；provider 越界也不得走首项 fallback。若当前 persisted canonical 等价于所选 alias，draft 保留原 persisted spelling，避免等价重选变成真实 publish。普通 Lead/Runner/Cron 和显式 `not_applicable` 的通配历史模板保持原控件行为。

### C. 管理台提交兼容

先让 DOM/public writer seam 的失败测试证明：QA change event 只能产生 `opus × low/medium/high/max`；合法 QA→Opus+max 能发布；alias 切换后落盘 spelling 保持 alias。

再覆盖等价重选：若 current 是 canonical `claude-opus-5`、用户重选对应 alias `opus` 且 provider/effort 相同，客户端 draft 保留 persisted current，既有 writer preflight 返回 `no_op`，不得创建 revision/publication/audit，也不得把 system seed 的 `seed_owner` 改为 founder。只有真正切换到另一条 policy model 时，draft 才携带并落盘所选 alias。

最小实现仅补 `workflowEffort()` 的合法 `max` 分支，并让客户端的 policy-aware change handler 做 canonical/alias 等价保留；不把本单扩成通用 management writer policy 框架。服务端既有全局 model registry 校验与 `/api/runs/start` 最终 shape 校验保留。

### D. 回归、视觉与交付

运行聚焦测试、类型检查和 Biome；用 in-memory `StateStore` + `importWorkflowMenuSeeds()` + category bindings 构造与生产 shape 同构的 fixture（必要时通过公共 writer 设置 alias/canonical/越界 current），渲染管理台并保存/检查 DAG 下拉截图或等价浏览器 capture，确认来源/越界/同-vendor 文案与三列布局不破坏。禁止复制 672MB 生产 DB；若读取生产只允许只读、零复制核对。随后运行精确全仓门：

```
pnpm lint
pnpm -r build
pnpm test:packages:run
```

并逐个运行本分支新增的 `scripts/__tests__/*.test.sh`（预计无新增 shell 测试）。所有实现提交推送后，经 `codex:rescue` 路径发起 exact-head code review；若有 blocking finding，修复、重跑、推新 head、开新 gate。最后创建 PR，并把 `engineering/doc/milestones/FLY-2366.md` 作为 literal last commit，执行 implement completion route `needs_review`，不派发 QA、不 merge。

## 预期修改面

- `packages/teamlead/src/workflow-menu-policy.ts`（新）
- `packages/teamlead/src/bridge/workflow-menu-policy-route.ts`（新）
- `packages/teamlead/src/bridge/plugin.ts`
- `packages/teamlead/src/bridge/management-console-contract.ts`
- `packages/teamlead/src/bridge/management-dag-source.ts`
- `packages/teamlead/src/bridge/management-dag-writer.ts`（仅补合法 `max`）
- `packages/teamlead/src/bridge/fleet-console-html.ts`
- 对应 `packages/teamlead/src/__tests__/*.test.ts`
- `engineering/doc/FLY-2366-shape-model-allowlist/*`
- `engineering/doc/milestones/FLY-2366.md`（最终提交）

## 明确不做

- 不恢复 `menus/shapes/`，不复制白名单到前端常量。
- 不修改 shape 允许内容，不重写现有 `/api/workflow/menus`。
- 不改变 Lead/Runner/Cron picker，也不扩大 `resolveMenuOverrides()` 的 alias-only 输入合同，不改变已物化 run。
- 不移除 `/api/runs/start` 的最终校验，不新增通用 writer policy 校验框架，不做跨节点 QA/producer vendor 组合求解。
- 不修改 `CLAUDE.md`，不 merge/deploy/dispatch QA。

## 已知边界

本单的 authoritative allowlist 是「taskCategory / node 的 `{vendor,model,effort}` 集合」。`simple_code` 等 shape 还存在跨节点约束：producer 与 QA 不能解析到同一 runtime vendor；单节点各自合法不代表二者组合合法。本单不引入组合求解器或额外提示，服务端既有运行时 `same_vendor_review` guard 保留。后续若要让跨节点组合联动不可选，需单独定义联动编辑语义。

## 完成证据

- policy endpoint auth/DTO/negative tests；
- registry 单行 mutation → endpoint projection 与 DOM option 同步测试；
- persisted 越界 model/effort/null 的如实 DOM marker + provider 不 fallback + change-event draft 测试；
- 具名 binding 的 registry templateId rename/shape removal（含 founder-owned template）→ projection unavailable/read-only + writer readonly 拒绝测试；
- 合法 max/alias publish positive test；
- canonical current 重选等价 alias → no_op、零 revision/audit、seed_owner 不变测试；
- markup/DOM 与 visual capture；
- 三个全仓 gate 全绿；
- exact-head code review APPROVED；
- PR + literal-last milestone commit + `complete --route needs_review --pr <n>`。
