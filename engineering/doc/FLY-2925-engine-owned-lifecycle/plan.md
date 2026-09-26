# FLY-2925 引擎统一体生命周期 — 实施计划
Issue: FLY-2925 (https://linear.app/geoforge3d/issue/FLY-2925/病根修复-7-codex-体生死只认引擎一侧goal-结束不等于死引擎终结后-goal-不得自续重启只按原会话续接6-张-43)
日期: 2026-09-26
基于: research.md

状态：待设计评审；按本次重开交接裁定沿用 FLY-2902 已批准钉槽合同（§13）。基线 fdd1b404d；这是设计，未实现、未部署、未完成真实验收。

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
| 账号隔离 | 复用 FLY-2902 按账号钉槽；宿主和可见 TUI 使用该 execution 的原槽，槽模式不写凭据副本 | A 体工作中切默认号到 B，A 体及其重启仍用 A，新体用 B；同号重登不打断在飞工作，保留实际账号与切号回执 |
| goal | 同一 thread 的目标、用量、预算及手工暂停保持不变 | 比较前后原生 goal 状态与消费；不重发 objective 清零 |
| 可见终端 | 同一 exec 的 `runner-*` remote TUI，绑定宿主的实际 thread | 截图+可附着验证；空 pane、只活后台均不算 online |
| phase 停驻 | 现有完成/park/wake 持久记录，由宿主继续消费 | 无需求不恢复；同 wake 重放零重复输入；TURN 仍由引擎授予 |
| 明确终结 | FLY-2903 停止、排空、精确进程清理，补跨进程 owner 识别 | 真关闭/断线竞态，终结后没有新 daemon 或模型回合 |

账号行为以本次重开交接的最新 Lead 裁定为准：FLY-2902 已批准 plan 是权威，槽模式不写副本、在飞 runner 不换号。独立宿主不依赖在飞换号，不能把旧稿提出的扩展接口冒充已有能力；若实现发现必须依赖该能力，按 §13 显式报依赖，不在本单自行重做凭据布局。

## 3. 身份与权威：复用现有模型

| 数据 | 单一权威 / 用途 | 禁止的推导 |
|---|---|---|
| run/node/attempt/activation/execution_id | StateStore 当前工作流绑定 | 不从窗口名、cwd、issue 标题认领 |
| process-body generation/state/current_demand_id/owner_claim_id | FLY-2808 现有 `workflow_execution_process_body` | Bridge 重连不增加 generation；只有物理重建才增代 |
| threadId、resolved model/effort、cwd/worktree identity、manifest digest | 冻结启动及 resume manifest，与原生响应核对 | 空 ID 不退回 thread/start；模型自述不是身份证据 |
| codex_execution_credential_slot / credentialSlotOrig | FLY-2902 首次准入的持久原槽；legacy 仅按其迁移回执解析 | 不用当前全局活跃槽猜，不为在飞体重钉到新号 |
| engine terminal/close intent | sessions/工作流终态和 FLY-2903 关闭账本 | goal blocked/complete、socket 断开、宿主退出都不是该字段的写权限 |
| host identity / socket / start identity / event cursor | 扩展现有 exec session manifest；只作为载体定位与观察 | 文件存在不能证明进程活；进程活不能证明有工作权限 |
| native goal status / wait reason | 宿主持久观察事件及既有 session event 投影 | 不直接写 session terminal、不给 successor 授权 |

扩展 `session.json` 为显式 `hostProtocolVersion:1`，保存 host pid/start identity、endpoint、exec、process generation、threadId、manifest digest、binary release path 和 engine event ACK cursor。账号秘密、ingest token 不写事件/HTML/命令行；原槽凭据链接由 FLY-2902 受管 home 和 launcher 提供，宿主仅接收不含秘密的原槽引用和准入回执。原子临时文件+rename，0600，拒绝 symlink/越界路径；字段严格校验。旧 manifest 不猜新字段。

**不新增一套工作流状态机**。body 仍用 active/retiring/standby/resuming/resume_failed/closed。等待仅是工作观察，不冒充 phase complete。展示优先级为 engine closed → identity/problem → waiting → working；未知不涂绿色。

## 4. 独立宿主合同与重连

### 4.1 包装边界

新增 `packages/teamlead/src/runner-host/codex-runner-host.ts` 与 `codex-runner-host-protocol.ts`；宿主依赖现有 claude-runner，不反向让 claude-runner 导入 teamlead。从 `CodexTmuxAdapter.execute` 提取执行逻辑到 `packages/claude-runner/src/codex-runner-session.ts`，由 adapter 的宿主客户端与宿主入口共享类型，不能复制两个 goal loop。

宿主包含现有 daemon runtime、goal loop、turn/phase consumers、mailbox intake、心跳、可见 TUI 和清理。Bridge 留 admission、TURN、引擎推进、关闭决定、事件接收和 reconnect proxy。`ExecuteContext` 中的函数不可 JSON 化：逐个替换为命名能力，manifest 仅传值；宿主使用 CommDB.openExistingWriter（已存在库的无迁移写入口，见 §4.5）和引擎只读 authority reader，向 Bridge 写状态走现有认证事件入口。缺能力拒绝启动，不能吞掉闭包造成静默无邮件。

宿主经现有 tmux/cmux 受管 launcher 独立启动，不能以 Bridge stdin/IPC channel 生存为前提。使用本单 W1 新增的、独立于可变 checkout 的发布快照（§4.4），不是假定生产已有 release/symlink 部署。launcher 从已验证快照的绝对路径启动，Bridge 重连握手检查协议兼容。Bridge 普通 shutdown 只关 proxy、保留宿主；issue 终结、显式关闭和批准 standby retirement 才发 stop。

宿主使用独立 detached 进程组，标准输入不接 Bridge；日志写受管执行目录。它不与可见 TUI 共用 pane 的进程生命周期：TUI 关闭只记显示缺失并由宿主重建同一 exec/thread 的窗口，不能 stop daemon。执行和 phase hold 期间仍必须有 founder 可附着的真实 runner-* TUI；后台存活而窗口缺失为降级缺陷，不报 online。只有引擎关闭才结束宿主。post-merge.ts、tmux-lookup.ts、BridgeEventLoopGuard.ts、cmux cleanup/keeper、workflowTmuxWindowAuthority prune 必须按当前引擎绑定与 host manifest 判定窗口，不能从 pane/PID 缺失推导执行死亡。

引擎 authority reader 是新增窄只读模块，禁止构造 StateStore（其构造会做 DDL）。以 readonly + query_only 连接既有数据库，使用明确列、参数绑定、短读事务；不复制活库，不设 immutable=1 忽略 WAL。N 与 N+1 保持此查询合同向后兼容，先加列后使用；不兼容 schema 读失败则停止新输入、暂停原生 goal 并显示原因。移除旧列必须等引用该 reader 版本的宿主排空。跨版本测试运行 N reader 对 N+1 迁移后的隔离库，包含关闭记录读取与拒绝未知 schema。

### 4.2 控制与事件

宿主专属本地 Unix socket 复用 daemonSocketDir 的短根 + exec/generation 哈希，启动前用 assertSocketPathFitsSunLen 校验完整 UTF-8 字节长，父目录 0700、socket 0600，manifest 保存精确映射；不得把完整 worktree/home 拼进 sun_path。不是公网管理端口。请求 schema：`{v:1, requestId, executionId, generation, operation, expectedThreadId, engineReceiptId}`。operation 只允许 inspect、attach、stop、deliver、resume；本版不开放 credential-change；inspect 不变更状态，attach 不发送业务输入。所有变更必须核对 StateStore/CommDB 的对应需求/关闭/邮箱记录、当前代数及绑定；不把 bearer token 或同 UID 当成额外引擎授权。现有同 UID 运行信任边界不因此升级为恶意同用户隔离保证。

响应包含精确 host/thread/generation 观察、结果与 requestId。命令按 `(exec,generation,requestId)` 去重。deliver 复用 mailbox 原 message/wake 身份，不自建第二套消费语义；“已接收”与“模型已消费”分开。

宿主的 session/turn 事件写每体追加 journal：`{v, exec, generation, seq, eventId, type, payload}`，fsync 后才算已记录；eventId 为 exec+generation+seq，seq 单调。Bridge 用现有 event_id 唯一键落库，再返回连续 ACK；缺号先补齐，重复事件不二次推进，旧代数仅审计不改变新体。host transport ACK 不推进 mailbox 的 consumed。journal 上限 16MiB 未 ACK 数据，达上限在回合边界暂停并显示 event_backlog_full；不丢边界事件、不无限增长。ACK 后保留最后确认 cursor 和未 ACK 段，原子轮换；崩溃中途可从最后完整行恢复，截断尾行记诊断。

### 4.3 Bridge 重启（体仍活着）

1. 从当前引擎绑定找 exec，检查非终态、process-body 与 manifest。
2. 验证宿主 start identity/endpoint 的对应关系，握手返回精确 exec/generation/thread；窗口列表只用于显示和定位，不能单独授权。
3. attach 订阅已有 journal，核对当前 native turn，补齐事件和邮箱 cursor。活跃回合不能被陈旧 CommDB active_turn_id 覆盖；只接受该宿主记录、相同 native turn 身份的补写，存在冲突则 hold 呈现证据，不抛“恢复提交后失败”并判死。
4. exec、thread、process generation、账号槽、目标/预算全部不变；**不调用 commitCodexRecovery、goal/set active、thread/start 或恢复 kick**。
5. 若只是显示窗口不在，由宿主重开绑定同 daemon/thread 的 TUI；不能因此重启 daemon。

Bridge 离线时，已有宿主继续当前被授予的工作和本地邮箱/phase 控制。引擎只读状态可用才允许新的恢复/激活；仅 Bridge 网络断开不使当前体终结。authority 数据库打不开/身份不明时停止新输入并暂停 goal；明确关闭则 stop。宿主自身 daemon 死亡不在 Bridge 不可用时自行铸新进程，保留故障等引擎恢复命令。

### 4.4 发布快照是新增交付物，不是已有前提（R1 HIGH）

当前 update-flywheel.sh 对主 checkout 做 ff-only merge，restart-services.sh 原地 pnpm build；teamlead build 会删/复制 dist，claude-runner tsc 覆盖 dist。本机 standing-authority/active-package.json 不存在，不能把 FLY-2654 名称当运行保证。**保留 Bridge 的现有部署方式，为长驻宿主单独新增可验证运行快照**。

W1 交付 `scripts/build-codex-host-release.mjs`、`scripts/lib/codex-host-release.mjs` 及受管 launcher。构建产物位于 `<state>/codex-host-releases/<content-digest>/`，先写同盘 staging，验证完成后原子 rename，不从运行目录构建或覆盖。快照 manifest 含 source SHA、lockfile hash、平台/架构、Node ABI、全部文件 hash、入口/协议版本、构建工具版本。收集 teamlead 宿主入口、claude-runner/comm/config/core 及全部递归 workspace/runtime dependencies 的 dist/package.json、bin/agents/assets/被调用 scripts 与 CLI；包含闭合 node_modules、better-sqlite3 原生模块和所需动态库。Node 可执行文件与受管 Codex 可执行文件也复制或钉到受本快照 GC 保护的内容寻址不可变载体，记录真实路径/hash/ABI；不得指向 Homebrew current 或可变 shim。内部 symlink 可保留但 realpath 必须仍在快照内；禁止指回 checkout、pnpm 全局 store 或可变 node_modules，禁止与可变源使用硬链接。普通复制或经核验的写时复制均可。不得打包 auth、home、DB、环境密钥或任务 worktree。

快照检查从 staging 的独立环境运行：清掉 NODE_PATH/开发回退，解析每个依赖和动态 import，加载原生 SQLite 并只在临时测试库读写，检查脚本的间接 source/exec 目标闭包。所有 runtime 路径经快照 manifest 解析，`FLYWHEEL_COMM_CLI`、guard/launcher 子脚本和动态 import 都钉快照；任务 cwd 仍为 worktree，cwd 不作为运行代码搜索根。未知/逃出闭包的动态路径拒绝发布，不能以“多数模块已载入内存”通过。只读快照文件防止意外改写，不宣称同 UID 对抗隔离。

启动前在 release registry 事务登记 `(releaseDigest, exec, spawnAttemptId, generation)` 的 pending 引用；启动后以同一 attempt CAS 补入实际 pid/start identity，握手验证后变 active。pending 也阻止 GC；崩溃后逐个核实际进程才能清除，不能因尚无 start identity 就当未启动。失败释放引用必须先证明未存活。重连使用 manifest 固定 digest，不使用 latest 指针替换运行体。GC 先取得与 admission 共用的锁，交叉核对精确进程、host manifest、standby/resuming 原会话所需版本、回滚基线与未完成 rollout；缺证据/未知存活一律保留。只有没有这些引用且超过 24h 的快照可删除；崩溃遗留引用须先核实对应载体已结束。删除临时 staging 同样不能碰已发布/被引用目录。

初始预算明确为宿主快照根总计 12GiB（含 staging），创建后文件系统须保留至少 8GiB 可用；这两个数是可配置保护上限而非实测大小。构建前预估、复制中累计、完成后实测均检查；空间不足时只回收可证明无引用的旧快照，否则拒绝本次发布和新宿主 admission，保留旧体继续，向 Lead 报实际字节与超限原因。不得为凑预算删在用 release。529 记录实际快照大小与保留集，必要调整预算须显式配置并记录。

A1 必须在宿主执行期间对隔离生产形状 checkout 做一次**实际 ff-only merge + 原地 build + Bridge stop/start**，让宿主在 dist 删除/覆盖窗口触发此前未加载的动态 import 和 CLI 子命令；证明读取路径均为旧 digest、原 native 模块正常、原 exec/thread/账号不变。不能用仅发 SIGTERM/重启 Bridge 的测试代替班车。

### 4.5 最旧在用快照的跨版本合同（R2 HIGH）

固定运行字节解决构建覆盖，但不允许把兼容责任推给旧体。以下合同是 W1/W4 的一部分：

| 接触面 | 固定与演进规则 | 核验与失败行为 |
|---|---|---|
| 模型调用的 flywheel-comm | CLI 与宿主一起固定，防 CLI 在 build 中被删除；请求带 cliContractVersion + releaseDigest，Bridge 保留最旧在用版本的命令/端点/参数/响应及错误语义 | complete/qa-result/gate/ask/check/turn/park/progress 等**实际清单**在快照构建时从命令注册器/请求消费者提取；HTTP 成功不冒充旧 CLI 可解释的有效 receipt，保留旧响应适配器 |
| CommDB 读写 | 宿主与该 CLI 所有库打开路径必须用 openReadonly/openExistingWriter；严禁调用会做 SCHEMA/applyMigrations/purge 的构造器 | 复用 db.ts 现有无迁移入口，加 writerContractVersion 校验与事务内版本围栏；只读元数据检查不执行 DDL。只由当前 Bridge 的受控启动迁移者执行迁移 |
| turn/mail/goal/phase 事件、settlement 回执 | schema 和语义都按 eventContractVersion 标识；兼容窗口内保持消费唯一性、ACK/consumed 区分、终结/TURN 权限不变量 | 新必填字段须有服务端可证明的旧格式适配，不能填默认授权；未知事件持久保留且不推进工作流，不能 ACK 后丢弃 |
| 宿主 socket/Bridge proxy | hostProtocolVersion 是协议族，不是孤立的“1==1”检查；双方声明 supported ranges 与 required capabilities | 握手无交集时拒绝 attach/新输入，保留 exec/thread、事件/邮件，显示 compatibility_hold；不能回退旧 reown 或重新 admission |
| 原生 Codex/Node/SQLite ABI | 固定当前运行版本；显式受管升级换到经过验证的兼容快照 | 保留原 thread/home/账号/预算，按下述 upgrade receipt 执行；不能无限等旧 binary 重新被服务端接受 |

**兼容清单与部署门。** 每个快照 manifest 增加准确 CLI 命令/HTTP consumer 清单、CommDB writer/read contract、事件/回执 contract、host protocol、原生 binary/profile 与 ABI。版本号仅是索引，证据是兼容适配代码与双版本验收。release registry 中 active、pending、standby、resuming、rollback-pin、upgrade-in-progress 都计入“在用”，不因最近没心跳就剔除。Bridge 候选产物须携带支持清单；部署守卫在 pre-merge/pre-stop 和任何 DB 迁移前，比较全部在用快照，拒绝删除或破坏最旧在用合同。持发布锁冻结清单，admission/恢复也用同一版本门，避免检查后冒出旧 consumer。未知清单拒绝部署，不静默忽略；新版本可选择保留旧适配器，或先由引擎受控升级并排空引用再移除。

**旧写入者与迁移不能仅凭列还在就算兼容。** `CommDB.openExistingWriter` 已存在，但今天仅检查 mailbox generation，W1 必须扩展为在每个同步写事务取得 SQLite 写锁后核 `writerContractVersion`/迁移状态，再做原有 DML；版本检查与写入同一事务，不在库打开时检查一次后永久放行。当前迁移者以同一写锁发布 supportedWriterContracts 与迁移状态；兼容迁移保留旧写语义，新消费/settlement 不变量必须有兼容适配/trigger 等落实与反例测试，否则不能把旧版本列入支持集合。不兼容迁移先拒绝部署，不能先改变 schema 再让旧体发现。宿主/CLI 写入拒绝或 busy 保留原 requestId/deliveryId、退回可重试等待，不能重发新身份、丢信或伪造交卷。旧快照没有无迁移入口或事务围栏时，不能加入受支持宿主集。

FLY-1914 消费者 sweep 新增 `<state>/codex-host-releases` 的全部在用 manifest 和实际封存 CLI/scripts 为必查 root（含 standby 和回滚保留版本）；仓库/插件缓存零引用不能取代此项。给出扫描时间、release digest、引用 execution 与命令/端点处置。缺 manifest/不可读快照标“未检查”并拒绝破坏性变更，不能写零引用。

**不兼容握手与临时 hold。** 独立关闭 reader 不依赖握手成功，继续观察引擎关闭并 stop；协议不兼容期间不消费新业务输入、不推进事件 ACK 或 mailbox consumed，事件继续持久化直到既定上限。可暂停原生自动 goal，使用 `compatibility_hold` latch 记录施加前状态/exec/thread/generation；Bridge 通过兼容版本重新连接或引擎授权升级后才能解除，不能把 handshake timeout 当死亡。最旧关闭-reader 合同也在部署门里，不能先破坏它再期望旧宿主自行停机。

**原会话受控升级（含服务端提高最低 Codex 版本）。** 结构化最低版本错误或经 Lead 核实的版本不可用事件触发引擎 `carrier_upgrade` 操作；普通 400 文案不自动授权。请求绑定 exec/activation、原 thread、当前 generation、old/new release digest、目标 binary hash、原账号槽、持久 requestId 和有效需求；目标须通过兼容清单/原生会话格式验收。当前回合能完成则等边界；已被服务端拒绝时在原回合终态边界保留失败证据。写 upgrade intent、保存目标/用量/预算/手工 pause/gate/邮箱游标，用专属 latch 暂停自动 goal，排空观察后受控停旧 daemon；证实旧进程组/监听退出，才由同一 process-body claim 增代，用新二进制 thread/resume 精确原 thread。先核身份与保留状态再接受合法输入，不重设 objective、不清预算、不换账号、不新建 execution/thread。显式升级不是 Bridge 普通重连，后者仍禁止 goal/set active 或换版本。

升级按 requested→old_stopped→new_verified 持久推进，同 requestId 重放不重复停/启；关闭在任何窗口优先。失败保留原体等待，若旧版本仍受服务端支持且会话格式可逆，可凭同一引擎操作回原版本精确续接；否则不假回滚，不新建对话。目标格式/协议无法保留会话时明确 upgrade_blocked，报告依赖修复。standby 无模型工作可在下一次合法恢复需求时选择已验证的兼容新快照，用相同升级回执转移引用；当前版本不支持则保留原快照，不因保留成本偷删。

新增 A9：在旧宿主及停驻体存在时，529 部署一次**实际改 CLI/HTTP、CommDB 列与写语义、事件 payload 的兼容版本**。旧 CLI 的真实 gate/check/ask/complete（专用可交卷测试体）仍获正确回执；旧写入者不执行迁移、新库消费唯一性与 settlement 不变量不破坏；旧事件补齐无重复推进。再部署删除旧端点/破坏旧写语义的候选，必须在 merge/stop/migrate 前被挡住；伪造兼容声明但语义错误须被双版本测试反例发现。另测不兼容 handshake、临时读失败恢复、强制最低版本错误及受控升级每个崩溃窗口；最后真实模型在原 thread 使用新版本完成后续任务。跨版本 smoke 必须运行封存旧 CLI 和 writer 代码，不能只模拟相同版本客户端。

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

确证旧进程组和监听端点已退出后才能增代、恢复 lease。`process_resume` 使用 FLY-2902 的 `credentialSlotOrig`，恢复首次绑定的原槽。legacy 无记录必须经其明确迁移回执解析，否则拒绝。原 home 已被其他槽占用按 `credential_slot_resume_conflict` 拒绝；不能删 home 检查或用当前活跃号猜测。

启动新宿主并 `thread/resume` **精确原 thread**，比较响应 ID、cwd、resolved model/effort、home/槽、worktree identity。继承已有真实上下文和 goal，用现有暂停/hold 守卫先阻止业务输入，验证通过才接需求。能力不支持“核身份前不自动工作”时此次恢复失败并告警，不能先执行后核验。

原 thread 不存在/损坏/响应空或错、旧代数、家冲突 ⇒ resume_failed，保留执行体/证据、停止已创建的错误载体；不新建 thread，不隐式 fallback。瞬态连接故障最多沿 FLY-2808 原会话尝试 2 次，只有清理已确认才第二次。纯 Bridge restart 绝不走 resume_fallback；独立的合法 phase demand 若沿 FLY-2808 有显式 fallback receipt，保留原规则并显示上下文损失，不能把它算作本单“原会话恢复成功”。

### 6.1 活 daemon 接管是新增路径（N 兼容版先交付）

当前 spawnCodexDaemon 只有 spawn/reap，不能拿它充当 attach。新增 `adoptCodexDaemon` 的独立 handle：不 spawn、不 unlink socket、不 reap；清理方法仍复用 FLY-2903 的精确 PGID/socket/start identity 证明。由引擎 CAS owner claim + daemon socket singleton lock 共同排他。N-1→N 时旧 Bridge 已停，必须同时确认旧 owner PID/start identity 已消失、原 daemon/endpoint/home/thread 对应一致；仅“Bridge Map 没 owner”不够。旧 lock holder 确证死亡后原子转移锁记录给新控制者，保持 daemon 存活，不经过 spawn 的 orphan-reap 分支。旧 holder 活着/身份不明则 hold，禁止抢锁；并发接管者只有一个可拿 claim/lock。

接管先订阅并缓冲通知，再 `thread/read(includeTurns)` + goal/get，合并原生 turnId/status 与缓冲事件，再读一次收敛交错；不发送 thread/start、goal/set active 或恢复 kick。缺失的 started/completed 只用原生读到的同一个 turnId 补观察，标 `reconciled_from_native`，不假装是实时通知。恢复 turn barrier 时对照 CommDB 的已持久 turn/mail/wake 身份；已完成回合只幂等关闭其 barrier，不倒退当前回合，不解除原 gate/手工暂停。仍在进行的回合继续，同步边界证明齐全之前不注入新邮件。

在途 steer/投信按原 messageId/clientUserMessageId 查询原生 item 和既有 durable injection 账：能证明已出现则补 transport receipt（不能因此补 model-consumed）；能证明未提交且原请求已结束才沿原 delivery id 重发；结果不明标 delivery_unresolved，保留邮件并等待边界核对/Lead 纠正，禁止靠正文相同推断或盲重投。证据缺失不换体、不判死、不伪造收到。协议若不能给出足够快照/事件以还原边界，阻止迁移完成并报告限制；529 必须证明实际版本支持，设计不将此能力假定为现成。

宿主崩溃、daemon 仍活也走上述接管；只重建控制者并记录 owner 更替，原 daemon body generation 不变。物理 daemon 确证消失才走 §6 的原会话 resume。迁移旧 Bridge 控制者到宿主使用同一接管算法，N 版可在明确边界主动转移；首发从 N-1 接管不能要求旧代码配合 flush。

### 6.2 carrier_lost 与旧体登记

扩展现有 StateStore 引擎事务，不绕过 beginWorkflowExecutionResume 的状态检查：在当前 execution/activation/非终态匹配、精确 carrier death 证据成立时，按 `(exec, generation, deathEvidenceId)` 唯一键登记 carrier_lost 需求与观察。若现有工作/phase 需求仍有效，引用其 demandId；仅引擎可为尚未完成的当前工作创建恢复需求，并关联原需求，宿主不能提供任意 demandId。active 经 CAS 写 `resume_failed(reason=carrier_lost_confirmed)`，随后复用同一 resume claim 流程；没有合法工作需求则登记等待、保持 standby，不启动模型。关闭优先、陈旧 generation/重复死亡事件不重复增代。

flag 关闭时准入、没有 body 行的 legacy Codex，N 版只在核实 frozen launch + 当前 engine binding + 原 thread/home/credential-slot 后，以唯一 execution_id 在同一事务补登记实际 active/standby 和 manifest 所载代数；旧 manifest 无代数用明确的 legacy enrollment receipt 初始化 1（符合现有 CHECK generation > 0）；有合法代数原样保留，不从窗口猜，existing row 冲突拒绝。这项迁移只登记既有体，不创建新 execution 或请求；无法核实则 migration_required。测试包括缺记录、并发登记、active 死亡、重复 evidence、无需求、旧代数、关闭交错。

**删除项**：`CodexSessionReowner.beginRecovery` 的新 rescue-owner 业务启动、recovery commit 后 reconcile 判死、恢复时泛用 startInitialTurn/kick；将 reowner 收敛为精确重连/委托 process resume，不再另建恢复状态机。保留被其他初始启动消费者需要的 launch commit；不要全局删掉 turn/start。

## 7. FLY-2903 复用与跨进程终结

PR #1343 已合入本基线。继续用它的 stop/drain、精确 PGID/socket/start identity、终态 sweep 和 token 账本；不重建相同组件。

Bridge 先持久化 engine 关闭事实，关闭请求绑定 exec/generation；本地 owner registry 中宿主 proxy 的 requestStop 转发给宿主。宿主在处理请求、每次恢复、每次解除等待、每次发送输入前以及每个 turn/started、turn/completed 边界读最新引擎状态；另以不重叠的 1s 轮询覆盖 app-server 原生 goal 无宿主输入而自续的窗口。读到关闭立即 stop/drain，先请求暂停原生 goal 并中断在途回合；读失败亦停止新输入并请求暂停，不假定断 Bridge 后无关闭。关闭转发只是加速器，不是唯一触发。无法暂停/断线时按 FLY-2903 的授权精确清理收口；记录关闭写入、观察、停止及 token 增量时点，1s 是轮询目标而非瞬时零消耗保证。宿主将 stopRequested 同步置位并调用 runtime.stop；晚到的 transport-death catch 不得越过该位。关闭途中崩溃后只可恢复清理，不能恢复工作。

宿主因 authority 读取失败施加的暂停单独记 `authority_read_hold`：落盘施加前 goal 状态、exec/thread/generation、当时有效 demand 与 pause 原因集合。读恢复后重核当前引擎非终态、同一需求/身份仍有效、无用户/gate/budget/其他 hold，且该 latch 独占本次暂停来源，才以同一持久 latch 幂等解除并恢复原 active；任何归因不明等明确纠正授权。解除属于原需求下技术 hold 的恢复，不是 Bridge reconnect 本身的授权。用户原先 paused 或期间新增手工 pause 不得解除；在暂停/记录之间崩溃先核原生状态，不能推测恢复。A9 包含短暂读失败后继续、并发手工暂停仍暂停。

新宿主必须显式提供 restart gate；resident 模式缺 gate 视为拒绝，不继承当前“缺 predicate 默认 true”。所有物理恢复授权统一由引擎 claim 给出，runtime 不私自循环 spawn。引擎关闭拒绝优先于任何 reconnect/retry/phase wake。

`codex-terminal-sweep` 的 owner 判断改成识别经握手核验的外部宿主，不能把“Bridge Map 没 owner”当无 owner。无响应/身份未知不误杀别的进程；仍可按 FLY-2903 已有精确进程证据执行授权清理。超时写 timeout/unverifiable，后续维护重试；不声称 closed。终态后不得出现新 spawn/resume；在途操作可能有有限排空消耗，报告原始时点和 token 增量，不能以采样没看到就宣称瞬时零消耗。

## 8. FLY-2689：启动返回值跟引擎事实一致

保留 lease missing 的准入拒绝和错误码；失败不制造已在线证据。`runs-route.ts` 先由引擎是否已提交 run admission 决定返回：未建立 run 为原 4xx/5xx；已经建立且将继续推进为 HTTP 202、`success:true`、`runId`、`executionId`、`launchState:"pending"|"waiting"`、结构化原因和查询位置。ready 为既有成功响应。`retryable:false` 如保留必须仅表示“不要重复 POST 已接纳的 run”，不能表示 run 已失败。

引擎已终结则返回对应终态事实，不写 success:true。查询和启动响应共用 run projection，提交后的未知启动观察不否定 run。所有消费者按 launchState 判 ready，不按 success 判进程在线；sweep `runs-route.dag-entry.test.ts`、Lead 工具/启动 action、`scripts/inject-linear-issue.sh` 及其他 `/api/runs/start` 字面匹配。禁止顺便重构全部 admission 或放松凭据守卫。

## 9. 两步上线、首次迁移与回滚下限（R1 HIGH）

本节是未来独立 updater 的发布步骤，不授权设计节点部署。**N-1 是现网旧版，N 是兼容版，N+1 才启用宿主**；不能把同一次发布中先后执行的两行配置当成两步上线。两版各有独立 build SHA、评审/QA 和 updater 健康回执。

1. **N 交付但不开放宿主 admission。** 先实现 §4.4 快照工具、§6.1 活 daemon 接管、旧体登记、外部宿主识别/协议与关闭兼容、窗口清理保护、回滚下限检查。reowner/terminal sweep 启动扫描前先读取 carrier kind/manifest；host-owned 或接管状态已登记的体不得走旧 reap/revive，即使暂时握手失败也只能观察/hold。N 保持创建新独立宿主的开关关闭，Bridge 可以接管原 daemon 继续控制；识别宿主不依赖 admission 开关。
2. **真实 N-1→N。** N-1 不会 flush 或交接，updater 停旧 Bridge 后原 daemon 可能仍在回合中。N 启动先保持 Codex adoption/reowner/相关 sweep 关闭，只做只读盘点并完成 Bridge 健康检查；不写 N-1 不懂的所有权/body 状态。健康通过并持久 known-good 回执后，才执行 §6.1 的订阅/原生快照/投信账核对，再开放该体的输入；在所有 active/gate-held/phase-parked 体完成登记之前不启用宿主。证据不全显示 migration_required，保留原体不新建对话。健康回执标识可回滚的 N 服务版本；接管验收回执另记，不把健康通过等同迁移完成。N 健康前失败仍按现有部署回 N-1，旧 daemon 无控制者的空窗与现状一致，不声称该失败路径已获宿主连续运行保证。
3. **外置回滚守卫先安装，再改变所有权。** W1/W4 在受管 Bridge 启动入口与 updater 的 pre-merge、pre-stop、rollback_and_restart（reset 前）接入同一只读兼容检查，守卫可执行文件取自 N 的受保护快照，状态位于 checkout 外的 `<state>/codex-host-rollout.json`。记录 protocol、最低兼容 SHA/digest、rollout phase、迁移执行清单、已知可用回滚 SHA；原子写入、严格 schema、未知/损坏拒绝不兼容启动，不是授权票据。安装守卫本身走既有受管部署，不手改 launchd。N 健康并持久 known-good 后，首个旧体所有权迁移前才写 migration_started。此前失败允许自动回 N-1；此后失败保留 N 的兼容管理路径和原体，不能回不认识新状态的 N-1。两段都必须在 529 故障注入，不能提前写 known-good 或 migration_started。
4. **N+1 只在 N 已部署并冻结 known-good 后启用宿主。** 验证 FLY-2902 已合入并集成、快照闭包/协议可用、N 回滚入口确实能识别宿主，才转移控制与开放新宿主准入。N+1 的 updater 在 stop N Bridge **之前**调用 N 已提供的 prepare-transfer：在回合边界冻结新输入、落观察账、持久 transfer intent，随后停止 N（不杀 daemon）。原 daemon 在 build 间隙仍可推进原生回合，因此 N+1 启动后仍必须执行 §6.1 的双读/缓冲收敛，不能仅信停机前快照；然后转移独占 claim/lock。N 不提前开放新宿主 admission，N+1 宿主在新产物就绪后接管原 daemon，不能杀后换体。失败/崩溃由 transfer receipt 指明唯一控制者；源控制者尚持锁时不启动第二 controller，源已死亡时用 §6.1 接管。既有在飞体全部记入迁移分母，不能批量关闭换新体清账。
5. **回滚实际执行点必须受守卫约束。** 修改 update-flywheel.sh 的 pre-merge 和 restart-services.sh 的 rollback_and_restart，在任何 reset/build/start 前核 rollback SHA 的实际兼容 manifest 与已知可用 receipt，不能只比较版本号或相信 DEPLOYED_SHA。N+1 构建/健康失败可回 N（宿主 admission 关闭但能 attach/stop）；不兼容或早于 N 的目标拒绝。check 之后到 reset/start 之间以发布锁与冻结 receipt 防 TOCTOU；N 及以后受管 wrapper 在启动时再次核对。此承诺覆盖已接入守卫的自动部署路径；wrapper 仍位于 checkout，人工 reset 到 N-1 会把守卫一起撤掉，当前设计**不声称防住这种绕过**。见 §15 的非阻塞 Follow-up；在保护期内运维 runbook 禁止绕开受管回滚。回滚不能删除宿主 manifest/release、改 terminal_at，或把握手失败交给旧 reap/revive。未知状态停止部署并报警，原宿主继续已授权工作，不能为凑恢复绿而退 N-1。
6. **默认开仅作用于 Codex。** 将 node_standby_resume 的有效默认解析改为 vendor-aware：无显式值时 Codex 为 true、Claude 沿原 false；registry、所有 default fallback、admission snapshot 和运行 consumer 同步调整。显式配置仍按原优先级生效并冻结；不得让全局布尔默认悄悄首次启用 Claude 退下/恢复。宿主 admission 另受 N/N+1 发布阶段门约束，不能以 resume 默认开绕过兼容部署。测试 Claude 无设置时不新增 body、原有显式设置保持、Codex 默认新体登记、legacy 仅依 §6.2 迁移。
7. **删除旧恢复业务路径，保留兼容管理能力。** N+1 的所有正常重启/载体恢复不可达 recovery commit + kick；消费者 sweep 和相关测试证明删除闭包。N 回滚只允许原 daemon 接管/原 thread 恢复，不靠其旧恢复业务路径。保留历史审计表只读。协议/reader 旧版本的移除与快照 GC 都必须等引用体排空，不能以 latest 切换覆盖它们。

A7 从真实 N-1→N→N+1 进行；分别注入首次 N 接管前/后失败、N+1 build/health 失败、自动回滚 N、伪造/缺失守卫 receipt、请求回 N-1。证明旧体原 exec/thread 不变，回 N 后宿主仍可见可附着、可收信、可关停，旧 reown/sweep 不抢体。失败不能被隐藏为已完成迁移。

FLY-2902 已合入 main 且本分支集成其批准接口，是 W3 凭据接线及真实迁移的开工门：核实际 SHA、recordCredentialSlot/credentialSlotOrig/home admit/受管 launcher 消费者与相关集成测试；未满足可独立做 W1/W2，但 W3 不自行仿造账号表或布局。设计不授权离线凭据迁移或真实账号操作。

## 10. 实施工作块及文件闭包

每块遵循先写失败相关用例、单文件运行确认红、最小实现、相关测试与 related 确认绿、提交。不要在设计节点执行这些实现步骤。

| 块 | 变更与交付 | 正/负验收 |
|---|---|---|
| W1 宿主与可重连控制 | 新 `teamlead/src/runner-host/codex-runner-host{,-protocol}.ts`，新 `claude-runner/src/codex-runner-session.ts`；调整 `CodexTmuxAdapter.ts`、`codex-daemon-transport.ts`、package build/bin 导出、受管 launcher；新增 host release builder/registry/GC、快照闭包及保护预算（§4.4）、readonly authority reader、adoptCodexDaemon 独立接管 handle；序列化值/重建能力清单逐项覆盖 | Bridge 退出宿主继续；host 重启/旧协议/伪 endpoint/双 claim 拒绝；TUI 真可见；journal 断行、重复、缺号、ACK 丢失 |
| W2 生死分流 | `codex-daemon-client.ts`、`codex-daemon-adapter-helpers.ts`、`codex-daemon-goal-runtime.ts`、`event-route.ts` | blocked 可收信；complete 无交卷不推进；429 同体有界；400/unauthorized/手工暂停无盲重试；不清预算 |
| W3 原会话恢复与终结 | `codex-session-reown.ts`、`plugin.ts`、`codex-execution-ownership.ts`、`codex-daemon-teardown.ts`、`codex-terminal-sweep{,-runtime}.ts`、现有 workflow-process-retirement / rework 接口及 `StateStore.ts` process-body claim | active 重连不 commit/kick，standby 无需求不启动；FLY-2903 关闭 race；原账号槽；旧体迁移，错误身份拒绝；legacy enrollment/carrier_lost demand CAS、窗口清理消费者闭包 |
| W4 开关/API/真实验收 | §4.5 跨版本清单/部署门、FLY-1914 活快照 sweep、无迁移 writer 事务围栏；config vendor-aware default consumer，`runs-route.ts` 及其调用方；update-flywheel.sh、restart-services.sh、受管 Bridge wrapper 的外置兼容守卫/回滚下限；529 验收工件与文档 | 开关声明/运行时/冻结 admission 一致；FLY-2689 首体失败仍 run pending；六单与负控逐项通过 |

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
| A1 FLY-2586 | 真 Codex 做带分段标记的任务；按 §4.4 回合中实际 merge + 原地 build + 重启 slot Bridge，触发延迟 import/CLI；再在 gate-held、phase-parked 各重启一次 | 活体宿主 PID/start/thread/exec/槽不变；工作继续；恢复提交及 kick 计数 0；信件不重消费 | 伪窗口名、错误 thread、旧 manifest 不能 attach；daemon 确证消失才增代原会话恢复 |
| A2 FLY-2344 | 合法交卷受 409 拒后原生 goal blocked；随后投递带随机标记的纠正指令 | 无 session_failed/替身，原 thread 下一次输出实际回应标记，完成正确交卷 | 未解决的 gate 和手工 paused 不被普通 heartbeat 解开 |
| A3 FLY-2814 | 活动回合中引擎 terminate；在 stop 请求、transport death、daemon drain、Bridge 重启四个窗口注入竞态 | 关闭事实先落盘，0 次终态后 spawn/resume；精确进程组/监听消失，两个采样间无新 turn/token 增长；在途消耗单列 | 外观相似另一 exec 不被杀；未知 PID/start/socket 只告警；普通断网非 terminate |
| A4 FLY-2630 | 529 受控代理注入一次 capacity，再恢复真实模型；另造 429/5xx/400/unauthorized | 前三者原 exec/thread 有界重试并实际产生后续模型输出；后两者同体等待纠正 | 重试中关闭、重复错误、重启不重置预算/次数；未知错误不无限 retry |
| A5 FLY-2689 | 隔离夹具移走本体 lease，在首体 admission 时触发失败；引擎仍已接纳 run | API 返回已接纳+等待原因，GET 与事实一致；0 个无 lease 的 daemon；修复后走引擎允许路径 | run 未提交仍失败；不能用 success:true 冒充 carrier ready；房间凭据不链接生产 |
| A6 FLY-2893 | 用 evidence CSV 中一条 turn mismatch 和一条 snapshot mismatch 的原状态在房间重建 | 所有 replay 行仍可追溯原 exec/event；A1 路由消除换体，无法核验的 snapshot 保留问题而不造 thread | 旧统计64、新统计62/100 不混成修后改善率；不声称修了额度/接管所有类 |
| A7 账号与迁移 | 原体 A 工作中切新起跑默认号到 B、同号重登；随后分别重启宿主/Bridge；旧 Bridge-owned active/parked 迁移 | 原 exec/thread 仍实际使用 A，新体使用 B，切号回执与实际模型账号对应；重登不丢工作；旧体迁移仍同会话；TUI 与 daemon 均有精确绑定 | 全局指针漂移不改在飞绑定；错账号、原槽缺失/home 冲突、依赖版本缺失拒绝；隔离房遵循 FLY-2902 凭据操作权限，不写生产槽 |
| A8 断线/重放 | Bridge 离线时产生边界与 mailbox 消费，丢一次 ACK 后恢复 | journal 连续补齐一次、消费不重复；body/phase/预算保持 | seq 缺洞、旧代数、伪 receipt、16MiB 上限、磁盘写失败不丢账冒成功 |

A3 另强制注入“引擎关闭已落库、stop 尚未转发时 Bridge 崩溃”，原生 goal 自动开回合时也由宿主轮询/边界守卫停止；记录有限排空消耗，不宣称瞬时零 token。A7 必须包含 §9 的实际两步部署与所有失败回滚窗口，不能只测手工迁移函数。

“每张单构造一次”按 A1–A6 交证据，其中 FLY-2893 是普查证据复现而非独立第六根因。A7/A8 是新架构必须补的风险验收，不能删掉原六单换成更容易的宿主 ping 测试。缺真实服务/529 权限时报告未验证，不能将单元绿当作可上线。

## 12. 设计交付清单

exploration.md、research.md、plan.md、冻结 evidence、Mermaid 源与本地渲染 SVG、founder-design.html（首屏决定+每节意见框+意见汇总）、评审有效 APPROVED receipt、发布 URL/HTTP/CSP 核验、Lead DESIGN-HTML ready 报告、progress cursor，均提交推送后才 complete phase_design_complete。不能以阶段完成终结常驻 goal；随后 park。

本轮设计变更不运行产品测试。图形本地渲染失败按两次上限保留源并标 DIAGRAM PENDING LOCAL RENDER，不上传远程渲染。HTML 零外部依赖，单一 nonced script，所有事件 addEventListener，path-scoped localStorage 与异常处理，复制失败有 execCommand fallback。每个拷贝片段首行严格为 `【页面意见汇总】FLY-2925`，意见不是批准。

## 13. 重开交接裁定与账号依赖边界

2026-09-26 本次重开交接明确沿用 FLY-2902 已批准 plan：槽模式不写副本、在飞 runner 不换号，2925 不重做凭据布局。这一裁定取代旧执行体收到的在飞切号要求及旧稿 CredentialProviderV1 提案。保留已提交历史供审计，不把旧提案当实现门槛。

本次只读复核 `FLY-2902-codex-credential-isolation/plan.md` 的 C1/C2/§6：新执行选活跃槽；首次槽归属在 daemon 启动前持久化；`process_resume` 使用原槽；缺记录的 legacy 体只能由迁移回执解析；冲突 fail closed。宿主与 TUI 均复用此通路，不复制 auth 字节，不跟随当前全局指针改变在飞绑定。切默认号回执必须与“旧体仍 A、新体 B”的实际消费者证据对应，不宣称旧体也用了 B。

独立宿主本身不需要在飞 A→B 或每体凭据副本，所以本版不增加 credential-change 协议。如果实现/真实台架发现选定架构必须依赖它们，必须先报告显式依赖：缺失能力、负责上游、批准计划/版本、原 exec/thread 保持与应用/模型实际采用回执、崩溃与重复操作负控；未经该独立裁定不能启用依赖路径，也不能在 2925 偷做凭据系统。此条件不是当前已满足的能力声明。

保留的硬验收是 A7：在飞时切默认号及同号重登不丢工作，原槽恢复，切号回执，TUI 与 daemon 的实际绑定；A1–A6 六张原单和 A8 邮件/事件重放仍完整执行。FLY-2903 stop/restart fence 继续复用；FLY-2689 仅响应语义；FLY-2893 保持普查伞单。设计批准不等于 529 或生产验收通过。

## 14. R1 评审逐项处置与新增验证

有效 CHANGES_REQUESTED，request 9b8acb0b-8a17-4726-8d52-4e1eafef51ad，2 HIGH + 7 MEDIUM；未经新请求的有效 APPROVED 不发布。

| findingKey | 本次设计处置 | 实现/QA 证据要求 |
|---|---|---|
| immutable-release-premise-absent (HIGH) | §4.4/W1 新增快照完整交付，不再假设已有 | A1 实际 merge/build/restart、延迟 import、原生模块、CLI 路径与 GC/预算负控 |
| first-deploy-transition-and-auto-rollback (HIGH) | §6.1/§9 新接管 + N/N+1 分步 + 外置守卫 | N-1 首次中途接管，N 健康前失败仍回 N-1，迁移后/N+1 回 N，拒不兼容自动回滚 |
| carrier-lost-resume-contract-gap (MEDIUM) | §6.1/6.2 明确 daemon 存活接管、死亡需求/CAS 与 legacy 登记 | 并发、无需求、关闭、缺行、旧代数 |
| standby-flag-default-changes-claude (MEDIUM) | §9.6 Codex 默认开、Claude 默认保持 | 两 vendor 与显式 override/冻结快照 |
| close-fence-misses-autonomous-goal-turns (MEDIUM) | §7 增边界+1s 只读轮询，A3 增丢转发 | 真 goal 自续关闭窗口与停止/token 时间线 |
| fly2902-merge-order-dependency (MEDIUM) | §9 明确 W3 开工依赖 | 合入 SHA 与实际接口，不凭 plan 名称 |
| host-socket-path-length (MEDIUM) | §4.2 复用短根/哈希/长度/0700 | 生产长度路径及越界/错误权限负控 |
| authority-reader-schema-skew (MEDIUM) | §4.1 窄 readonly reader，不构造 StateStore | N reader 读 N+1 隔离 WAL 库，未知 schema 拒绝 |
| host-lifetime-container-and-window-reapers (MEDIUM) | §4.1 独立进程组，TUI 单独显示 | 关 pane/keeper/prune 不杀宿主，窗口恢复与 online 诚实性 |

以上 MEDIUM 均纳入对应设计段，不升为额外审批门；实现者按此验证，不重新发明范围。新增具体相关文件：`scripts/__tests__/codex-host-release.test.sh`（快照/GC/空间/路径）、`scripts/__tests__/codex-host-rollout.test.sh`（两步/回滚守卫）、`packages/claude-runner/test/codex-daemon-adoption.test.ts`、`packages/teamlead/src/runner-host/__tests__/codex-host-authority-reader.test.ts`。W4 搜索上述新增脚本与既有 updater/restart/Bridge wrapper 的完整路径、basename、父目录，记录所有命中处置；现有 `scripts/__tests__/update-flywheel-sources.test.sh`、`bridge-wrapper-preflight.test.sh`、`restart-services-admission-pause.test.sh` 逐文件纳入，再依实际 diff 补发现。窗口消费者同样加入 §10.1 的逐文件发现，不运行目录或全包 suite。

## 15. R2 处置与非阻塞 Follow-ups

R2 request f15d927d-4fb8-47f7-aaf7-eb441069a0d1 有效 CHANGES_REQUESTED；确认 R1 两项 HIGH 修复，新增一项 HIGH、四项 MEDIUM、一项 LOW。

| findingKey | 处置 |
|---|---|
| pinned-snapshot-cross-version-contracts (HIGH) | §4.5 完整兼容清单/最旧在用部署门、CLI/HTTP/事件语义、CommDB 无迁移写入口与事务围栏、FLY-1914 活快照 sweep、不兼容 hold、同会话 binary 升级、A9 真双版本台架；W1/W4 交付 |
| legacy-enrollment-generation-zero-violates-check (MEDIUM) | §6.2 改为 1，保留现有 CHECK，已有代数原样；carrier_lost 从实际基线增代 |
| first-deploy-rollback-blocks-whole-bridge (MEDIUM) | §9.2/3 延后 adoption 到 N 健康与 known-good 后，健康前失败仍可回 N-1 |
| rollback-guard-wrapper-reverted-by-reset (MEDIUM) | 缩小承诺到受管自动部署路径；外置 launchd 入口作为 Follow-up 交 Lead 决定，本设计未实现抗人工 reset 保证，不将它冒充 HIGH 已解决证明 |
| snapshot-budget-per-deploy-retention (MEDIUM) | Follow-up：分层去重（依赖按 lockfile+ABI、dist 按内容、binary 按 hash）、物理占用与逻辑大小分报、真实部署频率/寿命容量估算。现行 12GiB 是保护上限，不能声称足以支持生产频率；按 §4.4 保留引用并拒绝超限，可能暂停新 admission。§4.5 允许有凭证的 standby 兼容升级减少旧引用，但不把它当容量问题已解决。Lead 决定优化归属；上线容量验收必须明确报告能支持的保留集。 |
| authority-read-failure-self-pause-resume-undefined (LOW) | §7 持久 authority_read_hold 与原需求/其他 pause 的解除条件，A9 负控 |

A9 新增具体 `packages/teamlead/src/runner-host/__tests__/codex-host-version-compatibility.test.ts`、`packages/flywheel-comm/src/__tests__/host-existing-writer-contract.test.ts`，及 `scripts/__tests__/codex-host-compatibility-gate.test.sh`，按 §10.1 逐文件发现、运行；跨版本验收使用真实封存旧版本。以上 Follow-ups 不伪装为已实施或门已通过，最终有效 APPROVED 后向 Lead 原样报告。
