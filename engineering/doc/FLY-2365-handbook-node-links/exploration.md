# FLY-2365 角色卡与 DAG 节点重连 — 探索
Issue: FLY-2365 (https://linear.app/geoforge3d/issue/FLY-2365/2356s1-角色卡-dag-节点重新连上manifest-在不恢复-role-的前提下给节点带执行手册引用schema-3)
日期: 2026-09-06
基于: 无

## 1. 问题重述

FLY-2121 把 workflow 的稳定 node id、行为 type、展示 label 与执行手册实现拆开，并让系统生成的新 manifest 升到 schema 2 后不再写 `role`。这个决定消除了 `design` 同时表示 graph、node、执行者的命名互撞，也避免重新引入靠别名派工的兼容层；历史 schema 1 只由永久 decoder 读取。

管理台当前因此有两份无法连接的数据：

- DAG 图来自已发布 manifest，只知道 node `id` / `label` / `type` / 模型绑定；
- 左侧角色卡来自项目已解析的执行手册配置，只知道配置项 id、registry node name 与手册文件；
- 前端只能按 node `type` 着色，无法回答“这个节点使用哪份执行手册”。FLY-2071 S1 只能如实写成“两套颜色互不对应”。

本单必须补一条新的、语义单一的引用边，不能把已退役的 `role` 恢复成万能字段。

## 2. 已核实的当前链路

### 2.1 manifest 生成与解析

- `.flywheel/agents/registry.yaml` 是 graph 与 handbook node 的事实源；graph 的可执行 node 名直接引用 `nodes` 注册名。
- `compileWorkflowMenuSeed()` 当前生成 schema 2 manifest，并故意不写 `role`。
- `validateWorkflowManifest()` 严格按 schema 1 / 2 分派；schema 2 用 exact-key 校验。
- pinned workflow snapshot 目前只接受 manifest/snapshot schema 1 / 2，因此 schema 3 不能只改生成器，必须贯通模板解析、snapshot materialization / replay 与选择入口。

### 2.2 管理台投影与角色卡

- `management-dag-source.ts` 把已发布 manifest 投影成 `ManagementDagGraphNode`；当前没有执行手册引用。
- `management-topology-source.ts` 从 `resolvedAgents` 生成角色卡；卡片 id 取 config agent 名，而真正稳定的手册身份在 `ResolvedAgentConfig.nodeName`。
- Flywheel 自身存在 graph-only 手册 `eng_design` / `implement`，它们不一定是 label dispatch 的 `agents:` 条目。仅展示 `resolvedAgents` 会让这些执行节点永远找不到角色卡。
- `fleet-console-html.ts` 已有 `.dag-chip` 与 `[data-role]`，但没有二者间的 hover / focus / click 交互，也没有 node 级“未关联”状态。

## 3. 锁定约束

1. **不恢复 `role`**：新字段只表达“这份执行手册是谁”，不承担派工别名、行为 type 或展示 label 的职责。
2. **schema 2 永久可读**：老模板缺引用仍完整渲染，节点上明确显示“未关联”，不能让整张 DAG 消失。
3. **引用稳定**：引用 registry node name，不引用会随仓库整理而变化的文件路径。项目 overlay 再把同一 name 解析到项目自己的文件。
4. **结构节点无手册**：`gate` 与 `execution: engine` 的 `land` 不是假装“缺失”；只有 agent 执行节点参与关联验收。
5. **唯一匹配**：一个项目内每个 handbook ref 至多一张角色卡；悬空或非唯一都作为未关联显示，不能随便挑第一张。
6. **输入与 HTML 安全**：schema 3 引用必须是非空稳定 id；所有 DOM 属性与提示继续走 `esc()`。

## 4. 方案比较

### A. 恢复 `role`

否决。它直接倒退 FLY-2121 的分层设计，也会重新混淆 graph node、label-dispatch role 与 handbook identity。

### B. manifest 写手册文件路径

否决。路径是项目 overlay 的实现细节；同一个全局模板跨项目运行时，实际文件可以不同。路径改名也会无谓制造模板 revision。

### C. schema 3 增加 `handbook_ref`，值为 registry node name

采用。生成器在每个 agent 执行节点上写引用；项目解析器用同一个 registry name 找到项目本地手册文件。角色卡按 resolved project registry 的唯一手册集合生成，而不是只按 label-dispatch 配置生成。

## 5. 实现假设（动代码前显式列出）

- manifest JSON 沿用现有 snake_case，字段命名为 `handbook_ref`；管理台 DTO 使用 TypeScript 风格 `handbookRef`。
- schema 3 解析允许引用缺失，以便 founder/custom 或损坏边界在 node 上显示“未关联”；系统 registry 编译器与对照测试保证六个内置 graph 的所有 agent 节点都填写引用。
- schema 1 / 2 不接受 schema 3 专属 key，但都继续按原合同解析；管理台把缺失投影为 `null`。
- 角色卡集合以 `ResolvedProjectRegistry.nodes` 为准；未激活 registry 的 legacy 项目继续从 `resolvedAgents` 降级生成，不扩大本单为项目迁移。
- hover 与键盘 focus 只高亮；click 会滚动并聚焦对应角色卡。无唯一卡片时节点保留“未关联”提示且不跳转。

## 6. 需要由后续调研证明的事项

- schema 3 穿过 `StateStore`、template selection、run snapshot 与 catalog migration 的全部版本白名单，不出现“模板能发布但 run 不能启动”的半升级。
- snapshot schema 是否同步升 3，还是继续用 snapshot schema 2 包 schema 3 manifest；优先选择版本语义清晰、改动面可完整测试的方案。
- 六个内置 graph 的 agent 节点集合与项目 resolved registry card 集合逐项相交恰好为 1。
- 管理台 happy-dom 测试覆盖 hover/focus/click、schema 2 缺失提示、悬空 ref，以及 structural node 不误报。
