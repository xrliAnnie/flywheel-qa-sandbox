# FLY-1807 急停开关批删除固化 — 实施计划

Issue: FLY-1807 (https://linear.app/geoforge3d/issue/FLY-1807/flag执行e2-急停开关-49-条删-flag-固化成开单独批不混功能类)
日期: 2026-08-16
基于: 无(上游为 FLY-1782 分支产物 `product/doc/FLY-1782-flag-recheck/{exec-ready.md §2, resolver-state.md, tally.md, pile1-judgment.md}`,PR #853)

---

## 0. 一句话

把 FLY-1782 体检裁决为「删 + 固化成开」的急停开关批(§2 名单 49 条)按三条硬门逐条删除:每条先证明「真缺省 = 生效值 = 开」,然后拆掉开关、保留被守护的行为为无条件路径,registry 行删除 + `RETIRED_FLAGS` 墓碑防复活;**本批单独走,一条不混进功能类(E1)**。

## 1. 范围核算:49 → wave-1 最多 42(设计期审计结论)

§2 名单共 49 条。设计期逐条对账后,**7 条不能进 wave-1**:

### 1.1 六条 E6 前置(维持体检既有结论,非本设计新裁)

FLY-1811(E6)明文是 E1/E2 的前置:「这 19 条判完之前,它们不进任何批量」。§2 的 49 条里落在待查 19 条名单(`resolver-state.md §4`)里的有 **6 条**:

`mailbox_queue` · `converge_cmux_symlink` · `auto_qa_killswitch` · `workflow_rework_reentry` · `external_merge_reconcile` · `instruction_path_check`

处置:**wave-1 不碰**。E6 逐条判完后,判「registry 与解析器一致」的按本计划同款配方作为 **E2 wave-2** 小 PR 执行(仍单独批、不混 E1);判「不一致」的以解析器为准退出批量、按 E3 逐条走。

### 1.2 一条设计期新发现退出:`done_thread_reconcile`

**证据**(`scripts/test-deploy.sh:912-917`,FLY-1165):QA 框架给**每个 slot Bridge** 显式注入 `FLYWHEEL_DONE_THREAD_RECONCILE=0` —— 因为该 sweep 会打**真 Linear API**,不关的话 QA 房会拿生产 Linear 状态去归档 slot 的隔离 thread。

⇒ 它的 OFF 值不是「没人用的急停」,而是 **QA 隔离机制的现役依赖**。删掉 = QA 房失去这道隔离 ⇒ **不满足本批「零行为变化」定义**。

处置:**退出本批**,报 Lead 裁决归属。建议:先给 QA slot 一个非 flag 的隔离通路(如 slot Bridge 以配置显式禁用该 sweep),之后再按 E3 逐条删;在那之前 registry 行保留原样。**本单对它零改动。**

### 1.3 基建级 OFF 消费者全清单(设计期 + Codex R1 复核后的完整账)

OFF 值的现役消费者共**三处**,处置各不同:

| 消费者 | 涉及 flag | 处置 |
|---|---|---|
| QA slot 隔离(`test-deploy.sh:912-917`,防打真 Linear) | `done_thread_reconcile` | **硬退出**(§1.2) |
| FLY-1707 incident replay(`scripts/qa-fly-1707-incident-dispatcher.ts:319-320`,**TS 对象语法 `: "0"`**;CI `ci.yml:152-153` 现役执行)——为确定性重放关掉两个 sweep | `engine_dead_exec_sweep` · `engine_unlaunched_tripwire` | **条件放行**,见 §3 台账 #17/#18 的三选一 |
| legacy 场景测试(`test-cmux-sync-hooks-integration.sh:519-524` 的 `FLYWHEEL_CMUX_VIEW_INVARIANT=0` FLY-293 场景;CI `ci.yml:207` 现役)+ `test-cmux-sync.sh:982-986` 全局 fixture 的 legacy 值 | `cmux_view_invariant` 等 cmux 族 | 属**可删测试面**,PR-B 一并收敛(§5/§6),不构成退出 |

⚠️ **扫描方法教训(本设计自己犯了一次、被 review 抓回)**:OFF 注入有多形态——shell `X=0`、TS 对象 `X: "0"`、赋值 `= "0"`。初版审计只扫了 `=0` 一种形态,漏掉 FLY-1707 replay;实现节点的核查(§2.3、§4 步 3)**必须多形态扫**,单形态结论一律不算数。

### 1.4 wave-1 最多 42 条(动态核算)

| 批 | 数 | 内容 |
|---|---|---|
| **PR-A(TS 侧)** | **N_A = 36 − E_A** | 读点全在 TypeScript packages;`E_A ∈ {0, 2}` = #17/#18 绑定条件退出数(§3 台账) |
| **PR-B(shell 侧)** | **N_B = 6** | 读点含 bash 脚本:`tmux_keepalive` · `cmux_wal_quarantine` · `cmux_roster` · `cmux_view_invariant` · `cmux_strict_view` · `cmux_close_request_killswitch` |
| E6 前置 | 6 | §1.1,wave-2 待放行 |
| 设计期退出 | 1 + E_A | §1.2 `done_thread_reconcile` + #17/#18 若走 (c) |
| **恒等式** | **N_A + N_B + E_A + 6 + 1 = 49** | 与 exec-ready §2 对账;执行中任何 §7 退出都同步更新此账 |

固化值:**放行条目全部为「开」**(exec-ready §2 逐条已标)。下文以「42 / 36」指 `E_A=0` 的基准情形;台账、PR 描述、墓碑断言、residue 扫描名单一律**按实际放行集生成**,不按基准数硬编码。

## 2. 三条硬门的落地形态(与 E1 同款,逐条适用)

1. **固化方向以「解析器的真缺省」为准,`registry.default` 不是权威。** 落地:每条 flag 执行时**全仓 word-boundary grep 该 envVar**,枚举出**全部真实读点**(registry `readSites` 只当索引用),逐读点核对 idiom 是 default-ON(TS:`!== "0"`;shell:`${VAR:-1}` / `load_cmux_bool_flag X 1`)。台账逐条记「注册表说 ON / 实际读点逐个核 ON / 采信读点」。
   - **为什么必须全仓 grep 而不是信 registry**——设计期已抓到两例登记不全:`founder_auto_approve` 有第三个未登记读点(`voice-routes.ts:339`);`cmux_close_request_killswitch` 有两个未登记 shell 读点(`flywheel-cmux-sync.sh:2039,2144`)。
2. **每删一条,PR 必须写明「固化成哪个值 + 为什么」,写不出来不许删。** 落地:PR 描述带逐条台账(§4 格式),实际放行集(§1.4)一行不缺。
3. **现值 ≠ 想要的值 ⇒ 先改值再删,顺序不许反。** 落地:设计期核查生产生效值(`~/.flywheel/.env` + launchd plist `com.flywheel.*` + `~/.flywheel/bin` wrapper),**Codex R1 复核修正后的快照**:
   - wave-1 42 条里**恰有一条被显式设值**:`.env:137` `FLYWHEEL_CMUX_VIEW_INVARIANT=1` —— **与目标同值**,不需要翻值;但删 flag 加墓碑后这一行会被 `validateFlagTruthEnvironment`(truth.ts)判「已退役假开关」,所以 **PR-B ship 窗必须带一步运维清理**:先删这行(旧代码 unset 仍 ON,零风险)→ 核实生效值仍为 ON → 再算 ship 完成。完成证据 = 该 var 从 .env/plist/wrapper 消失 + truth check 不再报它(FLY-1456 先例同款)。
   - `.env:167` `FLYWHEEL_MAILBOX_QUEUE=1` —— 属 E6 前置那 6 条,不在 wave-1;记入 wave-2 交接,同款清理逻辑。
   - 其余 41 条零设值 ⇒ 生效值 = 代码缺省 = 开 = 固化值,「先改值」为空操作,直接删。
   - 台账逐条区分三种情形:**未设值** / **设为目标值**(如上,删行即可)/ **设为相反值或有隔离语义**(→ 翻值先行或退出,参照 §1.2/§1.3)。
   - ⚠️ 设计期初版用逐 var 循环 grep 得出「零设值」,**是错的**(循环有 bug,漏了两行);单条 alternation 正则复扫才抓到。**实现节点开工时必须用 alternation 全名单一次扫**,并对 QA 框架 / CI 脚本按 §1.3 的多形态扫,不许沿用逐条循环。任何新出现的设值 ⇒ 该条按上面三分法处置。

## 3. 逐条台账(基准 42 条;#17/#18 条件项见注记,实际放行集按 §1.4 动态核算)

> 读点列 = registry 登记数;执行时以全仓 grep 为准(硬门 1)。「注记」列只写有专项风险/动作的。

### PR-A(TS 侧,基准 36 条,N_A = 36 − E_A)

| # | flag | envVar | 读点 | 注记 |
|---|---|---|---|---|
| 1 | `liveness_alerts` | `FLYWHEEL_LIVENESS_ALERTS` | 1 | bridge_boot;liveness-manifest |
| 2 | `prune_park_guard` | `FLYWHEEL_PRUNE_PARK_GUARD` | 4 | 4 个 reconciler/prune 读点 |
| 3 | `readopt_parked_roles` | `FLYWHEEL_READOPT_PARKED` | 1 | HeartbeatService |
| 4 | `codex_gate_wait` | `FLYWHEEL_CODEX_GATE_WAIT` | 1 | claude-runner 包 |
| 5 | `lead_dual_active_scan` | `FLYWHEEL_DUAL_ACTIVE_SCAN` | 2 | plugin object_construction + fleet-data |
| 6 | `quota_degraded_switch` | `FLYWHEEL_QUOTA_DEGRADED_SWITCH` | 1 | quota-monitor |
| 7 | `quota_daemon_wake` | `FLYWHEEL_QUOTA_WAKE` | 1 | direct-toggle proof 测试一并删 |
| 8 | `review_severity_policy_killswitch` | `FLYWHEEL_REVIEW_SEVERITY_POLICY` | 1 | |
| 9 | `progress_resume_killswitch` | `FLYWHEEL_PROGRESS_RESUME` | 2 | 跨 teamlead + edge-worker |
| 10 | `founder_review_gate_exclude` | `FLYWHEEL_FOUNDER_REVIEW_GATE_EXCLUDE` | 1 | |
| 11 | `founder_auto_approve` | `FLYWHEEL_FOUNDER_AUTO_APPROVE` | 2+1 | **第三读点 `voice-routes.ts:339` 未登记**;严禁误伤 `FLYWHEEL_FOUNDER_AUTO_APPROVE_DENYLIST`(独立 var,保留) |
| 12 | `stale_ship_rewake` | `FLYWHEEL_STALE_SHIP_REWAKE` | 1 | |
| 13 | `auto_linear_done` | `FLYWHEEL_AUTO_LINEAR_DONE` | 1 | linear-issue-finalizer |
| 14 | `founder_reply_unreachable` | `FLYWHEEL_FOUNDER_REPLY_UNREACHABLE` | 1 | |
| 15 | `ask_hygiene` | `FLYWHEEL_ASK_HYGIENE` | 4 | 跨 flywheel-comm(db.ts)+ teamlead(3 处含 StateStore) |
| 16 | `founder_milestone_notify` | `FLYWHEEL_FOUNDER_MILESTONE_NOTIFY` | 1 | |
| 17 | `engine_dead_exec_sweep` | `FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP` | 1 | **条件放行**(§1.3 FLY-1707 replay 依赖 OFF):三选一,优先序 (a) 证明固化 ON 后 replay fixture 对两 sweep 是 no-op、原断言不动 → 放行;(b) 注入 seam,**硬约束:生产 `reconcile()` 必须无条件调用两条 sweep 路径**——seam 只许注入底层 probe/effect/fixture 数据让 replay 里的 sweep 自然 no-op,**不许**是 enabled boolean / skip callback / 任何能绕过调用点的参数(那等于把 kill switch 换名藏回来)→ 放行;(c) (a) 失败且 (b) 无法以该形态闭合 → 两条一起退出转 E3(触发 §1.4 动态计数 `E_A=2`)。两条 flag 同命运,选项与结论写进 PR 台账 |
| 18 | `engine_unlaunched_tripwire` | `FLYWHEEL_ENGINE_UNLAUNCHED_TRIPWIRE` | 1 | 同 #17,绑定处置 |
| 19 | `remote_reports` | `FLYWHEEL_REMOTE_REPORTS` | 2 | plugin + flywheel-comm CLI(publish-report / feature-flags 命令的 `skipped` 分支删除) |
| 20 | `fleet_console` | `FLYWHEEL_FLEET_CONSOLE` | 1 | **精确变换,旧 dashboard 不是死代码**:真 guard 是 `FLYWHEEL_FLEET_CONSOLE !== "0" && !process.env.FLYWHEEL_PROJECTS`(plugin.ts ~4558),只删第一个 conjunct,改成 `if (!process.env.FLYWHEEL_PROJECTS)`;**保留** FLYWHEEL_PROJECTS split-brain guard、optional `fleetConsole`、旧 dashboard(`getDashboardHtml`)、`/api/fleet/*` 条件挂载、console 初始化失败 try/catch 回退(plugin.ts ~4826)及其测试。退役 fallback = 行为变更,另立单 |
| 21 | `commdb_residue_harvest` | `FLYWHEEL_COMMDB_RESIDUE_HARVEST` | 1 | bridge_boot |
| 22 | `terminal_commdb_sync` | `FLYWHEEL_TERMINAL_COMMDB_SYNC` | 1 | bridge_boot |
| 23 | `cron_stale_guard` | `FLYWHEEL_CRON_STALE_GUARD` | 1 | |
| 24 | `ship_gate_rebind` | `FLYWHEEL_SHIP_GATE_REBIND` | 1 | |
| 25 | `ship_gate_retire` | `FLYWHEEL_SHIP_GATE_RETIRE` | 2 | |
| 26 | `ship_gate_card` | `FLYWHEEL_SHIP_GATE_CARD` | 1 | 严禁误伤 `FLYWHEEL_SHIP_GATE_CARD_GRACE_MS`(E1 范围) |
| 27 | `tier2_prefix_norm` | `FLYWHEEL_TIER2_PREFIX_NORM` | 1 | |
| 28 | `viewer_session_reaper` | `FLYWHEEL_VIEWER_SESSION_REAPER` | 1 | bridge_boot |
| 29 | `chrome_session_reaper` | `FLYWHEEL_CHROME_REAPER` | 1 | bridge_boot |
| 30 | `fleet_sensor_tmux_killswitch` | `FLYWHEEL_FLEET_SENSOR_TMUX` | 1 | object_construction(HeartbeatService 接线层) |
| 31 | `land_node` | `FLYWHEEL_LAND_NODE` | 1 | 固化开 = terminal land 恒在,与 FLY-1655 不变量一致 |
| 32 | `workflow_vendor_at_dispatch` | `FLYWHEEL_VENDOR_AT_DISPATCH` | 1 | |
| 33 | `commdb_protection` | `FLYWHEEL_COMMDB_PROTECTION` | 1 | flywheel-comm db.ts |
| 34 | `continuity_preflight` | `FLYWHEEL_CONTINUITY_PREFLIGHT` | 1 | run-dispatcher |
| 35 | `push_guard` | `FLYWHEEL_PUSH_GUARD` | 1 | WorktreeManager;固化开 = per-worktree pre-push guard 恒装(FLY-1718) |
| 36 | `doa_backoff` | `FLYWHEEL_DOA_BACKOFF` | 2 | run-dispatcher + plugin maintenance |

### PR-B(shell 侧,6 条)

| # | flag | envVar | 读点 | 注记 |
|---|---|---|---|---|
| 37 | `tmux_keepalive` | `FLYWHEEL_TMUX_KEEPALIVE` | 1 | `tmux-server-rescue.sh:520` `${VAR:-1}` |
| 38 | `cmux_wal_quarantine` | `FLYWHEEL_CMUX_WAL_QUARANTINE` | 2 | OFF 分支 = legacy global-abort 行为,删 |
| 39 | `cmux_roster` | `FLYWHEEL_CMUX_ROSTER` | 2 | |
| 40 | `cmux_view_invariant` | `FLYWHEEL_CMUX_VIEW_INVARIANT` | 2 | 生产 `.env:137` 设 `=1`(同值)⇒ ship 窗删行 + truth check 转绿(§2 硬门 3);hooks-integration 的 FLY-293 legacy `=0` 场景删/改写(§1.3) |
| 41 | `cmux_strict_view` | `FLYWHEEL_CMUX_STRICT_VIEW` | 3 | 跨 shell + TS(`tmux-lookup.ts`),原子删;**联动注记见 §9.3** |
| 42 | `cmux_close_request_killswitch` | `FLYWHEEL_CMUX_CLOSE_REQUEST` | 1+2 | **shell 读点 `flywheel-cmux-sync.sh:2039,2144` 未登记**;严禁误伤 `FLYWHEEL_CMUX_CLOSE_REQUEST_FILE`(路径 var,保留) |

## 4. 逐条删除配方(每 flag 六步,原子:一条 flag 只出现在一个 commit 族里)

1. **枚举读点**:全仓 word-boundary grep envVar(`grep -rEnw` 语义,含 `scripts/`、`packages/`、测试、文档)。记录与 registry `readSites` 的差异。
2. **核真缺省**(硬门 1):逐读点确认 default-ON idiom。任何一个读点不是 default-ON(如 `=== "1"` opt-in、或经复合解析函数)⇒ **该条整体退出批量 → E3**,不许只删「顺手的那部分」。
3. **核现值**(硬门 3):重跑 §2 硬门 3 的生产 env 核查(.env / plist / wrapper / QA 框架赋值,alternation 全名单 + 多形态)。结果**逐字按 §2 硬门 3 的三分法**处置:未设值 → 直接删;设为目标值 → ship 窗删行 + truth check 转绿;设为相反值或有隔离语义 → 翻值先行或按 §1.2/§1.3 退出。
4. **删开关、留行为**:每个读点把 guard 拆掉,保留 ON 分支为无条件路径;OFF 分支成为死代码 ⇒ **同 commit 删除**,PR 描述列出删掉的死代码(dead-code hygiene)。
   - TS:`if (process.env.X !== "0")` → 无条件;`xEnabled()` 之类只剩 `return true` 的 helper 内联删除。
   - shell:`[[ "${X:-1}" == "0" ]] && return 0` 整行删;`load_cmux_bool_flag X 1` 派生变量与其分支删。
5. **registry + 墓碑**:删 `FEATURE_FLAGS` 对应行;`truth.ts` `RETIRED_FLAGS` 追加 `{ envVar: "FLYWHEEL_X", retiredBy: "FLY-1807" }`。墓碑给两道免费守卫:drift 测试「retired tombstone 不许再有生产布尔读点」防复活(覆盖面见 §9.4);`validateFlagTruthEnvironment`(truth.ts:433)对 `.env` 里的残留行报「已退役假开关,删这行」。
6. **测试与文档**:OFF-path 测试删除;ON-path 测试去掉 env 前置、断言收紧为无条件行为;`directToggleProof` 测试(#7/17/18/32 等 direct 条目)删除;registry 自身的 per-flag 断言(如 `feature-flags-registry.test.ts` 里 cmux 读点计数)同步更新;注释/文档里的 `X=0 disables` 陈述清除。

**前缀撞名保护名单**(word-boundary 强制,体检自己就栽过 `SHIP_GATE_CARD` vs `SHIP_GATE_CARD_GRACE_MS`):
`FLYWHEEL_FOUNDER_AUTO_APPROVE_DENYLIST` · `FLYWHEEL_SHIP_GATE_CARD_GRACE_MS` · `FLYWHEEL_SHIP_GATE_GRACE_MS` · `FLYWHEEL_CMUX_CLOSE_REQUEST_FILE` · `FLYWHEEL_CMUX_LINKED_VIEW`(FLY-1446 保留)· `FLYWHEEL_DONE_THREAD_RECONCILE*`(全族本单不碰)· `FLYWHEEL_QUOTA_*` 其余成员。

## 5. PR 切分与提交结构

**两个 PR,先 A 后 B,同属本单**,理由与本单从 E1 分批同构:失败代价不对称。PR-B 动的是 7k 行生产 bash(`flywheel-cmux-sync.sh`)+ founder 每天看的 cmux 侧栏,OFF 分支剥离是真 bash 手术;把它和 PR-A 的机械 TS 删除隔开,两边的 review 信号都不被稀释。

- **PR-A**(N_A 条 TS):commit 按子系统族分组(bridge-boot 族 / ship-gate·approval 族 / workflow-engine 族 / comm·commdb 族 / founder-notify 族 / 杂项),每 commit 内逐 flag 原子;registry/truth/测试改动跟随所属 flag 的 commit。
- **PR-B**(6 条 shell):`flywheel-cmux-sync.sh` + `flywheel-cmux-autostart.sh` + `tmux-server-rescue.sh` + `cmux-close-request.ts`/`tmux-lookup.ts`;测试面**全量收敛**:`test-cmux-sync.sh`(含 :982-986 全局 fixture 的 legacy 值改为固化后 topology,不是只删显眼 OFF case)+ `test-cmux-sync-hooks-integration.sh`(FLY-293 `INVARIANT=0` legacy 场景删/改写)+ `scripts/__tests__/test-cmux-autostart-flags.test.sh` + CI 里这三条的 exact command 作为本地门。
- 两 PR 描述均带 §3 台账 + 硬门 1/3 的核验记录;里程碑 + 文档按惯例进各自 PR 最后一个 commit。
- 与 E1(FLY-1806)都会改 `registry.ts`/`truth.ts`:**串行执行,后开工的 rebase**;不并行开两张 registry 大 PR。

## 6. 验证与 QA

**PR-A**:
- `pnpm lint`(全仓)+ `pnpm -r build`。
- 定向 vitest:`packages/config`(registry / drift / truth 全套——drift 双向守卫 + PR-A 自己 `N_A` 条墓碑的防复活断言是本 PR 的结构性验收器;累计 `N_A+N_B` 条只在 PR-B 后验收)+ 触到的 teamlead / edge-worker / flywheel-comm / claude-runner / inbox-mcp 测试文件。全量 package gate 以 CI 为准(host 全量 vitest 压死生产 Bridge 是既有教训,不在 host 跑)。
- grep-zero 自证(**计数按 PR 归属拆,不许拿累计数当 PR-A 的门**):PR-A 只对**自己的 `N_A` 条**做 envVar + flag name 的 word-boundary 残留扫描;命令形态 = 精确 target-list 的 `grep -rEnw`,**显式 allowlist** = `truth.ts` 墓碑行、本单执行台账文档、真正的历史归档(`product/doc/FLY-1782-*` 等)。**活文档不豁免**:仍在指导操作者设 `X=0` 的现役文档必须同步改(已知至少 `doc/reference/remote-report-pipeline.md:48` 的 `FLYWHEEL_REMOTE_REPORTS=0`;逐条扫各自 envVar 在 `doc/reference/` / README / CLI help 文案中的活引用)。多形态 sweep(envVar、flag name、`X=0`、`X: "0"`)——FLY-205 sub#17 + 本单 §1.3 的双重教训。
- 行为零变化的证明形态:**改动前后,保留下来的 ON-path 测试一条不改也全绿**(它们就是行为规格);变更只允许出现在「删 OFF-path / 删 env 前置 / 删 toggle proof / §1.3 列明的测试面收敛」四类。
- FLY-1707 replay 门:`bash scripts/__tests__/qa-fly-1707-incident-replay.test.sh` 在 #17/#18 所选方案下全绿(CI 同款命令)。

**PR-B**:
- `scripts/test-cmux-sync.sh` 全量 + `scripts/test-cmux-sync-hooks-integration.sh`(CI 同款)+ `scripts/__tests__/test-cmux-autostart-flags.test.sh` + `bash -n` 语法门。
- grep-zero 自证:对 PR-B 的 6 条,同 PR-A 规则;**B 合入后跑一次累计 `N_A+N_B` 条的全名单残留扫描**,作为 wave-1 收口证据。
- 真机段:merge 后 ship 窗由独立 QA 验 cmux 侧栏完整(watcher 正常轮转、无 invariant 告警)——纯 pre-merge shell harness 不当作最终验收;ship 窗含 `.env:137` 清理步(§2 硬门 3)。

**独立 QA 节点(DAG)**:两 PR 各自过独立 QA;QA 至少覆盖(a)slot Bridge 正常起 + drift/registry 测试在被测 head 上绿,(b)PR-B 后真 cmux 侧栏一轮 watcher 周期零回归,(c)QA 框架自身冒烟(`test-deploy.sh` 起房)不因删 flag 受损——特别是确认 `done_thread_reconcile` 隔离原样健在。

## 7. 退出规则(任何一条命中即退出批量,不许「就这条特殊处理一下」)

1. 任一读点不是 default-ON idiom,或真值经复合解析函数(→ E3 / E6)。
2. 生产 env(.env / plist / wrapper)或 QA 框架对该 var 有现役赋值,**且按 §2 硬门 3 三分法落在「设为相反值或有隔离语义」一档**(→ 报 Lead,参照 §1.2 先造替代通路;「设为目标值」不触发退出,走 ship 窗删行)。
3. 拆 OFF 分支时发现它不是死代码——被别的机制或调用方依赖(→ E3)。
4. ON-path 既有测试在只删开关的改动下变红(说明「零行为变化」假设破产,→ E3)。

退出不阻塞其余条目;退出名单进 PR 描述与回报。

## 8. 部署与回滚

- 行为零变化 ⇒ 无特殊上线序列(**唯一例外:PR-B ship 窗多一步同值清理,见下**);正常 founder-gated ship + `restart-services` 周期(多数读点是 bridge_boot/boot 接线,重启后新代码生效,值不变)。
- 生产 `.env` 清理:**PR-B ship 窗删 `.env:137` `FLYWHEEL_CMUX_VIEW_INVARIANT=1`**(§2 硬门 3 的序列与完成证据);其余 41 条零设值、无需清理。未来有人误加任何一条,`validateFlagTruthEnvironment` 直接报「已退役假开关,删这行」。
- 回滚 = `git revert` 单 PR(registry 行、墓碑、读点同 PR 原子,revert 后 flag 完整回归)。
- **代价交代**(Annie 已在 FLY-1782 拍板接受):删除后这批(实际放行集)防护的紧急关闭手段从「改一行 .env」变成「改代码 + 部署」。守 ship 路的 break-glass 开关不在本批,退路保留。

## 9. 专项注记

### 9.1 registry 登记质量的顺手修正
本单执行中发现的「读点登记不全」(§2 硬门 1 已列两例)只影响**被删条目**,随删除自然消失,不单独修 registry;但台账要记录差异,给 FLY-1455(CI 断言防复发)当输入。

### 9.2 `fleet_console`:旧 dashboard **不删**(Codex R1 修正)
初版误判 OFF 分支为死代码。实况:旧 dashboard fallback 还有两个与本 flag 无关的活入口——`FLYWHEEL_PROJECTS` split-brain guard(env-pinned 部署强制走旧 dashboard)与 console 初始化失败的 try/catch 回退。本单只做 §3 #20 的精确变换(删 `!== "0"` conjunct),fallback 全链与其测试原样保留;想退役 fallback 是行为变更,不属于本批,需另立单。

### 9.3 `cmux_strict_view` × `FLYWHEEL_CMUX_LINKED_VIEW` 联动
registry 明文:linked_view「完整 grouped rollback 需同时设 `FLYWHEEL_CMUX_STRICT_VIEW=0`」。strict_view 固化开后,linked_view(FLY-1446 保留)的 `=0` 回滚只剩「独立视图」形态,双关组合的 legacy grouped 拓扑回滚路径消失。体检已把 strict_view 裁进删批,本计划照执行,但 PR-B 必须:(a)验 `LINKED_VIEW=0` + strict 无条件 ON 的组合仍有既有测试覆盖且绿;(b)在 PR 描述向 Lead 明示这条回滚路径的收窄。

### 9.4 墓碑防复活的真实覆盖面(诚实边界,Codex R1 扩正)
drift 守卫的「retired tombstone 不许再有生产读点」断言只覆盖:**四个 `SCAN_DIRS`**(teamlead / config / flywheel-comm / edge-worker 的 src)里、**它的正则认识的形态**(`process.env.X` 与带布尔比较的 `env.X`)。因此拦不住:(a)shell 脚本复活;(b)`packages/claude-runner`(不在 SCAN_DIRS——恰是 #4 `codex_gate_wait` 的读点所在包);(c)`env().FLYWHEEL_X` 调用形态(恰是 #11 第三读点 voice-routes 的写法)。本单**不扩建扫描器**(不加报警器,删的比加的多),对应的诚实声明:墓碑可靠地挡住的是「`.env` 残留」与「SCAN_DIRS 内扫描器认识的 TS 形态复活」;其余形态防复活靠 review + 各 PR 的 grep-zero 基线。若未来要收口,归 FLY-1455(CI 断言/扫描器扩形态),不在本单。

## 10. 不做什么

- **不碰** §2 之外的任何 flag。特别是:保留的守 ship 路 break-glass 开关(`codex_hard_gate_killswitch` · `merge_approval_gate_killswitch` · `qa_done_gate_killswitch` · `ship_ci_guard` · `design_html_gate`)零改动;`founder_ux_gate_killswitch` Annie 已改判「删」(tally §4),但它不在 §2 的 49 条内,执行归属由 Lead 另行安排,本单不越界。
- 不碰 E6 六条与 `done_thread_reconcile`(§1);`.env:167` `FLYWHEEL_MAILBOX_QUEUE=1` 随 E6/wave-2 处置,本单不动。
- 不删旧 dashboard fallback(§9.2)、不扩 drift 扫描器(§9.4)。
- 不动 flag 存储/动态化架构(FLY-1778)、不做创建时治理(FLY-1455)、不做每周扫描(B3)。
- 生产 `~/.flywheel/.env` 只清理 wave-1 的 `.env:137`(PR-B ship 窗,§8);`.env:167` 留给 E6/wave-2;其余行一概不动。
- 不新建 shell 侧 flag 扫描器(§9.4)。

## 11. 实施硬门 #4 三格复核(Lead/Cass 追加)

复核基线为删除前 `HEAD=93c1e59a6` 的真实读点,生产值扫描覆盖 `~/.flywheel/.env`、`~/Library/LaunchAgents`、`~/.flywheel/bin`。42 条里只有 `FLYWHEEL_CMUX_VIEW_INVARIANT=1`,其余均未设置。registry 的 42 个 `default` 都是合法布尔值 `true`;没有「写了默认、但默认本身不可用」的条目。

| # | envVar | 固化值 + 生产现值 | absent-read 验证(删除前代码) | registry default |
|---|---|---|---|---|
| 1 | `FLYWHEEL_LIVENESS_ALERTS` | ON;生产未设 | `env.X !== "0"` ⇒ ON == 现行为 ✓ | `true`,合法 ✓ |
| 2 | `FLYWHEEL_PRUNE_PARK_GUARD` | ON;生产未设 | `!== "0"` / `=== "0"` 早退均落 park-veto ON == 现行为 ✓ | `true`,合法 ✓ |
| 3 | `FLYWHEEL_READOPT_PARKED` | ON;生产未设 | `=== "0" ? running-only : expanded` 落 expanded park roles == 现行为 ✓ | `true`,合法 ✓ |
| 4 | `FLYWHEEL_TMUX_KEEPALIVE` | ON;生产未设 | shell `${X:-1}` 落 policy enforcement == 现行为 ✓ | `true`,合法 ✓ |
| 5 | `FLYWHEEL_CMUX_WAL_QUARANTINE` | ON;生产未设 | shell `${X:-1}` 落 quarantine == 现行为 ✓ | `true`,合法 ✓ |
| 6 | `FLYWHEEL_CMUX_ROSTER` | ON;生产未设 | shell `${X:-1}` 落 roster reconcile == 现行为 ✓ | `true`,合法 ✓ |
| 7 | `FLYWHEEL_CMUX_VIEW_INVARIANT` | ON;生产显式 `=1` | shell `${X:-1}` + TS `!== "0"` 均落 invariant ON == 现行为 ✓ | `true`,合法 ✓ |
| 8 | `FLYWHEEL_CMUX_STRICT_VIEW` | ON;生产未设 | shell `${X:-1}` + TS `!== "0"` 均落 strict independent view == 现行为 ✓ | `true`,合法 ✓ |
| 9 | `FLYWHEEL_CODEX_GATE_WAIT` | ON;生产未设 | `process.env.X !== "0"` ⇒ resident wait ON == 现行为 ✓ | `true`,合法 ✓ |
| 10 | `FLYWHEEL_DUAL_ACTIVE_SCAN` | ON;生产未设 | 两处 `env.X !== "0"` ⇒ scan ON == 现行为 ✓ | `true`,合法 ✓ |
| 11 | `FLYWHEEL_QUOTA_DEGRADED_SWITCH` | ON gate;生产未设 | `process.env.X !== "0"` ⇒ 允许已由 quota config 开启的降级 == 现行为 ✓ | `true`,合法 ✓ |
| 12 | `FLYWHEEL_QUOTA_WAKE` | ON;生产未设 | `process.env.X !== "0"` ⇒ wake path ON == 现行为 ✓ | `true`,合法 ✓ |
| 13 | `FLYWHEEL_REVIEW_SEVERITY_POLICY` | ON;生产未设 | `env.X !== "0"` ⇒ severity policy ON == 现行为 ✓ | `true`,合法 ✓ |
| 14 | `FLYWHEEL_PROGRESS_RESUME` | ON;生产未设 | `!== "0"` / `=== "0"` 早退均落 resume ON == 现行为 ✓ | `true`,合法 ✓ |
| 15 | `FLYWHEEL_CMUX_CLOSE_REQUEST` | ON;生产未设 | TS `=== "0"` 早退不触发 + shell `${X:-1}` ⇒ marker write/drain ON == 现行为 ✓ | `true`,合法 ✓ |
| 16 | `FLYWHEEL_FOUNDER_REVIEW_GATE_EXCLUDE` | ON;生产未设 | `process.env.X !== "0"` ⇒ exclusion ON == 现行为 ✓ | `true`,合法 ✓ |
| 17 | `FLYWHEEL_FOUNDER_AUTO_APPROVE` | ON;生产未设 | 两处 `!== "0"` + voice `=== "0"` 早退不触发 ⇒ approval ON == 现行为 ✓ | `true`,合法 ✓ |
| 18 | `FLYWHEEL_STALE_SHIP_REWAKE` | ON;生产未设 | `process.env.X !== "0"` ⇒ re-wake ON == 现行为 ✓ | `true`,合法 ✓ |
| 19 | `FLYWHEEL_AUTO_LINEAR_DONE` | ON;生产未设 | `=== "0"` 早退不触发 ⇒ Linear Done path ON == 现行为 ✓ | `true`,合法 ✓ |
| 20 | `FLYWHEEL_FOUNDER_REPLY_UNREACHABLE` | ON;生产未设 | `env.X !== "0"` ⇒ alert ON == 现行为 ✓ | `true`,合法 ✓ |
| 21 | `FLYWHEEL_ASK_HYGIENE` | ON;生产未设 | DB/Bridge 各读点 `env.X !== "0"` ⇒ hygiene ON == 现行为 ✓ | `true`,合法 ✓ |
| 22 | `FLYWHEEL_FOUNDER_MILESTONE_NOTIFY` | ON;生产未设 | `process.env.X !== "0"` ⇒ notify ON == 现行为 ✓ | `true`,合法 ✓ |
| 23 | `FLYWHEEL_ENGINE_DEAD_EXEC_SWEEP` | ON;生产未设 | `env.X !== "0"` ⇒ sweep ON == 现行为;FLY-1707 replay 已以自然 no-op fixture 通过 ✓ | `true`,合法 ✓ |
| 24 | `FLYWHEEL_ENGINE_UNLAUNCHED_TRIPWIRE` | ON;生产未设 | `env.X !== "0"` ⇒ tripwire ON == 现行为;FLY-1707 replay 已以自然 no-op fixture 通过 ✓ | `true`,合法 ✓ |
| 25 | `FLYWHEEL_REMOTE_REPORTS` | ON;生产未设 | Bridge `!== "0"` + CLI `=== "0"` 短路不触发 ⇒ publish/deliver ON == 现行为 ✓ | `true`,合法 ✓ |
| 26 | `FLYWHEEL_FLEET_CONSOLE` | ON arm;生产未设 | `X !== "0" && !FLYWHEEL_PROJECTS` ⇒ 仅去掉 flag conjunct,非 flag 的 projects/fallback guards 原样 == 现行为 ✓ | `true`,合法 ✓ |
| 27 | `FLYWHEEL_COMMDB_RESIDUE_HARVEST` | ON;生产未设 | `process.env.X !== "0"` ⇒ harvest ON == 现行为 ✓ | `true`,合法 ✓ |
| 28 | `FLYWHEEL_TERMINAL_COMMDB_SYNC` | ON;生产未设 | `process.env.X !== "0"` ⇒ terminal sync ON == 现行为 ✓ | `true`,合法 ✓ |
| 29 | `FLYWHEEL_CRON_STALE_GUARD` | ON;生产未设 | `process.env.X !== "0"` ⇒ stale guard ON == 现行为 ✓ | `true`,合法 ✓ |
| 30 | `FLYWHEEL_SHIP_GATE_REBIND` | ON;生产未设 | `env.X !== "0"` ⇒ rebind ON == 现行为 ✓ | `true`,合法 ✓ |
| 31 | `FLYWHEEL_SHIP_GATE_RETIRE` | ON;生产未设 | `!== "0"` / `=== "0"` 早退均落 retire ON == 现行为 ✓ | `true`,合法 ✓ |
| 32 | `FLYWHEEL_SHIP_GATE_CARD` | ON;生产未设 | `process.env.X !== "0"` ⇒ card ON;独立 grace var 保留 == 现行为 ✓ | `true`,合法 ✓ |
| 33 | `FLYWHEEL_TIER2_PREFIX_NORM` | ON;生产未设 | `process.env.X !== "0"` ⇒ prefix normalization ON == 现行为 ✓ | `true`,合法 ✓ |
| 34 | `FLYWHEEL_VIEWER_SESSION_REAPER` | ON;生产未设 | `process.env.X !== "0"` ⇒ boot reaper ON == 现行为 ✓ | `true`,合法 ✓ |
| 35 | `FLYWHEEL_CHROME_REAPER` | ON arm;生产未设 | `X !== "0" && !isTest` ⇒ 仅去掉 flag conjunct,测试/归因/grace guards 原样 == 现行为 ✓ | `true`,合法 ✓ |
| 36 | `FLYWHEEL_FLEET_SENSOR_TMUX` | ON;生产未设 | `process.env.X !== "0"` ⇒ coordinator ON == 现行为 ✓ | `true`,合法 ✓ |
| 37 | `FLYWHEEL_LAND_NODE` | ON;生产未设 | `env.X !== "0"` ⇒ land node ON == 现行为 ✓ | `true`,合法 ✓ |
| 38 | `FLYWHEEL_VENDOR_AT_DISPATCH` | ON;生产未设 | `env.X === "0"` legacy 分支不触发 ⇒ dispatch-time vendor resolution == 现行为 ✓ | `true`,合法 ✓ |
| 39 | `FLYWHEEL_COMMDB_PROTECTION` | ON;生产未设 | `process.env.X !== "0"` ⇒ protection ON == 现行为 ✓ | `true`,合法 ✓ |
| 40 | `FLYWHEEL_CONTINUITY_PREFLIGHT` | ON;生产未设 | `X !== "0" || freshStart` 第一项为 true ⇒ preflight ON == 现行为 ✓ | `true`,合法 ✓ |
| 41 | `FLYWHEEL_PUSH_GUARD` | ON;生产未设 | 两个 `process.env.X !== "0"` ⇒ hook/config guard ON == 现行为 ✓ | `true`,合法 ✓ |
| 42 | `FLYWHEEL_DOA_BACKOFF` | ON;生产未设 | `=== "0"` bypass 不触发 + `!== "0"` enforcement ⇒ admission/maintenance/backoff ON == 现行为 ✓ | `true`,合法 ✓ |
