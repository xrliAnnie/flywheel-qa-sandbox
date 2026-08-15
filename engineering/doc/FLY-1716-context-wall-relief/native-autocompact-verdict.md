# FLY-1716 Lead context 墙泄压 — 原生 Auto Compact 实验结论

Issue: FLY-1716 (https://linear.app/geoforge3d/issue/FLY-1716/投递撞-context-墙无泄压-lead-会话满-context-时投递永远进不去队列冻死今晚-cass-47-条-25h)
日期: 2026-08-14
基于: plan.md

## 1. 结论

截至 E1–E3，**没有符合 plan §3.2 全部 winner 判据的 200k-tier 配置**：

- Claude Code 默认 `auto` 与显式 `autoCompactWindow=200000` 都在约 77.4% 时自动 compact，落在目标 70–80% 区间，且两次 fresh session 重复一致；但 debug 明确走 `reactive-compact`，不满足「非 reactive 先行」判据。
- 旧的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=140000` 也会触发，但在约 52.2% 就 compact，属于 `works_outside_target`，且同样走 `reactive-compact`。
- Claude Code 2.1.233 已提供官方 `--autocompact <auto|tokens>` / `/autocompact` 配置面，持久化键为 `autoCompactWindow`；未发现独立的 enable/disable 开关。
- E4（1M tier）预算未获批准，终态为 `skipped_lead_decision`，不阻塞 B 与 test override 删除。Lead 判断：1M compact 失败已有生产实录，E4 潜在收益投机性高；B 对 1M 的重启保护不依赖 E4；若交付后仍认为 1M 原生配置结论有独立价值，再由 founder 决定是否追加 USD 20–30 级实验预算。

因此当前 amendment 结论是 **no-winner / 不向 launcher 增加 200k 或 1M Auto Compact 配置**。A 的代码终态按 plan §3.1 删除 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`；B 的 restart/resume safety gate 继续实施。

## 2. 固定实验条件

| 维度 | 固定值 |
|---|---|
| Claude Code | `2.1.233` |
| 模型 | `claude-haiku-4-5-20251001` |
| 模型 context window | `200000`（CLI result `modelUsage.contextWindow`） |
| 会话隔离 | 每个 replicate 使用独立 `CLAUDE_CONFIG_DIR`、workdir、session UUID |
| 认证 | 仅向实验子进程注入当前 OAuth access token；不复制生产 transcript/settings |
| customization | `--safe-mode --tools ''`，固定 system prompt |
| 负载 | 每 turn 2100 条固定结构记录，约 50.5k 新 input tokens；模型只回复 `OK` |
| 取证 | 每 turn JSON usage + transcript JSONL + 独立 debug log |
| 人工 compact | 无 |

context 占用口径与 plan §2.1 一致：`input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens`。每个 cell 均以 compact 前最后一次真实 assistant usage 为 trigger occupancy 锚点；compact 后 usage 显著下降作为 boundary 证据。

## 3. 实验矩阵

| Cell | 配置 | Replicate 1 | Replicate 2 | 归因 | 判定 |
|---|---|---:|---:|---|---|
| E1 | 默认态；无 compact env/setting | 154,829 / 200k = 77.41%；下一 turn 降至 54,912 | 154,805 / 200k = 77.40%；下一 turn 降至 54,953 | debug: `source=compact` + `Forked agent [reactive-compact]` | 目标区间内工作，但 reactive；非 winner |
| E2 | `/autocompact` 配置面审计 | 当前值 `auto`；UI 说明实际窗口为设置值与 model maximum 的最小值；`auto` 为推荐值 | CLI help 同时暴露 `--autocompact <auto\|tokens>`，token 范围 100k–1M | settings 精确新增 `"autoCompactWindow": 900000`（UI 同时报 200k model 上 capped 到 200k） | 官方配置面存在；无独立 on/off |
| E3a | 仅 `--settings '{"autoCompactWindow":200000}'` | 154,818 / 200k = 77.41%；降至 54,732 | 154,777 / 200k = 77.39%；降至 54,731 | 两次 debug 均为 `reactive-compact` | 目标区间内工作，但 reactive；非 winner |
| E3b | 仅 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=140000` | 104,424 / 200k = 52.21%；降至 54,723 | 104,326 / 200k = 52.16%；降至 54,832 | 两次 debug 均为 `reactive-compact`；后续再次按同节奏 compact | `works_outside_target` |
| E3c | setting + env | 未运行 | 未运行 | E3a/E3b 均证明各自输入已被消费，二者是同一 window 维度；无组合增益假设 | `not_applicable` |
| E4 | 1M control + 750k candidate，各重复 ≥2 | 未运行 | 未运行 | 预算申请 questionId `29d7341b-861c-4408-9494-4a8f55bae89b`；估算约 60 turns / 24M input-token exposure / USD 20–30 Sonnet-equivalent；Lead 明确不批 | `skipped_lead_decision` |

## 4. 证据定位

原始证据保存在本机临时实验根目录 `/private/tmp/fly1716-autocompact/`，不进 Git（transcript 含大体积合成负载）：

- E1：`e1-run1-isolated/`、`e1-run2-isolated/`
- E2：`e2-dialog/`（`settings.json` 与 TUI debug）
- E3a：`e3a-run1/`、`e3a-run2/`
- E3b：`e3b-run1/`、`e3b-run2/`

每个 run 的 `debug-turn-*.log` 中可检索 `source=compact` 与 `Forked agent [reactive-compact]`；`projects/**/<session>.jsonl` 保存 compact boundary 与逐 turn usage。

## 5. 发布与回滚判断

- **不发布新 winner 配置**：没有配置同时满足目标区间、非 reactive 归因、fresh repeat ≥2。
- **删除 test override**：按 founder 裁决移除 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 的 active runtime 传播；默认 `auto` 在本次 200k 实验中确实会 compact，但只证明当前版本/账号桶的 reactive 行为，不构成安全保证。
- **1M 不继承 200k 配置**：E4 未通过前，任何 200k 值都不得传播到 `[1m]` tier。
- 若部署后撞墙频率上升，回滚仅恢复 override 删除的 commit；不得绕过 founder 裁决引入自研 compact/clear 管线。
