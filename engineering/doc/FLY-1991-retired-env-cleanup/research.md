# FLY-1991 老环境变量清理 — 调研
Issue: FLY-1991 (https://linear.app/geoforge3d/issue/FLY-1991/flag治理env清理-1778-生效后删除全部失效的老环境变量行5-条已纳管-flag-的死-env-行-生产-env-里-16)
日期: 2026-08-23
基于: exploration.md

## 1. 权威链

| 问题 | 权威证据 | 结论 |
| --- | --- | --- |
| FLY-1778 是否合入 | PR #921 + merge `c63ca48b7` | 已合入 |
| FLY-1778 是否生产生效 | `/health.buildSha=57885f044` 且 ancestry 为真 | 已生效 |
| FLY-1981 是否生产生效 | `7362a675c` 不是 live SHA ancestor | 尚未生效 |
| 五条值是否已进 store | 生产 `flag_values` 精确 name/shape 查询 | 五行存在；两行 override、三行 default |
| 当前 FlagView 是否读 store | `/api/fleet/snapshot` writer 显示 SQLite owns value | 值已入管 |
| 删除 env 后是否仍安全 | `resolve.ts` + `flag-store-runtime.ts` 源码追踪 | 当前不安全；需先修 ready projection |
| 生产静态红灯 | `check-flag-truth --env-file ~/.flywheel/.env` | 20 个 unique tombstone error，rc=1 |
| 模板是否有目标赋值 | 两份模板显式 sweep | 零命中 |

`buildSha` 应以 ancestry 判定，不要求等于 merge SHA。

## 2. FLY-1981 与 rollback floor

当前 main 的 `STORE_MANAGED_FLAGS` 为：

```text
loop_profiler
shipped_husk_force
flag_retirement_scan
workflow_rework_reentry
skill_framework_mode
workflow_turn_divergence_alerts
```

`workflow_resume` 已进入 `RETIRED_FLAG_STORE_ROWS`；迁移删除 current row、保留 changelog。`FLYWHEEL_WORKFLOW_RESUME` 与 `FLYWHEEL_FOUNDER_CONSENT_DECISION_MODE` 同时进入 `RETIRED_FLAGS`，后者在 FLY-1981 前仍决定 consent audit mode，提前删会从生产非-off 状态退成 `off`。

本单新增代码前置后，live mutation 必须发生在“含 FLY-1981 和 FLY-1991 修复的部署已经成功结束”之后。此时后续正常 deployment 的自动 rollback target 是当前 deployed SHA，已经包含 FLY-1981；不能在同一未收敛部署中边启动边删文件。若人工/window rollback 让 live SHA 退到 FLY-1981 之前，QA 必须先从保留的 pre-image 原子恢复 `.env`，再重启/验收。

## 3. R1 阻断 finding 的源码结论

调用链是：

```text
plugin.currentFlagViews
  → resolveAllFlags(process.env + managementEnvSource())
  → enrichFlagViewsWithStore(views, flagStore)
```

`resolveAllFlags` 对缺失 env key 按 registry default 产生 `fileEffective`。当前 `enrichFlagViewsWithStore` 即使在 `runtime.mode === "ready"`，仍比较 `view.fileEffective` 与 `storeEffective`。因此 store override 为非默认值时，删行会得到永久 `split_brain`。后果不是装饰性红灯：

- `feature-flag-render.ts` 在 divergence 时隐藏 direct control；
- `canonicalizeFlagSample` 把 divergence 归为 indeterminate；
- 周扫描把它写入 `no_clock` 并重置稳定 streak。

权威修复应落在 enrichment 边界，而不是改通用 resolver：

- **ready**：SQLite 是唯一权威。store-managed view 的 `effective/bridgeEffective/displayEffective` 来自 store，legacy `fileEffective`、env-origin `error/divergence` 必须清空；只保留不含右值的 `fileConfigured` presence bit，让 UI 在 `clockReadiness === "ready"` 时提醒删除已经被忽略的精确 assignment。
- **bypass**：显式关闭 store 时，boot env snapshot 仍是 fallback 权威；保留既有比较/降级语义。
- **unmanaged flag**：完全不变。

这样不削弱静态治理：过期 env 行仍由 `check-flag-truth` 报错；ready FlagView 会显示非 divergence 的 stale-line warning，并引导走 `stage/apply`；FlagView 不再把已经退役的输入误当运行时第二权威。

R2 进一步指出，当前 truth validator 会放过仍在 registry 中的 store-managed envVar。修复 ready projection 后，如果不补静态规则，旧行重新出现会成为静默 no-op。因此本单同时让 `validateFlagTruthEnvironment` 从 `STORE_MANAGED_FLAGS + FEATURE_FLAGS` 派生 must-be-absent 集合；不往 only-shrink exemption ledger 添加例外。当前产品代码对生产文件报 20 个 tombstone；加入该规则但尚未清文件时会再报 `FLYWHEEL_SKILL_FRAMEWORK_MODE`，形成 21-name RED，清理后统一 GREEN。

R2 对“恢复 `skill_framework_mode` 控件”的 advisory 不适用于当前产品政策：`isFlagViewDirectToggleable` 显式要求 `!flag.storeManaged`，`feature-flag-render.test.ts` 也锁住 console/phone 不展示 store-managed 控件。即时翻转走已经支持 store canonical 的公共 stage/apply API；改变 founder UI 写策略超出本单范围。

代码 review 又发现 bypass recovery 的另一条权威边界：现实现对每个 managed flag 都用 recovery 进程 env 覆写 SQLite；删行后，缺失 env 会把已有非默认 override 重置为 registry default。修复规则是：只有 legacy parser 认为有权威的精确 assignment 才从 env 导入；enum 空串沿用 resolver 的 unset 语义，default-on bool 空串仍是显式 ON。若已有 SQLite row 且 env 权威缺失，则保留 `hasOverride/raw` 权威，按当前 codec/default 重算 canonical effective。effective 未变时 row 完整不动并写 no-op `bypass_recovery` audit；effective 变化时推进 `lastEffective/valueLastChanged/revision/updated*`，audit 如实记录旧值→新值。首次部署 bypass 后没有既有 row 时，仍按同一 parser 语义 seed。这样删行或空 enum 不会破坏 durable authority，也不让 codec/default shift 留下一轮陈旧 clock。

最终 code review 还指出 cleanup warning 不能只看 `storeManaged + fileConfigured`：bypass/degraded 下 legacy env 仍是权威或恢复输入，提示“已忽略、删这行”会误导运营。因此 renderer 同时要求 `clockReadiness === "ready"`；对应 negative tests 锁住两种 `no_clock` 模式不显示该提示。

## 4. RED 分析与物理行形状

当前静态 RED 的 20 个 unique name：

| retiredBy | 数量 | 范围 |
| --- | ---: | --- |
| FLY-1501 | 2 | swap pressure |
| FLY-1570 | 5 | pending/stuck/watchdog/zombie |
| FLY-1645 | 1 | mailbox discord |
| FLY-1674 | 2 | three-stage Codex |
| FLY-1808 | 6 | cmux + workflow legacy |
| FLY-1831 | 2 | alert routing/tickets |
| FLY-1981 | 2 | consent mode + workflow resume |

前五组是 issue 的旧 16 条。另有 `FLYWHEEL_SKILL_FRAMEWORK_MODE` active assignment 属于五名集合、但不是 retired flag。生产文件还存在：

- 一个 target name 的重复 active assignment；
- 一个 target name 的 exact commented assignment。

所以执行证据必须区分 `unique names removed`、`active lines removed`、`commented assignment lines removed`，不能把 validator error count 当物理删除行数。用户要求 literal grep 零命中，因此 operator 删除 target 的 active assignment 与 exact commented assignment；普通说明性 comment 即使提到相似词也保留。

## 5. 文件 mutation 设计

### 5.1 准入

1. `turn=yours`，inbox 已检查；
2. `/health.buildSha` 同时包含 FLY-1778、FLY-1981 与本单 ready-projection 修复；
3. `.flywheel/deployed-sha` 与 health build 收敛，当前无 updater/restart wave；
4. FlagView/store roster 与当前 `STORE_MANAGED_FLAGS` 一致，`workflow_resume` current row 已退役；
5. `.env` 是 canonical regular file、非 symlink，owner/mode 可验证；
6. active tombstone intersection 与 validator errors 逐名相同，无未知错误。

### 5.2 原子清理

- 在同目录创建 `0600`、带 UTC 时间戳与 pre-SHA 的备份；不打印内容。
- 解析两类 exact LHS：active assignment 与 `#` 后的 exact commented assignment；删除 target exact name 的所有重复行。
- 名单为“执行时全部 `STORE_MANAGED_FLAGS` 对应 envVar ∪ `RETIRED_FLAGS`”；issue 五名是必须单列审计的子集，已经缺席的名字幂等验收。
- 同目录 exclusive temp，继承 mode/owner，`fsync` 后 atomic rename；SHA drift fail-close。
- stdout 只输出变量名、三类 count、pre/post SHA；绝不输出 value。
- post-check 失败就从已校验 backup 原子恢复。

备份 owner 是执行 live mutation 的 QA runner；post-restart FlagView、scan bucket delta、flip/restore 与 rollback-floor 复核全部 GREEN 后删除。若任一项未绿，备份保留并在 handoff 报告其路径 hash/owner（不报告内容）。

## 6. TDD seam

### 6.1 产品代码 RED→GREEN

在 `flag-store-runtime.test.ts` 先增加会失败的公共行为测试：

1. ready store 的 `skill_framework_mode` 持有非默认 override，而 env file 缺行时，view 应无 divergence、无 fileEffective，store display/control 仍可用；
2. ready store 面对 stale、unavailable 或 invalid legacy env projection 时仍只展示 store，不带 env-origin error/divergence；
3. readable file 的 exact assignment 只投影 `fileConfigured`，renderer 仅在 ready 时给出不含右值的 cleanup/stage/apply 提示；bypass/degraded 不显示；
4. bypass 模式继续保留 legacy source comparison；recovery 在 env 缺失或 enum 空串时保留既有 store override，并在 canonical effective 变化时推进 clock/audit；有意义的 env assignment（包括 default-on bool 空串）继续导入，首次部署仍可 seed。

再最小修改 `enrichFlagViewsWithStore`、renderer 与 `StateStore.ensureFlagValueRows`，定向测试 GREEN 后 refactor。

### 6.2 live cleanup RED→GREEN

1. **RED**：现有生产 truth validator rc=1、20 个 unique 墓碑错误；新增 store-managed persistent-env 规则后，在清理前应为 21-name RED。
2. **GREEN**：原子替换后同一命令 rc=0，输出 `flag truth OK`。
3. **文件不变量**：literal target-name grep=0；两份模板显式 validator/sweep 仍绿。
4. **运行时**：新 Bridge FlagView 全绿；scan 的 `candidates/no_clock/keep_unbound/departures` 相对 pre-image 无新增回归；公共 stage/apply 下一读即时变化并恢复原 row shape。

翻转恢复必须比较 `hasOverride/raw/effective`。`revision/updatedAt/valueLastChanged/changelog` 会按审计语义前进，不伪称 byte-identical 恢复。

## 7. 部署与阶段边界

```text
implement: TDD ready projection + persistent-env truth guard → full gates → review → PR
  → founder-gated merge（非本 Runner）
  → normal updater 部署含 FLY-1981 + FLY-1991 的 build
  → 本 issue 的 DAG QA/live-op 节点原子清 .env → static GREEN
  → 下一新进程/独立真 Bridge 上做 FlagView、scan bucket delta、flip/restore
```

Runner 不运行 `restart-services.sh` 或 `request-restart.sh`。本 implement 节点不能在自己的修复尚未部署时执行 live mutation。

## 8. 会过期的结论

| 结论 | as-of | 重核 |
| --- | --- | --- |
| live Bridge 未含 FLY-1981 | 2026-08-23 06:40 PT | health SHA ancestry |
| 当前代码 static RED 为 20 个 unique name；本单 truth guard 合入后、清理前应为 21 | 2026-08-23 07:10 PT | truth validator |
| 物理 target 行包含 duplicate/commented shape | 2026-08-23 06:55 PT | secret-safe LHS classifier |
| ready projection 仍比较 legacy file source | HEAD `7362a675c` | `flag-store-runtime.ts` + RED test |
