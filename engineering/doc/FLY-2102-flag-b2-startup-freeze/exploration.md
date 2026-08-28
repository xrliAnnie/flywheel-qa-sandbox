# FLY-2102 flag·B2 启动期 flag 固化删 — 探索

Issue: FLY-2102 (https://linear.app/geoforge3d/issue/FLY-2102/flagb2固化-9-个启动cli-时读的-env-flag-固化删flag-store-写死常开删-env-旁路cmux-三个-ghost)
日期: 2026-08-27
基于: 无

## 1. 任务是什么

founder 8-27 v3/v4 裁定:9 个「启动/CLI 时读」的 env flag **都不迁 DB**,直接固化删。
这是 flag 治理三批中的 Batch 1(B1 = 13 个运行时读的不动;C = config.yaml 不动)。
本单吸收 FLY-1977(其 6 处 frozen 读点全部落在本单删除范围内,不再做 call-time 手术)。

## 2. 九个 flag 的现场审计(逐个读了生产读点)

| # | flag | env var | 读点 | 现状 | 裁定 |
|---|------|---------|------|------|------|
| 1 | flag_store | FLYWHEEL_FLAG_STORE | `flag-store-runtime.ts:19` `initializeFlagStore` (bridge_boot) | =0 时整个 SQLite flag store 旁路回 legacy .env(`mode:"bypass"`),并写 `flag_store_meta.bypass_seen` fence,下次回 store 模式时走 `ensureFlagValueRows` 的 bypass_recovery 重播 | 删旋钮,store 写死常开;**旁路 + fence + recovery 整族删** |
| 2 | ghost_guard_wait_ms | FLYWHEEL_GHOST_GUARD_WAIT_MS | `runs-route.ts:238` `GHOST_GUARD_SESSION_WAIT_MS`(bridge_boot,`positiveInt` fallback 90_000) | 纯数值旋钮,生产从未设置 | 写死 90000 |
| 3 | publish_broker | FLYWHEEL_PUBLISH_BROKER | `publish-broker/wire.ts:78`(bridge_boot);plugin.ts:4306 挂载、10871 close | 默认关,生产从未启用;真实 npm 发布走 GitHub Actions `payload-activation.yml` | **整段删**(细节见 §4) |
| 4 | converge_cmux_symlink | FLYWHEEL_CONVERGE_CMUX_SYMLINK | `converge-flywheel-bin.sh:318`(cli_invocation) | =0 暂停 cmux 形态收敛;非法值已 fail-safe 回 1 | 写死开 |
| 5 | cmux_view_helper | FLYWHEEL_CMUX_VIEW_HELPER | `flywheel-cmux-sync.sh:3767` `build_attach_command` | =0 走旧的一次性 `tmux attach` 命令(3775-3783) | 写死开,**删 =0 旧行为路** |
| 6 | cmux_node_presence | FLYWHEEL_CMUX_NODE_PRESENCE | `flywheel-cmux-sync.sh:1091` `node_presence_enabled()`(12 处调用) | =0 冻结 node: 表面 | 写死开 |
| 7 | issue_display_sweep_ticks | FLYWHEEL_ISSUE_DISPLAY_SWEEP_TICKS | `plugin.ts:8758`(object_construction)→ GatePoller `displayReconcileEveryNTicks`(默认 60,`0=关` 在 gate-poller.ts:731 `displayCadence > 0`) | 数值旋钮 + 0=关 双语义 | 写死 60;删 0=关 路 |
| 8 | voice_qa_presence_override | FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE | `voice-bridge/assistant/wiring.ts:135`(object_construction;armed 时非 loopback staged Bridge 直接拒启) | FLY-1353 headless 语音 E2E 治具**仍在用**:`e2e/gemini-staged.mjs:87`、`e2e/gemini-voice-loop.mjs:116` 都在置位;最近一次相关 commit #828 是重构不是废弃 | 不当 flag:**移入 exemptions.ts 有账豁免**(QA seam,注明只允许 loopback staged Bridge);读点保留 |
| 9 | lead_lease_bypass | FLYWHEEL_LEAD_LEASE_BYPASS | `flywheel-comm/lead-lease.ts:2806` `denyOrAudit`(cli_invocation) | =1 绕过 Lead identity lease 写授权(强告警+审计) | 删 flag + 绕过分支(founder 8-22「不应有全局 Hard Gate 阀」) |

**生产 .env 实测(2026-08-27,`~/.flywheel/.env`)**:九个 env var 全部 absent,`FW_CUSTOMER_RELEASE_TOKEN` / `FW_NPM_GAT_TOKEN` / `FLYWHEEL_PUBLISH_APPROVAL_CHANNEL` 也 absent。
⇒ 固化默认值对当前生产是**零行为变化**;唯一被删除的能力是「未来想关时不再有 env 开关」——这正是 founder 裁定要的效果。

## 3. 发现的三个非平凡点(设计必须显式裁)

### 3.1 publish broker 的 token scrub 是 flag 之外的副作用
`wirePublishBroker` **无论 flag 开关**都先执行 `readAndScrubPublishTokens`:从 process.env 删掉
`FW_CUSTOMER_RELEASE_TOKEN` / `FW_NPM_GAT_TOKEN`,防止任何子进程继承(wire.ts:37-49)。
整段删 broker ⇒ scrub 一起消失。裁定考量:
- 这两个 token 的正身在 GitHub Actions secrets + payload-endpoint worker env,**不在 Bridge 机器**;
- 生产 .env 实测两个 token 都不存在;
- runbook 红线本来就写「永不落 ~/.flywheel/.env」。
⇒ 倾向**随 broker 一起删**(不留孤儿 scrub),把「这两个 token 永不进 Bridge env」记入 runbook 退役横幅 + 本设计的 honest boundary。备选(被拒):在 plugin.ts 留 5 行裸 scrub —— 违背「只删不加」,且保护的是一个已不存在的注入路径。

### 3.2 exemptions.ts 的 baseline 是「冻结账本」
`validateFlagAuthoringPolicy` 断言 FLAG_EXEMPTIONS 冻结:新 `kind:name` 必须同时进
`LEGACY_FLAG_EXEMPTION_BASELINE` 才不炸。把 voice_qa_presence_override 移入豁免 ⇒
**必须修改这个「immutable maximum ledger」**。正当性:这不是新增野旋钮,是 founder 裁定把一个
已登记名字从 registry 账本挪到 exemptions 账本,治理总面净缩(registry -9,exemptions +1)。

### 3.3 lead_lease_bypass 的告警族只删生产者
`lead_lease_bypass_used` 告警 kind 有一整族消费者(kind-contract / alert-kind-copy /
lead-dual-active-scan / LeadAlertNotifier / lead-alert.sh)。其中 lead-dual-active-scan 的
lease-audit outbox 读的是**耐久 DB 里的历史 fault 行**(`auditEventType("bypass_used")`)——
历史上可能存在已落库的 bypass_used episode。⇒ 只删**生产者**(denyOrAudit 的 bypass 分支 +
disposition union 的 `"bypass"` 臂),历史 episode 的渲染管线保留(append-only 史料不许因为
生产者死了就变不可读)。

## 4. publish_broker 整段删的完整清单(消费者 sweep)

**删**:
- `packages/teamlead/src/bridge/publish-broker/`(10 个生产文件 + 4 个测试)
- plugin.ts:448 import、4299-4319 挂载块、10871 close
- `scripts/__tests__/publish-broker-structure.test.sh` + ci.yml:975 的 CI 步骤
- `scripts/release/broker-request.mjs`(纯 broker socket 客户端,无 broker 即死代码;issue 未点名但属「broker 代码」)
- registry.ts publish_broker 条目;truth.ts NON_FLAG_ALLOWLIST 三行 broker 专属 plumbing:
  `FLYWHEEL_PUBLISH_BROKER_SOCKET` / `FLYWHEEL_PUBLISH_AUDIT_PATH` / `FLYWHEEL_PUBLISH_APPROVAL_CHANNEL`(读点全在 broker 内)

**留(改注释/横幅)**:
- `scripts/release/shell-publish-preflight.sh` —— payload-activation.yml:266 在用;只删 :59 的 broker 注释引用
- `scripts/release/shell-prepare.mjs` —— `shell-pack-install-dryrun.test.sh` P2 与 `onboard-shell-publish-gate.test.sh` 在用(founder-direct 打包/staging 面);删其注释里的 broker 叙述
- `scripts/release/payload-promote.mjs` :350-353 的 broker 注释 —— 改述
- `packages/teamlead/src/bridge/__tests__/automated-message-inventory.test.ts`:140 与
  `scripts/__tests__/flywheel-log-rotate.test.sh`:187 各有一行指向 wire.ts 的清单条目 —— 随删同步
- `doc/engineer/implementation/fly-1062-payload-release-runbook.md` —— 加「RETIRED by FLY-2102」横幅(broker 路径已删;真发布走 payload-activation.yml),不删文件
- `FLYWHEEL_FLEET_SANITIZE` 留在 allowlist(fleet-capture / buddy / package-onboard 多处在用,非 broker 专属)
- `FW_ENDPOINT` / `FW_NPM_REGISTRY` / 两个 FW token —— GitHub Actions + payload-endpoint 的正身用法,不动

## 5. 治理面同步清单

- `registry.ts`:删 9 个 spec
- `truth.ts` RETIRED_FLAGS:**+8 tombstone**(retiredBy: "FLY-2102";voice 不 tombstone,走豁免)
- `exemptions.ts`:+1 条 FLYWHEEL_VOICE_QA_PRESENCE_OVERRIDE(kind env,persistentEnvAllowed: false,issue FLY-2102)+ baseline +1
- `store-policy.ts` LEGACY_UNMANAGED_BASELINE:-9(注释明说 entries may retire)
- drift 守卫 fixture `feature-flags-drift.test.ts`:删 3 个 cmux 条目(:469-471)
- 测试 fixture 换血:`feature-flags-registry.test.ts`(lead_lease_bypass / voice 两个断言组)、
  `flag-toggle.test.ts`、`flag-routes.test.ts`、`feature-flag-render.test.ts`、
  `fleet-console-model-flags.test.ts`、`StateStore.flag-value-store.test.ts`、
  `flag-store-runtime.test.ts`(bypass 用例)、`runs-route.dag-entry.test.ts`(ghost guard)、
  `lead-lease-enforce.test.ts`(bypass 用例)、shell 侧 fly1884/fly1944/converge/test-cmux-sync

## 6. 验收判据里的一个词面冲突(先量了)

验收写「`rg` 九个 env 名零命中」。但机制上 tombstone(truth.ts)与豁免账(exemptions.ts)
**必须保留 env 名**才能工作(.env 里出现旧名要能报「已退役假开关,删这行」),voice 治具也
继续置位它的 var。⇒ 字面零命中与本仓的退役机制互斥。这是词面冲突不是实质冲突:issue 要的
效果是「无生产读点、无旋钮语义」。plan 将把验收 sweep 精确化为:**零命中 = 排除
truth.ts RETIRED_FLAGS、exemptions.ts、voice e2e 治具 + wiring 读点(裁定保留)、
engineering/doc·product/doc 历史证据后,rg 全仓零命中**,并逐条列出预期残留。

## 7. 不做

- B1 的 13 个运行时读 flag、config.yaml(C 批)、任何新旋钮
- lead_lease_bypass_used 告警 kind 的历史渲染管线(§3.3)
- shell-publish-preflight / shell-prepare / payload-promote 的功能性改动(只动注释)
- StateStore `flag_store_meta` 表结构(留表,删读写方法;老库残留 bypass_seen=1 无消费者,无害)
