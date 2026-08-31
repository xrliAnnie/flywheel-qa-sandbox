# FLY-2168 Codex 真终端 TUI — 返工记录
Issue: FLY-2168 (https://linear.app/geoforge3d/issue/FLY-2168/派工-fly-2152-的-codex-implement-继任连续出生即死22同窗兄弟全健康-出生失败根因待查)
日期: 2026-08-30
基于: qa/independent/REPORT.md

## D1：工作区预信任

`scripts/qa-fly-1239-e2e.mjs` 的真实机器验收上下文现显式设置
`pretrustWorkspace: true`，避免 Codex 在未信任工作区弹窗处停住。

## D2：Codex 宿主受限尝试

在当前 Codex managed sandbox 内启动短任务验收时，进程在创建 thread 前失败：

```text
Failed to initialize session: failed to load AGENTS.md instructions for environment local:
fs sandbox helper failed: sandbox-exec: sandbox_apply: Operation not permitted
```

该尝试没有启动 Codex，也没有产生可用于开窗可靠性判断的样本。未绕过或关闭 sandbox，
也未重复相同的无效尝试。Lead 已裁定：在本修复头 push 后，由可运行真实机器验收的
Claude QA 宿主按 3 次 / 8 分钟预算重新采集 D2，并将其作为下一轮硬判据。
