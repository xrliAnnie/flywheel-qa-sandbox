# FLY-2919 进程生死单一真源 — 实施记录
Issue: FLY-2919 (https://linear.app/geoforge3d/issue/FLY-2919/病根修复-2-体的生死只认一个真源死体当场终结活体不再按窗口判死9-张-68)
日期: 2026-09-26
基于: plan.md

## 当前范围与游标

实现执行 `8031d5c6-58bf-45e7-bdb4-8648d332e6bc`，TURN implement epoch 6，activation `activation:8031d5c6-58bf-45e7-bdb4-8648d332e6bc:9d401eac-e64b-4165-b3af-d6b0cf08466a:implement:1`。
设计 gate `f4e94872-60c5-49a3-9d47-89a63b8264f6` 的有效 APPROVED 已通过 CLI 核验。开工同步 origin/main（含 FLY-2903），未重开设计。

六组范围全部保留。目前仅完成 A 组的第一小批启动准入基础；**A 组整体未完成，B–F 尚未实施，九单验收尚未完成**。没有 code review、PR、CI、QA 或 handoff 成功声明。

待 Lead 非阻塞问题 `03abfa06-bd6d-48c6-b72c-12a5a1280d48`：短 lease 外采样、lease_held 重试、死亡义务重放时效、直接消费者覆盖、2903 restart gate 复用；以及死亡写入 flag / 独立采样 cadence 处置。

## A 第一小批：daemon 身份提交与物理启动边界

修改前基线 `d375a0e5fb35af2835911f8a9b3418503eee6d85` 的代码与本小批 RED 时相同（该提交只更新进度）。

- `spawnCodexDaemon` 原来同步调用 `onSpawnIdentity`，忽略返回的 Promise。现等待身份接受；异步拒绝走既有 newborn 清理并在清理确认后释放 socket ownership。
- 新增内部同步 `authorizeSpawn` hook，在低层所有异步预检之后、native spawn 前复核，并在身份等待及 socket 轮询之后复核。返回非 true 或抛错拒绝；已出生的进程走既有清理。
- `CodexDaemonGoalRuntime` 将自身 stop 状态与调用方授权合并，传至物理 spawn，覆盖 preflight await 内收到 stop 的情况。
- `CodexTmuxAdapter` 复用 FLY-2903 同一终止/retirement predicate，供 restart 与 native spawn 两入口使用。所有测试注入的身份回调改为 await。
- 本小批没有接入持久化 owner 表/OS accepted binding，不能把该 hook 宣称为已完成的 generation/spawn CAS，也不宣称 Heartbeat 已去除窗口判死。

红绿记录：

| 测试文件 | 新断言 | RED 结果 | 同一断言 GREEN |
|---|---:|---|---|
| codex-daemon-runtime.test.ts | 6 | 未接受身份即准入；拒绝 Promise 被忽略；撤销许可仍出生；identity await 中 close 未挡准入 | 6 pass |
| codex-daemon-goal-runtime.test.ts | 2 | stop/owner revoked 的低层预检空窗仍执行 native spawn | 2 pass |
| CodexTmuxAdapter.test.ts | 2 | terminate/retirement 未提供物理启动 predicate | 2 pass |

中间修正过测试 fake child 的 exit 事件模型；仅将正确事件模型下的行为断言失败计作 RED，不将 fixture 超时计作产品失败。

## 本小批验证

消费者扫描使用每个改动 TS 的完整路径、文件名、父目录逐一 `git grep -lF`，另补 basename stem 捕获 `.js` 导入。462 个匹配及逐文件排除理由保存在 `implementation-a-consumers.json.gz`；该清单只是本小批，后续必须随新增变更重新扫描。

- owning `vitest related src/codex-daemon-runtime.ts src/codex-daemon-goal-runtime.ts src/CodexTmuxAdapter.ts --run`：7 文件、394 pass、2 skip。显式排除 plan 禁止的 `tmux-viewer.macos.test.ts`，以及已实际运行失败的两个 FLY-2830 real-ps case。
- 原始两文件回归：183 pass，2 个 FLY-2830 fixture 在 `ownPgid` 的 `execFileSync("ps", ...)` 遭 `EPERM`。没有改测试或把这两项称为通过。
- FLY-2211 kill-path inventory + codex-sync-timeout：2 文件、7 pass；未弱化或改写清单。
- launch-claim-durable + FLY-1560：2 文件、14 pass；child-process-census 初次在 5s 限制超时，未改限额，独立复跑 1 pass。
- run-infra-memory-distill：1 文件、2 pass。
- `pnpm lint` exit 0，5102 文件、25 个现有 warnings；未修改无关文件。
- `pnpm install --frozen-lockfile` 成功；缺失 dist 的依赖通过相应 package/dependency build 补齐。最终 `pnpm --filter "flywheel-claude-runner..." build` exit 0；`pnpm --filter "...flywheel-claude-runner" typecheck` 四包（claude-runner、edge-worker、teamlead、voice-codex）全部 exit 0。
- `node --test scripts/__tests__/qa-fly-2456-liveness.test.mjs` 原样及环境明确的复跑均未通过：首次真实 socket holder 的 lsof 超时，复跑 holderError=EPERM，均返回 unknown；另有继承 shell 初始化诊断。没有改探针来伪造 alive。临时 fixture 由既有 after hook 收回；需 QA 在 529 重验。

日志保留于该执行本机 `/tmp/fly2919-a*.log`（RED 分别为 a1/a2/a3-red；不作为永久唯一证据）。必要原始结果及六个源码/测试文件的内容 SHA 已归档至 `implementation-a-evidence.json.gz`。

## 下一步

继续 A：持久化 execution_process_owner、accepted OS binding、ownerToken/generation/spawnEpoch CAS、统一进程证据、Claude/Kimi/Antigravity 启动绑定与旧体迁移。然后执行 B–F 原计划、九单 before/after、删除清单、完整相关验证、有效 code review、PR 与 needs_review 路由。529 真机验收由独立 QA 节点补齐。


## 续接 A 第二小批（2026-09-26，执行 7b52a229）

本执行从 `913ee5b3e` 接续；TURN implement epoch 9，activation `activation:7b52a229-6638-4b36-9115-cd8f5383b204:2464497b-d2bf-4c64-93c9-be124e234164:implement:1`。设计账本曾回到 design 5/5；本执行核验有效 APPROVED 后恢复 implement 0/6，保留全部批准文档。`241e6b439` 的 owner-store/registry WIP 原样继承并补验，未把它当作已经完成的 A 组。

已完成的边界修正：

- `ExecutionProcessOwnerStore.authorizeSpawn` 拒绝 spawn_epoch=0 的纯 owner claim。继承 WIP 的对应断言实测 RED（返回 true），修后 GREEN。
- `recordDrained` 在核对当前 owner/generation/spawnEpoch/controller/binding 后先查已提交回执，再对首次提交执行证据时效检查。新增关闭重开数据库、60 秒后重放及外来 owner 负控；RED 为 drain_evidence_expired，修后 GREEN。这只解决 owner drain 回执重放，**不代表 C 组跨库死亡义务已落实**。
- `CodexDaemonGoalRuntime` 扩展 FLY-2903 同一 restart gate 为可等待、可幂等重核的 predicate，在 kill/drain 前进入，drain 后重核；两次 await 后均检查 stop。没有新增独立 restart gate，也没有关掉正常同线程重启。
- 两条红测证明等待 gate 前不得先拆 daemon、等待中 stop 不得产生第二 writer；另加 drain 内撤权负控，抓到早移 gate 后仍可能重启的回归，并保留原 post-drain fence。原第二次 transport death 拒绝测试按真实 spawn 次数判断撤权，避免依赖 predicate 被调用几次。

本批仅 owner 基础与 runtime 边界，**尚无 production owner-store 调用、OS binding 接纳或 BodyObservation 接线**。所有九单生产路径仍待 B–F 收敛；没有 PR、代码审查或 handoff 完成声明。

### 本轮追加义务跟踪

| 义务 | 当前证据 / 尚需工作 |
|---|---|
| death-before-pending-complete-marker | 待 B/C：死亡提交前先对账 marker；必须有真实完成不被判死红绿证据 |
| codex-reown-revive-precedence | 本轮保留并运行 reown 两文件回归；recovery_active/unknown 的统一探测尚待 A/B |
| obligation-replay-evidence-expiry | owner drain 重放已补；C 组 CommDB obligation 幂等与过期顺序仍待实现 |
| lease-contention-refuses-normal-restart | WIP 使用短同步事务，测试保留 lease_held 后可重试；runtime gate 现可 await；Bridge 有界重试尚未接线 |
| no-runtime-kill-switch | 待 feature registry、codec、store wrapper 与全部死亡消费者动态读取 |
| consumer-inventory-direct-importers | 本批源码消费者扫描归档；全仓五探针及每个状态写入口处置仍待 B–F |
| fly2903-sweep-and-restart-gate-unmapped | 已扩展并重核原 restart gate；terminal sweep 的 BodyObservation 接线仍待 B/E |
| claude-process-title-identity | 待 A：exec 前 PID/start 登记与独立 executable path 核验，不依赖改写后的 argv |
| standby-retirement-window-proof | 待 A/E：writer 集合为空的 BodyObservation 与负控 |
| probe-cadence-heartbeat-5min | 待 A/B：独立或按需采样，以及延迟上界测试 |
| LOW follow-ups | 保留 founder wake 后继交代、未跑真机项，最终 PR 单列 |

### 验证范围与暂存日志

锁定依赖安装成功；先前 vitest 缺失、依赖 dist 缺失都是 preflight，不计行为 RED。当前批次日志 `/tmp/fly2919-owner-*`、`/tmp/fly2919-restart-*`、`/tmp/fly2919-a2-*`，最终命令结果与源码 hash 将归档到 `implementation-a2-evidence.json.gz`。

消费者清单 `implementation-a2-consumers.json.gz` 用四个改动/继承源文件的 full path、basename、parent directory、stem 执行 git grep -lF，逐路径标注保留/排除原因。它是本小批清单，不替代最终九单消费者处置表。StateStore 是枢纽：按批准计划不扩张成本地整包，相关调用使用临时 include 配置只运行 owner fixtures；StateStore 原迁移套件、FLY-1560 与 reown 单独保留。第一次未限定的 related 调用已停止，无测试结果，不计通过。

真实 `ps` fixture 两项仍被 sandbox EPERM 拒绝，保留原测试交 529 重验；后续 scoped related 明确仅排除这两项和批准计划禁止的 tmux-viewer.macos。并行构建期间 async-exec-file 的 500ms stdin 用例超时，后续未改限额复跑通过；最终结果以本节后续记录和归档为准。


本批已确认结果（源码对应归档 SHA，不代表整个任务完成）：

- Owner 原红测：27 项中 2 fail / 25 pass；相同文件 GREEN 27 pass，限定 related 重跑 27 pass。
- Runtime gate 新增两个等待边界 RED；drain 内撤权负控另一次 RED；最终 owning related 7 文件 **413 pass / 2 skip**，包含 runtime 61 项以及 adapter、ownership、exports 和 async subprocess 直接消费者。
- `StateStore.test.ts` + FLY-1560 guard：2 文件 **111 pass**（含旧表迁移）。
- `codex-session-reown*.test.ts`：2 文件 **63 pass**。
- `codex-execution-ownership.test.ts` + FLY-2211 kill-path inventory：2 文件 **25 pass**。
- retention registry + FLY-2567 compatibility drift：2 文件 **53 pass**；未弱化 guard 或更新无关 digest。
- `pnpm --filter "flywheel-teamlead..." build` exit 0；最后一次 runtime 撤权修正后再跑 `pnpm --filter "flywheel-claude-runner..." build` exit 0。
- `pnpm lint` exit 0：5105 文件，25 个现有 warning；未修无关文件。

下一批仍从 A 继续：生产 owner 登记与 awaited binding、实际 native-spawn permit CAS 和 lease_held 有界重试、所有 adapter OS 身份与 writer 集合、单一 BodyObservation。之后逐组 B–F；C 组死亡义务重放与 HIGH complete marker 不变式尚未完成。不得从当前绿色测试推断 Heartbeat 已去除窗口判死。

- 依赖方类型检查：`pnpm --filter "...flywheel-claude-runner" typecheck` 中 claude-runner、edge-worker、teamlead 通过；voice-codex 因 voice-bridge dist 缺失失败。补 `pnpm --filter "flywheel-voice-bridge..." build` 后，`pnpm --filter flywheel-voice-codex typecheck` exit 0。四个依赖方均已验证，未修改 voice 业务代码。


## 续接 A 第三小批（2026-09-26，执行 7b52a229）

本批仍执行批准 A 组，未改产品设计。新增下层 `BodyObservation`、独立 OS 采样与 native spawn permit 的等待边界；尚未把生产 owner 登记与 Heartbeat/双库消费者接上。不能将本批下层 fixture 当作九单生产验收。

- `execution-process-liveness.ts` 不接收窗口或 workflow status 作为判生死输入。身份绑定 execution/activation/generation/revision/ownerToken/spawnEpoch/digest；采样最多 5 秒，观察有效 10 秒，CAS 消费前用 `isCurrentBodyObservation` 重核全部字段与时效。四种现有 adapter 都有 live/dead/unknown fixture；PID/start/boot 冲突、缺绑定、控制器仍活、spawn/restart/reown 有效、残留 writer 均不授权死亡。
- writer 核验包含原组成员、已接受 writer 和本次独立 nonce 归属发现的 detached writer。父进程死亡或被收养不等于 writer 消失；PID 重用拒绝；zombie 不算可写活进程。只有精确登记的纯 viewer 可排除，已绑定或继承 nonce 的 writer 不得降格成 viewer。
- `execution-process-inspector.ts` 读 OS PID/start/boot、macOS lsof txt/cwd 或 Linux /proc executable/cwd；不从改写后的 argv 推断 executable。nonce 环境归属使用前后稳定 argv 与环境快照，argv 中伪造 nonce 不算环境。复用 Codex daemon/group/socket 探针并注入预采集证据，旧 group ledger 缺失或 PGID 不匹配保持 unknown。每个命令共享递减的 5 秒预算，权限/解析/超时失败关闭；只取消自己创建的 probe child，等 close 才结束，不向目标 worker 发信号。
- FLY-2211 inventory 按已有 bounded_child 形状只增该精确 child.kill 调用及源码形状约束，保留 runner-affecting 分类、其余审计 predicate 和限额。没有新增通用免责。
- `prepareSpawn` 经 runGoal 的每次初启/同线程重启传到低层，在异步 socket 预检后等待持久 permit 获取，随后现有同步 `authorizeSpawn` 紧接 native spawn 再核验。获取拒绝转为安全的 owner_admission_failed，释放原 socket 锁；等待期间撤权不启动 worker。这只是调用钩子，Bridge 的实际 owner CAS 和 lease_held 有界重试仍待接线。

红绿记录（详细日志及源码 hashes 归档 `implementation-a3-evidence.json.gz`）：

| 边界 | RED | GREEN |
|---|---|---|
| 基础物理 verdict | 27 fail / 7 pass | 34 pass |
| 时间有效性与消费者身份复核 | 13 fail / 35 pass | 48 pass |
| 本次发现的 detached writer | 3 fail / 48 pass | 51 pass |
| 独立 inspector 身份复核、解析 | 2 fail / 20 pass；1 fail / 21 pass | 22 pass |
| nonce viewer 负控与清理登记 | 3 fail / 25 pass | inspector + inventory 28 pass |
| 预检后的 permit 获取、拒绝/撤权 | 3 fail | 3 pass |
| 初启及同线程重启均获取 permit | 1 fail | 1 pass |

测试 fixture 曾因未设置 fake socketExists 进入长轮询，已停止并修正 fixture；该中断不计产品 RED，表中只计修正后真实行为断言失败。

本批消费者清单 `implementation-a3-consumers.json.gz` 按五个源文件 full path/basename/parent/stem 的 git grep -lF 逐路径登记，含新文件补项共 3464 条。宽 src 目录和通用 index 名称命中逐项标明排除理由，直接调用测试与 FLY-2211/child census/reown 保留。没有新 scripts/__tests__/*.test.sh。

已确认 owning related 9 文件 **475 pass / 2 skip**，只排除批准计划禁止的 macOS viewer 测试和此前已证实 EPERM 的两个 real-ps fixture。后者及 qa-fly-2456-liveness 真机项仍交 QA529，不算通过。当前 Inspector Mac/Linux 都是注入式 OS fixture，未冒充真机证明。

Teamlead retained guards 四文件 **71 pass**（reown 63、launch claim 7、child process census 1）。依赖方四包 typecheck 均通过。lint 首次发现新文件导入排序/控制字符正则写法四项错误，修正后通过（5109 文件、25 个既有 warnings）。清理 inventory 一次在并行检查期间超过原 15 秒限额，保留失败记录并单独复跑，未改测试限额。

下一步仍为 A 的生产 owner/accepted OS binding/实际 spawn CAS 与 lease 重试、Claude/Kimi/Antigravity 注册与旧体迁移、runtime flag；随后按 B–F 完成所有消费者。HIGH pending-complete-marker、跨库义务幂等、standby 空 writer 证明、独立采样周期和九单生产验收尚待实现。

本小批最终：独立复跑 inspector/kill inventory/sync-timeout 三文件 **30 pass**，原限额未改；最终 `pnpm --filter "flywheel-claude-runner..." build` exit 0。所有本批红绿/失败后复跑日志及 11 个源码、测试、inventory 文件 hash 已归档；没有请求 full CI、代码 review、PR 或 needs_review，任务仍在 implement 0/6。


## 续接 A 第四小批（2026-09-26，执行 7b52a229）

本批接通 Codex 生产 owner，仍为 A 部分实现，B–F 和九单验收未完成。未请求 full CI、代码评审、PR、QA 或 needs_review。

- `run-infra.ts` 将 `createExecutionProcessOwnerFactory` 注入现有 dispatch/rescue adapter factory；沿用现有 execution registry 的同一个 token。启动前取得 OS controller PID/start/boot 和同步 owner CAS，每次 spawn 必须 prepare/authorize；native spawn 使用任务 cwd。没有把 Bridge 的 cwd 当作 worker cwd。
- `CodexTmuxAdapter` 把每 owner nonce 传给 daemon；先保留原 PGID/session 登记，再 await 独立 binding 接纳。`execution-process-inspector` 允许 wrapper fork 的同 PGID native worker，但只有唯一 executable/cwd/boot/nonce/socket 一致的 worker 可接纳。nonceWriters 单独证明环境归属，不能用普通组成员冒充；不读 ps argv 判 executable。
- runGoal 原 restartGate 内先检查已有停止/退役边界，再 await owner beginRestart，并在等待后复核。close 在 cooperative stop 前持久撤权，runtime.drained 后独立查清 group/writer 再写 receipt；TUI 清理未 join 时，沿已有 ownershipHeldUntil 保留 registry 至清理及 owner finish 都结束。不会凭 socket 消失直接铸 owner drain receipt。
- 共享 Bridge controller 仍活但当前 owner 已持久 close，且 spawn 已结清、worker/writers 均空时允许收尾。`ownerClosed` 不覆盖 spawnInflight、不把活 worker 判死。缺失/未知 binding、残留 writer 和身份变化均拒绝 receipt。
- 所有 OS await 都在 mutation lease 外；lease_held 按 25/50/100/200ms 有界重试（共最多 5 次），语义拒绝不重试。已结账 owner receipt 按身份先查幂等，再看证据期限，因此 60 秒后重放不会撞 10 秒有效期。跨 CommDB 的义务幂等仍待 C。

### Lead 恢复裁定与落实

问题 `d5574ed6-2a34-4296-b87f-2b7ba3bdeb42` 的有效答复批准：有效 recovery claim 作为独立受信授权；旧 controller/daemon/writers 经 OS 证明清空后，同 generation 新 owner token 可接纳，spawnEpoch 单调前进，不耗 fault-replacement 预算、不铸替身；保留原 reown 预算和耗尽告警。

实现于 `ExecutionProcessOwnerStore.claim/mutate` 和 `execution-process-controller.ts`：同代换 owner 必须同时匹配未过期 claim、lifecycle revision、旧 owner/epoch/binding digest、旧 drain receipt。复用已有 recovery reservation 内的短同步 CAS，不另取同表 lease；不提交、不替换原 recovery claim。原 recovery commit 完成后 controller 识别同一 episode 已关闭与 revision 前进，后续正常 restart 回到普通 mutation lane。失效/过期 claim、旧 writer 仍在、binding 不符、普通 dispatch 试图同代接纳全部拒绝。没有改 CodexSessionReowner 的预算或 FLY-2921 的替身协调器。

### 红绿及限定回归

| 边界 | RED | GREEN |
|---|---|---|
| adapter owner 接线/收尾 | 新行为断言红；close 等待竞态另一次 1 fail/13 pass；dispatch kind 1 fail | adapter 全文件 190 pass；最终 owning related 包含全部 |
| daemon 使用任务 cwd | 1 fail | 1 pass |
| 唯一 native group/nonce 接纳 | 2 fail/5 pass | 7 pass |
| 生产 controller CAS/采样/收尾 | 10 fail | 10 pass |
| 同代 reown 精确授权 | Store 与 controller 各 1 fail；首次修正后暴露自持 lease_held，保留失败日志 | owner/controller 合计 47 pass；恢复 commit 后正常 restart 另补 1 pass |
| durable close 后共享 controller 不阻止空 writer 收尾 | 1 fail | 1 pass |
| run-infra 生产 factory 注入 | 1 fail | 1 pass |
| nonce 配置分类 | drift guard 2 fail | truth/drift 57 pass；最终限定 related 134 pass |

`NON_FLAG_ALLOWLIST` 新增 FLYWHEEL_EXECUTION_NONCE 原因：每 owner 的进程归属身份，不是行为开关。此条不替代待实现的运行时死亡授权 flag。限定 config related 发现未改动的 registry 已有 37 项，而 founder-copy 测试仍期待 36；仅把固定数量校正为 37，保留完整 EXPECTED_WHEN_ON 等值比对与作者约束。未放宽 predicate。

最终相关结果：runner owning related 9 文件 **496 pass / 2 skip**；teamlead owning related 5 文件 **109 pass**；直接 run-infra/调度消费者 11 文件 **138 pass**；StateStore 原迁移/retention/FLY-2567/child census/reown wiring 5 文件 **169 pass**；FLY-1560 **7 pass**；kill inventory/sync timeout/Kimi registry 3 文件 **10 pass**；edge catchall **8 pass**；限定 config related 6 文件 **134 pass**。shell `codex-guard.test.sh` **49 pass**，`check-flag-truth.test.sh` **3 pass**。

`pnpm --filter "flywheel-teamlead..." build` 通过；依赖方 runner/edge/teamlead/voice-codex 四包 typecheck 通过；`pnpm lint` 通过，25 个既有 warning。测试是局部证据，非 full CI / QA / 生产证明。保留两个真实 ps fixture 的 sandbox EPERM 排除与 macOS viewer 限制，交 QA529；没有改变测试超时。一次未限定 config related 因 barrel 扩到无关 ConfigLoader 等测试而中断，不作为通过证据，随后采用六个直接 truth/registry 文件 include 配置重跑。

消费者归档 `implementation-a4-consumers.json.gz` 按 full path/basename/parent/stem 搜索，4370 路径逐项标处置；新增源码和直接测试补入记录。日志与源码 hash 为 `implementation-a4-evidence.json.gz`。这只是 A4 消费者检索，不替代最终五探针全仓死亡写入点清单。

### 仍需继续的已知边界

1. 失败/中断 native spawn 未接纳 binding 时，spawnInflight 保持 unknown；必须取得在途 newborn 的物理清空证明才能结账，不能直接清标记。
2. Claude/Kimi/Antigravity 的 exec 前 PID/start/boot 登记、真实 executable 与 native session 独立核验，以及旧体唯一匹配迁移尚未接线。现在不能声称四载体生产完成。
3. 生死统一服务、运行时 kill switch、独立采样周期、所有直接 probe 消费者、HIGH pending complete-failed marker 优先对账、跨库义务重放、standby writer-empty、terminal sweep 仍待 A 后续和 B–F。
4. 九单复现/删除分支清单、最终评审、PR 与注册交卷 route 均未完成。保持 implement 0/6。


## 续接 A 第五小批（2026-09-26，执行 7b52a229）

A4 代码 `7bad9acc8`、进度 `0cb9629b8` 已推送。A5 继续批准 A 组，尚未完成其他载体生产 factory、旧体迁移、runtime flag 或 B–F。

### Codex 未完成启动的物理收尾

新增独立 `capturePendingExecutionSpawnAbsence`，输入是实际在途许可的 nonce、已知 child PGID（未生成 child 为 null）、host boot；不伪造 native accepted binding。它在共同 5 秒预算内做稳定 census、argv 前后夹取环境 nonce、socket 和 boot 复核。组内活进程、脱组 nonce writer、不可核环境、活 socket、boot 变化均不授权结账；argv 中伪造 nonce 不冒充环境。

Owner 持久保存 spawn_nonce/pending_pgid/binding_spawn_epoch；兼容旧表增加列时不补造 nonce，对已接纳且无在途的旧绑定回填原 epoch。未解决的旧在途记录仍 unknown。先登记实际 child group，再等待 native binding；接纳时同时核 nonce/group。重启时上一轮 binding 按自己的 epoch 校验保存，不能拿它冒充新 spawn。失败收尾分别核实上一轮 accepted writer 集合与新许可的 nonce/group/socket，所有证据确认后在短同步 CAS 中原子清 in-flight 并写 exact owner receipt。普通 recordDrained 仍拒绝 in-flight。相同已提交 receipt 的重放先核身份，再看期限；过 10 秒不会重复结账。

额外复现了采样期间 session revision 变化：最初只 mock getSession 会被原 mutation lease 拒绝，属于无效 RED；改为真实 upsertSession 推进 revision 后两例确实 RED。修正固定采样前 revision 到最终 CAS，accepted/pending 两条收尾路径均拒旧证据。原 mock 通过日志保留，不计红测。

### 三个 tmux 载体的共用候选登记钩子

`TmuxAdapter` 新增 optional TmuxProcessLaunchDeps，由 Kimi/Antigravity 同样转发。配置时：先 prepare permit，最终 exec 的同一 shell 以显式 `$$` 生成候选，验证 PID/start/boot/独立 PGID/cwd；shell executable 明确只是候选，不能当 native 身份。要求 PID==PGID 且不同于 tmux server；不读取 pane PID。

候选处于现有每执行隔离目录，0600 临时写+fsync+rename，读上限 16 KiB、不跟随文件 symlink；失败清理临时文件。cwd realpath，helper 同样走正向环境白名单。Bridge 的注入式 acceptSpawn(candidate) 完成前，不发 native identity/startup 通知或首心跳；撤权、取消、接纳失败执行 close/cleanup/finish，不能把 finish 未确认包装成成功。未配置 deps 保留 legacy 行为。

这只是共用启动钩子；Claude/Kimi/Antigravity 的独立 native executable/session 核验与生产 factory 尚待下一批，不能据 mock lease 测试宣称其生产登记完成。特别是 Claude 标题会改写、Kimi 为 Node CLI，需要沿批准计划接独立 executable 与真实原生会话参数，不用 argv 标题猜身份。

### 本批红绿与测试政策

- failed-spawn census 8 RED → 8 GREEN；inspector 全文件 38 pass，既有 liveness 52 pass。
- owner nonce/group 持久化与前一 epoch 两例 RED → 当时 owner 34 pass；外来 nonce/group 另 1 RED；加入旧表迁移后 owner 36 pass。
- controller failed-native 四例 RED；真实 revision 变化两例 RED → 最终 controller 21 pass。
- tmux 新候选/门控基础红绿，后补身份发布/收尾失败 2 RED → adapter 新文件 11 pass；manifest 5 pass。三 adapter 直接兼容、registry、defaultExec 共 7 个显式文件 239 pass。
- StateStore 全文件 104 pass；先前并行时 3 个 5 秒超时，保留失败日志，未调整限额，逐文件重跑通过。FLY-1560 7、retention 36、FLY-2567 17 均通过。
- FLY-2211 首轮发现新增测试一条 qa-only kill-window inventory hit，另一个 guard 在重载时超过原 15 秒限额。仅登记该精确 qa-only 条目，未改其他分类/断言/限额；独立复跑 5 pass。

本轮收到 Contract v4 后，后续显式测试改为一次一个具体文件；完整 local-test-policy/v1 已同步正在执行的子任务。此前多文件命令是政策更新前的具名相关文件选择，不是整包测试。owning related 仍额外执行，teamlead 按六个直接消费者的 include 配置选择，5 文件 119 pass。原两项真实 ps fixture 的 sandbox EPERM 与禁止的 macOS viewer 继续交 QA529，不算通过。没有新 shell 测试。

本批证据/完整消费者检索将归档到 implementation-a5-evidence.json.gz 与 implementation-a5-consumers.json.gz。最终 build/lint/related/依赖类型检查结果在下方补记；在通过前不宣称本批验证完成。任务仍 implement 0/6，HIGH completion marker、跨库重放、死亡消费者、采样节奏和九单验收未完成。


A5 验证续记：lint 通过（5115 文件，25 个既有 warning）；Codex adapter 显式 190 pass、同步 timeout guard 2 pass。统一 runner related 因 TmuxAdapter 导入链带入 real-tmux 项而停止，保留其超时/失败日志，不计为本批通过或 529 验收；改用 /tmp/fly2919-a5-runner-related.config.mts 的 16 个明确相关单元文件待重跑。该次 async stdin 500ms 和 TUI timeout 负控也出现失败，必须按原限额独立复核。child census 与 flag drift 各一个原 5 秒超时也待重跑，不修改断言。

2026-09-26 19:22Z 本机 uptime 显示 load averages 131.82/122.70/136.36（73 users）。已减少并发，没有触碰其他执行或服务。A5 作为 WIP 保全：teamlead... build 仍在 tsc（tool session 44125），flag drift 单文件重跑仍在采集（54600）。源码已冻结，后继先收这两个任务结果，再完成 bounded runner related、child census、async/TUI 复核、repo-fable argv 直接消费者和导出依赖 typecheck；不能将 WIP 当绿头或请求交卷。临时配置和命令日志同时归档供重启恢复。
