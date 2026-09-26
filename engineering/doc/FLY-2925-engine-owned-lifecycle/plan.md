# FLY-2925 引擎统一体生命周期 — 实施计划
Issue: FLY-2925 (https://linear.app/geoforge3d/issue/FLY-2925/病根修复-7-codex-体生死只认引擎一侧goal-结束不等于死引擎终结后-goal-不得自续重启只按原会话续接6-张-43)
日期: 2026-09-26
基于: research.md

状态：待设计评审；按最新 Lead 行为要求执行，账号依赖能力必须补齐（§13）。基线 fdd1b404d；这是设计，未实现、未部署、未完成真实验收。

## 1. 给 founder 的决定

**选独立终端运行：把每个 Codex 工程师的运行控制搬出 Bridge，Bridge 重启只重新连上原工程师。保留现有程序通信接口，让信件、回合记录和原账号绑定继续有效。代价是增加一个小的独立宿主程序，并验证跨进程的终结与恢复。**

Bridge 是接单、调度、汇报的服务；宿主是守着一个 Codex 工程师的独立程序。当前已经有可看的终端，但控制程序仍在 Bridge 里。只多开窗口不能修复这条依赖。

首选评估的是原生 `codex` 自包含终端。它能保留原生 goal（持续目标）和精确会话恢复；暂未证实裸终端能保留现有机器投递与同步回合控制。因此选“独立宿主 + 真实 Codex 终端”，宿主内部继续用 app-server（程序控制 Codex 的通信接口）。不因协议名字相同而把它误称为仍由 Bridge 驱动。

原三至四个逻辑改动面扩大为四个闭包：独立运行/重连、goal 观察与引擎裁决、精确恢复与原账号、六单验收/API 事实。文件数超过四个；不能为了凑文件数漏消费者。Lead 回复 8221ee32-6265-4da8-b341-7e100b14926a 已确认此评估方向与最小范围；回复 da2cd3c3-c23a-4105-837c-11b97427a7c7 要求继续计划、评审与 HTML 交付。

### 1.1 对比与放弃项

| 方案 | 选择 | 原因 / 代价 |
|---|---|---|
| 裸 `codex` 独立终端 | 首选评估，暂不直接替换 | goal 和 resume 都有；按键投递/读屏不能取代 mailbox 消费回执、turnId 边界、阶段守卫；需要等价协议证据 |
| 独立宿主 + TUI + 内部 app-server | **选** | 保留已实现能力，移走 Bridge 重启造成的控制者丢失；新增窄宿主和重连协议 |
| Bridge 内继续修 reown | 不作为最终形态 | 补错误分类有必要，但仍每次重启重建执行上下文；保留窗口不是进程独立 |
| 换体、重设 goal、重放最初任务 | 拒绝作为重启恢复 | 隐藏丢失身份、重复工作、重置预算 |
| 独立宿主失败时静默切回旧 reown | 拒绝 | 重新引入两个生死裁决者；失败必须可见并保留原会话 |

### 1.2 可见结果与边界

Bridge 班车重启时原终端继续显示原会话；回来后看到同一执行体，没有“恢复提交后失败→换人”。goal 卡住时显示“等待纠正/等待上游”，信件仍可到达；引擎明确结束后原体不再自动拉起。

不改变 Claude 运行方式，不改账号槽布局，不实现新的额度调度，不修 FLY-2893 所有前三类问题，不让模型文本决定终结。工程设计通过不是部署许可；只有独立 updater 按窗口部署。

## 2. 必须保留的能力

| 能力 | 保留方法 | 证明方式 |
|---|---|---|
| 中途信件 | 宿主复用 mailbox、turn/steer 与现有消费回执；Bridge 只发持久需求 | 工作中发独特指令，检查模型下一响应实际使用，不能只看传输 ACK |
| 回合边界 | 宿主运行现有 turn lifecycle/barrier，持久记录原 threadId/turnId | Bridge 断线中产生的边界按事件身份补齐，不能生造 turn/start |
| 账号隔离 | 每体隔离凭据，由上游账号控制提供有效绑定；恢复采用最新已应用的授权绑定 | 工作中 A→B 切换，原会话在安全边界实际使用 B；Bridge/宿主重启不退回 A；无切换授权时仍 A |
| goal | 同一 thread 的目标、用量、预算及手工暂停保持不变 | 比较前后原生 goal 状态与消费；不重发 objective 清零 |
| 可见终端 | 同一 exec 的 `runner-*` remote TUI，绑定宿主的实际 thread | 截图+可附着验证；空 pane、只活后台均不算 online |
| phase 停驻 | 现有完成/park/wake 持久记录，由宿主继续消费 | 无需求不恢复；同 wake 重放零重复输入；TURN 仍由引擎授予 |
| 明确终结 | FLY-2903 停止、排空、精确进程清理，补跨进程 owner 识别 | 真关闭/断线竞态，终结后没有新 daemon 或模型回合 |

账号最终行为以 Lead 最新要求为准：每个 runner 独立凭据隔离，重登与账号切换不丢失在飞工作，授权切换须平滑到达在飞体。当前 FLY-2902 head 的原槽实现与此有差异，见 §13；本单不自行降低要求，也不把 Bridge 重启当成切号授权。

## 3. 身份与权威：复用现有模型

| 数据 | 单一权威 / 用途 | 禁止的推导 |
|---|---|---|
| run/node/attempt/activation/execution_id | StateStore 当前工作流绑定 | 不从窗口名、cwd、issue 标题认领 |
| process-body generation/state/current_demand_id/owner_claim_id | FLY-2808 现有 `workflow_execution_process_body` | Bridge 重连不增加 generation；只有物理重建才增代 |
| threadId、resolved model/effort、cwd/worktree identity、manifest digest | 冻结启动及 resume manifest，与原生响应核对 | 空 ID 不退回 thread/start；模型自述不是身份证据 |
| effectiveCredentialBinding / applied change receipt | 上游账号控制的每体有效绑定；birth slot 仅是初始来源 | 不用当前全局活跃槽猜，也不以 birth slot 覆盖已应用切号 |
| engine terminal/close intent | sessions/工作流终态和 FLY-2903 关闭账本 | goal blocked/complete、socket 断开、宿主退出都不是该字段的写权限 |
| host identity / socket / start identity / event cursor | 扩展现有 exec session manifest；只作为载体定位与观察 | 文件存在不能证明进程活；进程活不能证明有工作权限 |
| native goal status / wait reason | 宿主持久观察事件及既有 session event 投影 | 不直接写 session terminal、不给 successor 授权 |

扩展 `session.json` 为显式 `hostProtocolVersion:1`，保存 host pid/start identity、endpoint、exec、process generation、threadId、manifest digest、binary release path 和 engine event ACK cursor。账号秘密、ingest token 不写事件/HTML/命令行；每体独立凭据由上游受管 home 和 launcher 提供，宿主仅接收不含秘密的 binding 引用和应用回执。原子临时文件+rename，0600，拒绝 symlink/越界路径；字段严格校验。旧 manifest 不猜新字段。

**不新增一套工作流状态机**。body 仍用 active/retiring/standby/resuming/resume_failed/closed。等待仅是工作观察，不冒充 phase complete。展示优先级为 engine closed → identity/problem → waiting → working；未知不涂绿色。

## 4. 独立宿主合同与重连

### 4.1 包装边界

新增 `packages/teamlead/src/runner-host/codex-runner-host.ts` 与 `codex-runner-host-protocol.ts`；宿主依赖现有 claude-runner，不反向让 claude-runner 导入 teamlead。从 `CodexTmuxAdapter.execute` 提取执行逻辑到 `packages/claude-runner/src/codex-runner-session.ts`，由 adapter 的宿主客户端与宿主入口共享类型，不能复制两个 goal loop。

宿主包含现有 daemon runtime、goal loop、turn/phase consumers、mailbox intake、心跳、可见 TUI 和清理。Bridge 留 admission、TURN、引擎推进、关闭决定、事件接收和 reconnect proxy。`ExecuteContext` 中的函数不可 JSON 化：逐个替换为命名能力，manifest 仅传值；宿主构造本地 CommDB 读写器和引擎只读 authority reader，向 Bridge 写状态走现有认证事件入口。缺能力拒绝启动，不能吞掉闭包造成静默无邮件。

宿主经现有 tmux/cmux 受管 launcher 独立启动，不能以 Bridge stdin/IPC channel 生存为前提。使用不可变 release 绝对路径；更新 symlink 后旧宿主仍运行旧版本，Bridge 重连握手检查协议兼容。Bridge 普通 shutdown 只关 proxy、保留宿主；issue 终结、显式关闭和批准 standby retirement 才发 stop。

### 4.2 控制与事件

宿主专属本地 Unix socket，exec 路径范围内，0600；不是公网管理端口。请求 schema：`{v:1, requestId, executionId, generation, operation, expectedThreadId, engineReceiptId}`。operation 只允许 inspect、attach、stop、deliver、resume、credential-change；inspect 不变更状态，attach 不发送业务输入。所有变更必须核对 StateStore/CommDB 的对应需求/关闭/邮箱记录、当前代数及绑定；不把 bearer token 或同 UID 当成额外引擎授权。现有同 UID 运行信任边界不因此升级为恶意同用户隔离保证。

响应包含精确 host/thread/generation 观察、结果与 requestId。命令按 `(exec,generation,requestId)` 去重。deliver 复用 mailbox 原 message/wake 身份，不自建第二套消费语义；“已接收”与“模型已消费”分开。

宿主的 session/turn 事件写每体追加 journal：`{v, exec, generation, seq, eventId, type, payload}`，fsync 后才算已记录；eventId 为 exec+generation+seq，seq 单调。Bridge 用现有 event_id 唯一键落库，再返回连续 ACK；缺号先补齐，重复事件不二次推进，旧代数仅审计不改变新体。host transport ACK 不推进 mailbox 的 consumed。journal 上限 16MiB 未 ACK 数据，达上限在回合边界暂停并显示 event_backlog_full；不丢边界事件、不无限增长。ACK 后保留最后确认 cursor 和未 ACK 段，原子轮换；崩溃中途可从最后完整行恢复，截断尾行记诊断。

### 4.3 Bridge 重启（体仍活着）

1. 从当前引擎绑定找 exec，检查非终态、process-body 与 manifest。
2. 验证宿主 start identity/endpoint 的对应关系，握手返回精确 exec/generation/thread；窗口列表只用于显示和定位，不能单独授权。
3. attach 订阅已有 journal，核对当前 native turn，补齐事件和邮箱 cursor。活跃回合不能被陈旧 CommDB active_turn_id 覆盖；只接受该宿主记录、相同 native turn 身份的补写，存在冲突则 hold 呈现证据，不抛“恢复提交后失败”并判死。
4. exec、thread、process generation、账号槽、目标/预算全部不变；**不调用 commitCodexRecovery、goal/set active、thread/start 或恢复 kick**。
5. 若只是显示窗口不在，由宿主重开绑定同 daemon/thread 的 TUI；不能因此重启 daemon。

Bridge 离线时，已有宿主继续当前被授予的工作和本地邮箱/phase 控制。引擎只读状态可用才允许新的恢复/激活；仅 Bridge 网络断开不使当前体终结。authority 数据库打不开/身份不明时停止新输入并暂停 goal；明确关闭则 stop。宿主自身 daemon 死亡不在 Bridge 不可用时自行铸新进程，保留故障等引擎恢复命令。

## 5. goal 观察不再决定体死亡

调整 `runGoalToTerminal` 为 resident session loop：既有函数可保留作为非 resident 调用包装，但 DAG resident 不能因 goal 状态结束而返回 adapter finally。用判别联合 `continue | wait | request_engine_decision | stop_authorized` 表达观察；`GoalClassification.success` 只用于真正结束后的结果，不能承担 liveness。

| 观察 | 宿主动作 | 唤醒依据 |
|---|---|---|
| blocked，没上游错误 | 保留体与 mailbox，记录 native_blocked，暂停继续轮转 | 新的合法信件/phase wake/Lead 纠正；同 messageId 一次 |
| capacity、明确 serverOverloaded、HTTP 429/5xx | 同 thread 退避 10s、30s、120s，最多 3 次；尊重更长 Retry-After（上限 15min 后等待） | 当前引擎需求仍有效、非手工暂停、同 error episode；预算不重置 |
| 额度耗尽 / budgetLimited | 留体等待，不自动换号/扩预算 | 既有额度/预算治理给出的明确动作 |
| unauthorized / 400 cyber / 权限配置错 / 未知 error | 留体可收信，显示原因，不盲试、不标死 | 同号修复或引擎新决定；未知不当瞬态 |
| paused（用户主动） | 保持暂停 | 明确 resume 授权；Bridge 重启、普通 heartbeat 不解除 |
| complete，阶段尚未完成 | 记录 goal_complete_without_phase_receipt，仍等引擎 | 有效交卷 receipt 或新指令；不自行交卷、不伪造成功 |
| 有效阶段 completion + park | 进入现有 phase hold / FLY-2808 退下流程 | 引擎合法需求；goal status 不替代 completion receipt |
| 传输断开但进程状态未知 | 诊断、停止新输入，重连观察 | 精确宿主/daemon 观察；不按超时直接换体 |
| 引擎关闭 / 被 supersede | 禁止新输入，stop/drain | 只有引擎可授权新 execution；旧 exec 不恢复 |

重试 episode = `(exec,thread,last failed native turnId,error category)`，计数/nextAt 写宿主 journal 并投影；Bridge 重启不清零。错误通知重复不重复扣重试。任何重试前再核 engine binding/close intent 和预算；合法模型进展结束旧 episode。错误文案仅供展示，分类优先结构化 codexErrorInfo/HTTP code，无法识别的 text 不授权重试。

在 `event-route.ts` 删除 goal_blocked→终态的转换；旧格式事件重放只记观察，不能对已等待/新代数体 teardown。真正 provider 进程不可恢复要向引擎报告 physical_failure，由引擎现有判定决定后续，宿主无 replacement 权限。

## 6. 只有物理载体真的没了才原会话续接

入口统一到 FLY-2808 的 process resume，reason 明确分为 `bridge_reconnect`（不得创建进程）、`carrier_lost`、`phase_demand`。先检查终态/关闭、当前 activation、原 manifest、原槽；取得现有 process-body 的唯一 resume claim。并发 Bridge/heartbeat/重复 wake 共享该 claim，不能第二次 spawn。

确证旧进程组和监听端点已退出后才能增代、恢复 lease。`process_resume` 使用上游最新已应用的每体有效凭据绑定；没有切换记录时才回首次绑定。legacy 无记录必须经上游明确迁移回执解析，否则拒绝。不能删 home 检查、用当前活跃号猜测，或退回 birth slot 撤销已完成的切换。

启动新宿主并 `thread/resume` **精确原 thread**，比较响应 ID、cwd、resolved model/effort、home/槽、worktree identity。继承已有真实上下文和 goal，用现有暂停/hold 守卫先阻止业务输入，验证通过才接需求。能力不支持“核身份前不自动工作”时此次恢复失败并告警，不能先执行后核验。

原 thread 不存在/损坏/响应空或错、旧代数、家冲突 ⇒ resume_failed，保留执行体/证据、停止已创建的错误载体；不新建 thread，不隐式 fallback。瞬态连接故障最多沿 FLY-2808 原会话尝试 2 次，只有清理已确认才第二次。纯 Bridge restart 绝不走 resume_fallback；独立的合法 phase demand 若沿 FLY-2808 有显式 fallback receipt，保留原规则并显示上下文损失，不能把它算作本单“原会话恢复成功”。

**删除项**：`CodexSessionReowner.beginRecovery` 的新 rescue-owner 业务启动、recovery commit 后 reconcile 判死、恢复时泛用 startInitialTurn/kick；将 reowner 收敛为精确重连/委托 process resume，不再另建恢复状态机。保留被其他初始启动消费者需要的 launch commit；不要全局删掉 turn/start。

## 7. FLY-2903 复用与跨进程终结

PR #1343 已合入本基线。继续用它的 stop/drain、精确 PGID/socket/start identity、终态 sweep 和 token 账本；不重建相同组件。

Bridge 先持久化 engine 关闭事实，关闭请求绑定 exec/generation；本地 owner registry 中宿主 proxy 的 requestStop 转发给宿主。宿主在处理请求、每次恢复、每次解除等待、每次发送输入前读最新引擎状态；读失败拒绝新的启动。宿主将 stopRequested 同步置位并调用 runtime.stop；晚到的 transport-death catch 不得越过该位。关闭途中崩溃后只可恢复清理，不能恢复工作。

新宿主必须显式提供 restart gate；resident 模式缺 gate 视为拒绝，不继承当前“缺 predicate 默认 true”。所有物理恢复授权统一由引擎 claim 给出，runtime 不私自循环 spawn。引擎关闭拒绝优先于任何 reconnect/retry/phase wake。

`codex-terminal-sweep` 的 owner 判断改成识别经握手核验的外部宿主，不能把“Bridge Map 没 owner”当无 owner。无响应/身份未知不误杀别的进程；仍可按 FLY-2903 已有精确进程证据执行授权清理。超时写 timeout/unverifiable，后续维护重试；不声称 closed。终态后不得出现新 spawn/resume；在途操作可能有有限排空消耗，报告原始时点和 token 增量，不能以采样没看到就宣称瞬时零消耗。

## 8. FLY-2689：启动返回值跟引擎事实一致

保留 lease missing 的准入拒绝和错误码；失败不制造已在线证据。`runs-route.ts` 先由引擎是否已提交 run admission 决定返回：未建立 run 为原 4xx/5xx；已经建立且将继续推进为 HTTP 202、`success:true`、`runId`、`executionId`、`launchState:"pending"|"waiting"`、结构化原因和查询位置。ready 为既有成功响应。`retryable:false` 如保留必须仅表示“不要重复 POST 已接纳的 run”，不能表示 run 已失败。

引擎已终结则返回对应终态事实，不写 success:true。查询和启动响应共用 run projection，提交后的未知启动观察不否定 run。所有消费者按 launchState 判 ready，不按 success 判进程在线；sweep `runs-route.dag-entry.test.ts`、Lead 工具/启动 action、`scripts/inject-linear-issue.sh` 及其他 `/api/runs/start` 字面匹配。禁止顺便重构全部 admission 或放松凭据守卫。

## 9. 启用、在飞体迁移和回滚

1. 首先实现并在 529 验证宿主协议、观察分流和关闭守卫；使用不可变 manifest 中的 carrier kind，不能靠当前全局配置猜旧体形态。
2. 将 `node_standby_resume` 默认设为开，同时修改 registry 的 polarity/默认说明及有效读取 fallback，核对持久 flag-store 显式 off 的优先级。新 admission 必须存下选择；旧 actor 不能被默认值追溯改写。此 flag 是两 vendor 共用，保留 Claude 既有路径并跑关联负控。
3. 活着的旧 Bridge-owned daemon：在确定回合边界冻结新输入，flush 事件、持久原身份和当前 phase/gate/budget，旧控制者释放**控制权**但不杀 daemon；唯一 claim 让新宿主连接原 endpoint、核对 thread 后接收控制，最后 Bridge 只保留 proxy。中途失败旧控制者仍在则继续原体；旧控制者已不在则按同 manifest 恢复。禁止双 controller 并发发送。
4. 启用后第一次班车，旧 manifest 无足够身份不能猜：显示 migration_required，并保留仍活的体；若已确证消失走精确 thread 的单一路径。所有在飞可恢复体迁移完成之前，不能宣布“班车续接验收通过”，不能把旧体排除出分母。不能批量 terminalize 再换新体清账。
5. 上线后删除旧恢复分支及所有 reachable fallback；历史恢复表和审计记录保留只读，不倒填死亡事实。删除需消费者 sweep 与相关测试证明旧逻辑无入口。
6. 回滚先停新宿主 admission，保留兼容 proxy 和关闭/精确恢复能力，等新宿主自然交卷/受控原会话转回已验证的兼容载体。未排空的新宿主、standby、resuming 不能交给只懂旧 reown 的 Bridge。不可恢复则保持新版管理并报 Lead，不能删 manifest 或改 terminal_at 来“回滚”。

默认开的有效部署需包含兼容宿主二进制、FLY-2808 resume 与满足 §13 的每体凭据/在飞切换接口。现有 FLY-2902 钉槽 API 单独不足以开启新宿主；上游未补齐时保持已运行旧体、拒绝新宿主 admission 并显示 dependency_capability_missing，不降级为只切新体。design 不授予执行离线凭据迁移或切换真实账户的权限。

## 10. 实施工作块及文件闭包

每块遵循先写失败相关用例、单文件运行确认红、最小实现、相关测试与 related 确认绿、提交。不要在设计节点执行这些实现步骤。

| 块 | 变更与交付 | 正/负验收 |
|---|---|---|
| W1 宿主与可重连控制 | 新 `teamlead/src/runner-host/codex-runner-host{,-protocol}.ts`，新 `claude-runner/src/codex-runner-session.ts`；调整 `CodexTmuxAdapter.ts`、`codex-daemon-transport.ts`、package build/bin 导出、受管 launcher；序列化值/重建能力清单逐项覆盖 | Bridge 退出宿主继续；host 重启/旧协议/伪 endpoint/双 claim 拒绝；TUI 真可见；journal 断行、重复、缺号、ACK 丢失 |
| W2 生死分流 | `codex-daemon-client.ts`、`codex-daemon-adapter-helpers.ts`、`codex-daemon-goal-runtime.ts`、`event-route.ts` | blocked 可收信；complete 无交卷不推进；429 同体有界；400/unauthorized/手工暂停无盲重试；不清预算 |
| W3 原会话恢复与终结 | `codex-session-reown.ts`、`plugin.ts`、`codex-execution-ownership.ts`、`codex-daemon-teardown.ts`、`codex-terminal-sweep{,-runtime}.ts`、现有 workflow-process-retirement / rework 接口及 `StateStore.ts` process-body claim | active 重连不 commit/kick，standby 无需求不启动；FLY-2903 关闭 race；原账号槽；旧体迁移，错误身份拒绝 |
| W4 开关/API/真实验收 | config feature-flags registry/effective default consumer，`runs-route.ts` 及其调用方；529 验收工件与文档 | 开关声明/运行时/冻结 admission 一致；FLY-2689 首体失败仍 run pending；六单与负控逐项通过 |

若需要给既有持久表增字段，沿其 migration/retention 分类更新；不得为 transport journal 添加一套可修改工作流权威的数据库。所有 SQL 使用绑定参数。所有 HTML/告警的外来文本走现有 escapeHtml；日志不输出 credential bytes。

### 10.1 相关测试选择协议

实现者先 `git grep -lF -- '<old literal>'` 与 new literal，并对每个实际改动的完整路径、basename、父目录搜索引用，写 `test-selection.md`：命中测试逐一保留或排除，排除要给理由。下表是**当前已识别的最小集合**，不能代替实际 diff 的补充发现；不枚举所有测试来模拟全套。

| owner package | concrete file（包内） | 覆盖 |
|---|---|---|
| flywheel-claude-runner | `test/codex-daemon-client.test.ts` | goal、回合、等待与 kick |
| 同上 | `test/codex-daemon-adapter-helpers.test.ts` | 观察分类 |
| 同上 | `test/codex-daemon-goal-runtime.test.ts` | resume/禁止自续 |
| 同上 | `test/CodexTmuxAdapter.test.ts` | 宿主集成与 finally 边界 |
| 同上 | `test/codex-daemon-runtime.test.ts` | 精确进程与清理 |
| 同上 | `test/codex-execution-ownership.test.ts` | proxy stop、旧 lease |
| 同上 | `test/codex-phase-lifecycle.test.ts` | phase 停驻 |
| 同上 | `test/codex-turn-barrier.test.ts` | 回合持久化与乱序 |
| 同上 | `test/codex-home.test.ts` | lease、有效绑定（集成上游后补其具体测试） |
| flywheel-teamlead | `src/bridge/__tests__/codex-session-reown.test.ts` | 三种 reconnect/resume 路由 |
| 同上 | `src/bridge/__tests__/codex-session-reown-wiring.structure.test.ts` | 删除旧消费者 |
| 同上 | `src/bridge/__tests__/codex-daemon-teardown.test.ts` | stop→drain |
| 同上 | `src/bridge/__tests__/codex-terminal-sweep.test.ts` | 外部 owner 和负控 |
| 同上 | `src/bridge/__tests__/codex-terminal-sweep-runtime.test.ts` | 真实 sweep 接线 |
| 同上 | `src/bridge/__tests__/runs-route.dag-entry.test.ts` | admission 响应 |
| 同上 | `src/__tests__/workflow-process-retirement.test.ts` | standby/退下 |
| flywheel-config | `src/__tests__/feature-flags-registry.test.ts` | 默认定义 |
| flywheel-teamlead | `src/bridge/__tests__/flag-store-runtime.test.ts` | 有效默认与显式 off |

W1 新增具体 `packages/teamlead/src/runner-host/__tests__/codex-runner-host.test.ts` 与 `codex-runner-host-protocol.test.ts`；测试隔离所有进程/home/socket/DB，绝不触碰生产 home。event-route 的实际引用测试通过上述发现协议加入，不以“太大”为由跳过。

逐个文件命令形状：`pnpm --filter flywheel-claude-runner exec vitest run test/codex-daemon-client.test.ts`，其他文件每次替换一个具体文件。TypeScript 变化另运行 owning package `vitest related <具体改动文件列表> --run`。保持 `pnpm lint`、受影响包及依赖 build（如 `pnpm --filter "flywheel-teamlead..." build`），导出类型变化要跑 dependent typechecks。新增 `scripts/__tests__/*.test.sh` 逐个运行。禁止本机全仓/全包测试；只有冻结 head 的 CI OK 才是全套绿。

## 11. 529 真实验收：每单一例，保留反例

每项记录源码 SHA、529 slot/配置、Codex version、run/exec/thread、process start identity、generation、原槽、turn 与 message/receipt ID、前后截图/原始日志路径。必须有真实 Codex 模型消费或进程证据，模拟服务器只用于局部测试。不得动生产服务和账号来替代 529。

| ID / 对应单 | 可重复原现象 | 修后必须证明 | 负例 |
|---|---|---|---|
| A1 FLY-2586 | 真 Codex 做带分段标记的任务；回合进行中重启 slot Bridge，再在 gate-held、phase-parked 各重启一次 | 活体宿主 PID/start/thread/exec/槽不变；工作继续；恢复提交及 kick 计数 0；信件不重消费 | 伪窗口名、错误 thread、旧 manifest 不能 attach；daemon 确证消失才增代原会话恢复 |
| A2 FLY-2344 | 合法交卷受 409 拒后原生 goal blocked；随后投递带随机标记的纠正指令 | 无 session_failed/替身，原 thread 下一次输出实际回应标记，完成正确交卷 | 未解决的 gate 和手工 paused 不被普通 heartbeat 解开 |
| A3 FLY-2814 | 活动回合中引擎 terminate；在 stop 请求、transport death、daemon drain、Bridge 重启四个窗口注入竞态 | 关闭事实先落盘，0 次终态后 spawn/resume；精确进程组/监听消失，两个采样间无新 turn/token 增长；在途消耗单列 | 外观相似另一 exec 不被杀；未知 PID/start/socket 只告警；普通断网非 terminate |
| A4 FLY-2630 | 529 受控代理注入一次 capacity，再恢复真实模型；另造 429/5xx/400/unauthorized | 前三者原 exec/thread 有界重试并实际产生后续模型输出；后两者同体等待纠正 | 重试中关闭、重复错误、重启不重置预算/次数；未知错误不无限 retry |
| A5 FLY-2689 | 隔离夹具移走本体 lease，在首体 admission 时触发失败；引擎仍已接纳 run | API 返回已接纳+等待原因，GET 与事实一致；0 个无 lease 的 daemon；修复后走引擎允许路径 | run 未提交仍失败；不能用 success:true 冒充 carrier ready；房间凭据不链接生产 |
| A6 FLY-2893 | 用 evidence CSV 中一条 turn mismatch 和一条 snapshot mismatch 的原状态在房间重建 | 所有 replay 行仍可追溯原 exec/event；A1 路由消除换体，无法核验的 snapshot 保留问题而不造 thread | 旧统计64、新统计62/100 不混成修后改善率；不声称修了额度/接管所有类 |
| A7 账号与迁移 | 原体 A 工作中授权切 B、同号重登、切换四个提交窗口重启宿主/Bridge；旧 Bridge-owned active/parked 迁移 | 回合边界后原 exec/thread 实际使用 B，回执持久；重登不丢工作；旧体迁移仍同会话；TUI 与 daemon 均有精确绑定 | 未授权全局指针漂移不改绑定；旧代数/重复请求不重复换号；错账号、依赖版本缺失、失败切换保留同体等待 |
| A8 断线/重放 | Bridge 离线时产生边界与 mailbox 消费，丢一次 ACK 后恢复 | journal 连续补齐一次、消费不重复；body/phase/预算保持 | seq 缺洞、旧代数、伪 receipt、16MiB 上限、磁盘写失败不丢账冒成功 |

“每张单构造一次”按 A1–A6 交证据，其中 FLY-2893 是普查证据复现而非独立第六根因。A7/A8 是新架构必须补的风险验收，不能删掉原六单换成更容易的宿主 ping 测试。缺真实服务/529 权限时报告未验证，不能将单元绿当作可上线。

## 12. 设计交付清单

exploration.md、research.md、plan.md、冻结 evidence、Mermaid 源与本地渲染 SVG、founder-design.html（首屏决定+每节意见框+意见汇总）、评审有效 APPROVED receipt、发布 URL/HTTP/CSP 核验、Lead DESIGN-HTML ready 报告、progress cursor，均提交推送后才 complete phase_design_complete。不能以阶段完成终结常驻 goal；随后 park。

本轮设计变更不运行产品测试。图形本地渲染失败按两次上限保留源并标 DIAGRAM PENDING LOCAL RENDER，不上传远程渲染。HTML 零外部依赖，单一 nonced script，所有事件 addEventListener，path-scoped localStorage 与异常处理，复制失败有 execCommand fallback。每个拷贝片段首行严格为 `【页面意见汇总】FLY-2925`，意见不是批准。

## 13. 最新 Lead 约束、明确依赖差距与集成接口

Lead 对问题 `8221ee32-6265-4da8-b341-7e100b14926a` 的回复确认独立宿主为 founder 首选评估方向，保留可见可附着 TUI、FLY-2903 fence，并要求真实证明 mailbox、turn boundary、**account switch mid-turn**；FLY-2689 仅最小响应语义，FLY-2893 保持伞单。

同一回复要求 FLY-2902 的“每 runner 独立凭据副本；切号/重登不打断在飞体并平滑到达”。但指定 PR #1352 head `94bda21e956c40a1f36e3b733bb52eb57a0b7cae` 的当前 PR body 和计划 C1/C2/§6 明确是 per-account 槽、process_resume 回 orig、切号只影响新体。**源代码不是推翻 Lead 行为要求的授权；当前原槽实现仅是已观察依赖，不能当最终验收目标。**

已提出精确冲突问题 `7857ee31-e7fb-4646-b347-90828345c9eb`。遵从 Lead 随后要求继续评审，当前计划按其明确的产品行为设计接口；等待其指定满足该接口的上游版本/补齐归属。设计可评审不等于依赖已实现；本单不声称当前 #1352 已满足，也不在 FLY-2925 重做凭据布局。

宿主需预留受引擎授权的 `credential-change` 操作（不是网络断线/Bridge 重启的隐式换号），目标接口要求：绑定 requestId、exec、expected process generation、old/new credential binding、credential change generation 和原 thread；待当前安全边界后应用；持久区分 requested/applied/model-observed；模型实际请求对应新账号才完成回执。期间所有邮件保留，原 exec/thread/goal/预算不变；重复/迟到/旧代际操作拒绝，失败保留可诊断的同体等待。上下游对有效 credential binding 的来源必须一致，不能永久按 birth slot 覆盖已批准切号。具体槽/副本物理操作委托裁定后的 FLY-2902 接口。

A7 最终还必须增加“在飞回合中切号→正确边界后原会话实际采用新凭据→回执落库→宿主/Bridge 各重启一次仍同绑定”及重复切号/失败恢复负控；仅证明 A 留 A、新体 B 不满足本次 Lead 约束。缺少该上游接口时视为前置依赖未满足，不能静默降为只切新体。


### 13.1 上游能力准入与切换步骤

宿主启动依赖注入的 CredentialProviderV1（具体物理布局由账号工作归属方实现）：

```typescript
interface CredentialProviderV1 {
  capabilities(): { version: 1; perExecutionIsolation: true; inFlightSwitch: true };
  readEffective(executionId: string): Promise<CredentialBinding>;
  applyAtBoundary(request: CredentialChangeRequest): Promise<CredentialApplyReceipt>;
  reconcilePending(executionId: string): Promise<CredentialApplyReceipt | null>;
}
interface CredentialBinding {
  executionId: string;
  bindingId: string;
  generation: number;
  accountIdentityDigest: string;
  homeReference: string;
}
interface CredentialChangeRequest {
  requestId: string;
  engineReceiptId: string;
  executionId: string;
  expectedProcessGeneration: number;
  expectedCredentialGeneration: number;
  targetBindingId: string;
  nativeThreadId: string;
  completedTurnId: string;
}
interface CredentialApplyReceipt {
  requestId: string;
  state: "applied" | "refused" | "pending";
  effective: CredentialBinding;
  reason?: string;
}
```

上游必须以实际能力+接口集成测试证明这两个 true，不能仅填 capability 名称。宿主不能从 `.active-slot` 自行实现上述 apply。操作步骤：收到当前引擎授权→持久 requested→把原 goal 置 paused 以阻止下一次自动续跑，允许当前回合完成→turn/completed 与事件写盘 barrier→重核终态/绑定→上游原子 apply→记录 applied→若原 daemon 无法确认重新读取凭据，以引擎授权的同会话物理重建执行，不让 goal runtime 自行换号→实际 account/read 身份及第一条新模型请求与新绑定相符后记录 model-observed→恢复原 goal 的剩余预算与合法需求。暂停不能中断在途模型工作；此语义由 A7 真台架证明，当前协议不支持则不能启用。

重登同号也用该代际通道，不能覆盖共享其他执行的凭据。applied 后、observed 前崩溃由 reconcilePending 返回原 receipt 再核实际身份，不能再次 apply 或退回旧账号。record requested 后 apply 前崩溃只在引擎授权仍有效时续做。关闭任意时点到达都优先 stop，保留已应用凭据回执供清理；不为完成切换再拉起已结束的体。

依赖补齐与宿主行为验收是实现/QA 的硬退出条件；选择独立架构不允许把它们降为 non-blocking Follow-up。此设计阶段只定义并核查接口，不执行真实账号变更。
