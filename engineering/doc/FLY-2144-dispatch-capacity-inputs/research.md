# FLY-2144 派发容量输入 + dag-resolver 退役 — 调研
Issue: FLY-2144 (https://linear.app/geoforge3d/issue/FLY-2144/2108e-派发判断的容量输入quota-机器内存当前值可读-附-dag-resolver-退役)
日期: 2026-09-02
基于: exploration.md

---

## 0. 本调研要钉死的东西

exploration 定了方向:**一个 builder、两个出口、零闸门**;R8 一并删两个 v0.1 脚本。本文把每条接缝落到**文件 / 函数 / 字段 / 测试**级别,给 plan 直接照抄。所有代码事实为本单自核(2026-09-02,分支 `flywheel-FLY-2144` @ `63154c214`)。

**Lead 裁定(question `8be11d15`,2026-09-02)**:
1. 内存口径 = macOS `memory_pressure` 命令的 `System-wide memory free percentage`(founder 2026-08-13 裁定);排除 `vm_stat` free% 与 `vm.swapusage`;Bridge 无既有采样 ⇒ 新增只读采样器,带 `observed_at`;紧张参考线 free% < ~15%,仍是判断输入不是闸门。
2. R8 同 PR 删 `scripts/run-project.ts`、`scripts/smoke-test.ts`、`scripts/lib/setup.ts` 的 `DagDispatcher` 导出;保留 `run-issue.ts`;无兼容层。

---

## 1. 内存采样器:`memory_pressure` 命令合同

### 1.1 实测(本机,2026-09-02 19:40 PT)

```
$ /usr/bin/memory_pressure          # 无参数
The system has 51539607552 (3145728 pages with a page size of 16384).
Stats: … Swap I/O: … Page Q counts: … Compressor Stats: … File I/O: …
System-wide memory free percentage: 75%
elapsed_ms=5   exit=0
```

- 只读、5ms、exit 0;末行就是要的那一个数。
- 机器 `hw.memsize = 51539607552`(= 48 GiB),`hw.ncpu = 18`,当时 load1 6.35。

### 1.2 ⚠️ 危险面(man page 原文)

`memory_pressure [-l level] | [-p percent_free] | [-S -l level] | [-s sleep_seconds]` —— **带任何参数都是「施加 / 模拟内存压力」**:`-l warn|critical` 会真的分配内存直到系统发低内存通知;`-p N` 会分配到剩 N%;`-S` 模拟。

⇒ 采样器合同:
| 项 | 合同 |
| --- | --- |
| 二进制 | 常量 `MEMORY_PRESSURE_BIN = "/usr/bin/memory_pressure"`(绝对路径,不走 PATH) |
| argv | 常量 `MEMORY_PRESSURE_ARGV: readonly string[] = []`,**永远为空** |
| 调用 | `execFile(bin, [], { timeout: 2000, maxBuffer: 64KiB })`,不经 shell |
| 解析 | **先取 stdout 最后一个非空行**,再整行匹配 `/^System-wide memory free percentage:\s+(\d{1,3})%$/`(⛔ 不用 `/m` —— `$` 在多行模式下匹配任意行尾,合法行后面跟垃圾也会过,Codex R1 HIGH-5);取整、必须在 0..100,否则 `null`;`maxBuffer: 64 * 1024` 写进 `execFile` options |
| 平台 | `process.platform !== "darwin"` → 不执行,`unavailable: "structural: memory_pressure_unsupported_platform"` |
| 失败 | 超时 / ENOENT / 非零退出 / 解析失败 → `freePct: null` + 稳定 token(`transient: memory_pressure_timeout` / `structural: memory_pressure_missing` / `transient: memory_pressure_parse_failed`);**绝不抛到调用方** |
| 时间戳 | `observedAt` = 命令返回那一刻(注入 clock) |
| 负向守卫 | 单测:注入 `execFile` 桩,断言收到的 argv `toEqual([])` 且 bin 为绝对路径;另一条**源码级**测试读 `machine-free-pct.ts` 文本,断言不含 `"-l"`, `"-p"`, `"-S"`, `"-s"` 字面量与 `/bin/sh` |

### 1.3 为什么现采、不缓存、不加定时器

- 5ms、只读、无副作用 ⇒ 每次读快照时现采,`observedAt` 天然准确,零新状态、零新定时器(FLY-169 「不加新 timer」惯例)。
- ⛔ 不加 `FLYWHEEL_MEMORY_PRESSURE_CMD` 之类的 shell 覆盖种子(FLY-1142 有 `FLYWHEEL_SWAP_SENSOR_CMD` 先例):单测走注入,HTTP 测试走 `BridgeConfig` 注入,真机 E2E 读真值 —— 少一个能把 Bridge 变成「跑任意 shell」的入口。

### 1.4 与 FLY-1142 传感器的关系

`MemoryPressureMonitor`(vm_stat 口径)继续**只**服务 `fleet_pressure_hold` 手刹。快照里**旁注**手刹是否置位(§4),但「内存当前值」只有 `memory_pressure` 这一个来源。两者数值定义不同,不做换算、不做对比。

---

## 2. 负载:`RunnerAdmissionController` 加只读 `probe()`

`packages/teamlead/src/bridge/runner-admission.ts`,现有私有字段 `loadavgFn / cpuCount / loadPerCore` + `tryAdmit()`(无副作用,只读探针)。

```ts
export interface AdmissionProbe {
	load1: number;
	cpuCount: number;
	perCore: number;            // load1 / cpuCount
	thresholdPerCore: number;   // this.loadPerCore(默认 8.0)
	decision: AdmissionDecision; // = this.tryAdmit() 此刻结果,只读
}
probe(): AdmissionProbe
```

- ⛔ `tryAdmit()` 一行不改;`AdmissionReason` 联合类型不加成员。
- 测试:沿用 `runner-admission.test.ts` 的注入风格(`loadavgFn`, `cpuCount`)。

---

## 3. 手刹 / 暂停:StateStore 既有读接口

| 字段 | 来源 | 形状 |
| --- | --- | --- |
| `pressureHold` | `store.getFleetPressureHold()` → `{ set_by, set_at, watermark } \| undefined` | `{ active, setBy?, setAt?, watermark? }` |
| `admissionPause` | `store.getAdmissionPause()` → `{ active, remainingSeconds }` | 原样 |

两者是派发前**一定会撞到**的事实(`tryAdmit` 先查它们),所以 Lead 必须看得见;但它们是既有机制,本单只读不改。

---

## 4. 活跃 runner 计数

`store.getActiveSessions()` = `status IN ('running','ship_parked','awaiting_review','approved_to_ship')`(`StateStore.ts:8794-8796`)。

```ts
runners: {
	running: number;                 // status === "running"
	parked: number;                  // 其余三种(占内存、不占 CPU)
	total: number;
	byProject: Record<string, { running: number; parked: number }>;
	observedAt: string;
}
```

PRD research §9 那条判据在这里落地:**park 着的 QA-PASS 持有者也吃容量**,所以分开数。⛔ 不数 `inflight`(那是 startDispatcher 的瞬态,`/api/triage/data` 已有)。

---

## 5. 额度(quota)

### 5.1 Claude:读 `claude-accounts.json`

- 路径:`defaultStorePath()`(`FLYWHEEL_CLAUDE_ACCOUNTS_PATH` 可覆盖,测试用);读法:`existsSync` 区分「没有」,`readStoreStrict(path)`(既有,shape 非法 / JSON 坏 ⇒ `null`)区分「坏了」;⛔ 不用 `readStore()`(它把坏文件吞成空 store,Codex R1 HIGH-3)。
- 每账号取:`name, quotaExhaustedUntil, weeklyResetAt, lastObservedAt, observedFiveHPct, observedSevenDPct, authExpired, refreshTokenInvalid, profileVerifyFailed`;顶层取 `activeAccount`。
- **值级校验**(Codex R2 HIGH-2,`readStoreStrict` 只验 shape 不验值):`name` 必须匹配安全别名文法 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`(⛔ 禁 `@`、空白、控制符 —— 别名里不许长得像邮箱)且在 store 内唯一;`activeAccount` 为 `null` 或精确命中唯一账号,否则整格 `unavailable: "transient: account_store_invalid"`;三个 auth flag 只能缺席或 boolean,非 boolean ⇒ 该账号整条丢弃并在 `unavailable` 记 `transient: account_entry_invalid`(其余账号照常);**三个时间字段**(`lastObservedAt`、`weeklyResetAt`、`quotaExhaustedUntil`)一律 `Date.parse` 为有限 instant 后只输出 `toISOString()` 或 `null`,⛔ 绝不透传 store 原字符串(`readStoreStrict` 只验它们是 string,白名单挡不住塞进 string 的邮箱 / token / 控制符,Codex R3 HIGH-4);`lastObservedAt` 还必须 **不在未来**(> now + 60s ⇒ `observedAt: null, ageMinutes: null, stale: null`,⛔ 不得算成负账龄的 fresh);百分比 `Number.isFinite && 0..100`。**账号过滤完成后再核 `activeAccount`**(为 `null` 或命中剩余账号中唯一一个,否则置 `null` 并追加 `transient: account_store_invalid`)。负向测试:别名含 `@` / 重名 / `activeAccount` 指向不存在或已被过滤的账号 / 未来观测 / 字符串型 auth flag / reset 字段塞邮箱或换行,各自断言序列化响应不含原值。
- ⛔ **脱敏**:`AccountEntry.identity.email` 存在于 store,快照**不得**带出(负向测试:store 夹具含 `identity.email`,断言响应文本不含该邮箱);`modelCaps`、`identityMismatch`、`switchCooldownUntil` 也不带(与派发判断无关)。
- 新鲜度:`ageMinutes = now - lastObservedAt`;`stale = ageMinutes > staleAfterMinutes`;`staleAfterMinutes = 2 × candidateSweepMinutes`(`loadQuotaMonitorConfig()` 的值,缺省 60 ⇒ 120)。规则本身写进快照(`staleAfterMinutes` 字段),读者看得见尺子。
- 生产实况(2026-09-03T02:16Z 观测):5 账号全在 16 分钟内;活跃 `personal` 5h 9% / 7d 30%。
- 池未配置(文件不存在,QA slot 常态):`unavailable: "structural: account_pool_not_provisioned"`,`accounts: []`。

### 5.2 Codex:如实「无数值源」

`codex-account-ledger/*.json` 只有 profile/plan/mode/lastObservedAt(且含 email);撞额度只能从 pane 文本检出。快照固定写:
```ts
codex: { source: null, unavailable: "structural: codex_no_usage_api" }
```
⛔ 不读 ledger 目录(避免带出 email、避免造「像数值」的东西)。

---

## 6. `CapacitySnapshot` 类型(plan 直接抄)

文件:`packages/teamlead/src/bridge/capacity-snapshot.ts`

```ts
export const CAPACITY_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/** 每个顶层格同一形状:数据字段全部可为 null,`observedAt` 可为 null,失败时只填 `unavailable`。
 *  ⛔ 禁止用 0 / false 冒充观测值 —— 读不到就是 null + token。
 *  两种 null(Codex R3 HIGH-3):顶层格的 null 必须伴随 `unavailable`;账号对象内部字段的 null 是
 *  「本来就允许 unknown」(未观测 / 窗口未开 / 时间无法解析),不带 `unavailable`,渲染成 `?`。
 *  所有 `unavailable` 必须过 isCapacityUnavailableToken():精确 allowlist(plan §3.1 的 13 个 token)
 *  + 唯一受限模式 /^transient: memory_pressure_exit_[0-9]{1,3}$/;字符文法只是函数内第一层,不单独作判据。 */
export interface CapacitySnapshot {
	schemaVersion: 1;
	generatedAt: string;                       // ISO,builder 完成那一刻
	memory: {
		source: "memory_pressure";               // /usr/bin/memory_pressure,空 argv
		freePct: number | null;                  // System-wide memory free percentage
		observedAt: string | null;
		tightBelowPct: number;                   // 15,参考线,不是闸门(常量,永远有值)
		tight: boolean | null;                   // freePct < tightBelowPct;null = 读不到
		unavailable?: string;                    // 稳定 token,见 §1.2
	};
	load: {
		load1: number | null; cpuCount: number | null; perCore: number | null; thresholdPerCore: number | null;
		observedAt: string | null;
		unavailable?: string;                    // "structural: admission_controller_absent" | "transient: load_probe_failed"
	};
	brakes: {
		pressureHold: { active: boolean | null; setBy?: string; setAt?: string; watermark?: string | null; unavailable?: string };
		admissionPause: { active: boolean | null; remainingSeconds: number | null; unavailable?: string };
		admission: { admit: boolean | null; reason?: string; detail?: string; unavailable?: string }; // tryAdmit() 此刻结果,只读
		observedAt: string | null;
	};
	runners: {
		running: number | null; parked: number | null; total: number | null;
		byProject: Record<string, { running: number; parked: number }> | null;
		observedAt: string | null;
		unavailable?: string;                    // "transient: session_store_unreadable"
	};
	quota: {
		claude: {
			source: "claude-accounts.json";
			activeAccount: string | null;
			staleAfterMinutes: number;             // 常量算出,永远有值
			accounts: Array<{
				name: string; active: boolean;
				fiveHPct: number | null; sevenDPct: number | null;
				observedAt: string | null; ageMinutes: number | null; stale: boolean | null;
				weeklyResetAt: string | null; exhaustedUntil: string | null; authUnusable: boolean;
			}>;
			unavailable?: string;                  // "structural: account_pool_not_provisioned" | "transient: account_store_unreadable"
		};
		codex: { source: null; unavailable: "structural: codex_no_usage_api" };
	};
}

export interface CapacitySnapshotDeps {
	store: Pick<StateStore, "getActiveSessions" | "getFleetPressureHold" | "getAdmissionPause">;
	/** scaffold / 测试 Bridge 可缺席(plugin.ts 本来就写 `config.runnerAdmission?.`);缺席 ⇒ load 与 brakes.admission 两格 unavailable */
	admission?: Pick<RunnerAdmissionController, "probe">;
	readMemoryFreePct: () => Promise<MemoryFreePctReading>;   // machine-free-pct.ts
	accountStorePath?: string;                                // 默认 defaultStorePath()
	quotaConfigPath?: string;                                 // 默认 defaultQuotaMonitorConfigPath()
	now?: () => number;
}
export async function buildCapacitySnapshot(deps: CapacitySnapshotDeps): Promise<CapacitySnapshot>
```

不变量:
- **只读**:deps 里没有任何写方法;builder 不 import 任何 `set*/clear*/write*`。
- **永不抛、永不编数**:每个分支各自 try/catch,失败 ⇒ 该分支数据字段全 `null` + `unavailable` token;整体总能返回一份快照(与 patrol `UNAVAILABLE(...)` 惯例同形)。⛔ 任何分支都不得用 `0`/`false`/`[]` 冒充「读到了」—— 这是 Codex R1 BLOCKER-1 钉死的合同,单测逐分支注入抛错验证。
- **每格带时间**:memory/load/brakes/runners 各自 `observedAt`,quota 每账号 `observedAt + ageMinutes`,整体 `generatedAt`(PRD R5 判据)。
- **quota 读法**(Codex R1 HIGH-3):`existsSync(path)` 为假 ⇒ `structural: account_pool_not_provisioned`;为真则 `readStoreStrict(path)`(既有,shape 非法/JSON 坏 ⇒ `null`)⇒ `transient: account_store_unreadable`,`accounts: []` **且带 unavailable**;⛔ 不用 `readStore()`(它把坏文件伪装成空池)。每个白名单字段再做运行时校验:百分比 `Number.isFinite && 0..100`,时间 `Date.parse` 有限,否则该字段 `null`。

---

## 7. 出口 A:`patrol_tick` payload + 渲染

### 7.1 生产侧(`patrol-tick.ts`)

- `PatrolTickDeps` 加可选 `capacity?: () => Promise<CapacitySnapshot>`。
- pass 作用域的惰性 helper(⚠️ 缺席与同步 throw 都要兜住,Codex R2 MEDIUM-5):
  ```ts
  let once: Promise<CapacitySnapshot | undefined> | undefined;
  const capacityOnce = () =>
  	(once ??= Promise.resolve()
  		.then(() => deps.capacity?.())
  		.catch(() => undefined));
  ```
  在组 `payload` 前:`const capacity = await capacityOnce();`
- `payload` 加 `...(capacity ? { capacity } : {})`。
- `HookPayload` 加 `capacity?: CapacitySnapshot`(`hook-payload.ts` 接口)。
- `plugin.ts:8855` 的 `createLeadPatrolTickPass({...})` 传 `capacity: () => buildCapacitySnapshot(capacityDeps)`。
- 一次 pass 内 **惰性只采一次**:patrol pass 本身每 60s 跑(20 tick × 3s),但多数 pass 一条 tick 都不发(名册空 / 未到点 / settlement 未完成),所以 builder 不在项目循环前无条件调用,而是用 pass 作用域的 memoized promise,在**第一条确定要组的 payload** 之前才采;同一 pass 里真发 tick 的多个 Lead 共用这一份(PRD §1.2)。名册为空的 Lead 不发 tick(既有 `roster.length === 0 → continue`)⇒ 空闲起步只能靠 HTTP 出口。

### 7.2 渲染(`hook-payload.ts formatPatrolTick`)

- `capacity` **缺席 ⇒ 输出与今天逐字节相同**(`patrol-tick-render.test.ts` 的 `toBe` 精确断言继续成立;legacy replay 行不受影响)。
- 存在 ⇒ 在 `"[patrol_tick] 巡检时间到。"` 之后、🔴 summary 之前插入固定三行(全部是**事实**,零判断词 —— 现有测试禁用 `check/verify/suggest/建议/怀疑/该查`):

```
容量(Bridge 采样 · 判断输入,不是闸门;快照 2026-09-03T02:16:41Z):
- 内存 free 75%(memory_pressure,参考线<15%)| 负载 6.35/18核=0.35(阈 8.0)| 手刹=无 | 部署暂停=无 | 在跑 7 · 停车 3
- 额度 Claude ★personal 5h 9%/7d 30%(16m 前)· business 11/0(17m 前)· school 0/10 · shopping 0/1 · personal1 0/0 | Codex 无数值源
```

- **局部不可用照样三行**(Codex R2 MEDIUM-4):每一格都有自己的 unavailable 写法 —— `内存 free ?(<token>)`、`负载 ?(<token>)`、`手刹=?(<token>)`、`部署暂停=?(<token>)`、`在跑 ?(<token>)`、`额度 Claude ?(<token>)`;合法的 `null + unavailable` 只让那一格变 `?`,其余格照常。
- 账号行的 unknown 写法(Codex R3 HIGH-3):账号字段(`fiveHPct/sevenDPct/observedAt/ageMinutes/stale/weeklyResetAt/exhaustedUntil`)本来就允许 unknown,它们的 `null` 不带 `unavailable`:某窗口 `null` ⇒ 该窗口 `?`;账龄未知 ⇒ `(未观测)`;仍是三行。只有**顶层格**的 `null` 必须伴随 `unavailable`。
- 安全:数值只经 `Number.isFinite` + 范围校验后打印;账号名、`setBy` 经 `canonicalPatrolToken`;`unavailable` token 经 `isCapacityUnavailableToken()` —— **精确 allowlist**(plan §3.1 列出的 13 个稳定 token)+ 唯一受限模式 `/^transient: memory_pressure_exit_[0-9]{1,3}$/`,builder 与渲染器共用同一个函数(⛔ 不经 `canonicalPatrolToken` —— 那条 `^[A-Za-z0-9._-]{1,64}$` 不收冒号和空格,Codex R3 HIGH-2;⛔ 也不能只靠字符文法 —— `/^(structural|transient): [a-z][a-z0-9_]{0,47}$/` 会放过 `transient: suggest` 这类指令词,Codex R4 HIGH-1,它只留作函数内第一层);时间经 `Date.parse` 校验。**只有 shape 非法 / 注入**(该是数字的地方是字符串、顶层格 `null` 无 `unavailable`、账号名含换行、token 不在 allowlist)才整段退化为一行 `容量=⚠️ 账面不可读(<token>)`,与 `loops` 的 `unknownReason` 同形,**不抛**。
- 手刹置位时写 `手刹=置位(swap-sensor 自 2026-…)`;暂停时写 `部署暂停=剩 NNs`。
- `stale` 账号加 `(stale)` 后缀;`freePct === null` 写 `内存 free ?(<token>)`。

### 7.3 测试

- `patrol-tick-render.test.ts`:新 describe「FLY-2144 capacity lines」—— 存在 / 缺席 / 手刹置位 / stale / 内存不可读 / 恶意字符串 fail-closed;并复跑既有精确断言。
- `patrol-tick.test.ts`:harness 注入 `capacity`,断言 payload JSON 含 `capacity.schemaVersion === 1`;不注入时 payload 无该键;builder 抛错时 tick 照常发、payload 无该键。

---

## 8. 出口 B:`GET /api/capacity`

- 挂载:`plugin.ts`,`app.get("/api/capacity", tokenAuthMiddleware(config.apiToken), handler)`;**只认 master token**(不给 gemini scoped token,不进 `isGeminiScopedReachable` 白名单)。
- `TEAMLEAD_API_TOKEN` 未配置 ⇒ `503 { error: "capacity API requires TEAMLEAD_API_TOKEN" }`(与 `/api/admission` 同形)。
- 响应:`200` + `CapacitySnapshot` JSON;各分支不可用写在字段里,**不**用 5xx 表达「某一格读不到」。
- 注入:`BridgeConfig` 加可选 `capacityProbes?: { readMemoryFreePct?: () => Promise<MemoryFreePctReading>; accountStorePath?: string; quotaConfigPath?: string }`;`plugin.ts` 组 `capacityDeps` 时取之,缺省用真探针。
- 测试(`packages/teamlead/src/__tests__/capacity-route.test.ts`,照 `triage-data.test.ts` 起 `createBridgeApp`):无 token 401;有 token 200 且 `schemaVersion===1`;memory 探针返回 null → `memory.unavailable` 有 token 且仍 200;store 夹具含 `identity.email` → 响应文本不含邮箱;`admissionPause` 激活 → `brakes.admissionPause.active===true`。

### 8.1 Lead 怎么读(规则文本,落 `department-lead-rules.md`「Action Gate」节)

新增小节「Capacity input before dispatch (FLY-2144)」。⚠️ 与 `runner-patrol-rules.md:61-66` 的「`[patrol_tick]` 仍是纯闹钟…不采信 Bridge 单方转述」**不冲突的写法**(Codex R1 HIGH-4 + R2 HIGH-3 收口):那条规则管的是 **runner 状态**(名册要拿 tmux/gh/Discord 独立核);容量是 **Bridge 采样的读数**(`memory_pressure` / 账号文件 / 会话表),本单指定它就是 R4 的输入源,Lead 核的是它的**新鲜度**,不是去别处再采一份。内容四条:
1. **两种时刻,两个出口,同一个 builder**:
   - **在巡检那一轮里决定放活**(PRD §1.2「放新活直接读巡检那一次的结果」;[2108·B] 的拉活将落在这一轮)⇒ 用 `patrol_tick` 正文里的「容量」三行,它就是这一轮采的那份。
   - **在巡检之外的时刻决定**(某个 runner 刚跑完、founder 临时派单、名册为空所以根本没有 tick)⇒ 先 `GET $BRIDGE_URL/api/capacity` 再拍:
     `printf 'header = "Authorization: Bearer %s"\n' "${TEAMLEAD_API_TOKEN:?}" | curl --config - -fsS "${BRIDGE_URL:?}/api/capacity"`(secret 走 stdin,与 STEP 5 同款)。
   - 两个出口是**同一个 builder 的两次采样**,不是同一份快照;每份自带 `generatedAt`。⛔ 别引用 `generatedAt` 超过一个巡检周期(默认 60 分钟)的快照。
2. 它是**输入不是闸门**:读到内存紧 / 额度高 / 手刹置位,由 Lead 自己决定这一波放几个;花明显资源按 quota 自己拍,不问 founder(PRD R4/R7 原话)。
3. 每一格自带 `observedAt/ageMinutes`;`stale` 或 `unavailable` 的格不得当成新鲜事实引用。
4. tick 仍是闹钟:容量三行不改变 `[patrol_tick]` 的性质,也不替代任何一步 runner 核验。
- 内容合同测试:`packages/teamlead/src/__tests__/fly2144-capacity-rule.test.ts` —— 用 `lead-rules-bundle` 的既有装配函数拼出真实 dept Lead bundle,钉 `/api/capacity`、`不是闸门`、`generatedAt`、`巡检周期` 四个正向锚 + `runner-patrol-rules.md` 的「纯闹钟」句仍在 + cos bundle 不含该小节。
- ⛔ 不改 `runner-patrol-rules.md`(那是 [2108·B] 要大改的文件,避免并行 PR 冲突);`lead-rules-bundle.test.ts` 只钉文件名与顺序,不钉内容 hash(已核)。

---

## 9. R8 退役清单(逐文件)

### 9.1 删除
| 路径 | 说明 |
| --- | --- |
| `packages/dag-resolver/**`(package.json, tsconfig.json, vitest.config.ts, src/{DagResolver,LinearGraphBuilder,index,types}.ts, src/__tests__/{DagResolver,LinearGraphBuilder}.test.ts) | 整包 |
| `packages/edge-worker/src/DagDispatcher.ts` | 唯一非测试消费者 |
| `packages/edge-worker/src/__tests__/DagDispatcher.test.ts`(825 行)、`parallel-dispatch-e2e.test.ts`(193 行) | 只测被删的类 |
| `scripts/run-project.ts`、`scripts/smoke-test.ts` | v0.1 手动入口,Lead 裁定删 |

### 9.2 修改
| 路径 | 改动 |
| --- | --- |
| **新** `packages/edge-worker/src/dag-node.ts` | `export interface DagNode { id: string; blockedBy: string[] }`,文件头注明「FLY-2144: the only surviving type of the retired dependency-ordering package; production reads `id` only, `blockedBy` kept for test fixtures」—— ⚠️ 注释里**不得**出现被禁 token(包名、类名、`DAG resolver` 字样),否则残留守卫会命中(Codex R2 MEDIUM-7) |
| `packages/edge-worker/src/Blueprint.ts:55`、`PreHydrator.ts:1` | `import type { DagNode } from "./dag-node.js"` |
| 22 个 `packages/edge-worker/src/__tests__/Blueprint*.test.ts` / `blueprint-designer-phase.test.ts` | 同上换 specifier(仅 import 行) |
| `packages/edge-worker/src/__tests__/e2e-core-loop.test.ts` | 保留「Single issue pipeline」(用字面 `DagNode`,去掉 resolver 步骤),删「Full DAG dispatch / Shelve / skips completed / Unknown blockers」四个 describe;去掉 `LinearGraphBuilder/LinearIssueData/DagResolver/DagDispatcher` import |
| `packages/edge-worker/package.json` | 删 `"flywheel-dag-resolver": "workspace:*"`;`build` 改 `tsc && rm -f dist/DagDisp* && npm run copy-prompts`(FLY-1674「退役产物在编译成功后清」惯例;⚠️ 必须清:`files: ["dist"]` + `package-onboard.sh:607-622` 整目录拷 dist ⇒ 曾构建过的 checkout 会把旧 `dist/DagDispatcher.js` 打进客户 payload,Codex R2 BLOCKER-1;glob 故意不含完整禁词,让内容守卫零豁免;`dist/` 下无其他 `DagDisp` 前缀文件) |
| `pnpm-lock.yaml` | `pnpm install` 重生成(CI 用 `--frozen-lockfile`,不重生成必红) |
| `scripts/lib/setup.ts:64-65` | 删 `DispatchResult` / `DagDispatcher` 两行 re-export(`run-issue.ts` 不用;FLY-2121 测试只 import `loadSetupProjectConfig`) |
| `scripts/package-onboard.sh:47` | `PO_PACKAGES` 去掉 `dag-resolver` |
| `scripts/package-onboard-files.allow:123-124` | 删两行 |
| `docs/CONTRIB.md` | 第 10 行架构一句、包表一行、依赖图 `-> dag-resolver`、目录树一行;第 56 行「The monorepo contains 9 packages」**删掉总数断言**,表头改为「Core packages (selected)」—— 真实 workspace 是 22 个包(R8 后 21),旧表本来就只列 9 个,⛔ 不顺手扩成 21 包重写(Codex R2 MEDIUM-6) |
| `docs/RUNBOOK.md:11`、根 `CLAUDE.md:26` | 架构描述里的 `DAG Resolver` / `DAG resolver →` 改成真实链路(`Bridge run-dispatcher`);CLAUDE.md 只动这一行 |
| `packages/core/src/{constants,adapter-types,tmux-viewer,flywheel-error-types,AdapterRegistry}.ts`、`packages/edge-worker/src/Blueprint.ts:439`、`scripts/e2e-tmux-runner.ts:7`、`scripts/lib/setup.ts:3,650-653` | 注释里的 `DagDispatcher` / `run-project.ts` 改成当前真实调用方措辞(如 `run-dispatcher` / `Blueprint` / `run-issue.ts`),让残留守卫可以零豁免 |
| `.github/workflows/ci.yml` | 在 FLY-1674 残留守卫步骤旁加 `bash scripts/__tests__/fly2144-retired-dispatch-residue.test.sh` |
| **新** `scripts/__tests__/fly2144-retired-dispatch-residue.test.sh` | **双层**:路径层 `git ls-files` 不得含 `packages/dag-resolver/`、`scripts/run-project.ts`、`scripts/smoke-test.ts`;内容层对 `git ls-files -- packages scripts .github docs CLAUDE.md` 的 tracked 文件做**大小写不敏感**扫描,token 族 `flywheel-dag-resolver`、`DagResolver`、`DagDispatcher`、`LinearGraphBuilder`、`dag[-_ ]+resolver`;排除 `engineering/doc/**`、`product/doc/**`、`doc/**`、`node_modules`、`dist`;**唯一结构性自排除 = 守卫脚本自身**;阳性对照用字符串拼接生成、写入临时目录、路径层与内容层各测一次(Codex R1 BLOCKER-2) |

### 9.3 不动
- `doc/architecture/*.md`、`doc/architecture/archive/*`:历史设计留痕,守卫排除。
- `packages/core` 的 `Semaphore` / `FLYWHEEL_MARKER_DIR` / `openTmuxViewer`:仍有其他消费者(ProjectLock、TmuxAdapter、run-dispatcher)。
- `scripts/run-issue.ts`:不用 DAG,保留。
- CI 矩阵:`ci-matrix-coverage.test.sh` 用 `pnpm list` 对真实 workspace 求并集,包删除后自动一致;`light` 行的 filter 字面量不含 `dag-resolver`,`ci-structure` 钉的字面量不变。

### 9.4 消费者 sweep 证据(CLAUDE.md FLY-1914 规矩,虽非 CLI 契约变更,同法登记)
2026-09-03T02:35Z:`~/.claude/plugins/cache` 0 命中;`~/Dev/claude-plugins-official/external_plugins` **root 不存在,未检查**;主仓 `scripts/`+`packages/` 命中见 §9.1/9.2 全部处置。

---

## 10. 测试计划

| 层 | 文件 | 覆盖 |
| --- | --- | --- |
| unit | `bridge/__tests__/machine-free-pct.test.ts` | 解析(正常 / 缺行 / 101% / 非数字)、超时→token、ENOENT→token、非 darwin→token、**argv 恒空**、源码无危险 flag 字面量 |
| unit | `bridge/__tests__/runner-admission.test.ts` 追加 | `probe()` 数值与 `tryAdmit()` 一致;不改既有用例 |
| unit | `bridge/__tests__/capacity-snapshot.test.ts` | 全部分支注入:正常;memory null;store 缺文件;store 含 email 不外泄;stale 计算;parked/running 分类;手刹/暂停旁注;builder 永不抛 |
| unit | `__tests__/patrol-tick-render.test.ts` 追加 | §7.3 |
| integration | `__tests__/patrol-tick.test.ts` 追加 | payload 含/不含 capacity;builder 抛错不阻塞 tick |
| integration | `__tests__/capacity-route.test.ts` | §8 |
| contract | `__tests__/fly2144-capacity-rule.test.ts` | 规则文本锚 |
| shell | `scripts/__tests__/fly2144-retired-dispatch-residue.test.sh` | 零残留 + 阳性对照 |
| repo | `pnpm -r typecheck`、`pnpm lint`、`pnpm --filter flywheel-edge-worker test:run`、`bash scripts/__tests__/ci-matrix-coverage.test.sh`、`bash scripts/__tests__/package-onboard.test.sh` | R8 全量 |
| E2E(QA 节点) | 真 Bridge:`curl -fsS -H "Authorization: Bearer …" $BRIDGE_URL/api/capacity \| jq '.memory.freePct, .quota.claude.accounts \| length'`;等一个 `patrol_tick` 或用 `patrol-tick.test` 的 harness 回放,肉眼核三行 | 端到端 |

**验尺子**:E2E 里 `jq '.memory.freePct'` 必须是 0..100 整数且与同刻 `/usr/bin/memory_pressure \| tail -1` 相差 ≤ 2 个百分点;`accounts|length` 必须等于 `jq '.accounts|length' ~/.flywheel/claude-accounts.json`。

---

## 11. 风险与回滚边界

| 风险 | 处置 |
| --- | --- |
| 误带参数调用 `memory_pressure` 造成真实内存压力 | 常量空 argv + 绝对路径 + 两条负向测试(§1.2) |
| 快照把 email 带出 Bridge | 字段白名单 + 负向测试(§5.1) |
| `patrol_tick` 渲染被注入指令 | 数值校验 + `canonicalPatrolToken` + fail-closed 行(§7.2);沿用 FLY-1687 的反注入测试模式 |
| Lead 把「输入」读成「闸门」 | 规则文本明写「不是闸门」+ 渲染首行同句;`tryAdmit()` 零改动可由 diff 证明 |
| 删包后 CI 矩阵/打包脚本漏改 | §9.2 列出的 4 处清单 + `ci-matrix-coverage` + `package-onboard.test.sh` 都在 CI |
| 旧 dist 残留 `DagDispatcher.js` 被 `package-onboard.sh` 整目录拷进客户 payload | edge-worker build 后 `rm -f dist/DagDisp*`;验收先在 `dist/` 种一个 sentinel `DagDispatcher.js`,build 后断言本地 dist 与 onboard payload 都不含它(不做 vacuous 干净 CI 检查) |

**回滚**:R4 全部为**加法**(可选字段、新路由、新文件、规则新小节),`git revert` 一个 PR 即回到今天;无 schema 迁移、无持久化格式变更(`lead_events.payload` 里多一个可选键,旧渲染器忽略未知键)。R8 为删除,同一 revert 恢复。**没有 flag、没有开关**(铁律)。

---

## 12. 未查项 / 盲区

- `founder 2026-08-13 裁定` 原文没有在仓库或记忆库里找到(全仓 grep `free percentage` / `memory_pressure` 只命中 FLY-342 语音实验手记);本单以 Lead 转述为准,并把出处写成「Lead 转述,question 8be11d15」。
- `loadQuotaMonitorConfig()` 的签名只看了导出名,plan 阶段按其真实签名接。
- 生产 Bridge 进程 env 里 `FLYWHEEL_RUNNER_*` 沿用 FLY-1969 research 的核验(未设),本单未重核;快照会把 `thresholdPerCore` 原样打出来,所以就算设了也不会读错。
