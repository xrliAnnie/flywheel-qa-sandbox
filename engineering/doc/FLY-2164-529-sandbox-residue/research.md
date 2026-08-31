# FLY-2164 529 沙箱残留卡死 step 2 — 调研

Issue: FLY-2164 (https://linear.app/geoforge3d/issue/FLY-2164/529沙箱残留-qa-sandbox-main-带-fly-202-设计-fixture-残留九步演练必卡-step-2)
日期: 2026-08-31
基于: exploration.md

## 1. 精确代码路径(行号以本分支 HEAD 为准)

### stub 侧(`scripts/qa-529-generalized-stub.mjs`)
- `commitFile(path, content, message)` :213 — 写文件→`git add`→`git diff --cached
  --name-only` 为空则**跳过 commit**→`git push origin HEAD`→返回 `rev-parse HEAD`。
  跳过 commit 的分支同时服务两种情形:①合法 resume(分支已有先前提交,HEAD 领先
  main)②被毒化基线(HEAD == main tip)。二者的判别式恰好是
  `git merge-base HEAD origin/main` 是否等于 HEAD。
- `completeDesign(context)` :254 — design.html 内容模板只含 `${issue}` 插值,
  **与 run 无关**(静态 663 bytes)⇒ 可被残留逐字节命中。
- `completeImplement(context)` :387 — fixture md 追加
  `- attempt N: run=<runId> execution=<execId>` 行,天然 run-unique,免疫。
- `main().catch` :628 — 任何抛错写入 `state.fatal = {message, at}` 后 exit 1。
- `initialState()` :73 — **restart 时原样展开旧 state**,`fatal` 字段不清除
  ⇒ fatal 会跨重启残存。对 driver 守卫的含义:不能单凭 fatal 判死,必须联合
  「工作进程已死」;否则 crash→respawn→恢复健康的执行会被误杀。
- `selectFixtureBranch(context, issue)` 被 design/implement 各调用一次,部署测试
  `test-deploy-generalized.test.sh:534` 断言该调用串**恰好出现 2 次**,改动须保形。

### 闸侧(`packages/flywheel-comm/src/commands/complete.ts`,本 issue **不改**)
- `deriveBaseRef` :662 — `merge-base(HEAD, origin/main)`,兜底 `origin/main`。
- `collectDesignHtmlEvidence` :578 — `git diff --name-only --diff-filter=ACMR
  <base>..<head>`,无命中 → `failDesignHtmlCompletion` :622。
- 失败文案(:631,分类器要兼容的**生产原文形状**):
  `[complete] FLY-1404 founder design HTML is required before phase_design_complete:
  no committed .html exists under doc/<ISSUE>-<slug>/ in <sha>..<sha>.` + 多行
  Remediation。塌空签名 = **区间两端同一个 40 位 sha**。
- stub 把 runComm 的 stdout+stderr 合并进 fatal:实际 fatal.message 前缀为
  `design complete failed: ` 且含上述全文。

### driver 侧(`scripts/qa-529-generalized-e2e.mjs`)
- `waitFor(label, probe, timeoutMs)` :110 — **catch 吞掉 probe 抛出的一切异常**
  (:117 存入 `last` 继续轮询)⇒ 任何"probe 内抛错快败"的设计必须先给 waitFor
  加可穿透异常语义。`waitFor` 也被注入 `terminateQaSessionForA3`(lib),那里的
  probe 不抛标记异常,语义扩展对其零影响。
- step 2 等待 :759 — probe 只查 StateStore 的 `workflow_run_node`/`sessions`,
  不读 stub-state。
- `probeExecution(slotDir, commDb, executionId)` :282 — 已返回 `{stub, pidAlive,
  tmuxAlive, liveness}`,`stub.fatal` 就在里面,**守卫可直接复用**。
- `observedRunExecutionIds(db, runId)` :197 — run 内全部 execution(bound +
  current node),按 runId 隔离,无跨 run 污染 —— 守卫的枚举来源。
- A3 先例 :1043-1097 — 诊断型退出已有完整范式:先落 step evidence JSON
  (`status: "diagnosed_not_released"`),stdout 打诊断行,独立退出码
  `A3_DIAGNOSIS_EXIT = 20`,usage(:47)记载。新诊断沿用同构。

### lib 侧(`scripts/lib/qa-generalized-e2e-lib.mjs`)
- `GENERALIZED_FIXTURE_MARKER` :181 — 既有 marker 行格式
  `<!-- flywheel-qa-529-generalized run=<id> exec=<id> -->` 及身份字符校验
  (`reconcileGeneralizedFixturePrBody` :202 已实现构造+校验)。design.html 的
  run-unique 标记**复用同一格式**,不发明第二种词汇(single source of truth)。

## 2. 消费者 sweep(改动面 = 3 个脚本 + 测试 + playbook,零生产代码)

| 消费者 | 引用方式 | 影响 |
|---|---|---|
| `scripts/test-deploy.sh` :1026 | 把 stub 复制进房间 stub-bin | 新字节随新 build 生效;接口(argv/env)不变 |
| `scripts/inject-linear-issue.sh` :117 | 提示文案引用 driver 用法 | 不变 |
| `scripts/__tests__/test-deploy-generalized.test.sh` | 源码级断言(见下) | 需同步 3 处 |
| `scripts/__tests__/qa-generalized-e2e-lib.test.mjs` | lib 单测(node:test) | 新增用例 |
| `scripts/__tests__/test-auto-approve-identity.test.sh`、`test-deploy-qa-room.test.sh` | 仅路径/存在性引用 | 不变 |
| `scripts/qa-529-generalized-codex-stub.mjs` | codex CLI pane shim,不写 fixture | 不变 |
| 插件 fork / 插件缓存 | 无 `qa-529` 引用(QA 房间脚本不出仓) | 不适用;且本 issue 不删改任何 flywheel-comm 子命令,不触发 FLY-1914 sweep 义务 |

`test-deploy-generalized.test.sh` 需同步的既有断言:
1. `:534` `selectFixtureBranch(context, issue);` 计数 == 2(保形即可,预计不动)。
2. `:592` stub `--version` 精确串 `Flywheel 529 generalized persistent stub 1.0.0`
   —— 行为变更应 bump 到 `1.1.0`(让 QA 能用 `--version` 区分房间新旧字节,直接服务
   A/B 验证),断言同步。
3. `:600` 附近 playbook 断言 `恰好 14 条 pitfall` —— 新增第 15 条(本坑:症状、
   同 sha 判别口诀、诊断出口、整改),断言改 15。

## 3. 关键设计判定(带证据)

### 3.1 守卫判死条件:`fatal && !pidAlive`
- fatal 跨重启残存(§1 stub `initialState`)⇒ 单凭 fatal 会误杀恢复中的执行。
- pane 存活性不可靠(codex shim 故意保 pane 活;remain-on-exit),工作进程 pid
  才是权威 ⇒ 用 `probeExecution().pidAlive`,不用 `liveness`(它 OR 了 tmux)。
- 残余风险:pid 复用(死进程的 pid 被无关进程占用)会让守卫退回今天的行为
  (轮询直至通用超时)—— **不会更糟**,接受并写入诚实边界。

### 3.2 waitFor 穿透语义
标记异常(`error.qa529Abort === true`)在 catch 中直接重抛;其余异常保持现状
(存 last 重试)。lib 注入点(`terminateQaSessionForA3`)零影响。

### 3.3 分类器双签名
`classifyStubFatal(message)` 归类 `collapsed_baseline` 的两个触发条件:
- 生产原文签名:`/no committed \.html exists under .+ in ([0-9a-f]{40})\.\.\1(?![0-9a-f])/`
  (兼容**旧 stub 字节**的房间 —— 正是阳性对照 A 面);
- D2 稳定标记:`FLY-2164 collapsed fixture baseline`(新 stub 字节自己的诊断)。
其余非空 fatal 归 `stub_fatal`。按记忆
`feedback_membership_test_fed_a_preresolved_input_proves_nothing`:单测必须喂
**由 complete.ts 文案模板构造的原文**(而非自造字符串),并配"两端不同 sha"的
错形状对照组。

### 3.4 run-unique 标记的幂等性
同 run 重入:同 runId+exec ⇒ 内容相同 ⇒ 跳过 commit;但该 run 首次提交已把 HEAD
推离 main(`commitFile` 每次都 push,`selectFixtureBranch` 优先取
`origin/qa529-<issue>-<runId>`)⇒ 区间仍非空,闸照过。design rework(同 run 换
execution)⇒ exec 变 ⇒ 内容变 ⇒ 新 commit,同样成立。

### 3.5 D4 清理的授权与方式
- issue 明文要求清理;经沙箱 PR + 显式 `gh pr merge`(沙箱 auto-merge 行为不可依赖
  也不必依赖),不直推 main,符合 PR flow。
- 记忆 `reference_529_generalized_stub_blocked_by_fly1404_design_html` 中"别删沙箱
  main 上的文件"是对**当时未获授权的 QA runner**说的;本 issue 就是那次上报换来的
  授权载体。
- 清理只删 `doc/FLY-202-generalized-e2e/design.html` 一个文件;同仓
  `doc/FLY-202-qa-sandbox-fixture/`(FLY-202 真设计产物,180KB html 等)是**正常
  历史产物,不动**(scope discipline;它属 `doc/FLY-202-<slug>/` 模式但在 main 上
  不进 diff 区间,无害)。

## 4. QA 验证路径(供 plan 的 test evidence 章节)

- **单测**(`qa-generalized-e2e-lib.test.mjs` 新增):marker 行构造(不同 runId ⇒
  不同字节;同输入 ⇒ 稳定;匹配 `GENERALIZED_FIXTURE_MARKER`);`classifyStubFatal`
  双签名 + 错形状对照组;守卫判定函数(fatal×pidAlive 四象限)。
- **部署测**:同步 3 处断言后全绿。
- **房级阳性对照 A(复现原病)**:按记忆
  `reference_room_local_stub_patch_needs_depth_preserving_mirror` 用深度保持镜像把
  房间 stub 钉回**旧字节**(静态 design.html),`--issue FLY-202`(清理 PR 合并前
  执行)⇒ 新 driver 必须在分钟级给出 `collapsed_baseline` 诊断 + step-2 evidence +
  独立退出码,而非 15 分钟通用超时。
- **房级阴性对照 B(治愈证明)**:新 stub 字节 + `--issue FLY-202`(残留仍在时即可)
  ⇒ 九步全绿 —— 直接证明"忽略残留"结构性成立,顺带是清理前的最强证据。
- **清理后回归**:沙箱 main `git ls-tree` 确认路径消失;`--issue FLY-202` 再跑全绿。
- 529 房操作纪律沿用记忆:`reference_529_generalized_ab_run_recipe`、
  `reference_529_room_without_alerts_flag_writes_prod_alert_dirs`(Bridge 侧手工
  隔离三变量)、证据先拷后拆(`feedback_copy_evidence_before_the_action_that_destroys_it`)。
