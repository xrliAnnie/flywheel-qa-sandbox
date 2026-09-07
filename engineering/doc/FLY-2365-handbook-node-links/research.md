# FLY-2365 角色卡与 DAG 节点重连 — 调研
Issue: FLY-2365 (https://linear.app/geoforge3d/issue/FLY-2365/2356s1-角色卡-dag-节点重新连上manifest-在不恢复-role-的前提下给节点带执行手册引用schema-3)
日期: 2026-09-06
基于: exploration.md

## 1. 权威现状

### 1.1 FLY-2121 的不可回退边界

FLY-2121 最终方案不是“把 role 改个名字”，而是两层 registry：graph node 用稳定 registry node name，node `type` 只描述行为，`label` 只负责展示，项目 overlay 决定该 handbook identity 在项目内落到哪个文件。系统生成的新 manifest schema 2 不再写 `role`；历史 schema 1/2 的兼容只用于读取与重放，不能成为新写路径。

因此本单的新引用必须是第四个单义字段：`handbook_ref = registry node name`。它既不是 config 中的 label-dispatch agent key，也不是会移动的文件路径。

### 1.2 生产 6 项目快照（2026-09-06 只读核验）

`GET http://127.0.0.1:9876/api/fleet/snapshot` 当前有且只有 6 个项目；每个项目都展示相同的 6 个全局 DAG。可执行 handbook identity 的并集是：

```
eng_design, implement, qa, pm, product_design, proto, general
```

角色卡却来自每个项目 `.flywheel/config.yaml` 的 `agents:`：

| 项目 | 角色卡数 | 当前形态 |
|---|---:|---|
| flywheel | 7 | registry 已激活；有 qa/pm/product_design/proto/general，但没有 graph-only 的 eng_design/implement 卡 |
| geoforge3d | 8 | legacy backend/frontend/designer/product/qa/operations/marketing/general |
| growth | 2 | legacy xuanxue/reflection |
| joycon-typeless | 5 | legacy research/software/hci/designer/general |
| personal-assistant | 1 | legacy life |
| tidal-echo | 2 | legacy content/sub-content |

除 flywheel 外，5 个项目没有 project registry overlay；其中只有 personal-assistant 仍有一条 `ic-roster.yaml` 的 `general` 映射。也就是说，“把 `handbook_ref` 和现有 config 角色卡 id 做字符串比较”无法满足 6 项目验收，且会把未激活项目的真实缺口藏掉。

Lead 已通过问题 `33075c00-dc57-4c35-bf7d-fedab7d200dc` 裁定：**只允许显示项目运行时真正会用的手册**。flywheel（registry 已激活）必须为每个 agent node 提供唯一角色卡；legacy 项目不得塞入 Flywheel registry 卡冒充绑定。本单不得顺手迁移那 5 个项目 overlay。Round 1 设计审查证明原拟完整原因“仍用旧项目手册”不符合真实文件状态；Round 2 又证明 blanket“没有手册可关联”漏掉 personal-assistant 的真实例外。Lead 最终通过问题 `3b9a8790-5c8e-445a-895b-a225c6734c1c` 裁定按节点验证：registry 精确 ref 匹配；legacy 仅在 `resolveNodeAgentFile` 与角色卡 realpath 后的 canonical agentFile 逐字相等时关联；其余按实际缺口明示。不得进一步推断 DAG 会失败。

## 2. schema 3 的全链路影响

### 2.1 template manifest

`packages/teamlead/src/workflow-template.ts` 当前：

- `WorkflowManifestNode` 仍保留历史 `role?` / custom `agent_file?`；
- schema 2 exact-key parser 接受历史 role，但 `compileWorkflowMenuSeed()` 不再产生；
- `validateWorkflowManifest()` 只接受 1 / 2；
- land / gate 必须拒绝所有执行字段。

增量方案：

- 新增 `WorkflowManifestV3Legacy` / `WorkflowManifestV3Land`，拓扑与 schema 2 相同；
- node 追加 `handbook_ref?: string` 共享类型字段，仅 schema 3 exact-key parser 认识且要求所有 agent 执行节点非空；schema 3 禁止 historical `role`，无 custom `agent_file` 时 ref 必须等于 node id，有 custom file 时 ref 必须等于该 file；schema 1 / 2 仍拒绝 ref key；
- `handbook_ref` 非空、使用 registry identity 字符串；gate / land 明确禁止；
- `compileWorkflowMenuSeed()` 输出 schema 3，并在每个 agent 执行 node 上填 node registry name；不恢复 `role` / `agent_file`。

“缺失时页面明示”由 schema 1/2 老 manifest 与 nullable management DTO 覆盖；schema 3 不发布缺 ref 的新模板。系统种子完整性再由编译器测试和 registry 对照测试双重保证。

### 2.2 pinned snapshot

snapshot 当前强制 `snapshot.schema_version === manifest.schema_version`，而运行入口、replay、release-state SQL 都把 generalized workflow 写死为 2。为了不制造“snapshot 2 内嵌 manifest 3”的双重版本语义，采用同步新增 `WorkflowRunSnapshotV3`：

- 新增 `buildWorkflowRunSnapshotV3()`；V2 builder 与所有历史 V2 测试保持原样；
- V3 builder 解析 schema 3，但严格沿用 V2 的 `agent_file` → historical `role` / bundled node id 解析顺序；`handbook_ref` 只随内嵌 manifest 被 snapshot 封存，不参与 agent content、dispatch 或 replay；
- `parseWorkflowRunSnapshot()` 接受 1 / 2 / 3，2 与 3 都要求 pinned effort / generic agent；digest 仍对完整 manifest 与 snapshot 重算；
- `StateStore.materializeWorkflowRun()` 对 schema 2 用 V2 builder，对 schema 3 用 V3 builder；fresh selection、replay、founder claim、generalized execution classification、release-state SQL 都把 2 / 3 视为 generalized；schema 1 仍只读/legacy。

必须同步的硬编码点：

- `workflow-template-selection.ts` candidate `1 | 2 | 3`；fresh 1 返回 legacy，2/3 进 engine；
- `bridge/runs-route.ts` candidate union、generalized replay predicate 与 entry predicate；保留 DB `entry_kind = workflow_v2` 作为既有协议名，不做无关迁移；
- `StateStore.ts` expected selection union、materializer、generalized admission、founder terminal fallback、`rev.schema_version = 2` 四条 SQL 改为 `IN (2,3)`；已有 `activeSchema2Runs` 字段名为外部兼容保留，注释改成 generalized；
- `workflow-catalog-migration.ts` 新 seed 的 resolvable handbook census 纳入 schema 3；founder-owned schema 2 的 legacy role 风险诊断保留；
- `workflow-run-snapshot.ts` union、`validatePinnedWorkflowManifest`、parser body 重建与 V3 builder；任何只需 generalized 语义的 `=== 2` 改为 2/3，但不得让 agent resolver 读取 `handbook_ref`。

## 3. 管理台投影

### 3.1 DTO

- `ManagementRoleView` 追加 `handbookRef: string`，它来自 `ResolvedAgentConfig.nodeName` 或 resolved registry node name，不再从卡片显示名/路径猜。
- `ManagementDagGraphNode` 追加 `handbookRef: string | null`。schema 3 取 manifest `handbook_ref`；schema 1/2 与缺字段均为 `null`。
- 管理台 snapshot version 保持 2：这是只读 DTO 的向后兼容增量，老页面忽略，新页面对字段缺失按 null 处理。

### 3.2 角色卡集合

`loadFeatureFlagProjectConfigs()` 当前仅在 config agents 含 `node:` 时构造完整 `ResolvedProjectRegistry`，却只把 `resolvedAgents` 放进 cache；`buildTopologyView()` 因而只能画 label-dispatch agents。cache stamp 还只看 config.yaml，不看项目 overlay / bundled registry。

按 Lead 裁定：cache 保留 `resolvedRegistry`，角色卡在 registry 已激活项目中优先从其 `nodes` 去重生成；legacy 项目维持 config 卡，并只读 ic-roster，将 roster ref 与角色卡路径 realpath 后精确匹配。personal-assistant 的 `general` 因而唯一命中 `life` 卡；无 roster、roster 未配置该 ref、或已解析文件未命中唯一卡分别显示真实原因。不能拿目标项目 GitHub repo 拼一个实际不存在的 bundled 路径。

“已激活”必须复用运行时 `projectUsesAgentRegistry(projectRoot)`（flywheel 项目名或 overlay 文件存在），而不是 `agentConfigsRequireRegistry(cfg.agents)`。两者分叉时，前者决定 console 的 active 状态和 registry 卡集合；registry 解析失败要保留 active=true 并 fail-visible，不能静默降级到 legacy 卡。cache identity 同时纳入 config、项目 overlay、bundled registry 三个源，避免角色卡长期陈旧。

## 4. 前端交互与失败显示

当前 `fleet-console-html.ts` 的 DAG chip 是绝对定位 `<div>`，角色卡是 `<a>` 或 `<div>`。实现不加新路由：

1. 角色卡渲染 `data-handbook-ref`。
2. agent DAG node 查找当前项目角色卡中相同 ref 的集合；恰好 1 个才标记 linked。
3. linked chip 支持 mouseenter/focus 高亮对应卡，mouseleave/blur 清理；click/Enter/Space 滚动并聚焦对应卡。
4. ref 缺失、悬空或重复时 chip 副标题显示“未关联”，`title` 说明原因，不绑定跳转。
5. gate / land 保持“人工审批 / 引擎执行”，不显示未关联。
6. 仓库当前并不存在字面“两套颜色互不对应”；本单保留真实存在的产品/工程 `layNote()` 分类说明，并新增独立关联交互说明。静态颜色仍按 node type，临时高亮才表达 handbook 关系。

选择器不拼接用户值：遍历 `[data-handbook-ref]` 后比较 dataset，避免 selector 注入；所有属性/文字仍经 `esc()`。

## 5. 测试矩阵

### 5.1 schema / runtime

- RED：内置 seed 仍是 schema 2 或任一 agent node 无 `handbook_ref`；GREEN：6 graph 全部 schema 3，agent refs 精确等于 registry node identity，gate/land 无 ref/role/agent_file。
- schema 2 fixture 继续 validate、materialize、snapshot parse 与 management render。
- schema 3 ref 随 manifest pin 入 snapshot；把 ref 改成与 node id 不同，agent 内容/digest 与 dispatch 仍不变，证明 metadata-only。
- snapshot 1/2/3 parse；unknown 4 fail；manifest/snapshot version mismatch 与 digest mismatch fail。
- fresh selection、idempotent replay、generalized admission与 release-state 各至少一条 schema 3 阳性；既有 schema 2 回归保持。

### 5.2 management source / DOM

- source：schema 3 graph node 投影 ref；schema 2 投影 null。
- topology：同一 handbook identity 只出一张卡；config alias 不改变 `handbookRef`；缺 registry 的 legacy fallback 保持。
- DOM：hover/focus/click 高亮并定位唯一卡；schema 2 缺 ref显示“未关联”；悬空 ref 同样明示；重复 ref 是 registry Record 结构不可达的防御分支；gate/land 不误报；HTML 特殊字符被转义。
- 对照：flywheel 每个 DAG agent node 的匹配数必须精确等于 1；personal-assistant/general 必须唯一命中 life 卡并说明 ic-roster 同文件关系；geoforge3d 等其余 legacy 节点为 0 且逐个显示实际原因。零静默、零假卡。

### 5.3 可视验证

复用 FLY-2364 的本地只读 console harness 形状，先抓真实 `/api/fleet/snapshot`：项目名、DAG id/templateId、registry active 是 fail-closed 不变量，ref 与 role-card 集合是部署前后预期变化，只记录 delta。再构造 6 个项目页、6 个 DAG 与 handbook 卡；Playwright 断言 flywheel 与 personal-assistant/general 对应卡高亮，其他 legacy 节点短文案“未关联”且 title/aria 给出完整原因并截图。另以 schema 2 卡做阴性截图。请求监听要求全程只有 GET，console error / pageerror 均为 0。

## 6. 风险与回滚

| 风险 | 守卫 |
|---|---|
| 只升级 template，fresh run 入口仍只认 2 | selection + runs-route + StateStore + snapshot 的 schema 3 E2E |
| 把 node id 当成 UI 隐式 ref，未来改名再断 | manifest 显式 `handbook_ref`，只有管理投影读取；runtime resolver 保持现状 |
| schema 2 整卡报错而非 node 退化 | management source/DOM schema 2 对照 |
| 一 ref 多卡时随便跳第一张 | 匹配数必须恰好 1；否则未关联 |
| legacy 5 项目的 6-page 验收被伪造 | harness 运行前抓真实生产 snapshot 并逐项 fail-closed 对照 fixture |
| 回滚后新 schema 3 revision 无法被旧代码读 | 首选保留 decoder 停生成；整体降级前先用兼容版本发布 schema-2 current revision并核 verified backup |

## 7. 设计审查 Round 1 与范围收口

- 设计审查 `f468548d-cdcd-421b-aa8f-ae62ce167b87` 返回 `CHANGES_REQUESTED`。blocking finding `legacy-unlinked-reason-false` 指出：5 个 legacy 项目中 4 个连 `.flywheel/menus/ic-roster.yaml` 都没有，节点上写“仍用旧项目手册”会把“没有角色卡关联”误写成“有可用 fallback”。Lead 采纳这部分，但拒绝审查员与初稿进一步推断运行必然失败：生产项目仍通过默认/通用执行体正常派发。
- Lead 指令 `[lead-instruction 2c478130-7d92-430c-a12d-f5f90715edb8]` 同时收紧技术边界：`handbook_ref` 是管理台派生元数据，不得成为运行时 agent resolver 的新输入；dispatch / selection / admission / replay 行为必须保持不变。运行时消费该字段降为 Residuals。
- 审查还指出 active predicate 分叉、fixture 未与生产 snapshot 对账、旧文案断言为空、回滚漏掉 DB revision 发布、chip 长文案必然截断等问题；以上均已进入修订计划。

## 8. 设计审查 Round 2 与逐节点 legacy 真值

- Round 2 `fa0a4246-dda5-4e6e-bc6b-7c5dc59899c3` 的 blocking finding `legacy-blanket-reason-ignores-ic-roster` 实测 personal-assistant 的 `ic-roster general → .flywheel/agents/life/life-executor.md`，与唯一 `life` 角色卡指向同一真实文件。
- Lead 裁定不再把 5 个 legacy 项目一刀切：registry 项目按 ref 精确命中；legacy 项目 only-if `resolveNodeAgentFile` 与角色卡 canonical agentFile 规范化后逐字相等。计算只读、不落库、不改 runtime resolver、不做模糊匹配。
- 其余 advisory 收口：schema 3 authoring 禁止 ref/runtime identity 分叉；production baseline 区分不变量与预期 delta；保留产品/工程分类说明并新增 handbook 说明；required ref 增加显式 RED；registry 源进入 cache stamp；PR body 单列 admission/SQL/founder fallback 三类静默硬编码点。
