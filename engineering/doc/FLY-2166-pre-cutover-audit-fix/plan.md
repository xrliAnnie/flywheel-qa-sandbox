# FLY-2166 迁移审计结构性不可通过 — 实施计划

Issue: FLY-2166 (https://linear.app/geoforge3d/issue/FLY-2166/fly-2103-遗留-迁移脚本-pre-cutover-审计对真实仓库结构性不可通过g1-receipt-不可获得已手工等价完成迁移)
日期: 2026-08-29
基于: research.md

## 0. 结论先行

采用 exploration.md 方案 C:**脚本退役(净删)+ 手工 G2 runbook + 未来迁移守则**。
不修一次性脚本去追一个已手工完成的迁移;不伪造/补铸任何 G1 receipt。
纯删除 + 纯文档 + 一处测试断言改写,零新增生产代码、零新增运行时机制。

## 1. 目标 / 非目标

**目标**
1. 处置结构性不可运行的 `migrate-fly2103-project-flags.ts`(净删三文件,
   research §1.1 清单)。
2. 给 FLY-2103 剩余手工 cutover 一份可执行的 G2 runbook(纯文档,内容逐条
   转写自已批准的 plan §3 / 脚本断言 / qa.md Step 7,见 research §2)。
3. 把三条根因教训沉淀为 `doc/reference/one-shot-migration-contract.md`
   (research §3 四条)。

**非目标**
- 不执行 FLY-2103 剩余 cutover 运维(companion PR 合并、checkout 同步、
  ponytail 行写入、G2 执行)—— 归 FLY-2103 thread,本单只交 runbook。
- 不动 FLY-2103 历史文档与 milestone(append-only)。
- 不动 ConfigLoader / MetaAlertNotifier / flag store 等活机制。
- 不加任何 CI job(真仓阳性对照是 QA 流程门,CI 结构上做不了)。

## 2. 流程总览

```mermaid
graph LR
    S1["Step 1<br/>fly1436 断言改指 runbook<br/>(RED)"] --> S2["Step 2<br/>写 g2-runbook.md<br/>(GREEN)"]
    S2 --> S3["Step 3<br/>净删脚本+lib+专属单测"]
    S3 --> S4["Step 4<br/>doc/reference 守则文档"]
    S4 --> S5["Step 5<br/>全仓门禁+sweep 证据"]
    S5 --> S6["Step 6<br/>codex-code-review→PR<br/>+milestone FLY-2166.md"]
```

## 3. 实施步骤

### Step 1 — `fly1436-pr-b-assets.test.ts` 断言改写(RED 先行)

把 `:27` 一带对迁移 lib 源文本的两条 manifest 断言
(`pipeline_dag/flywheel=1`、`pipeline_work_kind/flywheel=1`)改指
`engineering/doc/FLY-2166-pre-cutover-audit-fix/g2-runbook.md`;
断言 (a)(flywheel config 无 `pipeline` 块)不变。此刻 runbook 未建 → 测试 RED。
守卫用意不变:flywheel 的 DAG/work_kind enrollment 在仓内必须有载体编码。

### Step 2 — 写 `g2-runbook.md`(GREEN)

内容 = research §2 的六节,按 Codex R1 #1–#4 补全后要点:

- **环境绑定先行**(R1 #3,转写自 receipt 的绑定字段):执行记录必须先解析并
  记下 —— 新 Bridge loopback origin、该 Bridge 实际使用的 teamlead.db
  **realpath**(并验证后续 SQL 查的就是这份 DB,不是另一份)、六 checkout 的
  HEAD/upstream SHA、各步时间戳。SQL 对一份库、写/snapshot 对另一个 Bridge
  的假 PASS 由此排除。
- 前置:5 个 companion PR 窗内 merge;六 checkout config.yaml **逐仓保全式收敛**
  (R1 #4,不得整文件 reset/commit):先备份 pre-change diff,fetch 并认出已合并
  的 companion commit,只调和 retired-key 投影,证明非 retired 内容原样保留
  (joycon-typeless 等仓的 config.yaml 内有无关未提交差异),冲突即停交操作者
  裁决;附 8 个审计类别(覆盖原 9 类 key)的逐仓 YAML-aware 核对命令
  (worktree 与刷新后的 committed 双侧)。
- **写前 preflight**(R1 #1,转写自 `planSubset` + post-deploy 六行前提):
  read-only 查 7-flag 域现状 —— 恰好 6 行 G1 manifest → 允许写第 7 行;恰好
  最终 7 行 → no-op(安全重入);**其他任何状态**(如已有 `ponytail/*=1`、缺
  G1 行、多余行)→ 停,人工裁决,不得触碰 `/stage`。
- 第 7 行写入:新 Bridge 上走 `/api/fleet/flag/stage → /apply`,runbook 给出
  **完整命令形状**(含 `Origin` 头、canonical payload 与 `confirmToken` 透传、
  任一步非 2xx 即中止)(R1 #3);actor `bridge-local-operator`,reason
  `"FLY-2103 config.yaml flag migration"`,`ponytail` / `*` / raw=`0`。
- G2-a:7-flag exact-set SQL(对已绑定的 DB realpath),期望恰好 7 行(runbook
  内嵌完整 7 行 manifest 表,即 Step 1 断言的锚文本);缺行/异值/额外行 → 停。
- G2-b:六仓 worktree+committed retired-key grep 零命中。
- G2-c(R1 #2,**不缩水已批准的 G2 合同**):承接 FLY-2103 plan §3 的完整
  Step 7 可观察面清单 —— fresh DAG dispatch、active DAG recovery(恢复不
  held)、DOC-FLOW prompt 块(4 开 2 关)、ProofShot session_params、ponytail
  resolver 全 OFF、split participation、xhs planner —— 每项给出可执行的手工
  观察步骤;`GET /api/fleet/snapshot` 7×6 对照 qa.md 基准表作为底层核对。
  某项在窗内确实无法观察时,显式记录缺口交 Lead/founder 裁决,**不得静默跳过
  或以 snapshot 代替**。
- 记录进 FLY-2103 thread;证据(SQL 输出、snapshot、stage/apply 响应、diff
  备份)**先拷后做下一步动作**,再引用。

测试 GREEN。runbook 挂载时序见 Step 6(merge 门,R1 #5)。

### Step 3 — 净删三文件

`scripts/migrate-fly2103-project-flags.ts`(362 行)、
`scripts/lib/fly2103-project-flag-migration.ts`(709 行)、
`packages/teamlead/src/__tests__/fly2103-project-flag-migration.test.ts`(326 行)。
`git rm`,不留 tombstone(git 历史 + 守则文档引用 `@49b57b3e9` 承接)。

### Step 4 — `doc/reference/one-shot-migration-contract.md`

research §3 的四条守则(真相源显式声明并先收敛 / 载具分离 / 真实环境阳性对照
是 ship 硬门,「跑过且被阻断」不算 / receipt 模式保留并引 lib 的 git SHA),
每条附 FLY-2103 实例。不改 CLAUDE.md(research §5 决定,评审可推翻)。
另写一条 feedback memory(阳性对照缺失 + 阻断合理化的失效模式)。

### Step 5 — 全仓门禁 + sweep 证据

- `pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(teamlead 整包
  失败即停假绿坑 → 逐包核对照跑)+ 保留套件
  `bash scripts/__tests__/fly2103-project-config-generators.test.sh` 单独确认。
- 带新时间戳重跑三 root 消费者 sweep(仓内 / `~/.claude/plugins/cache/*/` /
  插件 fork 源;任一 root 不可读则显式写「未检查」),证据进 PR body
  (FLY-1914 合同的类推适用)。
- `rg "migrate-fly2103|fly2103-project-flag-migration"` 全仓零命中
  (历史 docs/milestone 除外,逐条列出)。

### Step 6 — 评审与 PR

- codex-code-review(`codex:rescue` 通道)循环至 APPROVED。
- PR base=main,body 含:三 root sweep 证据(带时间戳)、删除清单、
  fly1436 改写说明、runbook/守则路径、Linear issue 链接。
- **runbook 挂载是 merge 门**(R1 #5):PR body 必含一条 evidence 项 ——
  「FLY-2103 thread 中含 runbook 路径/内容的 comment permalink」,该 permalink
  存在且经核实之前 PR 不得 merge。顺序:Step 1–2 RED/GREEN → runbook 经 Lead
  挂进 FLY-2103 thread(DONE 报告发起,拿回 permalink)→ 删除 PR 才可 merge。
- 最后一 commit:新文件 `engineering/doc/milestones/FLY-2166.md`
  (不碰 CLAUDE.md);本文件夹 docs 随分支走。
- merge 等 founder `approve_to_ship`(`verify-approval` 后由 Lead 执行);
  **merge 不触发部署**(FLY-1959),本单改动也不需要任何部署或重启。

## 4. 验收标准

1. 三文件已删,全仓引用零命中(历史文档除外,逐条列出)。
2. `fly1436-pr-b-assets.test.ts` GREEN 且仍守住 enrollment 载体。
3. `g2-runbook.md` 覆盖 Step 2 全部要点:环境绑定、保全式 checkout 收敛、
   写前 preflight(6 行→写 / 7 行→no-op / 其他→停)、完整 stage/apply 命令
   形状、G2-a/b、**完整 Step 7 可观察面清单**(非 snapshot-only)、证据先拷
   后用;7 行 manifest 表完整。
4. `one-shot-migration-contract.md` 覆盖 research §3 四条守则。
5. 全仓门禁绿(lint / build / test:packages:run 逐包核对 + generator shell 套件)。
6. PR body 含带时间戳的三 root sweep 证据。
7. **merge 门**:PR body 含 FLY-2103 thread 的 runbook comment permalink 且经
   核实;permalink 缺失时 PR 不得 merge(经 Lead 挂载,DONE 报告发起)。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| 维护窗操作者按 #987 PR body 指引找脚本扑空 | runbook permalink 是 merge 门(验收 7),挂载先于删除 merge |
| G2 前有人再写 7-flag 域内的行 → 现状漂移 | 写前 preflight:非「恰好 6 行」/「恰好 7 行」即停;G2-a 额外行同样停,不静默接受 |
| SQL 与 Bridge 各对一份 DB 的假 PASS | 环境绑定先行:记录 Bridge origin + DB realpath 并验证同一性 |
| 整文件 reset 抹掉 config.yaml 内的无关本地修改 | 保全式收敛:备份 diff、只调和 retired-key 投影、证明其余内容保留、冲突即停 |
| fly1436 文本断言对 runbook 措辞脆弱 | 断言只锚 manifest 行的字面 JSON 片段(与今天锚 lib 源码同等脆弱度,不新增) |
| 插件 fork 源 root 本地缺失 | sweep 证据显式写「该 root 检查方式/结果」,没查不得报零引用(FLY-1914) |
| 六 checkout dirty config 的班车时序风险(运维,非本单) | 已上报 Lead(message `5d11e28b`),runbook 前置节固化处理步骤 |

## 6. 部署

无。纯删除 + 文档 + 测试断言改写;不投重启票,不碰任何运行服务。
