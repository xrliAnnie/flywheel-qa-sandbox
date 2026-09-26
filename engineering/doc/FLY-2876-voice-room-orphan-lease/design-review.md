# FLY-2876 同 slot 孤儿语音房锁 — 设计评审记录
Issue: FLY-2876 (https://linear.app/geoforge3d/issue/FLY-2876/病根529-语音房-语音会话自然结束-测试房被拆后语音房锁-tmpflywheel-voice-room-guild-channellock)
日期: 2026-09-26
基于: plan.md

## Gate 清单（Bridge 权威）

| 项 | 值 |
|---|---|
| execution | df956a3d-e741-4383-98dd-d8d049e00688 |
| manifest revision | 1 |
| request_id | 8bafb546-a9b4-41a3-813e-a3ed8efdca44 |
| expected_plan_path | engineering/doc/FLY-2876-voice-room-orphan-lease/plan.md |
| expected_blob_sha | 819e0a6203ffb0f420ab8d571e36ecf7c882cb36（= `git rev-parse HEAD:plan.md`） |
| 显式 review request | `gate review_design --no-block` → question e9876d7a；`request-review --type design` 被 Bridge 409 拒绝（claude-family 作者走 legacy Codex 通道），该 gate 问题作废 |

## 评审器尝试

| 评审器 | 结果 | 证据 |
|---|---|---|
| Codex（codex-with-fallback exec, gpt-5.6-sol xhigh） | 未能运行：账号 personal1 usage limit 至 2026-10-03 08:33；`codex-profile next` 已停用；`codex-profile use personal` → `codex_candidate_recovery_required`（目标账号租约需人工恢复），未动凭据 | scratchpad `codex/stdout-r1.log`，session 01a0de9c-b4a9-79d1-9172-2d55bdd65236 |
| Gemini（gemini-cli 0.61.0） | 未能运行：`IneligibleTierError`（Gemini Code Assist 个人版已停用） | scratchpad `gemini-stderr-r1.txt` |

## Codex 设计评审轮次（gpt-6-astra xhigh，session 01a0df4b-9972-70c3-99ca-4a96d62f45f9；账号切至 school 后可用）

| 轮 | manifest | 裁定 | 发现 | 处置 |
|---|---|---|---|---|
| R1 | rev1 8bafb546 / blob 819e0a62 | CHANGES REQUESTED | D1-1 HIGH 并发双 stop 删新锁/覆盖新回执（实证）；D1-2 MEDIUM mkdir 前回执检查过期 | plan 增第 17–23 条：同 slot 关键区互斥（初版为目录互斥锁）+ 交错测试 |
| R2 | rev2 bbd25d19 / blob d6cc8d66 | CHANGES REQUESTED | D2-1 HIGH 目录互斥锁的墓碑回收会挪走活锁 ⇒ 双持有者（协议模型实证）；D2-2 MEDIUM mkdir→owner 发布间崩溃无恢复协议；D2-3 MEDIUM T10–T12 时序与互斥合同矛盾 | plan 增第 24–32 条：改为保留锁文件 + 内核 advisory lock（stdin 系留 helper，lockf→flock→python3），测试重写为子进程 + 屏障 T10–T18 |
| R3 | rev3 fdc32cd0 / blob 2ae68518 | （进行中） | | |

评审环境备注：Codex 沙箱内 `spawnSync ps` 为 `EPERM`，其 `node --test` 结果（15/9）源于环境；本节点真实环境 24/24。

## 状态

Codex 账号已由 Lead/founder 切至 school，评审沿路径 (a) 进行中；R3 结果出来后更新本表。
本记录不构成通过；设计本体此前已经三轮 Codex 代码评审（见 plan.md R1–R3 节与 milestones/FLY-2876.md）。
