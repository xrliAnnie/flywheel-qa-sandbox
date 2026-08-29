# FLY-1243 flag-cleanup ② 批量 11 个 flag 固化 default-on + 退休 — 实施计划

Issue: FLY-1243 (https://linear.app/geoforge3d/issue/FLY-1243/flag-cleanup-批量12-个-flag-固化-default-on-退休-flagfly-1136-audit)
日期: 2026-07-14
基于: exploration.md

## 0. 范围(Tadashi gate 拍板后 = 11 flag)

固化 default-on + 退休:alert_threads · stuck_errorsig · pane_multiframe · detection_gap_scan · auto_repair · account_self_heal · notify_digest_expect · xhs_review · roundtable_reply_in_thread · roundtable_enabled · detection_escalation。

**剔除 runner_autocontinue**(生产 UNSET + canary,防 FLY-314 式 partial-enable;flag 原样留)。

## 1. TDD 顺序(RED → GREEN)

1. **先动 config 包**(registry + drift/resolve/registry 测试)—— 删 11 定义,更新测试断言。跑 config 包测试 → 期望 drift 反向对退休 flag 不再找 readSite(通过),正向不再扫到裸 gate(等代码删完才真通过)。
2. **再动 teamlead 生产 gate** —— 逐 flag 删 env 读,保留逻辑/同伴 gate。
3. **收敛 teamlead 测试** —— 删 `=0` sentinel(off 路径已不存在),on-behavior 改无条件。
4. 全仓 `pnpm test` + `pnpm lint` 绿。

drift 正向守卫是最终裁判:11 个 envVar 在生产 `src` 里必须**零** `process.env.FLYWHEEL_*` 布尔 gate 残留,且注册表里**零**定义 → 两侧同步才过。

## 2. 逐 flag 精确编辑(生产)

### A 类 — 删守卫,永远跑
| flag | 文件:符号 | 编辑 |
|---|---|---|
| stuck_errorsig | stuck-candidate.ts `evaluateStuckCandidate` | 删 `input.errorSigEnabled ?? env==="1"` gate + `errorSigEnabled` 输入字段;error-sig 路无条件跑(在硬安全 gate 之后) |
| pane_multiframe | plugin.ts `createBridgeApp` LeadWatchdog 构造 + LeadWatchdog.ts | 删 `multiFrame` env 读;LeadWatchdog 内多帧路径无条件生效(删 `multiFrame` option 或内部恒真) |
| detection_gap_scan | plugin.ts `gapScanTick` | 删首行 `if (env!=="1") return;` 早退 |
| detection_escalation | plugin.ts `detectionEscalationEnabled()`(4 call site)+ stuck-escalation.ts | 删谓词函数,4 处调用点无条件走;stuck-escalation.ts `env==="1" &&` 条件去掉该合取 |
| notify_digest_expect | notify-receipts.ts `isDigestExpectEnabled` + notify-digest-expect.ts | 删 gate 谓词,写回执 + expect tick 无条件跑 |

### B 类 — 删 flag,同伴配置 gate 保留
| flag | 文件 | 编辑 |
|---|---|---|
| alert_threads | plugin.ts:6022/7029/7406 | 删 `alertThreadsEnabled`;`alertHub = unifiedAlert && repairChainResolves ? …`;删 7029 的 flag-misconfig warning(改成 unifiedAlert-present 但 chain 不解析时才 warn,或直接删该 warning——无频道本就不建 hub) |
| auto_repair | plugin.ts:6023/7414/7548 | 删 `autoRepairEnabled`;`autoRepairBot: new AutoRepairBot(…)` 无条件(仍在 alertHub 内=需频道);日志去掉 on/off 分支 |
| xhs_review | plugin.ts:1613 | 删 `if(env==="1")`,永远挂 xhs review loopback 路由 |

### C 类 — 删 flag,改「同伴配置 present 才激活」
| flag | 文件:符号 | 编辑 |
|---|---|---|
| roundtable_enabled | roundtable-config.ts:71 `loadRoundtableConfig` | `if (env.X!=="1") return undefined` → `if (!(env.FLYWHEEL_ROUNDTABLE_CHANNEL_ID??"").trim()) return undefined`;有 channel 但缺 token/userid 仍 fail-loud throw |
| roundtable_reply_in_thread | codex-lead-runtime.ts:585 | `if (env.X==="1")` → 先算 parentChannelId(channel_id ‖ crossDept[0]);`if (parentChannelId 可解析) { … }` 否则不激活(不 throw);移除原「flag=1 但无 channel→throw」(现在无 channel 优雅跳过) |
| account_self_heal | 14 sites(plugin.ts:7065/7887/…、account-switch-repair.ts:90、infra-notify.ts:63、LeadWatchdog.ts:604) | 删所有 `env.FLYWHEEL_ACCOUNT_SELF_HEAL === "1"`;plugin 永远构造 accountSwitchRepair;repair 内 isEnabled 默认恒真;infra-notify 保留 `resolveInfraNotifyIdentity` 同伴 gate(去掉 flag 合取);LeadWatchdog usage_limit attach 无条件(仍受 isTransient 短路保护) |

## 3. registry.ts(config 包)

删 11 个 flag 定义块(alert_threads/stuck_errorsig/pane_multiframe/detection_gap_scan/auto_repair/account_self_heal/notify_digest_expect/xhs_review/roundtable_reply_in_thread/roundtable_enabled/detection_escalation)。**保留** runner_autocontinue 定义(含 canary 注释)。

## 4. 测试收敛(teamlead + config)

- **删 `=0` reverse-compat sentinel**(off 路径不存在):stuck-candidate.test / LeadWatchdog-fly1048-multiframe.test / AlertChannelHub.contract-escalate.test / account-selfheal-bytecompat.test / infra-notify-bytecompat.test / notify-digest-expect off-branch / xhs-review-mount off-branch / roundtable-config off-branch / roundtable-reply-in-thread off-branch / stuck-detection-interop off-branch / stuck-escalation off-branch。
- **on-behavior 测试改无条件**(删 `env=1` setup,断言功能默认生效)。
- **config 包**:feature-flags-drift.test(11 flag 出注册表→反向不再校验它们;正向确认生产无残留 gate)、feature-flags-resolve.test(删 auto_repair 等 resolve 断言)、feature-flags-registry.test(计数/存在性)。

## 5. 脚本(不破坏)

无脚本靠 `=0` 关这些;`=1` sets 退休后 inert。可选清理非测试脚本(token-usage-daily.sh 等)的 `=1` export —— **本 PR 不动**(inert 无害,减少面),留 follow-up 若需要。

## 6. 验收

- `pnpm --filter @flywheel/config test` + `pnpm --filter @flywheel/teamlead test` 绿。
- `pnpm lint` 全仓绿。
- `grep -rE "process.env.FLYWHEEL_(ALERT_THREADS|STUCK_ERRORSIG|PANE_MULTIFRAME|DETECTION_GAP_SCAN|AUTO_REPAIR|ACCOUNT_SELF_HEAL|NOTIFY_DIGEST_EXPECT|XHS_REVIEW|ROUNDTABLE_REPLY_IN_THREAD|ROUNDTABLE_ENABLED|DETECTION_ESCALATION)" packages/*/src` 排除 __tests__ = 零命中。
- 11 flag 在 registry.ts 零定义;runner_autocontinue 仍在。
- Codex code review APPROVED。
