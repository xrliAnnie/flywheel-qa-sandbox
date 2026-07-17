# FLY-1252 claude-accounts.json 配额状态可信化 — 调研

Issue: FLY-1252 (https://linear.app/geoforge3d/issue/FLY-1252/infra-claude-accountsjson-配额状态过期不可信-切号器切到已耗尽账号拖垮-lead)
日期: 2026-07-16
基于: exploration.md

Lead 批复(brainstorm gate):方案 C 批准,四个钉子:① bypass 响亮(log+告警);② 硬拒消息可行动(报哪个号有量);③ store 写并发纪律(daemon=唯一自动观察写者、G3 时间戳、last-observed-wins、锁序);④ 回归含 kill-switch 回滚场景。手动路径对 exhausted = 硬拒确认。

## 1. 现有机件盘点(代码级事实)

| 机件 | 位置 | 与本单的关系 |
|---|---|---|
| store 读写 | `packages/teamlead/src/account-heal/account-store.ts` | `AccountEntry{name, quotaExhaustedUntil, weeklyResetAt, authExpired?…}`;`readStore` fail-soft、`writeStore` 原子(tmp+fsync+rename, 0600);`isQuotaUsable(entry, nowMs)` = `quotaExhaustedUntil` null/过期/不可解析 → usable。**G3 新字段落这里** |
| 切号执行 | `switch-executor.ts` | `commitSwitch` 是 `quotaExhaustedUntil` 唯一现有写点(标记被切走的源账号,bump generation)。**不改语义,保持它是唯一「切号标记」写者** |
| daemon 编排 | `quota-monitor.ts` | `pollOnce`:锁下快照 → 锁外 fetch active usage → `commitSuccessfulObservation`(重取锁、CAS 复核、写 statusline 缓存、persist state)→ 触发判断 → `verifyAndRankCandidates`(逐候选:锁下 freshness+读 token → 锁外 fetch usage → 资格 <100%/<100%)→ `switchAccount(preferredOrder)`。**观察回写挂接点在这里(§3)** |
| daemon 接线 | `quota-monitor-runtime.ts` | 所有 IO 注入的组装点:`withAccountsLock=withMkdirLock(lockPath)`、`readStore/writeStore` 已 import。**新 dep 在这里给真实现** |
| 候选扫描 | `quota-monitor.ts::sweepCandidates` | accelerated 档下每 ~60min 扫一遍闲置候选(fetchUsage 结果**当前被整个丢弃**,只为预热)。**回写后这里变成闲置账号数据的主要来源** |
| usage API 客户端 | `quota-usage-api.ts` | `fetchAccountUsage(accessToken)` → `{ok:{raw, fiveH:{pct,resetsAt}, sevenD:{pct,resetsAt}}} \| {error:…}`;shape 校验、10s 超时、Retry-After。**guard CLI 复用** |
| pool 凭证读取 | `quota-monitor-credentials.ts` | `readPoolMonitorCredential(poolDir, name)` → `{accessToken, expiresAt}`(解析 `.credentials.json` 的 `claudeAiOauth`)。**guard CLI 复用** |
| 手动切号器 | `packages/claude-runner/bin/flywheel-claude-profile`(bash) | `use_profile()`:`require_pool_entry` → `acquire_lock`(FLY-852 delegated 模式:daemon 经 switchAccount 调它时带 `FLYWHEEL_CLAUDE_LOCK_DELEGATED`)→ `freshness_guard`(锁内 Node helper,exit 30/31,bypass env 只在非 delegated 生效)→ kc_write + verify-before-commit → `.active` → identity 同步。**quota guard 插在 freshness_guard 之后(§4)** |
| freshness helper | `freshness-cli.ts` + `bin/flywheel-claude-freshness` | exit-code 契约(0/30/31),**锁内运行、自己不取锁**(约定 caller 持锁)。guard CLI 沿用同一模式,exit code 避开 30/31 |
| 告警链 | `scripts/lead-alert.sh` + `LeadAlertNotifier.ts::ALERT_EVENT_TYPES` + `bridge/kind-contract.ts::KIND_CONTRACTS` + `bridge/__tests__/kind-contract.test.ts` | 新 kind 四处同步的既有模式(FLY-1256 刚走过一遍,6 个 kind)。**钉子① 的 `quota_guard_bypassed` 走这条路** |
| 每日报表 | `account-summary-cli.ts`(读 ledger + store) | store 变真后自动受益,**本单不改它** |
| 锁 | `mkdir-lock.ts` / bash 同款 | mkdir 原子 + holder{pid,at} + 120s stale-break;Node 与 bash 字节兼容 |

## 2. G3 数据模型:AccountEntry 新增 optional 观察字段

```ts
export interface AccountEntry {
  name: string;
  quotaExhaustedUntil: string | null;   // 语义不变;新增观察写者(§3)
  weeklyResetAt: string | null;         // 语义不变;观察时也刷新
  authExpired?: boolean; …              // 不动
  // FLY-1252 新增(全部 optional,byte-compat):
  lastObservedAt?: string;              // ISO;这条观察数据的采集时刻(钉子③时间戳)
  observedFiveHPct?: number;            // 最近一次实测 5h 用量 %
  observedSevenDPct?: number;           // 最近一次实测 7d 用量 %
}
```

- **byte-compat**:旧文件无这些字段照常读;`isQuotaUsable`/`selectNextAccount`/`earliestReset` 不读新字段,行为零变化(哨兵测试)。
- pct 快照的用途:guard 硬拒消息的「哪个号现在有量」表(钉子②)+ summary 未来可用。选号逻辑**不**依赖 pct(资格判断永远走实测,pct 只是展示)。
- 不放进 ledger 的理由:store 是选号与 guard 的数据面(同一把锁、同一文件),ledger 是报告聚合面(FLY-871,自有 staleness 模型);跨文件写会引入第二把锁序。ledger 后续消费 store 观察字段留 follow-up。

## 3. daemon 观察回写(方案 C 之 B 半)

### 3.1 统一语义:一个纯函数

`account-store.ts` 新增纯函数(单一语义实现,三个写点共用):

```ts
applyObservation(entry: AccountEntry, obs: {fiveHPct, sevenDPct, fiveHResetAt, sevenDResetAt, observedAt}): AccountEntry
```

规则:
- `quotaExhaustedUntil` = `sevenDPct >= 100` ? `sevenDResetAt` : `fiveHPct >= 100` ? `fiveHResetAt` : **null(清除)** —— 与 `commitSwitch` 的 operative-reset 语义一致(weekly 支配)。
- `weeklyResetAt = sevenDResetAt`(每次观察都刷新,legacy weekly 排序从此有真数据)。
- `lastObservedAt / observedFiveHPct / observedSevenDPct` 全量更新。
- 卫生:resetsAt 不可解析或已在过去 → 该窗口按未耗尽处理(不标);只接受 shape 校验过的 200 payload(fetchAccountUsage 已保证)。

### 3.2 IO 契约:`recordObservation(name, obs)` 两种持锁形态(钉子③锁序)

- **Node daemon 侧**:`recordObservation` 自取 `claude-accounts.lock` → readStore → 按 name 找 entry(不存在则跳过,不创建——池成员资格不归观察管)→ **last-observed-wins 闸**:若 entry.lastObservedAt 比本次 observedAt 新则跳过写 → applyObservation → writeStore → 放锁。**绝不 bump generation**(CAS 语义 = 已提交切号数,污染它会假触发 daemon 的 generation_advanced 保守恢复与 noop 判定)。
- **guard CLI 侧**(bash `use` 内,caller 已持锁——freshness helper 同款约定):同一 applyObservation + 直接 readStore/writeStore,**不取锁**(取了就和自己的 bash 父进程死锁,FLY-852 教训的镜像)。
- 写者全景(钉子③,写进 plan 的并发纪律表):
  | 写者 | 写什么 | 锁 |
  |---|---|---|
  | `switchAccount::commitSwitch` | 切号标记(源账号 exhausted)+ generation++ + activeAccount | switchAccount 自持 |
  | daemon `recordObservation` | 观察字段 + exhausted 标记/清除(**唯一自动观察写者**) | 自取 |
  | guard CLI(手动 use 内) | 同上(仅手动触发) | caller(bash)持 |
  | bash `use` 本体 | 不写 store(现状保持) | — |

### 3.3 daemon 调用点(quota-monitor.ts,全部经注入 dep)

`QuotaMonitorDeps` 新增 `recordObservation: (name: string, obs: Observation) => Promise<void>`(runtime 给真实现;单测注入 spy):

1. **active 观察**:`commitSuccessfulObservation` 返回 true(CAS 复核通过)后调用——放在锁段外、复核通过后(观察按 name 落账,跨切号也是真话;last-observed-wins 兜并发)。`refreshNewActive` 复用同路径,天然覆盖。
2. **候选验证**:`verifyAndRankCandidates` 每个 `fetchUsage` 成功(ok)后立即调用——**关键顺序**:实测 <100% 的候选先清 store 陈旧标记,才进 `switchAccount`(否则 `selectNextAccount` 的 `isQuotaUsable` 过滤会把刚验证合格的候选拦掉——exploration §6 的坑,plan 里落成显式测试)。
3. **候选扫描**:`sweepCandidates` 每个 fetch 成功后调用(现在结果被丢弃;回写后闲置账号在 accelerated 档每小时刷一次真数据)。

### 3.4 既有行为交互(确认过,无需改)

- 候选预过滤 `if (!isQuotaUsable(entry, now)) continue`(cooldown 跳过、不实测):标记自带真实 resetsAt 自然过期,保留「省 API」权衡;误标自愈路径 = 标记到期后下轮实测清除。
- daemon 状态机(state 文件/backoff/tier/reviveEpoch)零改动。
- statusline 缓存写(`usage-api-cache.json`)零改动。

## 4. 手动路径硬闸(方案 C 之 A 半)

### 4.1 新 helper:`quota-guard-cli.ts` + `packages/teamlead/bin/flywheel-claude-quota-guard`

freshness helper 同构(exit-code 契约、锁内运行、名字不带 secret、token 只进 Authorization 头):

```
check --name <target> --pool <poolDir> [--store <storePath>]
```

- 读 `readPoolMonitorCredential(pool, target)`;token 缺失/已过期 → exit 33(fail-closed;正常流程不会发生——freshness_guard 刚 rotation 完)。
- `fetchAccountUsage(token)`:
  - ok 且双窗口 <100% → **exit 0**;顺手 `applyObservation` 落 store(caller 持锁形态)。
  - ok 且任一窗口 ≥100% → **exit 32**;落 store(exhausted 标记带真实 resetsAt);stderr 打印硬拒消息(§4.3)。
  - error(网络/429/401/malformed) → **exit 33**;stderr 说明原因(fail-closed,bash 拒切)。
- exit code 30/31 已被 freshness 占用,32/33 为新约定;bash 侧精确映射。

### 4.2 bash `use_profile` 接线

`freshness_guard` 通过之后、`kc_write` 之前插 `quota_guard "$name"`:

- **delegated 模式跳过**(`FLYWHEEL_CLAUDE_LOCK_DELEGATED` 非空):daemon 在 `verifyAndRankCandidates` 刚实测过目标,重复调用浪费 usage API 限额(实测 5 次/5min/token)且拖长锁内时长。
- **bypass**:`FLYWHEEL_CLAUDE_QUOTA_BYPASS=1` 且非 delegated → 跳过检查,但(钉子①)**响亮**:stderr 大字警告 + `lead-alert.sh --kind quota_guard_bypassed --severity warning` 一条(签名含 target+时间戳,每次 bypass 必响;lead-alert.sh Bridge-independent,发送失败不阻塞切号——bypass 本来就是紧急通道,fail-open 但记录尽力)。
- exit 32 → `fail_code 32 "…"`,Keychain/.active 未动;exit 33 → 同样硬停,提示网络原因 + bypass env 名。
- helper 路径解析镜像 `default_freshness_bin()`(claude-runner/bin → teamlead/bin 相对推导,env `FLYWHEEL_CLAUDE_QUOTA_GUARD_BIN` 可覆盖);**helper 缺失 = exit 33 同款 fail-closed**(与 freshness 的 31 一致姿态)。
- 锁内网络预算:freshness(OAuth 轮转,10s)+ quota(usage GET,10s)≈ 20s 上限 < 120s stale-break,仍在既有「切号时刻有界例外」框架内(plan 里写明这个预算)。

### 4.3 硬拒消息(钉子②:把人导向能用的号)

exit 32 时 guard CLI 从 `--store` 读全池观察数据,stderr 输出:

```
REFUSED: target 'business' has no quota — 5h 34% / 7d 100% (weekly resets 2026-07-15T19:00-07:00)
Pool status (last observed by quota daemon):
  shopping   5h 12% / 7d 41%   observed 6m ago   ← has quota
  school     5h  0% / 7d 17%   observed 58m ago  ← has quota
  personal   (no observation data)
  personal1  exhausted until 2026-07-17T09:00-07:00 (observed 12m ago)
Suggestion: flywheel-claude-profile use shopping
Emergency override: FLYWHEEL_CLAUDE_QUOTA_BYPASS=1 (logged + alerts the Lead)
```

- 数据源 = store 观察字段(方案 C 两半的协同点);无数据的账号如实标 unknown(base 档闲置账号可能几小时没观察——诚实标注 age,不假装新鲜)。
- Suggestion 规则 = 观察数据里双窗口 <100% 且 lastObservedAt 最新者优先,纯展示建议(不自动改目标)。

### 4.4 `next` 语义

`next_profile` 现状 = 排序后取下一个名字 → `use_profile`(guard 失败即整个命令失败)。改为:按 round-robin 顺序逐个尝试,guard exit 32 的目标**跳过**(stderr 记一行)继续下一个;全部被拒 → 汇总硬停(消息同 §4.3 全景)。freshness 失败(30)沿用现状语义(hard fail,不静默跳——auth 问题要人管)。实现层面把「单目标校验」抽成可复用函数避免 `set -e` 中途炸,细节归 plan。

## 5. 告警 kind:`quota_guard_bypassed`(四处同步,FLY-1256 模式)

1. `scripts/lead-alert.sh` kind 白名单 +1;
2. `LeadAlertNotifier.ts::ALERT_EVENT_TYPES` +1;
3. `kind-contract.ts::KIND_CONTRACTS` +1 —— `{owner: "claude", arc: "human_by_design"}`(与 FLY-1256 五个非 informational kind 同形:Bridge-independent alert root,不承诺 durable ticket 生命周期);**不进** `INFORMATIONAL_KINDS`(bypass 是需要人看见的警告,不是流水信息);
4. `bridge/__tests__/kind-contract.test.ts` drift 守卫同步。

## 6. 测试与回归面(含钉子④)

| 层 | 覆盖 |
|---|---|
| 单测 store | `applyObservation` 全分支(weekly 支配/5h 标记/清除/resetsAt 不可解析或过去/字段全量更新);last-observed-wins(旧观察不覆盖新);**byte-compat 哨兵**:无新字段的旧 store 走全部现有 API 行为逐字节不变 |
| 单测 monitor | 三个调用点各自触发 recordObservation(active 提交后/候选实测后/sweep 后);**清标记先于 switchAccount**(候选带陈旧 exhausted 标记 + 实测 <100% → 标记被清 → selectNextAccount 不再过滤它);CAS 复核失败(stale_snapshot)不落观察;不 bump generation(观察写前后 generation 恒等断言) |
| 单测 guard CLI | exit 0/32/33 全分支;32 时 store 落标记 + 全景消息含建议;33 各 error class;token 永不进 stdout/stderr(grep 哨兵);store 缺失/entry 缺失容错 |
| bash 集成(既有 claude-profile 测试席) | use:guard 拒 → Keychain/.active 未动;delegated 跳过 guard;bypass 跳过 + 触发 lead-alert 调用(fake bin 断言);helper 缺失 fail-closed;next 跳过 exhausted 落到下一个合格者/全拒硬停 |
| **kill-switch 回滚回归(钉子④)** | daemon 形态的 store(观察标记齐全)喂给 legacy 路径:`selectNextAccount`(无 preferredOrder)跳过 exhausted 标记账号、weekly 排序用上刷新过的 weeklyResetAt;e2e 剧本加一幕「撤 CUTOVER 语义下的选号读到真数据」(复用 qa-fly-1256 的隔离手法,独立脚本 qa-fly-1252) |
| e2e | 复现事故:目标账号 mock 为 7d 100% → `use` 硬拒 + 拒绝消息含有量账号;daemon 数轮 poll 后 scratch store 与 mock API 一致(exhausted 带真实 reset、健康为 null) |
| kind 四处同步 | shell↔TS parity / drift 测试沿用既有模式 |

## 7. 风险与边界

| # | 风险 | 处置 |
|---|---|---|
| R-1 | usage API 全挂 → 手动切号全被 33 拦 | 设计如此(fail-closed);bypass env 是响亮逃生门;daemon `quota_monitor_down` 会先叫人 |
| R-2 | 观察数据把候选**误标** exhausted(API 返回异常值) | 只信 shape 校验过的 200;resetsAt 过去/不可解析不标;下轮实测 <100% 自动清;标记自带到期 |
| R-3 | 锁内时长 +10s(quota probe) | 预算 ≈20s < 120s stale-break;仅切号时刻发生;delegated 跳过不加 daemon 路径时长 |
| R-4 | usage API 调用配额(实测 5 次/5min/token) | 手动 use 每次 +1 次(目标 token 的桶,与 daemon 对 active 的轮询不同桶);sweep/verify 频次不变;可忽略 |
| R-5 | store 新字段被第三方脚本读到 | optional 字段、JSON 加性变更;readStore fail-soft 不受影响 |
| R-6 | `next` 行为变化(跳过 exhausted) | 语义更符合「找下一个能用的」;plan 里列为显式行为变更,PR 描述注明 |

## 8. 非目标(明确出界)

- 不改 FLY-1256 daemon 的触发/选号/恢复/告警逻辑本体(只加观察回写 dep)。
- 不动 TUI 撞墙检测链(runner-quota-detector / derive-account-limit)——不新增第三个 store 写者(Lead 已确认)。
- 不改 `flywheel-account-summary` / ledger(store 变真自动受益;ledger 消费观察字段 = follow-up)。
- 不动 statusline 缓存 / freshness helper 本体。
- Codex 账号池(codex-profile)不在本单。
