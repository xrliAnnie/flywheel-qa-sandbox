# FLY-1999 runner 环境隔离不等于账号隔离 — 设计修正

Issue: FLY-1999 (https://linear.app/geoforge3d/issue/FLY-1999/envbug-runnerlead-环境继承污染codex-home-指向-infra-botflywheel-codex-binpath)
日期: 2026-08-23
基于: plan.md

## Founder 原话

> 「所有的 bot 共享一个 Codex 账号没有问题,我不希望以后每一个 runner 还得有一个自己的 Codex 账号,这个完全不需要」

## 修正后的边界

- 废除概念:本设计不创建、分配或要求“每个 runner 一个 Codex 账号/一次独立登录”。
- 保留器官:runner pane 仍从干净环境出生;身份路径只来自目标 runner 的显式配置;非必需秘密不下发。
- `codex-tmux` 已有 per-execution `CODEX_HOME` 是同一个共享账号凭据的隔离快照与运行目录,不是新的账号或登录席位。
- Claude runner 内调用的 Codex 继续共享 `~/.codex`,并随 `codex-profile use` 的机器级共享账号切换。本单只阻止它误读其它 Lead 的 `CODEX_HOME`。

因此 FLY-1999 的实现无需回滚或重设计:它修复的是环境来源与秘密边界,不改变账号共享策略。
