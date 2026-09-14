# FLY-2555 Codex 终态缺席判定 — 调研
Issue: FLY-2555 (https://linear.app/geoforge3d/issue/FLY-2555/巡检假报修-codex-设计死体的-commdb-行带-parked-声明-窗口不解析时-reconcile-只-veto)
日期: 2026-09-14
基于: exploration.md

代码证据：

- `run-quiescence.ts:probeExecutionAbsenceBeyondTarget` 首先检查 Codex daemon；任何非 absent（含 unknown）立即返回，未继续执行 marker discovery 与宿主进程探针。session 参数只有 adapter_type，未消费终态证据。
- `plugin.ts` boot 与 periodic reconcile 共享 executionAbsence 闭包，已有按 execution id 的 store.getSession 调用。
- `commdb-fsm-reconcile.ts` 先保护 TURN，再验证 FSM 与注册窗口 dead，parked 分支仅对 RECONCILE_DELETABLE_STATES 调用 executionAbsence。dead 已走 prune_parked_overridden_execution_absent 与 finalizePaneLossResidue（含 exact target/TURN 复查）。
- `failed` 属于 CRASH_PRESERVE_STATES；不在 RECONCILE_DELETABLE_STATES 内。需单独覆盖用户指定 failed，不扩大 Claude 或 blocked 的可删除集合。
- `hasHostProcessByExecutionId` 只有 pgrep code=1 表示无进程，其余错误按有进程处理，适合 fail-closed 复用。

待实验验证的假设：daemon unknown 的提前返回是 completed Codex 留行的直接原因；failed 的状态门禁是额外覆盖缺口；marker discovery 若不确定或有改名窗口，则应继续保守保留。

生产快照首次命令因工作树尚无 dist 返回 snapshot_helper_missing；正在按锁文件安装并构建本 checkout。未复制或修改生产数据库。

## 2026-09-14 18:07Z 实测与设计 R1

设计 gate `8ffc6374-ced9-427d-ad22-0d4cab14d132` 有效结论 CHANGES_REQUESTED。HIGH findingKey=`daemon-unknown-fallback-blind-to-codex-processes`：execId 不在 Codex daemon/TUI 的 argv（使用哈希 socket 路径），单纯 unknown fallback 会误删仍存活的 daemon 的 CommDB/问题身份。

Lead question `6c36e867-a574-4449-b6d8-fa9668699fe7` 明确授权使用 mode=ro SELECT 导出所需行，不绕过受管快照身份门。2026-09-14T18:05:34.880807Z 导出 9 CommDB running 行、9 匹配 StateStore 行、2 声明；fixture 原材料在 `/tmp/fly2555-evidence/production-rows.json`。

目标 `412485c1-93e3-4bbf-b228-b12410649347`：StateStore completed、codex-tmux、design；注册窗口 @2877 dead、marker missing。pgrep 返回 3，stderr 为 sysmond service not found / Cannot get process list，因此宿主无进程未被证明。

2026-09-14T18:07:09.486Z 使用真实 `probeCodexDaemonEvidence` 返回 `{liveness:unknown,ledger:valid_group,socketLive:true,spawnLock:live}`，见 `/tmp/fly2555-evidence/daemon-evidence.json`。这直接否定“目标是零证据死体”的前提。仅支持零证据的修复不能解决指定目标；不能把更窄合成用例作为 C1 GREEN。已向 Lead 发起明确范围裁定，尚未修改生产代码。

Lead question 7967cfe2 确认零证据两次复核与 reconcile-only opt-in，failed 仅 harvest 可接受。Lead question d9ffa953 提供 18:08:31Z 宿主 execution-id argv 无匹配（1157 个进程）证据；因 Codex 使用哈希 socket，该观测并不否定 18:07:09Z 实测 live socket。R2 明确保留原目标，原 C1/C3 冲突仍待 5892368a 裁定。

## 修前 fixture 重放

2026-09-14T18:14:38.779Z 使用 readonly SELECT 的生产行创建隔离 `/tmp/fly2555-evidence/before.comm.db`，执行现有 reconcile，注入此前采集的 probe 结果（host rc3 保持 unknown）。原 9 行、修前重放后 9 行、removed=[]、reconciled=0；目标 412485c1 命中 prune_skipped_parked_conflict，TURN 持有者保留。记录 `/tmp/fly2555-evidence/replay-before.json`；重放入口 `/tmp/fly2555-evidence/replay-before.ts`。此为真实生产行与采集证据的隔离重放，不是生产清理。
