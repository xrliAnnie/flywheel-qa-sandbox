# FLY-1991 老环境变量清理 — 实施计划
Issue: FLY-1991 (https://linear.app/geoforge3d/issue/FLY-1991/flag治理env清理-1778-生效后删除全部失效的老环境变量行5-条已纳管-flag-的死-env-行-生产-env-里-16)
日期: 2026-08-23
基于: research.md

## 1. 验收不变量

1. ready store-managed FlagView 只以 SQLite 为运行时权威；legacy `.env` 缺失、陈旧、不可读或非法都不产生 `fileEffective`、env-origin `error/divergence`。readable file 只保留 secret-free `fileConfigured` presence bit，并仅在 `clockReadiness === "ready"` 时显示非 divergence 的删除/stage/apply 提示；bypass/degraded 不显示。显式 bypass 比较语义不变。
2. `validateFlagTruthEnvironment` 永久拒绝 store-managed envVar 出现在 persistent env；must-be-absent 集合从 `STORE_MANAGED_FLAGS + FEATURE_FLAGS` 派生，不新增 exemption。
3. bypass recovery 仅在 legacy parser 认为有权威的 exact assignment 存在时导入；enum 空串按 unset，default-on bool 空串仍按显式 ON。已有 SQLite row 且 env 权威缺失时保留 `hasOverride/raw`，按当前 codec/default 重算 effective：未变则 row 不动并写 no-op audit，变化则推进 clock/revision 并在 audit 记录旧值→新值；无既有 row 的首次部署仍按同一语义 seed。
4. live `.env` mutation 只能在含 FLY-1981 与本单修复的 build 成功部署、`deployed-sha` 收敛且 updater wave 已结束后发生。
5. 五个 issue 名、旧 16 名、执行时全部 `RETIRED_FLAGS` 与全部 store-managed envVar 在生产文件和两份模板中满足 assignment 零命中；已经缺席的名字不冒充删除量。
6. active assignment 与 exact commented assignment 均按 exact name 删除；普通 comment、非目标字节、mode、owner 不变。unique name、active line、commented line、prose-only residual 分开计数。
7. `check-flag-truth` 从当前代码的 20-name RED（加入 guard 后、清理前为 21-name RED）转为 GREEN；任何未知 error 或 SHA drift 都 fail-close。
8. 新 Bridge 的 store roster 零 divergence/degraded；scan 的 `candidates/no_clock/keep_unbound/departures` 相对 pre-check 无新增回归。
9. 受控 flip 通过公共 stage/apply 在不重启的下一读生效；restore 后 `hasOverride/raw/effective` 与原 shape 相同。审计 clock/revision/changelog 允许且必须前进。
10. Runner 不 merge、不请求 ship、不调用重启脚本；implement 节点交付代码/测试/PR，DAG orchestrator 在部署后唤醒本 issue 的 QA/live-op 节点。

## 2. Seam 与 RED→GREEN

| seam | RED | GREEN |
| --- | --- | --- |
| ready FlagView | store override + env 缺行/陈旧会 `split_brain` | 只展示 store；值字段清空，presence-only cleanup warning 保留 |
| bypass 回归 | recovery 会把缺失/空 enum 当 default 覆写既有 row，或保留陈旧 effective | 有意义的 explicit env 继续导入；absent/空 enum 保留 override，canonical 不变时 no-op、变化时推进 clock/audit；空 bool 语义不变；首次部署仍 seed |
| persistent guard | store-managed registry envVar 当前会静默通过 | 任一 store-managed persistent line 给出 actionable error |
| 静态治理 | 当前 20-name RED；加 guard 后清理前 21-name RED | 同一脚本 `flag truth OK`，rc=0 |
| 文件集合 | target/retired active 或 commented assignment 有命中 | exact assignment 零命中；prose-only comment residual 分类报告 |
| 运行时 | pre snapshot/bucket census | 新 build roster 全绿，全 bucket 无新增回归 |
| read-on-use | original row shape | stage→apply 下一读变化；restore 后 shape 复原，uptime 不变 |

代码测试只走导出的 `enrichFlagViewsWithStore` + `resolveAllFlags`/真实 in-memory `StateStore`，不测私有 helper。

## 3. 执行波次

### P0 — 设计批准与 authority 复核

1. `turn=yours`，task boundary 查 inbox。
2. 把 R1 finding 固化为 ready-vs-bypass 权威规则，完成新一轮 design review；批准前不写实现。
3. fetch `origin/main`；若基线前进，重算 roster/tombstone 交集并更新 docs。

### P1 — 产品代码 TDD

1. **RED-A**：在 `packages/teamlead/src/bridge/__tests__/flag-store-runtime.test.ts` 增加 ready store 的 absent/stale/unavailable/invalid legacy env cases；断言 no divergence、no env-origin error、`fileEffective` undefined、display 等于 store。先运行并保存失败。
2. 将现有 `keeps stale .env visible when it differs from the managed store` 明确作为 **legitimate retarget**：ready 不再比较已退役来源；把原 split-brain 断言迁到 bypass runtime，避免简单删除灾备覆盖。
3. **RED-B**：在 `flag-truth.test.ts` 与 `scripts/__tests__/check-flag-truth.test.sh` 先断言 store-managed persistent env 行失败；确认当前实现错误地通过。
4. **RED-C**：公共 store write 后在 process/file env 均缺失时仍投影 store；bypass recovery 在 env 缺失/空 enum 时保留 override、空 bool 继续导入，并在 default shift 时校正 effective clock/audit；renderer 对 presence bit 仅在 ready 给出删除/stage/apply 提示，bypass/degraded 不显示。
5. **GREEN**：最小修改 `enrichFlagViewsWithStore`、`StateStore.ensureFlagValueRows`、renderer 与 `validateFlagTruthEnvironment`。ready 清除 legacy value projection但保留 presence；truth guard 从现有 authority sets 派生；unmanaged 不变。
6. **REFACTOR**：去掉重复条件，保持 secret-free DTO；跑 owning package 相关全套测试。

不改 `isFlagViewDirectToggleable`：当前产品明确不渲染 store-managed console/phone 控件，并有既有测试。P5 的 flip 通过 public stage/apply API 验证；UI 写策略另单治理。

### P2 — implement 节点 gates、review、PR

执行：

```bash
pnpm lint
pnpm -r build
pnpm test:packages:run
bash scripts/__tests__/check-flag-truth.test.sh
```

宿主 aggregate 原始失败逐项归因，不能用定向绿冒充整门绿。随后：

1. 提交产品代码、测试与 docs；不提交 live `.env`/backup/operator。
2. 注册 exact-head `review_code`，直到 `reviewVerdict=APPROVED`。
3. push feature branch，开 base=`main` PR。PR 明确 live cleanup 需在该 PR 部署后执行，不伪报尚未发生的生产验收。
4. `complete --route needs_review --pr <number>`；这只完成 wave-1 implement handoff，不关闭 FLY-1991 的 live-op 验收。DAG orchestrator 负责在部署后推进同一 issue 的 QA 节点；本 Runner 不自行 dispatch successor。

### P3 — post-merge live-op 准入（后续 QA/操作波次）

1. `/health.buildSha` 与 `~/.flywheel/deployed-sha` 相同，且 ancestry 同时包含 FLY-1778、FLY-1981、本单修复。
2. 确认刚才 deployment 已成功结束、无 in-flight updater/restart；若 FLY-1981 与本单同波部署，必须等整波 GREEN 后才 mutation。
3. 记录 pre FlagView effective/shape、scan 四类 bucket、store roster；`workflow_resume` current row 已不存在，changelog 仍在。
4. 用 truth validator + secret-safe LHS classifier 重算 active tombstone set、五名 present/absent、duplicate/commented shapes。
5. `.env` 必须为 canonical regular non-symlink file；记录 owner/mode/size/pre-SHA。

### P4 — 一次性 operator TDD 与原子清理

1. 在 `/private/tmp` 先写 hermetic harness，对 fake env 覆盖 active duplicate、exact commented assignment、普通 comment、相似前缀、SHA drift 与 rollback；operator 尚不存在时先取得 RED。
2. 再用 `apply_patch` 创建一次性 Node operator。参数只接受 canonical env path、repo root、expected pre-SHA。
3. 名单从当前 `truth.ts` 的 `RETIRED_FLAGS` 与 `STORE_MANAGED_FLAGS + FEATURE_FLAGS` 派生；五个 issue 名另做 required-subset 断言，不得硬编码“20/21/23”。
4. parser 删除所有 target active assignment 与 target exact commented assignment；保留普通 comment/相似名。分别输出 unique/active/commented/prose-only-residual count 和 already-absent names，不输出 value。
5. 同目录创建 `0600` backup；exclusive temp 继承 owner/mode，write+fsync，mutation 前复核 source SHA，atomic rename 后 fsync directory。
6. harness GREEN 后才对 canonical live file执行。任一 post-check 失败，用已校验 backup 原子恢复并证明 pre-SHA 恢复。
7. operator/harness 从 `/private/tmp` 删除。backup 由本 live-op QA runner 持有到 P5 全绿。

### P5 — static GREEN 与 post-restart QA

1. active/commented exact assignment sweep=0。literal target-name 命中只能属于分类后的 prose-only comment；必须逐名报告但不得为了“字面零”删除说明性注释。当前 preflight prose-only count=0，因此本次实际预期 literal sweep=0。
2. 同一 checkout 的 `check-flag-truth --env-file` rc=0；显式对 `fleet/example/env.example`、`packages/gemini-agent/.env.example` 跑 validator/sweep，并做 repo content-anchored scan。
3. normalized pre/post diff 只允许被分类的 target 行消失；mode/owner 不变。
4. 等正常新进程或在隔离真 Bridge：health build 仍含 FLY-1981+FLY-1991，进程 start 晚于 mutation；FlagView roster 零 error/divergence/degraded。
5. 比较 scan pre/post 的 `candidates/no_clock/keep_unbound/departures` exact membership；受影响 store-managed flags 不得新增到任何坏 bucket。无 settled run 就标未验证，不能用“没告警”替代。
6. 默认在隔离真 Bridge 做受控 flip。保存原 `hasOverride/raw/effective`，经公共 stage/apply 改值，下一读立即观察，再经公共 route 恢复；断言 shape 相同。记录 revision/value clock/changelog 的预期推进。
7. 复核 rollback floor：live SHA 不得回退到 FLY-1981 之前。backup 至少保留到清理后的下一次正常 deployment 成功结束；这样该波及以后自动 rollback 的前任 deployed SHA 已含 FLY-1981。
8. 上述 rollback floor 闭合且其余检查全 GREEN 后，由执行 P4 的 QA runner 删除该次 backup。此后 deliberate/window rollback 到 FLY-1981 以前必须 fail-close，先提交独立 env reconstruction plan，不能引用已删除 backup。若未全绿则保留并 handoff。

## 4. 失败与恢复

| 失败 | 处置 |
| --- | --- |
| design review CHANGES | 修 docs，开新 gate/request；不实现 |
| 既有测试锁住旧 ready behavior | 明确 retarget 到 bypass；不得静默删除覆盖 |
| FLY-1981 或本单修复未部署 | 等正常班车；不改 live file |
| deployment 尚未收敛 | 等 health/deployed-sha 一致且 wave 结束 |
| health SHA 本地未知 | fetch 后仍未知则停止，不猜 ancestry |
| source SHA 漂移 | 丢弃 temp，回 P3 重算 |
| 非目标 diff / static 不绿 | 原子恢复 pre-image，证明 SHA 恢复 |
| backup 存续期内 SHA 回退到 FLY-1981 前 | 先从 backup 恢复 env，再允许 restart/验收 |
| backup 删除后要求回退到 FLY-1981 前 | fail-close；先有独立 env reconstruction plan |
| FlagView error/divergence | 不 flip，保留 backup，报告 finding |
| scan 任一 bucket 新增回归 | 保留 backup，报告 exact delta，不只报 candidate count |
| flip apply/restore 失败 | 立即走同一路由 restore；仍失败则 fail-open question gate并保持目标存活 |

## 5. 证据与秘密边界

允许：变量名、行号、present/absent、分类 count、hash、mode、uid/gid、build SHA、test rc、FlagView 非秘密字段、scan run/bucket、store row shape（不含 raw value本身）。

禁止：`.env` 原行、任何右值、backup 内容、token、完整 process environment。命令输出只投影左值或 allowlisted JSON。

## 6. 分波审计

### Wave 1 — 本 implement 节点完成条件

| requirement | 证据 |
| --- | --- |
| ready store 权威唯一 | absent/stale/unavailable/invalid RED→GREEN tests |
| stale line 非静默 | `fileConfigured` + ready-only renderer cleanup/stage/apply test；bypass/degraded negative tests |
| bypass 不退化 | 原 stale comparison + absent/empty-enum preserve + empty-bool/default-shift/explicit-import/first-seed recovery tests GREEN |
| persistent env 防回生 | config unit + executable truth-check RED→GREEN |
| repo gates | lint/build/package tests/shell harness receipts |
| implement handoff | code review approved、PR、`needs_review` receipt |

### Wave 2 — 同一 FLY-1991 的 DAG QA/live-op 完成条件

| requirement | 证据 |
| --- | --- |
| 5 名与旧 16 清理 | frozen set literal/exact sweep=0；present/absent 表 |
| current tombstones 收口 | runtime `RETIRED_FLAGS` intersection=0 |
| production truth GREEN | post static rc=0 |
| FlagView 全绿 | new-process snapshot + store census |
| 周扫描无新增回归 | 四类 bucket pre/post exact delta |
| flip 即时生效且 shape 恢复 | stage/read/restore/read + row shape + unchanged uptime |
| template/example | 两文件显式 validator/sweep + repo content scan |
| backup 生命周期 | create/verify/restore trigger/delete-or-handoff receipt |

Wave 2 trigger 是本 PR merge 且正常 updater 部署含 FLY-1981+FLY-1991 后，由 DAG orchestrator 唤醒本 issue 的 QA 节点；wave-1 PR body 必须携带 pre-check 快照与本表，不能把 issue 当作已完成关闭。

## 7. 会过期的结论

| 结论 | as-of | 重核 |
| --- | --- | --- |
| 当前代码 preflight RED 是 20 unique names；truth guard 后、清理前应为 21 | 2026-08-23 07:10 PT | P3 重算，不写入 operator |
| branch 代码基线是 `7362a675c`；`origin/main=5940f4220` 仅多 FLY-1987 docs | 2026-08-23 07:00 PT | fetch + changed-path audit |
| live Bridge 是 `57885f044` | 2026-08-23 06:40 PT | health + ancestry |
| template 当前零目标 assignment | HEAD `7362a675c` | 两文件显式 + repo content scan |
| ready projection 尚未退役 legacy comparison | HEAD `7362a675c` | P1 RED test |
