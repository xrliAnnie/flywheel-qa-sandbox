# FLY-2358 任务级 Codex home 改键 (agent, 项目) — 探索
Issue: FLY-2358 (https://linear.app/geoforge3d/issue/FLY-2358/2355b1-ic-层地基任务级-codex-home-改键-executionid-agent)
日期: 2026-09-05
基于: 无(上游为 PRD `engineering/doc/FLY-2119-codex-identity-memory/prd.md` §5.2/§5.3.2/§5.3.3/§5.5,分支 `flywheel-FLY-2119`)

## 1. 问题陈述

Codex runner 的家(`CODEX_HOME`)今天按 `executionId` 一次一个(`packages/claude-runner/src/codex-home.ts:270-274`),记忆开关本来就是开的,所以 867 个家里 409 个真的攒出了 `memories/raw_memories.md`、383 个攒出了 `memories/MEMORY.md`【本轮实测,2026-09-05;PRD 写作时是 646 家/92 家】,但下一张单换了家,什么都带不走。PRD §5.5 定了键 = `(agent, 项目)`,并要求改键与「角色家不随任务删除」同批上线。

本单是三段式(设计→实现→QA)的设计段,**必须先答一道裁定题**:同一 `(agent, 项目)` 同时跑两个 runner 时家怎么办 —— (a) 共享持久家,还是 (b) 执行级家 + 持久记忆存放点。

## 2. 现状审计(逐处原文核过)

### 2.1 家的建 / 用 / 删,今天谁在碰

| 环节 | 文件:行 | 事实 |
|---|---|---|
| 路径解析 | `codex-home.ts:262-274` | `codexHomesRoot()`(可被 `FLYWHEEL_CODEX_HOMES_ROOT` 覆盖)+ `codexHomeDir(executionId)` |
| 建家 | `codex-home.ts:1042-1216` `provisionCodexHome` | 每次执行都调;**幂等 = 原地覆盖** auth.json / `.active` / config.toml / AGENTS.md / `skills/`(matt 臂装六个技能目录,bare 臂**删掉**它们) |
| 唯一生产调用点 | `CodexTmuxAdapter.ts:827` `executeOwned` | 首次 spawn、Bridge 重启后 reown、换体(`codex-session-reown.ts:217` 起的 ctx)**全部**走这一处 ⇒ 每次都重新 provision |
| 退休擦凭据 | `CodexTmuxAdapter.ts:1671,1766` → `scrubCodexHomeCredential(executionId)` | 终态时把 config.toml 里的 GH_TOKEN 受管块剥掉(P5 不变量:退役家不囤活令牌) |
| 启动清扫 | `run-infra.ts:1204` `scrubOrphanedCodexHomes(liveExecIds)` | Bridge 启动时**按根目录下的目录名当 executionId**,不在活会话集合里的家一律剥令牌 |
| 删家 | `codex-home.ts:1261-1270` `removeCodexHome` ← `CodexTmuxAdapter.ts:2483` `removeCodexSessionState` | **全仓生产调用点 0 个**(注释原文 `re-exported for tests`);`catch {}` 为空 |
| 孤儿 reaper | `codex-runner-orphan-reaper.ts:238-256,681-690,748,790` | 把根目录**目录名集合**当 executionId 集合,用它反查 socket 归属并核验 ledger 身份;家不在集合里 ⇒ `identityMismatchSkipped`(不杀) |
| rollout 探针 | `codex-rollout-probe.ts:40` | `codexHomeDir(executionId)/sessions` 下按 threadId 找最新 rollout 的 mtime(reown 判活用) |
| 账号台账 | `codex-home.ts:1190` → `bin/codex-account-core.mjs:366-398` | 只记 `sha256(resolve(home))` 指纹,不按家名解析 |
| 全局健康 | `codex-global-health.ts:95-105` | 只要求 runner 的 CODEX_HOME 不在 `~/.codex-*`(Lead 家)下 |
| 529 房 | `scripts/test-deploy.sh:901-903` | slot 通过 `FLYWHEEL_CODEX_HOMES_ROOT` / `FLYWHEEL_CODEX_SESSION_DIR` / `FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT` 三轴隔离 |

📌 根目录下**已经有非 UUID 的家名**(`fly1224liv`、`qa-fly2168-*` 等,本轮 `ls` 实测)⇒ 任何「按名字长得像 UUID 判旧家」的守卫都不可靠,守卫必须按**结构**(路径落在哪个子树)判。

### 2.2 键所需的两个字段今天在哪

PRD §5.3.2 第 4 条说「建家那层拿不到 agent 和项目」——追到底了:

- `AdapterExecutionContext`(`packages/core/src/adapter-types.ts`)已有 `projectName`、`sessionRole`(design/implement/qa/main)、`phaseKeepAlive.role`、`residentLoopTarget.nodeId`;**没有**节点 id 字段。
- Blueprint(`packages/edge-worker/src/Blueprint.ts:2734-2742`)在 spawn 前已经为 **FLY-2147 runner 角色记忆**算过同一身份:`resolveRunnerMemoryIdentity({projectName, nodeId: generalizedExecutionContext.nodeId, agentName})` → `{project, role}`,`role = nodeId ?? agentName`,安全字符集 `SAFE_IDENTIFIER_RE`、长度 ≤128、大小写注入编码 `encodeMemoryPathComponent`(`runner-memory.ts:71-130,151-175`)。生产已按它把 Codex implement runner 的记忆挂在 `~/.flywheel/runner-memory/flywheel/implement`(teamlead.db 实测 8 行)。
- reown 侧(`codex-session-reown.ts:190-240`)从 session 行重建 ctx:`project_name` 有;`workflow_node_id`(set-once,`StateStore.ts:7719`)与 `agent_name` 有。

> **⇒ 「agent」不需要新造词表:直接复用 FLY-2147 的 `(project, role)` 身份**,同一条规则在首次 spawn(Blueprint)与 reown(session 行 `workflow_node_id ?? agent_name`)两处得到同一个值。这就是 PRD 要的「一个来源」。

生产实测(teamlead.db,adapter_type=codex-tmux):`(implement, flywheel)` 535 行带节点 id、152 行是 cutover 前的无节点 id 旧行;design 19+1;qa 2;main 4。**此刻**就有 4 个 `(implement, flywheel)` 的 Codex runner 同时 running(FLY-2366/2368/2357/2239)⇒ 并发不是假想,是常态。

### 2.3 一次性家里到底有什么会被共享

本轮起了两个真 app-server(见 §4 E1)后家里的清单:`auth.json`、`config.toml`、`.active`、`AGENTS.md`、`skills/`、`sessions/`、`history.jsonl`、`installation_id`、`memories/`、五个 sqlite(`memories_1` `state_5` `logs_2` `queue_1` `goals_1`,全部 WAL)、`app-server-control/app-server-startup.lock`、`cache/` `tmp/` `.tmp/`。

## 3. 两条路

### (a) 共享持久家
一个 `(agent, 项目)` 一个家,多 runner 同时 `CODEX_HOME` 指向它。Codex 自己的记忆流水线(启动时 phase1 从本家 `state_5.sqlite` 的 `threads` 表抽取 idle ≥6h 的 rollout → phase2 在本家 `memories_1.sqlite` 的 `jobs` 表拿全局锁后合并进 `memories/`,`core/src/memories/start.rs:14-45`、`state/src/runtime/memories.rs:59-90,639`)在**下一次 spawn 的启动**里自然把上一张单的会话消化掉 ⇒ 记忆天然累积,[2355·B2] 缩成「种回去 + 验收」。

### (b) 执行级家 + 持久记忆存放点
家仍一次一个;为每个 `(agent, 项目)` 维护一个跨任务目录,把 `memories/` 与 `memories_1.sqlite` 软链进每个执行家(本轮 E3 证明软链到同一文件时锁仍串行,-wal 落在目标旁)。auth / config / skills 的执行级隔离(FLY-123 / FLY-1395 / FLY-1961)逐字节不动。

## 4. 证据(哪些来自旧证据、哪些是本轮实测)

| # | 问题 | 来源 | 结论 |
|---|---|---|---|
| E0-lock | phase2 全局锁在多进程共享一家时串不串行 | **旧**:FLY-2119 `exp-phase2-lock.cjs`(2026-09-02,合成)+ 真会话两臂(`exp-evidence/phase2-jobs.txt`:shared 家 jobs 1 行,只有一个会话拿到) | 串行(8 进程恰 1 Claimed) |
| E2 | 同上,本机复现 | **本轮**(2026-09-05,`exp-phase2-lock.cjs` 原样重跑,节点自检先证明「回收 n/n」断言会响) | 5 轮全部 Claimed=1 / SkippedRunning=7;阳性对照(各家各一份库)5 轮全部 Claimed=8 |
| E0-auth | 同家两真会话并发,凭据会不会撞 | **旧**:FLY-2119 `exp-auth-concurrency.sh` 三臂(business 号,2026-09-02,`exp-evidence/exit-codes.txt` 五个 rc 全 0、无凭据类错误、指纹变了 ⇒ 真到过刷新点);同一 refresh_token 四次兑换全部成功 | 正常使用下没撞;**没逼出**两写者同毫秒落进 truncate 窗口的情形(findings §19,诚实边界) |
| E0-tear | `auth.json` 写法是 truncate+write 无 rename | **旧**:`exp-auth-tear.js` 饱和写 8.6% 读到空文件(不是坏 JSON);源码 `core/src/auth/storage.rs:111-127`(本机 checkout db6aa80) | 窗口真实存在;真实频率 = 几小时一次刷新 × 极窄窗口,远低于饱和值 |
| E1 | **真二进制 0.153.2**:两个 `codex app-server --remote-control` 同家同时起,`app-server-startup.lock` 是不是互斥锁 | **本轮**(`exp-two-appservers-one-home.sh`,零凭据) | 双 socket 都在、双进程都活、stderr 无 lock/already 行;阴性对照(同 socket 起第二个)如期失败 `control socket is already in use` ⇒ 那把锁不互斥 app-server |
| E3 | (b) 的技术前提:软链 `memories_1.sqlite` 到共享文件,锁还串不串行 | **本轮**(`exp-symlinked-memdb-lock.cjs`) | 5 轮 Claimed=1;`-wal` 落在目标文件旁(SQLite 解析 symlink);阳性对照 3 轮全 Claimed=8 |
| S1 | 守卫式 reload | 源码 `core/src/auth.rs:1042-1065` `reload_if_account_id_matches`:先重载磁盘,account_id 相同才用磁盘上别人刷新出的新票;不同则各自刷各自的 | 同账号并发 = 设计内路径;混账号并发 = 文件在两个账号间来回翻,各进程自身一致 |
| S2 | 旧证据引用的源码位置 | 旧 findings 引 `login/src/auth/manager.rs`,本机 checkout(2026-02-14)没有该路径,对应逻辑在 `core/src/auth.rs`;二进制 0.153.2 比 checkout 新 | 结论不受影响,但**行号引用以本机 checkout 为准并标注版本差** |

### 4.1 Codex 这一侧并发「可行」的结论只成立到哪
- ✅ 记忆合并锁串行(E0/E2/E3 三处独立);✅ 两个 app-server 可共存(E1);✅ 正常使用下凭据不撞(E0-auth,n=1)。
- ⚠️ 未证:两写者同毫秒落进 truncate 窗口(读到空文件 = 那一瞬像没登录);消除法是 `cli_auth_credentials_store = "keyring"`,**不在本单范围**(会动 `~/.codex` 家族配置形状,且未实测)。
- ⚠️ 未证:高频下服务端是否仍容忍同一 refresh_token 重复兑换(n=1)。

### 4.2 但「我们这一侧」的执行级状态才是真正的坑(PRD 没写,本轮审计新发现)

| # | 冲突 | 今天为什么没事 | 共享家后 |
|---|---|---|---|
| C1 | 退休擦令牌 `scrubCodexHomeCredential(executionId)` | 一家一执行 | runner A 退休会把还在跑的 B 的 GH_TOKEN 从共享 config.toml 剥掉 |
| C2 | Bridge 启动清扫按目录名当 executionId | 目录名就是 executionId | 键式家名永远不在活集合 ⇒ 每次 Bridge 重启都剥掉活 runner 的令牌(runner 在 tmux 里活过 Bridge 重启) |
| C3 | reaper 用根目录名反查 socket 归属 | 同上 | 键式家不进集合 ⇒ 所有 Codex 孤儿 app-server 变成 `identityMismatchSkipped`,永不回收(方向安全,但功能退化) |
| C4 | rollout 探针 `codexHomeDir(executionId)/sessions` | 同上 | 找不到目录 ⇒ reown 判活退化为 `absent` |
| C5 | config.toml 受管信任块只放**一个** worktree 路径(`codex-home.ts:882-892`) | 一家一 worktree | 后起 provision 抹掉先起者的 worktree 信任 |
| C6 | 技能臂(FLY-1395)落在家里:matt 装 `skills/`,bare 删它;`[[skills.config]]` 禁用表按臂不同 | 一家一臂 | 生产近两周 `(implement, flywheel)` 四臂混跑(bare 53 / bare-ponytail 80 / matt 93 / superpowers 83 行)⇒ 后起 provision 覆盖先起者的臂 |
| C7 | `.active` / `auth.json` 按当下 `~/.codex` 身份整份覆盖 | 一家一次 | 账号轮换期间,新 runner 用新号覆盖,旧 runner 刷新时再写回旧号(S1);各进程自洽,新起的进程读到哪份看时机 |
| C8 | `removeCodexHome` 空 catch、零调用点 | 没人调 | 「跑完清理」接上那天第一刀删光该 agent 全部记忆(PRD §5.5.3) |

(b) 路线**天然没有 C1-C7**(执行家原样),只多两个软链;但它的代价在别处:phase1 只在「同一家里的下一次启动」抽取 idle ≥6h 的 rollout,执行家没有下一次启动 ⇒ 每张单最后 6 小时内结束的会话**永远抽不到**,B2 必须再造一条「收尾时逼一次抽取」的路(一次额外真会话 + 用 `-c memories.min_rollout_idle_hours=0` 覆盖节流闸 —— 与 PRD ⛔「不改节流闸」直接冲突),或者接受丢失。

## 5. 裁定:选 (a) 共享持久家,并把 C1-C8 一次做完

理由(按权重):
1. **记忆累积零新机制。** (a) 下 Codex 自己的启动流水线就是回流;(b) 要么新建一条回流路(违反「不改节流闸」),要么系统性丢最后 6 小时。这是 PRD §3.3「照抄 Claude = 稳定的家」的字面落地。
2. **Codex 侧并发已被三处独立证据支撑**(§4),剩余未证项(truncate 窗口、n=1)在 (b) 里同样存在——今天每个执行家各拷一份 auth.json 各自刷新同一个 refresh_token,本来就是 reuse 温床(findings §4.2)。
3. **我们这一侧的冲突 C1-C7 全部可用一个机制收口:租约文件。** `<家>/.flywheel-leases/<executionId>` 在 provision 时落、终态 scrub 时删;它同时充当 (i) 擦令牌的引用计数(C1)、(ii) 启动清扫与 reaper 的「执行 ↔ 家」反查(C2/C3/C4)、(iii) 「有别的活租约时不许覆盖/删除」的判据(C5/C6)。一个来源,不镜像词表。
4. B2 因此缩成「把今天 383 个旧家里的 `memories/` 种进对应键式家 + 验收」(Lead 2026-09-05 指示:偏最小形状)。

### 5.1 选 (b) 的代价(写给后人)
- 多一条回流机制且必须动节流闸或接受丢最后 6 小时;
- 软链 sqlite 的 `-wal/-shm` 归属依赖 SQLite 解析 symlink 的行为(E3 证明成立,但是隐性依赖);
- phase1 的 `threads`(每家一份 `state_5.sqlite`)与共享 `stage1_outputs`(`memories_1.sqlite`)跨库联查语义未验;
- 删家守卫仍要做(PRD 硬条),不省。

### 5.2 (a) 下必须显式接受的两条
- **技能臂变成家级属性**(C6):有别的活租约时不按本次请求改臂,沿用家里现有臂并打 warn(已非阻塞问 Lead d7ba5d3c,默认按此;备选是把臂搬到 argv `-c skills.config=[...]`,更厚)。
- **账号轮换期间的身份翻转**(C7):不阻止,只打日志 `keyed_home_identity_switch`;不引入「按账号分家」(那会把记忆按账号切开,违反键定义)。

## 6. 身份没解析出来怎么办

`resolveRunnerMemoryIdentity` 失败(`no_project` / `no_role` / `invalid_*`)时**回落到今天的执行级家**,并打一行 `codex-home identity_unresolved reason=<…> → execution home`。不发明别名(FLY-2147 原则),不阻塞派发。当前生产里 codex 的 `main` 会话(4 行)会走这条回落。

## 7. 边界(本单不做)
- ⛔ 不清理今天 867 个一次性家(其中 409/383 个是唯一证据);⛔ 不动 `~/.codex` 公共家与 `~/.codex-*` Lead 家;⛔ 不改四道节流闸;⛔ 不改 `cli_auth_credentials_store`。
- Lead 家(`~/.codex-honeylemon` 等)由启动脚本管(PRD §5.5.2),本单只给解析器一个能接 Lead id 的入口,不改 Lead 启动器。
- B2 的「种回去」(把旧家记忆迁入键式家)与验收留给 [2355·B2]。
- 真凭据并发臂不重跑(Lead 2026-09-05:不让 founder 为此重登 business)。

## 8. 待 Lead 裁的两个非阻塞问题
- 99a2e4f7(已答:引用旧证据,不重跑真凭据臂,偏最小形状)。
- d7ba5d3c(技能臂家级属性 vs 搬到 argv;默认前者)。
