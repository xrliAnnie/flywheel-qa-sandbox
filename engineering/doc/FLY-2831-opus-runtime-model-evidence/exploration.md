# FLY-2831 Opus 线运行时模型解析取证 — 探索
Issue: FLY-2831 (https://linear.app/geoforge3d/issue/FLY-2831/qa-fixture-fly-2775-529-slot-4-opus-线运行时解析取证-可随时关闭)
日期: 2026-09-23
基于: 无

## 背景
FLY-2775 QA 合成单：在 529 slot-4（Finance-Test，Lead=flywheel-test-4）验证 run start 的运行时模型解析。非真实需求，取证后可关闭。

## 要回答的问题
run start 派发的 Runner，最终进程实际以哪个模型运行？是否为 Opus 线（`claude-opus-5-5`）？

## 取证来源
1. Runner 进程命令行里的 `--model` 参数（`ps -ww -o command= -p $PPID`）。
2. 模型自报身份（system prompt 中的 model ID）。
3. Runner 环境变量（`FLYWHEEL_*`）。
