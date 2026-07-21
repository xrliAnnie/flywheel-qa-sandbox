# FLY-1402 lead-rules bundle 拼接单文件修复 — 调研

Issue: FLY-1402 (https://linear.app/geoforge3d/issue/FLY-1402/p1装载链-lead-rules-bundle-全-fleet-静默失效-cli-append-system-prompt-file-为)
日期: 2026-07-21
基于: exploration.md

Brainstorm gate 已过(Tadashi 批准方案 A + 三项裁定:external 统一走 bundle;逃生阀留但 fail-loud;canary = 默认 ON + 首班车除 Cass 外显式 legacy)。本文回答实现所需的全部技术事实。

## 1. 病灶精确清单:claude-lead.sh 的 24 个 append 位点

全部在 `packages/teamlead/scripts/claude-lead.sh`(行号为当前 HEAD cb97e7309):

| 行 | 变量 | 条件 |
|---|---|---|
| 2093 | INBOX_ACK_RULE | INBOX_MCP_ENABLED=true |
| 2166 | BASE_EXTERNAL_CONTRACT | external 臂(缺失 fail-STOP) |
| 2184 | BASE_COMPANION_SAFETY | companion 臂(缺失 fail-STOP) |
| 2201 | BASE_DEPT_RULES | dept 臂 |
| 2224 | BASE_RUNNER_MSG_RULES | dept 臂 ∧ backend≠commdb |
| 2242 | BASE_EXECUTOR_ROUTING_RULES | dept 臂 |
| 2254 | BASE_MODEL_ROUTING_RULES | dept 臂 |
| 2267 | BASE_STUCK_REMANAGE_RULES | dept 臂 |
| 2278 | BASE_REENGAGE_RULES | dept 臂 |
| 2293 | BASE_PATROL_RULES | dept 臂 |
| 2306 | BASE_DOC_FLOW_RULES | dept 臂 |
| 2318 | BASE_AUTO_QA_RULES | dept 臂 |
| 2331 | BASE_DEFAULT_ENABLE_RULES | dept 臂 |
| 2347 | BASE_XHS_MEMORY_RULES | dept 臂 |
| 2354 | BASE_COS_RULES | cos 臂 |
| 2363 | BASE_FOUNDER_LOCAL_TIME_RULES | 非 external |
| 2377 | BASE_FOUNDER_AUTH_RULES | 非 companion ∧ 非 external |
| 2423 | BASE_FOUNDER_UX_RULES | 非 companion/external ∧ FLYWHEEL_FOUNDER_UX_GATE_ENABLED=1 ∧ mode≠off |
| 2436 | BASE_HTML_DELIVERY_RULES | 非 companion ∧ 非 external |
| 2452 | BASE_CROSS_DEPT_RULES | 非 external |
| 2468 | BASE_DISCORD_REPLY_CONTRACT | 非 external |
| 2484 | COMMON_RULES(项目层) | 非 external ∧ LEAD_RULES_DIR 存在(缺文件 fail-STOP) |
| 2498 | DEPT_RULES(项目层) | 同上 ∧ dept 臂(缺文件 fail-STOP) |
| 2525 | SCREENCAP_SKILL | 非 companion/external ∧ 未禁用 |

此后到 `_launch_claude` 调用(dry-run 2658 / 生产 supervisor loop)之间**再无**该 flag 的追加(已 grep 全文核实);FLYWHEEL_AGENT_TEAM_ARGS 只带 identity flags(--agent-id 等),`_launch_claude` 只补 --session-id/--model/--effort。⇒ 收集点可以放在 2525 之后、FLY-142 transport 合并(≈2536)之前,一处 materialize。

## 2. 不受影响调用面(结论复核)

- **Runner**:`TmuxAdapter.ts:808-833` — 整个 prompt 写单文件传单 flag(FLY-154),0600/0700 权限,是本修复的直接先例。
- **Codex Lead**:`codex-lead-runtime.ts:627-630` split CSV → 逐文件读 → 拼接为一份 baseInstructions(启动横幅印 "baseInstructions N chars from M file(s)")。**不经 CLI flag,天然正确**。⇒ lead-rules-bundle.sh 的 `compute_lead_rule_bundle` / `assemble_full_access_governance` 语义不动。
- voice-core 双 Brain、`scripts/lib/agent-cli-providers/claude.sh`、Antigravity/Kimi adapter:单文件或不用该 flag。

## 3. 复用件:lead-rules-bundle.sh + parity 测试

- `compute_lead_rule_bundle <role> <base> <backend> <required>`:纯函数,stdout 逐行输出有序路径 — **不改**(codex 消费方语义冻结)。
- 新 materializer 放进**同一文件**(它已是「Lead 规则装载」的共享库,claude-lead.sh 新增 `source` 即可,codex-lead.sh 已 source 不受影响 — 函数只定义不执行)。
- `lead-rules-bundle.test.ts` parity 锚点是 `BASE_X="${BASE_RULES_DIR}/file.md"` **路径赋值行**(`/${f}"` 形式)与 commdb 守卫正则 `/commdb[\s\S]{0,400}runner-messaging-rules\.md/` — 路径赋值与守卫块本次都不动,只动 `CLAUDE_ARGS+=` 那一行 ⇒ parity 测试预计零改动(实现时跑一遍确认)。

## 4. Bundle 体积实测

dept 全集(inbox-ack + BASE dept 13 份 + 通用 5 份 + screencap,不含 env-gated founder-ux、不含项目层):**约 143 KB**;cos 全集约 72 KB;companion 约 15.6 KB;external 约 4 KB。加分节头/哨兵头 <2 KB。单文件 143 KB 远低于 CLI 文件读取的实际限制(Runner 路径常年传 6KB-100KB+ 无恙);上下文成本 ≈ 36k tokens(dept),是规则本应占用的应然成本。

## 5. 关键机制事实

### 5.1 dry-run 测试通道
`FLYWHEEL_LEAD_DRY_RUN=1` 下 launcher 在隔离 HOME 里走完整个 Layer 1 装配后经 `_emit_launch_plan` 输出 `LAUNCH_PLAN_BEGIN … ARG\t<v> … LAUNCH_PLAN_END` 即退出(claude-lead.sh:1255-1292, 2656-2660)。⇒ bundle 在 dry-run 也照常落盘(落在隔离 HOME 下),测试从 ARG 行取 bundle 路径再断言文件内容 — 现有 fly231/fly879 测试骨架直接复用。

### 5.2 SHA 工具
macOS 自带 `shasum -a 256`(perl core),Linux CI 有 `sha256sum`。materializer 依次探测两者;都缺时 fail-loud 降级(哨兵行写 `RULES_BUNDLE_SHA=unavailable`,log WARNING)— 不因校验工具缺失阻断 Lead 启动(可用性优先,与 legacy 阀同哲学)。

### 5.3 告警通道(legacy fail-loud)
`scripts/lead-alert.sh` 有 `--kind` 白名单(FLY-879 已有加新 kind 先例:external_config_error)。legacy 模式告警需新增 kind `rules_bundle_legacy`(severity warn),best-effort `|| true`(告警失败不阻断启动,同 `_companion_failstop_alert` 模式)。

### 5.4 逃生阀 env 的注入路径
per-Lead env 由 launchd plist `EnvironmentVariables`(经 wrapper)携带 — 与已有 `FLYWHEEL_LEAD_ROLE=cos` 手工补法相同。canary 首班车操作 = 给目标 Lead 的 plist 加 `FLYWHEEL_LEAD_RULES_BUNDLE=legacy`(重启通报逐个列名);soak 后撤掉再统一重启。代码不需要感知 canary,只认 env。

### 5.5 现有测试面盘点(7 个受影响 + CI 事实)
CI(ci.yml)只显式跑 3 个 teamlead shell 测试(adapter-reap / claude-lead-resume-recovery / fly-513-repoint),**受影响的 7 个都不在 CI**,是本地/开发期测试;vitest(`pnpm -r test`)跑 lead-rules-bundle.test.ts。

| 测试 | 断言方式 | 迁移动作 |
|---|---|---|
| `__tests__/fly231-companion-launch-plan.test.sh` | dry-run LAUNCH_PLAN 里 awk 提取 flag 后跟的 basename 列表 | 提取唯一 bundle 路径 → 断言 bundle 内容含/不含各分节 |
| `__tests__/fly879-external-launch-plan.test.sh` | 同上(external) | 同上 |
| `__tests__/screencap-skill-gate.test.sh` | 输出串含/不含 `--append-system-prompt-file`+skill 路径 | 改为 bundle 内容含/不含 screencap 分节(flag 恒在) |
| `__tests__/rollback-args-gate.test.sh` | 内联模拟 CLAUDE_ARGS 构造 | 模拟段同步为新收集模式(或断言 bundle 清单) |
| `__tests__/decommission-legacy-companion-daemon.test.sh` | flag 出现在 fixture 假脚本文本里 | 大概率零改动(fixture 非断言) |
| `test-fly26-rules-split.sh` | Group 3 内联模拟 append 逻辑 | 模拟段同步 |
| `test-fly205-doc-flow-lead.sh` | grep claude-lead.sh 源码:`BASE_DOC_FLOW_RULES=` 3 行内跟 flag | 改 grep 目标为新收集调用 |

新增回归测试进 **vitest**(CI 自动覆盖):加在 lead-rules-bundle.test.ts 或新 spec,shell-out 跑 materializer(与现有 runBundle harness 同模式)。另加一个 launcher 级 dry-run 断言(argv 恰一个该 flag)并**挂进 ci.yml**——这是防复发的机器闸。

### 5.6 角色臂检测现状(供 check-rules-truth 用)
`IS_COS_ROLE` = `FLYWHEEL_LEAD_ROLE=cos` ∨ `LEAD_ID="cos-lead"`(claude-lead.sh:2132-2135)。flywheel-cos-lead 三个 CoS 的 plist 已由 Tadashi 手工补 `FLYWHEEL_LEAD_ROLE=cos`(gate 回复确认),搭下次重启生效。check-rules-truth 的角色臂不变量以后自动暴露此类错配。

### 5.7 「Appending …」log 行
多个测试与运维习惯 grep 这些 log 行。**保留每条 log 原文**(bundle 模式下仍逐条打印),额外加一条 summary log(`Rules bundle: N files → <path> (sha <8位>)`)。最小化测试与肌肉记忆churn。

## 6. 设计输入汇总(→ plan)

1. materializer 三函数进 lead-rules-bundle.sh:`rules_bundle_reset` / `rules_bundle_add <path> <layer-label>` / `rules_bundle_materialize <out> <role> <lead> <project>`(纯 bash 3.2 兼容,原子写 temp+mv)。
2. claude-lead.sh:24 处 `CLAUDE_ARGS+=(--append-system-prompt-file X)` → `rules_bundle_add X <label>`;screencap 块后统一 materialize + 单 flag;legacy 阀在 `rules_bundle_add` 内直通旧行为。
3. 哨兵头格式(exploration §3 定稿)+ 探针指令行。
4. check-rules-truth.sh:静态(SHA/FILES/manifest/角色臂)+ 动态(活进程 argv 恰一个 flag 指向 bundle)。
5. 测试:vitest 材料化回归(两哨兵串)+ launcher dry-run 单 flag 断言(进 ci.yml)+ 7 个存量测试迁移。
6. 运维:legacy fail-loud(log + lead-alert kind `rules_bundle_legacy`);canary 两班次写成可执行步骤;重启后哨兵探针 runbook(dept 阳性 + Cass cos 阴性对照)。
