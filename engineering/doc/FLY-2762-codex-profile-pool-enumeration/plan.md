# FLY-2762 Codex 号池按目录枚举 — 实施计划
Issue: FLY-2762 (https://linear.app/geoforge3d/issue/FLY-2762/codex-号池五号-flywheel-codex-profile-把号池写死为-schoolpersonalbusiness)
日期: 2026-09-22
基于: research.md

**Status**: approved v5（effective design gate `c6e86fc2-719c-4f06-aa1a-367f1f71bccc`，见 §8）
**taskCategory**: code

## 0. 目标与不做的事

**目标**:号池 = `~/.codex/profiles/` 下名字合法的目录；目录名就是 profile 名。`list/use/save/status`、自动切号、
切号审计与通知、额度页对每个号同一套规则。新号 = 建目录 + 登录，零代码改动。

**不做**:
- 不改 Claude 账号族(`flywheel-claude-profile`、quota-monitor、account-heal)。
- 不新增自动切号开关；总闸仍是 `codex_quota_auto_switch`。
- CLI 不自己起 app-server 探号(research §3)。
- 不接线 `reset-credit-selector`(生产未用)；只去掉它的三号假设，保持它可被将来接线。
- 不动任何真实凭据；实施与测试全部用 `mkdtemp` 夹具。

## 1. 稳定身份与单一真相

| 概念 | 唯一来源 | 说明 |
|---|---|---|
| profile 名 | 目录名 | 规则 `CODEX_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/`,且**不得以 `account-` 开头**(该前缀保留给「没有目录的身份」,即 FLY-2750 派生名) |
| 号的身份(email/accountId/plan) | 该目录 `auth.json` 的 id_token | 与今天 `identifyCodexAuth` 解析方式相同 |
| primary 策略 | `codex-account-registry.json` v2:`{"version":2,"primary":"personal"}` | 只剩策略，不列号 |
| 探测结果(token 状态、额度、重置时刻) | Bridge 写的 `~/.flywheel/codex-quota/codex-accounts.json` | CLI 与额度页都只读它 |

**两种名字，两个校验器(R1-6)**:
- **号槽名**(slot name):目录名。`isCodexSlotName(name)` = 正则 && 不以 `account-` 开头。用于：号池成员、切号目标 `to`、`use/save` 参数。
- **身份标签**(identity label):`identifyCodexAuth` 返回的 `profile`,可能是号槽名，也可能是没有目录的 `account-<slug>`。
  `isCodexIdentityLabel(name)` = `/^[a-z0-9][a-z0-9._-]{0,79}$/`(允许保留前缀，上限 80)。
  **生成器与校验器共用同一上限(R2-5)**:`unregisteredProfileName` 在 `account-<slug>` 超过 80 字符时，截断 slug 并追加
  `-<sha256(email) 前 8 位 hex>`,保证输出恒满足 `isCodexIdentityLabel`。兼容性：今天六个号都有目录，没有任何号在用派生名，
  所以现存 accountKey 不受影响；只有将来「没有目录且 email 很长」的号会拿到截断名。用于：root 绑定、切号审计 `from`、通知 `from`、outbox 源号。

`CODEX_PROFILE_NAME` 在 `codex-account-core.mjs` 定义并导出；teamlead 的 `CODEX_ACCOUNT_SLOT_NAME` 改为 re-export 它
(正则字面相同，消灭第二份)。显示标签 = profile 名本身，不做映射表。

## 2. 核心 API(`claude-runner/bin/codex-account-core.mjs`)

```js
export const CODEX_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,31}$/;
export function isCodexSlotName(name)      // 正则 && !name.startsWith("account-")
export function isCodexIdentityLabel(name) // /^[a-z0-9][a-z0-9._-]{0,79}$/,与派生名生成器共用上限

export function loadCodexAccountPolicy(registryPath)
// 只接受 {version:2, primary:<isCodexSlotName>},多余键/缺键/v1 一律抛错。

export function enumerateCodexProfileSlots(profilesRoot)
// -> [{ name, state, identity? , error? }] 按 name 排序
// state ∈ "ready" | "not_logged_in" | "invalid_credential" | "invalid_name"
//   - 只看一层目录；跳过以 "." 开头的项和非目录项(散落的 *.bak 文件不是号)
//   - 目录是 symlink → invalid_name(安全：不跟随)
//   - 名字不合法/保留前缀 → invalid_name
//   - 无 auth.json → not_logged_in
//   - auth.json 不是普通文件/解析失败/无 email → invalid_credential
//   读文件沿用 O_NOFOLLOW + lstat 的现有安全读法。
//   profilesRoot 读不了 → 抛错(不能把「读失败」当成「空池」)。
//   profilesRoot 必须显式传入且为绝对路径；缺失即抛错，没有 ambient 默认值(测试与工具不可能误读真实目录)。

export function loadCodexAccountPool({ profilesRoot, registryPath })
// -> { version: 2, primary: string|null,
//      profiles: [{ name, email, role }],          // 只含 ready 且 email 唯一的号
//      slots: <enumerate 的全部结果>,
//      problems: [{ name, code }] }               // code ∈ duplicate_email | invalid_name | invalid_credential | not_logged_in
// 规则：
//   - 两个及以上 ready 目录 email 相同 → 这几个目录都不进 profiles,各记 duplicate_email(拒绝，不静默挑一个)
//   - role = (name === policy.primary) ? "primary" : "manual_backup"
//   - primary 目录不在 profiles 里 → primary=null(CLI 打一行警告，不抛错；号池照常可用)
//   - 结果交给 validateCodexAccountPool 再断言一次

export function validateCodexAccountPool(value)
// 纯函数，拒绝：重名、重 email、非法名、primary 不唯一、primary 与 role 不一致。
// 这是 issue 验收「重名/重邮箱/primary 不唯一仍拒绝」的阴性用例入口。
```

`identifyCodexAuth(raw, pool)` 保持签名，`pool` 与今天的 registry 同形状(`profiles[].{name,email,role}`),
所以它的「email → 名字」映射自动变成「email → 目录名」。没有目录的 email 仍得 `account-<slug>`(FLY-2750 行为不变)。

**删除**:`PROFILE_NAMES`、`PROFILE_NAME_SET`、`validateRegistry`、`loadCodexAccountRegistry`。
故意删掉旧加载函数而不是保留兼容壳：让每个调用方在编译期必须换成现算号池(即消费者普查由编译器强制)。
`readCodexAuthIdentity(authPath, { registryPath })` 改为 `{ profilesRoot, registryPath }`。
台账函数 `recordCodexAccountObservation` / `readCodexAccountSnapshot` 同样改收 `{ profilesRoot, registryPath }`,
内部用现算号池做 `assertIdentityMatchesRegistry`。

**类型传播(R1-8)**:`CodexProfileName` 联合类型改为 `string`;`CodexAccountRegistry` 更名 `CodexAccountPool`(加 `slots/problems`)。
需同步改的声明/再导出：`codex-account-core.d.mts`、`codex-account-install.d.mts`(`registry` 参数类型)、
`claude-runner/src/codex-account-identity.ts`、`claude-runner/src/index.ts`、teamlead 的 `runtime.ts`、`probe.ts`、
`codex-accounts-observer.ts`、`run-recovery.ts` 及它们的测试。每个 chunk 结束时 `pnpm -r typecheck` 必须绿。

## 3. 分块实施

### Chunk A — 核心号池(claude-runner/bin/codex-account-core.mjs + .d.mts + registry.json)
- 实现 §2。`agents/codex-account-registry.json` 改为 `{"version":2,"primary":"personal"}`。
- 测试(新 `test/codex-account-pool.test.ts`,全 mkdtemp):
  - 六个目录 → 六个 profiles,名字 = 目录名，email 来自各自 id_token。
  - `.codex-quota-account-locks/`、`.active`、`shopping-auth.json.bak` 不出现。
  - 目录无 auth.json → `not_logged_in`;坏 JSON → `invalid_credential`;`account-foo`、`Foo`、symlink 目录 → `invalid_name`。
  - 两个目录同 email → 都不进 profiles,各一条 `duplicate_email`。
  - `validateCodexAccountPool` 阴性：重名、重 email、两个 primary、primary 名与 role 不符 → 抛错。
  - `loadCodexAccountPolicy` 阴性：v1 文件、多余键、primary 非法名 → 抛错。
  - profilesRoot 不存在/不可读 → 抛错。
  - `identifyCodexAuth(shoppingAuth, pool).profile === "shopping"`;池外 email → `account-<slug>`。

### Chunk B — 手动号池 CLI(claude-runner/bin/flywheel-codex-profile.mjs)
- `main()` 起手用 `--profiles` + `--registry` 现算号池，替换 `context.registry`。
- `expectedProfile`:名字必须是 `profiles` 里的号；报错列出现算名单：
  `Unknown Codex profile 'x'; expected one of: business, personal, personal1, personal2, school, shopping`。
  名字在 `problems` 里的，报对应原因(如 `shopping: duplicate_email`),不报「未知」。
- `use <name>`:逻辑不变(读目录凭据 → 校验身份 = name → 原子写 home)。
- `save <name>`:**只能写回已有凭据且账号键相同的号槽**(R2-1)。先读 home 与目标槽两边凭据，要求
  `codexInstallAccountKey(home) === codexInstallAccountKey(slot)`(键含 accountId,同 email 不同 accountId 也会被拒);
  持有这把唯一租约 + home 安装锁后，写入前**重读两边再断言一次**,然后原子写。
  - 目标是 `not_logged_in` 空槽 → 拒绝，提示「新号请直接登录进目录：`CODEX_HOME=<profiles 根>/<name> codex login`」,
    路径由 `context.profiles` 生成并 shell 转义(QA 用临时根时不会指向真实目录)。
  - **R1-1 做减法**:不支持「save 进空槽」。它需要在身份从 `account-*` 变成目录名的瞬间同时持有新旧两把 accountKey 租约，
    复杂且只为一条有更简单替代的路径服务。新号流程固定为「建目录 → 在该目录里登录」,登录本身就把凭据写进槽，无需 save。
- `status`:不变，`Actual profile` 现在对六个号都是目录名。
- `list`:每个目录一行(含问题行),列：名字、角色、email、plan、token 状态、5h 重置、周重置、探测时刻(年龄)。
  - email / plan:来自目录 auth.json 的 id_token(离线、即时)。
  - token 状态与重置时刻：来自 Bridge 快照中**同名且同 `identityKey`**的那行(R1-2)。
    `identityKey` = observer 已在算的 `codexInstallAccountKey(identity)`(SHA-256,非 PII);CLI 对当前槽凭据算同一个键比对。
    快照行缺 `identityKey`(旧快照)或不匹配 → 显示「未探」。快照仍然**不落 email**(保持 FLY-2688 的非 PII 边界)。
  - 快照路径：新增显式参数 `--snapshot <abs path>`,**两个入口都传**(R2-3):
    全局 shim(install-codex-guard 生成)固定 `$HOME/.flywheel/codex-quota/codex-accounts.json`;
    仓库内 private launcher `packages/claude-runner/bin/flywheel-codex-profile` 传 `${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/codex-quota/codex-accounts.json`
    (与它已有的 ledger 推导一致)。未传 `--snapshot` → 三列「未探」并注明「未配置快照路径」;不猜 ambient home。
  - token 状态词表(与额度页同一套，见 §4):`正常 / 打满 / 已吊销 / 已过期 / 凭据失效 / 未登录 / 凭据损坏 / 重复登录 / 在用未探 / 未探`(共 10 个)。
  - 快照不存在或不可读 → 该三列显示「未探」,末尾一行说明原因；**不报错**(离线部分仍有用)。
  - `--json`:stdout 永远是**单个 JSON 对象** `{ primary, accounts:[...], problems:[...], snapshot:{ path, generatedAt|null }, refresh:{ requested, ok, error|null } }`。
  - 删除 `Untracked:` 行(不再有「未跟踪」这个概念)。
- `list --refresh`:先 `POST $FLYWHEEL_BRIDGE_URL/api/codex-accounts/refresh`(Bearer `TEAMLEAD_API_TOKEN`,默认 URL
  `http://127.0.0.1:9876`,超时 100s),再读快照渲染。token 缺失 / 连接失败 / 非 2xx → 照常渲染旧快照；人读模式把
  `REFRESH FAILED: <原因>` 写到 **stderr**,JSON 模式写进 `refresh.error`;两种模式退出码都是 3。URL 只允许 loopback(`127.0.0.1`/`localhost`/`::1`),否则拒绝(不把 token 发到别处)。
- 帮助与 `next` 文案去掉三号字样。
- 快照读取器：CLI 内置一个**宽容**的小解析器，只取 `name / identityKey / authHealth / note / planType / fiveH / weekly / observedAt`(R2-2)。
  ready 行的 `identityKey` 必须是 64 位小写 hex;缺失 / 形状不对 / 与当前槽不符 → 该行「未探」;问题行可以没有 key。不依赖 teamlead 包。
- 测试(改 `test/codex-shim.test.ts` + 新增):
  - 六号 `list` 全出现且无 `Untracked`;`use shopping`、`save personal1` 在夹具里成功，home 的 auth.json 字节与槽一致。
  - `save personal` 时 home 是 business 号 → 拒绝；`save newslot`(空槽)→ 拒绝并给出登录提示；目录不存在 → 拒绝。
  - **正向**:同名同 `identityKey` 的快照行，额度与 token 状态正确显示。
  - 快照缺失 / 坏 JSON / 同名但 `identityKey` 不同 / key 非 64 位 hex / 无 `--snapshot` → 三列「未探」,退出码 0。
  - `save`:同 email 不同 accountId → 拒绝且目标槽字节不变。
  - 经 private launcher(`PROFILE_BIN`)只设临时 `FLYWHEEL_STATE_DIR` → 读到同一快照；`list --refresh` 后仍读同一路径。
  - `--refresh` 用本地假 HTTP 服务：成功、401、503、连接拒绝、非 loopback URL;`--refresh --json` 失败时 stdout 仍可 `JSON.parse`。
  - 阴性对照不做成 CI 测试(依赖分支拓扑)。证据 = exploration §2.2 的实测记录；QA 在部署前用当时的旧 release 目录 + 临时 home 复跑一次。

### Chunk C — 切号安装与恢复(claude-runner/bin/codex-account-install.mjs)
- `:340`、`:489` 的三号字面量 → `pool.profiles.some(p => p.name === profile)`(`registry` 参数即现算号池)。
- 测试：第四个号(`shopping`)的 install / persist 成功；池外名字：install 仍返回现有的 `install_uncertain`(内部 `invalid_profile`
  被既有 catch 吞成它，**不扩 public 结果类型**),persist 返回 `identity_mismatch`。

### Chunk D — runner 出生与台账(claude-runner/src/codex-home.ts、codex-account-identity.ts、index.ts)
- `readCodexSourceAuth`、`discoverAccountPool`、台账观测改用 `loadCodexAccountPool({ profilesRoot: codexProfilesDir(env), registryPath })`。
- `discoverAccountPool` 返回 `profiles` 的名字(无生产调用方，只保持语义正确)。
- `manual_backup_active` 日志语义不变。
- 测试：canonical 装着 shopping 号 → runner 出生成功、`sourceIdentity.profile === "shopping"`、台账写 `shopping.json`。

### Chunk E — Bridge 额度运行时(teamlead)
- `plugin.ts`:删掉「注册表只加载一次并缓存」,改为 `getCodexAccountPool()` 每次调用现算(六个小文件，毫秒级)。
- **单轮号池快照(R1-4)**:`CodexQuotaRuntime.observe()` 改为返回 `{ pool, observations }`(pool 在入口处加载一次)。
  coordinator 把同一个 `pool` 传给 selector、`rotate(incident, candidate, round)`、通知快照；本轮内不再二次加载。
  `credential()` 与 host inventory(`credentialIdentity`)同理：一次调用内加载一次、复用。
- `createCodexQuotaRunRecovery`:`identify` 参数改为 `pool: () => CodexAccountPool`,`canRecover` / `recover` 每次调用开头取一次。
  修掉「Bridge 启动后新建的号能被切入却永远 `canRecover=false`」。
- `candidate-selector.ts`:删 `profiles` 常量；`selectCodexQuotaCandidate(observations, { now, pool, excludedProfiles })`,
  `pool: readonly string[]` 必填，由调用方传入本轮号池名单；校验非空、名字合法、不重复。
  **空池 → `no_usable_credentials`,绝不产生 `pool_exhausted` 事实**(修 `every([])` 恒真 + `Math.min()`=Infinity → `toISOString` RangeError)。
  缺观测的号仍按今天规则算「不是全池打满」。
- **持久化的全池打满证据带上号池(R1-5)**:`recordPoolExhausted` 写入的 `observation_json` 改为版本化对象
  `{ "v": 2, "pool": [...], "observations": [...] }`(仍是同一 TEXT 列，无 SQLite 迁移)。重放时：v2 用存下的 pool;
  旧的纯数组行按 `["business","personal","school"]` 解释(这是唯一允许出现三号字面量的地方，放在带注释的 legacy 常量里，
  并加入 §6 grep 断言的白名单)。
  **成员按身份而不只按名字(R2-4)**:v2 证据的 `pool` 存排序后的 `[{ profile, accountKey }]`。
  store 通过注入的 `currentCodexPoolMembers: () => { profile, accountKey }[]`(plugin 装配时赋值，沿用 `store.codexQuotaAvailability = ...` 的注入方式)
  取当前成员。判定：
  - 当前成员里出现旧证据**没有的** `{profile, accountKey}`(新号，或同名目录换了账号)→ 旧事实**不再算当前**。
  - 只是成员变少(删号/变成问题目录)→ 旧事实仍然有效(不因删号解锁)。**重放方式(R3-1)**:把存下的成员与 observations
    **一起**按当前 `{profile, accountKey}` 取交集，再交给 selector。否则已删号的过去 reset 时刻会让「全池打满」提前失效。
    交集为空(存下的成员全被删了)→ 维持旧事实为当前(fail closed),由 coordinator 立即重探来更新。
  - 提供器缺失 / 抛错 / 返回非法值 → **fail closed**,旧事实照旧生效。legacy 纯数组行：成员 = 其 observations 里的 `{profile, accountKey}`。
  **立即重探**:coordinator 在处理 `pool_exhausted` incident 时，若上面判定为「有新成员」,忽略旧 `next_attempt_at`、本 tick 立即 observe
  (今天 `coordinator.ts:138-142` 会一直等到旧 reset 时刻)。
- `codex-quota-store.ts:283,369,692`、`outbox.ts:242,250`、`switch-notification.ts:4`:三号成员检查 → 形状校验(R1-6):
  - `reconcileExternalRoot.profile`、`recordSwitchAudit.from`、通知 `from`、outbox 源号 → `isCodexIdentityLabel`(允许 `account-*`)。
  - `recordInstalling.profile`、`recordSwitchAudit.to`、通知 `to`、outbox 目标号 → `isCodexSlotName`。
  - 「是不是池里的号」由 rotate 前的本轮 pool 检查负责；持久层只防不安全的名字。
- `reset-credit-selector.ts`:`CODEX_QUOTA_PROFILES` 与 `CodexQuotaProfile` 联合删除；账号集合取输入里的 profile 集合
  (非空、名字合法、不重复);平局规则由「固定三号顺序」改为按 profile 名字典序；「三号快照」等文案与 `profile_order` 说明同步改。
- 新路由 `POST /api/codex-accounts/refresh`(R1-7):挂在现有 `if (config.apiToken)` 分支里(与 `/api/accounts-page.html` 同处);
  服务未配置 token → 路由不挂载，显式 503 且不调用刷新(`tokenAuthMiddleware(undefined)` 会放行，所以不能只靠它)。
  单飞函数返回类型从 `Promise<void>` 改为 `Promise<{ generatedAt, accountCount }>`,在写完快照后直接返回，路由不再另读文件。
  失败 → 503 + 固定文案(不回显内部路径)。
- 测试：
  - `codex-quota-candidates.test.ts`:六号快照里 personal1 可被选中(删掉「退役号」用例，改为「池外名字不被选」);
    「全池打满」需六号全满。
  - `StateStore.codex-quota.test.ts`:`reconcileExternalRoot/recordInstalling/recordSwitchAudit` 接受 `shopping`、
    拒绝 `../x`、`Foo`、空串。
  - switch-notification / outbox:`shopping` 源/目标号正常渲染，不再 unknown/none。
  - `save` 并发：持锁等待期间 home 或目标槽身份被换 → 写前二次断言拒绝，目标字节不变。
  - 热插入全链：runtime 与 recovery 创建之后新建 `shopping` 目录 → 下一轮 observe→select→rotate→commit→`canRecover`/`recover` 全部成功；
    本轮中途新建目录不影响本轮，下一轮生效。`recover()` 内部多次 `canRecover` 复用同一份 pool(抽 `canRecoverWithPool`,测 getter 只调一次)。
  - 全池打满后、旧 reset 之前热插入新号 → 下一 tick 立即 observe 并选中它；同名目录换账号 → 旧事实失效；
    删除成员不解锁；成员提供器抛错不 fail-open。
  - **删号时序(R3-1)**:A、B 都打满，A 在 t+10s reset、B 在 t+50s reset;t+5s 删除 A。t+15s(A 已过 reset、B 未过)guard 仍为 true;
    t+55s(B 也过 reset)guard 才失效并触发重探。另测交集为空时 guard 为 true。
  - 长 email(local part 超长)的池外身份 → 派生名 ≤80 字符，`account-* → shopping` 全链(install journal / audit / 通知 / recovery)通过。
  - `account-* → shopping`:install journal、switch audit、通知快照、recovery 全链不被名字校验拒绝。
  - 空池(全是未登录/坏凭据/重复 email)→ `no_usable_credentials`,不写 capacity fact。
  - 六号里五号打满 → `selected`;旧三号 v1 fact 存在时热插入 `shopping` → guard 不再是当前。
  - 路由：服务配 token 时缺/错 token 401;未配 token 503 且未调用刷新；成功体含 `generatedAt/accountCount`;并发两次 POST 只跑一次；刷新抛错 → 503 固定文案。

### Chunk F — 额度页 token 状态列与「未登录」行(teamlead)
- `codex-accounts-observer.ts`:
  - 每轮刷新开头加载一次 `loadCodexAccountPool`(R1-3)。**只探 `pool.profiles` 里的号**。问题目录出「不探测」行：

    | 号槽问题 | 是否探测 | 快照行 |
    |---|---|---|
    | `not_logged_in` | 否 | `authHealth:"missing"`,`note:"not_logged_in"` |
    | `invalid_credential` | 否 | `authHealth:"missing"`,`note:"invalid_credential"` |
    | `duplicate_email` | **否**(同一 refresh token 起两个 app-server 会互相作废) | `authHealth:"unknown"`,`note:"duplicate_email"` |
    | `invalid_name` | 否 | 不出行 |
  - 快照行新增可选字段 `identityKey`(R1-2);旧 reader 忽略它。`carried()` 只在 `identityKey` 相同才沿用旧读数；
    身份变化或问题目录一律清空旧额度/plan,不把换号前的读数挂到新号上。
  - `quota-reader.ts` 在判 `refresh_invalid` 时同时给出细分 `refreshFailure: "revoked"|"expired"|"invalid"`(research §4;
    码表以现有正则为准，expired 只认 `refresh_token_expired`;同一错误文本含多个码时优先级 revoked > expired > invalid,有测试);
    observer 把它写进 `note`:`token_revoked` / `token_expired` / `refresh_invalid`。**快照格式不升版本**。
- `capacity-snapshot.ts` / `account-quota-view.ts`:
  - 新增一列「token 状态」(Codex 表)。取值与 CLI 同一词表，判据：

    | 列值 | 判据 |
    |---|---|
    | 正常 | `authHealth=valid` 且未打满 |
    | 打满 | `authHealth=valid` 且某窗口 100%(沿用 `exhausted`),并附恢复时刻 |
    | 已吊销 | `note=token_revoked` |
    | 已过期 | `note=token_expired` |
    | 凭据失效 | `note=refresh_invalid` |
    | 未登录 | `note=not_logged_in` |
    | 凭据损坏 | `note=invalid_credential`(需重新登录) |
    | 重复登录 | `note=duplicate_email`(两个目录登了同一个号，需删掉一个) |
    | 在用未探 | `authHealth=in_use_unshared` |
    | 未探 | 其余(`unknown`/`recovery_uncertain`/超时) |

    词表与判据写成一个导出函数 `codexTokenState(reading)`,CLI 的宽容解析器实现同一张表并有一条跨包「同一输入同一输出」测试
    (CLI 测试读 teamlead 的同一个 JSON 夹具)。
  - 行底色：打满/已吊销/已过期/凭据失效/未登录/凭据损坏/重复登录 → 红色行(与今天 `exhausted-account` 同样式)但**文案不同**,解决「看不出区别」。
  - `MANUAL_CODEX` 三条手填兜底行删除：机器快照缺席时，Codex 表只显示一行「无机器读数」提示，而不是假装有三个号。
  - 页面与 `hook-payload` 的文字摘要里若有「三号」字样一并去掉(实施时 grep 复核)。
- 测试：`codexTokenState` 对 10 个状态参数化单测；集成用例「六 ready + 一未登录 = 七行」;坏 JSON / auth.json 是目录 / 重复 email
  各出一行且**未启动 probe**;换号不继承旧读数；快照不含 email;HTML 转义用可自由文本的 `planType` 做恶意输入。

### Chunk G — 安装脚本与文案
- `scripts/install-codex-guard.sh`(R1-8):**无条件**两次校验——算 content hash 前校验源策略文件；切 current 前校验被选中 release 里的策略文件
  (覆盖「同 hash release 已存在而跳过 stage」的路径)。任一失败 `die`,current 不动。
- 全局 shim 增加 `--snapshot "$HOME/.flywheel/codex-quota/codex-accounts.json"`(与 `--ledger-root` 同一推导)。
- `scripts/codex-with-fallback.sh:187`:文案改为「用 codex-profile list 查看可用号，再 use <name>」。
- `scripts/__tests__/codex-guard.test.sh`:加两例「源策略坏 → 不发布」「已存在同 hash 的坏 release → 不切 current」,
  并断言生成的全局 shim 命令行包含 `--snapshot`。

## 3.5 测试迁移清单与执行(R2-6)

`claude-runner` 的 `tsconfig` 排除 `*.test.ts`,typecheck 抓不到测试里的旧用法，所以显式列出并实际跑：

- 迁移为 `mkdtemp` profiles + v2 策略文件、补齐必填 `profilesRoot`:
  `codex-account-identity.test.ts`、`codex-account-ledger.test.ts`、`codex-account-install.test.ts`、`codex-profile-quota-refresh.test.ts`、
  `codex-home.test.ts`、`CodexTmuxAdapter.test.ts`、`codex-shim.test.ts`、`codex-daemon-client.test.ts`、
  `runner-env-isolation.real-tmux.test.ts`、`codex-runner-tui-window.real-tmux.test.ts`(后两个若本机无 tmux 条件则按其既有 skip 规则),
  以及 teamlead 的 `codex-quota/__tests__/*`、`StateStore.codex-quota.test.ts`、`codex-quota-bench.test.ts`、`capacity-snapshot.test.ts`、
  `account-quota-view.test.ts`、`capacity-route.test.ts`、`scripts/__tests__/codex-quota-client.test.mjs`、`scripts/__tests__/codex-guard.test.sh`,
  **以及 CI 实际执行、写 v1 Codex 注册表的 5 个 shell 套件(R3-2)**:`scripts/__tests__/codex-home-link-truth.test.sh`、
  `codex-home-reconcile.test.sh`、`codex-home-launch-fence.test.sh`、`flywheel-lead.test.sh`、`package-onboard-smoke.test.sh`。
  每个都改为 v2 策略文件 + 临时 `profiles/<slot>/auth.json`。
- 执行：每个 chunk 结束 `pnpm -r typecheck` + `pnpm --filter flywheel-claude-runner test` + `pnpm --filter flywheel-teamlead test -- codex-quota capacity account-quota StateStore.codex-quota`,
  核对 Tests 条数非零(pnpm filter 名写错会 exit 0 零测试)。**排除** `**/tmux-viewer.macos.test.ts`(会开真 Terminal)。
- 另外逐个执行(与 CI 同命令):`bash scripts/__tests__/codex-quota-client.test.sh`、`node --test scripts/__tests__/codex-quota-client.test.mjs`、
  `bash scripts/__tests__/codex-guard.test.sh`,以及上面 5 个 shell 套件各自的 `bash scripts/__tests__/<name>.test.sh`。
- **残留断言(R3-2)**,两条都要为 0:
  1. 全仓 `rg -l 'loadCodexAccountRegistry|CodexAccountRegistry' packages scripts`(排除 node_modules/dist)。
  2. 在 §3.5 列出的 Codex 夹具文件上跑 `rg -l -U -P '(?s)"?version"?\s*:\s*1.{0,600}?"?primary"?\s*:'` 与
     `rg -l -P '"?role"?\s*:\s*"manual_backup"'`(两者并集)。
  **先证明它能抓到**:实施开工前在基线 `58693d28c` 上跑这条判据，必须**恰好**命中以下 13 个已知 v1 夹具文件
  (2026-09-22 设计时逐文件实测，R4 独立复现):
  - claude-runner 5 个：`CodexTmuxAdapter.test.ts`、`codex-account-identity.test.ts`、`codex-account-install.test.ts`、
    `codex-home.test.ts`、`codex-profile-quota-refresh.test.ts`;
  - teamlead 3 个：`codex-quota-bench.test.ts`、`codex-accounts-observer.test.ts`、`runtime.test.ts`;
  - shell 5 个：上面列出的 5 个套件。
  `codex-account-ledger.test.ts` 与 `codex-shim.test.ts` **不是**内嵌 v1 夹具：它们经默认路径 / private launcher 读仓库自带的注册表，
  文中的 `manual_backup` 是身份的 `mode` 字段(v2 下仍存在)。它们仍在迁移清单里(补必填 `profilesRoot`、改用临时 profiles),
  由实际跑 Vitest 验证，不由残留判据覆盖。StateStore / ship-judgment 的 `version…primary` 误报因不在清单内而被排除。
  (v4 曾写「claude-runner 7 个」,是把 `mode: "manual_backup"` 也算进去的计数错误，R4 指出后更正。)
  实施后同一判据为 0。

## 4. 回滚边界

| 层 | 回滚方式 | 数据影响 |
|---|---|---|
| 自动切号扩到 N 号 | 设 `codex_quota_auto_switch=false`(已有 kill switch) | 无 |
| 全部代码 | revert PR → 下个部署窗口；codex-guard 旧 release 带回 v1 三号注册表 | 额度库无 CHECK,新写入的 `shopping` 等行对旧代码只是读不到的历史行，不崩 |
| 快照 `codex-accounts.json` | 格式未升版；旧 Bridge 读新快照：新 `note` 值走 `本次未读` 兜底文案 | 无 |
| 台账 `codex-account-ledger/` | 新增 `personal1.json` 等文件；旧代码 `readCodexAccountSnapshot` 只读三号，不碰它们 | 无 |

## 5. 部署前置与部署后核验(写进 PR body,由 QA/部署方执行)

- 前置：`~/.codex/profiles/.codex-quota-account-locks/` 下没有 `*.pending.json`(research §2)。
- 前置：当前没有任何号在用超长派生名(即 canonical `~/.codex/auth.json` 的邮箱属于某个号槽，或其 `account-<slug>` ≤ 80 字符)。只读 id_token 的 email 声明。
- 部署后(只读):`codex-profile list` 六号全出现、无 Untracked;`codex-profile status` 身份正确。
- 不在部署核验里做 `use`(会切共享 profile);`use/save` 的正向证据来自夹具测试 + QA 用临时 `--home`。

## 6. 验收映射

| issue 验收 | 证据 |
|---|---|
| 五(六)号 `list` 全出现且非 Untracked | Chunk B 测试 + 部署后只读核验 |
| `use shopping` / `save personal1` 成功 | Chunk B 夹具测试(QA 用临时 `--home` 对真 profiles 只读源复核) |
| 账号页五(六)号 + token 三态 | Chunk F 测试 + QA 截图 |
| 阴性对照：改动前 `use shopping` 报 expected school, personal, or business | 已在 exploration §2.2 实测；QA 部署前用旧 release 复跑 |
| 非测试代码 `["school","personal","business"]` 字面量为 0 | CI 加一条 grep 断言测试(扫 `packages/*/src`、`packages/claude-runner/bin`、`scripts`,白名单：Claude 族文件 + §3 E 的 legacy 常量一处) |
| 重名/重邮箱/primary 不唯一仍拒绝 | Chunk A `validateCodexAccountPool` 阴性用例 |

## 7. 风险

1. **自动切号会用上新号**:部署后 incident 可能切到 personal1/personal2/shopping(prolite 档，额度更小)。这是本单目的；
   founder 可见的切号卡片会显示真实号名。回滚杠杆见 §4。
2. **重 email 目录**:今天没有，但若有人把同一号登进两个目录，两个都会被排除出号池(fail closed)。`list` 明确显示原因。
3. **快照陈旧**:CLI 显示的是 Bridge 最近一次真探。每行带探测年龄；要新数就 `--refresh`。

## 8. 设计评审记录

### Codex R1(CHANGES REQUESTED,8 条阻塞 + 5 条 advisory)

| # | 问题 | 处置 |
|---|---|---|
| 1 | save 进空槽需要新旧两把 accountKey 租约 | **做减法**:取消该路径，新号直接登录进目录 |
| 2 | 快照不落 email,CLI「同 email」合同不可实现；observer 按名字继承旧读数 | 加非 PII `identityKey`;只在键相同时 carry |
| 3 | 问题目录的探测策略不全；重复 email 会被探两次 | 只探 pool.profiles;问题目录出不探测行 |
| 4 | 单轮 pool 没贯穿 coordinator / recovery | observe 返回 `{pool, observations}`;recovery 改收 pool getter |
| 5 | 持久化打满证据无 pool;空池被判全满 | 证据版本化带 pool;空池 = no_usable_credentials;guard 比较当前 pool |
| 6 | `account-*` 在审计/通知被拒 | 区分号槽名与身份标签两个校验器 |
| 7 | refresh 路由鉴权/返回/路径/JSON 合同不闭合 | 挂 apiToken 分支；单飞返回元数据；显式 `--snapshot`;失败写 stderr / JSON 字段 |
| 8 | 类型传播、ambient 默认、install 状态、installer 旁路 | 列全类型清单；profilesRoot 必填；保持 install_uncertain;installer 无条件校验 |
| advisory | 状态计数、XSS 用例、reset-credit 文案、错误码、阴性对照 | 全部采纳(见各 chunk) |

### Codex R2(CHANGES REQUESTED,6 条；R1 第 3、4 条确认闭合)

| # | 问题 | 处置 |
|---|---|---|
| 1 | save 只比 email,不比含 accountId 的账号键 | 改为账号键全等 + 写前重读断言 |
| 2 | CLI 解析字段仍写 email | 改为 identityKey(64 位 hex),补正向测试 |
| 3 | private launcher 没传 `--snapshot` | 两个入口都传，按各自 state root 推导 |
| 4 | 打满证据只比名字；池变化后不会立即重探 | 成员按 `{profile, accountKey}`;新成员 → 旧事实失效 + 立即 observe;删号不解锁；提供器异常 fail closed |
| 5 | 派生名长度与校验器上限不一致 | 共用 80 字符上限，生成器超长截断 + hash 后缀 |
| 6 | 测试与 v1 夹具迁移不在验证闭环 | 新增 §3.5 清单 + 实际跑 Vitest + 残留 rg 断言 |
| advisory | recover 内复用 pool、提示路径、hex 校验 | 全部采纳 |

### Codex R3(CHANGES REQUESTED,2 条；R2 第 1、2、3、5 条确认闭合)

| # | 问题 | 处置 |
|---|---|---|
| 1 | 删号后重放未限定为幸存成员子集，越过已删号 reset 会提前解锁 | 成员与 observations 一起按当前成员取交集后重放；交集为空 fail closed;加跨 reset 的时序测试 |
| 2 | 漏 5 个 CI shell 套件；残留正则会假绿 | 补进清单并逐个执行；残留判据改为两条并集，限定 Codex 夹具清单，先在基线证明命中 |
| advisory | save 锁等待中身份变化测试、guard shim 含 `--snapshot` 断言、派生名前提写进 PR body | 全部采纳 |

### Codex R4(Lead 授权的有界验证轮，fresh thread,effort high)

| R3 项 | R4 结论 | 处置 |
|---|---|---|
| 1 删号子集重放 | 已关闭 | — |
| 2 测试夹具闭环 | 部分关闭：5 个 shell 套件与两条残留判据已到位；但基线计数「claude-runner 7 个」无法复现(实为 5) | 按 R4 给的最小修正，改为明确的 13 个文件清单并说明 ledger/shim 为何不在其中；本人逐文件复跑确认 5/3/5 |

R4 未提出新的阻塞项，对 v4 的有界 diff 也未发现回归。

### Effective design gate（APPROVED）

2026-09-22，`plan.md` v5 通过正式 design gate
`c6e86fc2-719c-4f06-aa1a-367f1f71bccc`：`reviewVerdict=APPROVED`、
`reviewerVerdict=APPROVED`。非阻塞 advisories 已通过 runner report
`09addcb4-534e-49e9-9783-8f7178609e0a` 回报 Lead。
