# FLY-2404 全机一份 Codex 凭据 — 设计修正(Lead 收口裁决)

Issue: FLY-2404 (https://linear.app/geoforge3d/issue/FLY-2404/codex凭据-全机只用一份-codex-凭据runnerleadraya-的每个-codex-home-不再各存一份-authjson)
日期: 2026-09-07
基于: plan.md(v5,commit 8a26e5d0e)+ codex-review-r5-residue.md

## 0. 为什么有这份文件

Codex 设计评审 5 轮(R1 11 条 → R2 8 → R3 6 → R4 6 → R5 4)均为 CHANGES REQUESTED;核心方案(每家一条 symlink 指向主机真身)五轮都被肯定,剩余全部是 launcher / helper / runbook 的合同细节。按 Lead 3 轮安全阀规则,Lead(flywheel-eng-lead,2026-09-07)以 **v5 + leadAcceptance** 收口,不开 R6。plan.md 保持 v5 不改(设计评审门绑定该 blob);本文件把 Lead 的裁决与 R5 残余项固定为**实现节点必做的 RED 清单**。

## 1. Lead 裁决原文(question ae6e9f78 答复)

> leadAcceptance 收口,4 条全部作为 residue 交实现节点 RED 清单必做,并裁 #3:**只保留 founder 在主机 `codex login` 为受支持的生产动作**;不做无人值守 force-refresh helper,不在任何脚本里改写/输出 token(与本单红线一致);§4.2 改成「9-12 前若切换未落地,founder codex login 一次」的 runbook 步骤,实验 driver 明确标注为非生产工具。#1 环境变量改 FLYWHEEL_PROJECT_NAME、唯一参数顺序、退出码表加 6=uncertain、launcher shape test 真跑到 fake link-truth;#2 link-missing 进两个 helper 的写入决策(同一 process/launchd/lease fence 后 temp symlink + rename 恢复,锁内终验;severe 集合补列;加 missing/负例测试);#4 `~/.codex-raya` 写明当前**不属于 active managed set**、首次启用前需独立 Lead 批准 —— 但注意 FLY-2401(Raya 读侧激活)马上要用它:激活时由本单 helper 以 link-truth 方式提供,不再让 founder 单独登录;§5「Lead 部分全绿」限定为已批准 homes,全局 deadline 后移不作为单-home waiver。

## 2. 实现节点 RED 清单(对 plan.md v5 的覆盖性修正)

| # | plan.md v5 位置 | 修正(以本文件为准) | 验证 |
|---|----------------|-------------------|------|
| R5-1 | WS-B「Lead launcher」示例 | 调用改为 `"$link_truth" --lead "$FLYWHEEL_PROJECT_NAME/$FLYWHEEL_LEAD_ID" "$CODEX_HOME"`(launcher 只导出 `FLYWHEEL_PROJECT_NAME`,`set -u` 下 `FLYWHEEL_PROJECT` 会 unbound);CLI synopsis 定为 `codex-home-link-truth.sh [--lead <project>/<leadId>] [--unlink] [--keep-backup] <home>`(选项在前、home 最后,解析器拒绝其他顺序);退出码表补 `6 = uncertain`(home 目录 fsync 失败,链接已在位) | `codex-lead-home-rule.test.sh` 在清空 `FLYWHEEL_PROJECT` 的环境里**真正执行**三个 launcher 到 fake link-truth,断言收到三个准确 tuple;CLI 参数顺序测试 |
| R5-2 | WS-A 决策表 / WS-B helper | `link-missing`(家内 `auth.json` 不存在,例如 `codex logout` 删了链接)进入 `migrateCodexAgentHomeCredential` 与 `migrateCodexHomeCredential` 的写入决策:通过同一 process/launchd/lease fence 后,以 temp symlink + rename/create 恢复;keyed 路径仍在锁内终验。WS-C severity 表把 `link-missing` 显式列为 severe。**provision** 对 missing 仍是「新家建链接」(不变) | keyed / Lead / legacy 三条 missing-destination 恢复测试;活 lease / job running 下仍拒绝的负例 |
| R5-3 | §4.2 定时炸弹 | **删除「备选:运维强制刷新」**。受支持的生产动作只有一条:「9-12 前若切换未落地,founder 在主机 `codex login` 一次」,gate 仍是真身 `last_refresh` 前进且 exp ≥ 9 天。不做无人值守 force-refresh helper;任何脚本不得改写或输出 token。`exp-evidence/run-wave.sh` 与 `fake-authority.py` 标注为**非生产工具**(只用于设计证据与 QA 回归 wave A) | plan/runbook 文本核对;`exp-evidence/` 文件头加 NON-PRODUCTION 标注 |
| R5-4 | A6 / §4.3 / §5 | `~/.codex-raya`(仓内 launcher 推导的家,当前不存在)**不属于 active managed set**;首次启用前需独立 Lead 批准。FLY-2401(Raya 读侧激活)启用它时,由本单 helper 以 link-truth 方式提供凭据,不再让 founder 单独登录。§5「Lead 部分全绿」限定为**已批准的 homes**;未批准项记录预期 `copy-pending` 与 deadline 处置;全局 `FLYWHEEL_CODEX_LINK_DEADLINE` 后移不作为单-home waiver | 验收表按已批准 homes 采证;探针对未批准家的 `copy-pending` 有记录 |

## 3. 不变的部分

plan.md v5 其余全部有效:WS-A 新家建链接 / 存量不热切、WS-B 排空脚本与 keyed 锁内迁移、WS-C 单实例探针与逐 reason remediation、WS-D 残留门、WS-E 盘点/删除分离 + write-ahead receipt、§4.1 owned-pause 协议(Bridge 不停)、§4.3 逐 home 清单(Lead 逐个批)、§4A 实验证据、§9 五轮处置表。

## 4. 收据

`.flywheel/runs/4fa6eb68-d84f-41af-b11a-3cf19b9273e2/codex/design-review.json`:`status:"APPROVED"` + `leadAcceptance{instructionId, acceptedBy:"flywheel-eng-lead", acceptedAt, codexFinalVerdict:"CHANGES_REQUESTED@R5 (3 HIGH + 1 MED, all carried as residue)", residue:"R5 #1-#4 per codex-review-r5-residue.md; #3 resolved as founder-login-only", rationale}`。
