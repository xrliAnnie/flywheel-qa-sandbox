# FLY-2105 Flag 治理关门 — 探索
Issue: FLY-2105 (https://linear.app/geoforge3d/issue/FLY-2105/flagd关门-ci-守卫改判据env-configyaml-出现任何-flag-值即红legacy-unmanaged-baseline)
日期: 2026-08-30
基于: 无

## 1. 任务边界

本单是 Batch 3 关门，不再发明第三种 flag 路径。依赖已经落在当前
`origin/main`：FLY-2100 提供逐项目 store scope，FLY-2101/2102 固化删除旧 env
开关，FLY-2103 把项目 flag 消费点切到 scoped SQLite，FLY-2104 修好真实手动周扫
与 `#flywheel-notification` 投递。

要把四件事变成可执行不变量：

1. 生产代码新增 `process.env.FLYWHEEL_*` 布尔/枚举读点直接失败；仓库内任意
   `config.yaml` 再出现已迁移/退役的 flag key 直接失败。
2. `LEGACY_UNMANAGED_BASELINE` 为空且不能再长；每个 registry spec 都属于
   `STORE_MANAGED_FLAGS`，scope 只决定全局行还是逐项目行，不再决定是否纳管。
3. registry 的 `default` / `polarity` / `valueKind` 与 store codec 逐条对账，避免
   `qa_auto` 一类“名册与解析方向相反”的复发。
4. 实跑 FLY-2104 的 `POST /api/flag-scan/run`，以通知频道中的真实消息证明零候选
   （或如实列出候选），不拿 mock 或本地 renderer 代替。

## 2. 当前树的事实

- `FEATURE_FLAGS` 有 17 条：10 条 bridge-global，7 条 project scope。
- `STORE_MANAGED_FLAGS` 只有 10 条；另有一份 7 条的
  `PROJECT_STORE_MANAGED_FLAGS`，两份重复表达“是否纳管”。
- `LEGACY_UNMANAGED_BASELINE` 仍列那 7 个 project flag，尽管它们已经由
  FLY-2103 store wrapper 消费，因此“legacy”账与运行时真相相反。
- 现有 codec 对照测试同时遍历 global/project 两个集合，但 CI 没有直接断言
  `STORE_MANAGED_FLAGS.size === FEATURE_FLAGS.length`。
- drift guard 已能拒绝大多数 store flag 的 raw env 读，但仍保留一个
  `skill_framework_mode` compatibility 特例；它也只枚举 TypeScript config schema，
  不扫描已跟踪的 `config.yaml` 文件。
- `doc/engineer/onboarding/tidal-echo/config.yaml` 仍有
  `checkpoints.*.enabled` 与 `doc_flow.enabled`，正是 FLY-2103 已退役的 key。
- `FLAG_EXEMPTIONS` 当前 46 条，其中 22 条明确标成
  `persistentEnvAllowed: true` 的 safety/auxiliary runtime 开关；这与本单“只留 QA
  隔离、dry-run、一次性迁移”的字面边界冲突，已向 Lead 发出非阻塞 disposition
  问题（question `382ec580-55c8-409b-a35b-72d2c3df6e5f`）。

## 3. 设计选项

### A. 以 registry 为唯一纳管名册（推荐草案）

- `STORE_MANAGED_FLAGS` 从 `FEATURE_FLAGS` 全表导出；
  `PROJECT_STORE_MANAGED_FLAGS` 只从 `scope === "project"` 导出，作为存储路由子集，
  不再是第二份 authoring allowlist。
- `LEGACY_UNMANAGED_BASELINE = []`，authoring policy 删除 legacy 分支。
- codec 合同按 registry 全表执行；scope 分支分别验证 global/project 存储约束。
- drift 增 tracked `config.yaml` leaf-path 扫描，复用 `yaml` 依赖与既有 retired/registry
  身份，不加 parser。

优点：最少重复账，直接满足“registry + codec + scope，别无他路”。风险：所有使用
`STORE_MANAGED_FLAGS` 作为 global-only 集合的调用点必须按 `spec.scope` 收窄，不能仅改常量
制造 project flag 的全局 seed/write 旁路。

### B. 保留 global/project 两份手写 managed 集，只新增相等断言

改动更小，但 `STORE_MANAGED_FLAGS.size === FEATURE_FLAGS.length` 无法成立，runbook 仍要求
作者同时维护 registry 和第二份名册。拒绝。

### C. 删除 registry 的 `envVar` / `configKey` 历史身份

概念最纯，但会扩大到报告 DTO、bootstrap migration、真值检查与退役诊断的公共面；本单验收
要求拒绝 raw 值与 config 残留，不要求抹掉 registry 中的身份元数据。按 YAGNI 不做。

## 4. 豁免关门原则

豁免不是产品开关。最终保留项必须同时满足：

- 类型属于 `qa_isolation`、`dry_run` 或 `one_time_migration`；
- 禁止持久生产 env（`persistentEnvAllowed: false`）；
- 每条有具体 reason、owner、issue 与机器可审查的退役条件；
- 生产读点与声明一致且仍存活；
- 新增豁免不可以让 registry/store authoring policy 变绿。

当前 22 个 persistent 项的去向等待 Lead disposition；在答案前不把它们悄悄改名成“真豁免”，
也不擅自硬编码其值。

## 5. 验收证据形状

- RED env：向 synthetic production source 注入
  `process.env.FLYWHEEL_X === "1"`，目标 guard 返回明确 raw-read issue。
- RED config：在临时 tracked-shape `config.yaml` fixture 注入 `doc_flow.enabled`（另以
  当前 tidal-echo 样例作真实残留），目标 guard 返回文件与 dotted path。
- GREEN：删注入与真实残留后，targeted config tests 和 CI shard 通过。
- ledger：CI 直接断言 `LEGACY_UNMANAGED_BASELINE.length === 0`、
  `STORE_MANAGED_FLAGS.size === FEATURE_FLAGS.length`、双向无差集。
- codec：每个 registry spec 的 unset/default、显式 0/1 或 enum members、canonical 输出逐条对账。
- scan：真实 POST response、durable run id/evidence、notification message id/URL 或零候选消息回读。

## 6. 不做

- 不新增 flag、fallback ledger、category 级逃生门或依赖。
- 不修改 FLY-2104 的候选算法、周日调度或通知拓扑。
- 不 merge/deploy/restart Bridge；本节点只实现、验证、开 PR。
- 不把历史文档中的 flag 名当生产残留；守卫只管生产源和受控的 tracked config 文件。
