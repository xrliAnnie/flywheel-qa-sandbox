# FLY-2164 529 沙箱残留卡死 step 2 — 实施计划

Issue: FLY-2164 (https://linear.app/geoforge3d/issue/FLY-2164/529沙箱残留-qa-sandbox-main-带-fly-202-设计-fixture-残留九步演练必卡-step-2)
日期: 2026-08-31
基于: research.md(evidence)+ Codex design review round 1 反馈

## 目标 / 非目标

**目标**
1. 结构性免疫:stub 的 design.html fixture 变 run-unique,共享沙箱 main 上的任何
   残留都不可能再让提交塌空(= issue 的"忽略它"分支,治本)。
2. 阳性对照:基线塌空(或任何 stub 致死)时,driver 在分钟级给出明确诊断
   (stdout 诊断行 + step evidence JSON + 独立退出码),不再 15 分钟通用超时。
3. 清掉 qa-sandbox main 上现存的 `doc/FLY-202-generalized-e2e/design.html`,
   恢复 `--issue FLY-202` 与旧字节(1.0.0)房间的可用性,并用对照 C 证明恢复成立。

**非目标**
- 不改 `packages/`(FLY-1404 闸原样保留 —— 演练保真度的前提);零生产运行时代码。
- 不给 driver 沙箱 main 写权(被否决方案 R1/R5,见 exploration.md)。
- 不动 `doc/FLY-202-qa-sandbox-fixture/`(FLY-202 真设计历史产物,无害)。
- 不处理 step 2 的另一独立卡因(回报体超 512KB,另案)与 FLY-2158(step 8 A3)。
- 不加 stub 侧 commit 前的 merge-base 负守卫(round 1 原 C2)——评审判定为冗余机制:
  C1 已消灭新字节塌空,旧字节塌空由 FLY-1404 生产原文 + C3/C4 诊断覆盖,第二套
  签名与额外子进程调用没有独立的用户可见收益(founder 红线:只删不加)。

## 改动清单

### C1 — stub:design.html run-unique(治本)
文件:`scripts/qa-529-generalized-stub.mjs` `completeDesign`;
`scripts/lib/qa-generalized-e2e-lib.mjs`。

- lib 新增导出 `generalizedFixtureMarker(runId, executionId)`:返回
  `<!-- flywheel-qa-529-generalized run=<runId> exec=<executionId> -->`,复用
  `reconcileGeneralizedFixturePrBody` 现有的身份字符校验;并把
  `reconcileGeneralizedFixturePrBody` 内部构造 `current` 的那一行改为调用它
  (single source of truth;`GENERALIZED_FIXTURE_MARKER` 正则保持私有,
  不为测试单独导出)。
- lib 新增导出 `buildDesignFixtureHtml(issue, runId, executionId)`:纯函数,
  返回现有 design.html 模板内容,并在 `<!doctype html>` 之后插入一行
  `generalizedFixtureMarker(runId, executionId)`。`completeDesign` 改为调用它
  (模板出仓成为可单测的纯函数,"marker 真的被嵌入"由单测直接证明)。
- 幂等性(research §3.4):同 run 同 exec 重入内容相同 ⇒ 跳过 commit,但该 run
  首次提交已把 HEAD 推离 main(`commitFile` 每次 push,`selectFixtureBranch`
  优先取 `origin/qa529-<issue>-<runId>`)⇒ 区间仍非空;design rework/替换体换
  exec ⇒ 内容变 ⇒ 新 commit。均成立。
- `selectFixtureBranch(context, issue);` 调用串保形不动(部署测断言恰好 2 次)。
- stub `--version` bump:`Flywheel 529 generalized persistent stub 1.1.0`
  (QA 用它区分房间新旧字节,直接服务对照 A/B/C)。

### C3 — lib:分类器与判死决策(纯函数,单测锚点)
文件:`scripts/lib/qa-generalized-e2e-lib.mjs`。

- `classifyStubFatal(fatal)`:入参是 stub-state 的 `fatal` 对象(或 null)。
  - `fatal` 为 null/undefined ⇒ 返回 null(无事发生)。
  - `fatal.message` 匹配生产原文签名
    `/no committed \.html exists under .+ in ([0-9a-f]{40})\.\.\1(?![0-9a-f])/`
    (区间两端同 sha —— 与 complete.ts :631 实际文案对齐,覆盖旧 stub 字节的
    房间,即阳性对照 A 面)⇒
    `{ kind: "collapsed_baseline", remediation: 换 --issue / 清理沙箱 main 残留 /
    参见 FLY-2164 }`。
  - 其余一切非空 `fatal`(含 message 缺失/非字符串的畸形残留状态)⇒
    `{ kind: "stub_fatal", malformed?: true, remediation: 指向 stub-state 路径与
    bridge.log }` —— **绝不返回 null**,保证 C4 引用 `classification.kind` 恒安全。
- `stubFatalAbortDecision(input)`:纯**状态转移**函数(评审 round 2:窗口计时
  必须显式入参、观测状态必须显式回传,否则 500ms 轮询每次覆盖时间戳永远凑不满
  2s,或跨复活/换绑的陈旧观测导致伪"连续")。契约:
  - 输入 `{ executionId, fatal, pidAlive, isCurrentExecution, kind, nowMs,
    priorObservation }` —— `executionId` 是**当前节点绑定的执行体 id,由 driver
    显式传入**(评审 round 3:stub-state 的 `fatal` 只有 `{message, at}`,
    executionId 在顶层,纯函数不得依赖未声明的外部来源);
    `priorObservation = { executionId, fatalAt, firstObservedAtMs } | null`
    (driver 为**每个节点**各存一份,见 C4 —— 并发候选互不覆盖);
  - 输出恒为全形 `{ abort: boolean, nextObservation: 同形 | null }`,driver 用
    `nextObservation` 原样替换该节点的留存状态;
  - 转移规则:
    1. `fatal` 缺失 / `pidAlive` / `!isCurrentExecution` ⇒
       `{ abort: false, nextObservation: null }`(**清零**;此后同一
       `(executionId, fatal.at)` 再现要走**全新完整窗口**);
    2. `kind === "collapsed_baseline"`(确定性死因)⇒
       `{ abort: true, nextObservation: null }`,无窗口;
    3. 其余 kind,取观测元组 `(executionId, fatal.at)`(executionId 来自入参):
       - `priorObservation` 为空或元组不同 ⇒
         `{ abort: false, nextObservation: { executionId, fatalAt,
         firstObservedAtMs: nowMs } }`(开窗,记**首见**时刻);
       - 元组相同且 `nowMs - firstObservedAtMs >= 2000` ⇒
         `{ abort: true, nextObservation: null }`;
       - 元组相同但未满 2s ⇒ `{ abort: false, nextObservation: 原样保留
         (firstObservedAtMs **不刷新**) }`。

### C4 — driver:waitFor 穿透 + stub 致死守卫(远端快败)
文件:`scripts/qa-529-generalized-e2e.mjs`;`scripts/lib/qa-generalized-e2e-lib.mjs`。

- **权威模型(评审 round 1 第 1 条)**:守卫的健康权威是
  `workflow_run_node.execution_id`(每个未完成节点的**当前**执行体),
  **不是** `observedRunExecutionIds`(那是所有权账本,含不可变的历史绑定;
  已被替换的死前任会永远留在里面,step 7 的替换语义就依赖这一点)。
  守卫每次评估:读各未完成节点的当前 execution → 只对它们探测。
  abort 之前**重读一次**该节点的 execution_id,确认仍指向同一执行体;
  换绑发生 ⇒ 放弃本次 abort、**清零该节点的观测状态**,继续轮询。
- 观测状态按 `node_id` 各存一份(`Map<nodeId, observation>`),每次评估把 C3
  返回的 `nextObservation` 原样写回;`nowMs` 由守卫以 `Date.now()` 注入
  (纯函数不自取时钟,单测用假时钟)。
- `waitFor` 移入 lib(driver 与 `terminateQaSessionForA3` 注入点共用同一实现),
  catch 增加:`if (error?.qa529Abort) throw error;` 其余行为不变。
- 守卫实现(driver 内部薄壳,决策逻辑全在 C3 纯函数):
  1. 仅 stub 模式启用(`--real` 房间无 stub-state,守卫为 no-op,零额外探测);
  2. 先读 stub-state 文件;**只有** `fatal` 存在时才做 pid 检查
     (不再对每个 execution 每 500ms 全量 `probeExecution` —— CommDB 与 tmux
     探测都省掉);
  3. 判 abort ⇒ 先 `writeStep(step, title, { status: "diagnosed_stub_fatal",
     executionId, classification, fatal, pidAlive })` 落证据,再抛错
     (A3 先例:诊断先持久化);`writeStep` 自身失败不回落到通用超时 ——
     照抛 qa529Abort,附 `evidenceWriteError` 字段;
  4. 抛出的错误由 lib 纯函数 `buildStubFatalAbortError({ step, executionId,
     classification })` 构造,携带**结构化字段**
     `{ qa529Abort: true, exitCode: STUB_FATAL_DIAGNOSIS_EXIT, step,
     classification }` —— `runDrill` 出口从字段(而非解析文案)打印
     `[qa529] step <N> diagnosis: <kind>; <remediation>` 并返回 exitCode。
- 调用点:step 2/3/4、QA attempt 1 ready、step 6、step 7、QA attempt 2 ready、
  QA PASS submission 各 waitFor probe 的开头(依赖 stub 推进的全部等待;
  convergence drain 除外 —— 那里 stub 正被主动杀,fatal 不该触发快败)。
- 新常量 `STUB_FATAL_DIAGNOSIS_EXIT = 21`(类比 A3 的 20);usage 文案补一行:
  `Exit 21: a stub recorded a fatal error; the driver emitted a diagnosis instead of timing out`。

### C5 — 测试(行为测试为主,源码断言只留必须同步的)
- `scripts/__tests__/qa-generalized-e2e-lib.test.mjs` 新增(node:test / assert):
  - `generalizedFixtureMarker`:不同 runId ⇒ 不同输出;同输入 ⇒ 稳定;非法身份
    字符抛错;`reconcileGeneralizedFixturePrBody` 接受并去重同一 marker
    (格式单一来源成立,不导出私有正则)。
  - `buildDesignFixtureHtml`:输出包含 marker 行;不同 runId/exec ⇒ 字节不同;
    同输入 ⇒ 字节稳定;仍含 FLY-1404 要求的五段结构。
  - `classifyStubFatal`:喂**由 complete.ts :631 文案模板构造的生产原文**
    (同 sha 区间)⇒ `collapsed_baseline`;错形状对照组(两端不同 sha)⇒
    `stub_fatal`;畸形 fatal(message 缺失/非字符串)⇒ `stub_fatal` + malformed,
    非 null;fatal 为 null ⇒ null。
    (记忆红线:membership 测试不许只喂自造输入,必配错形状对照组。)
  - `stubFatalAbortDecision` 全象限,含评审 round 1 要求的四个场景:
    (a) 当前执行体死 + fatal ⇒ abort(collapsed_baseline 立即;generic 满窗后);
    (b) 历史死执行体带 fatal + 当前健康替换体 ⇒ 不 abort;
    (c) 同执行体 respawn 携带残存 fatal(pidAlive)⇒ 不 abort 且状态清零;
    (d) 观测窗内发生换绑(isCurrentExecution 翻转)⇒ 不 abort 且状态清零。
  - 稳定窗**假时钟**序列(评审 round 2 要求,generic kind):
    `t0`(开窗,不 abort)→ `t0+500`(firstObservedAtMs 不刷新,不 abort)→
    `t0+1999`(不 abort)→ `t0+2000`(abort);
    以及三种清零插曲(pidAlive / 换绑 / 元组变化)之后同一
    `(executionId, fatal.at)` 再现 ⇒ 拿到**全新完整窗口**而非立即 abort;
    元组变化用例还须覆盖:同一 `fatal.at`、**不同 executionId**(替换体恰好
    继承相同时间戳)⇒ 视为新元组,开新窗并记录新 id。
  - `waitFor`(移入 lib 后):普通异常吞掉重试;`qa529Abort` 异常立即重抛;
    注入 probe 验证证据写入先于抛错的次序。
  - `buildStubFatalAbortError`:结构化字段齐全(qa529Abort/exitCode/step/
    classification),文案含 kind 与 remediation。
- `scripts/__tests__/test-deploy-generalized.test.sh` 只同步两处**必须变**的断言:
  - stub `--version` 断言改 `1.1.0`;
  - playbook pitfall 计数断言 14 → 15。
  (round 1 拟新增的 `qa529Abort`/`classifyStubFatal` 源码断言撤销 —— 行为已由
  单测覆盖,源码断言是冗余面。)

### C6 — playbook 第 15 条 pitfall
文件:`doc/qa/framework/529-room-playbook.md` 表尾追加:
症状(step 2 静默超时/design 永远 running)、判别口诀(stub-state fatal 里区间
两端同 sha ⇒ 基线塌空)、新出口(driver exit 21 + step evidence 诊断)、整改
(换 `--issue`;残留清理见 FLY-2164)。

### C7 — 沙箱残留清理(操作步骤,非本仓代码;顺序强制)
- **implement 节点**:在 `xrliAnnie/flywheel-qa-sandbox` 开 **draft PR**
  (draft 状态使沙箱的 auto-merge 无法合并它 —— PR #85 证明该仓会自动合并
  非 draft PR,"PR body 里写 merge deferred"不构成机制),仅删
  `doc/FLY-202-generalized-e2e/design.html`;PR body 注明 FLY-2164;记录
  PR URL + head sha 进 progress 与本仓 PR body;**不转 ready、不合并**。
- **qa 节点**:跑对照 A/B(见验证顺序)。每次对照开跑前验证并记录:
  ① 沙箱 `origin/main` 当前 sha;② 残留文件在该 sha 上仍存在(对照 A/B)
  或已消失(对照 C);③ 清理 PR 仍是 `isDraft=true`(A/B 期间)。
  QA 只出证据与判决,**不执行合并**(QA 报缺陷、不做修复/合并的项目分工)。
- **合并操作者 = flywheel-eng-lead(明确授权的 operator)**:收到 QA 的
  A/B 证据落库报告后,核对清理 PR head 未漂移(与 implement 记录的 head sha
  一致),将 draft 转 ready 并按该 exact head 合并;随后 QA 跑清理后核验与对照 C。

## 稳定身份(stable identities)
| 身份 | 值 | 消费者 |
|---|---|---|
| 诊断退出码 | `STUB_FATAL_DIAGNOSIS_EXIT = 21` | usage 文档、QA 脚本、playbook |
| 诊断错误结构化字段 | `qa529Abort`, `exitCode`, `step`, `classification{kind,remediation}` | driver 出口、step evidence 读取方 |
| marker 行格式 | `<!-- flywheel-qa-529-generalized run=<r> exec=<e> -->`(唯一定义:lib) | design.html、PR body、私有校验正则 |
| evidence 字段 | `status: "diagnosed_stub_fatal"`, `classification.kind` | step-N.json 读取方 |
| stub 版本串 | `Flywheel 529 generalized persistent stub 1.1.0` | 部署测、房间字节鉴别 |
| 显示标签 | stdout `[qa529] step <N> diagnosis: …` | 人读诊断行 |

## 迁移与回滚
- **迁移**:无 schema/状态迁移。已建成房间跑旧字节,新字节随房间从新 build 重建
  生效(stub-bin 深度镜像);新 driver 对旧 stub 房间**向后兼容**(分类器的生产
  原文签名就是为旧字节准备的)。旧 driver + 新 stub:C1 使塌空不再发生,旧 driver
  无需认识新诊断即可受益。
- **回滚边界**:单 PR 全量 revert 即回到现状;C7 可通过 revert 沙箱清理 PR 恢复
  文件。无不可逆动作(唯一跨仓写入 = 沙箱清理 PR,本身走 PR flow 可逆)。

## 负守卫(negative guards)清单
1. C4 权威模型:历史 execution 的 fatal 永不触发 abort;abort 前重读当前绑定,
   换绑即让步(防误杀健康替换体 —— 评审 round 1 第 1 条)。
2. C3 判死:`fatal && !pidAlive && isCurrent` 联合判据 + generic 死因的二次观测
   有界恢复窗。
3. C4:evidence 先持久化再抛错;evidence 写失败不吞诊断(附 evidenceWriteError
   照抛)。
4. 分类器对未知/畸形 fatal 归 `stub_fatal`(malformed 标注)而非 null 或硬套
   `collapsed_baseline`(不过度归因,引用恒安全)。
5. 守卫仅 stub 模式启用;`--real` 房间零开销零误报。
6. pid 复用极端情形下守卫不触发,退回今天的行为(通用超时),**不会更糟**
   (诚实边界)。
7. C7:draft PR + 每次对照前的残留在位/在删核验 + exact head 合并
   (auto-merge 与 head 漂移都被显式挡住)。

## 验证顺序与证据(顺序有含义;沙箱 main sha 每步记录)
1. 单测 + 部署测:`node --test scripts/__tests__/qa-generalized-e2e-lib.test.mjs`;
   `scripts/__tests__/test-deploy-generalized.test.sh` 全绿。
2. **对照 A(复现原病,清理前)**:验残留在位 + 记录沙箱 main sha;房间 stub 钉回
   旧字节(深度保持镜像,`--version` 报 1.0.0 为凭),新 driver `--issue FLY-202`
   ⇒ 预期分钟级 exit 21、step-2 evidence `classification.kind == "collapsed_baseline"`、
   stdout 诊断行。
3. **对照 B(治愈证明,清理前)**:验残留仍在位 + 记录 sha;新 stub 字节
   (`--version` 1.1.0 为凭)+ `--issue FLY-202` ⇒ 九步全绿 exit 0 ——
   "忽略残留"结构性成立。
4. A/B 证据先拷出(step-*.json、stub-state、bridge.log —— 记忆红线:先拷后拆),
   QA 报告落库 → **flywheel-eng-lead** 核对清理 PR head 未漂移后转 ready 并合并
   → `git ls-tree origin/main`(或 `gh api …/contents`)验证路径消失 + 记录新 sha。
5. **对照 C(旧字节恢复证明,清理后)**:房间 stub 钉回 1.0.0 字节并以
  `--version` 为凭,`--issue FLY-202` 至少跑通 step 2(design 完成;跑满九步更佳)
  ⇒ 证明"删残留恢复了 1.0.0 房间",而不是又一次证明 C1。
6. 判 PASS 前拉 exact head 的 CI 结论(记忆红线:本地绿 ≠ 该头 CI 绿)。

## 诚实边界
- 本设计不阻止未来的沙箱 PR 再次把 fixture 字节合进 main(auto-merge 是沙箱自己的
  配置,不在本仓控制面)—— 但 C1 使这类残留对新字节**无害**,C3/C4 使它对旧字节
  **可诊断**,C6 使它对人**可查**。
- pid 复用窗口内守卫不触发,退化为现状(通用超时),不更糟。
- generic stub_fatal 的二次观测窗把诊断延迟约 2–4s —— 用轻微延迟换取对替换体
  换绑竞态的免疫,collapsed_baseline 不受此延迟影响。
- 不修 step 2 的 512KB 卡因、不修 FLY-2158;driver 对**非 stub 类**卡死(如 Bridge
  停摆)仍是通用超时 —— 那不是本 issue 的病。
