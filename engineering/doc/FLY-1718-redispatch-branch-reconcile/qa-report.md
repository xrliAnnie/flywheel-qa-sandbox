# FLY-1718 re-dispatch 重生对账 — 独立 QA 验收报告

Issue: FLY-1718 (https://linear.app/geoforge3d/issue/FLY-1718/re-dispatch-丢已拍板成果-fresh-start-无视-origin-同名分支open-pr从-main-另起分叉1704)
日期: 2026-08-13
基于: plan.md(§7 验收标准)

---

## 0. 判决

**PASS —— 但带一条硬性部署前置条件(见 §4.1),不是代码缺陷,是上线顺序问题。**

被验 head:`4c320bfab3881af337c808b38262f082fde4efba`(= 本地 HEAD = `origin/flywheel-FLY-1718` = PR #824 head,
出判决前重新 fetch 核对过;PR 状态 OPEN / MERGEABLE / CLEAN,CI 9/9 SUCCESS)。

四个工作包(P1 分支延续性 / P2 force-push 护栏 / P3 指令路径绑定 / P4 DOA 退避)在**真机**上都按设计工作。
P1 —— 这单的数据丢失杀手 —— 在真 Bridge 上完整复现并证伪了 FLY-1704 事故形态。

---

## 1. 真机 E2E:529 隔离房(核心证据)

用 `scripts/test-deploy.sh 2 --from-branch flywheel-FLY-1718 --lead-label Flywheel` 把**候选 head 本身**部署进
隔离 slot 2(独立 Bridge + 独立 test bot + 独立频道 + 独立 StateStore/CommDB,生产零触碰)。

活体身份核对(不是自报,是 `/health` 实测):

```
buildSha = artifactBuildSha = 4c320bfab3881af337c808b38262f082fde4efba
listener pid 85693 → /Users/xiaorongli/Dev/flywheel-FLY-1718 这份 checkout
```

### 1.1 FLY-1704 重放 —— 验收标准 §7.1 ✅

前置:在 sandbox origin 的受管分支 `project-slot-2-FLY-124` 上放一个明确标记的「round-1 已拍板成果」提交
`bd1fc01dbba602a47b1f2373b6ddda23dde63a02`(含 `ROUND1-FOUNDER-APPROVED.md`)。
slot 的 runner 起点环境变量 `FLYWHEEL_RUNNER_START_POINT=refs/remotes/origin/flywheel-FLY-1718`(= `4c320bfa`)——
**修复前的行为应当落在这里**。

真 `POST /api/runs/start`(FLY-124)后:

| 观测点 | 实测 |
|---|---|
| 新 worktree HEAD | `bd1fc01d` = **origin 受管分支 tip**,不是 `4c320bfa` |
| 已拍板成果 | `ROUND1-FOUNDER-APPROVED.md` **在 worktree 里** |
| 分支名 | `project-slot-2-FLY-124` |
| Bridge 日志 | `[continuity] project-slot-2-FLY-124 open PR inventory: #59`(真 `gh api` 查到真 open PR) |
| runner 提示词 | 见下 |

runner 真实 system prompt(`/tmp/fly1718q/flywheel-runner-prompts/18a822b3-.../append-system-prompt.md:211-214`)逐字:

```
BRANCH CONTINUITY (re-dispatch inventory reconciled):
This worktree continues origin/project-slot-2-FLY-124@bd1fc01 (open PR #59: https://github.com/xrliAnnie/flywheel-qa-sandbox/pull/59).
Before changing anything, run `git log --oneline -10` and read the existing PR description when present.
Continue on top of the preserved work. Do not force-push. No pipeline gate is skipped by this inheritance.
```

同一份提示词 242-245 行带 FORCE-PUSH GUARD 合同段;该 runner worktree 实测已配置
`core.hooksPath=~/.flywheel/state/push-guard/worktrees/<hash>/hooks` + `extensions.worktreeConfig=true`。

### 1.2 origin 无同名分支 → byte-compat 对照 —— 验收标准 §7.2 ✅

同一台活 Bridge 上派 FLY-202(sandbox origin 上**没有** `project-slot-2-FLY-202`):

```
worktree HEAD = 4c320bfab3881af337c808b38262f082fde4efba  ← 就是环境起点,与改动前一致
ROUND1 marker  = 不存在
```

一台 Bridge、两次派发、结论相反 —— 这是 A/B,不是单点。

### 1.3 探不清 → 拒发 + 残留清点 —— 验收标准 §7.3 ⚠️(8/9,见 §4.2)

把 slot repo 的 origin URL 指到一个不存在的仓库,再派同一个 issue:

```
HTTP 503 {"success":false,"code":"CONTINUITY_INDETERMINATE","retryable":true,
          "message":"branch continuity is indeterminate: ... does not appear to be a git repository"}
```

| 残留项 | 实测 |
|---|---|
| worktree 目录 | 无 ✅ |
| 本地分支 | 无 ✅ |
| StateStore `sessions` 行 | 0 → 0 ✅ |
| CommDB 预注册行 | 0 → 0 ✅ |
| `lifecycle_launch_claims` | **0 → 1(`closed`)** ❌ 见 §4.2 |

对照组:恢复 origin URL 后**同一条请求**立刻 HTTP 200,worktree HEAD = `bd1fc01d`、round-1 文件在 —— 证明
上面那条 `closed` 记账不阻断后续派发。

### 1.4 新 Bridge 端点的真实挂载 + 鉴权 —— 验收标准 §7.6 部分 ✅

| 请求 | 实测 |
|---|---|
| `POST /design-review-validation`(无 token) | 503 `bridge ingest token not configured` |
| `POST /api/doa-backoff/reset`(无 token) | 401 `unauthorized` |
| `POST /api/doa-backoff/reset`(master token + 不可解析 issue) | 409 `lifecycle root is not unambiguous` |
| `POST /actions/doa-backoff/reset`(无鉴权别名) | **404 —— 别名不存在** ✅ |

### 1.5 真 Discord 面

两次派发各建了一个真 thread,用 Discord API(不是 StateStore 自报)复核:

```
1537268499037036574  🧠规划 [F] [FLY-124] …   type=11  parent=1493080993173737583  message_count=5
1537268906060943460  🧠规划 [F] [FLY-202] …   type=11  parent=1493080993173737583  message_count=3
```

父频道是隔离的 `product-lead-test`,生产频道零触碰。

---

## 2. 组件级真机 harness(全部用编译产物 dist,不是源码 mock)

| Harness | 覆盖 | 结果 |
|---|---|---|
| `e2e1-continuity.mjs` | 真 bare origin + 真 clone + 真 `WorktreeManager.create` | **23/23** |
| `e2e2-pushguard.mjs` | 真 `WorktreeManager.create` 装护栏 + 真 `git push` | **30/30** |
| `e2e3-designgate.mjs` | 真 `flywheel-comm await-codex-gate` 子进程 + 真 StateStore + 真 loopback | **18/18** |
| `e2e4-doa.mjs` | 真 StateStore + 真 `createDoaBackoffAdmission`/`drainDoaBackoffAlerts` | **38/38** |
| `e2e5-prodshape-gate.mjs` | 生产形态 runner env 打真 slot Bridge | **3/3** |
| `e2e6-failclosed.sh` | 真 Bridge 拒发 + 残留清点 | 8/9(见 §4.2) |

关键的**前后对照**(不是只看修复后绿):

- E2E-1 S1.0b:不做 materialize 时 `git worktree add <origin sha>` **直接失败** —— 证明预检是承重的,不是装饰。
- E2E-1 S1.8/S1.9:把起点钉回 `origin/main`(修复前行为)→ HEAD 落在 main、已拍板文件消失、merge-base 证实分叉 ——
  **事故被原样复现**。
- E2E-2 C.3:`FLYWHEEL_PUSH_GUARD=0` 时**同一条 force-push 成功** —— 证明拒推是护栏干的。
- E2E-3 每条拒绝都带 `reachedServer` 断言 + 紧邻的成功对照,避免「服务器没答话」被误读成「服务器拒绝」。

### 2.1 已提交测试(在被验 head 上重跑)

```
teamlead  bridge  7 files → 104/104
teamlead  unit    7 files → 103/103
edge-worker       3 files →  89/89
flywheel-comm     1 file  →  17/17
scripts push-guard shell   →  14/14
```

> 途中我自己踩过一次假红:从 `packages/teamlead` 目录调 vitest 跑 edge-worker,4 个 push-guard 用例报
> ENOENT。查清是**测试**用 `process.cwd()` 解析 asset,**产品代码**用 module 相对 URL(`import.meta.url`),
> 产品侧不受 cwd 影响。换回包目录后 89/89。记为测试卫生 advisory(§4.5),不是缺陷。

### 2.2 突变检验(防空过绿测)

对**副本**做突变(共享 worktree 零写入),每个突变都必须让套件变红:

- push-guard shell 套件:控制组绿 + **4/4 突变全部转红**(去掉非快进拒绝 / 任意 ACK 放行 / ACK 审计改尽力而为 / 允许删远端分支)。
- continuity 模块:控制组绿 + **3/4 突变转红**(错误一律当 missing / 跳过 targeted fetch / 去掉 post-fetch sha 相等校验)。
  第 4 个(去掉 `cat-file -e`)**存活** —— 健康仓库里 fetch 成功后对象本来就在,黑盒探针无法区分。
  这条是纵深冗余,我**不声称**对它有突变覆盖。

> 这里也踩过一次:突变 harness 最初复用同一个 clone,前一次探测已经把 ref materialize 了,
> 于是三个突变全部「存活」。改成**每次探测新建 clone**后才拿到真结果。

---

## 3. 验收标准逐条对照(plan §7)

| # | 标准 | 结论 | 证据 |
|---|---|---|---|
| 1 | 重放 FLY-1704:worktree HEAD == origin tip、对象在本地、prompt 含 PR 号 | ✅ | §1.1 真 Bridge |
| 2 | origin 无同名分支 → 与 main 现状 byte-compat | ✅ | §1.2 真 Bridge 对照 |
| 3 | 断网/坏 remote → 拒发,claim/CommDB/worktree 三无残留 | ⚠️ | §1.3:worktree/CommDB/session 三项干净;`lifecycle_launch_claims` 多一条 `closed`(§4.2) |
| 4 | force-push 拒 + 审计;ACK 放行 + 审计;审计不可写 + ACK → 拒;主仓不受影响 | ✅ | §2 E2E-2 30/30 + shell 14/14 |
| 5 | 孤儿 plan_path 降级;gate 对改投/换内容/删除/未提交改动全部非零退出 | ✅ | §2 E2E-3 18/18 |
| 6 | DOA:<60s 拒带 next_eligible;同前任不涨代;释放后不永久断路;第 5 代 needs_lead + 恰一条 severe alert;privileged reset 必须 master token、loopback alias 打不到 | ✅ | §2 E2E-4 38/38 + §1.4 真挂载 |

---

## 4. 发现

### 4.1 🔴 部署硬前置:`TEAMLEAD_INGEST_TOKEN` 全机未配置,不配就 ship 会打死所有 design gate

**这不是代码缺陷** —— 代码就是 Codex R4/R5 明确要求的 fail-closed 形态。问题是它依赖的一个前置条件在这台机器上不成立。

事实(逐条可复核):

1. **[生产现状]** 活体生产 Bridge(PID 22296,port 9876)进程环境里**没有** `TEAMLEAD_INGEST_TOKEN`(只有 `TEAMLEAD_API_TOKEN`);
   `~/.flywheel/.env` 里也没有这个键。
2. **[代码链]** `Blueprint.ts:2820` → `bridgeIngestToken: process.env.TEAMLEAD_INGEST_TOKEN`;
   `TmuxAdapter.ts:468` 只有在它有值时才往 runner pane 注入 `FLYWHEEL_INGEST_TOKEN`。
   实测我自己这个生产 runner pane 以及另外 8 个活 claude 进程,`FLYWHEEL_INGEST_TOKEN` 计数全是 0。
3. **[本分支]** `await-codex-gate design` 在 `FLYWHEEL_INSTRUCTION_PATH_CHECK !== "0"`(默认)时,
   缺 `FLYWHEEL_INGEST_TOKEN` 直接 `process.exit(1)`;Bridge 侧缺 `TEAMLEAD_INGEST_TOKEN` 时 endpoint 恒 503。

真机实证(E2E-5,打的是跑候选 head 的真 slot Bridge):

```
生产形态 runner env(有 BRIDGE_URL、无 INGEST_TOKEN)
  → exit=1  [await-codex-gate] FLYWHEEL_BRIDGE_URL and FLYWHEEL_INGEST_TOKEN are required for design review validation
就算 runner 侧硬塞一个 token(Bridge 侧仍未配)
  → exit=1  [await-codex-gate] Bridge denied design review: bridge ingest token not configured
FLYWHEEL_INSTRUCTION_PATH_CHECK=0(计划里写明的回滚口)
  → exit=0  恢复 FLY-1718 之前的放行行为
```

**[合并后+部署后] 影响面**:每一个走到 `await-codex-gate design` 的 design 阶段 runner 都会硬停,
触发概率 100%,不是窄边界。

**建议的上线顺序(二选一,任一即可解除)**:

- **A(推荐)**:先配 `TEAMLEAD_INGEST_TOKEN` + 重启 Bridge,再部署本单。
  这条本来就是 Tadashi 名下的待办(#232「配 TEAMLEAD_INGEST_TOKEN(1715 ship 硬前置)」),FLY-1718 与 FLY-1715 共享同一个前置。
- **B**:先带 `FLYWHEEL_INSTRUCTION_PATH_CHECK=0` 部署(P1/P2/P4 全部照常生效,只有 P3 休眠),
  等 token 配好后再翻开。

> 计划 §4.2 的原文假设是「runner pane 实际只持有 `FLYWHEEL_INGEST_TOKEN`」。这台机器上它一个都没有 ——
> 前提本身不成立。这也是我**没有**据此判 FAIL 的原因:返工回 implement 改不出任何代码(fail-closed 是被 review
> 明确要求的),该动的是部署顺序。

### 4.2 🟡 LOW:被拒的派发每次留下一条 `closed` launch claim(与 §7.3 字面「无 lifecycle claim」不符)

真 Bridge 实测:连打 3 次坏 origin 的派发 → `lifecycle_launch_claims` 里 `closed` 行 **+3**,一次一条,不收敛。

成因:计划 §2.3 写明 pre-lifecycle 的 P1 拒绝**不应**调 `abortPreLaunch`(「此刻还没有 claim 可清」),
但实现调了(合理:它要顺带释放 P4 的 reservation),而 `onSpawnFailed → closeLaunchAndReleaseDoa`
会为这个从未启动的 executionId 落一条 `closed` 记账。

**为什么判 LOW 而不是阻断**:紧随其后的同一条派发立刻成功(HTTP 200、worktree 正确),说明它不阻断、不污染重试;
每行极小且按唯一 executionId 键。风险只是坏 remote 持续重试时该表无界增长(refusal 是 `retryable:true`)。
建议 follow-up:要么 `onSpawnFailed` 对不存在的 claim 不落行,要么把 §7.3 的验收措辞改成「无 `starting`/`active` claim」。

### 4.3 🟡 LOW:continuity 会盖掉 QA 框架自己的 `FLYWHEEL_RUNNER_START_POINT`

`FLYWHEEL_RUNNER_START_POINT` 是 `WorktreeManager.create()` 里的 env 兜底,只在 `opts.startPoint` 缺席时生效。
本单让 dispatcher 在 continuity 命中时显式传 `ctx.startPoint`,于是**env 兜底被结构性覆盖**。

生产环境该变量不设,无影响;但 **529 QA 房会受影响**:只要 sandbox origin 上残留着上一轮的
`project-slot-N-FLY-XXX`(实测 `project-slot-2-FLY-124` 就在),下一轮 QA 拿到的就是**上一轮的分支**,
而不是当前被测的 PR 分支 —— 会静默改变 QA 房测的是什么。
建议 follow-up:在 QA 框架文档里写明,或让 teardown 顺手清掉 sandbox 上的受管分支。

### 4.4 🟡 LOW(环境,非本单):`test-teardown.sh` 两次都要跑第二遍才成功

两次拆房第一次都停在
`timed out after 60s waiting for cmux mutator lease (owner mode=watch pid=52764)`,
第二次立刻成功。属 FLY-1482 的 lease handoff 面,不是 FLY-1718 引入的,但会让自动化 QA 流程看起来失败。

### 4.5 🟡 LOW(测试卫生):`WorktreeManager.test.ts` 的 push-guard 用例依赖 cwd

用例用 `process.cwd()` 拼 asset 路径,从别的包目录调 vitest 会 ENOENT 假红。
产品代码用 `import.meta.url` 相对解析,**不受影响**。CI 按包跑所以是绿的。

---

## 5. 诚实边界(没测到的,和为什么)

- **≥2 Lead 的 N-to-N 拓扑没跑成**:slot 1/3/4 当时被其它 QA run 占着(锁活、端口在听),只有 slot 2 空闲;
  `--extra-lead` 需要另一个 slot 的 bot/频道身份,借用会造成双监听。**跑成的是**:真隔离 Bridge + 真 Lead + 2 个真 Runner
  + 2 个真 Discord thread(API 复核)。
- **DOA 第 5 代的 severe alert 没有走到真 Discord**:本机 `~/.flywheel/.env` 里没有 FLY-529 的
  `TEST_ALERT_CHANNEL_ID` / `TEST_ROUNDTABLE_CHANNEL_ID`(两个镜像频道需要 founder 手建,bot 无 MANAGE_CHANNELS),
  `--alerts` / `--mode roundtable` 因此不可用。用生产频道试 = 污染生产,不做。
  **替代验证**:用真 `drainDoaBackoffAlerts` + 真 StateStore 验到「恰一条 severe/crash_loop + 二次 drain 不重发(durable receipt)」。
  真 Discord 告警投递属未验证项,风险:告警渲染/投递层若有问题不会被本轮抓到(该层本单未改动)。
- **`cat-file -e` 的突变没被杀掉**(§2.2),不声称覆盖。
- **P3 的完整正向链路(Bridge 写 manifest → 指令送达 → runner 按新 schema 写 result → 过门)在真 Bridge 上没跑通**,
  因为 §4.1 的 token 前置;正向链路是在 e2e3 的真 CLI + 真 StateStore + loopback 组合里验的。
  token 配好后建议补一次真 Bridge 的 design gate 全链。
- 生产 Bridge 全程只做只读探测(`/health`、`ps eww`),未重启、未改配置;实测跑完仍 `ok:true`、5 sessions、
  buildSha `6cdd54f0`(main)不变;其余 QA slot 端口 19871/19873/19874 监听未动。

---

## 6. 复现方式

harness 都在 `/private/tmp/claude-501/-Users-xiaorongli-Dev-flywheel-FLY-1718/05169f8d-a41c-4f0e-b034-012f76451d6e/scratchpad/`:
`e2e1-continuity.mjs` / `e2e2-pushguard.mjs` / `e2e3-designgate.mjs` / `e2e4-doa.mjs` /
`e2e5-prodshape-gate.mjs` / `e2e6-failclosed.sh` / `e2e6b-claim-growth.sh` /
`mutation-check.sh` / `mutation-continuity.mjs`。

529 房:
```
env -u FLYWHEEL_ROUNDTABLE_CHANNEL_ID … TMPDIR=/tmp/fly1718q TEST_REPLY_BY_ISSUE=1 \
  TEST_API_TOKEN=<tok> bash scripts/test-deploy.sh 2 --from-branch flywheel-FLY-1718 --lead-label Flywheel
```
(本机 runner pane 会把 `FLYWHEEL_ROUNDTABLE_CHANNEL_ID` 泄漏进 test-deploy,导致 slot Bridge 启动即
`Fatal: [roundtable] … required config missing`;必须先 unset。)

---

## 7. Founder ship 报告交付记录

已按 FLY-1463 生成并投递到 **FLY-1718 issue thread**(用 `--issue`,该路径解析不到 thread 会 404,
不会静默落回 core 频道 —— 发之前读 `reports-route.ts:398-415` 确认过):

```
url        = https://fw-reports-a53de2.vercel.app/r/2658b037c181febb1931b24c40bf5add/
messageId  = 1537274300543926434
delivered  = true
```

模板两处已知陷阱都已处理:

- 三张图**确实**由我用 `/opt/homebrew/bin/mmdc` 从本文件夹的 `.mmd` 源码现渲染成 inline SVG 后嵌入
  (不是模板自带的手绘 SVG),所以模板里「这些图由 Mermaid 源码生成」那句话现在是**真的**;
- 「529 GIF」占位灰框已换成真实观测数据做的证据图(A/B 两次派发的 worktree HEAD + Bridge 日志原文 + 拒发结果)。

四项自检 + 两条陷阱 grep 全过;hosted URL 实测 HTTP 200、`__CSP_NONCE__` 已被替换成真 nonce、
3 张 mermaid SVG 在、7 个评论框在。`publish-report` 自带的 proofshot 对已发布 URL 渲染:
console errors 0 / server errors 0。

**边界**:没能用 Claude-in-Chrome 亲自打开 hosted URL 目检。本会话 `list_connected_browsers` 断连,
`chrome-diagnose.sh` 判 `LOCAL_STATUS=READY`(native host 活、无 env override),而 Keychain
`mdat=20260813005541Z` 显示机器 Claude 账号在**本会话启动之后**才切过 —— 正是 chrome-repair 铁律 2
写明的「切号前启动的会话持旧账号 token,它看到的断连是假阴性」。按该手册,修复要 founder 做 R5
(目标 profile 点开侧边栏)且验证必须用**新会话**,两者我都做不到,故不硬试(手册明令别在这上面烧时间)。
因此评论框的持久化/清空往返也未做。
