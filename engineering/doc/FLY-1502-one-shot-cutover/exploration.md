# FLY-1502 一次性切换(九步 stop-the-world) — 探索
Issue: FLY-1502 (https://linear.app/geoforge3d/issue/FLY-1502/v2批次3-一次性切换-九步-stop-the-world-gono-go-十条-旧系统冻结围栏)
日期: 2026-07-28
基于: 无(本 issue 首篇;上游=doc/engineer/plan/v2/design-FINAL-v2.md §4 + design-chain/design-v1/v2/final §4)

## 1. 任务理解

v2 批次 3 = **把已 merge 但未上电的 v2 系统真正启动,并一次性、不可双轨地退役旧消息基座**。
设计权威已锁死(founder 批准的 design-FINAL-v2.md §4 + design-chain 各版 §4),本单不重开架构,
只把"九步 + Go/No-Go 十条 + 三重围栏"落成可执行的工具链与切换手册,并在 founder 在场的
切换窗口内执行。

三块交付:
1. **生产常驻接线**(FLY-1520 plan §0 明文"生产常驻接线归 1502"):v2 引擎/调度器/DAG 运行时
   目前是纯包,零生产接线——需要 launchd 常驻、admission 入口(真 issue → DAG)、founder
   approval 入口、GitHub non-admin + required-checks 探针(FLY-1520 §9 亦归 1502)。
2. **切换工具链**:冻结、在途枚举、canonical key 对账迁移、WAL-safe backup + 只读归档、
   原路径墓碑围栏(装/卸)、实弹测试 harness、Go/No-Go 十条检查器、回滚脚本。
3. **切换手册(runbook)**:九步逐步的操作序列 + 每步验证 + 回滚出口,founder 在场执行。

## 2. 现状审计(关键事实)

### 2.1 v2 侧(新系统)
- 包:`packages/v2-kernel`(20 表 schema、迁移 0001-0008、`backupDatabase`(integrity+FK+
  migration ledger 校验)、连接 PRAGMA、fence CAS 族)、`v2-engine`(consume-loop、driver、
  enqueue、注入垫片 claude/codex、`initializeCutoverEpoch`(meta cutover_epoch=1))、
  `v2-dag`(admission/dispatch/completion/gate/ship/rework/reconcile)、`v2-actions`(薄壳)、
  `v2-scheduler`(scheduler-once + launchd target + `scripts/install-v2-scheduler.sh`)。
- **生产状态:未上电**。`~/.flywheel/flywheel-v2.db` 不存在;launchd 无 v2 job;
  `packages/teamlead`(Bridge)对 v2 包**零引用**。
- 库路径:`DEFAULT_V2_DB_PATH = ~/.flywheel/flywheel-v2.db`(paths.ts)。
- mailbox 行带 `cutover_epoch` 列;engine 读 meta `cutover_epoch`——epoch 围栏的库侧已就绪。
- **无外部 ingress**:v2 包内无 Discord/Linear 适配;source_kind 全是引擎内部种类。
  设计 v1 §0 非目标明文"不动 Linear/GitHub/Discord 外部集成"。

### 2.2 旧双源(被退役对象)
- **comm.db**:`~/.flywheel/comm/<project>/comm.db`(每项目一个;现有 flywheel / geoforge3d /
  TestProject / fire-test / 若干 QA 目录,另有顶层遗留 comm.db/flywheel.db)。
  writer:flywheel-comm CLI(每个 Runner 的 gate/ask/stage/complete/progress——含本 pipeline
  自己)、Bridge(GatePoller、run-dispatcher、watchdog 族、DirectEventSink…,待 research
  全量盘点)。
- **JSON 信箱**:两层——
  (a) stock Agent Team 信箱 `~/.claude/teams/<lead>/inboxes/<agent>.json` + `.flywheel.jsonl`
  sidecar(`agent-team-transport/path-helpers.ts`);
  (b) 结构化目录 `~/.flywheel/inbox-structured/<lead>/requests` + `<runner>/responses`。
  writer:Bridge(sendRunnerWake / run-dispatcher)、flywheel-comm send 双写(FLY-168)、
  claude-code stock harness 自身(teammate SendMessage)。
- 设计警告(design-final §4 [R3-2]):旧 JSON writer 会 `ensureFileExists` 递归重建目录,
  仅移走目录挡不住——所以要"父目录 chmod 500 + 同名只读占位"的墓碑,重建即 EACCES fail loud。

### 2.3 关键交叉事实:claude 注入垫片仍写 stock 信箱路径
`v2-engine/src/injection/claude-shim.ts` 经 `writeMailboxEntry` 写 sessionRef 携带的
inboxPath——即 **v2 上电后仍要往 `~/.claude/teams/...` 命名空间写文件**(白拿 harness 注入,
设计 2.4a 原文)。"JSON 信箱退役"退役的是其**作为 Flywheel 权威传输层**的身份(sidecar 权威、
双写、wake 依赖),vendor 注入面保留。
⇒ **墓碑围栏不能盖整个 teams 目录**:必须做到"被围栏的旧身份路径"与"v2 新会话身份路径"
**命名空间不相交**(v2 会话用新 team/agent 身份或独立 CLAUDE_CONFIG_DIR)。这是九步中
"原路径墓碑"唯一需要新设计决策的点,其余步骤设计已给死。

### 2.4 九步与十条(权威原文汇总)
九步(design-v1 §4,v2 补齐):①预演(隔离路径 standalone migrator 反复跑+抽样重放+对账
清单)②冻结(关 admission、枚举在途、cutover intent 落 meta、不能 drain 的在途落 durable
checkpoint)③停全部旧写者(Bridge+Lead+runner CLI+巡逻,记 host epoch)④一致快照(SQLite
online backup API 必含 WAL)⑤迁移(FK/CHECK/UNIQUE+integrity_check+foreign_key_check+业务
invariant)⑥安全重置(撤旧凭据、目录 0700 库 0600、旧 token 拒绝清单)⑦epoch fence
⑧顺序启动(kernel→dispatcher/projector→observer→runner supervisor)⑨回滚点(首个 v2 外部
副作用前可原子回切;之后 forward-repair)。
消息通道切换并入步 2-6:双源冻结→canonical key(source_kind,source_id)对账去重迁移未读
(带 message_uid+payload_digest 校验、行数双向核对)→旧 comm.db WAL-safe backup→
integrity_check→chmod 只读归档;JSON 信箱目录归档→三重围栏(a 启动入口撤销 b 原路径墓碑
c epoch fence)。
Go/No-Go 十条(design-v2 七条逐字 + final ⑧⑨⑩):①旧 writer PID/tmux/daemon 全退出
②旧 API token 与旧 capability 被拒 ③每 active task ≤1 active attempt ④每 dispatch 有唯一
generation/effect key ⑤每在途外部 effect 有 receipt 或进 reconcile ⑥migrated gate 绑
exact head ⑦v2 DB 权限/integrity/FK/WAL backup 测试过 ⑧双源冻结+未读按 canonical key
迁移对账 ⑨旧信箱只读归档+原路径 fence 就位 ⑩实弹测试(真启动旧 JSON writer 与旧 comm.db
writer,断言 fail loud、原路径无新文件/-wal/-shm、新 mailbox 无旧 epoch 行)。
注:④⑤ 措辞出自 commands/outbox 时代,FLY-1500/1518 后需按 actions 模型映射
(④→actions effect_key/invocationUid 唯一 ⑤→已启动 action 的 outcome 已结算或诚实留
`intended`)。FINAL-v2 §4 另把 **GitHub required-checks + non-admin merge actor 探针**列为
Go/No-Go 保持项(§1.5 v2 merge lane bootstrap,fail closed 保 v1 lane)。

### 2.5 FLY-1520 §9 "1502 清单"(上游欠条)
- non-admin + required-checks 探针 → **上线阻塞**(Go/No-Go 组成部分)。
- payload/meta 强制点提升为列(schema 单)、generic task-effect lane 合流、legacy agent
  (generation>0 无 binding)收养 API、多 shippable worktree、超上限 DAG 复核 → 均为
  **上线后跟进**候选:切换要求在途清零,上电起点是"零 legacy agent、零在途 DAG",这些
  能力在切换窗口用不到。归属需 Lead 裁定(本探索建议:全部移出 1502,另开 issue)。

### 2.6 回滚锚点
`main@37bcb8e2` = "strip 3 feature flags from founder-approval circuit (FLY-1448/1466)
(#696)",是 v2 批次系列(#711 起)落地前最后一个非 v2 提交。生产 main 现已包含大量
v2-无关修复(#713/#714/#715 等)。**v2 代码在接线前对旧系统零行为影响**(纯新增包)——
所以"整体可退"应分层:
- **T1 运行时回滚**(默认路径,分钟级):卸围栏→归档恢复原路径→重启旧栈(代码停留当前
  main,因 v2 接线是 opt-in 的 launchd/config)。首个 v2 外部副作用前随时可走。
- **T2 代码回滚**(最后手段):整仓回 37bcb8e2——会连带丢掉 #713-#723 的非 v2 修复,
  只有当前 main 的旧路径本身被证明坏了才走。
- 首个 v2 外部副作用之后:forward-repair(设计步 9 原文)。

## 3. 关键张力/设计问题(brainstorm gate 需 Lead 裁定)

Q1 **切换范围**:comm.db 是每项目一库。九步"停全部旧写者"是全机 stop-the-world;上电后
旧 comm 基座全退役=**所有项目**(geoforge3d/tidal-echo/growth…)的 Runner 编排同时落到
v2,还是切换窗口只保 flywheel 项目走 v2、其他项目的 Runner 派发暂停(Lead 的 Discord 聊天
面不受影响,见 Q2)直到后续批次?"拒绝双轨"红线按哪种解读?
(倾向:**全机退役旧基座**;非 flywheel 项目 Runner 派发短暂停用,恢复即走 v2——旧基座
零残留,不算双轨。)

Q2 **Bridge 的命运**:设计 v1 非目标"不动 Discord/Linear/GitHub 外部集成"⇒ Bridge 的
Discord I/O + Lead pane 投递继续存在。但 Bridge 是最大的旧 writer(comm.db+JSON 双源都写)。
上电形态是:(a) Bridge 带着"旧 comm writer 路径全部禁用"的改动重启(改动面=research 盘点
的全部写点,量大),还是 (b) Bridge 原样重启、靠三重围栏让它的旧写路径 fail loud(危险:
Bridge 会崩循环),还是 (c) Bridge 拆薄——只留 Discord/Lead 投递,Runner 编排相关子系统
(GatePoller/run-dispatcher/watchdogs)整体下线由 v2 接管?
(倾向:(c) 拆薄,配 (a) 的写点禁用;实弹测试正好验证围栏对漏网写点兜底。)

Q3 **九步执行形态**:一个带 durable step ledger、每步幂等可重入、dry-run 模式的
`cutover` CLI(founder 每关键步确认),vs 一册人工 runbook + 零散脚本。
(倾向:CLI + ledger;预演步在隔离路径反复跑的就是同一个 CLI。)

Q4 **JSON 信箱命名空间不相交**(§2.3):v2 新会话用 (a) 独立 CLAUDE_CONFIG_DIR,还是
(b) 新 team 命名规约(如 `v2-<agent>`),旧 team 目录整体归档+墓碑?
(倾向:(b) 新 team 命名——不动 vendor 全局配置,围栏按旧 lead/team 名逐目录盖。)

Q5 **时序与分工**:任务 #181 显示切换窗口已开(Annie 在场)。三段式下:设计(本节点)→
Implement 节点建工具+预演+PR(:cool: ship)→**切换窗口执行**(九步+Go/No-Go+上电+真 issue
验收)。切换执行归 Implement 节点在 ship 后由 founder 陪同现场跑,还是 Lead 亲自执行、
Runner 只交付工具?FLY-1502 自己的 pipeline(本 exec)就是最后的旧系统在途——步 2 在途
清零怎么处理"正在执行切换的自己"(建议:FLY-1502 PR 先 ship、pipeline 全 parked/completed,
切换窗口内旧系统只剩守护进程,无活 issue)。

Q6 **1502 清单归属**(§2.5):建议除 GitHub 探针外全部移出、另开 post-launch issue。

## 4. 方案方向(待 gate 后进 research/plan 细化)

- 交付物 = ①接线(launchd v2 常驻 + admission/approval 入口 + GitHub lane 探针)
  ②cutover CLI(九步 ledger 化,含双源对账迁移器、backup+归档、围栏装卸、实弹 harness、
  Go/No-Go 十条检查器、T1 回滚)③runbook(founder 视角逐步操作卡)。
- 预演(步 1)在隔离路径用真生产数据副本反复跑,不等切换窗口。
- Go/No-Go 十条全部机器可判(检查器输出逐条 PASS/FAIL + 证据),founder 只做 GO/NO-GO
  决策,不做人工核对。
- 实弹测试 = 受控启动一次旧 writer 二进制(旧 Bridge 入口 + flywheel-comm CLI)断言
  EACCES/fail loud + 三处零残留断言(原路径无新文件/-wal/-shm、新 mailbox 无旧 epoch 行)。
