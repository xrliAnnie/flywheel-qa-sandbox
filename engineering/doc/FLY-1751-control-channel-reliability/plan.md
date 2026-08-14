# FLY-1751 控制指令不可靠修复 — 实施计划

Issue: FLY-1751 (https://linear.app/geoforge3d/issue/FLY-1751/控制指令不可靠founder停手指令无优先通道最坏延迟-8-小时9-条因租约超时判死-换代对账只是其中一腿)
日期: 2026-08-13
基于: research.md

**Scope 权威**:Issue 正文「🎯🎯 8-13 深夜 二次定稿」节,两条,不许扩。所有历史章节(证据 A-D / 机制定性 / 修法一二三 / 第一版定稿)仅作背景,不得捡回任何已作废的刀。

**版本**:ship 时取空号(暂记 v1.5x.0)。分支:本 worktree `flywheel-FLY-1751`;PR base = `main`。

## 0. 总览

| # | 改动 | 落点 | 性质 |
|---|---|---|---|
| Fix 1 | 攒批参数 batchMaxSize 5→10、batchWindowMs 60_000→30_000 | `packages/teamlead/src/bridge/mailbox-queue-config.ts` + 2 处 fallback 收敛 | 默认值变更(生产无 env override,直接生效于 Bridge 重启后) |
| Fix 2 | `adopt-inflight` 补挂 SessionStart 触发腿(覆盖 `/clear` 换代) | 新 `packages/teamlead/scripts/session-start-adopt-inflight.sh` + `claude-lead.sh` installer | 纯增量;launcher 现有调用一字不动 |

不做(founder 明令):claim/ack 状态机手术、里程碑时间戳列、founder 优先通道、human 免攒批、STOP 控制面、死信分诊。

## 1. Fix 1 — 攒批参数

### 1.1 变更

`packages/teamlead/src/bridge/mailbox-queue-config.ts:16-17`:

```ts
	batchWindowMs: 30_000,
	batchMaxSize: 10,
```

fallback 字面量收敛(消灭陈旧副本,单一真相源):

- `packages/teamlead/src/bridge/lead-inbox-loop.ts:207-215` → `{ ...DEFAULT_MAILBOX_QUEUE_CONFIG, enabled: false }`(import 自 `./mailbox-queue-config.js`;`enabled:false` 语义保持 —— fallback 只在测试装配缺 `queueConfig` 时生效并走 legacy 路径)
- `packages/teamlead/src/bridge/runner-mailbox-lane.ts:211-219` → 同上

**不改**:env knob 名称/clamp 域、`inflightMaxBatches=3`、`ackLeaseMs`、`leaseRetryMax`、tick 调度、`claimQueueBatch` 逻辑。

### 1.2 TDD

1. **RED**:`mailbox-queue-config.test.ts` 默认值断言先改为 10/30_000 → 跑挂。
2. **GREEN**:改 `DEFAULT_MAILBOX_QUEUE_CONFIG`;跑 `packages/teamlead` + `packages/flywheel-comm` + `packages/config` 受影响测试。
3. 逐个失败点判定:显式传参的测试(如 `claimQueueBatch` 单测多以显式 `batchMaxSize/batchWindowMs` 传参)不应失败也不许改弱;断言默认值渗透的测试随改。新增一条回归断言:`resolveMailboxQueueConfig({})` 返回 `batchMaxSize===10 && batchWindowMs===30_000`(无 env 时)。
4. fallback 收敛后跑两个 lane 的既有测试,证明 `enabled:false` 行为逐字不变。

### 1.3 验收对齐(定稿验收第 1、4 条)

- **攒批实测(可证伪)**:vitest 集成用例——配置**必须经 `resolveMailboxQueueConfig({})` 取得**(证明默认值接线,不许显式传 10/30_000);同 sender 在 head 后 30s 内投 12 条 → 一次 claim 恰 10 条(容量上限生效);跨窗用例:两条消息 created_at 相差 31s → **先对第一箱 `recordBatchDelivered` + ACK 结算**,再第二次 claim → 第二条独立成箱(否则 queue 优先返回 frozen LEASED 批,测到的是 lease 恢复不是 30s 分箱)。前后字节对照 = 测试先在旧默认下反向断言失败(RED 步骤即对照)。
- **全量回归**:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(正常收发/签收/幂等不变)。
- **诚实边界(报告措辞约束)**:`batchWindowMs` 是并箱横界不是 hold-back —— 面向 founder 的交付措辞用「一箱最多装 10 条、最多并 head 后 30 秒内的消息」,不得写成「每 30 秒发一批」。

## 2. Fix 2 — `/clear` 换代腿

> **R1 修订**:Codex design review R1 五项 blocker 全部采纳(逐条已亲自核实代码事实):①matcher 收窄为 clear-only;②hook 落 per-Lead `settings.local.json` + `agent_type` 三重身份锚,不再写全机 `~/.claude/settings.json`;③超时改用 hook 条目原生 `"timeout": 10` 字段,删除「无 timeout 就裸跑」;④installer 采用 reply-enforcer 级安全 merge(防 jq 1.6 空输出)+ 复用既有 per-workspace mkdir 自旋锁;⑤companion/external 显式排除(其 pane 的 CommDB/CLI 被 FLY-231/879 安全边界清空,不恢复)。

### 2.1 新 hook 脚本 `packages/teamlead/scripts/session-start-adopt-inflight.sh`

姿态:**对会话诞生 fail-open(任何分支 exit 0、绝不阻塞),对 adoption fail-closed(身份链任何一环不成立就不动库)**。

```
1. 读 stdin(有界,如 head -c 65536)→ jq 解析 SessionStart 输入
   (claude-code hooks.ts:3876-3882:含 hook_event_name / source / agent_type)。
   stdin 缺失、坏 JSON、jq 缺席 → 静默 exit 0(不 adoption)。
2. source == "clear" || exit 0(与 matcher 双保险;startup/resume 归 launcher 腿,
   compact 不换代 —— 均不 adoption)。
3. agent_type 非空且 == "$LEAD_ID" || exit 0
   (Lead child 以 `claude --agent "$LEAD_ID"` 启动,claude-lead.sh:2110-2113;
   agent_type 是 Claude Code 注入的会话身份,不是可随意继承的 env)。
4. [ -n "$LEAD_ID" ] && [ "$LEAD_ID" = "${FLYWHEEL_LEAD_ID:-}" ] || exit 0
   (env 佐证锚:runner pane 的裸 LEAD_ID 被 TmuxAdapter.ts:575 显式清空;
   仅作 belt —— 主边界是 per-Lead settings.local.json 安装半径 + agent_type)。
5. [ -n "${FLYWHEEL_COMM_CLI:-}" ] && [ -f "$FLYWHEEL_COMM_CLI" ]
   && [ -n "${FLYWHEEL_COMM_DB:-}" ] || exit 0。
6. 执行:node "$FLYWHEEL_COMM_CLI" adopt-inflight --recipient "$LEAD_ID" --kind lead
   —— 与 launcher 调用逐字同参;db 经 FLYWHEEL_COMM_DB env 解析(claude-lead.sh:534,
   QA slot 自动跟走)。CLI 非零退出/异常输出 → stderr 诊断 + exit 0。
   不做 shell 层 timeout wrapper(macOS 无 GNU timeout;有界性由 hook 条目
   原生 "timeout": 10 秒字段保证)。
7. 输出纪律:stdout 注入新会话 context —— 仅当 adopted N > 0 时输出一行
   「[adopt-inflight] 已把上一现场的 N 条在途消息重新排队,稍后将重投本会话
   (注意 [lead-instruction <id>] 幂等:已处理过的指令不要重做)」。
   **N 的单位是 mailbox 消息行,不是批**(CLI 打印的 adopted: N = UPDATE changes)。
   0 行时全静默。诊断走 stderr。任何分支 exit 0。
```

### 2.2 installer `install_session_start_adopt_inflight_hook()`(`claude-lead.sh`)

**目标文件 = `${LEAD_WORKSPACE}/.claude/settings.local.json`**(不是全机 `~/.claude/settings.json`)。依据:Lead child 的 cwd = `LEAD_WORKSPACE`(claude-lead.sh `cd "$LEAD_WORKSPACE"`),Claude Code 会合并读取 cwd 的 `.claude/settings.local.json` hooks;每个 Lead 独占自己的 workspace 目录 → **不同 cwd 的会话(runner/founder/generic)根本加载不到这个 hook;同 workspace cwd 手起的会话会加载,但仍须过 agent_type/env 两层身份锚**(§4.4)。

- **可执行文件也收进 per-Lead 半径(R2 blocker)**:源 = `${SCRIPT_DIR}/session-start-adopt-inflight.sh` → 发布到 `${LEAD_WORKSPACE}/.claude/hooks/session-start-adopt-inflight.sh`,settings 条目 command 引用**本 workspace** 的这份。不发布到共享 `~/.flywheel/bin/`:①529 QA slot 与生产共用真 `$HOME`(`scripts/test-deploy.sh:1194-1196` 只隔离 `LEAD_WORKSPACE` 到 slot 目录),feature branch 起 QA Lead 会 last-writer-wins 覆盖生产 Lead 正在引用的共享字节;②`scripts/lib/script-sanity.sh:6-12` 已把「`<state>/bin` writer 必须原子安装」定为硬约束,不新增裸 `cp` writer。`LEAD_WORKSPACE` 是持久目录(不随源码 worktree 清理),QA slot 的 workspace 在 slot 目录内、随 slot 一起隔离/回收。
- **双文件发布顺序与允许终态(R3 blocker —— 两次 rename 不是一个事务,不假装是)**:全程在 workspace 锁内,但 hook reader 不持锁,故按「有序发布 + 诚实终态」执行:
  1. **stage 先行,零 mutation**:锁内读取并验证旧 settings(非空 object 或缺席视 `{}`),同目录 stage 新脚本(完整性校验:非空 + `bash -n`)并 stage merge 后的 settings(非空、可重 parse、顶层 object);两个 artifact 都 ready 前不碰任何生产文件。
  2. **先脚本后 settings**:先 atomic `mv` 发布脚本(`chmod +x` 在 mv 前的 temp 上做),成功后才 atomic `mv` 发布 settings。**绝不反序** —— settings 永不指向缺失/未验证的脚本。
  3. **允许四种终态**:stage 失败 = old/old;脚本 `mv` 失败 = old/old;脚本成功 + settings `mv` 失败 = **new-script/old-settings**(首装时新脚本 inert 无 settings 引用;升级时旧 settings 继续指向同一固定路径上的已验证新脚本 —— 单文件 rename 保证 reader 只见完整旧版或完整新版);双成功 = new/new。partial 终态 log WARNING,下次 Lead 出生 installer 幂等收敛到 new/new。**不声称「任何失败两文件都字节不变」**;若未来要求严格 old/old|new/new,需 versioned immutable script path + settings rename 作唯一 commit point,本单不需要。
  4. **不可达负面**:「settings 已发布而脚本未发布」在任何失败序列下不可达(顺序保证)。
- **路径 quoting 加固(R3 LOW)**:settings command 用 shell-safe 形式(经 `bash` 调用并安全引用脚本路径),兼容含空格的 `LEAD_WORKSPACE`;dedupe 按规范化脚本 basename 判断,不依赖 command 字符串恰好无引号结尾。测试补一个带空格 sandbox workspace 用例。
- **锁**:复用既有 per-workspace 自旋锁语义与锁路径 `${LEAD_WORKSPACE}/.claude/settings.local.json.flywheel-lock`(claude-lead.sh:2060-2085 的 MCP pre-seed 同款:mkdir 原子自旋 50×0.2s + stale >1min 清理),与 MCP pre-seed 串行执行、共用同一把锁文件,消除并发 writer lost-update。
- **安全 merge(reply-enforcer 级,claude-lead.sh:1092-1124 约束)**:读入必须是非空 JSON object(文件缺席视为 `{}`);jq 合并输出必须**非空**、可重新 parse、且顶层仍为 object(jq 1.6 有「成功但空输出」陷阱,`jq empty` 不足);任一步失败 → log WARNING + 原文件字节不动;成功才在锁内 atomic `mv`。
- 条目:`.hooks.SessionStart` 防御性归一为数组 → 剔除所有 command 以 `session-start-adopt-inflight.sh` 结尾的旧条目 → 追加 `{"matcher": "clear", "hooks": [{"type": "command", "command": $cmd, "timeout": 10}]}`。**matcher 只有 `clear`**:startup/resume 已由 launcher 在 fork 前覆盖,hook 再扫会与新现场的首批投递竞态(launcher requeue → Bridge 立即重 claim → hook 二次撤箱,一次物理重启多烧一个 retry generation);compact 不换代。`"timeout": 10` 为 Claude Code hook 条目原生秒级字段,是有界性的唯一来源。
- 调用位点:`cd "$LEAD_WORKSPACE"` 之后、紧随 MCP pre-seed 块(:2046-2107)之后(此时 `LEAD_WORKSPACE`/`SCRIPT_DIR` 均已就绪且同锁串行)。**companion/external 跳过安装**并 log 原因(见 §2.5);`jq` 缺席 log WARNING skip。
- launcher 现有 `_adopt_inflight_before_launch`(:2878/:2983)**一字不动**(阴性对照:`scripts/__tests__/test-claude-lead-adopt-inflight.test.sh` 必须原样通过)。

### 2.3 TDD(shell harness,`scripts/__tests__/test-claude-lead-session-start-adopt.test.sh`)

镜像 `test-claude-lead-adopt-inflight.test.sh` 的手法(pin 生产源文件 + stub node 执行真实脚本/helper 体):

**hook 脚本行为**(stub `node` 记录 argv;stdin 喂真实 SessionStart JSON):
1. Lead 形(stdin source=clear + agent_type=X;env LEAD_ID=X=FLYWHEEL_LEAD_ID,CLI/DB 在)→ 恰一次 `adopt-inflight --recipient X --kind lead`,exit 0。
2. source=startup / resume / compact → **零调用**,exit 0。← R1 收窄的守卫
3. stdin 缺失 / 坏 JSON / agent_type 缺失 / agent_type=Y≠X → 零调用,exit 0。
4. runner 形 env(LEAD_ID 空,FLYWHEEL_LEAD_ID=X,即使 stdin 伪造 clear+agent_type)→ 零调用,exit 0。
5. 嵌合 env(LEAD_ID=X,FLYWHEEL_LEAD_ID=Y)→ 零调用,exit 0。
6. CLI 缺席 / DB env 空 → 零调用,exit 0。
7. CLI 非零退出 → hook 仍 exit 0(stderr 有诊断)。
8. stub 输出 `adopted: 3`(单批 3 条 member 场景)→ stdout 提示行且计量词为「3 条在途消息」;`adopted: 0` → stdout 空。

**installer**(沙箱 LEAD_WORKSPACE + 假 settings.local.json):
9. 空/缺席 settings.local.json → 装出恰一条 SessionStart 条目:matcher 逐字 `clear`、command = **完整 shell-safe 形式(经 `bash` 调用、安全引用的 `${LEAD_WORKSPACE}/.claude/hooks/session-start-adopt-inflight.sh` 路径)逐字断言最终 JSON 字符串,不是裸路径**、`timeout == 10`(逐字段断言);可执行文件已落 workspace 且 `+x`;带空格 workspace 用例须实际执行该 command(R4 非阻塞提醒采纳)。
10. 幂等:连跑两次 → 仍恰一条,脚本字节稳定。
11. 旧路径条目(同文件名后缀、不同前缀,含历史 `~/.flywheel/bin/` 形)→ 被替换为 workspace 路径,不重复。
12. 既有无关 SessionStart / 其他 hooks / MCP pre-seed 字段 → 原样保留(sibling 不丢)。
13. 坏 JSON / 顶层非 object → skip,文件字节不动。
14. **jq 空输出陷阱**:模拟 merge 产出空 → 不写文件。
15. 并发两 writer(锁竞争)→ 两次写入的字段都在,无 lost-update。
16. **per-Lead 半径(R2)**:同一 `$HOME` 下两个不同 `LEAD_WORKSPACE` 各装带可辨字节的脚本 → 两份 settings command 与脚本各留各家,第二次安装不改第一份;生产源 pin:installer 不写入、settings 不引用共享 `~/.flywheel/bin/session-start-adopt-inflight.sh`;带空格的 workspace 路径用例(command shell-safe 引用不拆词)。
16b. **双文件 commit 终态(R3)**:分别注入三个失败点 —— stage 失败 / 脚本 `mv` 失败 / 脚本成功后 settings `mv` 失败 —— 断言终态分别为 old/old、old/old、new-script/old-settings,各自 WARNING + temp/lock 清理干净;第三种终态下**再跑一次 installer 收敛到 new/new**(幂等收敛);负面断言:「settings 已发布而脚本未发布」在任何注入序列下不可达。
17. 生产源 pin:claude-lead.sh 恰一处调用 installer、位于 `cd "$LEAD_WORKSPACE"` 之后;companion/external 分支不调用;launcher 的 `_adopt_inflight_before_launch` 调用数仍 = 1 且紧贴 v2 fork(现有测试不动即为证)。

**真挂起有界性**(真机/QA):stub 永久挂起 → 会话在 hook `timeout: 10` 秒内继续诞生,`/clear` 不被阻塞。

### 2.4 验收对齐(定稿验收第 2、3 条 —— 真机,QA 节点执行)

- **正对照**:529 隔离房(或指定沙箱 Lead)造 LEASED 在途批 → 对该 Lead pane 发 `/clear` → **零人工** → 断言:comm.db 中原 LEASED 行翻为 QUEUED(`last_error='recipient_reborn'`)→ 随后被重投新现场并 ACKED → 后续 QUEUED 恢复流动。**此对照同时是「settings.local.json + --agent + bypassPermissions 组合下 hook 真会开火」的存在性证明**(设计已核 claude-code 源码 matchQuery=source,但真机开火必须实证)。
- **阴性对照 a**:无在途批的 `/clear` → adoption 0 行,新会话 context 无提示行,无任何库变更。
- **阴性对照 b(进程重启腿回归)**:重启该 Lead body → launcher 腿照常 adoption,且 **SessionStart(source=startup)不再叠加第二次 adoption**(comm.db 中该重启窗口 `recipient_reborn` 只出现一代)。
- **阴性对照 c(半径)**:同机起 Claude runner + founder 终端裸 claude → 两者的 SessionStart 均无本 hook(settings.local.json 不在其 cwd),零 adopt-inflight 调用。
- 真机验收在 QA 节点做;本设计只锁定判据与步骤。

### 2.5 companion/external 显式排除(scope 决定,非静默 no-op)

FLY-231/FLY-879 的安全边界把 companion(Belle)/external(Anna)pane 的 `FLYWHEEL_COMM_CLI`/`FLYWHEEL_COMM_DB` **显式清空**(claude-lead.sh:1652-1665,Codex R2 HIGH-5 既定裁决)。本单**不**为 `/clear` adoption 恢复这些凭据(那是推翻一条已评审安全边界的决定,超出本 bounded 节点授权):

- companion/external 的 `/clear` 换代维持现状行为:LEASED 批靠 30 分钟 ack-lease 到期 → `reconcileExpiredLeases` 重投(每代 retry+1,`leaseRetryMax=3` 触顶进 DEAD)+ 下次进程重启的 launcher 腿。慢且有损,但与今天一致,无回归。
- installer 对 companion/external 跳过安装并 log,使排除**可见**(而非装了个必然 no-op 的 hook 假装覆盖)。
- 此边界会在交付报告向 Lead/founder 明示;若需要 companion 覆盖,应立后续单走 broker/受限通道设计(与 FLY-510 phase-2 同族),不在本单。

## 3. 部署与生效

| 步骤 | 说明 |
|---|---|
| merge → main | 常规 PR 流(founder 批准 gate) |
| Bridge 重启 | Fix 1 默认值随新 build 生效(下一班 restart-services 批次车) |
| Lead body 换代 | Fix 2 installer 在**各 Lead 自己**下次出生时跑一次,写入该 Lead 的 `${LEAD_WORKSPACE}/.claude/settings.local.json`(per-Lead 文件,**没有**「一个装好全机生效」的捷径 —— 全舰重启批次车天然逐 Lead 覆盖);装好后对该 Lead 运行中会话的**下一次 /clear** 即生效 |
| 部署后观察项(不进本单) | 死讯回流通知发件人 / 信箱堵死独立报警(修法三残余两尾巴,founder 已降级为观察项) |

## 4. 风险与边界(诚实清单)

1. **window 语义**:30s 是并箱横界,不是投递节拍。founder 面向措辞按 §1.3 约束。
2. **重试预算**:每次 adoption 对被接管消息 `lease_retry_count+1`(1708 既定语义,不改)。连续 4 次 `/clear` 且批始终无人 ack 才会触顶判死 —— 这是「真失败仍按原语义判死」的阴性对照要保住的行为,不是缺陷。matcher 收窄为 clear-only 后,一次物理重启只有 launcher 一代 adoption,不再有双扫叠烧。
3. **compact 排除**:matcher 不含 `compact`;compact 后未 ack 批由 30 分钟租约超时自然重投兜底 —— 那正是租约存在的意义。
4. **身份半径(三层)**:①安装半径 = per-Lead `settings.local.json` + 同 workspace 内的可执行文件 —— **不同 cwd** 的会话(runner/founder/generic)加载不到;**同 workspace cwd** 的会话会加载,但仍须过后两层;②会话身份 = SessionStart stdin `agent_type == LEAD_ID`(Claude Code 注入,非可继承 env);③env 佐证 = `LEAD_ID` 非空且 == `FLYWHEEL_LEAD_ID`。三层都过才动库;任何一层缺失静默退出。人为在 LEAD_WORKSPACE cwd 且注入全套 env 且伪造 agent_type 的会话视同坐进 Lead 席位,接受。
5. **companion/external 排除**(§2.5):显式 scope 决定,交付报告向 Lead/founder 明示;其 `/clear` 维持现状(租约到期重投 + 下次进程重启),无回归、无新覆盖。
6. **两 lane 共享默认值**:runner lane 攒批同步变为 10/30s,无已知反向风险(research §1.2)。
7. **hook 有界性**:唯一来源是 hook 条目 `"timeout": 10`(Claude Code 原生秒级字段,超时 tree-kill 整棵进程树);脚本内不再有平台相关的 timeout wrapper。**超时后 adoption 结果是不确定的**:SQLite 原子 UPDATE 可能已在被杀前提交(此后按既有 CAS/重投语义继续),也可能未发生(由下一次 `/clear`、租约到期或下次进程重启兜底)。风险清单与 QA 判定不得用「stdout 缺失」证明零库变更 —— 真机挂起用例以 comm.db 终态为准。两种结局都不阻塞会话、不丢消息。
