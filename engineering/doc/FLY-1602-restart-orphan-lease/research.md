# FLY-1602 重启换代失败即孤儿 lease catch-22 — 调研

Issue: FLY-1602 (https://linear.app/geoforge3d/issue/FLY-1602/基建a-重启换代-lead-失败即孤儿-lease-catch-22-每次-restart-挂掉只能人工捞回)
日期: 2026-08-02
基于: exploration.md

## 1. 关键机制的代码事实(全部本地核验,file:line 可点)

### 1.1 lease:bind 之后 supervisor 身份丢失

- schema(`packages/flywheel-comm/src/lead-lease.ts:35`):`lead_lease(lead_key PK, project, lead_id, generation, holder_pid, holder_start, bound_at, acquired_at, acquired_by)`。**没有 supervisor tuple 列。**
- `acquire()`(`lead-lease.ts:350-417`):存在行且 `holder_pid/holder_start` 进程存活(`processAliveWithStart` = pid + lstart 双验)→ `denied_holder_alive`。holder 在 acquire 时 = supervisor 自己。
- `bind()`(`lead-lease.ts:419-470`):CAS(`WHERE … holder_pid=<supervisor> AND bound_at IS NULL`)把 holder **覆写成 pane(body)tuple** 并写 `bound_at`。此后 lease 里 supervisor 只剩 `acquired_by` 文本(`"claude-lead.sh:<pid>"`,无 lstart → PID 复用不安全,不能作存活判定)。
- 结论:**bind 后 lease 无法区分「监护中的 body」与「孤儿 body」**——这正是 `denied_holder_alive` 一刀切的结构根源。增列 `supervisor_pid INTEGER / supervisor_start TEXT`(幂等 `ALTER TABLE ADD COLUMN`,in-repo 先例 FLY-267 journal `reply_channel_id`)即可保留双 tuple。

### 1.2 supervisor 启动环:HOLD 不退出、无收养分支

- launch 环(`packages/teamlead/scripts/claude-lead.sh:3179-3350`):`lead_identity_prepare_lease` 返回 3(含 `denied_holder_alive`,经 `lead-identity-preflight.sh:86-89`)→ 记 HOLD → `interruptible_sleep`(退避 3→30s 封顶)→ `continue`,**无限循环、永不放行、永不收养**。每轮发 `lead_dual_active`(severe)告警(:3212-3216,claims.db 去重)。
- FLY-1285 takeover 守卫(`_prepare_lead_launch` :1449-;FLY-1507 research §3 已核验):对活本体零授权路径——`existing_archived_lead_alive` / `unarchived_live_lead_window` 永久 hold。
- 双档防线语义:今天「body 活着」= 无条件挡死。设计要改的只是**在证据齐全时细分**,不放松真双活。

### 1.3 监护循环的最小状态集(收养需重建的现场)

- `_launch_claude`(:1855-1925)建立:`LEAD_WINDOW_ID`(new-window 返回)、`TMUX_SERVER_PID`(socket inspect)、archive 文件(`tmux_supervisor_archive_write`:server_pid/pane_pid/pane_start/window_id,`tmux-supervisor-guard.sh:16-33`)、lease bind、`remain-on-exit on`。
- 监护 `_wait_tmux_window`(:1934-)只消费:archive 全局 + `LEAD_WINDOW_ID` + `_tmux_target_matches_archive`。**不依赖「body 是我 fork 的」**——tmux 本来就隔离了父子关系。
- ⇒ 收养 = 用「window 名精确匹配 + pane tuple == lease holder tuple + argv 身份证明」重建这四件套,跳过 `_launch_claude`,直接进 `_wait_tmux_window`。body 零触碰。被收养 body 退出后走既有 relaunch(热解析新参数,FLY-1496),旧参数冻结自动过期。
- 现场旁证:此刻孤儿态的 archive(`~/.flywheel/pids/flywheel-flywheel-eng-lead.claude.tmux`,09:56)就是死 supervisor 留下的,内容正指向孤儿 body——收养时 archive 若在且 tuple 复验通过,可直接采信;缺失/陈旧则由 window+lease 重建。

### 1.4 cleanup 的孤儿窗口(为何 SIGTERM 也留孤儿)

- `cleanup()`(:2020-2078):SIGTERM → 生成证明 → `send-keys C-c` → **≤5×1s 等待** → `kill-window` → 删 PID 文件(:2069)→ exit 0。全程 >6s。
- `launchctl kickstart -k` 的 kill 宽限远小于此(实录 03:17:52 收 TERM 后零 cleanup 日志,1–6s 后 wrapper 已重生)→ 优雅拆除被 SIGKILL 截断,body 存活。**生成证明不确定时还有刻意的保留分支(:2046-2048 preserving)。**
- ⇒ cleanup 不可能在对抗性 kill 下保证带走 body。修「窗口大小」是徒劳;修法是让「body 幸存」变成继任者可分类、可接管的状态(收养),cleanup 语义零改动(优雅 stop 仍带走 body,restart-services 的 I1 不动)。

### 1.5 storm gate 与 restart-services 互盲(newborn 验证失败的根因)

- wrapper(`scripts/flywheel-lead-wrapper.sh:148-175`):`restart-storm-gate.py gate lead.<project>-<lead_id>`,held → log + `exit 0`(launchd ThrottleInterval=30s 后重试)。
- restart_lead(`scripts/restart-services.sh:989-1167`):bootout → quiescence → sweep → bootstrap → `launchd_lead_outcome_ready` 30×2s(:82-83)——**全程不查、不 resume storm gate**。gate held 时 bootstrap「成功」但 wrapper 永远自拒,验证探测的是结构上不可能出现的 newborn → 报错落在 :1163「newborn/body/model verification failed」,语义错误。
- gate 有 `resume` 动词(`restart-storm-gate.py` 契约头:`resume/status [--with-seq]`),台账实录 episode 112 / last_resumed_seq 111——resume 机制在被反复使用,restart-services 作为**唯一合法重启入口**理应在 bootstrap 前 resume 自己的 child key。
- 验证窗口尺寸(**本条结论已被 §5.1 推翻,保留原文供对照**):当时依据 9–60s 样本(03:17:21→03:17:30 = 9s;重负载 02:00 波 ~4s 到 PID file、bundle 构建 1–2s)判断"30×2s 窗口本身够用,根因不是窗口太短"。§5.1 的 lease history 铁证(bind 落在报错后 1.6–14.7 分钟)与 fresh wrapper→supervisor-ready 140s 实测表明:9–60s 样本量的是**已完成 setup 的 supervisor 在 acquire 放行后的 body launch 段**,而 restart-services bootstrap 后的**全新 supervisor 冷启动**在负载下远超 62s 窗口。合并结论:gate 互盲(本节)与窗口结构性不足(§5.1)是**叠加的两个根因**,分别由 W3 与 W5 治。

### 1.6 kickstart 旁路现状

- `scripts/flywheel-daemon.sh restart_one`(:957-972):**至今仍是 `kickstart -k`**。FLY-1507 只把 kickstart 从 restart-services 退场并在 plan §1 判定其为孤儿制造机("对活实例是无 cleanup 强杀")。
- 昨夜移交文档(~/.flywheel/handoff-bridge-storm-20260802.md)的救援方案 (c) 明文使用逐个 kickstart。
- Bridge 代码级 kickstart(`packages/teamlead/src/bridge/launchctl.ts:43`)只服务 infra-bot job(`fleet-sensors.ts:689`,`AutoRepairBot.ts` 的 kind 映射无 lead job),**但这不能排除仓内自动化**。
- R15 补审发现遗漏的第二条 Lead 专用自动路径:`packages/v2-scheduler/src/system-ports.ts` 的 `LaunchctlPort.kickstart()` 精确执行 `launchctl kickstart -k gui/<uid>/com.flywheel.lead.<key>`;`scheduler-once.ts:168-195` 在 stale heartbeat + pending mailbox 时走 `status → kickstart -k → confirmProgress → record-failure`。它受 v2 cutover authority/armed marker 约束;本会话未读取生产 LaunchAgent,故**只能列为高相似度候选,不能断言昨夜已启用或就是凶手**。但代码层旁路真实存在,必须纳入 W4 与并发测试。

### 1.7 lease CLI 面(新动词落点)

- `packages/flywheel-comm/src/commands/lead-lease.ts`:现有 `resolve / acquire / bind`(+ store 侧 `validate`)。收养需新增 `adopt` 动词:输入 lead/project/supervisor tuple + 期望 holder tuple,内部单事务 CAS。
- 分类所需判活原语已存在:`processAliveWithStart`(lead-lease.ts,pid+lstart);shell 侧 argv census 先例 = FLY-1507 quiescence ③(claude-lead.sh argv 形态稳定:`/bin/bash …/claude-lead.sh <lead_id> <project_dir> <project_name> …`);body argv 证明 = `lead_identity_command_matches`(`lead-identity-preflight.sh:140-167`)。

### 1.8 `lead_dual_active` 消费方

- `kind-contract.ts:272`(kind 注册)、`plugin.ts:11074-11114`(告警路由/去重键)、`lead-dual-active-scan.ts`(Bridge 独立扫描器,量的是真·重复进程)。收养只减少**假**双活(孤儿)输入;扫描器与 kind 契约零改动。新增 kind `lead_body_adopted`(info 级审计)需登记 kind-contract + lead-alert.sh 白名单(`scripts/lead-alert.sh:185` 的 kind 枚举)。

## 2. 收养安全性推演(三真相源 → 四证合取)

收养放行必须同时成立(任一测不到 = fail-closed 维持 HOLD):

| # | 命题 | 测量源 | 失败语义 |
|---|---|---|---|
| P1 | lease 已 bind 且 holder(body)tuple 存活 | lease 行 + pid/lstart 双验 | holder 死 → 走正常 acquire 新生,不需要收养 |
| P2 | lease 记录的 supervisor tuple 已死 | 新增列 + pid/lstart 双验 | 活 → 真双活,deny(今天行为) |
| P3 | 进程表无本 Lead 任何 claude-lead.sh(argv census,排除自己) | ps 全表扫描 | 命中/扫描失败 → HOLD |
| P4 | body argv 身份证明 + 同名窗口恰 1、live pane 恰 1、pane tuple == holder tuple | tmux inventory + ps command | 多窗/多 pane/证明不齐 → HOLD(detect 级诚实失败) |

- P2+P3 是**双重独立**的「无监护人」证明(lease 记录轴 + 进程表轴),防单源说谎;P1+P4 是「body 是且仅是本 Lead 真身」的双重证明。
- 竞态封闭:多只候选 supervisor 同时判定通过 → `adopt` 单事务 CAS(`WHERE lead_key=? AND generation=? AND holder_pid=? AND holder_start=? AND bound_at IS NOT NULL`)只允许一只赢;输家重进环,下一轮 P2/P3 命中(赢家在位)→ HOLD/deny。
- 与 restart-services sweep 的并发:sweep 只发生在 bootout 后的无 job 期(FLY-1507 结构性竞态封闭),此时不存在 launchd supervisor;收养只由 launchd supervisor 发起(job loaded)。残余窗口(人工裸跑 claude-lead.sh)由 P3 census + CAS 仲裁。sweep 若先杀 body → P1 失败 → 收养自然放弃 → 正常新生。
- 旧行兼容:增列前写入的 lease 行 supervisor 列为 NULL → P2 无法测量 → **fail-closed 维持 HOLD**(今天行为逐字保留)。一次正常换代/新生后全舰队自然迁移到新行。

## 3. 收养后的诚实边界

- 被收养 body 携带冻结的旧启动参数(含 --model)——收养时跑 `lead_body_model_evidence`(`scripts/lib/lead-body-sweep.sh:609`)对照 manifest `resolvedModel`,不一致就在 `lead_body_adopted` 告警里明说「参数陈旧,待下次受控 restart 换身」。收养**不试图**解决换参数——那是 FLY-1507 restart 流程的职责分工。
- restart 波中若 sweep 失败留下幸存者、继任 supervisor 把它收养:N0-N4 验证仍会诚实报 failed(newborn 集合差不成立)——波报失败,但系统落在「有监护的旧身」而非「无监护孤儿+风暴」,下一波受控 restart 完成换身。

## 4. 结论(带进 plan 的机制清单)

1. **lease 双 tuple + `adopt` CAS 动词**(flywheel-comm:schema 增列、acquire 分类细化返回 `holder_orphaned`、新动词);
2. **claude-lead.sh 收养分支**(HOLD 环内 `denied_holder_alive` → 四证分类 → 收养重建监护现场 → `_wait_tmux_window`);
3. **restart-services ↔ storm gate 握手**(bootstrap 前 resume child key;验证循环识别 held 态并以独立错误上报);
4. **旁路收编**(flywheel-daemon.sh restart → bootout+bootstrap;runbook 修订);
5. **告警语义**(新增 `lead_body_adopted` info kind;`lead_dual_active` 收窄为真双活)。

## 5. 第二次 audit 补充证据(2026-08-02 晚,合并稿新增)

> 背景:本 issue 曾被两次独立派发。第二次 audit(晚间)从 lease generation history 与 restart-storm ledger 取到一组第一次 audit 未覆盖的一手证据,按 Lead 裁定原样并入本调研(见 design-correction.md)。行号引用与 §1 同基线。

### 5.1 病 A:换代验证 4/5 是假阴性(62s 窗口结构性短于真实换代)

数据源:`/tmp/flywheel-restart-20260802-*.log`、`~/.flywheel/logs/restart-fly1604-deploy-20260802-161235.log`、`sqlite3 ~/.flywheel/lead-lease.db "SELECT generation,holder_pid,holder_start,bound_at FROM lease_generation_history WHERE lead_key='flywheel-flywheel-eng-lead'"`(本地时间 = UTC-6):

| restart 报 ERROR 时刻 | 新 generation 成功 bind | 延迟 |
|---|---|---|
| 01:35:46 | gen 48 @ 01:38:25 | +2.6 分钟 |
| 03:15:50 | gen 50 @ 03:17:29 | +1.6 分钟 |
| 04:01:51 | gen 51 @ 04:16:32 | +14.7 分钟 |
| 16:16:53(当天最新代码) | gen 53 @ 16:28:04 | +11.2 分钟 |

5 次报失败里只有 04:42:44 一次是真失败(gen 51 body 4487 存活至 09:56 人工捞回,期间 5.2h 无新 generation)。验证窗口 = 30×2s + final ≈ **62s**(restart-services.sh:80-83, 1141-1161);而 wrapper→supervisor-ready 在负载下实测 **140s**(supervisor 日志 10:45:10→10:47:30),叠加 claude 冷启动,真实换代 2~15 分钟。**推论:即使 W3 的 gate resume 消除了闸门否决,窗口仍结构性短于被测过程**——重 Lead 的假阴性不会因 W3 消失,需要独立的验证语义修复(→ W5)。

旁证:`lease_generation_history` 的 `holder_start` 与 `bound_at` 逐秒吻合(差 ≤1s)→ **bind 是"supervisor 活 + body 新生 + model 已热解析"三命题的单一 commit 事件**,可直接作验证锚点(W1 的 `verify-bound` 已提供原子执行面)。

### 5.2 病 C:换代序列自身无 crash-safety(02:08 实锤)

`/tmp/flywheel-restart-20260802-020430.log` 在 `02:07:59 Stopping and unloading Lead flywheel-eng-lead via launchd bootout` 一行**戛然而止**(全文件末行)——restart 进程死于 bootout 之后、bootstrap 之前,launchd job 被留在 unloaded 态无人 reconcile(03:02 那轮 probe 因此连 bootout 行都没有)。换代 6 步(bootout→quiesce→sweep→rm pidfile→bootstrap→verify)无 durable 意图记录(→ W6)。

### 5.3 storm ledger 定量 + 当前生产风险

`~/.flywheel/restart-ledger/lead.flywheel-flywheel-eng-lead.jsonl`:总计 123 次 wrapper 启动,事故窗口(08-02T07:00–16:59Z)**72 次**;`.state` 在晚间 audit 时刻仍为 `held_alert_attempted`(episode 118)。即:**catch-22 的 churn 填账 → brake 落闸 → 健康态下一次 supervisor 死亡将无人 respawn**。W3 的 controlled-wave arm 只覆盖**受控 restart/reconcile 波**。**诚实边界(R8-5/R15 修正)**:非受控场景下 gate held 时 wrapper 在 exec supervisor 之前就 exit 0(flywheel-lead-wrapper.sh:148-175),W2 收养链根本没有机会执行——已 held 的 episode 仍需下一次 restart-services controlled arm 或人工 resume 才解。W4 必须同时收编 daemon 与 v2-scheduler 两条 kickstart 旁路,否则「churn 源已消除」结论不成立。

### 5.4 外部连环杀手的直接观测(支持 W4)

supervisor 日志今晨 10:47–10:57:每个 supervisor 存活约 74s 即收 `Shutdown signal received...`(SIGTERM),launchd 1-2s 后 respawn,周期 ~77s;ledger seq 12-16(07-30)同样精确 77s 间隔。与 §1 的 kickstart -k 旁路时间形态吻合。候选现有两条:人工/`flywheel-daemon.sh` 与 v2-scheduler stale-heartbeat repair;后者有 5-60s bounded backoff + confirm window,时间形态尤其值得比对,但生产 cutover 是否 armed 未证。W4 同时收编两条代码路径;杀手身份的最终 forensic(生产 LaunchAgent/cutover 状态 + scheduler action intent)不阻塞本单。
