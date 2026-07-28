# FLY-1507 Mufasa Codex TUI — QA O1 结论
Issue: FLY-1507
日期: 2026-07-27
基于: QA-REPORT.md

## 结论

`growth-mufasa-lead` 的正常 Codex TUI 形态满足 FLY-1507 的 newborn
结构约束，无需为该 backend 放宽或改写验证器：

- `tui-window.ts` 固定在 `flywheel` session 创建且只创建
  `growth-mufasa-lead` window；
- window 的 pane 命令由 `buildTuiCommand` 生成，为完整的
  `codex resume --remote unix://... -C ... -s workspace-write
  -c approval_policy=never <thread>`；
- 该形态正是 `lead_body_newborn_ok` 的单 window、单 live pane 和
  `lead_body_codex_command_matches` 完整 argv 证明。

2026-07-27 的只读真机检查没有看到该 window，但原因发生在 window
创建之前：`com.flywheel.lead.growth-mufasa-lead` 显示 `spawn scheduled`、
`last exit code = 1`，日志反复报
`codex-lead-runtime: missing required env: FLYWHEEL_COMM_DB`。因此 QA
观察到的是当前 Mufasa carrier 的独立启动配置故障，不是 FLY-1507
newborn predicate 对正常 Codex TUI 的结构性误判。本单不修改 Mufasa
launcher/runtime，也不放宽换身验证器。
