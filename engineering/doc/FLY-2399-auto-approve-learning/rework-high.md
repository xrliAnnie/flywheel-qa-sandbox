# FLY-2399 生产入口与分页 — 实施记录
Issue: FLY-2399
日期: 2026-09-13
基于: plan.md

同步头 2aca30140c6dee125f67d97745b45baf3e630cc5 的精确 CI 34799185158 为 14/14 SUCCESS，但 review 24eb4416-d365-41f5-ba38-dad0826d39de / request cbc19a65-2b25-4aa7-8098-1c18722669ef 为 CHANGES_REQUESTED。完整 findings/advisories 留存 sync-r1-review.json。

Lead 裁定 28500a40-a595-4318-b030-01d9bac3866b 授权只修 production-model-bin-is-profile-script 与 github-pagination-link-path-mismatch 两条 HIGH，严格红绿，一次推新头后冻结并重开 review/CI。其余 17 条 MEDIUM/LOW 全留 follow-up，包含分页竞态建议；不改 plan、授权、预算或取消归因。

第一项：plugin 的 modelBin 从账号切换脚本 resolver 改为 PATH 的真实 claude，与现有 subscription classifier 默认入口一致。原 claudeProfileBinPath 在切号路径保持原用法。测试从真实 plugin 配置提取并执行 modelBin 初始化表达式，注入返回切号脚本的 resolver；RED 收到 /fixture/flywheel-claude-profile 而非 claude，GREEN 得到 claude 且切号 resolver 零调用。该文件 5/5 通过；没有真实模型调用，不冒充语义 QA。

第二项：本轮只读 GitHub API 核到 Link 为 https://api.github.com/repositories/1164340454/pulls/1163/files?per_page=100&page=2。允许 numeric repository prefix + 完全相同资源后缀，与原 /repos/owner/repo 路径等价。只取下一页数字，下一请求仍由 allowlisted repo slug 生成，绝不跟随 header URL。origin、认证字段、fragment、page+1、per_page=100 校验保留。

测试同时覆盖 PR 列表和 PR 文件两页、slug/数字ID两种 Link，检查下一次真实 fetch URL 仍在原仓库；错 PR、错 slug、非数字 ID、异源、错页码、错页大小拒绝。RED 真实数字 Link invalid_pagination；GREEN 11/11 通过。原始红绿日志 /tmp/fly2399-high{1,2}-{red,green}.log。

相关回归、全仓门结果在最终 milestone 与交付报告记录；新头 review/CI 不复用旧头通过。
