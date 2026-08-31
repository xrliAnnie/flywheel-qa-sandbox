# FLY-2166 迁移审计结构性不可通过 — 调研

Issue: FLY-2166 (https://linear.app/geoforge3d/issue/FLY-2166/fly-2103-遗留-迁移脚本-pre-cutover-审计对真实仓库结构性不可通过g1-receipt-不可获得已手工等价完成迁移)
日期: 2026-08-29
基于: exploration.md

exploration.md 已定方向为方案 C(脚本退役 + 手工 G2 runbook + 未来迁移守则)。
本文回答实现层的全部「怎么做」:删除清单与影响面、runbook 的内容来源、守则文档
的落点,以及验证方式。

## 1. 删除清单与消费者 sweep

### 1.1 待删文件(净删,git 历史保留)

| 文件 | 行数 | 说明 |
|---|---|---|
| `scripts/migrate-fly2103-project-flags.ts` | 362 | CLI 入口(结构性不可运行) |
| `scripts/lib/fly2103-project-flag-migration.ts` | 709 | 审计/receipt/写入库 |
| `packages/teamlead/src/__tests__/fly2103-project-flag-migration.test.ts` | 326 | 专属单测,随 lib 删 |

### 1.2 消费者 sweep(2026-08-29T23:22Z,实现节点需带新时间戳重跑)

对 `migrate-fly2103|fly2103-project-flag-migration` 的全量引用:

- **仓内**(scripts/ + packages/ + .github/):仅上表 3 个文件 + 
  `packages/teamlead/src/__tests__/fly1436-pr-b-assets.test.ts:27`(见 §1.3)。
  `.github/workflows/ci.yml:110` 引用的是
  `scripts/__tests__/fly2103-project-config-generators.test.sh` —— 那是 config
  **generator** 的守卫套件(仍在生效,**保留**),不引用迁移脚本。
- **插件缓存** `~/.claude/plugins/cache/*/`:零命中。
- **插件 fork 源** `xrliAnnie/claude-plugins-official`:本地未 checkout,实现节点
  在 PR body 的 sweep 证据里显式写明该 root 的检查方式与结果(FLY-1914 合同:
  没查不得报成零引用)。

### 1.3 `fly1436-pr-b-assets.test.ts` 的改写形状

现状:该测试断言 (a) flywheel `.flywheel/config.yaml` 无 `pipeline` 块;(b) 迁移
lib **源文本**包含 `pipeline_dag/flywheel=1` 与 `pipeline_work_kind/flywheel=1`
两行 manifest —— 用意是守住「YAML 删块后,flywheel 的 DAG/work_kind enrollment
仍被载体编码」。

lib 删除后,enrollment 的运行时权威是 DB 行(仓内不可测),仓内载体改为本单的
G2 runbook(§2,列出最终 7 行 manifest)。改写:断言 (a) 不变;断言 (b) 改指
`engineering/doc/FLY-2166-pre-cutover-audit-fix/g2-runbook.md` 的对应两行。
与现状同类(文本断言),守卫强度不降。备选:直接删 (b) —— 但那会让「删 YAML
块却丢 enrollment」这类回归失去仓内守卫,不取。

### 1.4 不动的东西(scope discipline)

- `engineering/doc/FLY-2103-config-flag-retire/` 全部历史文档与
  `engineering/doc/milestones/FLY-2103.md`:当时为真的记录,只追加不改写;
  本单文档负责陈述后来的事实。
- `ConfigLoader` 的 retired-key fail-loud、`MetaAlertNotifier` 的
  `project_config_invalid`、flag store 本体:全部是活的生产机制,不碰。
- `scripts/__tests__/fly2103-project-config-generators.test.sh` 及 CI 引用:保留。

## 2. 手工 G2 runbook 的内容来源(逐条可追溯)

新文档 `engineering/doc/FLY-2166-pre-cutover-audit-fix/g2-runbook.md`,内容全部
转写自已批准的 FLY-2103 plan §3 运维合同 + 脚本断言 + qa.md Step 7,不发明新要求:

1. **前置核对(维护窗开始前)**
   - Companion PR 全部 OPEN → 窗内 merge:GeoForge3D#283 / joycon-typeless#49 /
     belle-workspace#3 / growth#25 / tidal-echo#28。
   - 六 checkout 的 config.yaml 收敛:**不能只 `git pull`**(flywheel checkout 的
     config.yaml 是带旧内容的未提交修改;geoforge3d/growth 的本地 doc_flow 删除在
     companion PR 合并后成为冗余脏改)。每仓按「retired-key 投影 worktree ==
     committed(已清理)」为准逐仓 reset 或提交,**只处理 config.yaml,不碰无关
     本地修改**;附逐仓 YAML-aware 核对命令(8 个审计类别,覆盖原 9 类 key)。
2. **第 7 行写入**(新 Bridge 起来后):沿用手工 6 行的同一通道
   `/api/fleet/flag/stage → /api/fleet/flag/apply`(actor `bridge-local-operator`,
   reason `"FLY-2103 config.yaml flag migration"`),写 `ponytail` scope=`*` raw=`0`。
   老 Bridge 对 ponytail 的 400 拒绝是预期(plan §2 Step 5),必须在新 Bridge 上写。
3. **G2-a:exact-set == 7**(转写自 `assertExactRows` + `FLY2103_FINAL_ROWS`):

   ```sql
   SELECT flag_name, scope, has_override, raw_value FROM flag_values
   WHERE flag_name IN ('doc_flow','pipeline_dag','pipeline_work_kind','proofshot',
     'xiaohongshu_learning','ponytail','skill_framework_split_participation')
   ORDER BY flag_name, scope;
   ```

   期望**恰好 7 行**(6 行 pre-cutover manifest + `ponytail|*|0`),全部
   `has_override=1`。任何缺行/异值/**额外行**(例如后来有人开了某项目的
   doc_flow)→ 停,人工裁决,不静默接受(plan §3 G2 原文)。
4. **G2-b:config 残留清零**:逐仓对 worktree 与 committed 跑 8 个审计类别
   (覆盖原 9 类 retired key),零命中(转写自 `auditPostDeployConfigs`)。
5. **G2-c:可观察面抽查**:`GET /api/fleet/snapshot` 读 7 flag × 6 项目 effective
   值,对照 qa.md「真实 Bridge 六项目对照」表(doc_flow: flywheel/joycon/pa/tidal
   ON、geoforge3d/growth OFF;pipeline_work_kind 仅 flywheel ON;ponytail 全 OFF;
   split 全 ON …)。这正是 qa-bridge-parity.mjs 用真 API 做过的核对的手工版。
6. **记录**:执行结果记入 FLY-2103 thread(issue 处置已约定);证据先拷后引
   (feedback_copy_evidence_before_the_action_that_destroys_it)。

不含伪造 receipt 的任何步骤:G1 receipt 判死,G2 的效力来自上述核对记录本身。

## 3. 未来迁移守则文档

落点:`doc/reference/one-shot-migration-contract.md`(与 ralph-patterns 等参考文档
同层;不进 CLAUDE.md 正文,避免共享写点)。内容四条,每条附 FLY-2103 实例:

1. **真相源显式声明**:审计推导预期状态用的真相源(committed / worktree /
   运行时 effective)必须写进 plan 并与 manifest 的推导源一致;若现实中多源分叉
   (如 geoforge3d/growth 的运行时关闭只存在于未提交修改),必须先有一个显式
   收敛步骤(提交或 disposition 记录),再跑审计 —— 不能把「审计会拒绝」当成
   收敛机制本身。
2. **载具分离**:迁移脚本不得与它审计的状态清理(config 删 key)同乘一个 PR;
   否则脚本可运行的每个 commit 上审计前提都已被破坏(FLY-2103 的顺序自锁)。
3. **真实环境阳性对照是 ship 硬门**:ship 前必须在真实环境跑通一次 dry-run 到
   PASS(QA 流程门;CI 没有真仓/真 DB,结构上做不了)。「跑过且被阻断」不算 ——
   阻断必须回答「哪个真实时点能通过」,答不出即设计缺陷。
4. **receipt 模式保留**:分阶段 receipt(manifest digest + 环境绑定 + 原子写 +
   post 阶段逐字段校验)是好的防伪造模式,参考实现见
   `scripts/lib/fly2103-project-flag-migration.ts@49b57b3e9`(git 历史)。

配套一条 feedback memory(本 runner 记忆库):阳性对照缺失 + 阻断合理化这个
失效模式,供后续 QA 节点召回。

## 4. 验证方式(实现节点)

- **删除的完整性**:`rg "migrate-fly2103|fly2103-project-flag-migration"` 全仓
  零命中(docs 与 milestone 历史记录除外,逐条列出);带时间戳的三 root sweep
  证据进 PR body。
- **fly1436 测试改写**:先改断言目标 → RED(runbook 未建)→ 建 runbook → GREEN
  (TDD 顺序;其余为纯删除与纯文档,无新增生产代码,无新增单测面)。
- **全仓门禁**:`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`
  (注意 teamlead 整包失败即停的假绿坑,逐包核对照跑)+ 
  `bash scripts/__tests__/fly2103-project-config-generators.test.sh`(确认保留的
  generator 套件不受影响)。
- **codex-code-review** 循环至 APPROVED;PR 走正常流,milestone 新文件
  `engineering/doc/milestones/FLY-2166.md`。

## 5. 悬而未决 → 交实现节点/评审的点

- fly1436 断言 (b) 指向 runbook 还是直接删:本文取「指向 runbook」,评审可推翻。
- 守则文档要不要在 CLAUDE.md 的 Onboarding Reference 列表加一行指针:本文取
  **不加**(CLAUDE.md 是高冲突共享写点,守则按需被 grep 到即可),评审可推翻。
- runbook 完成后由 Lead 转挂 FLY-2103 thread 的时序:必须在删除 PR merge 之前
  完成挂载,避免维护窗操作者按旧 PR body 找脚本扑空(设计已在 plan 里写死:
  DONE 报告里附 runbook 路径,由 Tadashi 转发)。
