# FLY-1243 flag-cleanup ② 批量 12 个 flag 固化 default-on + 退休 — 探索

Issue: FLY-1243 (https://linear.app/geoforge3d/issue/FLY-1243/flag-cleanup-批量12-个-flag-固化-default-on-退休-flagfly-1136-audit)
日期: 2026-07-14
基于: 无

## 1. 任务

FLY-1136 审计定档 = ②「enable 后删」:已全量 enabled 的 flag → **固化默认开**(移除 flag gate)+ **退休 flag**(删注册表定义)+ **保留逻辑**。本批 12 个 env flag。排除 `watchdog_judge`(与 FLY-1234 双执行);`detection_escalation` 排在 FLY-1234 ship 之后(现已 live,GO)。

12 个:`alert_threads` · `stuck_errorsig` · `pane_multiframe` · `detection_gap_scan` · `auto_repair` · `account_self_heal` · `notify_digest_expect` · `xhs_review` · `roundtable_reply_in_thread` · `roundtable_enabled` · `runner_autocontinue` · `detection_escalation`

## 2. 架构:flag 系统是「注册表 + 漂移守卫」

- **单一真相** = `packages/config/src/feature-flags/registry.ts`(FLY-709)。每个 flag 声明 name/envVar/polarity/default/readSites。
- **漂移守卫** = `packages/config/src/__tests__/feature-flags-drift.test.ts`,双向:
  - 正向:扫生产 `src` 里的 `process.env.FLYWHEEL_*` 布尔 gate,未注册 → CI 挂。
  - 反向:每个注册 flag 的 readSite 文件里必须真出现该 envVar。
- **推论(关键约束)**:退休一个 flag = **代码 gate 和注册表定义必须同步删**。只删注册表 → 正向失败(生产还有裸 gate);只删代码 → 反向失败(readSite 找不到 envVar)。

## 3. 事实核对:生产 `~/.flywheel/.env` 现状(不信标签,查事实)

10/12 现在就是 `=1`。**两个例外**:
- `FLYWHEEL_DETECTION_ESCALATION` = UNSET → 预期内:issue 明说排在 1234 之后才 enable,本批**即是它的首次通电**。1234 已 live → GO。
- `FLYWHEEL_RUNNER_AUTOCONTINUE` = **UNSET**,且注册表注释写「默认 off,先单-runner canary」。固化 = /loop 自续跑 arming 打到**每个** runner,一个**从未在生产验证过**的行为。→ **需 Tadashi 明确确认**(见 §5 决定 A)。

脚本核对:**没有**脚本靠 `=0` 关这些(无 disable-reliance);有脚本 `=1`(qa/token),退休后成 inert no-op,不破坏。

## 4. 逐 flag 变换分类(移除 gate,保留逻辑)

### Type A — 干净无条件(删 `=== "1"` / `!== "1"` 守卫,永远跑)
| flag | gate 位点 | 变换 |
|---|---|---|
| stuck_errorsig | stuck-candidate.ts:320 `input.errorSigEnabled ?? env` | 删 env + 注入参数,error-sig 路永远跑 |
| pane_multiframe | plugin.ts:8114 `multiFrame: env==="1"` | `multiFrame: true` → 删 LeadWatchdog `multiFrame` option,永远多帧 |
| detection_gap_scan | plugin.ts:5594 早退守卫 | 删守卫,gapScanTick 永远跑 |
| detection_escalation | plugin.ts:5331 `detectionEscalationEnabled()`(4 call sites)+ stuck-escalation.ts:706 | 删谓词,永远升级(**首次通电**) |
| notify_digest_expect | notify-receipts.ts:33 `isDigestExpectEnabled` + notify-digest-expect.ts 内部 | 删 gate,永远写回执 + 永远跑 expect tick |

### Type B — 删 flag,但**同伴配置 gate 保留** → 未配置部署 byte-compat
| flag | gate | 保留的同伴 gate |
|---|---|---|
| alert_threads | plugin.ts:6022/7029/7406 | `unifiedAlert && repairChainResolves`(无频道→alertHub 仍 undefined) |
| auto_repair | plugin.ts:6023/7414 | 在 alertHub 内构造(无频道→AutoRepairBot 从不建) |
| xhs_review | plugin.ts:1613 route mount | **无**同伴配置 → 永远挂 localhost review 路由(loopback+session-token,无害;见 §5 note) |

### Type C — flag 曾是**唯一主 gate**;裸删会 throw/误激活 → 改为「**同伴配置 present** 才激活」
| flag | 现有 | 变换(保 byte-compat 不 throw) |
|---|---|---|
| roundtable_enabled | roundtable-config.ts:71 `env!=="1"→undefined` | 换成 `CHANNEL_ID` 缺失 → undefined;有 channel 但缺 token/userid 仍 fail-loud |
| roundtable_reply_in_thread | codex-lead-runtime.ts:585 `env==="1"` | 换成 parentChannel 可解析才激活;否则不激活(非 throw) |
| account_self_heal | 14 sites,核心 plugin.ts:7065 构造 gate + repair 内部 isEnabled(account-switch-repair.ts:90)+ infra-notify.ts:63 + LeadWatchdog.ts:604 | 全删 env `=== "1"`;永远构造 repair runtime,靠既有 account-pool / infra-identity guard 保未配置 byte-compat(切号仍需真 cap+池) |

### Type D — 实质功能,生产未开,需明确确认
| flag | 现有 | 风险 |
|---|---|---|
| runner_autocontinue | plugin.ts:7938 boot gate + armer.ts:90/146 | 生产 UNSET + canary。固化 = 全 fleet 每 runner /loop 自续跑,未验证 |

## 5. 需要 Tadashi 确认的真决定(非制造出来的)

**A(最重要)· runner_autocontinue**:生产 UNSET + 注册表写「canary」。本批固化 = 全 fleet 每 runner /loop 自续跑 arming,一个从未生产验证的实质行为。确认:本批真要它全 fleet 永远开?还是像 watchdog_judge 一样**移出本批**(留作真 canary)?

**B · Type-C config-presence 语义**:roundtable_enabled / roundtable_reply_in_thread / account_self_heal 的 flag 曾是主 gate。裸删会让未配置部署(QA slot / sub / joycon)在 boot throw 或误激活。我改成「gate 在同伴配置存在」(有 channel/池才激活,无则优雅跳过 = byte-compat)。确认此语义 OK。

**C · 测试 & 脚本**:各 flag 的 `=0` reverse-compat sentinel 测试(off 路径已不存在)→ **删**;on-behavior 测试 → 改为无条件。脚本里 inert 的 `=1` 保留(无害)。确认。

## 5b. 决定拍板(Tadashi,2026-07-14 brainstorm gate)

- **A · runner_autocontinue 移出本批 → 批量 12→11**。事实核对推翻其入批前提(生产 UNSET + canary)。flag 原样保留(含 canary 注释)。PR 描述注明剔除理由。
- **detection_escalation = GO**(1234 已 live,原计划顺序满足)。
- **B · Type-C config-presence 语义接受**(缺配置优雅跳过非 throw = 硬要求)。xhs_review 永挂 loopback OK。
- **流程**:保留 plan.md + codex CODE review 硬门;research + design-review 省(本批机械但面宽)。

**本批最终 11 flag**:alert_threads · stuck_errorsig · pane_multiframe · detection_gap_scan · auto_repair · account_self_heal · notify_digest_expect · xhs_review · roundtable_reply_in_thread · roundtable_enabled · detection_escalation。~~runner_autocontinue~~(剔除)。

## 6. 交付范围

- `packages/config/src/feature-flags/registry.ts`:删 12 个 flag 定义。
- `packages/config/src/__tests__/feature-flags-drift.test.ts` / `feature-flags-resolve.test.ts` / `feature-flags-registry.test.ts`:随注册表收敛。
- `packages/teamlead/src/**`:~8 生产文件删 gate,保留逻辑(plugin.ts 是热点)。
- ~15 测试文件:删 `=0` sentinel,on-behavior 改无条件。
- TDD:先让 drift 测试 + 逐 flag「无条件生效」测试变红,再改代码变绿。
