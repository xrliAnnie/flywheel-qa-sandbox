# FLY-2554 ship 即归档 — 探索
Issue: FLY-2554 (https://linear.app/geoforge3d/issue/FLY-2554/thread归档-ship-即归档把-done-thread-archiver-的-60-分钟静默常量降为-0机器消息阶段回声-巡检提醒)
日期: 2026-09-14
基于: 无

Founder 要求已 ship 线程自动收起，机器阶段回声、巡检、Lead 通报不延长等待。Lead question 7a8c7c66-7236-44e1-bf4c-1ba9c07fa38b 收窄：保留 60m 默认，只跳过 ship 后 bot-only 尾部的静默；人类尾部保持原策略。

基线 f31b75af9 已有 FLY-2377 immediate post-ship archive。关键问题包括首次归档失败后的重试，也包括首次归档成功后 Discord 被消息重开。不能把 archive-once 理解为所有调用方永不重归档：post-ship 有 deterministic receipt；reconcile 专门发现 Discord open 且 archived_at 非空的线程并以 terminal authority 重归档。

设计 R1 HIGH bot-tail-exception-misses-reopened-path 指出首次归档限定漏掉真实场景。此修订覆盖该分支，并以 reopened discovery 的公开 reconcile seam 验证。
