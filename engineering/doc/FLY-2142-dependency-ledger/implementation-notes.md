# FLY-2142 依赖账本 — 实现记录
Issue: FLY-2142 (https://linear.app/geoforge3d/issue/FLY-2142/2108c-依赖账本初始批次-三类动态更新减法不许丢)
日期: 2026-09-04
基于: plan.md, design-correction.md

## M0 · Linear relation ID 能力探针

Lead 授权：仅使用两张标题以 `[FLY-2142 探针·可删]` 开头、team `FLY`、label `Flywheel`、Backlog、无 parent 的一次性 issue；关系只在两张单之间写删，不碰 FLY-2108 或真实 Epic。探针单为 `FLY-2325`（blocker）和 `FLY-2326`（blocked），保留到 M7 端到端演练完成后立即 archive。

### 第一次原始输出

```json
{"ok":true,"team":"FLY","label":"Flywheel","state":{"name":"Backlog","type":"backlog"},"blocker":{"id":"43d96f58-18b0-4be2-927c-714780240e61","identifier":"FLY-2325","url":"https://linear.app/geoforge3d/issue/FLY-2325/fly-2142-探针可删-blocker-f784570f"},"blocked":{"id":"68983234-6cef-46b1-b741-ff50e68b30a2","identifier":"FLY-2326","url":"https://linear.app/geoforge3d/issue/FLY-2326/fly-2142-探针可删-blocked-f784570f"},"operation_id":"dd5b4524-af5a-402c-b77f-f84967dde480","create":{"success":true,"returned_relation_id":"dd5b4524-af5a-402c-b77f-f84967dde480","accepted_caller_id":true},"fresh_inverse_relation_id":null,"fresh_inverse_matches_caller_id":false,"duplicate":{"threw":false,"success":true,"relation_id":"dd5b4524-af5a-402c-b77f-f84967dde480"},"delete":{"success":true,"relation_absent_after_delete":true},"retained_for_a7":["FLY-2325","FLY-2326"]}
```

第一次 fresh-read 的 `null` 是探针代码误把 SDK 的 `relation.issue: LinearFetch<Issue>` 当同步对象读取；关系写入、同 ID 重放和删除本身均成功。类型证据：`@linear/sdk` 60.0.0 `_generated_sdk.d.ts` 的 `IssueRelation.issue` 是 `LinearFetch<Issue> | undefined`，且模型已有同步 `issueId`。

### 修正观察后的原始输出

```json
{"ok":true,"blocker":"FLY-2325","blocked":"FLY-2326","operation_id":"40b90faf-8d07-4a26-8109-145a61819a4f","create":{"success":true,"returned_relation_id":"40b90faf-8d07-4a26-8109-145a61819a4f","accepted_caller_id":true},"fresh_inverse":{"count":1,"relation_id":"40b90faf-8d07-4a26-8109-145a61819a4f","issue_id":"43d96f58-18b0-4be2-927c-714780240e61","related_issue_id":"68983234-6cef-46b1-b741-ff50e68b30a2","matches_caller_id":true},"duplicate":{"threw":false,"success":true,"relation_id":"40b90faf-8d07-4a26-8109-145a61819a4f"},"delete":{"success":true,"relation_absent_after_delete":true}}
```

结论：

1. Linear 接受调用方提供的 UUID v4 relation ID。
2. blocked issue 的 `inverseRelations` 原样返回该 relation ID。
3. 同一 ID、同一端点和同一类型重复 create 是幂等成功，返回同一 relation ID，不抛错。
4. 默认实现选择 `relationIdMode: "client"`；`server` fallback 合同与测试仍保留。

## M7 · 端到端演练补充

2026-09-04T09:28Z 在隔离端口的临时 Bridge 上运行实际路由与实际 CLI，Linear 写入仍落在已授权的 `FLY-2325 → FLY-2326` 探针范围内。临时实例为两张 Backlog、无 parent 的探针注入了仅含这两张单的 active-scope 快照；这是为了满足生产路由的 blocked-item 范围守卫，不改变 Linear 上的状态、parent 或项目数据，也没有启动或重启常驻 Bridge。

- add relation：`149d78b5-fabf-4506-931f-68a681662d27`
- remove operation：`8f17f718-9cb6-4d29-9e5a-e50cc19604e0`
- 直查 `inverseRelations`：`[] → [149d…] → []`
- Linear history：add 为 `ab`，remove 为 **`rb`**，与既定码表一致，无需改常量。
- 同一个 remove operation 再跑 `note`：`ledger.recorded = "already"`，没有生成第三条评论。
- Linear GraphQL 的 `Comment.bodyData` 将每条评论保存为一个无 marks 的纯文本节点；节点文本逐字包含 `[dependency-ledger] …\ndl1:…`。因此方括号、`dl1:` 与 base64url 均未被解析成链接、强调或其它富文本节点，无需双格式解析 fallback。

完整回执、历史和评论证据见 `implementation-evidence.md`。

## Code review R1 处置

Review `7ab7fcb0` 在 `303a461f5` 上给出 1 HIGH、3 MEDIUM、2 LOW；Lead 要求 HIGH/MEDIUM 全修，LOW 修或在 PR 说明。本轮全部处理：

1. **Backlog 后代 403（HIGH）**：Epic 快照新增 `descendantIds`，直接复用 active-root 子树遍历并包含 Backlog 后代；原 `items` 仍只含页面渲染的非 Backlog 子单。dependency add/remove/note/log 的 blocked/issue scope guard 统一改查 `descendantIds`，不按状态特判。测试同时证明 Backlog 后代四条路由可用、真正范围外仍 403。
2. **Linear 写永久挂起（MEDIUM）**：三个实际写调用 `createRelation`、`deleteRelation`、`createComment` 共用 20 秒 deadline；超时沿既有未确认/未记账失败合同返回，per-project 串行尾链会 settle。测试以 5ms 注入 deadline 覆盖三臂。
3. **评论时间只信载荷（MEDIUM）**：可解析 ledger comment 现在并列输出载荷自述 `at` 与 Linear comment 的 `observed_at`，排序仍按后者。
4. **Markdown 标题漂移（MEDIUM）**：统一 label 为 pinned plan 与 Lead 规则中的「依赖需要减法的地方」；HTML/Markdown 同词。
5. **note 丢 relation ID（LOW）**：added 状态下，调用方给出的 ID 与现存边不一致返回 409 `relation_id_mismatch`；removed 状态下保留调用方提供的已删除 relation ID，不再覆盖成 null。
6. **稳定错误码未记账（LOW）**：实现现有的 `invalid_backfill`、`invalid_relation_id`、`relation_id_required`、`invalid_kind_only`，以及本轮新增的 `relation_id_mismatch` 均视为稳定外部错误码；不改 pinned plan，登记在本实现记录和 PR body。

Lead 保存的 stash `FLY-2142 WIP of dead body 2aee3345` 只有 discover partial-failure 输出净化及其测试。该内容符合 plan 的错误面不泄漏约束，本轮按严格 TDD 手工恢复：先加入带 token/path 哨兵的测试并观察失败，再只保留 `relation_id` 与 `post_write_check` 两个修复所需字段。为避免删除共享 git 数据，原 stash 未 drop。
