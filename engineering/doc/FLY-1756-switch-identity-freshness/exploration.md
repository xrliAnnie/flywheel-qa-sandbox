# FLY-1756 Lead 代 founder 切号自愈 — 探索

Issue: FLY-1756 (https://linear.app/geoforge3d/issue/FLY-1756/bug-lead-无法代-founder-切号她只能手工切-切号只认-active-标记不认活凭据身份-池快照会过期双因)
日期: 2026-08-21
基于: 无

## 1. 问题定义(founder 直令转译)

Founder 2026-08-13 直令纠正了立单方向:**号池标记(`.active`)与实际账号不一致是症状,不立单去治;真正要修的是「Lead 代 founder 切号已经不可用」**——她每次让 Lead switch 都被报「已经过期」,只好手工切,手工切又制造标记漂移,循环往复。目标状态:**Lead 永远能代切,founder 不再需要手工切**;手工切消失后,标记漂移症状自然消失。

2026-08-13 12:45 PT 实测锁定双因:

- **因一:切号只认 `.active` 标记,不认活凭据的真实身份。** `.active` 写着 `personal1`,活 Keychain 实际是 `personal`(她当天亲手登录)。让 Lead「切到 personal」时机器其实已在 personal 上,工具却按标记执行一次真换号——拿池里的 personal 旧副本去覆盖 Keychain。缺「target == 当前活身份 ⇒ no-op 成功」这一步。
- **因二:池快照会过期,她的手工登录只更新 Keychain、不回灌池。** 池内 `personal/.credentials.json` 停在 08-12 22:50;freshness 助手实测 `'personal' is STALE — refresh refused (HTTP 400)`——池里那份 refresh token 已被她的新登录轮换失效。`use personal` 因此 fail-closed 拒绝(**拒绝本身是对的**,是 FLY-871 的保护),但结果就是「你 switch 不了」。久坐的号(business 07-23、shopping 07-30)同理必然腐烂。

## 2. 现状审计(2026-08-21,本分支 = 最新 main)

> **时态声明**:以下是 [本分支] 现状。8-13 实测发生在 FLY-1201(2026-07-20 merge, `9fa91cf6f`)之后、FLY-1806(08-16)之前——即实测时手动路径的 stale-active reconcile **已在生产**,却仍然失败。8-13 现场的确切失败路径无法从 issue 复原(见 §2.3),设计按「覆盖全部候选路径」收敛。

### 2.1 三个切号入口

| 入口 | 路径 | 现状 |
|---|---|---|
| ① 手动 `flywheel-claude-profile use <name>`(Lead 在 pane 里代 founder 跑的就是这条) | bash 单点持有全部 Keychain/pool mutation | FLY-1201 已加 stale-active reconcile(见 §2.2),之后走 freshness → identity assert → Keychain 写 |
| ② 引擎自动切(quota-monitor daemon → `switch-executor.ts`) | TS 侧,`resolveMachineAccount` 三证人(`.active` 标记 / `~/.claude.json` display 身份 / ledger)一致才 `resolved` | 证人不一致 → `machine_account_conflict` severe alert + **fail-closed 零修复**(FLY-1201 §2.3 裁决:引擎侧自动修复=「另一单 scope」——本单就是那一单) |
| ③ Bridge `/api/account-switch` | — | 已 410 退役(FLY-1456 G4:daemon 是唯一切号权威) |

### 2.2 FLY-1201 已交付的自愈(手动路径)与它的判定链

`use` 拿锁后跑 `reconcile_stale_active_locked`:

1. **快路径(零网络)**:`~/.claude.json` 的 `oauthAccount`(display 身份)== `.active` 槽的 identity anchor → 判「无漂移」,直接放行。
2. **慢路径**:不一致时 `kc_read` 活凭据 → OAuth `identity_probe`(网络)→ 活身份归到唯一 anchor 槽 → `capture_live_credential_strict`(活凭据写进真槽)+ 修 `.active` + sync store → 以修正后的 active 继续切换。
3. delegated(引擎委托)模式检出真漂移 → exit 46 零修复(裁决保留)。

### 2.3 缺口矩阵(为什么 8-13 还是挂)

| # | 缺口 | 机制 | 对应因 |
|---|---|---|---|
| G1 | **display 快路径假阴性** | 快路径信 `~/.claude.json`——它也是一个「标记」,与 Keychain 可脱钩。display 停在旧号时判「无漂移」→ 不进慢路径 → `use personal` 按 `active=personal1` 走 freshness → 池 personal 副本 400 → **exit 30 拒**。这是与 8-13 实测报错(STALE)吻合度最高的候选路径 | 因一 |
| G2 | **无真 no-op** | 即使 reconcile 修好了 marker(`RECONCILED_ACTIVE == target`),`use` 仍然完整重写 Keychain 一遍(跳 freshness,但 `kc_write` 照做)。issue 验收 ② 明确要求「target == 活身份 ⇒ 成功且 Keychain 文件 mtime 不变」 | 因一 |
| G3 | **freshness STALE 是终局,不问「机器是否已在目标号上」** | exit 30 直接拒。8-13 场景里目标池副本死了,但机器**已经在目标号上**——正确答案是 no-op 成功 + 顺手把活凭据 capture 回池,而不是拒绝 | 因一+二 |
| G4 | **引擎面零自愈** | founder 手工切一次 → 三证人 conflict → 引擎所有自动切号卡死,直到有人手动跑 `use`。「漂移即自动 capture」不存在于引擎面 | 因二 a |
| G5 | **池无周期保鲜,腐烂在最坏时机发现** | freshness probe-refresh 只在切号时对 target 单点跑;`sweepCandidates` 是配额观测不是保鲜。手工登录毒死旧家族副本(池不知情)+ 久坐号家族过期,都在「founder 要切号的那一刻」才炸 | 因二 b |

8-13 现场候选路径(无法确证,全部要被设计覆盖):(a) G1 假阴性 → freshness STALE(报错吻合);(b) display 四字段校验失败跳过快路径、慢路径 probe 网络失败 → exit 46;(c) Lead 走了引擎面 → `machine_account_conflict`,Lead 拿 freshness 助手诊断出 STALE 转述给 founder。

### 2.4 生产池现状(2026-08-21 只读观察)

5 槽(business/personal/personal1/school/shopping)**identity anchor 全部在位**——anchor 覆盖不是缺口,identity-first 的前置条件已满足。`.active`=shopping。池副本 mtime:business 08-21、personal 08-15、personal1 08-20、school 08-17、shopping 08-21——分布比 8-13 新(切号活动带来的惰性 capture 在起作用),但 personal(6 天)/school(4 天)若期间被手工登录过,照样可能已死,**当前没有任何机制会在切号前发现**。

## 3. 方案空间

### Fix A — `use` 入口 identity-first + 真 no-op(治因一,入口①)

**A-opt1(倾向):probe-first。** `use <name>` 拿锁后**先** `kc_read` + `identity_probe` 活凭据(一次网络调用):

- 活身份 == `name` 槽 anchor → **no-op 出口**:`capture_live_credential_strict`(活凭据回灌 name 槽,= 顺手保鲜)+ 修 `.active`/store(若漂)→ 成功返回,**零 Keychain 写**。同时消灭 G1/G2/G3。
- 活身份 ≠ name anchor → 照旧走现有 reconcile + 切换全链(freshness/identity assert/capture_back 全不跳)。
- probe 网络失败 → **退回现状路径**(display 快慢路径),不降级现有可用性;此时若走到 freshness STALE,按 A-opt2 救援。

**A-opt2:STALE-rescue only。** 只在 freshness exit 30 时才 probe 活凭据,活身份 == target anchor → 转 no-op 成功。改动面最小、正常路径零变化;但 G2 残留——display 假阴性 + 池副本侥幸还能刷新时,仍会拿池副本覆盖她刚登录的活凭据(issue 点名的「荒谬后果」)。

**对比结论**:A-opt1 为主(语义最干净:先问真身份,标记只是缓存),A-opt2 作为 probe 网络失败路径上的兜底并入。成本=每次 `use` 多一次 profile API 调用(现有 10s timeout 合同),切号是低频重操作,可接受。

### Fix B — 引擎面「漂移即自动 capture」(治因二 a,入口②)

**B-opt2(倾向):bash 新增显式子命令 `reconcile`。** 语义=「只对账修复,不切号」:自己 `acquire_lock`(非 delegated),复用 FLY-1201 全部 primitive(`identity_probe` → `find_anchor_slot_by_identity` → `capture_live_credential_strict` → `active_sync_store` → `write_active_from_reconcile`),fail-closed 语义原样(probe 不到/归不了唯一槽 → 非零退出零 mutation)。引擎在两个位点调用:

1. **conflict 位点**:`resolveMachineAccount` 返回 conflict/untracked 时,先 spawn `reconcile`,成功后重读三证人;仍不 resolved 才走现有 severe alert。
2. **周期漂移检测(零网络触发器)**:daemon 现有 tick 里比较 Keychain 凭据 digest vs 池 active 槽副本 digest(全本地);不等 = 有人动过 Keychain(founder 手工登录)→ spawn `reconcile`。这让「她手工登录后池自动跟上」不依赖下一次切号。

**B-opt1(否决):daemon 在 TS 侧直接做修复 mutation。** 违背「全部 secret mutation 单点在 bash」的现状架构,需重做 authority/CAS——正是 FLY-1201 警示的大 scope,且把 refresh token 引入第二个写入面。

**红线保持**:bash **delegated 切换**路径(`DELEGATED_LOCK_ACCEPTED=1`)仍然禁修——修复只发生在专用 `reconcile` 入口(它以自己的锁、手动语义运行),FLY-1201 的裁决字面不动。

### Fix C — 池周期保鲜 sweep(治因二 b)

挂在 quota-monitor 现有 tick(**零新 timer**,遵循 FLY-1560 方向):对每个**非 active**且非 `authExpired` 的池条目,距上次刷新 > 阈值(默认 24h)时跑 `verifyPoolCredential`(probe-refresh + 轮换写回,FLY-871 现成机制):

- `refreshed` → 池副本家族保活,写回轮换后凭据 + 记录 `lastRefreshAt`。
- `stale` → 标 `authExpired` + Lead alert **点名**「账号 X 需要 founder re-login」——把「发现死号」从切号时刻(最坏)提前到日常(最好),founder 可以挑方便的时间补登录。
- **active 槽绝不 probe-refresh**(FLY-871 红线,`ActiveAccountRefreshRefused` 结构性保证);active 槽的保鲜由 Fix B 的 capture 承担。

**关于「sweep 能不能防住手工登录毒死副本」的诚实边界**:如果 Anthropic OAuth 是「新登录使旧家族失效」(issue 采纳的归因,personal 08-12 capture → 08-13 即 400 支持它),那么 sweep 防不住这一类——防它的是 Fix B(登录后尽快 capture)。sweep 的价值是:(1) 防「久坐不动」型家族过期;(2) 早发现 + 点名已死副本。两类腐烂,两个机制,各管一半。

## 4. 明确不做

- **不动 freshness fail-closed 红线**:真死且刷不活的号仍然拒绝切入(负对照保留)。
- **绝不出现「池旧副本覆盖更新活凭据」的新路径**;no-op/capture 方向永远是 pool ← Keychain,不反向。
- **不改 delegated 切换禁修的 FLY-1201 裁决**(修复走专用 `reconcile` 入口,不藏在切换里)。
- **不救已死家族**(只能 founder re-login;我们做的是早发现+点名+不误伤)。
- 不动 `machine-account.ts` 三证人**判定语义**(仍然三证一致才 resolved;变化只是 conflict 后多一次「修复再重判」的机会)。
- 单机池;多机不在本单。

## 5. 开放问题(带进 research)

1. **OAuth 家族语义确证**:池副本 probe-refresh 会不会反过来影响 founder 手里的活凭据?(FLY-871 上线以来切号时的 target probe-refresh 已运行月余,需从文档/事故记录确证无「活会话被池刷新登出」案例。)
2. `identity_probe` 端点(`api.anthropic.com/api/oauth/profile`)的调用配额/延迟——Fix A 每次 `use` +1 次、Fix B 触发时 +1 次。
3. `reconcile` 子命令与 quota-monitor 的锁交互(`accounts-lock` / `mkdir-lock` 复用方式;daemon spawn 它时的超时与失败处理)。
4. `lastRefreshAt` 记在哪(池 sidecar vs `claude-accounts.json` store)。
5. `~/.claude.json` display 在 `claude /login` 后的更新行为(解释 8-13 的 G1 假阴性是否成立;不影响设计,影响 research 的现场归因置信度)。
