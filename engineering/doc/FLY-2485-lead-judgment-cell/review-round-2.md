# FLY-2485 Lead 判断格 — 调研
Issue: FLY-2485 (https://linear.app/geoforge3d/issue/FLY-2485/进度页e4-lead-判断格lead-note-新表-flywheel-comm-lead-note)
日期: 2026-09-09
基于: plan.md

R2 gate：`b384b37c-2462-48a2-93f5-332c37346e1b`。Request：`e172fabe-61e0-440a-ba1c-6c5158fbed9d`。有效 `reviewVerdict=APPROVED`，原始 `reviewerVerdict=APPROVED`；`settled=[]`，策略为 `medium_low_findings_are_non_blocking_v1`。评审对象为 R1 修订后的设计提交 `3d7559234`。

以下六条均为非阻塞建议，保留给 Lead 决定后续范围；本记录不声称它们已修复，也不暗改已获批准的实施契约：

1. MEDIUM `scope-proof-on-read-path`：identifier show/clear 当前也执行完整范围证明，可能付出多页扫描成本。建议仅 set 做成员证明，读取/删除限制在已分区的本地记录。
2. MEDIUM `clear-requires-live-linear`：离线 UUID 路径要求调用方先保存 UUID；遗忘后暂无本地发现入口。建议后续考虑按项目列出记录，或本地标识映射。
3. MEDIUM `role-length-unbounded`：当前角色校验没有长度上限。建议考虑 64–128 个码点的边界，并兼顾已配置角色兼容性。
4. LOW `scope-proof-no-request-deadline`：单次查询与快照有各自时限，但没有整体请求时限。建议统一预算，耗尽时返回明确上游错误。
5. LOW `uuid-branch-needs-bindingless-project-resolution`：离线 UUID 分支允许无 Linear 绑定的已注册项目，实施时需避免误用会拒绝无绑定项目的 resolver；应核对按精确项目键读取 ProjectEntry 的路径。
6. LOW `pm-display-name-mislabels-cos`：当前 pm 的“产品规划 Lead”显示名可能不符合协调/分流职责。建议由 Lead 确认显示名称，或明确配置部门；不在设计阶段改全局注册表。

已通过 `ask --report` 向 Lead 汇报，回执 `63a228c6-92c2-4f95-8c3f-01f1b761b735`。APPROVED 允许继续设计交付；不代表应用测试通过、创始人通过、合并或部署许可。
