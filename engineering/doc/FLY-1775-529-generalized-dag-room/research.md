# FLY-1775 529 隔离房补 generalized-DAG 能力 + 装房路书固化 — 调研

Issue: FLY-1775 (https://linear.app/geoforge3d/issue/FLY-1775/infra-529-隔离房补-generalized-dag-能力-装房路书固化14-条实测坑位收编)
日期: 2026-08-14
基于: exploration.md

以下事实均为本分支代码实读(file:line)或 FLY-1768 实测报告引用,非转述记忆。

## 1. 「workflow flag 0/5」的根因(比 issue 表述更精确)

生产的 5 个 flag 在 `~/.flywheel/.env` 里是**裸 `KEY=value` 行(非 export)**:

```
FLYWHEEL_WORKFLOW_CLAIMS_WRITE=1 / CLAIMS_READ=1 / GENERALIZED_TEMPLATES=1
FLYWHEEL_WORKFLOW_GATE_CARRIER=1 / TEMPLATE_DISPATCH=1
```

- 生产 Bridge wrapper `scripts/flywheel-bridge-wrapper.sh:46-48` 用 `set -a; source` 自动导出。
- `scripts/test-deploy.sh:40` **有意**用裸 `source`(不 `set -a`,理由见 :751 注释——
  `set -a` 会把整个生产 `.env` 塌进 slot 子进程,正是坑 4 的事故形态)。
- 结果:slot Bridge 经 `env VAR=… npx tsx scripts/run-bridge.ts`(:1516-1537)起,一个
  workflow flag 都收不到 → 0/5。`BRIDGE_EXTRA_ENV`(:627)现无任何 `FLYWHEEL_WORKFLOW_*`。

flag 注册表:`packages/config/src/feature-flags/registry.ts`——5 个全是
`source: env / scope: bridge_global / opt_in / default false`(:2624/2648/2720/2768/2792)。
**没有** DB flag 表、没有 flags.json;FLY-1091 的「dynamic」= 进程内热改
(`packages/teamlead/src/bridge/flag-toggle.ts:1-24`)。

硬性 fail-closed 门 `packages/teamlead/src/workflow-template-dispatch.ts:33-46`:
TEMPLATE_DISPATCH/CLAIMS_WRITE/CLAIMS_READ 缺一即 block;v2 模板再要
GENERALIZED_TEMPLATES。第 5 个 `GATE_CARRIER` 不挡 dispatch,但决定
`gate_carrier_epoch=1`(生产与 FLY-1768 演练的 run 形态;没有它九步判据链第 1 步就进不去)。
`FLYWHEEL_WORKFLOW_REWORK_REENTRY` / `FLYWHEEL_LAND_NODE` 默认 on,无需显式给。

⚠️ **附带发现(隔离泄漏,进路书)**:flag 热改的持久化路径硬编码
`join(homedir(), ".flywheel", ".env")`(`packages/teamlead/src/bridge/plugin.ts:2118/2186/4473`)——
slot Bridge 若走 flag-toggle 路由,会写**生产** `.env`。路书必须禁止在 slot 里用 flag 热改。

## 2. `workflow_category_binding`:无 boot seeding、无 HTTP 写路由

- Schema:`packages/teamlead/src/StateStore.ts:4350-4359`,PK `(project, task_category)`,
  FK → `workflow_template(template_id)`。
- Bridge boot 只做两件事(`packages/teamlead/src/bridge/plugin.ts:4227-4228`):
  `importWorkflowMenuSeeds(store)`(只种 `workflow_template` 族,无条件、内容哈希幂等)+
  `retireLegacyWorkflowTemplates(store)`(只 CAS 解绑/退役 12 个旧模板;fresh 库上是
  全空转,`workflow-template.retirement.test.ts:109-125` 有证)。**没有任何路径种 binding**。
- 全仓 HTTP 路由只有 GET(`workflow-template-routes.ts:36-77`);唯一写路由是 FLY-1436
  cutover,硬编码 `PROJECT="flywheel"` + 已退役的 baseline(`workkind-cutover.ts:23/41-43`),
  对 QA 项目不可用。
- 生产 5 行:`code→tpl_code / prd→tpl_prd / design→tpl_design / prototype→tpl_prototype /
  generic→tpl_generic_menu`(canonical 表 `packages/config/src/workflow-menu-contract.ts:8-15`,
  「Do not mirror these identities elsewhere」——脚本应从此表派生而非硬编码)。
- 解绑安全性:retire 只碰 12 个退役模板 id(`workflow-template.ts:1580-1593`)+ 3 个
  system owner(:1597-1601)。**指向幸存 5 模板的新行不会被下一次 boot 解绑**。
- **重启不再必要(待实现期实测确认)**:StateStore 现为 better-sqlite3 WAL
  (`StateStore.ts:11`, :1777),`save()/flush()` 为 no-op(:1929-1941);binding 读取是
  per-request 现读(`workflow-template-selection.ts:66-70`)。FLY-1768 的
  「停 Bridge → INSERT → 起 Bridge」三步舞的真实约束只剩**时序**(INSERT 必须在首次
  boot 种完模板之后,否则 FK 失败)。FLY-1441 报告里「sql.js 会覆盖外部写」的说法已过时。

## 3. 第三个独立断点:master auth

generalized dispatch 要求 `sessionRole=main` **且** Bearer == `TEAMLEAD_API_TOKEN`
(`runs-route.ts:962-974/1786-1789`;`workflow-template-selection.ts:179-181` 非 master 直接 throw):

- 默认房(`TEST_REPLY_BY_ISSUE=0`,`test-deploy.sh:65/83`)`TEAMLEAD_API_TOKEN` 根本不设
  → master auth **不可能** → 永远走 legacy。
- `scripts/inject-linear-issue.sh:243-248` POST 不带 Authorization → tokenless →
  `freshLegacyEntry=true`;开了 `TEST_REPLY_BY_ISSUE=1` 后它反而 401(坑 9 的机制)。

⇒ `--generalized` 必须无条件给 slot Bridge 配 `TEAMLEAD_API_TOKEN`(沿用
TEST_REPLY_BY_ISSUE 的 token 生成/复用逻辑 :65-81),并把 token 落到 slot 状态目录
(0600)供驱动读取;驱动直接 POST `/api/runs/start` 带 Bearer(FLY-1768 形态)。

## 4. `pipeline.dag` 的真实语义(文档过时,以码为准)

fresh v2 入口**只**由 flags + binding/templateId 决定(`runs-route.ts:2196-2201`);
`pipeline.dag: true` 今天只控两件事:
1. `work_kind: true` 的前置(`pipeline-config-source.ts:76-79`,违反 → 400)。
2. legacy `pipeline_dag_v1` run 的 recovery 收敛门(`runs-route.ts:1691-1706`)。

生成器 `scripts/lib/qa-multilead.sh:71-102` 现不产 `pipeline:` 段,且
`test-deploy.sh:848-849` 每次 deploy 重写该文件(手工补的会被抹掉——FLY-1768 是
deploy 后手补才活过来)。issue 交付 1 写明 slot config 要带 `pipeline.dag: true`:
照做(production-shape 对齐 + 给 recovery/work-kind 留路),但设计上明确它**不是**
v2 入口的开关,路书如实写。

## 5. 其余 run-start 必要输入(全部同时满足)

| 输入 | 检查点 |
|---|---|
| 3+1 flag(见 §1) | `workflow-template-dispatch.ts:33-46` |
| binding 行(精确 category 或 '*')或显式 `templateId` | `workflow-template-selection.ts:57-114` |
| 模板已发布未退役(boot 自动种,前提 worktree 已 build 且 `menus/shapes/` 完整) | :90-96;坏 seed 直接中止 boot(`verify-workflow-seeds.mjs:5-8`) |
| `sessionRole: "main"` + Bearer master + idempotencyKey(v2 自合成) | `runs-route.ts:1786-1789/2202-2203` |
| issue 无 `no-three-stage` label | `runs-route.ts:2065-2070` |
| `BRIDGE_DEPT_SCOPE_REJECT=off`(默认 on;`["*"]` 字面量永不命中真 label → 403) | `runs-route.ts:265-278/1432+`;FLY-1768 qa-report §8 |

## 6. 被退役的 e2e 驱动:不可复活,必须重写

`scripts/qa-fly-1281-generalized-template-e2e.mjs` 现为 5 行 tombstone
(`exit(1)`);FLY-1693 一并墓碑化 9 个 harness。旧驱动(625 行,
`git show 75383c2d4:…`)是 **in-process** harness:fake `$HOME` + 真
`createBridgeApp` + 真 `TmuxAdapter` + PATH 上的 `claude` shell stub 跑确定性
probe(无模型调用),12 条断言。不可回滚复活的两轴:
- 符号 `importBundledWorkflowSeeds` 已从源码删除(只在 dist 残影);
- 它引用的 `tpl_generic/tpl_product_*` 全在 `RETIRED_BUNDLED_TEMPLATE_IDS`
  (`workflow-template.ts:1580-1593`),每次 boot 主动退役。

替代驱动必须面向**真 529 房**(隔离 slot Bridge over HTTP + slot StateStore 只读取证),
按幸存 menu seeds 驱动。**PATH-stub 假体、真控制面**的形态被旧驱动验证过,直接继承。

⚠️ **附带发现**:`registry.ts:2730` 的 `workflow_claims_write` 说明仍钉在这个已死
E2E 上(「must not be enabled before the pinned real fresh-spawn E2E passes」)——
新驱动落地后应把该指针换成新驱动(一行 doc-string 改动,随实现 PR)。

## 7. 坑 14(FLY-1768 F2)的机制链(本次实读补齐,FLY-1768 未下的结论不代下)

QA PASS 进 land 闸的完整链(`workflow-decision-routes.ts` + `StateStore.ts`):

1. 服务端 canonical:`resolveEngineDecisionCanonical`(`workflow-decision-routes.ts:121-210`)
   —— qa_verdict 的 `serverHead` 取 QA execution 的 head authority;producer = 上游
   implement 节点最后一个 done execution。
2. `resolveGateEntryBinding`(:228-330)要求**全部**成立:
   - `getWorktreeBinding(qaExecutionId)` 有行 —— QA execution 自己的 worktree binding
     (`bindWorktreeOnce`,FLY-1185 创建时单写,`StateStore.ts:14469-14490`);缺 →
     `land_head_pr_identity_unavailable`。
   - worktree 真实仓库 authority:identity=`__main__`、HEAD == serverHead。
   - producer session 有 `pr_number` + 40hex `pr_head_sha`(implement 完工时经
     binding/mirror 写入,`StateStore.ts:28309/28329`)。
   - 真 PR probe(`gh`):OPEN、非 draft、非 cross-repo、head 在 tip。
3. 都成立 → `recordWorkflowGateEntryBindingTx`(`StateStore.ts:28412`)铸 binding;
   否则 store 层 land 权威判 `land_head_unavailable`(`StateStore.ts:30311-30320`:
   有 head 但查不到 `getCurrentWorkflowNodePrBindingForHead`)。

⇒ 房间层的正解:**QA 节点必须是 Bridge 正常派发的 execution**(走 spawn 机制拿到自己的
worktree binding),implement 必须真开 PR(sandbox 上 OPEN 非 draft)。驱动器只要不
绕开派发机制,这条链在房里理论上闭合;若实测仍断,断点会被驱动器第 8 步前的显式断言
定位到具体 reason(`land_head_pr_identity_unavailable` / `_drift` / `_probe_failed` / …),
那就是把 F2 从「假设」变成「可证伪定位」——机制修复仍归产品侧单独 issue。

## 8. 14 条坑位 → 处置矩阵(设计定案)

| # | 坑 | 处置 | 落点 |
|---|---|---|---|
| 1 | 从被测 worktree 起房(slot 跑脚本仓字节) | 自动化+硬门:deploy 头部醒目打印脚本仓 HEAD;新可选 `--expect-head <sha>` 不符 fail;deploy 尾部已有 `/health` 可校验,room-info 增 `buildSha` 字段 | test-deploy.sh + 路书 |
| 2 | 短 TMPDIR(sun_path 104) | 自动化:preflight 计算 slot socket 路径长度,超限时对子进程强制 `TMPDIR=/tmp` 并 log | test-deploy.sh |
| 3 | ambient roundtable env(半套配置 fail-closed) | 自动化:非 roundtable mode 对 Bridge/Lead 子进程显式清 `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS` 等 | test-deploy.sh |
| 4 | ambient `FLYWHEEL_ALERT_SENDER_TOKEN_ENV`(`set -a source` 塌缩→403 全死信) | 自动化:非 --alerts 对子进程显式清该 var | test-deploy.sh |
| 5 | slot bot 告警频道邀请矩阵(slot 1 可用 slot 2 403) | preflight 探针:--alerts 时逐 bot round-trip 探频道可达,403 → fail-loud 指路邀请 | test-deploy.sh + 路书 |
| 6 | 无 Runner 演练不带 `--from-branch` | 路书(决策类,脚本不猜) | 路书 |
| 7 | sandbox clone 间歇 stall(判据=目录增速) | 自动化:clone 增速看门狗,停滞 kill + 重试 1 次再 fail | test-deploy.sh |
| 8 | labels `["*"]` 非通配 → DEPT_SCOPE 403 | 自动化:slot Bridge 默认 `BRIDGE_DEPT_SCOPE_REJECT=off`(env 可覆盖回 on 供测该机制的 QA 用,precedent = FLYWHEEL_DONE_THREAD_RECONCILE);`--lead-label` 仍是正路,路书写清 | test-deploy.sh + 路书 |
| 9 | `TEST_REPLY_BY_ISSUE=1` 后 API 401 | 自动化:token 落 slot 状态目录 0600 + room-info 指路;`inject-linear-issue.sh` 有 token 时自动带 Bearer | test-deploy.sh + inject 脚本 + 路书 |
| 10 | 依赖未装/dist 过期 | 已有 preflight(:410),错误文案点名 `pnpm install --frozen-lockfile` + `pnpm -r build` | test-deploy.sh 文案 + 路书 |
| 11 | teardown 撞 cmux lease | 自动化:test-teardown.sh 撞 lease 超时自动重试 1 次,再挂才 fail | test-teardown.sh + 路书 |
| 12 | launchd-v2 bootstrap slot 内失败 | 路书:引擎演练用 `--no-lead`(九步不需要 Lead;founder gate 由驱动 respond 批,FLY-945 Fix E 路径) | 路书 |
| 13 | sensor 演练要显式 `FLYWHEEL_LEAD_WATCHDOG_INTERVAL_MS` | 路书 | 路书 |
| 14 | QA 体无 PR 身份 → land 必拒 | 驱动器结构性规避(§7)+ 第 8 步前显式断言 + 精确诊断;机制修复不在本单 | 驱动器 + 路书 |

## 9. 驱动器关键约束(实读汇总)

- 九步中第 4/9 步断言**体真停驻/体回收**(pane 活、goal paused)⇒ 驱动器不能绕开
  spawn 机制 —— 假体必须是 Bridge 真 spawn 出来的进程,只是把 AI 换成确定性脚本
  (PATH-stub,旧 FLY-1281 驱动验证过的形态)。
- `menus/shapes/code.yaml` implement 节点 `defaultModel: codex` ⇒ 默认会走 codex
  spawn 路径。stub 双轨:(i) 经 menu/roster 层把节点 vendor 钉到 claude-stub,或
  (ii) 同时 stub codex 入口 —— 取舍在 plan 里定,实现期以真机为准。
- founder gate 批准:slot 已带 `FLYWHEEL_FOUNDER_ATTRIBUTION_GATE=0`
  (`test-deploy.sh:771-772`),驱动用 lead-attributed `flywheel-comm respond` 批
  (test-auto-approve.sh 同路径),Lead 非必需 → `--no-lead` 兼容。
- QA verdict:`flywheel-comm qa-result`,per-attempt 一次性凭据(FLY-1768 research §6);
  attempt 1 FAIL / attempt 2 PASS 是两个凭据,不撞 replay。
- 证据形态:逐步 JSON + sqlite3 只读取证(`file:…?immutable=1` 或 WAL 只读),
  exit code 聚合;不出 PASS/FAIL 单字判决进引擎(演练纪律沿用 FLY-1768)。
