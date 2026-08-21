# FLY-1756 Lead 代 founder 切号自愈 — 调研

Issue: FLY-1756 (https://linear.app/geoforge3d/issue/FLY-1756/bug-lead-无法代-founder-切号她只能手工切-切号只认-active-标记不认活凭据身份-池快照会过期双因)
日期: 2026-08-21
基于: exploration.md

> 行号均为本分支(= 2026-08-21 main `07a8c0640`)快照;复核请用 `git log -S <符号>` 重定位。

## 1. 代码地图

| 部件 | 位置 | 角色 |
|---|---|---|
| bash 切号执行器(唯一 Keychain/pool mutation 面) | `packages/claude-runner/bin/flywheel-claude-profile`(2251 行) | `use`/`next`/`capture`/`status`;锁、reconcile、freshness、identity assert、verify-before-commit 全在此 |
| identity anchor 读写 | 同上 `read_identity_anchor()`(:661)、`write_identity_anchor()`(:785)、`identity_assert_value()`(:694) | 槽位不可变身份 `identity-anchor.json`(uuid+email,0600,五字段 schema) |
| 活凭据身份 probe | 同上 `identity_probe()`(:623);TS 侧 `account-identity.ts` `fetchProfileIdentity()` | GET `api.anthropic.com/api/oauth/profile`,Bearer accessToken,10s timeout,返回 email+uuid |
| stale-active reconcile(FLY-1201) | 同上 `reconcile_stale_active_locked()`(:1724)、`reconcile_absent_marker_locked()`(:1683) | 见 §2 |
| freshness 保鲜探针(FLY-871) | `packages/teamlead/src/account-heal/freshness.ts`(`verifyPoolCredential`)+ bash `freshness_check()`(:899) | OAuth `refresh_token` grant probe-refresh;成功先写回轮换凭据再放行;active 槽结构性拒刷(`ActiveAccountRefreshRefused`,freshness.ts:179) |
| 引擎切号编排 | `packages/teamlead/src/account-heal/switch-executor.ts` `switchAccount()` | CAS + 候选循环;`machine_account_conflict` fail-closed(:443-450) |
| 三证人权威 | `packages/teamlead/src/account-heal/machine-account.ts` `resolveMachineAccount()`(:78-133) | `.active` 标记 / `~/.claude.json` `oauthAccount` email / store ledger 三者一致才 `resolved` |
| daemon↔bash 装配 | `packages/teamlead/src/account-heal/claude-profile-cli.ts` | `applyProfile` = spawn `flywheel-claude-profile use <name>`,env `FLYWHEEL_CLAUDE_LOCK_DELEGATED=<pid>`(:209);与 bash 共享同一把 `~/.flywheel/claude-accounts.lock`(mkdir lock) |
| quota-monitor daemon | `packages/teamlead/src/account-heal/quota-monitor.ts`(50KB)+ `-config/-state/-credentials/-runtime` | 周期 tick:`basePollMinutes: 20` / `acceleratedPollMinutes: 10` / `candidateSweepMinutes: 60`(quota-monitor-config.ts:22-26);`machine_account_conflict` → severe+mention alert(quota-monitor-alert.ts:50),零修复 |
| Keychain 读取 + digest(TS 只读) | `quota-monitor-credentials.ts` `readKeychainMonitorCredential`(仅 accessToken/expiresAt)+ `PoolMonitorCredentialSnapshot.rawDigest`(仅池侧) | ⚠️ R1 更正:**Keychain 原始字节 digest 基建不存在,需新增**(初稿误写「现成」) |
| 台账 | `account-store.ts` `AccountEntry`(:37-65)/`AccountStore`(:67-75) | `authExpired`/`refreshTokenInvalid`/`identityMismatch`/`modelCaps` 等;⚠️ R2 后:`lastPoolRefreshAt` 随 sweep 撤下不再新增;plan 新增的是 monitor state 侧 `lastReconcile`/`lastIdentityAuditAt`/`poolAgeAlerts` |
| 测试基建 | `packages/claude-runner/test/claude-profile.test.ts`(bash harness);`scripts/qa-fly-1182-isolated-switch-drill.sh`、`scripts/qa-fly-1256-quota-daemon-e2e.sh` | scratch-Keychain adapter + 真 bash 脚本的隔离沙箱模式,直接可复用 |

## 2. 双因的机制化(逐缺口代码证据)

### G1 — display 快路径假阴性(因一残余)

`reconcile_stale_active_locked`(:1738-1741):`read_display_identity`(`~/.claude.json` 的 `oauthAccount`,四字段全非空才有效,:769-783)与 active 槽 anchor 一致 → 直接 `return 0` 判「无漂移」。display 本身是**另一个标记**(Claude Code 登录时写的 sidecar),与 Keychain 真凭据可脱钩。假阴性后果:`use <target>` 以旧 active 走 `prepare_profile_locked`(:1895),`name != active` → `freshness_check`(:1904-1907)→ 池 target 副本已死 → exit 30 拒。与 8-13 实测报错(STALE / HTTP 400)吻合度最高。

### G2 — 无真 no-op

`use_profile`(:2046-2061)在 reconcile 之后无「`name == RECONCILED_ACTIVE` ⇒ 提前成功返回」分支;`switch_profile_locked` 照样执行 `commit_profile_locked`(:1933)→ `kc_write`(:1993)重写 Keychain(同字节也写,mtime 变)。issue 验收 ② 要求 mtime 不变 ⇒ 需要显式 no-op 出口。附带风险:G1 假阴性 + 池 target 副本侥幸仍可刷新时,真的会拿池旧家族副本覆盖她刚登录的活凭据(issue 点名的「荒谬后果」;freshness 只验「池副本活不活」,不验「是否比活凭据旧」)。

### G3 — freshness STALE 是终局

`prepare_profile_locked` 收到 30 直接 `return 30`(:1906),`use_profile` `exit 30`(:2060)。没有任何路径问「活凭据是不是已经就是 target 的身份」。

### G4 — 引擎面零自愈

`switchAccount`(:443-450):`resolveMachineAccount` 非 `resolved` → `machine_account_conflict` fail-closed。monitor 报 severe alert(quota-monitor.ts:1314;alert 表 quota-monitor-alert.ts:50)后**等人**。FLY-1201 plan §2.3 原文裁决:「不做引擎 conflict 自动放行…引擎侧要自动修复需扩展 Bash→Node 结构化结果 + 重做 authority/CAS,**另一单 scope**」——本单即该单;但注意其闭环假设是「alert 后的人工 `use` 因本单(FLY-1201)变为安全 + 自愈」,而 8-13 实测(FLY-1201 已上线 24 天)证明人工 `use` 这一环仍会挂(G1/G3),闭环断裂。

### G5 — 池无周期保鲜

freshness probe-refresh 仅在切号时对 target 单点执行(bash `freshness_check` 由 `prepare_profile_locked` 调;引擎侧 `readCandidateCredential(deps, name, verify)` 仅在切号候选验证时 verify=true)。`sweepCandidates`(quota-monitor.ts:314-342)是**配额观测** sweep(fetchUsage 记 panorama),读凭据时 `verify=false`(:328),不保鲜。全代码库无周期 refresh。

## 3. OAuth 家族模型(本调研核心新知:两类腐烂,两个机制)

从 freshness.ts 头注释(FLY-871,2026-07-04 事故)+ 8-13 实测 400 + 生产池一个月运行事实,可自洽推演:

1. **池副本 = 活凭据的同家族字节快照**(capture = 复制 Keychain 字节)。OAuth refresh token 是**链式单次使用**:每次刷新颁发新 refresh token(轮换),旧环随即失效。
2. **active 槽副本必然腐烂**:活侧 Claude CLI 持续自行刷新轮换家族,池 active 快照很快变「已用旧环」→ refresh 必 400。这正是 FLY-871 红线「NEVER probe-refresh the ACTIVE」的深层原因(不止是「会把活会话轮换掉」,而是**从两个持有者轮换同一家族本质上互毁**)。active 槽的唯一保鲜方式 = **capture(拷最新字节)**。
3. **非 active 槽副本可保活**(⚠️ R1 曾降级,后被 Founder 终裁覆盖,见 §9):切走之后,该家族再无活会话轮换它,池成为家族最新环的**唯一持有者** → 定期 probe-refresh 理论上可保活。FLY-871 的切号时 probe-refresh 一个月运行无「活会话被池刷新登出」事故。R1–R7 评审曾因 `claude /login` 无法被 account lock 序列化而撤项;最终设计改为每轮用活 Keychain `oauth/profile` 直证 active,只刷确认非 active 槽,证据不可得则整轮零 refresh。
4. **founder 手工登录 = 换新家族**:她 `claude /login` 后 Keychain 持有全新家族;池里该号旧快照(旧家族最新环,或已被 CLI 轮换成旧环)从此救不活或迟早救不活。8-13 `personal` 08-12 22:50 capture → 08-13 12:45 refresh 400 与此吻合(她登录时旧家族被 revoke,或登录前 CLI 已轮换)。
5. **推论**(⚠️ R1/R2 后修订版;初稿的 sweep 安全性推论见 §8-C,已作废):
   - 「手工登录毒死副本」与「活跃期家族被 CLI 轮换」两类,**只有 capture 能救**(plan:`use`/`next`/`reconcile` 的 strict capture + 引擎每 tick digest 触发的 freshened capture)。
   - 「久坐腐烂」类:后台 refresh 保活因集体 stale 证人风险从本单撤下(plan §5.3);本单只做零网络老化点名(C′),死活留给切号时刻的按需 freshness 判定。

## 4. 历史裁决约束(设计必须遵守)

| 裁决 | 出处 | 对本单的约束 |
|---|---|---|
| active 槽绝不 probe-refresh | FLY-871(freshness.ts:83-91, :176-181) | active 保鲜只走 capture;⚠️ R1 后:后台对任何槽的 refresh 都已撤下(「非 active」在集体 stale 证人下不可证明) |
| 真死号 fail-closed 拒切 | FLY-871 | 负对照保留;Fix A 救援仅在「活身份==target anchor」证明成立时转 no-op,绝不放行真换号到死副本 |
| refresh/access token 不进 argv | FLY-871(freshness.ts:20-21)| `reconcile` 子命令沿用文件读 + stdin 契约 |
| delegated(引擎委托的 bash 切换)不做 marker/store 修复 | FLY-1201 Codex R1#4(plan §2.3;bash :1701-1703, :1760-1762) | Fix B 不解禁 delegated;修复走**新的专用入口**(独立进程自拿锁)。⚠️ R3 精化:`switch-executor.ts` 并非零改动——delegated freshening 事实经 ApplyProfileReport 通道返回、parent 锁内 patch(plan §2.3),但 marker/store 修复禁令字面保持 |
| capture 只准写「probe 验明身份 == 槽 anchor」的字节 | FLY-1182 assertion(bash `capture_live_credential_strict` 的调用前提;commit 阶段 `identity_assert_value` :1961-1976) | no-op/reconcile 的 capture 全部先 probe 后写 |
| daemon 是唯一自动切号权威;Bridge API 已 410 | FLY-1456 G4 | Fix B 挂 daemon,不复活 Bridge 路径 |
| 零新 timer 偏好 | FLY-1560/1570 方向 | Fix B/C′ 挂 quota-monitor 现有 tick(20/10min),不建新周期进程 |

## 5. 锁与进程拓扑(Fix B 的死锁规避)

- daemon 与 bash 共享同一把 mkdir lock(`~/.flywheel/claude-accounts.lock`,claude-profile-cli.ts 注释 + `withAccountsLock`)。
- `switchAccount` 的 conflict 判定发生在 `withLock` **内**(switch-executor.ts:443)——若在此处 spawn 一个自己拿同一把锁的 `reconcile` 子进程 = **死锁**。
- ⇒ Fix B 的两个调用位点都必须在**锁外**:
  1. monitor tick 的 conflict alert 位点(quota-monitor.ts:1314 一带,tick 流程在锁外);
  2. 周期漂移检测(tick 内,锁外:比较 `kc_read` digest vs 池 active 槽 `.credentials.json` digest,零网络)。
  spawn `flywheel-claude-profile reconcile`(不设 `FLYWHEEL_CLAUDE_LOCK_DELEGATED`,以手动语义自己 `acquire_lock`)→ 完成后 daemon 照常进 `switchAccount`,锁内 `resolveMachineAccount` 重判。⚠️ R1 更正:初稿写「TOCTOU 无害」不成立——**手工 `claude /login` 根本不参与 accounts lock**,任何检查之后都可被竞态;锁只序列化工具间互斥,不序列化 founder。安全性由「tagged-preimage 协议(写前终读 + compare-before-restore)+ 全路径 fail-closed」承担(plan §1.3),锁外 spawn 只解决死锁,不解决 TOCTOU。另:daemon 侧读 authority/digest 快照也必须在**短锁内**取(裸读多文件可见撕裂快照;现有 runtime 合同即如此,quota-monitor-runtime.ts:367-429),放锁后再 spawn。

## 6. 探索开放问题的裁决

| # | 问题 | 结论 |
|---|---|---|
| 1 | 池 refresh 会否影响活凭据 | ⚠️ R1 更正:「不会」**仅在能证明目标确非活家族时成立**;而「active 槽不刷」红线依赖的三证人可集体 stale(本 issue 场景本身!),故后台周期 refresh 无法满足该前提 → 从本单撤下(plan §5.3);按需路径(切号时对已证明≠活身份的 target)维持现状安全等级 |
| 2 | probe 端点成本 | `api/oauth/profile` GET,10s timeout 合同现成(account-identity.ts:3-4);⚠️ R1/R2 修订:Fix A 每次 `use`/`next` +1 次、Fix B 仅 digest/conflict 触发时 +1 次、identity audit 6h 一次;C′ 零网络。probe 失败 ⇒ manual 路径 **fail-closed 88**(不退回标记链,R1#2),daemon 侧跳过本轮 |
| 3 | reconcile 锁交互 | §5:独立进程自拿锁,daemon 只在锁外 spawn;复用 `acquire_lock`/lease fence 全套 |
| 4 | `lastPoolRefreshAt` 存放 | ⚠️ R2 作废:随 sweep 撤下不再需要;durable 节流状态改落 `QuotaMonitorState`(plan §3.4) |
| 5 | display 何时更新 | 未能从仓内证据确证 `claude /login` 对 `~/.claude.json` 的写行为;不影响设计(Fix A probe-first 不再依赖 display 做肯定性判定),仅使 8-13 现场归因停留在「候选 (a) 最可能」。**诚实边界:不作断言** |

## 7. 新发现的次级问题(设计需覆盖)

- **S1 auth 标记的解除路径**(⚠️ R2 修订):历史上已被标 `authExpired` 等的槽,被 Fix A/B 的 strict capture 写入验明身份的活凭据后,必须清除 auth 家族三标记(否则该槽被永久排除出候选);`identityMismatch` 权属独立(FLY-1252:仅对照 `AccountEntry.identity` 期望确认后才可清,见 plan §2.3)。现状 bash `active_sync_store` 只 sync `activeAccount` 且 best-effort → plan 新增 strict 合同。
- **S2 tick 内顺序**(⚠️ R2 缩水):refresh sweep 撤下后仅剩「reconcile 先于 C′ 老化报告」(authority 非 resolved 时 C′ 整轮跳过)。
- **S3 `use` 的 audit**:no-op 出口也要落 `audit_append`(现有审计通道,:139),否则「Lead 代切成功」在审计账上不可见。

## 8. R1 更正记录(2026-08-21,Codex design review R1 折入)

初稿三个结论被 R1 证伪/降级,已在原位标注(⚠️),此处集中存档,防整块引用时漏更正:

- **A. Keychain raw digest 基建不存在**(§1 表格):`readKeychainMonitorCredential` 只暴露 accessToken/expiresAt;`rawDigest` 仅池侧。plan 的 digest 触发器需新增 `readKeychainRawDigest()`。
- **B. 「TOCTOU 无害」不成立**(§5):accounts lock 序列化不了 founder 的 `claude /login`;安全性由 Keychain 字节 fence + 全路径 fail-closed 承担,不由锁承担。daemon 快照读取须在短锁内。
- **C. 家族模型不足以授权后台轮换器**(§3-3、§6-1):「非 active = 家族唯一持有者、定期刷新可无限保活」在集体 stale 证人下不可证明——后台 refresh sweep 从本单撤下(plan §5.3 存档启动前提),模型证据强度降级为「支持现有按需 fail-closed freshness 检查」。由此连带:初稿 §3-5「Fix C 防久坐腐烂」的动机作废,降级为 C′ 零网络老化报告;§7-S2(先 B 后 C 排序)随 sweep 撤下而失效。
- **C. 家族模型不足以单独授权后台轮换器**(§3-3、§6-1):R1–R7 「撤下 sweep」是当时的安全评审结论;其决策已被 §9 Founder 终裁覆盖。最终授权不来自「池标记说它非 active」,而来自当轮活 Keychain `oauth/profile` 身份直证;只有证明为非 active 的槽才能刷新。

## 9. Founder 终裁差异记录(2026-08-21)

Founder 明确裁定「自动定时保鲜」为必须项:几周不碰的号无人能保证不烂,烂一个就回到全手动。这一产品/运维决策推翻了 R1–R7 评审「只报老化、撤下定时 refresh」的取舍。安全边界为:

1. 守护每轮先用活 Keychain 凭据调 `oauth/profile`,唯一映射 anchor 槽;不可得/不唯一则整轮零 refresh。
2. 活跃槽绝不 refresh;仅对当轮直证的非活跃槽执行 refresh 并原子写回轮换后新凭据。
3. refresh 被拒表明该家族链已转走:不覆盖池,保留 fail-closed,并用老化报告点名。
4. `use` 成功路径的 freshness helper 必须把 refresh 轮换后的新钥匙先写回目标池槽,再安装到 Keychain;这是 `1 → 2 → 1` 零手动往返的必要条件。
