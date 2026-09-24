# FLY-2831 Opus 线运行时模型解析取证 — 调研
Issue: FLY-2831 (https://linear.app/geoforge3d/issue/FLY-2831/qa-fixture-fly-2775-529-slot-4-opus-线运行时解析取证-可随时关闭)
日期: 2026-09-23
基于: exploration.md

## 取证结果（2026-09-23 实测）
| 证据 | 值 |
|------|----|
| Runner 进程 pid / 启动时间 | 72355 / Wed Sep 23 22:19:55 2026 |
| 进程命令行 `--model` | `claude-opus-5-5` |
| 模型自报 model ID | `claude-opus-5-5`（Opus 5.5） |
| `FLYWHEEL_AGENT_BACKEND` | `claude-code` |
| `FLYWHEEL_LEAD_ID` / `FLYWHEEL_PROJECT_NAME` | `flywheel-test-4` / `test-slot-4` |
| `FLYWHEEL_EXEC_ID` | `81454589-f837-4b02-8d96-9e458e217fc7` |
| 进程 argv 其它 | `--agent-id runner-81454589@flywheel-test-4 --team-name flywheel-test-4 --permission-mode bypassPermissions` |

## 结论
run start 的运行时模型解析在 slot-4 生效：Runner 进程以 `--model claude-opus-5-5` 启动，模型自报一致，属于 Opus 线。三处证据互相吻合，无分歧。
