# FLY-1455 flag 漂移守卫回填台账 — 实施记录

Issue: FLY-1455 (https://linear.app/geoforge3d/issue/FLY-1455/flag治理登记强制第1批-不许野建-flag-漂移守卫补洞b0a-扩全-package-b0b-astschema-豁免登记-b2-登记)
日期: 2026-08-16
基于: plan.md

## 裁决口径

2026-08-16 向 `flywheel-eng-lead` 确认后采用以下切分:

- gate:控制开/关行为或选择 pipeline 路径,必须进 registry 或带理由、归属进 exemption。
- non-flag:值、上下文、plumbing、单次调用选项、founder preference / consent；不得进入退役扫描。
- `skills.proofshot.vision_default` 是 preference；`xiaohongshu_learning.video_opt_in` 是 consent。
- `pipeline.work_kind` 是行为开关,必须登记。

## 首次全量扫描结果

| 面 | 首次待裁决 | 归宿 | 结果 |
|---|---:|---|---|
| 全部生产 package root 负排除 + 根级生产 scripts 的首次待裁决 env 名 | 271 | `NON_FLAG_ALLOWLIST` 232；`FLAG_EXEMPTIONS` 39 | 0 个未处理 |
| `FlywheelConfig` boolean path | 14 | registry 11；`NON_FLAG_CONFIG_KEYS` 3 | 0 个未处理 |

env 的首轮 228 个 non-flag 名逐名固定在 `truth.ts` 的 `FLY1455_NON_FLAG_ENV` 常量中，并由同文件的 `Object.fromEntries` 一对一映射到 `NON_FLAG_ALLOWLIST`。每个名字的目的地与理由相同：

> FLY-1455 full-surface census: runtime value/context/plumbing or per-invocation choice, not a persistent on/off gate

这里不再复制第二份 228 行清单，避免台账与机器断言漂移；上述显式常量就是逐名可审计清单，新名字不会被 pattern 或前缀自动放行。

QA rework 扩到 package root 后新增 4 个 non-flag，因语义不同而在 `NON_FLAG_ALLOWLIST` 逐名写具体理由：

- `FLYWHEEL_LICENSE_KEY`：onboarding license secret value。
- `FLYWHEEL_ONBOARD_ENDPOINT`：onboarding service endpoint config value。
- `FLYWHEEL_AGENT_TEAM_ARGS`：`agent-team-transport` 产出的 eval-safe shell argv array。
- `FLYWHEEL_LEAD_CARRIER_START`：Lead carrier process-start identity/context；它由新增的 `cmd && [...]` shell 形态识别。

QA 预查曾列出 `FLYWHEEL_TEAMS_DIR`，但权威 AST 真扫证明它只存在于 `grep-gate.ts` 的禁止规则字符串，不是 runtime read；该名字继续由专用 ban gate 拦截，不写进 non-flag 账。真扫第五个新增名字是上面的 `FLYWHEEL_LEAD_CARRIER_START`。

## env exemption 回填（39）

下列名字都是真 gate，但按用途刻意不进入可切换 registry。每条在 `exemptions.ts` 都有 `owner: flywheel-eng-lead`、`issue: FLY-1455`，并由 CI 检查理由/归属非空、无重复、无跨账重叠、无 stale 条目。

### QA / fault-injection / 单次调用接缝（17）

理由：QA/fault-injection 或单次调用接缝，不是持久运行时 flag。
这组逐条标记 `persistentEnvAllowed: false`；命令级临时注入仍可使用，但进入持久环境文件会由 truth validator 拒绝。

- `FLYWHEEL_ALLOW_LICENSE_KEY_ENV`
- `FLYWHEEL_BUDDY_ALLOW_ANSWER_INJECTION`
- `FLYWHEEL_BUDDY_DEMO`
- `FLYWHEEL_BUDDY_PREVIEW_DRY_RUN`
- `FLYWHEEL_BUDDY_PREVIEW_LIVE`
- `FLYWHEEL_CLAUDE_FRESHNESS_BYPASS`
- `FLYWHEEL_CLAUDE_QUOTA_BYPASS`
- `FLYWHEEL_CMUX_DRY_RUN`
- `FLYWHEEL_CMUX_INSTALL_SKIP_LAUNCHCTL`
- `FLYWHEEL_CMUX_PROCESS_INCARNATION_OVERRIDE`
- `FLYWHEEL_CMUX_TEST_ALLOW_MODERN_BASH`
- `FLYWHEEL_DISCORD_CUTOVER_TEST_SEAMS`
- `FLYWHEEL_LEAD_V2_DRY_RUN`
- `FLYWHEEL_LEAD_V2_TEST_MODE`
- `FLYWHEEL_PROFILE_IDENTITY_BYPASS`
- `FLYWHEEL_QUOTA_E2E_KEEP`
- `FLYWHEEL_SKIP_AGENT_TEAM_PREFLIGHT`

### 底层安全 / 修复接缝（12）

理由：底层安全或恢复接缝，不开放到对话式 flag surface。
这组逐条标记 `persistentEnvAllowed: true`，允许由运维持久配置。

- `FLYWHEEL_CMUX_ORPHAN_REAPER`
- `FLYWHEEL_CMUX_REOPEN_SWEEP`
- `FLYWHEEL_CMUX_RESTORED_ADOPTION`
- `FLYWHEEL_CMUX_STOCK_ADOPTION`
- `FLYWHEEL_CODEX_HEALTH_GUARD`
- `FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT`
- `FLYWHEEL_DAEMON_SKIP_PS_SELF_PROBE`
- `FLYWHEEL_DISABLE_MAILBOX_SENTINEL`
- `FLYWHEEL_FOUNDER_APPROVAL_ACK`
- `FLYWHEEL_LEAD_CTX_RESUME_GATE`
- `FLYWHEEL_MERGED_GATE_GUARD`
- `FLYWHEEL_TURN_BELT_MERGED_RECLAIM`

### 辅助进程 gate（10）

理由：gate 由辅助进程拥有，Bridge registry 无法安全切换。
这组逐条标记 `persistentEnvAllowed: true`，允许由所属辅助进程持久配置。

- `FLYWHEEL_ELEVEN_AUTOSTART`
- `FLYWHEEL_GEMINI_AGENT`
- `FLYWHEEL_GEMINI_AUTOSTART`
- `FLYWHEEL_HEADPHONE_INCLUDE_ROUNDTABLE`
- `FLYWHEEL_HUDDLE_EARCON`
- `FLYWHEEL_HUDDLE_FILLER`
- `FLYWHEEL_RUNNER_SLIM_MCP`
- `FLYWHEEL_TUI_WINDOW_ALERT`
- `FLYWHEEL_VOICE_APPROVAL`
- `FLYWHEEL_VOICE_EDGE_TTS`

## project config boolean 回填（14）

| config path | 去处 | 一句话理由 |
|---|---|---|
| `checkpoints.*.enabled` | registry: `checkpoint_enabled` | checkpoint 行为开关；只补登记，不改变 `question` 或其他 checkpoint 行为 |
| `doc_flow.enabled` | registry: `doc_flow` | project doc-flow 开关 |
| `founder_milestone_report.enabled` | registry: `founder_milestone_report_enabled` | founder milestone report 开关 |
| `pipeline.dag` | registry: `pipeline_dag` | DAG dispatch enrollment 开关 |
| `pipeline.work_kind` | registry: `pipeline_work_kind` | dispatch work-kind enforcement 开关 |
| `ponytail.enabled` | registry: `ponytail` | project rollout gate（现存 dormant 语义不变） |
| `qa.auto` | registry: `qa_auto` | auto-QA pipeline 开关 |
| `skill_framework.split` | registry: `skill_framework_split_participation` | split 实验参与开关 |
| `skills.enabled` | `NON_FLAG_CONFIG_KEYS` | dormant legacy schema 字段，无 runtime consumer，当前没有可被切换的行为 |
| `skills.proofshot.enabled` | registry: `proofshot` | ProofShot auto-trigger 开关 |
| `skills.proofshot.vision_default` | `NON_FLAG_CONFIG_KEYS` | founder preference，可被 per-run label 覆盖，不进入退役扫描 |
| `xiaohongshu_learning.collections[].auto_create` | registry: `xiaohongshu_auto_create` | collection 自动建单行为开关 |
| `xiaohongshu_learning.enabled` | registry: `xiaohongshu_learning` | learning pipeline 开关 |
| `xiaohongshu_learning.video_opt_in` | `NON_FLAG_CONFIG_KEYS` | 向 Gemini 发送视频的显式 consent，不得被推断、退役或清理 |

## 明确未做

- 没有新增创建时退役条件或 `longTermKeep` 强制。
- 没有自动创建清理单，也没有 adoption/grandfather/tombstone/digest/partition scaffolding。
- 没有改变 `question` checkpoint 行为。

## R2 review advisory 处置

### 本 PR 已关闭

- transient QA exemption 不再能绕过持久环境 truth validation；`persistentEnvAllowed` 是显式、类型约束的权限位，未获准的 env exemption 会 fail closed。
- forward scan 不再按普通目录名跳过 `test`、`tests`、`fixtures`；package root 只负排除明确的 `__tests__`、`__mocks__`、`dist`、`node_modules`、`coverage`、`e2e`、`test-scripts`、`examples`，并继续按 `*.test.*` / `*.spec.*` 文件名排除测试文件。
- R4 review 发现 whole-package walk 会把 `vitest.config/setup.*` 与 `test/setup|fixtures.*` 当生产证据；现按精确文件形态排除这些已知 test infrastructure，同时 fixture 证明普通 `src/tests/helper.ts`、`src/fixtures/gate.ts` 仍在扫描面，不能给 stale exemption 留假保活口。

### 后续项（不阻塞 FLY-1455）

- wildcard config 在各 project 值不一致时 resolver 已 fail loud 并返回逐 project 错误；当前 founder UI 仍复用 config-error badge。若要显示独立 `mixed` 状态及逐实例摘要，需要新的 API/UI 状态设计，留给后续单。
- `feature-flags-drift.test.ts` 中“drift tooling test-only”的测试名同时断言 production export 不含 `exemptions`，措辞范围比实际断言宽；本单不改行为，后续可只收窄测试名/断言说明。
- config schema 枚举只审计 boolean path 是本单 B0b 的既定边界，目前该前提隐含在实现中；若未来登记其他类型 gate，应先扩展枚举契约。
- 38 条 exemption 目前按三类共享理由；机器断言保证逐名、owner、issue 和 stale/overlap 完整性，但更细粒度业务理由需要 owner 后续逐条补录。
- `process.env` / `env-param` read-site 的 prose symbol 仍有少量历史语义残留；本单 forward guard 已以 AST 实际读点为准，reverse evidence 文案清理留后续。
