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
