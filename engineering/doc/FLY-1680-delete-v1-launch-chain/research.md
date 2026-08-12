# FLY-1680 删除旧 Lead 启动链(v1 载体)— 调研

Issue: FLY-1680 (https://linear.app/geoforge3d/issue/FLY-1680/删除旧-lead-启动链v1-载体代码-1663-设计48h-后净删除条款的执行单)
日期: 2026-08-11
基于: exploration.md

调研方法:以「launchd plist → wrapper-v2 → lead-body.sh → claude-lead.sh(V2=1)」的**活调用图**为正本,对 v1 家族做反向引用 grep(`flywheel-lead-wrapper.sh`、`FLYWHEEL_LEAD_BODY_V2` 分支、supervisor/guard/lease/adoption 函数名),逐文件给出 verdict。行号基于 main `d6536134`。

> **更正(2026-08-11,Codex design review R1 核实后)**:初版矩阵四处判错,已在下文就地修正并以〔R1 更正〕标注——① `_emit_launch_plan` 是 v2 dry-run 共享 seam,不是 v1-only;② restart-services 的非-v2 重启分支是 **Codex bespoke Lead 的活重启路径**(`lead_restart_validate_authority` 给 codex wrapper 判 carrier=v1),切分必须按 backend 不按 carrier 标签;③ `LeadWindowLocator` 的 Claude-v1 臂**可以**整删——codex TUI 的共享 session 所有权在独立模块 `lead-backends/codex/tui-window.ts`,不消费 locator v1 臂;④ `lead-body-sweep.sh` 从 KEEP 改 TRIM(Claude census/hard-clear 随 v1 死,Codex 重启依赖保留,start-identity 委托改绑)。定版矩阵见 plan.md §2a。

## 1. v2 活链(不许碰的骨架)

```
launchd plist (16 生产 label)
 ├─ 14× Claude: ~/.flywheel/bin/flywheel-lead-wrapper-v2.sh <manifest>
 │    └─ env -i tmux -D -S <私有 socket>(前台 server)
 │         └─ new-session "wrapper-v2 --publish-and-start …"
 │              └─ lead-body.sh <manifest>          (一次性 body)
 │                   └─ FLYWHEEL_LEAD_BODY_V2=1 source claude-lead.sh
 │                        ├─ 共享装配层(rules bundle / MCP / bootstrap / dialog-poller-v2)
 │                        ├─ v2 one-shot 块(≈4368-4438)→ _launch_claude → 收据 → kill-server → exit
 │                        └─ (其后代码永不到达)
 └─ 2× Codex: flywheel-codex-lead-wrapper-*.sh → run-codex-lead-*.sh(bespoke,不在 v1/v2 体系)
```

v2 家族(全部**保留**):`scripts/flywheel-lead-wrapper-v2.sh`、`packages/teamlead/scripts/lead-body.sh`、`lib/lead-body-receipt.sh`、`scripts/lib/lead-address.sh` + `packages/teamlead/src/lead-address.ts`、`src/bridge/fleet-lead-locator.ts`、claude-lead.sh 的 `_poll_dev_channels_dialog_v2` / `_v2_*` 家族(FLY-1679)、`flywheel-daemon.sh` 的 v2 安装/渲染、restart-services.sh 的 v2 native-kickstart 分支(1384-1398 一带)。

## 2. 逐文件 verdict 矩阵

图例:**DELETE**=整文件删;**TRIM**=删文件内 v1-only 区段/分支臂;**KEEP**=不动(含理由);**TEST**=测试文件处置。

### 2.1 shell 启动链主体

| 文件 | verdict | 依据(实测引用) |
|---|---|---|
| `scripts/flywheel-lead-wrapper.sh`(238 行) | **DELETE** | 生产 plist 零引用;唯一「活」角色是 FLY-224 codex 派发(见 codex-lead.sh 行) |
| `packages/teamlead/scripts/claude-lead.sh`(4860 行) | **TRIM(主体)** | v1-only:supervisor 主循环(`log "Supervisor starting…"` ≈4498 起至文件尾,含 GEO-285 crash backoff、PID file/TMUX_ARCHIVE、resume 三振 v1 版);FLY-1659/1309/1285 launch 族 `_prepare_lead_launch`/`_lead_restore_orphan_session`/`_lead_clear_orphan_body`/`_lead_identity_conflict_excluding`/`_lead_try_adopt_body`/`_lead_bound_body_ready`/pending+fence 全家(`_lead_pending_*`/`_lead_fence_*`)/`_lead_exact_process_state`/`_lead_process_tuple_state`/`_lead_reserved_*`/`_lead_cleanup_exact_tuple`/`_lead_cleanup_failed_create`/`_lead_reconcile_pending_launch`/`_lead_prelaunch_isolation_gate`/**`_lead_create_tmux_window`(create-kill 建窗验收链本体,≈2475-2666)**〔R1 更正:`_emit_launch_plan` 从本清单移除——3080-3082 行在 V2 分支之前被 `_launch_claude` 调用,是 v2 dry-run characterization 共享 seam,保留〕;`ensure_tmux_session`;FLY-1285 generation guard 族 `_tmux_socket_path`/`_tmux`/`_tmux_generation_*`/`_lead_tmux_generation_state`/`_tmux_target_matches_archive*`/hold-report 族;v1 版 `_poll_dev_channels_dialog`(≈1498-1549;`_dev_channels_flag_active`/`_dev_channels_dialog_present` 为 v2 共用,保留);`_wait_tmux_window`/`_tmux_window_absence_proven`;`_launch_claude` 内 tmux new-window 臂(v2 直起子进程臂保留);`cleanup()` 内 v1 臂;≈4095-4123 的 `lead_launch_authority_prepare` HOLD 循环(整段 gated `!= v2`);v1 manifest 写块(549 行 elif 分支,v2 跳过);supervisor 循环内 lease prepare/adopt 调用位 |
| `packages/teamlead/scripts/lib/tmux-supervisor-guard.sh` | **DELETE** | 消费者=claude-lead.sh(v1 位)+ restart-services.sh:1215(v1 restart 分支配套)+ package-onboard 清单;v2 在 4095 行已用裸 `ps lstart` 取代 |
| `packages/teamlead/scripts/lib/lead-launch-authority.sh` | **DELETE** | 唯一消费=claude-lead.sh v1 位(4105 gated `!= v2`、supervisor 循环 refresh)+ package-onboard |
| `packages/teamlead/scripts/lib/resume-recovery.sh` | **DELETE** | `resume_recovery_decide` 唯一调用位 4818 在 v1 supervisor 循环内;v2 的 resume 断路器已由 lead-body 收据机制承担(§11.3「唯一保留 shim」) |
| `packages/teamlead/scripts/lib/lead-identity-preflight.sh` | **DELETE**〔R1 更正〕 | 仅剩 Claude v1 部分的消费;Claude 剜净后消费者归零,整删而非留悬案 |
| `scripts/lib/lead-body-sweep.sh` | **TRIM**〔R1 更正〕 | 保留主因=Codex 重启路径 hard-clear/census 依赖(非仅 debug);Claude 共享 session census + Claude hard-clear 族随 v1 删;`lead_body_process_start_identity` 对 `tmux_supervisor_process_start_identity`(guard 文件)的委托改绑到保留 lifecycle 原语并直测 |
| `scripts/lib/restart-candidate.sh` | **DELETE**〔R1 更正:初版漏项〕 | FLY-1663 §11.1 原列;restart-services 虽 source 但两函数零生产调用,仅孤立测试引用 |
| `scripts/lib/lead-restart-lifecycle.sh` | **TRIM** | `flywheel-lead-wrapper.sh` case 臂(≈527-536)、`project_carrier = v1` 校验臂、legacy-nohup manifest 兼容注释段;v2/codex 臂保留 |
| `packages/teamlead/scripts/expect-dev-channels.exp` | **DELETE** | 零执行引用(唯一引用=package-onboard 清单 + claude-lead.sh 一条历史注释);FLY-109 旧链孤儿 |
| `packages/teamlead/scripts/codex-lead.sh` | **KEEP** | v1 wrapper 死后 launchd 无到达路径,但仍被 `qa-fly259-mufasa-tui-slot.sh` 引用,且是 FLY-224 vendor-pluggable 通用入口(fleet backend 切换的休眠能力);加头注声明现状 |

### 2.2 载体选择/安装面(死分支清理)

| 文件 | verdict | 位置 |
|---|---|---|
| `scripts/flywheel-daemon.sh` | **TRIM** | v1 wrapper 安装(≈198-199)、`lead_wrapper_path` v1 臂(238)、`classify_plist_lead_carrier` v1 臂(246 起)、`generate_plist_to` `carrier="${5:-v1}"` 默认 + v1 case(318-325)、**`resolve_manifest_carrier` 的 `// "v1"` 缺省(474)→ 翻转为 v2 + `carrier:"v1"` fail-loud** |
| `scripts/provision-fleet-host.sh` | **TRIM** | 463 行 `v1) wrapper=flywheel-lead-wrapper.sh` 臂 |
| `scripts/packaged/bootstrap-services.sh` | **TRIM** | 94 行安装清单 + 130 行 v1 臂 |
| `scripts/flywheel-fleet.sh` | **TRIM** | `WRAPPER_DST`=v1 wrapper 的安装/校验/备份/回滚位(60/900-1026/1609)收敛到 v2-only |
| `scripts/flywheel-cmux-sync.sh` | **TRIM** | `classify_lead_carrier` 的 `flywheel-lead-wrapper.sh)` 臂(611-616)→ 归 config-drift/unknown;`build_lead_attach_command` 等 v2 行保留 |
| `scripts/package-onboard.sh` | **TRIM** | 打包清单行:flywheel-lead-wrapper.sh(92)、expect-dev-channels.exp(73)、lead-launch-authority.sh(75)、resume-recovery.sh(79)、tmux-supervisor-guard.sh(78) |
| `scripts/restart-services.sh` | **TRIM(backend-closed)**〔R1 更正〕 | 非-v2 换代编舞分支(≈1265-1510)**同时是 2 个 Codex bespoke Lead 的活重启路径**(codex wrapper 被判 carrier=v1):只删 Claude-v1 臂,Codex 的 bootout/quiescence/hard-clear/bootstrap 逐字节保留,Claude-v2 native-kickstart 臂保留;+ 1215 supervisor-guard source 行随改绑摘除 |
| `scripts/flywheel-fleet-batch.sh` | **TRIM**〔R1 更正:初版漏项〕 | carrier request/write/restore 逻辑的 v1 位;历史事务 journal 含 v1 desired/preimage/wrapper 备份时 restore 必须 fail-before-mutation(见 plan §2a-T) |
| `packages/teamlead/src/ProjectConfig.ts` | **TRIM**〔R1 更正:初版漏项〕 | `LeadCarrier = "v1" | "v2"` 类型与 validator 收敛 |
| `scripts/packaged/create-compat-mirror.sh`、`scripts/converge-flywheel-bin.sh`、`scripts/flywheel-cmux-autostart.sh`、`scripts/flywheel-bridge-wrapper.sh` | **TRIM(注释/清单级)** | 仅注释或文件清单提及 v1 wrapper,随删对齐 |

### 2.3 TypeScript 观测/证据面

| 文件 | verdict | 说明 |
|---|---|---|
| `packages/teamlead/src/bridge/fleet-data.ts` | **TRIM** | `wrapperPathFor`(v1)+ `classifyLeadPlistCarrier` v1 臂(≈219-235)→ v1 归 unknown(=config-drift 证据),v2 臂保留 |
| `packages/teamlead/src/LeadWindowLocator.ts` / `src/bridge/tmux-lookup.ts` | **TRIM(整删 v1 臂)**〔R1 更正〕 | 初版判断反了:codex TUI Lead 的共享 session 所有权在独立模块 `lead-backends/codex/tui-window.ts`(保护+直测),不消费 locator 的 Claude-v1 `LeadWindowRef` 臂;fleet-lead-locator 对 bespoke codex plist 分类 unknown→null。故 Claude-v1 臂与 fleet locator/capture/Enter 的对象回退整删;`tmux-lookup.ts` 中 Runner/非-Lead 仍用的字符串 helper 保留 |
| `packages/teamlead/src/account-heal/quota-revive-scan.ts` / `quota-monitor-runtime.ts` | **TRIM(谨慎)** | per-socket v2 扫描保留;v1 共享 session 扫描臂删除前先确认 quota 对象仅 Claude Lead(codex 额度自愈走 account-heal 别路) |
| `packages/teamlead/src/LeadWatchdog.ts` | **TRIM(小)** | FLY-1663 已适配 v2;残留 v1 分支按 grep 收敛 |
| `packages/flywheel-comm/src/lead-lease.ts` + lead-lease.db | **KEEP(本单)** | §11.2 消费矩阵横跨 comm 写校验/Bridge/founder-consent/flags;v1 写入者随本单消失,读侧已容忍无 lease(当前生产即此状态)→ 退役另立 follow-up |

### 2.4 测试面(TEST)

随机器走的测试(删):`scripts/__tests__/` 中 FLY-1285/1309/1659 launch-storm/adoption/pending-fence 族、FLY-1602 收养残留、FLY-1634 hard-clear 中「v1 换代清场」用例、test-restart-services.sh 的 v1 plist fixtures(1952/2581/2635/2691-2695 一带)与 v1 恢复用例、test-cmux-sync.sh `lead_plist_wrapper_basename`=v1 fixture(6977)、`packages/flywheel-comm` 的 lead-lease-enforce 测试**只删生产 launch 侧符号消失的用例**——lease TS 族本单保留,v2 no-legacy-lease 与其余仍活 enforcement 行为的测试全保(R2#4 收窄)。
需改写(v1 断言→v2 或删臂):fly1663 四件套里的 v1 对照断言、flywheel-daemon-install-verify / plist-env / fleet / fleet-batch 中 carrier=v1 用例、provision-prebuilt/packaged-seams 清单断言。
**新增守卫**:仓库级 grep-zero 断言(`flywheel-lead-wrapper.sh` 与已删函数名全库零命中,白名单=git 历史/`engineering/doc/**`/CLAUDE.md 里程碑),形态参照 FLY-1631 的 repo residue guard。

## 3. 数量级

claude-lead.sh 预计剜除 ≈1600-1900 行(launch 族 ~900 + supervisor 循环 ~420 + generation guard ~180 + v1 poller/window-wait/authority ~200+);连同**七个**整删文件(〔R1/R2 更正〕含 lead-identity-preflight.sh 与 restart-candidate.sh)、各安装面死臂与随行测试,全 PR 预计**净删 3500-5000 行**。方向与 FLY-1634(净删 2643)/FLY-1631(v2 退役)同族。

## 4. 风险点(供 plan 化解)

1. **`resolve_manifest_carrier // "v1"` 默认翻转**:不翻转则删除后 daemon 对无 carrier 项目生成指向不存在 wrapper 的 plist(boot loop);翻转+fail-loud 是本单唯一「加」。
2. **共享 session 寻址误删**:codex TUI Lead 依赖共享 cmux session 寻址;TS TRIM 必须按 caller 逐位判,不能按「v1=共享 session」一刀切。
3. **QA fixtures 大面积红**:v1 fixture 遍布 restart/cmux/daemon 测试;逐文件列删改清单,避免「测试改绿但断言空转」(vacuous green 教训)。
4. **多形态引用漏网**:FLY-1205 sub#17 教训——`./` 形、`../` 形、basename 形、字符串拼接形都要 sweep;grep-zero 守卫按 basename + 函数名双轨。
5. **盘上安装副本**:`~/.flywheel/bin/flywheel-lead-wrapper.sh` 删源后仍在盘;ship 窗清扫(D4),converge-flywheel-bin 是否 prune 需实测,不假设。

## 5. 2026-08-11 实施前审计补记

### 5.1 硬前置与基线

- 14 个 Claude Lead 中最后一项 `flywheel-flywheel-eng-lead` 的 v2 切换时间为 `2026-08-10T11:57:24-07:00`;因此最早代码变更时间是 **2026-08-12 11:57:24 PT**。在此之前只做只读审计与基线,不写实现代码。
- FLY-1679(PR #801)、FLY-1573(PR #798)、FLY-1574(PR #797)均已在当前基线中;`HEAD...origin/main = 11/0`(2026-08-11 01:06 PT),无缺失上游提交。
- 基线:`pnpm lint` 通过(仅既有 warning);`pnpm -r build` 在 `pnpm install --frozen-lockfile` 后通过;FLY-1663 foundation/runtime、FLY-1679 v2 dialog、daemon install/plist、hard-clear、controlled-wave shell 槽全绿。
- 全 package 基线的非本单失败已单独记录:resident 环境的 Terminal/`osascript` 不可用、TeamLead 大并发下 5s timeout、用户 npm cache 权限;carrier 相关单测与 FLY-247 carrier/fleet bash bundle 均绿。

### 5.2 整文件删除清单(定稿)

生产文件 7 个:

1. `scripts/flywheel-lead-wrapper.sh`
2. `packages/teamlead/scripts/lib/tmux-supervisor-guard.sh`
3. `packages/teamlead/scripts/lib/lead-launch-authority.sh`
4. `packages/teamlead/scripts/lib/resume-recovery.sh`
5. `packages/teamlead/scripts/lib/lead-identity-preflight.sh`
6. `packages/teamlead/scripts/expect-dev-channels.exp`
7. `scripts/lib/restart-candidate.sh`

专属测试/fixture 14 个:

1. `packages/teamlead/scripts/__tests__/claude-lead-manifest-preserve.test.sh`
2. `packages/teamlead/scripts/__tests__/manifest-roundtrip.test.sh`
3. `packages/teamlead/scripts/__tests__/lead-backend-dispatch.test.sh`
4. `packages/teamlead/scripts/__tests__/tmux-integration.test.sh`
5. `packages/teamlead/scripts/__tests__/claude-lead-resume-recovery.test.sh`
6. `packages/teamlead/scripts/__tests__/expect-script.test.sh`
7. `packages/teamlead/scripts/__tests__/fly1285-tmux-supervisor.test.sh`
8. `packages/teamlead/scripts/__tests__/fly231-restart-candidate.test.sh`
9. `packages/teamlead/scripts/__tests__/lead-launch-authority.test.sh`
10. `packages/teamlead/scripts/__tests__/test-lead-identity-preflight.sh`
11. `scripts/__tests__/supervisor-adoption.test.sh`
12. `scripts/__tests__/supervisor-storm-regression.test.sh`
13. `scripts/__tests__/flywheel-lead-wrapper.test.sh`
14. `scripts/__tests__/fixtures/fly1659/pre-fix-prepare-lead-launch.sh`

上述整删合计 **4,106 行**,尚未计入 `claude-lead.sh` 主体剜除与各载体分支 trim。`lead-backend-dispatch.test.sh` 可整删是因为它只验证已退役 wrapper 的 backend dispatch;保留的 dormant Codex direct entry 由 `codex-lead-args.test.sh`、`codex-lead-runtime.test.ts` 等独立槽保护。两个 manifest rewrite 测试只保护 v1 body 的 canonical manifest 自写;v2 wrapper 的原子 manifest/unknown-field 保留已有 `fly1663-lead-v2-runtime.test.sh` 覆盖。

### 5.3 必须 trim 而不能整删的共享面

- `packages/teamlead/scripts/lead-rules-bundle.sh`:v2 rules bundle stale-generation 清理仍调用 `tmux_supervisor_process_start_identity`;删除 guard 时在该单一调用点直接使用 `ps -p ... -o lstart=`(不新增 helper)。同步改 `fly1402-single-bundle.test.sh` 的 fixture。
- `scripts/lib/lead-body-sweep.sh`:仅保留 Codex shared-tmux descendant census/hard-clear;删除 Claude project/receipt/tuple/session/archive 全族;start identity 改绑已保留的 lifecycle 原语。`lead-body-hard-clear.test.sh` 只保留 Codex、tuple、sensor fail-close 用例。
- `scripts/lib/lead-restart-lifecycle.sh` 与 `scripts/restart-services.sh`:Claude 只允许 v2 wrapper + native kickstart;Codex 两个 bespoke wrapper 的 bootout/quiescence/hard-clear/bootstrap 字节行为保留。删除 Claude-v1 supervisor process inventory与 legacy-process candidate authority。
- `scripts/lib/tmux-server-rescue.sh`:**整文件保留**。其 QA/residue audit、real-tmux scaffold-prune 与独立 server-rescue 测试仍活;只移除 v1 `claude-lead.sh` 消费边。
- `packages/teamlead/scripts/claude-lead.sh`:保留装配、dry-run、v2 poller、one-shot body与 direct-child `env -i`;删 v1 manifest writer、shared-session/create-kill/lease/adoption/supervisor loop。非 dry-run 实跑对 `FLYWHEEL_LEAD_BODY_V2=1` fail-closed,不再存在 v1 fallback。
- `packages/teamlead/scripts/codex-lead.sh` 与 `packages/teamlead/src/lead-backends/codex/tui-window.ts`:保留;前者改头注澄清 direct/QA dormant 能力,后者是 bespoke Codex shared-tmux 的独立所有者。

### 5.4 安装、观测、测试与 CI 对齐清单

- 安装/选择:`flywheel-daemon.sh`、`flywheel-fleet.sh`、`flywheel-fleet-batch.sh`、`provision-fleet-host.sh`、`packaged/bootstrap-services.sh`、`converge-flywheel-bin.sh`、`package-onboard.sh`、`package-onboard-files.allow`。
- 观测/寻址:`ProjectConfig.ts`、`LeadWindowLocator.ts`、`fleet-data.ts`、`fleet-lead-locator.ts`、`tmux-lookup.ts`、`lead-alert-helpers.ts`、quota v1 shared-session scan、`flywheel-cmux-sync.sh`。
- 混合 shell 测试只删 v1 臂:`fly1663-launchd-foundation`、`fly1663-lead-v2-runtime`、`fly1679-dev-channels-v2`、daemon/fleet/fleet-batch、provision/package/converge、`fly1446-cmux-roster`、`restart-storm-wrapper-wiring`、`qa-fly1501-brake-missing-alert`、`wrapper-host-config-revcompat`、`host-path-allowlist`、`test-cmux-sync.sh`、`test-restart-services.sh`。
- CI 删除上述专属 suite 的显式调用,并从 `fly247-bash-suites.test.ts` 摘除 v1 manifest rewrite case。新增 `scripts/__tests__/fly1680-v1-extinction.test.sh`,显式注册到 `.github/workflows/ci.yml` 与 `scripts/__tests__/ci-structure.test.sh`。
- extinction guard 匹配 retired **入口 basename + API/function family**,不匹配保留的 `claude-lead.sh` 文件名;白名单仅 docs/里程碑与 guard 自身。旧 v1 plist/transaction fixture仍要作为 positive control 留在 guard 内或临时目录中,不可让 production tree 保留可执行选择分支。
