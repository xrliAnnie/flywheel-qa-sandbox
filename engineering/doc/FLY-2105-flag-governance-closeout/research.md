# FLY-2105 Flag 治理关门 — 调研
Issue: FLY-2105 (https://linear.app/geoforge3d/issue/FLY-2105/flagd关门-ci-守卫改判据env-configyaml-出现任何-flag-值即红legacy-unmanaged-baseline)
日期: 2026-08-30
基于: exploration.md

## 1. 基线与依赖状态

当前头的功能基线是 `origin/main@4ef016573`，本节点第一个 durable progress commit 为
`96cadae30`。安装 lockfile-pinned workspace dependencies 后，以下现有套件基线通过：

```text
pnpm --filter flywheel-config exec vitest run \
  src/__tests__/feature-flags-store-policy.test.ts \
  src/__tests__/feature-flags-drift.test.ts \
  src/__tests__/fly1981-final-ledgers.test.ts

Test Files 3 passed; Tests 46 passed; Duration 4.09s
```

这证明当前机制自洽，不证明关门要求已经满足：测试本身仍锁定 7 条 legacy baseline、两份
managed 集与 46 条 historical exemption ceiling。

## 2. registry ↔ store 的真实调用面

### 2.1 当前分区

| 账本 | 当前条数 | 实际语义 |
| --- | ---: | --- |
| `FEATURE_FLAGS` | 17 | 唯一产品名册；每条已有 `scope` 与 delegated wrapper |
| `STORE_MANAGED_FLAGS` | 10 | 目前同时被误作“全部纳管”和“global rows”两种语义 |
| `PROJECT_STORE_MANAGED_FLAGS` | 7 | FLY-2103 已接通的 project-scoped rows |
| `LEGACY_UNMANAGED_BASELINE` | 7 | 与上行同名，已经不是 live legacy |

因此不能只把 7 个名字复制进 `STORE_MANAGED_FLAGS`：

- `StateStore.ensureFlagValueRows()` 当前遍历 `STORE_MANAGED_FLAGS` 并要求每条有 `envVar`，
  再建立 `'*'` seed；若 set 变成全表而循环不按 scope 收窄，7 个 project flag 会启动失败。
- `StateStore.applyFlagValueChange()` 与 global route 也用 set membership 作写入准入；set 变全表后
  必须增加 `scope === "bridge_global"` 判据，不能让 project flag 走 global CAS API。
- `flag-store-runtime.readFlagValue()` 是 global-only reader；project wrapper 已经通过
  `readScopedBoolean()` 与 project subset 分流。
- `enrichFlagViewsWithStore()` 先判 project subset，再判 global set；只要保持这个顺序，all-set
  不会改变 project view。

最小安全收敛是：all-set 只表达“是否纳管”，所有运行路径以 registry `scope` 决定 global/project。
project subset 可由 scope 导出，避免作者再维护第三个事实源。

### 2.2 codec 合同

现有 `getFlagStoreCodec()` 有四类：default-on bool、opt-in bool、
`skill_framework_mode` enum、`summary_absorption_cadence_ms` 严格 value。现有测试已经覆盖
大部分 default/polarity，但遍历的是两个手写 managed 集的并集。关门后应直接遍历
`FEATURE_FLAGS`：

- unset parse 必须等于 registry `default`；
- bool 的 `default` 必须等于 `polarity === "default_on"`，显式 `0/1` 必须分别是
  false/true，canonical 必须区分两态；
- enum 每个 `enumValues` member 必须 round-trip，unsupported 回 registry default；
- value default 必须 canonical round-trip，非法 raw 必须 throw；
- 每条必须有 codec，不能因漏进某个手写 set 而跳过。

这直接覆盖 FLY-1455 B2′ 的 `qa_auto` polarity/codec 反向失效模式。

## 3. raw env guard

`drift-scan/index.ts` 已 AST 扫描 package production TS/JS/MJS 与 production shell，能识别：

- `process.env.FLYWHEEL_X` / `process.env["FLYWHEEL_X"]`；
- env-param 布尔比较、const-key/helper-key；
- shell boolean/presence/default/case。

`auditFlagAccounts()` 已对 store-managed env name 的 raw hit 报错，但保留了一个
`FLYWHEEL_SKILL_FRAMEWORK_MODE` compatibility read 特判。该 read 的真实形状是
`resolveSkillFrameworkMode({env})` 读取 synthetic env map；Blueprint 仍通过构造 map 复用旧 env
resolver。关门的最小重构是让 resolver 接受 store raw/control 值（或新增同文件的 raw-value
入口并由旧测试适配），随后删除特判；不能把另一个 allowlist 名字换上去。

RED 证据必须调用同一 `scanSources + auditFlagAccounts` 生产 guard helper，输入 synthetic
production source `process.env.FLYWHEEL_X === "1"` 并断言 raw read issue。这样证明的是 CI 判官，
不是单纯 `rg`。

## 4. tracked config.yaml guard

当前 guard 的 `enumerateBooleanConfigPaths()` 只看 `FlywheelConfig` TypeScript schema。FLY-2103
把 9 个 flag key 从类型/运行时读路删除后，schema 绿了，但跟踪样例仍可残留：

```text
doc/engineer/onboarding/tidal-echo/config.yaml
  checkpoints.brainstorm.enabled: true
  checkpoints.question.enabled: true
  doc_flow.enabled: true
```

`.flywheel/config.yaml` 已删除 flag values，仅保留 `doc_flow.default_department` 等非 flag
authoring 数据。

仓库已有 `yaml@2.7.1`，所以不加依赖。测试侧增加纯 helper：

1. 收集 tracked/worktree 内真正命名为 `config.yaml` 的 YAML（排除 node_modules/dist/测试生成
   temp）；
2. 用 `YAML.parse` 后枚举 dotted leaf paths；
3. 以 registry 历史 `configKey` + FLY-2103 明确退役 paths/patterns 为禁止集合；
4. 返回 `{file,path}`，解析错误 fail loud；
5. synthetic YAML 注入 `doc_flow.enabled` 先 RED；删 tidal-echo 三处真实残留后全表 GREEN。

`checkpoints.<name>.enabled` 是动态 segment，不能只靠字面 set；用受限 matcher
`/^checkpoints\.[^.]+\.enabled$/`。其它 FLY-2103 keys是精确 path：`pipeline.dag`、
`pipeline.work_kind`、`doc_flow.enabled`、`skills.proofshot.enabled`、
`xiaohongshu_learning.enabled`、`xiaohongshu_learning.collections[].auto_create`、
`ponytail.enabled`、`skill_framework.split`。历史 JSON/doc 文本不在 config runtime surface，
不扫。

## 5. exemption 账

当前 46 条 exemption 都有 live read，旧冻结账把“历史存在”误当“今天仍是真豁免”。结构缺口：

- 类型只有 `persistentEnvAllowed`，没有允许类别与退役条件；
- 18/12/10 条用 map + 同一句泛化 reason，无法逐条说明生命周期；
- 22 条允许持久生产 env，明显不是 issue 列举的 transient seam；
- `LEGACY_FLAG_EXEMPTION_BASELINE` 把历史 45 + founder reclassification 1 冻成永久最大账，
  不等于“只留真豁免”。

建议目标 shape：`kind: "env"` + `seam: "qa_isolation" | "dry_run" |
"one_time_migration"` + `persistentEnvAllowed: false` + 非空 `reason/owner/issue` +
非空 `retireWhen`。CI 断言 exact allowed categories、liveness、所有字段与 baseline 归零。

Lead 已在 question `382ec580-55c8-409b-a35b-72d2c3df6e5f` 裁定：22 条 persistent rows 默认
固化现值并删读点；只有同时满足 live consumer、行为必须保留、真实切换需求三项才迁 store；真豁免
严格限具名 QA 隔离/dry-run/一次性迁移。不确定项按删除处理。逐项复核后没有产品项满足 store
迁移三条件；20 项删除或改用既有非 flag 上下文，`FLYWHEEL_ELEVEN_AUTOSTART` 与
`FLYWHEEL_GEMINI_AUTOSTART` 两项作为 invocation-only QA seam 保留并补退役条件。exact 22 行证据与
处置见 `plan.md` §3.2。

## 6. FLY-2104 真扫描入口

已落地入口是 auth-required `POST /api/flag-scan/run`：

- body `{}` 调 `runNow()`，即使不在 Sunday slot 也新跑；
- `{dryRun:true}` 只预览，不能满足本单“真实扫描”；
- scanner disabled 返回 200/`disabled` 但零 run/effect，也不能冒充验收；
- clean run 返回 durable `runId`，candidate path 经 canonical `publish-report`，zero path发一行；
- 两者都只投 `FLYWHEEL_NOTIFY_CHANNEL`，identity 是 call-time
  `CLAUDE_INFRA_BOT_TOKEN + FLYWHEEL_NOTIFY_CHANNEL`；缺配置 fail loud，无 Core/Linear fallback。

本节点不会读取/打印 token。实际调用使用已运行 Bridge 的 loopback URL与已注入合法凭据；调用前
只读核 readiness，调用后以 response + durable DB/evidence + Discord notification 回读三者对齐。
如果 live Bridge 尚未部署 FLY-2104 或身份未配置，按 contract 向 Lead 报外部前置，不拿隔离
fixture 替代最后一条验收。

## 7. 预计改动面

- config governance：`store-policy.ts`、`exemptions.ts`、drift/store/final-ledger tests。
- scope-sensitive consumers：`StateStore.ts`、`flag-store-runtime.ts`、flag route tests。
- raw compatibility：`skill-framework-mode.ts`、Blueprint adapter与就近测试（仅在删除特判所需范围）。
- config residue：test-side scanner helper、tidal-echo onboarding sample。
- authoring docs：`flag-authoring-runbook.md`。
- 不改 scan candidate/notification production code；只真实调用已存在入口并沉淀证据。
