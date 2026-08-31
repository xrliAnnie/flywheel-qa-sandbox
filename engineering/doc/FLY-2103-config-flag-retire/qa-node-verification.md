# FLY-2103 project config flag 退役 — QA 节点独立验证

Issue: FLY-2103 (https://linear.app/geoforge3d/issue/FLY-2103/flagcconfigyaml-退役-9-个-project-config-flag-处置checkpointsenabled)
日期: 2026-08-29
基于: plan.md / qa.md（实施方自测报告）

## 结论：FAIL

代码本身的读点改造、fail-loud、测试与 resolver 对照都成立。**阻断项不在代码，在迁移
manifest 的事实前提**：`doc_flow` 的「4 开 2 关」是从**两棵脏工作树**读出来的，而这两个仓
`origin/main` 上提交的配置写的是**开**。本单会把一个 2026-07-02 的、未提交的 YAML 重排副作用
固化成永久策略，同时把写着「开」的那一行删掉——删掉之后这个分歧再也无法从配置恢复。

第二个阻断项：本单**没有改 Lead 规则包**，而 `default-enable-policy.md` 仍在指示每一个部门
Lead「上线一个特性就是把 `doc_flow.enabled: true` 写进项目 config.yaml」。本单落地后照做
= ConfigLoader throw → `run-infra` 该项目 setup 失败（只有一行 console.error，无告警），
该项目 start/retry 不可用。

---

## 阻断项 1（高）：迁移 manifest 来自脏工作树，与提交态相反

生产 `run-infra.ts:1001` 读的是 `<projectRoot>/.flywheel/config.yaml`——**工作树文件**。
迁移脚本 `scripts/migrate-fly2103-project-flags.ts:191` 读的是同一个路径，并把该内容的
`contentSha` 写进 G1 receipt。两者一致，所以「迁移前后运行时行为不变」这句话在**当前这一刻**
成立。问题是这个基准不是 git 里的东西。

实测（2026-08-29）：

| 项目 | 工作树（= 生产实际读到） | origin/main（提交态） | 迁移后（manifest 行） |
| --- | --- | --- | --- |
| geoforge3d | **OFF** | **ON** | OFF（无行 → registry default false） |
| growth | **OFF** | **ON** | OFF（无行 → registry default false） |
| joycon-typeless | ON | ON | ON |
| personal-assistant | ON | ON | ON |
| tidal-echo | ON | ON | ON |
| flywheel | ON | ON | ON |

- `git -C ~/Dev/GeoForge3D status --porcelain .flywheel/config.yaml` → ` M`
- `git -C ~/Dev/growth status --porcelain .flywheel/config.yaml` → ` M`
- 两个文件 mtime 都是 **2026-07-02 22:58**，diff 的主体是一次 YAML 重排
  （`labels: ["a","b"]` → `labels: [ "a", "b" ]`、注释缩进折叠、数组换行），
  `doc_flow` 整块消失是这次重排的**顺带副作用**，不是一次有意的关停提交。
  （growth 的同一棵脏树还多出一个未提交的 `roles:` 块，写死 runner
  `model: claude-sonnet-5 / effort: xhigh / backend: claude-tmux`——同样没进 git。
  这两棵树不适合当「现状」的权威来源。）

外部 config PR 与之直接冲突：

- GeoForge3D #283 从 `origin/main` 分叉，删掉的正是 `doc_flow: enabled: true`（保留
  `default_department: product`）；DB manifest 里 geoforge3d **没有 doc_flow 行**。
- growth #25 同形状（保留 `default_department: reflection`）。

也就是说，在**同一次交付内**：提交态里写着 `enabled: true` 的那一行被删除，而配对的 DB 行
不存在（= false）。以 git 为准，这是一次 ON→OFF 的静默翻转，覆盖 6 个项目里的 2 个。

放大这个风险的是 rollout 自己的步骤：`d3-rollout.mmd` 的维护窗里写着
「merge 5 个外部项目的 config 清理 PR **+ 同步 6 个主检出**」。「同步主检出」正是会清掉这两棵
脏树的操作；一旦清掉，pre-cutover receipt 里绑定的 `contentSha` 就再也无法从 git 复现，
G2 的 `auditPostDeployConfigs` 面对的也不再是 G1 审计过的那份内容。

需要做的（实施方）：
1. manifest 的每一项都改成从**提交态**（`git show origin/main:.flywheel/config.yaml`）推导，
   或至少与提交态双向对账；工作树与提交态不一致时必须停下来报出来，不能静默取工作树。
2. geoforge3d / growth 的 doc_flow 到底该是开还是关，是 founder 的判断，不是 QA 或实施方
   能替她定的——请把这两条作为显式决策项交上去，写进行集之前拿到答复。
3. G1 receipt 里除了工作树 `contentSha`，再记一个提交态的 blob sha，否则收据不可复现。

## 阻断项 2（高）：Lead 规则包仍在教 Lead 写已退役的 key

本单 `git diff --stat main...HEAD -- packages/teamlead/lead-rules-base/` 为空，规则包一行未动。
整个 `lead-rules-base/` 里也搜不到任何 flag store / `feature-flags` 的说法。

- `packages/teamlead/lead-rules-base/default-enable-policy.md:18-20`
  > **Config opt-ins** in `<your-project>/.flywheel/config.yaml` — e.g.
  > `doc_flow.enabled: true`, `proofshot.enabled: true`. These are repo changes and
  > ship in the feature's PR

  这是每个部门 Lead 的常驻规则。本单落地后照做：`ConfigLoader` throw →
  `run-infra.ts:1130` 的 per-project catch 只打一行 `console.error`（无 founder 告警）→
  该项目 RunInfra 不进 `projectRuntimes`，start/retry 静默不可用。失败模式是「Lead 遵守
  自己的规则把自己项目的派工能力关掉，且只在 Bridge 日志里可见」。
- `lead-rules-base/model-routing.md:112`、`lead-rules-base/executor-routing.md:151`
  仍把 DAG enrollment 描述成 `pipeline.dag: true`，该 key 已整块拒绝。
- `lead-rules-base/README.md:53` 同样以 `doc_flow.enabled` 举例。

参照物：实施方已经把 `529-room-playbook.md`、`setup-new-project.sh`、`setup-doc-flow.sh`、
`setup-ponytail.sh` 从旧 key 改到 scoped row，唯独漏了规则包——是遗漏，不是有意豁免。

## 次要项（低，不单独阻断）：残留的补救话术指向已不存在的 key

`packages/teamlead/src/bridge/runs-route.ts:2024`（本单修改过的文件）拒绝路径回给调用方：

> `... but pipeline.dag is disabled — restore pipeline.dag to converge it, ...`

`pipeline:` 顶层块现在整块被 ConfigLoader 拒绝，「restore pipeline.dag」已经做不到。
同文件 2130 行的 `DAG_DISPATCH_DISABLED` 文案同理。建议改成 scoped flag 的说法。

## 证据洁癖问题（非阻断）：parity 脚本硬编码 baseline commit

`qa-bridge-parity.mjs:381` 无论 `--baseline-root` 指向哪里，输出里的
`baselineCommit` 恒为 `d4e08f4a…`。我这次把 baseline 指向生产 main（`75a8d3689`，
即当前 Bridge `/health` 报的 `buildSha`），输出仍写 `d4e08f4a…`。读报告的人会以为对照的是
另一个基线。建议实际解析 baseline root 的 HEAD。

---

## 已独立复现为「通过」的部分

跑在 worktree HEAD `91076fdc7`（= PR #987 head `2b37dd595` + 我的 progress 提交，产物代码一致）。

**真实 Bridge 六项目 resolver 对照（我自己重跑，baseline 换成当前生产 main）**
`node qa-bridge-parity.mjs --baseline-root ~/Dev/flywheel --candidate-root ~/Dev/flywheel-FLY-2103`
→ `parity: true`，exact rows 恰好 7 行，无多余行。

| flag | flywheel | geoforge3d | growth | joycon-typeless | personal-assistant | tidal-echo |
| --- | --- | --- | --- | --- | --- | --- |
| doc_flow | ON | OFF | OFF | ON | ON | ON |
| pipeline_dag | ON | ON | ON | ON | ON | ON |
| pipeline_work_kind | ON | OFF | OFF | OFF | OFF | OFF |
| proofshot | OFF | OFF | OFF | OFF | OFF | OFF |
| xiaohongshu_learning | OFF | OFF | OFF | OFF | OFF | OFF |
| ponytail | OFF | OFF | OFF | OFF | OFF | OFF |
| skill_framework_split_participation | ON | ON | ON | ON | ON | ON |

注：`pipeline_dag` 六项目全 ON 不是 bug——旧语义 `dag = values.dag === undefined || values.dag === true`
（无 pipeline 块 = DAG on，FLY-1981），registry default 也是 true，一致。这也意味着这张表
**对 pipeline_dag 是不敏感的**（两臂恒 ON），它不能作为 DAG enrollment 未回归的证据。

**ConfigLoader fail-loud——拿 6 个项目的真实 config 做正反对照（我自己写的检查）**
6/6 现网 config 被新 ConfigLoader 逐一拒绝，报错点到 key：
`checkpoints.brainstorm.enabled was retired (FLY-2103) …`；
按 `stripRetiredKeys` 剥掉退役 key 后 6/6 全部加载成功，且非 flag 配置完整保留
（`doc_flow.default_department` = product/engineering/life/content 各自不变、
checkpoint 名单与 timeout 不变、`checkpoints.*.enabled` 全部消失）。

**测试**
- `packages/config` 全套：43 files / **680 passed**
- teamlead 聚焦 11 个文件（fly2103 迁移、flag-store-runtime、pipeline-config-source、
  runs-route.dag-entry、work-kind、workkind-cutover、founder-review-authority、
  project-runner-model、xiaohongshu-scheduler、flag-routes、DirectEventSink）：**203 passed**
- edge-worker（fly205 doc-flow / fly1356 skill-framework / fly1188 codex-prompt）：**90 passed**
- flywheel-cli init scaffold：**7 passed**
- `scripts/__tests__/fly2103-project-config-generators.test.sh`：passed
- `pnpm -r build`：exit 0

**读点 sweep**
验收给的正则在生产读点层零命中；剩余命中全部是 registry 元数据、ConfigLoader 拒绝文案、
迁移审计、注释/历史 provenance，以及非 flag 字段 `plan.autoCreate`——**除了**上面阻断项 2 和
次要项列出的那几处指令性文本。

## 诚实边界（没测的）

- **529 房真 Discord N-to-N 没跑。** 本单是 Discord-capable 的（改到 `DirectEventSink`、
  `runs-route`、`founder-review-authority`、`feature-flag-render`、Blueprint 提示词）。
  按我的常驻规则，PASS 之前必须在 529 房用候选 head 起隔离 slot 跑真 Discord。这次判 FAIL、
  head 必然会变，所以我把这一轮的 529 跑留到**修复后的 head** 上做，届时它是 PASS 的前置，
  不是可选项。风险：DAG enrollment / doc_flow 注入的端到端表现目前只有单测 + resolver 快照，
  没有真会话证据。
- **迁移脚本没有对生产 DB 实跑**（连 dry-run 也没有），因为阻断项 1 会改 manifest 本身，
  现在跑等于验证一个要作废的行集。
- **外部 5 个 config PR 只核了 diff 形状**（只删本单退役 key、无运行时代码），没有在各仓
  跑 CI。
