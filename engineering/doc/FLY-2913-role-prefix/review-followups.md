# FLY-2913 逐角色精简固定前缀 — 评审处置
Issue: FLY-2913 (https://linear.app/geoforge3d/issue/FLY-2913)
日期: 2026-09-25
基于: plan.md

R1 gate `c2bc9590-4a99-4032-97fd-aad2ddc17fb5`; request `82f72478-f361-485a-be8c-4d1affa2035f`; effective/raw verdict CHANGES_REQUESTED. Server policy: medium_low_findings_are_non_blocking_v1. No Lead governance ruling claimed.

| findingKey | 级别 | 处置 |
|---|---|---|
| task-declared-capability-undefined | HIGH | 修复：新 prefixTaskSet 有限 ID 协议、受审 registry、实际两个 scheduler payload、pinned snapshot/重试链、所有无声明触发器 legacy、会议纪要真任务和负控；等待新门确认 |
| forbidden-plugin-new-vectors | MEDIUM | Follow-up：compiler 在 plugin-dir/MCP 入口按源插件/manifest/server 身份拒绝 Discord，不只检查 enabledPlugins；runner/reviewer 双路径负控 |
| rollback-flag-registry | MEDIUM | Follow-up：给专用 enum 开关注册 feature-flags registry 的 readSites/timing/toggleable/retireWhen，并以实际控制写入和新 launch 证明回退 |
| cli-version-drift-policy | MEDIUM | Follow-up：确定受支持版本/self-probe 策略，显式 legacy fallback 通知，澄清 resume 版本不匹配处置 |
| mcp-credential-materialization | MEDIUM | Follow-up：禁止复制 literal secrets；reviewer 禁 credential-bearing MCP，私有配置只保留引用；落盘/清理与 secret scan |
| scope-complexity | MEDIUM | Follow-up：Lead 决定是否将混合 plugin 组件副本/规则片段延后；当前未擅自删掉原目标或宣称整包保留已达到精简 |
| hook-context-bucket | MEDIUM | Follow-up：hook 注入的 additionalContext 单列来源、token、keep/remove 决定，避免长期落残差桶 |
| reviewer-stamp-dir-nonexistent | LOW | Follow-up：reviewer 目前没有所称现成产物目录；实现需明确 request/session 目录与终态清理 owner，不能把计划措辞当现成能力 |
| tests-incomplete | LOW | 记录限制：docs-only worktree 无 node_modules，reviewer 未跑到 vitest；本轮不补跑整包。实际代码实现时安装依赖并跑相关具体文件，零测试不算通过 |

这些项已保留供 Lead 作后续安排；无一在本设计阶段被描述为运行验证通过。新 review 只验证 HIGH 修复及其引入的回归，非阻断意见不当成暗含批准或伪造完成。
