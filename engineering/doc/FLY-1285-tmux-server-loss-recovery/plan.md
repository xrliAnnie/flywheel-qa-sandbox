# FLY-1285 tmux server 丢失 + 恢复配置漂移 — 实施计划

Issue: FLY-1285 (https://linear.app/geoforge3d/issue/FLY-1285/incident-2026-07-15-0016-runner-tmux-server-丢失10-runner-阵亡-恢复机制以)
日期: 2026-07-15
基于: research.md

**Status**: draft（codex design review Round 5 中；R1×10 + R2×8 + R3×8 + R4×6 已全量吸收）
**裁决来源**: brainstorm gate 已过（Tadashi 批 A/B/C 全量 + 四点裁决：PR-0 最先单独出 / runbook 附 research / B 加真机验收 / C 批准）。

## 核心安全原则（贯穿全计划）

1. **破坏性动作只接受正向证明**：创建 server、埋葬 session、清理旧 claude 的前置必须是"完整扫描证明"；`unknown` / `ambiguous` / `saturated` / `rescue_failed` / helper 缺失 / ps·lsof 失败一律 hold/backoff，绝不 fail-open（与 tmux-lookup.ts:259-279 三态约定同构）。
2. **诊断→决策→动作原子**：每 socket 一把跨进程锁，受保护动作（SIGUSR1 / create）只在锁内、紧跟锁内 re-inspect 之后执行。
3. **hold 可持久、可解除、有界升级、告警一次**：`tmux_hold` episode 的**单一权威是 Bridge/StateStore**（§3.3）；计时起点持久化，supervisor/Bridge 重启都不重置；收敛自动 resolve。
4. **代码合入 ≠ 行为激活**：auto-SIGUSR1 由**每次调用现读的原子 activation marker** 控制（§4），不依赖进程启动时冻结的 env；merge 只带来代码，安全增益从激活批次的重启开始。
5. **世代绑定**：一切 target 级 tmux 操作（判活、判死、发键、kill-window、档案清理）之前都必须验证"当前 reachablePid == 档案 serverPid"；世代不符则 windowId 不可信。

## 0. 总览与 PR 切分

| PR | 内容 | 目标文件 | 生效方式 | 依赖 |
|---|---|---|---|---|
| PR-0 | 健康窗可配置（FLY-1290 载体，**最先单独出、独立小分支**） | scripts/restart-services.sh、scripts/lib/health-window.sh（新）+ 测试 | 下次跑 restart-services.sh 即生效 | 无 |
| PR-1 | inspect/recover/ensure 库（显式协议 + OS advisory 锁）+ supervisor 三态等待与世代绑定 + Fix C + Fix B + hold observation 上报 | scripts/lib/tmux-server-rescue.sh（新）、packages/teamlead/scripts/claude-lead.sh、scripts/lead-alert.sh（kind allowlist）+ 测试 | **supervisor 进程重启**生效；auto-rescue 由 marker 控制（默认无 marker=hold-only） | 无（与 PR-0 并行可） |
| PR-2 | Bridge/Runner 侧：ensureRunnerSession 全程 async 守卫 + ServerLossCoordinator 穷举裁决与 active-hold 对账 + durable hold 贯通 reaper + tmux_split_brain/tmux_hold 契约 + hold-observation 端点 + CLI sync | packages/claude-runner/src/TmuxAdapter.ts、packages/teamlead/src/bridge/{server-loss.ts,plugin.ts,sync-flywheel-hooks.ts,kind-contract.ts,ticket-owner-map.ts}、packages/teamlead/src/{HeartbeatService.ts,StateStore.ts,LeadAlertNotifier.ts} + 各自测试 | 需 Bridge 重启（激活批次，§4） | PR-1 |

三阶段管线注：本分支为共享分支；PR-0 从 main 开小分支速出（Tadashi 裁决），PR-1/PR-2 在本分支交付（再拆与否按 implement 时体量与 Lead 意见）。docs 随本分支 PR 合入。

## 1. PR-0 — restart-services.sh 健康窗可配置

1. 新 `scripts/lib/health-window.sh`（可 source 极小单元）：`resolve_health_window_sec`（读 `FLYWHEEL_BRIDGE_HEALTH_TIMEOUT_SEC`）+ `health_window_rounds`（ceil(sec/2)）。restart-services.sh 在 `.env` source（:32-95）**之后**解析。
2. 解析：未设/空→默认 **240**；非法→**回 240**+warning；合法 <30→clamp 30+warning；≥30→原值。
3. deploy（:1288-1301）与 bridge-only（~:1380-1395）两处循环都消费同一 `health_window_rounds`；:1362 dry-run 与 :1392 告警文案引用实际值。
4. abnormal-exit 面包屑砍出（follow-up）。

测试：`scripts/__tests__/restart-health-window.test.sh` source 真实单元（未设→120 轮；40→20；41→21；5→30+警告；abc/-1/0→240+警告；60→30 旧行为哨兵）+ **两条生产路径各自独立的静态断言**（都消费 health_window_rounds、无 `seq 1 30`/写死 60s 残留）+ 现有 5 个 restart-*.test.sh 全绿。
验收：/health 第 90s 才 ok：`=60` 判失败、默认 240 判成功。

## 2. PR-1 — 库 + supervisor 接入 + Fix B + Fix C

### 2.1 `scripts/lib/tmux-server-rescue.sh`

**(a) inspect**：`tmux_socket_inspect <socket_path>` → 单行 JSON `{"verdict","socketPresent","socketPath"(归一 /private/tmp),"reachablePid","candidatePids":[],"scanComplete"}`；verdict ∈ reachable|missing_single_orphan|saturated|dead|split_brain|ambiguous|unknown。判定与归一化同 v3（可达性 portable 有界 ≤3s；候选=同 uid+ppid==1+lsof 引用；ps/lsof 失败→scanComplete:false→unknown；候选>1 绝不自动选）。

**(b) 显式协议的 guarded 原语（R3 #1 定案）**——库绝不执行 caller shell function、绝不从 argv 猜目标：

- `tmux_socket_ensure <socket> --verify <probe-argv...> --create <create-argv...>`：
  - 两段 argv 必须都是**展开后的 `tmux -S <归一化路径> …`**（库校验 -S 存在且与 socket 一致，否则拒执行）。
  - 锁内流程：re-inspect → `reachable`：先跑 --verify（目标已存在→action=verified）；不存在→锁内跑 --create，**且 reachable/rescued 分支的 create 一律注入全局 `-N`（tmux 3.5a：即使命令通常会启动 server 也绝不启动）**——锁只能串行化 helper，挡不住 inspect 成功后下一瞬间 server 转入饱和，`-N` 把"顶替式自启"在 tmux 层物理封死（R4 #1）；`-N` create 失败→锁内 re-inspect + 重跑 --verify，仅"同一 reachablePid 下 verify 明确成功"才算并发 duplicate，否则 hold。`missing_single_orphan`+marker 开：SIGUSR1（发前对候选即时 ps/lsof 重验）→ 锁内等 socket 重现 → **完整 re-inspect 必须证明 reachablePid==被 signal 候选、scanComplete、无其它候选** → 才继续 verify/`-N` create；任一不满足→hold。**只有 `dead`（scanComplete）分支允许不带 `-N` 的 server-starting create**。`saturated`/`ambiguous`/`split_brain`/`unknown`/marker 关→对应 hold。
  - **终验（R4 #1 尾）**：任何 verified/created 成功路径返回前，再做一次完整锁内 inspect——只有 `reachable + scanComplete + 零其它候选` 才返回最终 reachablePid；否则按对应 hold 返回。
  - 成功 JSON：`{"action":"verified|created|rescued_then_verified|rescued_then_created","createStdout":"...","reachablePid":N}`——**锁内终验的 reachablePid 随结果返回**，caller 用它原子写四元组档案（不许解锁后另探世代）。退出码 0=成功；2/3/4=hold（saturated / ambiguous·split_brain / unknown）。
- `tmux_socket_recover <socket>`（R3 #4：**never-create 原语**，供 `_wait_tmux_window` 与 Bridge coordinator 用）：锁内 inspect→仅在 missing_single_orphan+marker 开时走同款 SIGUSR1+postcondition；输出 `{"action":"reachable|rescued|hold_*","reachablePid":N}`；任何路径都不 create。

**(c) 锁（R4 #2 定案：OS 持有的 advisory lock，进程退出自动释放）**：
- `mv` 目录不是 no-clobber 原语（目标存在时会移动**进**目标目录）——弃用 dot-lock。改为：临界区在**OS advisory lock** 下执行：锁文件 `~/.flywheel/locks/tmux-<sha256(归一路径)前16>.lockf`（父目录预建、权限受控）；获取方式按能力探测链选择——`flock(1)` → `lockf(1)` → `/usr/bin/python3 -c` fcntl.flock 薄封装——**全部缺失 → fail-closed hold**（记录能力缺失日志）。临界区（inspect+signal/create+终验）作为持锁子命令运行，**进程退出（含 SIGKILL/掉电）内核自动释放**，不存在陈旧锁回收问题。
- owner 元数据（pid+start-identity+token）仅作**诊断**写入旁文件，不参与互斥、不参与回收（R4 #2）。
- 取锁有界等待（默认 5s）→ 超时按 unknown hold。**库不安装全局 trap**（caller 的既有 supervisor trap 不被覆盖；OS 锁本身无需 trap 清理）。
- 测试：**两个真实进程同时抢锁**证明临界区并发恒为 1；持锁进程 SIGKILL 后下一方立即可获锁；三级探测链逐级降级 + 全缺 fail-closed；caller 既有 trap 仍执行。
- dry-run env `FLY1285_RESCUE_DRY_RUN=1`；shellcheck；风格随 reap-orphan-adapters.sh。

### 2.2 claude-lead.sh 接入

**(a) `_tmux()` 包装**：`FLYWHEEL_TMUX_SOCKET_OVERRIDE` 非空→所有 tmux 调用注入 `-S`；默认空=逐字节现状。传给库的 --verify/--create 用**展开后的 argv**（由一个小构造函数生成 `tmux -S <path> …` 数组，与 _tmux 同源，绝不传 shell function 名，R3 #1）。

**(b) `ensure_tmux_session`** → `tmux_socket_ensure <path> --verify "tmux -S <path> has-session -t =flywheel" --create "tmux -S <path> new-session -Ad -s flywheel -x 200 -y 50"`；成功后把返回的 reachablePid 暂存供档案写入；hold→返回非零+`ENSURE_HOLD_KIND`。

**(c) main loop set -e 修正 + hold 上报（R4 #3 修正时序）**：两处 if ! 包裹；hold 不进 crash/resume 计数、独立退避。**首次进入 hold 就立即、幂等 POST hold observation**（§3.3；重试有界、失败降噪），Bridge 以服务端接收时间创建/归并 episode 并**由 Bridge 在 10min 后升级告警**——supervisor 第 9 分钟重启也不重置计时（计时在 StateStore）。后续每轮 hold 只更新 last_seen/evidence。Bridge 不可用 fallback：lead-alert.sh 一条**明确标注不可自动 resolve** 的 severe（dedupe 按 lead/socket/日；此路径不承诺跨重启计时——诚实降级）。

**(d) `_wait_tmux_window` 三态 + 全路径世代绑定（R3 #2 修正——成功分支也验）**：
- launch 成功即写四元组档案：`serverPid（库返回的锁内 reachablePid）+ panePid + pane start-identity + windowId`。
- **每次接受任何 target 级结果前**（含 `list-panes` 成功分支）：先验当前 reachablePid == 档案 serverPid（轻量：inspect 的可达性探针+lsof 比对，或 `tmux -S … display-message -p '#{pid}'`），再验 pane 的 PID+start-identity。世代不符 → windowId 全体作废：判活/判死只看档案 panePid 的 OS liveness（ps + start-identity）；**dialog poller、send-keys C-c、kill-window、档案清理在动作前都做同样的 live re-check**——绝不触碰新 server 的同号 window。
- `list-panes` 失败 → server_indeterminate → `tmux_socket_recover`：reachable/rescued（且世代==档案）→ 硬证据 absence 探测（can't find window/session/pane 类 stderr 才算证明；timeout/EACCES 维持 indeterminate）→ proven_window_gone 或回等待；hold_* → 停留等待循环（降噪日志 + 并入 hold observation 升级）。
- graceful cleanup() 在 indeterminate/世代不符时：不发键、不 kill、**不删档案**（留给下一代 supervisor takeover）。

### 2.3 Fix C — 双实例互斥
同 v3：仅 proven_dead/proven_window_gone 后 reap；TERM 前重验（command 含 claude+lead 辨识+start-identity 一致；不符=PID 复用只清档案）→ TERM → ≤10s → **KILL 前再重验** → KILL。cleanup 只在非 indeterminate 清档案。

### 2.4 Fix B — model/effort 每次 launch 现读 manifest
同 v3（本地 resolver、jq 失败降级 env 不退出、effort enum 链保 :1636-1676 语义、日志与最终 argv 严格一致：`using manifest` 仅在校验通过且被采用时；`invalid manifest effort → using env`）。
**真机验收（R3 #8 修正——必须证"自然 relaunch"而非重启 supervisor）**：QA slot 隔离 lead，改 manifest.model 为有效备选值后，**保持同一 supervisor PID**，只结束其当前 claude pane 进程触发既有 crash/relaunch 路径 → 断言：supervisor PID 未变、plist/进程 env 未变、新 claude argv 用 manifest 值且恰出现一次、旧 claude 不存活、无第二次 resume、drift 日志一行。另保留"supervisor 重启后同样生效"作部署验收（不替代核心证明）。

### 2.5 PR-1 测试
- 库：七态 inspect 桩测；ensure 协议（verify-first / `-N` 注入与 dead 分支豁免 / create 失败后锁内 verify 判 duplicate / 终验 postcondition / createStdout 与 reachablePid 透传 / argv 无 -S 或不一致拒执行）；recover never-create；锁（双真实进程抢锁并发恒 1、SIGKILL 自动释放、探测链降级、全缺 fail-closed、caller trap 保留）；marker 关→全路径拒 SIGUSR1；rescue postcondition。
- **故障注入（R4 #1）**：隔离 socket 上 inspect 成功后、create 前 SIGSTOP server → 断言 `-N` create 失败并 hold、socket inode 与 server PID 不变、绝无第二 server。
- 真 tmux 隔离段：E1 saturated→hold；E2 rescued；E3 split_brain 拒 SIGUSR1；reachable+目标缺→create；override+default decoy 零扰动。
- 并发赛跑：终态 `verdict=reachable + candidatePids=[] + reachablePid 为预期世代`。
- supervisor：seam 测试（hold 计数/退避/observation 一次）；三态 wait；**世代陷阱三连测**：同号 window 下 (i) wait/判活不误读 (ii) dialog poller 不误发键 (iii) cleanup/TERM/KILL 不误杀且档案保留；indeterminate 期 SIGTERM 用例；Fix C 双重验证；Fix B 矩阵（含日志-argv 一致性）。
- E1/E2 真机断言：旧 Lead PID 存活、session file 未改写、无二次 --resume。

## 3. PR-2 — Bridge/Runner 侧

### 3.1 TmuxAdapter.ensureRunnerSession（R3 #5 修正：整段 async，含首探）
- **删除前置同步 `has-session`**（:1184-1189）：ensure 全流程改为一个 async guarded-exec 依赖 seam——Promise execFile 调 `~/.flywheel/bin` rescue CLI 的 `ensure`（--verify has-session、--create new-session），per-attempt timeout + 总 deadline（默认 90s，env 可调，含锁等待）；`execute()`（:219-237）await 之。锁内 verify-first 语义天然覆盖"已存在"路径，无需 caller 先探。
- typed hold（`tmux_saturated` 等）**不得被现有 fallback catch 吞掉**（:1191-1212 的二次 plain create 移除/同受 guard）：deadline 耗尽或 CLI 缺失 → 抛 typed error → 既有失败面（Blueprint success:false → DagDispatcher shelve），响亮日志；端到端 retryable dispatch 为 follow-up。
- createStdout 透传保 `-P -F '#{window_id}'`；scaffold rename 逻辑消费之。
- 测试：fake timers 证明"首探永不返回也不卡 event loop、deadline 后抛 typed hold"专用用例；等待期 event loop 可服务；四 backend（Claude/Codex/Antigravity/Kimi）继承路径；既有 ~110 it 全绿。

### 3.2 ServerLossCoordinator + HeartbeatService + StateStore（R3 #4 修正：active-hold 穷举 + recover 原语 + 事务化）

**durable hold**：StateStore `tmux_hold` = `{kind: saturated|split_brain|ambiguous|unknown|rescue_failed|lock_unavailable, evidence(JSON), affectedExecutionIds[], originalShape(server_down|server_fresh), created_at, last_checked_at}`（lock_unavailable=锁能力缺失/锁异常，替代 v4 的 corrupt_lock——OS 锁下无陈旧锁形态）。

**tick leg（probe=down 时 inspect）**：
| verdict | 动作 |
|---|---|
| reachable | **建立短期 reconcile hold**（不埋葬；下一 active-hold 轮完成 target 对账——防 first-check 证据被消费后漏成组对账，R3 #4 尾） |
| missing_single_orphan | marker 开→`tmux_socket_recover`；rescued→零埋葬+log-only；失败/关→hold |
| saturated / ambiguous / unknown | durable hold |
| split_brain | durable hold + `tmux_split_brain` ticket |
| dead（scanComplete） | 现行 server_down 埋葬 |

**boot leg（probe=up + wasFirst + targetGone 全 true 时 inspect）**：
| verdict | 动作 |
|---|---|
| reachable（scanComplete+零候选） | 正向证明单 server 换代 → 现行 server_fresh 成组迁移 |
| split_brain / ambiguous | durable hold（split_brain 加 ticket）+ 零迁移 |
| missing_single_orphan | marker 开→recover；成功零迁移；失败→hold |
| saturated / unknown | durable hold + 零迁移 |
| dead | 与 probe=up 矛盾 → 防御性按 unknown hold |

**active-hold（存在 tmux_hold 时每 tick，七态穷举）**：
| verdict | 动作 |
|---|---|
| reachable | target reconcile（四态）：all-present→清 hold+resolve ticket；all-gone→**hold→episode 幂等 transition（见下）**；mixed→gone 子集并入 transition、present 子集释放，transition 提交后才清 hold+resolve；indeterminate（任一 target 探测非硬证据）→ 继续 hold |
| missing_single_orphan | marker 开→recover 重试；成功→转 reachable 分支对账；失败→继续 hold |
| dead（scanComplete） | 原 server 真死 → 同款事务 arm episode（shape=originalShape）→ 清 hold |
| saturated / ambiguous / unknown | 刷新证据/时间戳继续 hold |
| split_brain | 刷新证据继续 hold（ticket 已在） |

**hold→episode transition 的事务边界（R4 #4：尊重 singleton ledger + outbox 分工）**：现有 `server_loss_episode` 是 id=1 单行 ledger（StateStore.ts:1831-1845,6604-6665），且迁移/CommDB 通知/Discord ticket 都不能在 SQLite 事务内执行。定义：
- 事务内**只**做两件事：写/合并 durable server-loss ledger 的 intent（signature、shape=originalShape、claimed ids）+ 删除对应 tmux_hold 行。
- singleton 冲突语义：已有未完成 episode 且属同一事件（同 socket 世代/签名可归并）→ **合并 claimed ids 进现有 episode**（绝不覆盖其 notifiedLeads/ticketDone/notifyAttempts——待重放副作用不可丢）；无法安全归并 → **保留 hold**，等旧 episode 走完（episodeComplete 清账）后下一 tick 再 transition。
- 事务提交后，migrate/notify/alert 全部由**既有 coordinator outbox**（check() 的重放语义）执行——transition 只制造账本状态，不直接产生副作用。
- 测试三组：已有 pending episode（归并/等待两分支）；commit 后、首个副作用前 crash（重启后 outbox 重放）；transition 幂等重放。

**HeartbeatService**：`check()` 返回 `{claimed, heldExecutionIds}`；三 reaper 对并集内 session 跳过破坏性动作；crash-reaper suppression（:1719-1733）加入同一判据；helper 缺失/异常→本 tick 全部 tmux-backed running 按 held（fail-closed）+ 日志。

测试：三张表逐行用例；reconcile 四态（含 mixed）；事务原子性（arm 与 clear 同 commit、幂等重放）；hold 重启幸存；resolve 时机；既有 server-loss 用例全绿。

### 3.3 `tmux_hold` 单一权威 + 告警契约（R3 #6 定案）

- **单一权威 = Bridge/StateStore**：durable `tmux_hold` episode + ticket 都由 Bridge 拥有；计时起点 = hold `created_at`（持久，双端重启不重置）；收敛 resolve 走 `AlertChannelHub.resolve()`（ticket 在 StateStore active thread 内，通道成立）。
- **supervisor 上报 = hold observation（R4 #3 定案）**：PR-2 新增 Bridge 端点 `POST /api/tmux-hold-observation`（body：leadId/projectName/socketPath/kind/heldSinceTs——heldSinceTs 仅作参考证据，**权威计时 = Bridge 服务端接收时间**，绝不据 caller 时间即时拉 severe）。supervisor **首次进 hold 即幂等上报**（2.2c），Bridge 按 correlation key（归一 socketPath+kind）创建/合并 episode，10min 由 Bridge 侧升级；**双端并发上报合并为一**。端点硬化：`config.apiToken` 缺失时显式 503（现有 tokenAuthMiddleware 无 token 会 no-op，plugin.ts:765-770——不许裸跑）；校验 kind allowlist、lead/project 身份、socket 路径归一合法性、时间范围、body size。
- **Bridge 不可用 fallback**：supervisor 走 lead-alert.sh 发一条 severe，正文明确"人工确认，无自动 resolve"，dedupe=lead/socket/日——不承诺 episode 语义（诚实降级）。
- **kind 契约（全定死）**：`tmux_hold`：owner `"claude"`（infra-bot 诊断）、arc `"human_by_design"`（remediation=运维介入/runbook，收敛时系统自动 resolve 不代表 remediation 自动化）、severity severe、dedupe=归一 socketPath+kind+episode、升级阈值=observation 或 Bridge 自检 created_at 起 10min、resolve=active-hold 对账完成。`tmux_split_brain`：owner `"founder_direct"` + arc `"human_by_design"`（并加入 ticket-owner-map.ts:67-75 no-owner 面）、severity severe、dedupe=归一 socketPath+排序 PID 集、resolve=reconcile transition 完成后、metadata=`{socketPath,reachablePid,orphanPids,casualtiesHeld}`。`socket_lost_rescued`=log-only。
- ALERT_EVENT_TYPES/KIND_CONTRACTS/router/Hub/dedupe/owner-map 的 exhaustive 测试全列 PR-2 验收；shell 侧 lead-alert.sh kind allowlist 在 PR-1 加入。**CLI sync 契约（R4 #6）**：rescue CLI 加入 syncFlywheelCliBin 默认 allowlist + `sync-flywheel-hooks` 测试断言（allowlist 含该 CLI、同步后可执行位、missing-source 时的行为）；soft-fail 现状由 §4 的激活 preflight 兜底（CLI 未验证到位不许开 marker）。
- 测试：supervisor 重启计时不重置、Bridge 重启 episode 幸存、双端并发上报合一、fallback 路径。

### 3.4 PR-2 真机段（QA）
隔离 socket 重演 server_fresh 假埋：零埋葬、split_brain ticket 恰一、hold 落库+重启幸存、收敛三分支（present→清；gone→事务 arm episode 后清；mixed→部分 arm）+ resolve 时机。

## 4. 部署与激活顺序（R3 #7 修正：marker 现读，不靠冻结 env）

1. PR-0 独立 merge。
2. PR-1/PR-2 代码合入——**运行中进程不受影响**（不重读脚本/不加载新 dist）；此阶段无行为变化。
3. **激活批次（一个批量重启窗）**：Bridge 重启（PR-2 dist 生效、CLI sync 落位验证、全 Runner creator 受 guard）→ supervisor 批量重启（PR-1 脚本生效，此时 marker 不存在=全 fleet hold-only，安全增益从这里开始）→ 验证 hold-only 行为正常 → **激活 preflight**（R4 #6：`~/.flywheel/bin` 的 rescue CLI 必须存在、可执行、内容 hash 与源一致——syncFlywheelCliBin 是 soft-fail（sync-flywheel-hooks.ts:281-318），preflight 不过绝不许创建 marker）→ **原子创建 activation marker `~/.flywheel/flags/tmux-auto-rescue.on`**（创建即全 fleet 即时开启，无第二轮重启）。
4. **marker 安全判据（R4 #5：无任何 env 后门）**：生产路径**彻底移除按 env 启用的通道**（helper 不读任何 enable env——本票修的就是"冻结 env 当真相"的病，不能自己再埋一个）；测试通过临时 HOME/state-root 或 marker 路径 seam 建**真实 marker** 验证。helper 每次调用对 marker 做 `lstat` 校验：普通文件、当前 uid 所有、非 symlink、文件与父目录均非 group/world-writable——任一不符 → 视为未激活并 log（异常 marker 绝不激活）。提供原子 enable/disable 操作说明（写临时文件+rename / rm）与回滚验收（rm marker → 下一次调用即回 hold-only）。
5. QA 过渡用例：marker 不存在/malformed/symlink/错误权限时全路径拒 SIGUSR1；创建 marker 后**真实运行中的进程**下一次调用即生效；rm 后即回退（验行为非验文件）。
6. 活体 split-brain 收敛（research §4 runbook）建议在激活批次前由 Tadashi/founder 执行。
7. Follow-up：abnormal-exit 面包屑；端到端 retryable dispatch；tmux arm64 + 探测洪峰减载。

## 5. 风险与缓解
- hold 卡创建：有界升级（10min observation→episode 告警；TmuxAdapter 90s deadline 降级 shelve；Bridge 按 held ids 精准抑制）；dead 正向证明放行冷启动；锁在 ~/.flywheel/locks 不依赖 tmux 目录。
- 锁异常：OS advisory lock 进程退出自动释放（无陈旧锁）；能力探测链全缺→fail-closed hold（kind=lock_unavailable）+ 诊断 runbook（research §4 附录）；不装全局 trap。
- SIGUSR1/顶替误发：marker 默认关且无 env 后门；三前置+signal 前重验+终验 postcondition；reachable/rescued 分支 create 强制 `-N` 物理禁自启。
- event loop：整段 ensure async+deadline，fake-timer 专用用例。
- 同号 window 误伤：核心原则 5 全路径世代校验，三连测覆盖 poller/cleanup/TERM-KILL。
- 契约面遗漏：exhaustive 测试逐项验收。

## 6. 验收清单（QA 阶段照单执行）
1. PR-0：解析矩阵 + `=60` vs 240 慢启动对照 + 两条生产循环独立静态断言。
2. E1 重演（隔离 -S + default decoy）：hold 不顶替、独立退避、tmux_hold 告警恰一次（episode 语义）、恢复自动接续；旧 Lead PID 存活、session file 未改写、无二次 --resume。
3. E2 重演：recover 找回窗口→回等待零动作；或硬证据判死→正常重启。
4. 并发赛跑（两真实进程）：临界区并发恒 1、SIGKILL 持锁者后可续、终态 verdict=reachable+candidatePids=[]+预期世代。
5. `-N` 故障注入：inspect 后 SIGSTOP server → `-N` create 失败并 hold、socket inode/server PID 不变、无第二 server。
6. 世代陷阱三连测 + indeterminate 期 SIGTERM 档案保留。
7. split-brain（Bridge）：零埋葬、ticket 恰一、hold 持久+重启幸存、收敛三分支（含 singleton 归并/等待两分支 + crash-after-commit 重放）+resolve 时机。
8. B 真机：**同一 supervisor PID** 下杀 claude pane 走自然 relaunch → manifest 值生效恰一次、plist/进程 env 未变、无二次 resume、drift 日志一致（Tadashi 裁决 ③）；另附 supervisor 重启部署验收。
9. C 真机：proven 判死后四元组收敛；indeterminate 绝不触碰。
10. 激活过渡：preflight（CLI 存在/可执行/hash 一致）不过不许开 marker；marker 缺失/malformed/symlink/坏权限全路径拒 SIGUSR1；创建后运行中进程行为即时翻转；rm 即回退（行为级验证）。
11. tmux_hold 权威：首次进 hold 即上报、supervisor 重启计时不重置（计时在 StateStore）、Bridge 重启 episode 幸存、双端上报合一、无 apiToken 端点 503、Bridge-down fallback 文案正确。
12. 字节兼容锚：TmuxAdapter 既有套件（~110 it）、server-loss 既有用例、fly241-lead-model-override、claude-lead-manifest-preserve、launch-plan sentinel、5 个 restart-*.test.sh 全绿。
