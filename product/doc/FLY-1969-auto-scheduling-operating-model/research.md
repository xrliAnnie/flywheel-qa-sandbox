# FLY-1969 自动排期 operating model — 调研(E1–E6 重判的证据底)

Issue: FLY-1969 (https://linear.app/geoforge3d/issue/FLY-1969/编排co-create-自动排期-operating-model-重判被-cancel-的大-dag353104311401168)
日期: 2026-08-21
基于: exploration.md

---

## 0. 这份文档描述的是哪个世界

| 世界 | 值 | 说明 |
| --- | --- | --- |
| 本分支 worktree HEAD | `772a116ed` | = `origin/main`,工作区干净 |
| 生产 deployed-sha | `d97bd1173` | 落后 main **3 个 commit**(#911 / #914 / #913) |

**本文所有代码结论同时适用于 [生产现状] 和 [main]** —— 逐个 `git diff d97bd1173 772a116ed -- <file>` 核过,四个关键文件在两个 SHA 之间**字节相同**:

```
SAME: packages/teamlead/src/bridge/runner-admission.ts
SAME: packages/config/src/workflow-menu-contract.ts
SAME: packages/teamlead/src/bridge/patrol-tick.ts
SAME: packages/config/src/patrol-config.ts
```

落后的那 3 个 commit 是 FLY-1940 / FLY-1728 / claude-profile,与本单判词无关。

**as-of 2026-08-21 17:30 本机实测。** 下面每条结论都带重核命令。

---

## 1. E1 · 决策 schema + 耐久台账 + 默认关 + 空跑

### 旧设计说什么(FLY-353 PRD §16)
定义 typed `DispatchDecision` schema;每次派发前写 durable dispatch ledger(`queued`/`dispatching`/`dispatched`/`escalated`/`done`);全局 kill switch + `FLYWHEEL_AUTO_DISPATCH` **默认 off** + allowlist;首批 **dry-run / report-only**;含 §12 删 `dag-resolver` 的迁移。

### 现状核对

**① `DispatchDecision` / `FLYWHEEL_AUTO_DISPATCH` 从未存在。**
```
grep -rln "AUTO_DISPATCH\|DispatchDecision" packages --include="*.ts" | grep -v node_modules | grep -v /dist/
→ 零命中
```
⚠️ 零命中的范围限定:只扫了 `packages/**/*.ts`,排除 `node_modules` 与 `dist`。脚本目录未扫。

**② 耐久台账已经有了,但不是 dispatch 维度的。**
`packages/teamlead/src/workflow-ledger-states.ts` 定义 workflow run/node 的状态集:
`pending / admitted / running / review / done / failed / completed / superseded`。
⇒ **run 起来之后**的每一步都有耐久台账;**决定要不要起、起给谁**这一段没有台账。

**③「加一个默认关的新开关」现在违反既有铁律。**
CLAUDE.md 里程碑逐字记载:
- FLY-1466:按 Annie「不加新 flag」铁律,把 3 个 flag 从 registry/source/test 完整剥除
- FLY-1806:删除 31 个 raw flag,固化为 23 条 ON / 3 个数值 / 5 条 OFF
- FLY-1808:再拆 10 条真开关 + 2 条移出 registry
- FLY-1455:flag 登记强制闭网(新增 flag 要过 registry 漂移守卫)
⇒ E1 的「`FLYWHEEL_AUTO_DISPATCH` 默认 off + allowlist」这个**形态**已经不可用了。要的那个安全性(不许它自己乱派)仍然成立,但载体必须换。

**④ `dag-resolver` 还在,但已经半死。**
```
packages/dag-resolver/{DagResolver.ts, LinearGraphBuilder.ts, types.ts, index.ts}
```
生产消费者只剩**类型**:`Blueprint.ts:49` 和 `PreHydrator.ts:1` 只 `import type { DagNode }`。
`DagResolver` **类**本体的非测试消费者只有 `edge-worker/src/DagDispatcher.ts`,而 `DagDispatcher` 在非测试代码里只被注释提到,没有被实例化。
⇒ §12 的「删旧引擎」仍然成立,但它今天是**清理债务**,不再是「先删了才能建新的」的前置。

**重核命令**
```bash
grep -rln "AUTO_DISPATCH\|DispatchDecision" packages --include="*.ts" | grep -v node_modules | grep -v /dist/
grep -rn "DagResolver\|flywheel-dag-resolver" packages --include="*.ts" | grep -v node_modules | grep -v /dist/ | grep -v __tests__
```

### 判
**部分成立,形态必须改。** 台账复用现有的、不新建一套;「默认关 + 空跑」的安全性改由**人**承载(先只产建议、Lead 点头才派),不再由 flag 承载。

### 我不确定的
如果第一版就是「产建议 → Lead 点头」,那 dry-run 本身就是多余的一层。要不要保留 dry-run,取决于第一版是不是真有「不经人手直接派」的路径。

---

## 2. E2 · CoS 分诊(只产决策,不 spawn)

### 旧设计说什么
CoS LLM triage 每轮产 typed decision(相关?/派谁/模板/何时/置信);低置信 escalate;`canSpawnRunners:false` 不变。

### 现状核对
- CoS(Aunt Cass)**已在生产运行**,两层链路(founder → CoS → 部门 Lead → Runner)是 FLY-1270 落的,CLAUDE.md 记为 ✅ Merged (PR #267)。
- `canSpawnRunners` 边界仍在(FLY-245 / FLY-247 inc2a 的里程碑都在引用它)。
- **缺的是「周期性主动」这一半**:今天 CoS 是**被动**的 —— 有人在频道说话她才动。没有任何机制让她定期回头扫一遍没派出去的 backlog。

### 判
**核心原样成立,且底座已经在跑。** 真正没建的是「定时主动扫一遍 backlog 并产出建议」。这是 E2 里唯一还需要建的东西。

---

## 3. E3 · 引擎校验 + 派发 + 每 6h 扫 + 读负荷补齐到容量

### 旧设计说什么
引擎校验 decision → 经 `RunDispatcher` / `/api/runs/start` + `DepartmentRegistry` 边界派发(dept Lead 执行 spawn);**每 6h 周期扫 + 读 per-Lead 负荷 + 补齐到 capacity + 按余量分发**;轻量依赖 fail-closed。

### 现状核对 —— 这条变化最大

**① 「周期扫」的一半已经建了,而且在生产真的在跑。**
FLY-1687(PR #827,commit `40552e36a`)= Bridge 给每个 Lead 敲**闹钟**。
- 代码:`packages/teamlead/src/bridge/patrol-tick.ts`、`packages/config/src/patrol-config.ts`
- 频率:默认 **60 分钟**(`DEFAULT_PATROL_INTERVAL_MINUTES = 60`),可配,clamp 在 10 分钟–24 小时
- 生产实测(只读 `~/.flywheel/teamlead.db`):
  ```
  patrol_tick | 274 条 | 最近一条 2026-08-21 23:48:37
  近 2 天 82 条
  ```
  ⇒ 不是「代码在仓库里」,是**真的在敲**。

**② 但它巡的是「已经在跑的」,不是「还没派的」。**
`StateStore.getPatrolRosterSessions` 的名册限定在:
```sql
status IN ('running','ship_parked','awaiting_review','approved_to_ship','pending','design_done')
```
全是**已经起过 session** 的。Linear 上从没派过的 issue **不在它的视野里**。

**③ 「读负荷 → 补齐到容量 → 按余量分配」完全没建。**
- `grep -rln "maxConcurren\|capacity"` 在 teamlead/config 里的命中全是别的语义(thread archive / review coordinator / triage route),没有 per-Lead 容量模型。
- `.flywheel/config.yaml` 与 `~/.flywheel/projects.json` 里**没有**任何 concurrency / capacity / max_runner 键。

**重核命令**
```bash
sqlite3 "file:$HOME/.flywheel/teamlead.db?mode=ro" \
  "SELECT event_type,COUNT(*),MAX(created_at) FROM lead_events WHERE event_type LIKE '%patrol%' GROUP BY event_type;"
grep -n "getPatrolRosterSessions" -A 8 packages/teamlead/src/StateStore.ts
grep -n "concurren\|capacity\|max_runner" .flywheel/config.yaml ~/.flywheel/projects.json
```

### 判
**核心成立,但入口变了。** 不用再造一个周期扫 —— 挂在已经在跑的巡检钟上。真正没做、也是 Annie 8/21 点名的那件(「读各 Lead 负载补到上限、按剩余分配」)= **容量与分配模型**,零基础。
另外要补一件旧 PRD 没写的:让巡检的视野**从「在跑的」扩到「没派的」**。

### 我不确定的
60 分钟 vs 旧设计的 6 小时,哪个才是对的节奏。现在是 60 分钟且可配,先不动。

---

## 4. E4 · 护栏 + 面板硬化

### 旧设计说什么
pause / takeover · 失败 → escalated · max concurrency · Discord 面板(每轮 summary HTML → core @founder,dedupe / noise budget)· cron 定时节点。

### 现状核对
- **暂停 / 接管 / 失败升级**:已建。`workflow_engine_escalation` 在生产 lead_events 里有 12,505 条(最近 2026-08-14)。
- **权限护栏**:`founder-only-authority` 合同 + Bridge 侧硬闸(FLY-175 Track 1/2)已建。
- **告警去重 / noise budget**:FLY-1612 把告警收敛成 durable episode(1/2/4/8 分钟退避、第 5 次终止),FLY-1218/1220 治了两类刷屏。已建。
- **max concurrency**:❌ 已被**刻意删除**,见下面 E5。
- **面板**:❌ 仍然没有。巡检钟的名册(FLY-1925 给它加了 TURN holder / 非终态 rework / 现场存活)是最接近面板的东西,但它是**发给 Lead 的一条消息**,不是一个能一眼看全景的面。

### 判
**大部分已建。** 剩下的是「面板」这一块 —— 而且它跟 Annie 8/21 要的「系统要明说派发受限的原因」是同一块。

---

## 5. E5 · 动态负载触发(旧标「北极星,后续」)—— 本轮最大的一条翻转

### 旧设计说什么
系统水位(内存 / token)决定何时扫;capacity 对接 FLY-1022。标记为**后续**。

### 现状核对 —— 它已经部分建了,而且阈值可能是错的

**① 「最多 N 个 runner」的硬上限已经被删掉,换成按真实资源压力放行。**
`packages/teamlead/src/bridge/runner-admission.ts` 开头逐字:
> FLY-123 WS-D (P4 = no manual cap): runner admission by REAL resource pressure, not a hardcoded N.
> The old `maxConcurrentRunners` (default 3, hard ceiling 20) is retired.
> Annie's requirement: Codex runner count is uncapped — the only constraint is runtime resource (machine load + memory).

⇒ Annie 8/21 给的机制(「机器会先撑不住 ⇒ 天然封顶」)**不是新想法,是她自己早就定过、并且已经落地的模型**。

**② 但两条腿只有一条是通的。**
```
loadPerCore: parsePosEnv(env.FLYWHEEL_RUNNER_LOAD_PER_CORE, 8.0)     ← 始终开
minFreeMem : parseNonNegEnv(env.FLYWHEEL_RUNNER_MIN_FREE_MEM_MB, 0)  ← 默认 0 = 关
```
内存那条腿**默认是关的**,而且关得有硬理由(代码注释):macOS 的 `os.freemem()` 只数真正空闲页、不含可回收的 inactive/speculative/purgeable,healthy 16 GiB Mac 读出来只有 ~100–200 MB,一开就会把**每一个** spawn 都拒掉。
⇒ **Annie 的心智模型说的是「内存」,今天真正在起作用的是「负载」。**

**③ 阈值设在机器已知断裂点之上 —— 这是我要给她的 pushback。**
本机实测(2026-08-21 17:26):
```
sysctl -n hw.ncpu → 18
uptime            → load averages: 45.00 45.21 32.54
```
阈值 = 每核 8.0 × 18 核 = **load 144 才开始拒**。
而记忆里有一条实测事故(2026-08-06,FLY-1648 QA):**load 顶到 88.88 时生产 Bridge 就已经退出过一次**,裸奔 32 分钟。

⚠️ **成色标注**:88 那次是「时间与负载高度吻合」的强相关,**不是**受控实验证明的因果 —— 原始记录里就是这么写的,我不升级它。
⚠️ 144 这个数是从代码默认值 × 本机核数**算**出来的,**不是**观测到系统在 144 拒绝过。
✅ **但算式的两个输入已核实(as-of 2026-08-21 17:40,[生产现状])**:活的 Bridge 进程(pid 21441,`/health` 报 `buildSha=d97bd1173`)的环境里**没有** `FLYWHEEL_RUNNER_LOAD_PER_CORE` / `FLYWHEEL_RUNNER_MIN_FREE_MEM_MB`,`~/.flywheel/.env` 与仓库 `.env` 里也都没有 ⇒ **走的就是代码默认值**(每核 8.0;内存闸 0 = 关)。`hw.ncpu = 18`。
⚠️ 残留边界:我核的是「进程 env + 那两个 .env 文件」。若这两个值还有第三个注入口径(运行时从别处读),我没查。

即便如此,方向性结论是稳的:**放行阈值(算出来 144)明显高于唯一一次观测到机器出事的水位(88)** ⇒ 今天这个「天然封顶」的表现形态更接近「直接崩」,而不是「优雅地慢下来」。

**重核命令**
```bash
sysctl -n hw.ncpu; uptime
grep -n "loadPerCore\|minFreeMem\|FLYWHEEL_RUNNER_" packages/teamlead/src/bridge/runner-admission.ts
# 未做:核生产 Bridge 进程的实际 env
ps eww -p "$(pgrep -f run-bridge | head -1)" | tr ' ' '\n' | grep FLYWHEEL_RUNNER_
```

### 判
**从「北极星、后续」提级为「核心、且现在是错的」。** 要做的不是发明新机制,是:
1. 把负载阈值挪到实测断裂点以下;
2. 把内存那条腿真正接上(得先换一个可靠的「可用内存」口径,不能用 `os.freemem()`);
3. 补一个今天完全没有的拒绝理由(见下)。

### 我不确定的
生产实际 env 值(上面已标)。以及内存口径换成什么 —— 这是工程题,归 Tadashi。

---

## 6. E6 · 第一层模板泛化

### 旧设计说什么
inject / fork 等通用 template-runtime 能力;**v1 不做**,v1 只支持现有成熟形态(single-session / 三段式 eng / product single-session-gate)。第一层模板本身 = FLY-1020。

### 现状核对 —— 这条基本可以关掉
`packages/config/src/workflow-menu-contract.ts` 是**唯一真相表**,今天有 6 个任务类型 → 6 套编译模板:
```
code → tpl_code · simple_code → tpl_simple_code · prd → tpl_prd
design → tpl_design · prototype → tpl_prototype · generic → tpl_generic_menu
```
FLY-1693 已把旧模板整批退役,生产只保留这 5 个 menu seed(+ tpl_simple_code)。
配套的 schema-v2 workflow 引擎(TURN / activation / gate / terminal `land`)= FLY-1655 / FLY-1788 已落。

⇒ 旧设计写的「v1 不做、只支持现有成熟形态」这句话的前提已经不成立:**成熟形态本身已经被泛化成模板层了。**

### 判
**已建,这条可以关掉。** 剩下的「Lead 当场按任务组流程」属于 FLY-1140 那条线,不在本轮。

---

## 7. 汇总判词表

| 块 | 判 | 一句话 |
| --- | --- | --- |
| **E1** | 🟡 形态要改 | 台账复用现有的;「默认关的开关」违反现行铁律,安全性改由人承载 |
| **E2** | 🟢 核心成立 | 底座在跑,只缺「定时主动扫 backlog 产建议」这一半 |
| **E3** | 🟡 入口变了 | 巡检钟已在生产真跑(60min);缺的是**容量与分配**,且视野要从「在跑的」扩到「没派的」 |
| **E4** | 🟢 大半已建 | 只剩「面板」,而它 = Annie 要的「明说派发受限的原因」 |
| **E5** | 🔴 提级 + 数字错了 | 从北极星升为核心;阈值算出来 144,唯一观测到出事的水位是 88 |
| **E6** | ⚪ 可关 | 模板层已建好 6 类 |

---

## 8. Annie 8/21 说的三件,逐件对回去

| 她说的 | 旧 PRD 里对应 | 今天真实状态 |
| --- | --- | --- |
| 读各 Lead 负载,补到容量上限、按剩余分配 | E3 | ❌ 零基础 |
| 用系统水位(内存 / token)决定何时扫 | E5(当时标北极星) | 🟡 负载腿通、内存腿关、阈值可能过高 |
| default-off + dry-run 先行 | E1 | 🔴 形态已不可用(不加新 flag 铁律) |

---

## 9. 她推翻我那条 pushback 之后,还剩下的设计后果

她的机制我接受:等 review 的 node 占内存 → 机器先撑不住 → 天然封顶。**保留的后果**:

这些 node 是**常驻占用**(QA-PASS 的持有者会 park 着活到 post-ship),会吃掉可派发容量 ⇒ **她面前堆得越多、系统能派的越少**。这是好的背压,但**它长得像「机器变慢了」**。

**现状核对**:今天 runner-admission 的拒绝理由是分类型的 —— `load_pressure` / `memory_pressure`,代码注释还特意写明「deliberately NO `explicit_limit` reason」。
⇒ **没有**任何一类理由叫「N 个在等你 review」。这是一个具体、能建、边界清楚的缺口。

⛔ 建议**不做**她提的「超过 30 个就停派」:她第一个答案(物理封顶)比它好;30 是一个要人维护、且一定会调错的数字。这也跟 FLY-123 刻意删掉 N-cap 的方向一致。

---

## 10. 我没查的 / 已知盲区

- ~~生产 Bridge 进程的实际 env~~ —— **已核实**(见 §5):两个阈值 env 都没设,走默认值。残留:144 仍是算出来的,不是观测到系统在 144 拒过。
- **token 水位**:E5 原文写「内存 / token」,我只核了内存和负载,**没查** token 维度今天有没有任何机制。
- 脚本目录(`scripts/`)没扫 `AUTO_DISPATCH`,只扫了 `packages/`。
- **自查**:我第一次用 `curl --max-time 15` 探 `/health` 拿到空响应,一度以为 Bridge 没响应;换 `--max-time 30` 后是 `http=200 / 4.1s`。当时 load 45 —— 短超时探针超时 ≠ 服务挂了,这个坑我踩了一次。
- FLY-1140 那条线(动态组 DAG)只读了 issue 与 PRD 目录清单,**没有**逐条重判 —— 本轮范围外。
