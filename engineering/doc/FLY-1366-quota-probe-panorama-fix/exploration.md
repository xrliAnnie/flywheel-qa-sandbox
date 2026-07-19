# FLY-1366 账号自愈探针失效 — 探索

Issue: FLY-1366 (https://linear.app/geoforge3d/issue/FLY-1366/bughigh-账号自愈切换失效panorama-探针-44-全失败usage-malformed3-freshness-stale-no)
日期: 2026-07-18
基于: 无

## 一句话问题

FLY-1182 账号自愈的切换决策每次都判「无可切目标」(no_target),因为 panorama 对 4 个备选号的健康探针全部失败——**根因不是数据源变更,而是 usage 校验器把「闲置账号」这一 API 合法形态判成 malformed**,外加 personal 号的 refresh token family 已死、告警可达性配置缺失。三层叠加,quota 100% 时自愈完全失效,Annie 被迫手动换号。

## 实证时间线(全部来自 /tmp/flywheel-quota-monitor.log + 真机探测)

| 时间(UTC) | 事件 |
|---|---|
| 07-16 06:06 起 | daemon 正常轮询 active 号用量(personal1→business→school→personal→…→shopping,期间多次**手动**换号,daemon 从未自动切过——`switch` 事件全 log 为 0) |
| 07-18 00:19–01:09 | `identity_conflict` ×6(daemon 07-17 17:14 PDT 重启后 .active 与 keychain 身份不一致;18:18 PDT 有人写 .active 后恢复) |
| 07-18 04:19–04:49 | **第一轮** `no_target` ×4,panorama 与事故完全相同(school/business/personal1=usage_malformed, personal=freshness_stale)——**事故前一晚已复现,非偶发** |
| 07-18 17:19–17:59 | **事故窗口** `no_target` ×5,shopping 90→95→98→100%;`quota_no_target` 告警 2 次 primary=sent |
| 07-18 18:09 起 | Annie 手动切到 personal1 → `identity_conflict`(machine_account_conflict),panorama 不再运行,**自愈至今仍挂起** |

## 根因(真机实证,非推测)

### R1(核心): usage 校验器拒绝「闲置账号」的合法 API 形态 → usage_malformed ×3

用 pool 里 daemon 刚刷新过的有效 token **只读**实测 `GET /api/oauth/usage`(2026-07-18 ~11:15 PDT):

```
school:    HTTP 200  five_hour: {"utilization":0,"resets_at":null,...}  seven_day: {"utilization":88,"resets_at":"2026-07-20T15:59:59Z"}
business:  HTTP 200  five_hour: {"utilization":0,"resets_at":null,...}  seven_day: {"utilization":4, "resets_at":"2026-07-23T02:00:00Z"}
personal1: HTTP 200  five_hour: {"utilization":17,"resets_at":"2026-07-18T23:00:00Z"}(Annie 刚切过去在用,窗口已激活,能通过校验)
```

**没有活跃 5h 窗口的闲置账号,API 返回 `resets_at: null`**。而 `quota-usage-api.ts:39-48 isQuotaWindow` 要求 `resets_at` 必须是可 `Date.parse` 的 string → `null` → `validatePayload` 返回 null → `error:"malformed"` → panorama `usage_malformed`(class=unverifiable)→ 不可作切换目标。

**即:探针把「0% 用量的完美备胎」系统性拒之门外;备胎越闲置越健康,越被判死。** active 号因为一直在用、窗口常开,所以校验一直通过——这解释了「监控正常、切换全灭」的诡异组合。

上游确认这是 day-one 盲区:FLY-1256 research 当时只在**活跃**账号上探测过 API(five_hour/seven_day 均有 resets_at),从未观测过闲置形态;FLY-1182 沿用了该假设。issue 候选方向 1 的三个猜测(格式变更/缓存损坏/数据源变更)均不成立——**格式从来如此,是校验器假设错了**。

### R2: personal 号 refresh token family 已死 → freshness_stale + 观测性双缺口

panorama 对候选号先做 OAuth probe-refresh(freshness.ts,`console.anthropic.com/v1/oauth/token`),成功才拿新 token 探 usage。personal 的 pooled credential `expiresAt=2026-07-17T10:48Z` 已过期一天多且每轮 refresh 被拒(其余 3 号每轮都刷新成功、expiresAt 始终在未来 8h)——refresh token family 大概率已被别处 rotate(如手动 `claude /login` 未回存 pool)。**不是** issue 猜测的「用量快照没刷新/抓取链路断了」——freshness 判的是 OAuth 凭据新鲜度,不是用量数据新鲜度。

观测性双缺口:
1. `verifyPoolCredential` 返回的 stale **reason**(如 `refresh refused (HTTP 403)`)在 `readCandidateCredential`(quota-monitor.ts:291-312)被丢弃,panorama 只剩裸词 `freshness_stale`,运维无从判断该修什么;
2. store 有 `refreshTokenInvalid` 字段(会使账号 auth_unusable),但**没有任何路径**在 refresh 持续被拒时落这个标或发「该号需重新登录」告警(唯一 writer 是 pool-rebuild 置 false)。personal 死了 2+ 天无人知晓。

### R3: 告警可达性 —— sent ≠ founder 可见

`quota_no_target` 路由策略是 `mention:true, severe:true`(quota-monitor-alert.ts:57),但 daemon 环境里:
- `FLYWHEEL_QUOTA_ALERT_MENTION_USER` **未设置** → 不 @Annie;
- `FLYWHEEL_QUOTA_ALERT_SEVERE_CHANNEL_ID` **未设置** → 无第二频道双投。

告警实际落在 `FLYWHEEL_UNIFIED_ALERT_CHANNEL_ID`(#flywheel-alerts,infra-bot 工单频道),无 mention → Annie 收不到任何推送。「实发」了,「实收」没有。

### R0(放大器,不在本 issue 修): degradedSwitch 兜底被关闭

quota-monitor.ts:1642 有「全 unverifiable 时按 store 记录盲切」的 degraded 兜底,但 `~/.flywheel/quota-monitor.json` 无 `degradedSwitch` 键 → 默认 false → 关闭。若开着,事故当时 school/business/personal1(store 标记全干净)会被盲切救场。这是 FLY-1182 决策逻辑的配置项,属边界外,列为 follow-up 供 Lead/Annie 决策。

## 方案

### F1(核心修复): usage 校验接受 inactive window

`QuotaWindow.resets_at: string | null`;`isQuotaWindow` 允许 `null`(仍要求 utilization 为有限数 ≥0、string 时必须可解析)。`resetsAt: string | null` 沿类型链诚实传播,消费点逐一 null-safe(全量清单见 research.md,波及面小:quota-monitor.ts 4 处 / quota-guard-cli.ts 4 处 / account-store.ts 观测投影)。关键语义:
- 候选排序(sevenD resetsAt 为 null = 周窗未开 = 最优,排最前);
- 主动号触发路径若 operative resetAt 为 null(pct≥90 时理论不可能)→ fail-visible 记日志不造假时间戳;
- ledger `applyObservation` 的 Date.parse 守卫天然兼容 null,只改类型即可。

否决的替代:在解析层把 null 归一成伪时间戳(如 now)——隐藏事实、污染 ledger,拒绝。

### F2: freshness_stale 带因透出

panorama status 从裸词改为模板 `` `freshness_stale: ${reason}` ``(仿既有 `model_bench_malformed: ${reason}` 形态,panoramaClass 用前缀判类),日志与 no_target 告警 body(panoramaBody)自动携带。**不**自动落 `refreshTokenInvalid`/不发新告警 kind(那会改变候选资格判定与告警面,越界)——「refresh 连续被拒 N 次自动标记+专项告警」列为 follow-up 选项。

### F3: 告警可达性

- 代码:mention user 未配置时 fallback 到 `FLYWHEEL_FOUNDER_USER_ID`(daemon env 已有)——「忘配」不再静默降级;
- 运维:`FLYWHEEL_QUOTA_ALERT_MENTION_USER` **保持不设**——让代码 fallback 层真实生效并被 QA 验证(显式设置只留作未来覆盖手段);severe 双投频道保持不设(现状),列为可选;
- QA:实发实收(触发一条真告警,Discord 侧核实消息 + mention 落到位)。

## 边界(不动项)

- 切换决策逻辑(阈值/排序规则/degradedSwitch/确认流)= FLY-1182 本体,不动;
- identity_conflict(手动切号后 .active 与 keychain 失配、自愈挂起)= FLY-865 机制域,**生产现在正卡在这个状态**,需运维先对齐(否则 QA 无法真机验证自动切换),代码不动,列 follow-up;
- personal 号复活 = 运维动作(Annie 重登 + `claude-profile save personal`),非代码。

## 部署注意

daemon(launchd `com.flywheel.quota-monitor`)跑的是 **FLY-1182 worktree 的 dist**,且 **loaded job 的 plist 把 wrapper 与 4 个路径 env 硬钉在该 worktree**(`launchctl print` 实证,design review 阶段确认)。merge 到 main ≠ 生效,且「改 .env + kickstart」也不够(kickstart 不重载 plist、wrapper 会恢复 launchd 预注入 env):ship 必须 **bootout 旧 job + bootstrap 主仓 plist**,细节见 plan.md §4。

## 开放问题(brainstorm gate 向 Lead 确认)

1. F1/F2/F3 的范围认定(尤其 F2 不落 refreshTokenInvalid、R0 不开 degradedSwitch)是否同意;
2. no_target 告警是否要求进 founder 可见渠道(现方案 = 原频道 + @mention;更重的 founder-page 机制留给 FLY-368 域)。
