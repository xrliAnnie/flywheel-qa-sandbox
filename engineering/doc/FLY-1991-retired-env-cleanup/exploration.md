# FLY-1991 老环境变量清理 — 探索
Issue: FLY-1991 (https://linear.app/geoforge3d/issue/FLY-1991/flag治理env清理-1778-生效后删除全部失效的老环境变量行5-条已纳管-flag-的死-env-行-生产-env-里-16)
日期: 2026-08-23
基于: 无

## 1. 问题边界

FLY-1778 已把五条 flag 的值权威迁到 SQLite，但“值读取迁走”不等于“.env 来源已经从所有投影中退场”。设计审查 R1 发现，当前 `enrichFlagViewsWithStore` 仍把 store 值与 legacy `.env` 的解析结果比较：当 `.env` 行被删除、store 恰好持有非默认值时，缺失行会按 registry default 解析，继而制造永久 `split_brain`。控制台因此隐藏写控件，周扫描也会把该 flag 放进 `no_clock`。

所以本单有两个严格有序的交付面：

1. 代码真相：ready 状态下 store-managed flag 只以 SQLite 为权威；legacy `.env` 不再参与该 FlagView 的 effective/error/divergence。显式 bypass 仍保留 env fallback 语义。
2. 文件真相：上述修复与 FLY-1981 都成功部署后，才物理清理生产 `~/.flywheel/.env` 的失效行，并用现有治理与运行时 seam 验收。

这不是新的 flag 机制，也不改 flag 默认值、store codec 或 stage/apply 路由。代码修复只补齐 FLY-1778 的权威边界；文件 mutation 仍是一次性、可恢复的宿主操作。

## 2. 当前事实快照

- 当前分支代码基线 `7362a675c` 包含 FLY-1778 merge `c63ca48b7` 与 FLY-1981 merge `7362a675c`；`origin/main=5940f4220` 仅新增 FLY-1987 文档，不改变本单 authority set。
- 生产 Bridge `/health.buildSha=57885f044`；该 SHA 是 FLY-1778 的后继、但不是 FLY-1981 的后继。因此 FLY-1778 已生效，FLY-1981 仍需等正常部署。
- 生产 `teamlead.db.flag_values` 已有五条纳管行；两条有 override、三条使用 store default。只记录 shape，不复制 raw 值。
- 生产 `.env` 中五个纳管名只剩 `FLYWHEEL_SKILL_FRAMEWORK_MODE` 与 `FLYWHEEL_WORKFLOW_RESUME` 两条 active assignment；另外三名已经缺席。
- 当前 main 的 `RETIRED_FLAGS` 与生产 `.env` active assignment 交集为 20 个 unique name；其中一个名字有重复赋值，另有一个目标名以 commented assignment 留存。物理行数必须在执行时单独重算。
- `scripts/check-flag-truth.ts --env-file ~/.flywheel/.env` 精确报 20 个“已退役假开关”，rc=1。
- 仓内持久环境模板为 `fleet/example/env.example` 与 `packages/gemini-agent/.env.example`；目标赋值行当前为零。

## 3. 精确集合

### 3.1 五个 SQLite 纳管名

```text
FLYWHEEL_FLAG_RETIREMENT_SCAN
FLYWHEEL_WORKFLOW_REWORK_REENTRY
FLYWHEEL_SKILL_FRAMEWORK_MODE
FLYWHEEL_WORKFLOW_RESUME
FLYWHEEL_WORKFLOW_TURN_DIVERGENCE_ALERTS
```

### 3.2 Issue 所指的 16 条既有墓碑

```text
FLYWHEEL_SWAP_PRESSURE_HIGH_PCT
FLYWHEEL_SWAP_PRESSURE_LOW_PCT
FLYWHEEL_LEAD_PENDING_ESCALATION
FLYWHEEL_STUCK_DETECT
FLYWHEEL_STUCK_FOUNDER_PAGE
FLYWHEEL_WATCHDOG_JUDGE
FLYWHEEL_ZOMBIE_GATE_RESOLVE
FLYWHEEL_MAILBOX_DISCORD
FLYWHEEL_THREE_STAGE_CODEX_DESIGN
FLYWHEEL_THREE_STAGE_CODEX_IMPLEMENT
FLYWHEEL_CMUX_LINKED_VIEW
FLYWHEEL_WORKFLOW_CLAIMS_READ
FLYWHEEL_WORKFLOW_CLAIMS_WRITE
FLYWHEEL_WORKFLOW_GATE_CARRIER
FLYWHEEL_WORKFLOW_GENERALIZED_TEMPLATES
FLYWHEEL_WORKFLOW_TEMPLATE_DISPATCH
```

### 3.3 创建 issue 后新增、但同样阻止 GREEN 的墓碑

当前 registry 比旧 16 条多出四个生产命中：

```text
FLYWHEEL_ALERT_ROUTING
FLYWHEEL_ALERT_TICKETS
FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE
FLYWHEEL_WORKFLOW_RESUME
```

`FLYWHEEL_WORKFLOW_RESUME` 已与五名集合重叠，去重后新增三名。若只删旧 16 条，当前 main 的静态门不可能转绿。`FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE` 只能在 FLY-1981 已成功部署、且本单代码也已部署后删除。

## 4. 方案选择

1. 先以 TDD 修正 `enrichFlagViewsWithStore`：`runtime.mode === "ready"` 时清除 legacy `fileEffective`、env-origin `error` 与 `divergence`，只展示 store 值；`bypass` 行为保持不变。
2. 完成 repo gates、code review 与 PR；本 implement 节点不在尚未部署修复时修改生产 `.env`。
3. 待含 FLY-1981 与本修复的 build 成功部署后，由后续 QA/操作波次创建 `0600` pre-image 备份，并以 exact left-hand-side 规则原子清理 active assignment 与 exact commented assignment。
4. 静态门立即从 RED 转 GREEN；新进程再验证 FlagView、scan 全 bucket delta 与一次受控翻转/shape 恢复。

不用新增永久 cleanup CLI：名单继续以 registry truth 为权威，一次性 operator 仅在执行波次生成并做 hermetic 测试，不把第二份长期名单留在仓库。

## 5. 明确不做

- 不删除 registry、tombstone 或 SQLite changelog。
- 不改 flag 默认值、codec、store schema 或 stage/apply API。
- 不让 ready store-managed FlagView 继续把 legacy env 当成第二权威；也不改变显式 store bypass 的 fallback 语义。
- 不把生产 `.env`、其备份或任何 value 提交进 git。
- 不请求即时部署/重启，不调用 `restart-services.sh`，不投紧急票。
- 不在本 PR 部署前执行 live mutation，不把旧进程结果冒充 post-restart QA。

## 6. 会过期的结论

| 结论 | as-of | 重核 |
| --- | --- | --- |
| FLY-1778 已部署、FLY-1981 未部署 | 2026-08-23 06:40 PT | `/health.buildSha` + ancestry |
| 生产墓碑交集为 20 个 unique active name | 2026-08-23 06:26 PT | `check-flag-truth.ts --env-file ~/.flywheel/.env` |
| 五个纳管名在生产文件仅命中两条 active assignment | 2026-08-23 06:18 PT | secret-safe exact LHS parser |
| 模板目标赋值零命中 | HEAD `7362a675c` | 显式检查两份模板 + repo content scan |
