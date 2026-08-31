# FLY-2164 529 沙箱残留卡死 step 2 — 探索

Issue: FLY-2164 (https://linear.app/geoforge3d/issue/FLY-2164/529沙箱残留-qa-sandbox-main-带-fly-202-设计-fixture-残留九步演练必卡-step-2)
日期: 2026-08-31
基于: 无

## 问题陈述

共享 QA 沙箱仓 `xrliAnnie/flywheel-qa-sandbox` 的 main 上残留着
`doc/FLY-202-generalized-e2e/design.html`,其内容与 529 演练 stub
(`scripts/qa-529-generalized-stub.mjs`)为 FLY-202 生成的设计 fixture **逐字节相同**。
任何人用 `--issue FLY-202` 跑九步演练都会**静默卡死在 step 2**,15 分钟后只得到一条
通用超时,看不到真因。

这是 FLY-2103 复验 QA 发现的 pre-existing 问题(非该 PR 引入);FLY-2155 QA 已实测
确认根因链条(见记忆 `reference_529_generalized_stub_blocked_by_fly1404_design_html`)。

## 审计证据(2026-08-31 复核,全部当场重验)

1. **残留仍在**:`gh api repos/xrliAnnie/flywheel-qa-sandbox/contents/doc/FLY-202-generalized-e2e`
   → `design.html` 663 bytes,sha256 `5467b7a30a173737dce6be66e56b395ca18c0b4d2fe59d321fb9a91d07c99472`。
2. **逐字节相同**:从 `scripts/qa-529-generalized-stub.mjs` 提取 `completeDesign` 的模板、
   以 `issue=FLY-202` 渲染,sha256 与上完全一致(663 bytes)。
3. **引入途径**:沙箱 PR #85(`docs(FLY-202): refresh QA sandbox notes — slot-3 harness
   real-Runner E2E`,branch `project-slot-3-FLY-202`)于 2026-08-23 被 **`app/github-actions`
   自动合并**。该 PR 是真 Runner E2E 的伴生产物,顺带携带了 stub 的 fixture 提交。
   ⇒ **污染途径是结构性的**:任何携带 fixture 字节的沙箱 PR 被(自动)合并,该 issue 的
   后续所有轮次即被毒死。单次清理不治本。

## 卡死机制(代码级,五环)

```
selectFixtureBranch (stub:236)          从 origin/main 开 fixture 分支
  → commitFile (stub:213)               文件已在且内容相同 ⇒ git add 零暂存 ⇒ 不提交、不推
  → HEAD == origin/main tip
  → complete --route phase_design_complete
      deriveBaseRef (complete.ts:662)   merge-base(HEAD, origin/main) == HEAD
      collectDesignHtmlEvidence (:578)  区间 <sha>..<sha> 空集,无 .html
      failDesignHtmlCompletion (:622)   FLY-1404 闸 fail-closed,exit 1
  → stub main().catch (stub:628)        fatal 写入 stub-state/<exec>.json,进程退出
  → eng_design 节点永不 done
  → driver waitFor "step 2 design completion" (driver:759)
      probe 只查 DB;waitFor 的 catch (driver:117) 吞掉一切 probe 异常
  → 15 分钟通用超时,真因只躺在 stub-state 的 fatal 字段里
```

三个互相独立的缺陷叠加:

- **D-a fixture 内容静态**:`completeDesign` 的 design.html 内容只由 issue id 决定,
  与 run 无关 ⇒ 残留可以逐字节命中 ⇒ 提交塌空。(implement fixture 的 md 已含
  `run=<runId> execution=<execId>` 标记,天然免疫 —— 只有 design.html 有此病。)
- **D-b stub 无负守卫**:`commitFile` 对「零暂存且 HEAD 未领先 main」这一被毒化基线
  情形没有显式诊断,把错误留给下游闸的文案(区间两端同 sha,极难读懂)。
- **D-c driver 诊断盲区**:stub 已把死因写进 `stub-state/<exec>.json` 的 `fatal` 字段,
  driver 从头到尾不读它;`waitFor` 还把 probe 异常一律吞进重试。

## 目标(源自 issue)

1. 清掉 qa-sandbox main 的残留,**或**让 driver 起步时清理/忽略它。
2. 阳性对照:带残留时 driver 必须给出明确诊断,而不是静默卡在 step 2。

## 方案方向(推荐组合 D1+D2+D3+D4)

### D1 — fixture 免疫(治本):design.html 内容 run-unique
在 stub 生成的 design.html 中嵌入一行
`<!-- flywheel-qa-529-generalized run=<runId> exec=<execId> -->`(复用 lib 中
`GENERALIZED_FIXTURE_MARKER` 的既有格式)。runId 每轮唯一 ⇒ 残留永远不可能与新一轮
逐字节相同 ⇒ 提交必然发生 ⇒ 区间必然非空。"忽略残留"由此结构性达成,不需要 driver
去动共享 main。同轮重入(resume)时内容相同 ⇒ 跳过提交,但首次提交已把 HEAD 推离
main,区间仍非空,幂等成立。

### D2 — stub 负守卫(显式诊断,近端)
`commitFile` push 后校验 `git merge-base HEAD origin/main` ≠ HEAD;相等即抛出带稳定
标记的诊断错误(如 `FLY-2164 collapsed fixture baseline: <path> …`)。此守卫同时覆盖
design 与 implement 两个调用方;合法 resume(分支已有先前提交)HEAD 必领先 main,
不会误伤。D1 生效后此路径应不可达 —— 它是 belt-and-suspenders。

### D3 — driver 快败诊断(阳性对照,远端)
- `waitFor` 增加可穿透异常:probe 抛出带标记(如 `qa529Abort`)的错误时立即重抛,
  不再吞进重试。
- 新增守卫:对 `observedRunExecutionIds` 内每个 execution 读 `stub-state/<exec>.json`,
  发现 `fatal` 即抛穿透异常;在依赖 stub 推进的各步 probe(step 2/3/4、QA ready、
  step 6/7、QA PASS 等)开头调用。
- lib 新增分类器 `classifyStubFatal`:识别「区间两端同 sha」签名(兼容旧 stub 字节的
  FLY-1404 原文)与 D2 的稳定标记,归类为 `collapsed_baseline` 并附整改指引
  (换 `--issue` / 清理沙箱 main);其余归 `stub_fatal`。
- driver 落 step 级 evidence JSON(沿用 A3 diagnosis 先例),stdout 打明确诊断行,
  以独立退出码(拟 21,类比 A3 的 20)退出。

### D4 — 一次性清理现存残留(恢复 FLY-202 可用)
经**沙箱 PR**(非直推 main)删除 `doc/FLY-202-generalized-e2e/design.html`,显式
`gh pr merge`(不赌自动合并)。issue 明文授权此清理;它恢复 `--issue FLY-202` 与
旧字节房间的可用性,但因污染途径结构性存在,不作为唯一修复。

## 被否决的替代方案

- **R1 driver 起步时清理沙箱 main**:driver 获得共享 main 写权并在演练启动时推删除
  提交 —— 正是我们一贯拒绝的「测试基建改共享 main」越权类;并发 slot 竞态;D1 后无必要。
- **R2 selectFixtureBranch 换基线**(不从 origin/main 开):破坏 implement fixture PR
  必须以 main 为 base 的语义与 remote PR head 校验;改动半径远超收益。
- **R3 为 stub 放宽 FLY-1404 闸**(env bypass):闸是与真 runner 共享的生产 fail-closed
  代码;为测试开洞摧毁演练保真度("真控制面"是 529 的全部意义),违反只删不加红线。
- **R4 只清理不改码**:PR #85 证明自动合并会再次携带 fixture 入 main,同病必复发。
- **R5 driver 起步 preflight 查沙箱 main ls-tree**:D1 已消除该失效模式,D3 兜住其余;
  再加 preflight 属于长机制,且 driver 并无沙箱 checkout,须额外引 API 依赖。

## 影响面与边界(初判,research 阶段细化)

- 改动全部落在 `scripts/qa-529-generalized-e2e.mjs`、`scripts/qa-529-generalized-stub.mjs`、
  `scripts/lib/qa-generalized-e2e-lib.mjs` + 其测试 —— **零生产运行时代码**
  (`packages/` 不动,`complete.ts` 的闸原样保留)。
- `qa-529-generalized-codex-stub.mjs` 只是 codex CLI 的 pane shim,不写 design.html,不受影响。
- 不删改任何 flywheel-comm 子命令,不触发 FLY-1914 消费者 sweep 义务。
- 已建成房间跑的是旧字节;新字节在房间从新 build 重建后生效(记忆:stub-bin 深度镜像)。
