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


### A5 定向复核收尾（2026-09-26 19:40Z）

前述 pending build（44125）与 flag drift（54600）均已 exit 0：受影响 teamlead 加依赖构建通过、flag drift 14 pass；导出依赖 runner/edge/teamlead/voice-codex 四包 typecheck 通过。child-process census 1 pass、repo-fable argv 直接消费者 3 pass。

限定16个单元文件 include 的 runner related 实际选中13文件：679 pass、2个既定 sandbox skip、1个原5秒 shell gate timeout；该 related 命令不是全绿。原源码/原限额独立复跑 TmuxAdapter.test.ts 得187 pass，其中同一 shell gate 2.413秒通过。此前 async stdin 与 TUI timeout 负控在这次 bounded related 中通过。没有再跑 real-tmux，没有增加超时或改断言。此前失败日志与最终结果都已更新进 implementation-a5-evidence.json.gz。

这关闭 A5 WIP 的待收结果，仍只是 A 的局部证据；生产 Tmux factory/native session 核验、旧体补采、开关、B–F 与九单验收均未完成。当前先落实 Lead HIGH 的 complete marker 优先不变式：Heartbeat 与 crash-reaper 跨 await 后必须先对账，未知/held 阻止死亡，最终 CAS 前同步检查。后续新 BodyObservation 死亡收敛同样必须消费此守卫，不能以当前两个消费者覆盖声称 HIGH 已全完成。


## 续接 B1/B2 验证与 A6 观测入口（2026-09-26，执行 b3d59196）

继承 `a84a07854`，TURN implement epoch 11。完整 A–F 和九单范围不变。

### B1/B2 继承验证

锁文件安装恢复缺失的 node_modules；首次 build 的缺依赖错误属于 preflight，不是产品 RED。继承源码未修改，24 个具体测试文件逐一执行，**392 pass**；包含 HIGH marker 的 Heartbeat/crash 保护、真实 /events 重放（9 pass）、两份 reown 回归（64 pass）以及 FLY-1560。逐查询消费者和逐文件排除理由见 `implementation-b1-consumers.json.gz`。此批没有改变 StateStore/CommDB 表或新增 kill 操作；对应迁移与 kill inventory 的既有 A5 证据不冒充本轮重跑。

### A6 当前身份与 OS 观测的衔接

新增 `execution-body-liveness.ts`，只组装接受过的 owner/binding 与既有独立 OS sampler，不写生命周期、不创建替身，也不从 pane、heartbeat 或业务停驻状态推导生死。采样前后核验 activation/generation/revision/owner/spawn epoch/binding；在同步消费入口再次核验身份、10 秒期限、spawn/restart/recovery 和动态开关。相同身份只共享正在进行的采样，不缓存完成的观测；缺身份不返回死亡证据，OS 读取失败为 unknown。

20 项新入口断言在 API scaffold 上全部 RED，最小实现后同一文件 20 GREEN；这是新入口的 TDD 记录，**不是九张原现象的 before/after 验收**。覆盖五种账面状态不能否决可靠死亡、活 worker 无窗口依赖、六类采样中身份变化、采样及消费期间开关变化、恢复/重启/在途启动优先、到期和并发采样。保留 controller 21 pass、纯进程证据 52 pass。

B1/B2 + A6 owning related 使用25个明确相关文件的 include 上界，实际选择12文件、**203 pass**；不是全包测试。最终 `pnpm --filter "flywheel-teamlead..." build` exit 0；`pnpm lint` exit 0（5119文件、25个既有 warnings）。没有改公开包导出；类型验证由受影响包加依赖构建覆盖。没有新增 shell 测试。源码 SHA256、完整命令日志与 related 配置归档 `implementation-b1-a6-evidence.json.gz`。

### 仍未完成，下一批必须接上

此入口当前尚无生产消费者，`isEnabled` / `isRecoveryActive` 是必须提供且读取失败保护的内部回调；**不是 feature registry 开关已落实或 reown 预算策略已接线的声明**。运行时 registry/wrapper、独立采样周期与公平预算、三种 Tmux 载体生产 factory/native 身份核验、旧体迁移、B–F 死亡消费者及双库义务、standby writer-empty、九单证据、评审/PR/CI/route 仍待完成。HIGH marker 守卫后续仍须进入新死亡事务，不能以现有两个消费者覆盖宣称全部完成。

全仓五类探针当前343处引用、31个非测试源文件的原始基线见 `implementation-probe-inventory-baseline.json.gz`；记录仍标未处置，不是最终消费者扫尾通过。源码核实 started-evidence 的无窗→未启动、worktree-reconciler 的 lookup gone→dead、lifecycle-sweep 的工作树删除准入仍依赖这些窗口结果，必须随 B/C/E/F 一起迁移。FLY-2921 继续拥有铸替身协调，不在本批新增平行协调器。

没有请求 full CI、代码评审、PR、QA529 或 needs_review，仍为 implement 0/6。


## A7 运行时死亡授权开关（2026-09-26，执行 b3d59196）

按现有 flag-authoring-runbook 落实 `execution_body_death_enabled`：bridge_global、default-on、store codec、命名 wrapper `storeExecutionBodyDeathEnabled`、精确 delegated/call_time read site。`createStoredExecutionBodyObserver` 在每次使用时读取同一个 store runtime，不缓存 bool；采样返回后和同步消费前再读，关闭/读取失败只返回 unknown 或拒绝消费，不回落到窗口判死。registry 的新 whenOn 和精确条目数37→38同步加入守卫，未改成宽松断言。

红绿：registry/codec 缺失2 RED；store wrapper 缺失1 RED（另39原回归通过）；实现后对应2/40 GREEN。原观测入口20项改走真实命名 flag wrapper 与 codec 路径，继续20 GREEN，其中采样中关闭、消费前关闭及随后重新启用均验证。store runtime 文件用真实 StateStore 热写证明；flag-routes 35项包含对每个 bridge-global flag 的实际 stage/apply/读取 round trip，新 flag 自动纳入。

本批显式定向18文件、391 pass（config10/235，teamlead8/156）；owning related config8文件184 pass、teamlead3文件95 pass。保留 `fly2102-flag-freeze.test.sh` 独立执行40 pass；build（teamlead及依赖）与 lint均exit0，25个既有warnings。首次registry守卫只因未同步精确数量37→38失败，原失败与后续通过都归档；没有扩大本机测试到整包。消费者/排除清单见 `implementation-a7-consumers.json.gz`，源码hash/完整日志/related配置见 `implementation-a7-evidence.json.gz`。

此批完成的是registry→store→新观测工厂的动态开关链，**尚未将全部生产死亡消费者迁入该工厂**，因此 Lead 的 no-runtime-kill-switch 义务仍须在 B–F 末尾逐消费者证明。新死亡提交应受开关控制，已提交跨库义务的幂等重放不得被开关卡住（C组仍待实现）。

下一步继续批准范围：三种Tmux载体生产绑定与旧体补采、统一观测的生产接线及reown预算优先、独立公平采样节奏、死亡CAS与marker优先/双库义务、其余B–F消费者和九单矩阵。任务仍implement 0/6；没有PR、有效代码评审、full CI、QA529或交卷完成声明。

## A8 启动身份接纳前置（2026-09-26，执行 7d99e8e8）

本轮从 `583b9e6d0`、TURN implement epoch 13 续接；A7 已提交推送，未重做设计或重复已完成的 B1/B2 验证。仍保留 A–F 和九单全范围，以下仅为 A 的一个必要前置批次。

新增 `expectedLeader` 的独立 OS 接纳约束：Tmux 最终 exec 必须延续登记的 PID/start/boot，不允许仅因为同组里存在另一个相同 executable 就接纳。Codex 原有可 fork 的 group 接纳路径不要求这个可选约束。采样中更换 PID 身份仍拒绝，接纳 binding 不携带临时 expectedLeader 字段。

登记 helper 现在接收同一个 shell 将传给 exec 的实际位置参数；写候选之前核对 binary 与 Claude 的唯一精确 `--session-id`/`--resume` 参数（也支持等号形式），不从改写后的 ps 标题恢复 session。Kimi/Antigravity 不要求不存在的 Claude session 参数。参数仍作为数据转发，没有写入候选文件或日志。登记是未受信候选，不能代替生产 factory 的独立 executable/cwd/nonce/身份复核。

红绿证据：同组其他 PID、PID/start 复用、host boot 不同三项因旧 binder 错误接纳而 RED，修正后 inspector 文件 43 pass；实际参数的 binary/session 缺失、重复、前缀、`--` 后伪装等六项 RED，修正后 launch 文件 14 pass。真实 `/bin/sh` + 临时 helper 测试原本只能读到空参数数组（RED），修后完整位置参数逐字匹配，`$(literal)` 不执行，登记 shell PID 与最终 exec 后程序 PID 相同（GREEN）；adapter 文件 12 pass。

验证：16 个具体文件逐一运行，397 pass；owner controller、FLY-1560、child census、FLY-2211 kill inventory 和运行时 flag drift 守卫均保留。限定 11 个已发现单元文件的 owning runner `vitest related` 实际选择 8 文件，292 pass。`pnpm --filter "flywheel-teamlead..." build` 与 `pnpm lint` exit 0（25 个既有 warning）。voice-codex 类型检查首次因 voice-bridge dist 缺失失败，补建 `flywheel-voice-codex^...` 依赖后同一 typecheck exit 0；不计为产品 RED。未新增 shell 测试文件，新增真实 shell fixture 位于上述 adapter vitest 文件。真实 tmux/viewer 验证仍归 QA529，未以 mock 代替。

**未完成的生产接线：**`expectedLeader` 目前尚无生产调用方；三载体的 `processLaunchDeps` 仍未由 run-infra factory 注入。后续需要按本机已核实的真实 binary 形态处理独立 executable：Claude 与 agy 是 native executable，Kimi 当前安装为带绝对 Node interpreter shebang 的脚本。不能将 Kimi 的脚本路径直接与 OS 的 Node executable 比较，也不能因此永久返回 unknown。生产 factory 还须把 trusted request 与候选逐字段匹配，将登记 identity 传入 expectedLeader，核验 executable/cwd/nonce 后持久接纳；旧体补采仍待实现。

B–F 的共同观测生产接线、reown 预算优先、独立公平采样、marker-first 死亡 CAS、双库义务重放、全部消费者迁移、standby writer-empty、九单验收、有效代码评审/PR/full CI/QA529/needs_review 均未完成。保持 implement 0/6；本批不能作为生产故障已修复的声明。

本批完整逐查询消费者匹配与逐文件排除理由归档 `implementation-a8-consumers.json.gz`；红绿日志、显式/related 命令、配置和最终源码 SHA256 归档 `implementation-a8-evidence.json.gz`。所有 16 个选择文件 exit 0；所有匹配测试均有保留或排除处置。

## A9 三载体生产绑定接线（2026-09-26，执行 7d99e8e8）

续接 `2bc0af382`，TURN implement epoch 13。统一使用现有 ExecutionProcessOwnerStore 与同步 mutation CAS，没有新增一套 owner 表/死亡缓存或替身协调器。

`createTmuxProcessLaunchDeps` 已在 `setupRunInfrastructure → createRunBlueprint → registerTmuxRunAdapterFactories` 注入 Claude/Kimi/Antigravity；每次 registry.get 仍创建独立 adapter 实例。factory 在 claim 前独立解析 native executable 与 canonical cwd，生成本次 owner token/nonce，将它自己持有的完整 request 与候选逐字段比对，然后把登记 PID/start/boot 传给 A8 的 expectedLeader。只有真实 native executable/cwd/nonce/原进程身份核验通过才接受 binding；参数不匹配时保留在途资格，不能补造 drain。派生 adapter 共享 TmuxAdapter 的 gate、接纳和收尾钩子。

TmuxAdapter 将已核验的绝对启动路径与固定 PATH 用于候选和真实 pane exec；这避免 tmux server 的旧 PATH 指向另一份解释器。独立解析支持 native、绝对 shebang、单一 `env <interpreter>` 与符号链接；拒绝不明确的 env -S 等形式、解释器循环、非文件/不可执行/缺失路径。PATH 的非绝对条目不参与查找，实际 pane 也只使用同一个绝对目录序列，不把 tilde 按当前 cwd 或 shell 设置猜测展开。本机只读解析发现原 PATH 含 `~/.dotnet/tools`，新增因果 RED 后修正：Claude/agy 对应 native executable，Kimi 的脚本对应实际 Node executable。该核验只读文件，未启动真实模型/窗口，不是 QA529。

共享 controller 新增 adapter/nativeSession/expectedLeader 输入，Codex 默认仍为 codex-tmux，dispatch/rescue 的旧接口保留。另一个因果 RED 证明 native 采样 await 期间 revision 改变仍会被旧代码接纳：现将采样前 revision 固定到最终 acceptSpawn CAS，不能用 await 后读到的新 revision 替旧证据续权。接纳成功前同时核对 native session 和 exact leader；close 与采样竞争时仍可记录实际 newborn 供清理，不能绕过 spawn fence。

红绿：共享 controller 的三载体接纳/收尾原本全拒绝，另三项 leader/session/revision 变化原本错误接纳，合计 6 RED → 文件 27 GREEN。新工厂 API 13 项从缺失到 GREEN，实际 registry factory 注入测试 1 项 GREEN；这两组新 API RED 不冒充九单原故障复现。绝对 command/PATH 未传入实际 pane 的 1 RED → adapter 文件 13 GREEN；resolver 首轮新 API 缺失，随后 fixture 的 macOS /var→/private/var canonical 路径修正（不计产品 RED），宿主混合 PATH 又有独立 1 RED → launch 文件 25 GREEN。

验证已收齐：26 个明确选择文件逐一运行，25 文件 523 pass；runs-route-registration 原15秒限额连续超时，不能称本批全绿。临时阶段计时确认停在 plugin.ts 动态 import 尚未返回、没有进入 startBridge；诊断后原测试逐字恢复，没有增限、删断言或把诊断算通过。FLY-2211 inventory 与 FLY-1560 lexical guard 各有一次原限额超时，原配置单独复跑分别5/7 pass，初次失败日志保留。

限定11个已发现单元文件的 runner related 实际选中7文件261 pass；限定13个的 teamlead related 实际选中8文件，7文件63 pass、同一个 routes 导入超时1 fail（因此该命令exit 1）。teamlead related 保留原 setupFiles 的 CommDB/state/Codex home 隔离、内置模型配置与 unstubGlobals。`pnpm --filter "flywheel-teamlead..." build`、lint（25个既有warning）、voice-codex依赖方typecheck均exit 0。消费者50条逐查询匹配、26文件选择、612条逐文件排除理由及旧启动入口清单归档 `implementation-a9-consumers.json.gz`；所有红/绿/超时/诊断日志、命令、related配置和最终源码SHA256归档 `implementation-a9-evidence.json.gz`。未跑整库/整包suite，没有新增shell测试文件。此批作为有明确验证缺口的实施检查点保全，后续仍需在原限额验证 routes，不请求评审或交卷。

### 下一步必须继续，不能把生产 factory 接线当成九单完成

- Tmux 两个 wait 分支以及 standby onRetired 仍按 pane/window 收尾；有了强制 owner.finish 后更必须接上 D 组的真实退出/完成回执分类与 writer-empty 证明。下一批优先完成这一依赖，不能以本批 mock 接纳/收尾测试声称缺窗活体或留窗死体已在生产路径通过。
- 旧 Claude 唯一身份补采仍未实现；独立观测的生产消费者、reown 预算优先、独立公平采样、marker-first 死亡 CAS、双库义务、B–F 其余消费者和九单矩阵仍未完成。
- 复核还确认继承的 `beginRestart` 在五次 lease_held 后仍返回 false，经既有 restartGate 当成 refused_by_owner；当前测试也固定这个旧行为。Lead 的“只有语义拒绝才 stop”义务尚未全闭合，必须在现有 restartGate 扩展临时争用结果，不能将本批保留的短 retry 测试报告成此义务已完成。
- 启动入口检索另有 `scripts/lib/setup.ts → scripts/run-issue.ts` 的独立旧 CLI 与 e2e 脚本，未接管其无协调 StateStore 的旧流程；它们不能给共同死亡消费者提供本批受信 owner 证据。当前生产 DAG dispatch/retry 入口是 run-infra，完整旧入口迁移边界需在最终消费者清单与 QA 报告列清。

保持 implement 0/6；没有代码复审通过、PR、full CI、QA529 或 needs_review 完成声明。

## D1 Tmux 进程等待与 standby 证明（执行 7d99e8e8）

从 2c694677d 续接，TURN implement epoch 13。生产 factory 绑定的 Claude/Kimi/Antigravity 在有 hook、无 hook 两种模式下均使用同一个 BodyObservation 等待分支。可靠死亡由当前 owner/generation/binding 证明；窗口存在或消失不影响结果。Tmux 单次 native launch 不再被共享 Bridge PID 存活永久遮住死亡；Codex resident controller 的恢复守卫继续保留，所有载体的 spawn/restart/recovery/writer census 守卫也保留。

观测与分类跨 await 后重新核对当前身份；有待处理 complete marker 则继续等待 canonical reconciler，绝不从 provider Stop 或 legacy sentinel 补造 generalized 完成凭证。匹配 execution/activation 的真实 receipt 或当前批准 retirement 保持正常结果，否则输出 abnormal_process_exit。Blueprint 对 generalized 无判决退出保留这一失败类型，不再因存在提交而进入成功 DecisionLayer；legacy 合法决策语义保留。恢复 context 即使未携带 workflowActivationId，只要 processLifecycle 存在也不能走 legacy Stop/sentinel 完成捷径。

legacy land-status 的 merged/failed/ready_to_merge 协议保留六个 poll 的宽限期，结束只表示完成信号，绝不冒充进程 drain；新共同分支不调用窗口探针。未接 factory 的旧 CLI/injected lease 仍走原 wait 实现，必须在最终入口清单中列明，不能声称所有旧路径已迁移。

standby 的窗口清理仅作清理请求。onRetired 移到 owner.close/finish 成功之后，并要求再次采样的当前 dead + 当前 retirement approval；缺窗、旧代证据、未完成 drain 均不能确认 standby。即使未绑定 lease，原来的“cleanup window 成功→onRetired”捷径也已删除。单 Tmux 串行采样不依赖 5 分钟 heartbeat，名义观测间隔上界为采样预算5秒加poll默认5秒（不含宿主调度停顿）；全局8候选/并发2/公平游标仍未实现，不能用这项局部 cadence 代替全局验收。

因果红绿覆盖：三载体死 worker 被活 Bridge 遮住（3 RED）；八个共同等待场景（8 RED）；缺窗却残留 writer 时旧 onRetired 提前调用（1 RED）；generalized 有提交但无判决退出被 Blueprint 误报成功（1 RED）；终态 failure 类型被丢弃（1 RED）；heartbeat 回调异常遮住采样（1 RED）；resume context 缺 receipt 被误分为 legacy completed（1 RED）；resume Stop 误完成与 legacy sentinel 丢失（2 RED）。新 factory observe API 的缺失 RED 是接线测试，不计九单原现象。sentinel 首次测试漏传参数的失败已明确归为 fixture 错误，保留日志但不算产品 RED。新等待文件最终13 GREEN；生产 factory 文件14 GREEN。

### 本批验证与明确缺口

19 个具体文件逐一执行，最终504 pass；FLY-2211 kill inventory 首次原15秒超时，同配置单独复跑5 pass，失败日志保留，没有放宽限额或删 guard。限定已发现文件的 owning related：runner7文件324 pass、teamlead3文件44 pass、edge-worker3文件81 pass。core 的 adapter-types 为类型引用，related 未选中测试（exit0）；两份显式 AdapterRegistry 共17 pass，并由依赖构建和 voice-codex typecheck 验证导出兼容，不把空 related 当测试通过。没有新增 shell 测试，没有运行整库/整包suite或真实模型/tmux/529。

D1 仍是 WIP：DirectEventSink 与 HTTP event-route 在落库时尚未重新采样并执行 marker/receipt/版本 CAS，适配器返回后的竞态尚未闭合；不得把本批当作 HIGH death-before-pending-complete-marker 全局完成。abnormal CommDB 投影由后续共同死亡收敛负责，adapter 不自行把 running 投影写 failed。实际 standby resume 的启动 context 尚缺 activation 时会被 owner 的 activation_missing 守卫拒绝，下一批必须从唯一当前 binding 补全受信身份，不能放宽 owner 守卫。C 组 StateStore 死亡事务、跨库义务/幂等过期、TURN/wake 交代、其余直接消费者、旧体迁移、Codex reown、restart 暂时争用不能 stop、九单矩阵仍在全范围内。

保持 implement 0/6；本批没有代码评审、PR、full CI、QA或交卷完成声明。消费者查询/逐文件排除与红绿、related、构建日志归档 implementation-d1-consumers.json.gz / implementation-d1-evidence.json.gz。

最终源码的 teamlead 及依赖 build、lint 均exit0（保留25个既有warning）；voice-codex依赖方typecheck exit0。首轮build发现 CommDB updater 的有限状态类型不接受 failed，已去除adapter独立失败投影，失败及最终成功日志均保留。

## A10 恢复启动的 activation 与异常退出贯通（执行 7d99e8e8）

续接已推送的 D1 检查点 d61ddd613。沿实际 buildStandbyResumeStartRequest → Blueprint → owner factory 核实：恢复请求保留 execution/generation，但没有 workflowActivationId。owner 的 activation_missing 拒绝是必要守卫，本批不删除它；仅在 processLifecycle.mode=resume 时，从 StateStore.resolveCurrentWorkflowActivation 取得唯一当前绑定。缺失/歧义拒绝，显式 activation 与当前绑定不同也拒绝，不覆盖为另一个身份。

owner claim 的每次 lease retry、prepareSpawn、authorizeSpawn 和 restart 准入均重新核对捕获的 activation。绑定的 OS await 期间被取代时，先保存该 newborn 的真实绑定供清理，再拒绝模型准入；close/finish 不要求逻辑 activation 仍活跃，避免完成后无法清理原物理体。没有改 execution/activation 凭证、恢复预算或 StateStore 的 owner CAS 规则；Codex 非 resume 的 reown 路径仍由原 recovery reservation 驱动。

同一路径另有两处遗漏：多 activation 的执行按 execution 单值查询会返回 undefined；现在 Tmux 死亡分类按观测内精确 activation 查 workflow context 和完成凭证。Blueprint 的异常退出分支也覆盖 workflowProcessLifecycle，避免只带恢复生命周期的无判决退出掉进 legacy DecisionLayer。legacy 不带 generalized/context/lifecycle 的成功决策保留。

新测试用真实临时 StateStore 的 admitted binding、注入 OS 样本验证两载体缺 activation 的成功恢复、缺失/歧义拒绝、显式冲突、lease retry 和 OS await 期间身份变化、拒绝旧 native permit、逻辑结束后的 drain。首轮8 RED中2项是原本已拒绝但错误分类字符串不同的负控，不计因果行为修复；其余6项为错误拒绝合法恢复或错误接纳失效身份。随后新增精确 activation 完成查询1 RED和Blueprint resume无判决退出1 RED；目标文件最终分别10/13 GREEN。多 activation 查询歧义在该接线测试中注入，不能冒充完整 standby 真机恢复验收。

本批仍不是 B–F 完成：共同死亡事务与最终 sink 的 marker/receipt/CAS、跨库义务、所有窗口消费者、独立公平采样、旧体补采、restart争用中性分类、九单矩阵、评审/PR/CI/QA/handoff仍待完成。实际跨 activation 但不换物理generation的 re-entry，也须在最终共同收敛中核对当下逻辑归属，不能以本批 resume 新启动身份测试代替。

A10 验证收齐：13个明确文件逐一运行306 pass；限定文件的 owning related 为 teamlead3文件51 pass、edge-worker3文件82 pass。teamlead及依赖build、lint均exit0（25个既有warning）。没有公共类型/schema变更，不新增shell测试；此次没有重跑A9遗留的routes原15秒导入超时，不能据此关闭该旧验证缺口。逐查询匹配、44条排除理由和全部红绿/命令/源码hash归档 implementation-a10-consumers.json.gz / implementation-a10-evidence.json.gz。

## C1 已提交结账的过期后重放（执行 7d99e8e8）

续接 ce4afdfc3。Lead obligation-replay-evidence-expiry 的既有 CommDB 入口已定位到 finalizeProvenGoneSession：旧实现先拒绝过期证据，随后才查 closeout_finalization_receipt，因此重启后无法取得已提交的结账结果。本批只将过期拒绝移到事务内的已提交回执查询之后；输入格式/摘要冲突、首次结账的过期/身份epoch/TURN/founder wake守卫全部保留，没有增加死亡授权或把任意字符串变成新义务。

真实临时 CommDB 测试先完成结账、关闭并重开数据库，再登记同 execution 的新身份和新问题。原实现重放返回 evidence_expired（1 RED/22原项通过）；修后返回同一已提交结果且不重复写库。负控验证更换 evidenceId 仍拒绝 receipt conflict，新的过期 reservation 仍拒绝 evidence_expired，新身份和新问题完整保留。该文件最终23 GREEN，不是生产数据库/529验收。

FLY-2567兼容性守卫按预期发现db.ts哈希变化。逐字比对确认 finalizeProvenGoneSession 之外所有内容不变，只刷新对应dependency hash并补充精确理由，旧bootstrap generator源码和hash不动。原守卫失败和随后定向复核均保留。没有schema或公共API变更、没有新增shell测试；新跨库 body_death 义务尚未实现，必须沿同一先查回执规则接入，不能把此既有入口修复报告成C组完成。

C1 验证收齐：7个具体文件逐一执行106 pass；owning comm related 限定到直接finalizer文件，1文件23 pass。comm及依赖build、lint均exit0（25个既有warning）。JSON兼容性fixture变更不涉及公共API，Bridge直接消费者均用新建comm产物验证。27条逐文件排除理由、回执重放红绿、兼容性guard原红/最终绿、源文件边界字节核对和全部命令日志归档 implementation-c1-consumers.json.gz / implementation-c1-evidence.json.gz。

下一批优先B/C核心：StateStore.convergeProvenDeadExecution 与既有 terminalizeProvenDeadSessionTx 接通，采样/marker对账放lease外，最终同步CAS内核对身份、generation、revision、owner/spawn、动态开关和marker；持久body_death义务保留实际完成/retirement结果，随后按epoch处理CommDB投影、TURN和founder wake。DirectEventSink/event-route/recordEnrolledTerminalSignal的execution单值查询在多activation时仍有歧义，须随同一收敛链处理。窗口清理不提供死亡授权，FLY-2921仍独占替身协调。A9 routes旧15秒导入超时与全A-F/九单、review/PR/CI/QA/handoff均保留未完成。

## B3 死亡提交事务检查点（执行 bd58c685）

续接 `67813247e`，TURN implement epoch 14。按批准 B/C 实现 `StateStore.convergeProvenDeadExecution`：异步 OS 采样与完成 marker 对账由调用方在事务前完成；入口本身同步拒绝待处理/不可读 marker，并核对 accepted binding、owner token、spawn epoch、generation、activation、lifecycle revision、证据时间与 observer 的动态开关/reown 判据。mutation lease 只在 SQLite IMMEDIATE 事务内使用；释放旧 revision 的 lease 后，同一写锁下终结/保留状态、关闭旧 owner 并插入 `body_death:<exec>:<generation>`，任一步异常整笔回滚。

复用 `workflow_run_event` 保存原 observation、CommDB identity revision、TURN epoch、完成回执、实际终态和待投影义务，不新增生死状态表或替身调度器。事务回放先查同一不可变事件，再检查首次死亡时效；已经提交的义务可在重启、10 秒证据到期、开关关闭后返回，不能重复关闭新 owner。首次提交仍拒绝 alive/unknown、启动在途/恢复、身份或代次变化；没有窗口输入。

测试使用临时真实 StateStore 与 accepted owner、注入 OS 无进程样本；workflow 身份/回执行是隔离 SQL fixture，不冒充真实 admission、Bridge 流程或529。初始 scaffold 12 RED/8 pass；最小实现20 GREEN。追加 standby 负控1 RED/23 pass，修后24 GREEN。新测试首轮 RED 先于引用清单执行，此顺序偏差已在消费者归档记录；随后回归/related前完成逐路径及字面量检索。完成后退休的组合负控与最终验证结果待下文补记。

本批尚无生产死亡消费者接线，`execution-body-convergence.ts` 当前仅定义 Bridge 内部提交/义务类型。CommDB trusted finalizer、TURN/wake settlement、持久待投影扫描、异步 marker-before-sample 协调仍未完成。对同物理generation出现较新逻辑activation目前安全拒绝，后续必须沿当前逻辑归属接通，不得把永久unknown当最终修复。A9 routes原15秒导入超时及全A–F/九单、有效评审/PR/CI/QA/handoff仍未完成。

B3 最终追加 completed+retiring 负控得到1 RED/24 pass，修后25 GREEN：已completed的批准退下仍提交standby，不关闭其可恢复物理记录，也不虚增lifecycle revision；已failed/blocked的不可逆结果仍保留。初始12 RED是新入口scaffold上的契约失败，其中marker/lease分类差异不计旧生产路径错误判死；九单原现象验收仍未完成。

本批显式16个具体文件逐一运行，按每文件最后结果合计 **428 pass / 1既有skip**；其中新死亡事务25、FLY-2211信号清单5、generalized-execution73与Tmux生产绑定14。owning related按两个明确include清单分开运行，实际8文件 **365 pass / 1既有skip**。teamlead及依赖build、teamlead与voice-codex typecheck、lint均exit0（25既有warnings）。没有新增shell测试。原始红/绿及回归日志、相关配置、源码SHA归档 `implementation-b3-evidence.json.gz`；查询及逐路径排除理由在 `implementation-b3-consumers.json.gz`。StateStore旧代码除新增导入和本入口外逐字不变，无schema/guard放宽。

下步仍须完成B/C生产接线：在lease外对账marker与采样；以当前逻辑activation接上同物理generation重入；读取/重放可信body_death义务、CommDB身份epoch CAS、TURN比较撤销和founder/rework wake结账；再接Heartbeat/dispatcher和其余窗口消费者。不得把本检查点报告为完整死亡收敛或实现交卷。上轮C1是已提交的实际进展，本轮继续推进；目标保持全部A–F与九单范围。

## C2 双库死亡投影与崩溃重放（执行 bd58c685）

在 B3 `0902cc61f` 上继续，TURN implement epoch14。新增 Bridge 内部协调入口：采样与 complete-marker 对账均在 mutation lease 外；采样前记下 CommDB identity revision 与 TURN holder/epoch，await 后重新核对，再调用 B3 同步死亡 CAS。采样期间同 execution 被颁发新 TURN 的负控先得到 1 RED/10 pass（旧实现错误返回 committed），增加采样前后 epoch 核对后 11 GREEN；不能用“仍是同 execution”覆盖新授权。

StateStore 的不可变 `body_death` event 是待投影义务。新增有界读取游标（1–64）及 `body_death_projected` 幂等回执，不新增表；首次投影只能由 Bridge 重新读到的原义务授权。短 mutation lease 只覆盖同步跨库核对、CommDB 投影和 StateStore 回执；异常保留 lease 至 TTL，下一次重放仍用同义务。新物理 generation 未提交投影时拒绝旧证据，不把旧死亡重绑到新 writer。真正提交过的死亡义务允许 10 秒证据过期后投影；没有实际提交的旧采样仍拒绝。

CommDB 新 `projectProvenBodyDeath` 独立于 land reservation，使用既有 closeout receipt 表。一次事务内核 identity epoch、精确 TURN compare-delete、founder wake terminal receipt/原始来源与 durable wake_failed 告警、终态镜像和 parked 声明清除。失败/blocked 保留原结局；已完成保持 completed，显式结束映射保留具体 terminalReason。已有 review gate、近期 report 与普通/rework wake 保留。**普通/rework wake 仍须由既有 replacement/retirement receipt 路径结账，当前 identity row 保留；projected 回执不表示所有 wake 或物理清理已完成。**未新增 Runner HTTP/CLI 接受 proof 的入口。

CommDB 的既有方法按字节保持不变（剥除新 import 与新 method 后等于 B3 HEAD）；FLY-2567 manifest 只刷新 db.ts 成员并写明两种 token-savings mode 的既有查询/分页/bootstrap 行为均未变，独立 legacy generator oracle 保留。第一次 guard 为 5 RED/12 pass，精确更新依据后17 GREEN；没有放宽 guard。

新入口的 scaffold RED：CommDB15 fail/1 pass、StateStore reader1 fail/25 pass、双库协调8 fail/1 pass；这些只算契约缺口，不冒称九单生产原现象。双库真实临时 SQLite fixture 覆盖 StateStore 已提交/CommDB 未提交，以及 CommDB 已提交/StateStore 未回执两个崩溃切点，关闭重开并经过61秒再用原义务恢复；核对关闭开关仍可补旧已提交义务、重复投影不触碰新身份、回执插入失败全事务回滚、lease争用先拒绝后重试、marker/开关/身份/TURN在await中变化时零死亡写。

本批仍未接生产 Heartbeat/dispatcher/其余窗口消费者；同物理generation的新逻辑activation桥接、独立采样节奏、reown生产保护、legacy迁移、普通/rework义务及完整A–F/九单均未完成。A9 routes原15秒导入超时未在本批关闭。没有review/PR/full CI/QA/handoff完成声明。

C2 验证收齐：16个具体文件依次执行337 pass；限定发现文件的 owning related 为 comm7文件130 pass、teamlead6文件181 pass。teamlead及依赖build、teamlead/voice-codex typecheck、lint均exit0（25条既有warning）。初次build缺lib.ts类型导出及owner缩窄、初次lint导入分隔错误均已修复并重跑通过；不算产品行为RED。无整库/整包测试，无新shell测试。全部红绿、初次失败和最终检查日志、命令、related配置、现有db方法字节核对及源码SHA256归档 implementation-c2-evidence.json.gz；逐查询消费者/排除理由归档 implementation-c2-consumers.json.gz。
