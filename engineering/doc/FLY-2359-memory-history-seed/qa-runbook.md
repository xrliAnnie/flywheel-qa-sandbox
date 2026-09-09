# FLY-2359 记忆回流验收 — QA 路书
Issue: FLY-2359 (https://linear.app/geoforge3d/issue/FLY-2359/2355b2-记忆回流-种回去任务结束把一次性家蒸馏出的记忆汇进-agent项目)
日期: 2026-09-08
基于: plan.md

## 1. 验收边界

本路书只在 529 的 generalized、真实 Codex runner 隔离房运行。专项工具调用房内已 build 的 `StateStore`、生产 `createCodexMemorySeedSourcesLoader` 和 claude-runner 的 `admit → provision → retire` 路径；三组身份都是 Codex。它不创建 Linear 任务、不走 ship、不触碰公共 home，也不删除夹具 session 或 home。

`fixtures/` 是去敏的“蒸馏产物运输夹具”，不是从生产 memory 复制来的内容。F、Q、J 各有独立 execution、唯一 marker、`MEMORY.md`、`memory_summary.md` 和被引用的 rollout；manifest 固定每个文件的 SHA-256。另有两个同名冲突快照、无 nodeId 与坏 adapter 反向控制。工具还确定性地产生 605 个 `(flywheel, implement)` 候选：225 个非空 source、217 个唯一 snapshot、380 个 `no_memory`。

要求 1/2 的当前任务记忆由工具显式写成 Codex 原生已蒸馏格式，再走真实 retire。这证明持久存放与运输，不宣称 Codex Phase 1/2 会在给定等待时间内自动产出。GREEN 另起真实 `codex exec` 首轮证明模型可消费档案；不能用登录状态、文件“应该存在”或 fixture-only 运行替代。

## 2. GREEN：冻结 exact head 后只跑一次

从被测 Flywheel worktree 开始。先确认工作树干净并记录完整 SHA；装房后不要再产生 progress/代码提交，否则 exact-head 闸会正确判定漂移。

```bash
HEAD_SHA=$(git rev-parse HEAD)
scripts/test-deploy.sh <slot> --generalized --codex-runner --no-lead --expect-head "$HEAD_SHA"
node engineering/doc/FLY-2359-memory-history-seed/qa-memory-seed.mjs \
  --slot <slot> --expect-head "$HEAD_SHA"
```

工具必须输出 `PASS ... (none)` 且退出 0。默认会运行三个真实模型首轮；prompt 只给“最近 native distilled memory / amber river / quartz lake / juniper field”主题，不给 marker、答案或档案路径。F 首轮必须先读到 F1 的 native marker；旧 F 目标在最近 8 条之外，记录还必须显示先读有界 `index.md`，再查 `catalog.md`，最后只读匹配的 snapshot。`assertions.json` 的 `model.*.readPaths` 同时保存实际路径与字节数。

成功包位于工具打印的 slot-local evidence 目录，至少包含：

- `preflight.json`：tested SHA、Codex 版本、slot buildSha/artifactBuildSha；
- `assertions.json`：身份行、home、四条断言、规模/去重/反向控制和模型 receipt；
- `model-*.jsonl`、`model-*-last.txt`、`model-*.stderr.txt`：真实 `thread.started` / `turn.completed` 及首轮读取记录；
- 夹具 manifest：来源身份和文件哈希；RED 包另含 mutation diff 的路径与 SHA-256。

四条产品判据的机器断言映射如下：

| 产品判据 | 必须为 true 的断言与正控 |
|---|---|
| 1. implement 结束后存放点有本次条目 | `implement_storage_contains_current`；检查 canonical `(flywheel, implement)` home，而不是已知的 source 路径 |
| 2. 下一 implement 开场带上一条 | `next_implement_sees_current`；新 execution 复用同一 home，开场文件已有 marker，且没有重扫 seed loader；`model_f_reads_current_and_seed` 再证明真实首轮读到该 native marker 与旧 seed |
| 3. QA 不见 implement | `qa_excludes_implement`，同时 `qa_positive_control` 和 `model_q_isolated` 通过 |
| 4. flywheel implement 不见 joycon | `flywheel_excludes_joycon`，同时 `joycon_positive_control` 和 `model_j_isolated` 通过 |

`historical_seed_available` 还必须证明旧 F 主题不在 recent index、仍可由 catalog 找到；`scale_archive_shape` 必须是 225 sources / 217 snapshots / 380 no_memory、index 不超过 8192 bytes，并包含无 nodeId/坏 adapter 的正确 skip reason。`scale_lock_under_5s` 记录真实 loader + 发布的锁内毫秒数并要求小于 5 秒。

## 3. RED：每个变异用独立临时分支和新房

RED 不能只传一个开关。每轮都要在临时 QA 分支实际修改生产字节、把变异提交成新的 exact head，并保存非空 `git diff`。工具只允许 RED 搭配 `--fixture-only`，避免把已知错误档案交给模型；退出 0 表示指定的负控按预期失败，其他非允许断言没有意外失败。

通用步骤：

```bash
# 在独立临时 QA 分支应用且提交下面一种变异
git diff --binary <unmutated-sha>...HEAD -- packages/ > /tmp/fly2359-<mutation>.diff
MUTATED_SHA=$(git rev-parse HEAD)
scripts/test-deploy.sh <slot> --generalized --codex-runner --no-lead --expect-head "$MUTATED_SHA"
node engineering/doc/FLY-2359-memory-history-seed/qa-memory-seed.mjs \
  --slot <slot> --expect-head "$MUTATED_SHA" --fixture-only \
  --expect-red <mutation> --mutation-base <unmutated-sha> \
  --mutation-diff /tmp/fly2359-<mutation>.diff
```

工具会在房内 checkout 重新计算 `<unmutated-sha>...<MUTATED_SHA>` 的 `packages/` binary diff，并要求它与传入文件逐字节相同；还会检查该变异实际改到了下表指定的生产文件。只给一份无关 diff 不能获得 RED 通过。

每种变异必须精确命中被测生产路径：

| `<mutation>` | 临时生产变异 | RED 必须观察到 |
|---|---|---|
| `backflow-disabled` | 在 `admitCodexAgentHome` 将 `home` 暂时改回 `codexHomeDir(input.executionId, env)`，并在同一临时变异中去掉 `validateCodexAgentHomeHandle` 的 canonical-path 相等检查；这是让旧 execution-home 路径能实际跑到断言所需的最小配套，不增加回流逻辑 | 1/2 同时失败：canonical F 没有本次 marker，F2 开场也没有 F1 marker |
| `seed-disabled` | 在 `admitCodexAgentHome` 暂时跳过 `loadMemorySeedSources` / `publishCodexMemorySeed` 分支 | 旧 F 首建的 `historical_seed_available` 失败；Q/J seed 正控也可随之失败 |
| `role-leak` | 在 `loadCodexMemorySeedSources` 暂时去掉 `workflow_node_id !== identity.role` 精确过滤 | Q 被种入 F marker，`qa_excludes_implement` 失败 |
| `project-leak` | 暂时去掉 `getProjectSessions(project)` 的 SQL project 约束，并去掉 loader 的 `project_name !== identity.project` 二次过滤 | J 被种入 F，`flywheel_excludes_joycon` 失败 |

变异不得留在最终分支。每轮拆房、恢复未变异提交、换新 slot 后再跑下一轮；工具发现 canonical 目标 home 已存在会拒绝复用，不能手删几条文件伪装新任务。`backflow-disabled` 是用户要求的“未接回流时 1/2 失败”证据；`seed-disabled` 独立证明 B2 的首建历史种回不是被 B1 持久家假绿。

## 4. 证据保全与拆房

先把整个 evidence 目录复制到 QA 的 durable 证据位置，再执行：

```bash
scripts/test-teardown.sh <slot>
```

teardown 非零、room identity 漂移、模型无 `thread.started`/`turn.completed`、任一 GREEN 跳过、只有 fixture-only、或者只跑 unit test，都不能报告四条通过。RED 与 GREEN 必须分别记录 exact SHA；最后一次 GREEN 必须来自无变异的 PR exact head。

本 implement 节点只交付工具并验证参数/纯逻辑，不占房、不派发 QA。DAG QA 节点负责在真机完成上述 RED/GREEN 和保存证据。
