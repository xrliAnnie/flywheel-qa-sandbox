# FLY-2485 Lead 判断格 — 调研
Issue: FLY-2485 (https://linear.app/geoforge3d/issue/FLY-2485/进度页e4-lead-判断格lead-note-新表-flywheel-comm-lead-note)
日期: 2026-09-09
基于: plan.md

R1 gate：`dd0579ff-de76-4d07-a45f-a4818fd85225`。Request：`d5063c62-102b-4d2f-b378-6e0a9e593791`。有效/原始 verdict 均为 CHANGES_REQUESTED。以下是逐项修订记录，不自称已通过复审。

1. HIGH `write-gate-narrower-than-page-scope`：接受。根过滤与子单遍历源码证实原写校验过窄。改为直接 binding OR 完整、受限 snapshot roots/descendants 成员。新增缺标签、跨 team、无 project 的已显示子单成功写入测试，另保留两分支均否定和不完整证明的拒绝测试。Lead 通过问题 `99e28443-02c3-4f76-bbcf-6fd19029f8c7` 明确 AGREED。
2. MEDIUM `schema-enum-wiring-omitted`：明确列出 RULE_IDS、REFRESH_REASONS 和 document 顶层 optional key 三处接线，加入闭集失败反例。
3. MEDIUM `department-not-one-to-one-with-lead`：正文、数据测试、HTML 明示“同部门多个 Lead 共用一格”，没有作者级历史。保持 Lead 已定的角色粒度。
4. MEDIUM `role-grammar-can-reject-configured-department`：删除额外 ASCII slug 限制；中文/空格等部门名精确匹配，最小文本不合法的已配置角色返回专用配置错误；不全局破坏原有项目配置加载。
5. MEDIUM `display-name-vocabulary-mistargeted`：只读核对真实部门集合后补齐 infra、分流与其他已存在角色；删除未出现的 qa/cos 映射。未知部门统一有“部门 Lead”说明，显示映射从不是身份允许集合。
6. MEDIUM `clear-requires-live-linear`：show/clear 接受回执中的 UUID 以 project 分区访问已有本地记录，不引入 alias 表，不准 UUID set；补离线删除测试，明确旧托管快照仍要等成功刷新。
7. MEDIUM `page-attribution-exceeds-auth-evidence`：页面/Markdown 明示“角色为提交方声明，未核验具体作者”，HTML 示例已同步；不把 shared token 说成逐 Lead 认证。
8. LOW `html-script-guard-short-circuit`：Lead 时间 updater 独立于 freshness-age 节点 guard，加入移除年龄节点仍更新判断时间的测试。
9. LOW `refresh-requested-vs-deferred-unreachable`：改为 invoked/unavailable/unchanged；invoked 仅证明调用 void 方法，不证明入队、生成或发布，不扩展现有 refresher API。

只变更设计文档和说明页。实现代码、生产状态和部署均未变更；需新 gate + request-review 得到有效 APPROVED 后再交付。
