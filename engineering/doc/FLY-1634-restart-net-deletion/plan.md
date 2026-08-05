# FLY-1634 重启减法第一刀 — 实施计划

Issue: FLY-1634 (https://linear.app/geoforge3d/issue/FLY-1634/重启减法简单为主第一刀-restart-services-花边机制净删除验收机制变少代码变少)
日期: 2026-08-04
基于: 无
状态: codex-approved(design review 4 轮:R1 7 项、R2 4 项、R3 3 项全采纳,R4 APPROVED)

## 0. 硬约束(founder 直令 2026-08-04)

本单是**减法**:交付物主要是删掉的东西。PR diff 里 restart 相关代码**净行数必须为负**;机制数量清点前后对比必须下降。任何一刀若「删了会坏」,必须先拿出坏的实证再讨论保留。

## 1. 事故审计与根因实证(设计前完成,全部为真机取证)

### 1.1 事故面貌

今晨(2026-08-04 08:22)全舰重启:16 Lead 仅 9 成功。6 败全部出在验证/护栏层,核心动作(bootout→bootstrap)零失败:

| Lead | 失败署名 | 层 |
|---|---|---|
| geoforge3d/product-lead | `body sweep is incomplete/unsafe (collect=0 terminate=2)` | 刀② sweep 护栏 |
| growth/rafiki-lead | 同上 | 刀② |
| growth/reflection-lead | 同上 | 刀② |
| joycon-typeless/joycon-lead | 同上 | 刀② |
| tidal-echo/sub-lead | 同上 | 刀② |
| growth/mufasa-lead | `replacement lacks newborn/body evidence after 30 probes` → `restart gate ledger did not advance` | 刀④ 判据层 |

历史对照(/tmp/flywheel-restart-*.log):同一 `collect=0 terminate=2` 署名 08-01 打在 belle-lead、08-02 打在 product-lead + tidal-echo-cos-lead(今天成功的 Lead)。**失败在 Lead 间漂移** → 不是静态配置问题,是竞态。

### 1.2 刀② 根因:zombie 被误判为 sensor failure,且 rc=2 是闩锁

静息态只读复现(sweep 库 stub 杀伤动作后对 16 Lead 全跑):全部干净 —— 每个 Lead 恰一个 full-proof 行、archive 健康、零 detect 行。失败只发生在 sweep 进行中。

macOS zombie 行为实测(python fork 实验,本机):

| 探针 | zombie 上的结果 |
|---|---|
| `kill -0 <pid>` | rc=0("存活") |
| `ps -o lstart=` | rc=0,**返回原始出生时间**(与期望 tuple 完全一致) |
| `ps -o command=` | rc=0,返回 `<defunct>`(不再是原命令) |

代入 `scripts/lib/lead-body-sweep.sh` 的 `_lead_body_target_identity_matches`:

1. `_lead_body_tuple_state` → `kill -0` 活 + lstart 匹配 → **返回 0「精确 tuple 存活」**
2. `lead_body_process_command` → `<defunct>`
3. `_lead_body_command_proof "<defunct>"` 失败 → **返回 2(sensor failure)**

`lead_body_terminate` 里所有 `|| rc=2` 是**只置位不复位的闩锁**:KILL 信号发出后紧跟的第一次 poll(毫秒级)几乎必然撞上尚未被 tmux server reap 的 zombie → rc=2 永久闩死。即使随后一切干净死透、清场完美,最终仍报 `body sweep is incomplete/unsafe`。是否中招取决于 tmux server 当时的 reap 延迟(重启风暴期 cmux refresh/rescue 狂打 tmux server,单线程 event loop 延迟拉大)—— 完美解释漂移性与「护栏每次红但 Lead 实际全死透了」。

**结论:护栏逻辑本身错**(把「已成功杀死、等待 reap」判成「不安全」)。按 issue 决策规则:逻辑错 → 以删为先重做,不修补原结构。

附带发现(同一根因族):`proof=detect` 类目标(全机 proctable 里 `claude --agent <lead_id>` 匹配但 project 证明不全的进程)**从不被 terminate 处理,只要存活就必然 rc=2** —— 一个"看见了但既不杀也不放行"的死结构。静息态下 detect 集为空,但它是第二个随时可触发的必败开关。

### 1.3 刀① 事实核查:两条「收养」路径,命运不同

- **restart 侧正闭合**(`lead_replacement_reconcile_ready` rc=0,W6 marker reconcile):生产日志中**从未成功过一次**。今晨 eng-lead、mufasa 两个 retained marker 均走到 `no proven replacement progress; entering normal lifecycle`。issue 断言成立。
- **supervisor-boot 侧收养**(`claude-lead.sh` `_lead_adopt_existing_body`):**今晨 08:24:18 真实成功过一次**(eng-lead 补拉的 supervisor 收养了 08:05 inline 事故留下的孤儿 body 72979,`lead_body_adopted` 告警实发,log:`Monitoring adopted Lead body PID 72979 in tmux @625`)。issue 的「从未成功」断言对这半条**不成立**,必须诚实修正。

它解决的真问题:supervisor 死、body 活 → launchd KeepAlive 秒拉新 supervisor → 身份预检撞活 body → 拒启 → crash-loop(FLY-1602 原始 bug)。**删除后必须保留对这个场景的收敛能力**,方案见 §2.1:硬换 + `--resume` 续会话,收敛性等价,机制少一个数量级。

### 1.4 刀③ 事故与现状

08-04 08:05:Lead 从自己会话 inline 跑 restart → 脚本进到自己 Lead 的 bootout 环节把执行者(自己所在进程树)杀了 → 半途孤儿态(留下 eng-lead/mufasa 两个 retained marker + 孤儿 body)。08:22 的补跑手工 detach 还打出 `(eval):3: command not found: setsid`(macOS 无 setsid(1))。「正确姿势」目前是一条人为纪律(self-ship 队列 / 手工 detach),而人为纪律已被证明会被违反。

### 1.5 刀④ 现状判据清单(全部参与成败判定并告警)

`launchd_lead_outcome_ready` 的 N0-N5:supervisor loaded + 新 pid/lstart tuple + pid 文件相等 + `lead_body_newborn_ok`(单窗单活 pane + 全旧 tuple 死绝 + 新 body 不在旧快照)+ model evidence + lease verify-bound 四 tuple/generation;失败后还有 `lead_restart_classify_wave_gate`(gate ledger 归因,mufasa 今晨死在这)+ `lead_restart_replacement_progressed`(converging rc=4)+ 900s convergence journal 终判。这一层产生了今晨第 6 个失败(mufasa):**Lead 实际换代与否未知,但判据链自身不闭合就记失败并告警**。

## 2. 四刀设计

### 2.1 刀①:删除整条收养路径(纯删 + 一个等价简单替代)

**删**:
- `scripts/restart-services.sh`:`lead_replacement_reconcile_ready`(约 1169-1330)整函数;W6 marker 扫描里的 reconcile-ready/converging 分支(1946-1979);convergence journal 的 `reconcile` 行处理。
- `scripts/lib/lead-restart-lifecycle.sh`:`lead_restart_replacement_progressed`、`lead_restart_marker_retired`、marker 严格加载中仅服务收养闭合的分支。
- `scripts/lib/lead-body-sweep.sh`:`lead_body_adoption_evidence`、`lead_body_attach_adopted`、`lead_body_adoption_hold_evidence`、`LEAD_ADOPTION_*` 全局。
- `packages/teamlead/scripts/claude-lead.sh`:`_lead_adopt_existing_body` 整函数及其调用位点。
- `packages/teamlead/scripts/lib/lead-identity-preflight.sh`:`lead_identity_adopt_lease`(以及 lead-identity CLI 的 `adopt` 子命令若无其他调用方)。
- 告警 kind `lead_body_adopted`:`scripts/lead-alert.sh`、`packages/teamlead/src/LeadAlertNotifier.ts`、`LeadWatchdog.ts`、`bridge/kind-contract.ts` + 对应测试。
- 测试:`scripts/__tests__/lead-replacement-reconcile.test.sh`(176 行)整文件;`scripts/test-lead-body-sweep.sh` 收养相关用例。

**等价简单替代**(供 supervisor-boot 孤儿场景,Codex R1 #1/#2/#3 + R2 #3 修订后的完整闭环)。`claude-lead.sh` 的 `4|5)` 分支(claude-lead.sh:3370)拆开处理:

- **rc=5(`idempotent_adopted`,= 本 supervisor 自己已绑定的活 body)**:不硬清(那是自杀循环)。最小替代 ≈10 行,alive 分支的前置条件按 `_wait_tmux_window` 的实际合同写全(R3 #1:该函数按全局 `LEAD_WINDOW_ID` 等待且每轮要求 `_tmux_target_matches_archive` 成立,claude-lead.sh:2054-2071,1321-1330):holder tuple 可执行(kill -0 + lstart 匹配,state 首字符 `Z` 判死)**且** `LEAD_WINDOW_ID` 非空 **且** `_tmux_target_matches_archive "$LEAD_WINDOW_ID" true` 成立 **且** archive 的 pane pid+lstart 精确等于 lease holder tuple → 才 `_wait_tmux_window; continue`。**sensor_error 或 live-but-unproven(窗口/archive 缺失、漂移)→ 走现有有界 HOLD/backoff 重试**,不硬清也不盲等;tuple 已死/zombie → 落入与 rc=4 相同的路径。`idempotent_adopted` 状态在 acquire 合同里**保留**(读路径),配五态状态矩阵测试(alive-closed / dead / Z / sensor_error / window-archive mismatch)。
- **rc=4(`holder_orphaned`,该状态保留,作为 hard-clear 触发器)**:

1. **session 抢救**(≈10 行,R1 #3):kill 前从 lease 返回的 exact holder tuple 的 argv 里读 `--session-id`/`--resume`,若 `SESSION_ID_FILE` 缺失则原子补写 —— 覆盖「fresh launch 成功但 session 文件未落盘时 supervisor 死亡」的窄窗口(wrapper 是先 launch 后写文件,claude-lead.sh:3497-3538)。
2. `lead_body_hard_clear` 以 **exact holder pid+lstart tuple 模式**清掉孤儿 body(只杀 tuple 仍匹配且 Lead argv token 精确匹配的进程,见 §2.2)。
3. **清空本轮 lease claim → `continue` 外层循环重新 acquire**:拿到**新 generation** 后走既有 fresh-launch/bind 路径。不复用旧 generation —— `lead_identity_prepare_lease` 在 orphan 态导出的是旧 generation,直接 launch 会在 bind CAS 撞墙杀新窗(lead-identity-preflight.sh:124-170,claude-lead.sh:2024-2039)(R1 #1)。
4. 配套一处 TS 判活修正(与根因同族,R1 #1):`packages/flywheel-comm/src/lead-lease.ts` 的默认 tuple 判活谓词(`processTupleStateWithStart`,366-395)把 `ps state` 首字符 `Z` 判为死 —— 否则 zombie holder 会让 acquire 永远返回 orphan,形成新循环。

wrapper 既有 `--resume` 逻辑不动;记忆连续性由步骤 1+既有 resume 保证。代价:孤儿场景下 Lead 会话被硬杀重连一次(~30s);频率:刀③落地后收窄到真 supervisor crash,罕见。**换代就是换代。**

**TS 收养执行面一并删除**(R1 #7 + R2 #3 + R3 #3):`packages/flywheel-comm/src/lead-lease.ts` 的 `AdoptLeaseInput`/`LeadLeaseStore.adopt`(183-193,816-895)、新库初始化里的 `CREATE TABLE IF NOT EXISTS lease_supervisor_audit`(lead-lease.ts:66-78,不 DROP 既有机器上的表 = 数据自然保留)、`packages/flywheel-comm/src/commands/lead-lease.ts` 的 `adopt` CLI case(358-425)、`index.ts:111` help 文案里的 `adopt` token、仅被收养测试消费的 audit 读面(`LeadLeaseSupervisorAuditRow`/raw mapper/`listSupervisorAudit`,lead-lease.ts:124-135,218-268,1061-1071)及其专属测试。`holder_orphaned`/`idempotent_adopted` 读路径保留。

实施备注(Codex R4,非阻塞):`lead_identity_process_table`(lead-identity-preflight.sh:266-275)唯一消费者是将删的 supervisor census —— Codex descendant snapshot 若复用它则保留,若用独立单快照 helper 则连测试 stub 一并删;按逐符号 grep 门执行。

**adoption-only shell 残面一并删除**(R3 #3):`lead-identity-preflight.sh` 的 `lead_identity_supervisor_census` 及其专属传感链 `LEAD_IDENTITY_SENSOR_CHAIN`/`lead_identity_build_sensor_chain`/`lead_identity_supervisor_command_matches`(277-356,唯一生产调用方是 `_lead_adopt_existing_body`)+ 测试;`claude-lead.sh` 的 `_lead_identity_alert_info`(唯一调用方是 `lead_body_adopted` 告警,1603,3314)与 `adoption_hold` HOLD 分支(3399-3401,随新 rc=4/5 路由一并删除)。

**marker 降级为面包屑,schema 同步瘦身**(R1 #4 自洽性):bootout 前写、成功后删的语义保留(它仍是 storm-gate `arm_controlled_wave` 的 attempt 载体)。但 marker writer 现强制写入 `LEAD_RESTART_LEASE_BASELINE`(lead-restart-lifecycle.sh:465-520),`restart-storm-gate.py` 的 controlled-marker parser 又强制校验 `lease_baseline` 字段(restart-storm-gate.py:279-338)—— baseline 只服务已删的证明链,所以**三处同步删**:marker schema 去掉 `lease_baseline` 字段、writer 去掉 baseline 采集依赖、storm-gate parser 去掉该字段校验;`scripts/__tests__/lead-restart-controlled-wave.test.sh` 与 `scripts/__tests__/restart-storm-gate.test.sh` 同步改。残留 marker 在下轮重启开头 = `log WARNING + rm -f`,不再有严格解析失败→按 key 拒 mutation→alert_severe 的整条链。

### 2.2 刀②:sweep 护栏重做为 `lead_body_hard_clear`(以删为先)

诊断结论(§1.2):护栏逻辑本身错。按 issue 规则修,但修的方式是**替换整个结构**,不在 929 行上打补丁:

新函数 `lead_body_hard_clear project lead_id backend [expected_pid expected_lstart]`(目标 ≤120 行,同文件,其余全删;契约按 Codex R1 #2 收紧):

1. **两种调用模式**:
   - **restart 路径**(无 expected tuple):目标 = `=flywheel` session 里窗名 `${project}-${lead_id}` 的窗口(沿用 session-scoped inventory,防误伤 QA/Runner 同名窗)。**backend 分治**(R2 #1:Codex argv 不含 project/Lead 身份 —— `codex resume --remote …` 是通用形状,tui-window.ts:83-97,身份只在窗名/env 里;全机按形状扫会误杀别的 Codex Lead/infra bot):
     - claude-code:kill-window + 全机 proctable 里 project 证明成立的残余(`lead_identity_command_matches` 精确 token + `_lead_body_claude_project_matches`)→ TERM → 短等 → KILL。
     - codex-app-server:kill-window **前**先从精确窗口快照 pane 及可归属 descendants 的 pid+lstart tuples,之后 TERM/KILL/终判**只**针对这些 exact tuples;**不做**全机 codex 形状扫描。
     前置条件:该路径只在 authority 三方校验通过后调用(现状即如此)。
   - **supervisor 孤儿路径**(带 expected tuple):**只**杀 pid+lstart 仍精确匹配**且** Lead argv token 精确匹配的那个 holder —— 权威来自 lease 返回的 exact tuple,比 window 名/receipt 证明更强也更简单。
2. **终判(唯一失败条件)**:有界轮询(默认 10s)内**重新枚举** exact tmux window/pane(两 backend)+ proctable(claude-code)/快照 exact tuples(codex),不存在**可执行**的同身份进程即成功 —— 判活谓词把 `ps -o state=` **首字符** `Z` 判为死(state 是字符序列,如 `Z+`;zombie 不能执行代码,不构成双身份风险 —— §1.2 根因的修正)。
3. **失败语义**:轮询期间的 sensor 抖动 = 本轮重试,**绝不闩锁**;但 deadline 时仍持续不可判(如 tmux server 全程无响应)→ **返回非零,fail-closed**,不 fail-open。
4. `detect` 类(lead_id 匹配但 project 证明不全)降级为 debug log,不参与判定 —— 静息态该集为空(§1.2 实测);孤儿场景的误漏由 exact-tuple 模式兜住(孤儿的权威身份来自 lease tuple,不依赖 receipt/argv 证明完整性)。
5. 收尾:`rm -f` 该 Lead 的 `.claude.tmux` archive(body 已清,新 wrapper 会重写)。

**删**:`lead_body_collect_targets`、`lead_body_terminate`、`_lead_body_send_interrupts`、`_lead_body_signal_full_targets`、`_lead_body_any_full_alive`、`_lead_body_wait_stage`、`_lead_body_has_live_detect`、`_lead_body_cleanup_windows`、`_lead_body_cleanup_archive`、`lead_body_swept_all_dead`、`lead_body_newborn_ok`、`lead_body_model_evidence`、full/detect 两级证明分类、targets 快照文件与 normalize —— lead-body-sweep.sh 929 → 约 150 行。调用位点(restart-services.sh launchd 路径 + legacy 路径、claude-lead.sh 预检)统一改调 `lead_body_hard_clear`。

C-c 礼貌打断阶段一并删除:Lead 换代本就要终结进程,TERM 就是礼貌层;省 5s×16 的等待。

### 2.3 刀③:脚本开头自分离(唯一的加,≈25 行换整条人为纪律)

`restart-services.sh` 参数解析后、任何状态变更前:

```bash
if [[ "${FLYWHEEL_RESTART_FOREGROUND:-0}" != "1" && "$DRY_RUN" != "true" ]]; then
    _detach_log="/tmp/flywheel-restart-detached-$(date +%Y%m%d-%H%M%S).log"
    set -m   # 子进程获得独立 process group,逃出调用方(Lead launchd job)的 group kill
    FLYWHEEL_RESTART_FOREGROUND=1 nohup "$0" "$@" </dev/null >>"$_detach_log" 2>&1 &
    disown
    echo "[restart] detached (PID $!, log: $_detach_log)"
    exit 0
fi
```

- `set -m` + `nohup` + `disown`:子进程独立 PGID(非交互 bash 下已实测)+ 免疫 HUP;launchd 清理 job 时按同 PGID 清进程(launchd.plist(5)),独立 PGID 逃出 group-kill —— 08:05 那类事故物理不存在。不依赖 macOS 没有的 `setsid(1)`。变量名用现状的大写 `DRY_RUN`(restart-services.sh:574-598;脚本 `set -u`,R1 #6)。
- `FLYWHEEL_RESTART_FOREGROUND=1` 逃生口:`update-flywheel.sh:88` 调用点显式加(launchd updater 消费退出码驱动 self-ship marker ack,契约不变,并为其非零退出码映射留回归用例);测试 harness 的真实 top-level 调用(如 test-restart-services.sh `bo_run`,1938-1960)显式前台,否则测试只验证 parent 早退;`--dry-run` 天然前台。这些是代码不是人为纪律。
- self-ship 队列(`self-ship-restart.sh` → QueueDirectories)保持不变:它仍是 ship 路径的正确入口;刀③兜的是「有人绕过队列直接跑」的那类错误。
- 529 真机 E2E 断言:child PGID ≠ 调用方 Lead job 的 PGID,且「bootout 调用者 Lead 后 child 仍继续跑完」实走一遍(R1 #6)。

### 2.4 刀④:成功判据收敛为一条(纯删)

**每 Lead 成功判据**:`launchctl` probe 显示 job loaded 且 supervisor pid+lstart ≠ 旧 tuple。**全舰成功判据**:全部 Lead 按此回归 + Bridge `/health` 通过。完。

**删(全部降级为 debug log,不参与成败判定、不告警、不重试阻塞)**:
- `launchd_lead_outcome_ready` 里的 newborn 证明、pid 文件相等、model evidence、lease verify-bound/generation → 函数缩为 supervisor-tuple probe(~15 行)。
- 30×2s verify 循环 + final re-probe → 单个有界等待(supervisor tuple 出现,默认 60s)。
- `lead_restart_classify_wave_gate`(gate ledger 归因;mufasa 今晨死于此)整函数 —— storm-gate 的 **arm** 保留(它让 bootstrap 后 wrapper 被放行,是功能件),**verdict 归因**删除。
- `lead_restart_replacement_progressed` + `LEAD_RESTART_CONVERGING_*` 12 个全局 + converging journal + 900s 终判 drain(2042-2106)。
- `lead_restart_verify_bound`/`lead_restart_progress_snapshot` 在 restart 判据里的使用(lease 库本身与其他调用方不动;bootout 前 baseline 采集若仅服务已删证明链则一并删)。
- 失败路径上仅服务已删机制的 alert kind/文案(`lead-restart-lease-*`、`lead-restart-wrapper-event-unproven-*`、`lead-restart-gate-held-*` 等)。`deploy_failed`/`deploy_degraded` 汇总告警保留。
- debug 观察(不判定):bootstrap 后打一行 `body observation: <pane pid/model flag or none>`,纯 log;全舰完成汇总里列出 `body=none` 的 Lead 清单(仍不改 verdict、不告警),作为人工/例行 fleet 检查的入口(R1 #5)。
- **文档/引用残面同步清理**(R1 #7,R2 #2 修正):`scripts/flywheel-daemon.sh:936-938` 的 N0-N5 atomic 说法、`CLAUDE.md` 中把 adoption/N0-N5 写成当前架构的段落。**KEEP(明确不删)**:`package-onboard.sh:111-112`、`package-onboard-files.allow:48-49` 的库清单及 smoke 断言 —— `lead-body-sweep.sh` 与 `lead-restart-lifecycle.sh` 是**瘦身不是删文件**,仍被 restart-services.sh:44,1028 与 claude-lead.sh:243,247 运行时 source,packaged install 必须继续携带。

**保留(明确不动)**:bootout 前 authority 三方校验(`lead_restart_validate_authority`,防错杀)、bootout 后 quiescence 证明(防双 supervisor)、`arm_controlled_wave`、Bridge 停/起/health、build、rollback、notify 汇总、`record_lead_restart_detail` 计数、deployed-sha 记账、cmux watcher 重启段。

### 2.5 机制清点(验收指标 #1)

| # | 现状机制(参与成败判定) | 处置 |
|---|---|---|
| 1 | replacement marker 严格解析 + retirement + 按 key 拒 mutation | 降级面包屑(log+rm) |
| 2 | restart 侧收养正闭合(reconcile_ready N0-N5) | **删** |
| 3 | supervisor-boot 收养(adoption evidence/attach/lease CAS) | **删**(替代=硬清+resume) |
| 4 | full/detect 两级身份证明 sweep + 闩锁 rc | **删**(替代=hard_clear 单判据) |
| 5 | sweep 清场护栏(windows unsafe/archive/live-detect) | **删** |
| 6 | newborn 单体新生证明 | **删**(debug log) |
| 7 | body model evidence | **删**(debug log) |
| 8 | lease verify-bound 四 tuple/generation 闭合 | **删**(出判据) |
| 9 | progress/converging rc=4 + 900s convergence journal | **删** |
| 10 | gate ledger verdict 归因(classify_wave_gate) | **删**(arm 保留) |
| 11 | 多判据终判 + ~15 个失败 alert kind | 收敛为 1 判据 + deploy 汇总告警 |
| 12 | 「必须记得正确姿势跑」人为纪律 | **删**(替代=自分离) |

12 → 5(面包屑 marker、hard_clear、launchd tuple 判据、Bridge /health、自分离)。

### 2.6 净行数预估(验收硬指标,实施时以 diff 实测为准)

| 文件 | 现在 | 预估 | Δ |
|---|---|---|---|
| scripts/lib/lead-body-sweep.sh | 929 | ~150 | −780 |
| scripts/restart-services.sh | 2463 | ~1900 | −560(含 +25 自分离) |
| scripts/lib/lead-restart-lifecycle.sh | 1186 | ~850 | −340 |
| packages/teamlead/scripts/claude-lead.sh | 3642 | ~3510 | −130 |
| lead-identity-preflight.sh + TS 告警面(4 文件) | — | — | −90 |
| TS 收养执行面(lead-lease.ts adopt + CLI case + 专属测试) | — | — | −250 |
| restart-storm-gate.py lease_baseline 校验 + marker schema | — | — | −40 |
| 测试:reconcile.test.sh 删 + sweep 测试重写 + restart/controlled-wave/storm-gate 测试瘦身 − 新增用例 | — | — | 净 −600 上下 |

生产代码净删 ≈ −1900,含测试 ≈ −2500。**任一文件若实施中发现删不动(有未知调用方),停下取证再定,不硬删。**

## 3. 测试计划(TDD)

1. **zombie 判活回归**(新,直击根因):python/perl fixture 造真 zombie,断言 hard_clear 判活谓词视 state 首字符 `Z` 为死、全程 rc=0;老逻辑在同 fixture 下复现 rc=2(RED 起点)。
2. **zombie × lease 闭环**(R1 #1):真 zombie holder fixture 下,lease 默认谓词判死 → hard-clear 后 acquire 推进 generation 且 bind 成功(vitest,packages/flywheel-comm)。
3. **hard_clear 行为**:bash harness(`scripts/__tests__/`)—— restart 模式(同名窗清除 + project-proven 残余 TERM→KILL)、exact-tuple 模式(只杀精确 holder)、detect 类只 log 不判死、10s 有界、sensor 抖动不闩锁、deadline 持续不可判返非零(fail-closed)、claude + codex 两 backend 形状。**双 Codex 隔离负例**(R2 #1 / R3 #2,逐字要求):目标 Codex Lead 与另一 Codex Lead/infra bot 同时存在时,重启目标**不得** signal 后者 —— 断言非目标进程的 pid+lstart 在 TERM、KILL、final verdict 三个阶段的 target set 中均不出现;此用例纳入 §3.8 的 CI 注册。
4. **自分离**:`FLYWHEEL_RESTART_FOREGROUND=1` 前台语义逐字兼容(updater rc 契约 + 非零退出码映射回归);缺省路径 fork 出独立 PGID(断言子进程 pgid≠父 pgid);`--dry-run` 不 fork;test harness top-level 调用全部显式前台。
5. **判据收敛**:supervisor tuple 判据单测;删除面(newborn/model/lease/gate-classify/lease_baseline)在 test-restart-services.sh、controlled-wave、storm-gate 测试里改写或删除,保留者全绿。
6. **孤儿场景**(刀①替代):harness 模拟 supervisor 死 body 活 → 新预检走 session 抢救 + 硬清 + 重新 acquire + fresh launch,不 crash-loop;session 文件存在/缺失两态都覆盖(R1 #3)。
7. **529 槽真机 E2E**(验收 #2):单 Lead 换代一次 + 故障注入一次(kill supervisor 留孤儿 body,验证收敛;高负载下换代验证 zombie 窗口不再触发失败;child PGID ≠ 调用 Lead job PGID 且 bootout 调用者后 child 跑完)。
8. **CI 注册**(R2 #4):`.github/workflows/ci.yml` 是逐文件枚举(无 glob runner),当前只登记了 restart-storm-gate 与 test-restart-services;重写后的 hard-clear suite(及 controlled-wave suite)必须**显式登记进 ci.yml**,或并入已登记 suite —— zombie/sensor/exact-tuple/codex 负例不能只手跑。
9. 全仓门:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 相关 `scripts/__tests__/*.test.sh` 与 `scripts/test-*.sh` 逐个跑。

## 4. 验收对照

| issue 验收 | 计划落点 |
|---|---|
| 净删除指标(行数负、机制数降) | §2.5 12→5;§2.6 净 −1900+;PR 描述附实测 diffstat 与机制对照表 |
| 529 槽 E2E:换代 + 故障注入 | §3.7 |
| 生产观察 16/16(ship 后,不阻塞 merge) | 判据即 §2.4 的唯一判据;下次自然全舰重启读数 |
| 文档含删除清单 | §2.1–2.4「删」清单 + 本文档随 PR 合入 |

## 5. 风险与诚实边界

1. **body 层病态不再挡部署 verdict —— 这是一段真实的 accepted risk,无自动接手方**(按 Codex R1 #5 核实后修正):supervisor 起来但 body 永远起不来(坏 token、wrapper 持续 hold 等)会计成功。核实现状:LeadWatchdog 只识别 blocked conditions、找不到窗口时静默清态(LeadWatchdog.ts:318-332);RunnerIdleWatchdog 只扫 running Runner;dual-active scan 不检测零 body;Bridge /health 不含 per-Lead body 事实 —— **没有现成自动链兜住零 body**。接手方是人工/例行检查:§2.4 的 `body=none` 汇总清单 + fleet 例行巡检。这是 founder 拍的取舍(判据只留一条),作为 accepted risk 写入 PR 描述;若生产读数证明该窗口真实咬人,再立独立小单,不在本单加机制。
2. **孤儿收养改硬清**:supervisor-crash 场景 Lead 多付一次 kill+resume(~30s)。记忆连续性 = argv session 抢救(§2.1 步骤 1)+ 既有 `--resume`;「fresh launch 成功但 session 文件未写」的窄窗口已由抢救步骤覆盖,若抢救也失败(argv 不可读)则该次上下文丢失 —— 明确接受。换来删除整条 adoption 机制。若实施/QA 中发现 resume 链路在该场景有坑,停下上报,不静默保留收养。
3. **detect 类降级为 log**:同 lead_id 异 project 进程不再阻塞换代。静息态该集为空(§1.2 实测);真出现属配置事故,log 留证 + watchdog 兜底。
4. **删除面较宽**(6 个 shell/TS 文件 + 测试):实施节点必须逐符号 grep 全仓确认无第三方调用方后再删;`package-onboard.sh`/`package-onboard-files.allow` 的两个库条目**逐项确认保持存在、不删除**(两库瘦身不删文件,§2.4 KEEP)。
5. 收养半条断言修正(§1.3):supervisor-boot 收养今晨成功过一次 —— 本计划仍按 founder「换代就是换代」删除,但以实证替代想象,取舍写明。

## 6. 实施结果与验收记录

### 6.1 删除结果

- restart 相关代码(`scripts/`、`packages/teamlead/`、`packages/flywheel-comm/`)最终实测:新增 1045 行、删除 3688 行,**净删 2643 行**;全 PR 含文档最终仍净删 2358 行。
- 五个主要实现文件:body sweep 929→464(−465),restart-services 2463→1907(−556),restart lifecycle 1186→848(−338),claude-lead 3642→3590(−52),identity preflight 356→241(−115)。
- 机制清点按 §2.5 落地:12→5。adoption 写路径、replacement reconcile、newborn/model/lease/gate 多层 verdict、convergence journal、严格 marker schema 均已删除;保留的 marker 只作面包屑。
- 自分离是唯一新增运行机制;默认非 dry-run 在状态变更前 detach,updater 显式前台。

### 6.2 自动验证

- restart shell suite:117/117;hard-clear:14/14;controlled-wave:10/10;identity preflight:23/23;self-detach:5/5;storm gate:22/22;CI structure:PASS。
- flywheel-comm:102 files / 1380 tests;teamlead 相关 LeadWatchdog + kind contract:74/74。
- R1 follow-up:真实 Bash 3.2 零参数路径先复现 `RESTART_ARGS[@]: unbound variable`,修复后 5/5;TS real-zombie fixture 在当前 managed sandbox 因 `/bin/ps` EPERM 明示 skip,其余 8/8,由 unsandboxed CI 执行真实 tuple 断言。
- `pnpm lint` 与 `pnpm -r build` 通过;`git diff --check` 通过。
- 全包断言运行中发现两项仓库/Runner 环境噪音:真实 HOME 的热模型策略使 config snapshot 漂移(干净 HOME 下 598/598),以及 claude-runner 长文件 112/112 后 Vitest worker IPC timeout;另有 voice-bridge 竞态用例并行时一次失败,单独复跑 17/17。均与 restart diff 无调用关系,未为本单改动。

### 6.3 529 真机 E2E 边界

2026-08-04 在槽 2/3/4 以 sandbox 精确提交 `c69d1582` 实跑。部署到达真实 `claude-lead.sh` 与真实 Claude 进程,但当前 Codex Runner 沙箱禁止全量 `ps`(`operation not permitted`)及跨执行单元 `kill(0)`,导致既有 tmux/identity 安全探针按设计 fail-close;独立 Claude 配置又触发首次登录,180 秒内无法形成 inbox-ready lease。因此**本会话没有把 529 换代 + 孤儿 sweep 伪报为通过**。

所有测试槽锁、测试 manifest、私有 tmux server 与 sandbox 临时分支均已清理。已通过 `flywheel-comm` 请求 Lead 在不受该进程沙箱限制的 operator shell 补跑 §3.7;此项保持为合并前外部 QA 证据,生产 16/16 仍按 issue 定义为 ship 后观察项。

### 6.4 独立 QA 节点交接合同(Lead 裁定)

529 两项由独立 Claude QA 节点执行,实现节点不再碰生产 tmux。QA 必须遵守:

1. 取 PR head SHA,把同一 SHA 推到 `xrliAnnie/flywheel-qa-sandbox` 临时分支;部署输出的 `branchSha` 必须逐字等于 PR head。
2. 用 `mktemp -d` 建独立目录,显式创建 `qa_socket=<dir>/tmux.sock`;每一条 tmux 观察/破坏命令都写成 `tmux -S "$qa_socket" ...`。**禁止裸 `tmux`、禁止依赖 `TMUX_TMPDIR`、禁止命中默认 socket。** `claude-lead.sh` 侧显式传 `FLYWHEEL_TMUX_SOCKET_OVERRIDE="$qa_socket"`;test-deploy 侧开 `SKIP_DEV_CHANNELS_WORKAROUND=1`,避免其默认-socket send-keys workaround。
3. **单 Lead 正常换代**:记录旧 supervisor pid+lstart、`tmux -S "$qa_socket"` 读到的旧 window/pane pid+lstart;TERM 旧 supervisor 并以同一 slot manifest 重启 wrapper;断言新 supervisor tuple 不同、旧 pane tuple 消失、目标窗恰一个、Bridge `/health` 200。
4. **孤儿 sweep 故障注入**:再次记录 tuple,KILL supervisor 但保留 body;确认旧 pane 仍在后启动继任 wrapper;断言日志出现 session identity 恢复/`Cleared orphan Lead body`,旧 body tuple 消失、新 body tuple 出现、lease generation 前进、目标窗仍恰一个、Bridge `/health` 200。禁止手工 kill-window 冒充 hard-clear 成功。
5. **R1 MEDIUM `hard-clear-post-term-census-single-shot`**:在隔离 slot 的 PATH 放 one-shot `tmux` shim;shim 必须校验收到的前两个 argv 是 `-S "$qa_socket"`,正常时原样 `exec` 真实 tmux argv,不得自行再拼一次 `-S`。设 `LEAD_BODY_CLEAR_TERM_ATTEMPTS=1`,让前两次 `list-panes` 成功、只让 TERM observation 后/KILL 前的第 3 次 `list-panes` 失败。正确结果是 transient blip 被重试、KILL/convergence 继续且本次换代不计失败;否则在 QA 报告把该 finding 标 `residual` 并附 rc/log,不得写 covered。
6. **R1 MEDIUM `orphan-clear-drops-managed-and-authority-guards`**:保留一个 exact pid+lstart 的 live holder,另起 `LEAD_LAUNCH_MANAGED=false` 的手工 supervisor 指向同一隔离 manifest/HOME。断言手工实例不向 holder 发 TERM/KILL、不 acquire/推进 generation,并留下 authority denial;若 holder 被杀或 lease 被抢,标 `residual`。所有观测仍只用 `tmux -S "$qa_socket"`。
7. 高负载/zombie 观察:在第二次换代同时制造短命子进程压力,断言不再出现 `collect=0 terminate=2`,持续 sensor failure 仍 fail-close。
8. teardown 顺序:先按部署 JSON 的 exact supervisor/Bridge PID 终止,再且只用 `tmux -S "$qa_socket" kill-server`;确认 socket 不可达、slot lock/manifest/session/CommDB 清理后,删除 sandbox 临时分支。若任何现有 teardown wrapper 会执行裸 tmux mutation,不得直接调用该分支。

QA 回报必须包含:PR SHA、slot、socket 绝对路径、旧/新 supervisor 与 pane tuples、两次退出码、Bridge health、相关日志片段、teardown 证据,并逐字列出上述两个 finding key 的 `covered|residual` 结论。

### 6.5 Code review

Codex code review R1 在实现 head `c766cd99` 上 **APPROVED**。Lead 对 advisory 的处置是:补 Bash 3.2 零参数台架与 TS 真 zombie fixture;上述两条运行时 MEDIUM 由独立 QA 专门打并标 `covered|residual`;3 条 LOW 记录不扩 scope。follow-up head `8cebd2ef` 再经 R2 **APPROVED**;新增 LOW(测试只在 macOS 真覆盖 Bash 3.2)已转报 Lead。`CLAUDE.md` 的旧 adoption/N0-N5 架构描述已标为被 FLY-1634 取代。
