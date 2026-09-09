# FLY-2398 自动合并影子跑 — 验收
Issue: FLY-2398 (https://linear.app/geoforge3d/issue/FLY-2398/2309b4-自动合并影子跑两周-四条记录线-错判率表一次都不真的自动合并p1-依赖-b1b2b3)
日期: 2026-09-08
基于: plan.md

## 1. 实现边界

- `StateStore` 在 founder 门判决事务内冻结机器分类与强度二两半;影子观察失败只回滚自己的 savepoint,不改变原判决动作。
- Lead 声明入口只接受 canonical UUID、四值枚举与已绑定卡;Bridge 以项目名册里的 Lead 身份读取 Discord 原消息并核对作者、正文、时间和卡绑定。普通 founder token 与 legacy `fallbackToken` 路径保持原样;严格解析只用于影子声明,缺失时返回 503。
- 两张影子表只追加,由 FLY-2006 retention registry 保护;报告只从 WAL-safe SQLite 在线副本读取,随后以 `mode=ro&immutable=1` 复算。
- 没有新增 merge 执行器、授权读者、review hold 或 founder 卡动作。影子期间真实自动合并次数仍为 **0**。

对应实现提交:

| 批次 | 提交 | 结果 |
| --- | --- | --- |
| C0 | `52cb9a562` | 注册两张影子表的 retention 保护 |
| C1 前置身份策略 | `0b6c429dd` | 影子声明 strict 解析与 legacy/general fallback 回归保护 |
| C1 | `44bfb9707` | 冻结 founder verdict 对应观察;不可改/删 |
| C2 | `eec4d8251` | 身份可核实、幂等且只追加的 Lead 声明入口 |
| C3 | `9f604ad12` | WAL-safe 只读副本、四线覆盖与 N1/N2/N3 独立复算 |
| 隔离回归 | `52876465f` | 登记 FLY-2398 为 FLY-2396 作者事实的只读度量消费者 |

## 2. 硬验收映射

| 验收项 | 可执行证据 | 结论 |
| --- | --- | --- |
| 四条记录线覆盖率 100% | fixture 的 `line1_machine_class`、`line2_human_class`、`line3_strength_two`、`line4_founder_action` 都是 `5 / 5`;逐条删观察、删/跨 run 声明、制造死信或镜像不一致都会输出 `TABLE_VOID` | 满足;缺任一线整张表作废 |
| 独立复算 N1/N2/N3 | `scripts/fly-2398-shadow-table.mjs` 先 `.backup` 活跃 WAL 库,再在 immutable readonly session 中执行 `shadow-table.sql`;测试核对源库 SHA-256 前后不变 | 满足;拿只读库副本与 SQL 即可重跑 |
| founder 动作变化量 = 0 | 精确源文件白名单测试同时锁住 FLY-2396/FLY-2398 事实消费者,并禁止 `land-executor`、`approval-signal`、`review-hold`、`post-ship-finalization` 等授权路径读取影子事实 | 满足;实现没有真实自动合并通路 |
| 报 0 同时报全集 | 所有 metric 结构都是 numerator/denominator;空 cohort 渲染为 `0 / 0 (no population)`,测试禁止裸 `| 0 |` | 满足 |
| 两个放手门槛 | 表固定展示「纯文档类错判率必须 `0 / 全集` 才可放手;非零则连纯文档也不开」;其它类仍不放手 | 满足;这里只生成影子判断,不执行放手 |

正常 fixture 有 5 次 founder 动作、4 个 distinct run、4 张机器判为纯文档的卡。独立结果为:

```text
cohort_actions                  5 / 5
cohort_runs                     4 / 4
line1_machine_class             5 / 5
line2_human_class               5 / 5
line3_strength_two              5 / 5
line4_founder_action            5 / 5
eligible_docs_runs              3 / 3
N1_founder_authored_rework      1 / 3
N2_founder_authority_rework     1 / 3
N1_release_threshold            0 / 3
N2_release_threshold            0 / 3
RELEASE_HOLD: N1_nonzero,N2_nonzero
N2_wide_all_rework              1 / 3
nested_post_observation_hit     1 / 3
nested_post_observation_incomparable 0 / 3
nested_post_observation_clear   2 / 3
TABLE_VALID
```

同一 run 有多次 founder 打回时,N3 仍只输出一条 distinct-run 明细。nested proxy 对混合证据按 `hit > incomparable > clear` 聚合;过期 proxy 明示「不等价于误判单数,精确数需 PR head 变更事件台账」。

## 3. 验证结果

| 命令 | 结果 |
| --- | --- |
| `pnpm lint` | 退出 0;保留 14 个既有 warning,没有把它描述成 warning-free |
| `pnpm -r build` | 退出 0 |
| `node --test scripts/__tests__/fly-2398-shadow-table.test.mjs` | 10 / 10 通过;含门槛非零、空全集、覆盖不全、双零仅候选与期末备份竞态(绝不自动合并) |
| TeamLead 13 个受影响文件精确集(含 Bridge、StateStore、route、Discord、retention 与两组隔离契约) | 267 / 267 通过 |
| flywheel-comm `shadow-declare` CLI | 8 / 8 通过 |
| `pnpm --dir packages/teamlead exec vitest run src/__tests__/fly2396-no-gating-readers.test.ts src/__tests__/fly2398-no-gating-readers.test.ts` | 3 / 3 通过 |
| TeamLead typecheck | 退出 0 |
| `pnpm test:packages:run` 第一次 | 未绿:flywheel-comm 2,076 通过;claude-runner 1,105 通过、2 skip,但 Vitest worker `onTaskUpdate` 超时导致退出 1 |
| `pnpm test:packages:run` 第二次 | 未绿:机器负载下既有 CLI/E2E 固定超时及 Vitest worker 超时;没有把该次称为全仓通过 |
| TeamLead 全包 | 未绿:12,029 通过、6 skip、14 失败、1 个 worker 超时。发现并修正 1 个 FLY-2396 精确白名单回归;其余为既有 5 秒测试、real-tmux/真实账号环境失败,修正后定向隔离集 3 / 3 通过 |

为区分本分支与环境失败,另在临时 detached `origin/main@ee113cab9` worktree 运行同一组 claude-runner real-tmux 失败项;main 同样出现 prompt overflow 超时与 tmux server 退出。临时 worktree 已删除。这是 A/B 基线证据,不是全仓绿灯。

本单新增的是 `.test.mjs`,没有新增 `scripts/__tests__/*.test.sh`。

## 4. 两周窗口与实际运行边界

- 窗口起点可显式传 canonical millisecond UTC;默认值是 shadow migration receipt 之后的第一个 UTC 零点。默认终点严格为起点后 14 天。
- 显式终点也必须恰好等于起点后 14 天;wrapper 与 standalone SQL 两层都会拒绝任意短窗/长窗。报告时钟早于终点时同样 fail closed,不能在第 1 天提前取得候选结论。
- wrapper 在 WAL 在线备份开始前记录 `snapshotStartedAt`,并要求它不早于窗口终点;即使备份跨过终点,也不能拿期末前开始的副本出表。若 `--db` 指向别人预先制作的副本,其原始捕获时刻仍须由交付者另附 provenance;SQL 无法从任意 SQLite 文件内容反推出复制时刻。
- 没有硬编码 `2026-09-06` 或替 founder 选定计时起点。真实影子跑开始前仍须向 founder 确认一次起点。
- 当前实现节点没有 production mutation、部署或 founder-path QA 权限,因此这里证明的是可执行实现与固定 fixture,不是已经完成两周 production 影子跑。最终表必须在 founder 确认并实际跑满窗口后对 production 数据库副本执行。

运行方式:

```sh
node scripts/fly-2398-shadow-table.mjs \
  --db <teamlead-sqlite-copy-or-live-path> \
  --window-start <founder-confirmed-canonical-UTC> \
  --window-end <exactly-14-days-later> \
  --format md
```

## 5. 回滚

若要停止采集,回退 C1/C2/C3 的代码接线与声明/报表入口;保留 C0 retention 注册。已写入的两张表、migration receipt 与观察证据继续按保护策略保存,不删除、不改写。由于没有任何 merge 授权消费者,停用影子采集不需要也不得改 merge 授权契约。
