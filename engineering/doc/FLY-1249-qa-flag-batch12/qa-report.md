# FLY-1249 独立 QA · FLY-1243 PR #588（11 flags 固化 default-on）— QA 报告

Issue: FLY-1249 (https://linear.app/geoforge3d/issue/FLY-1249/qa-fly-1243-独立验证-pr-58811-flags-固化-default-on本批最重)
日期: 2026-07-14
基于: 无（独立 QA，与实现者零共享）

## 裁决：✅ PASS

对象：PR #588 head `c9aab973a91ace84204da2636ae850c1c27fa6fd`（FLY-1243）。
6 项验收全部通过。**不 ship**（QA-only）。

> 前提确认：PR head `c9aab973a` 对上任务、state=OPEN/MERGEABLE/CLEAN、CI 两项全 SUCCESS；`runner_autocontinue` 已按 brainstorm gate 决定剔除（本批 11 flag）。

---

## ① Fresh checkout ✅

隔离 worktree 精确 checkout 到 reviewed commit `c9aab973a`（**非**实现者的 `flywheel-FLY-1243` worktree，零共享）。PR 无 `package.json`/lockfile 变更 → `pnpm install --frozen-lockfile` exit 0。

## ② config drift 37/37 + teamlead 套件 + build + shell + biome ✅

| 项 | 结果 | 证据 |
|---|---|---|
| **config drift 37/37** | ✅ | `flywheel-config` 全套 **394/394 绿**。"37" = 四个 feature-flag 文件之和：drift(3)+resolve(13)+registry(9)+direct-toggle(12)=**37**，全绿。drift **正向扫描**（生产 src 里每个 `process.env.FLYWHEEL_*` 布尔 gate 必须已注册或 allowlist）结构性独立复核了 ⑤——若 11 个退休 flag 还有裸 gate，正向测试必 FAIL，但它 PASS。 |
| **teamlead 相关套件** | ✅ | 15 个 FLY-1243 相关套件在干净 build + clean TMPDIR 下隔离复跑 **15 files / 230 tests 全绿**；`codex-lead-runtime.test.ts` 隔离 **124/124 绿**。 |
| **build** | ✅ | `pnpm -r build` exit 0（全 monorepo 含 teamlead 干净编译 = PR TypeScript 全仓类型检查通过）。 |
| **shell 测** | ✅ | `token-usage-daily-failloud` **8/8**（含 "expect unset → alert fires unconditionally (FLY-1243 default-on)"）；`codex-lead-tui-home` 的 **7 个 FLY-1243 marker cases 干净 env 下全绿**。 |
| **biome** | ✅ | `biome check` exit 0，1860 files，**0 error**，15 warning 全在非-PR 文件（既存无关）。 |

### ⚠️ teamlead 全套件的表面「大规模失败」= 环境 artifact，非 PR 回归（已证）

首次 `pnpm --filter flywheel-teamlead test` 报 262 files failed / 30 tests failed。**根因锁定并证伪**：

1. **262 文件失败 = 缺 build**：错误 `Failed to resolve entry for package "flywheel-config"/"flywheel-core"/…`。teamlead 测试 import 的是内部包的**编译产物**（`dist/`），我 fresh checkout 只 `install` 没 `build` → 全部 workspace-dep import 解析失败。跑 `pnpm -r build` 后，15 个相关套件 + codex-lead-runtime **全部转绿**。
2. **30 个真 test 失败 = FLY-245 + host 环境**：可见失败全在 `codex-lead-runtime.test.ts` 的 **FLY-245 write-capable release gate**（与 FLY-1243 无关），叠加 `timed out waiting for daemon operation lock ~/.codex-infra-bot/…`（繁忙生产 host 的真 daemon-lock 争用）。干净 build + clean TMPDIR 隔离复跑 → **124/124 全绿**。

CI（干净 runner）对该 PR 全绿，与上述诊断一致。

## ③ 逐 flag 三类核对 ✅

代码级逐行核对 + 相关单测 + 直接 boot-simulation。

### Type-A（5，纯删守卫→无条件路径）✅
| flag | 变换 | 核对 |
|---|---|---|
| stuck_errorsig | 删 `errorSigEnabled?` 输入 + `?? env==="1"` 门 | error-sig tail 扫描无条件跑（仍在硬安全 gate 之后）✓ |
| pane_multiframe | `multiFrame: env==="1"` → `multiFrame: true` | LeadWatchdog 多帧永远开 ✓ |
| detection_gap_scan | 删 `gapScanTick` 首行早退守卫 | 零-token gap 扫描恒跑 ✓ |
| detection_escalation | 删 `detectionEscalationEnabled()` 谓词 | 4 call site + reconcileTick + gapScanTick 全无条件（见 ④）✓ |
| notify_digest_expect | 删 `isDigestExpectEnabled` + 两处 guard + `"inactive"` outcome | receipt 恒写、expect tick 恒跑 ✓ |

### Type-B（3，同伴配置 gate 保留）✅
| flag | 保留的同伴 gate | 核对 |
|---|---|---|
| alert_threads | `alertHub = unifiedAlert && repairChainResolves` | 无 unified channel → 无 hub = byte-compat；有 channel 但 chain 不解析 → fail-loud ✓ |
| auto_repair | `autoRepairBot` 无条件但**在 hub 内**（需 channel+chain） | 无 hub → 无 auto-repair ✓ |
| xhs_review | 无同伴配置（永挂 loopback review 路由） | 单测证 "XHS_REVIEW **unset** → route still mounted"；"non-loopback → 403"（loopback+session-token 守卫保留，fleet-wide 无害）✓ |

### Type-C（3，同伴配置 present 才激活、缺配置优雅跳过不 throw）✅
| flag | 变换 | 核对 |
|---|---|---|
| roundtable_enabled | `ENABLED!=="1"` → `if(!channelId) return undefined` | CHANNEL_ID 缺 = byte-compat OFF；有 channel 但缺 token/userid 仍 fail-loud throw ✓ |
| roundtable_reply_in_thread | `REPLY_IN_THREAD==="1"` 门 → parentChannel 可解析才激活 | 缺 parent → 不激活（**不再 throw**）；cross-dept 不含时 throw 只在 channel 已设的真误配路径 ✓ |
| account_self_heal | 14 sites 删 flag；构造改 `accountPoolConfigured()` | `existsSync(defaultStorePath())` **永不 throw**；无池 → undefined = byte-compat；`resolveInfraNotifyIdentity` 同伴 gate 保留 ✓ |

**「未配置部署 boot 不炸」直接 boot-simulation（③ 硬要求）**：针对 built dist、未配置 env（QA-slot/sub/joycon 形状）跑 3 个 Type-C 解析函数 → **12/12 PASS**：`loadRoundtableConfig({})`→undefined 不 throw；CHANNEL_ID-set-无-token→fail-loud throw（同伴 gate 保留）；`parseCodexLeadRuntimeConfig(无parent)`→不 throw、replyInThread=undefined；`accountPoolConfigured()`→false 不 throw；`resolveAccountCapOwnerId({})`→undefined 不 throw；`makeAccountSwitchRepair({})` 构造不 throw。

## ④ detection_escalation 首次通电语义 + 与 FLY-1234 确认层互锁 ✅

本批即 detection_escalation 首次通电（生产原 UNSET）。**互锁结构原封不动，只删 on/off 门**：

- **INV-4 保留**（plugin.ts:5424 注释未变）：`onConfirmedStuck` 副作用只属**可疑 pipeline**；FLY-1234 heartbeat confirm 层的 routing **从不 notify**。
- **C4a 老/新流互斥**（stuck-escalation.ts `unifiedOwnsEpisode`）：删 `env.DETECTION_ESCALATION==="1" &&` 合取。固化后 unified 流常驻，老 stuck-detector 流靠 `unifiedOwnsEpisode`(active/clearing escalation row) 让位 → 不双重 paging。
- **detector 接线文件零 diff**：`stuck-runner-detector.ts` / `detection-detector-wiring.ts` / `detection-reconcile-tick.ts` / `stuck-remanage-routes.ts` 均**无改动** → 确认层 + 接线结构完整。
- escalation 由 **confirmed-stuck**（已过确认层）喂入 + **once-per-episode** durable-row 去重 + **CLEARING mute (C5)** → **不会被旧误报灌满**。

## ⑤ 11 个 flag 名零残留 env-gate ✅

- 生产 `packages/*/src`（排除 `__tests__`）里 11 个 env var 的**实际 `process.env` 读取 = 零**（精确 grep 排除注释/字符串）。剩余命中全是**注释**（记录退休事实）或运行时消息字符串。
- `registry.ts`：11 个 flag **零定义**；`runner_autocontinue` 仍在（line 1987/1991，含 canary 注释）。
- 计数 delta：注册表 envVar 数 98→87（删 11，精确）。

## ⑥ CI 核对 ✅

PR #588 head `c9aab973a`（未漂移）；`Build & Test` = SUCCESS，`FLY-1062 payload distribution` = SUCCESS；OPEN / MERGEABLE / CLEAN。

---

## Minor 观察（非阻塞，不影响 PASS）

1. **Type-C account_self_heal 消息措辞陈旧**：`account-switch-route.ts:182` / `rescue-route.ts:97` / `kind-contract.ts:77` 的运行时错误消息字符串仍写「account self-heal is disabled (FLYWHEEL_ACCOUNT_SELF_HEAL off)」，提到已退休的 flag 名。仅「未接线」byte-compat 路径的措辞陈旧，**无功能影响**。建议 follow-up 改为「account pool 未配置」。
2. **shell 测 hermetic 破绽**：`codex-lead-tui-home.test.sh` 的 `rt_marker_case` 用 `env "$@"`（不清继承环境）→ 生产 Bridge host 的 `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS` 泄漏进 "no resolvable parent" case，产生**假失败**（unset 该泄漏 var 后 7/7 marker cases 全绿）。CI（干净 env）不受影响。另有 14 个 sandbox/read-deny/daemon 失败为**既存**（base main 逐字相同，host codex binary 版本所致），非 PR 引入。建议 follow-up：harness 用 `env -i` 或显式 unset roundtable/cross-dept vars。

## 环境说明（诚实标注）

- host = 繁忙生产 Bridge 机（多 runner + Bridge + 真 codex binary + 生产 FLYWHEEL_* env）。全套件并发跑不可靠；本 QA 以**干净 build + clean TMPDIR + 隔离/scrub env** 复跑相关套件取得可信结论，并以 **base-main 对照** + **env-leak 外科式确认** 证伪所有表面失败。
- 所有 QA artifact 保留于 scratchpad（install/build/teamlead-test/shell/biome 日志 + bootsim.mjs + base-checkout 对照）。
