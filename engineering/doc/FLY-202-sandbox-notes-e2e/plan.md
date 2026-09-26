# FLY-202 沙箱夹具刷新 — 实施计划
Issue: FLY-202 (https://linear.app/geoforge3d/issue/FLY-202/qa-sandbox-fixture-slot-harness-real-runner-e2e-task-do-not-pick-up)
日期: 2026-09-26
基于: research.md（同文件夹；事实以 research 现场实测为准）；Codex design review R1 反馈已折入

> **For Flywheel Runner (implement 节点):** 在当前 resident session 内逐项执行；
> 不派发 subagent；不 merge、不 approve、不请求 ship。route 由 dispatch 指定。

**Goal:** 在延续分支 `project-slot-2-FLY-202`（PR #155）上，按 **verify-then-refresh**
合同保证 `doc/qa/sandbox-notes.md` 满足 FLY-202 五步要求并与当前仓库快照一致；
把 PR #155 元数据改为夹具合同形态（这是必达结果，不是美化）；无内容差异时不制造 no-op commit；
最终 push 之后进入 **mutation freeze**（只读校验，不再改 Git 或 PR）。

**Architecture:** 只改 Markdown 与 PR 元数据。主交付物固定路径 `doc/qa/sandbox-notes.md`；
过程文档在 `engineering/doc/FLY-202-sandbox-notes-e2e/`。目录表以 `git ls-tree -d --name-only HEAD`
为准；`ls -R doc/ | head -50` 以本次 checkout 实时输出为准；§3 摘要以 README blob 为准。

**Tech Stack:** Markdown、POSIX shell、Git、GitHub CLI (`gh` 2.97)、flywheel-comm（经 `$FLYWHEEL_COMM_CLI`）

---

## 总则

- 分支：直接用 `project-slot-2-FLY-202`（= 本轮 feature branch），不另建；PR 复用 #155，不新开。
- 全部写操作限于沙箱 clone；零 `packages/` / `scripts/` 代码改动；不碰 `doc/FLY-202-qa-sandbox-fixture/`。
- **命令入口**：`flywheel-comm` 不在 PATH；一律用 `node "$FLYWHEEL_COMM_CLI" …`，从仓库根执行。
- **账本**：progress 命令会真实产生一笔 path-limited commit（只含 progress.md）。cursor 映射固定：
  Task 0 = 前置不计数；Task 1→`1/5`、Task 2→`2/5`、Task 3（含探针决定）→`3/5`、Task 4→`4/5`、
  Task 5 在最终 push **之前**写 `5/5`。标准形态：

  ```bash
  node "$FLYWHEEL_COMM_CLI" progress --exec-id "$FLYWHEEL_EXEC_ID" \
    --file engineering/doc/FLY-202-sandbox-notes-e2e/progress.md \
    --phase implement --cursor N/5 --next "<下一步>"
  ```
- 任何 push / gh 失败：重试一次；仍失败 → `node "$FLYWHEEL_COMM_CLI" ask --lead flywheel-test-2 --exec-id "$FLYWHEEL_EXEC_ID" "<原因>"` 上报后**停止**等裁决，不静默、不带病 complete。
- 临时文件放 `/tmp/fly202-*`（仓库外），避免污染工作树。

## Task 0 — 基线核对（硬前置，任何写入之前；fail-closed）

```bash
[ -z "$(git status --porcelain)" ] || { echo "DIRTY TREE"; exit 1; }     # 0a 工作树必须全净
git fetch origin main --quiet
REMOTE_OID=$(git ls-remote origin "refs/heads/$(git branch --show-current)" | cut -f1)
[ "$REMOTE_OID" = "$(git rev-parse HEAD)" ] || { echo "REMOTE BRANCH != HEAD"; exit 1; }   # 0b 远端同分支未被并发写
git rev-list --count HEAD..origin/main                                     # behind
git log --oneline origin/main..HEAD                                        # 0c 审计 ahead 内容（不是只看计数）
git diff --name-only origin/main...HEAD                                    # 0d 路径集必须全命中白名单（见文末）
```

| 情形 | 动作 |
|---|---|
| 0a/0b 任一失败 | ask Lead + 停止（不得 `git switch -C`、不得 force-push：远端分支已存在） |
| 0c 出现非本 issue 的 commit，或 0d 出现白名单外路径 | ask Lead + 停止 |
| behind=0 | 进 Task 1 |
| behind>0 | `git merge origin/main`（技术同步，不需 ship 审批）。**任何冲突** → `git merge --abort` → ask Lead → 停止；不预设选哪一边。merge 成功后重跑 0a / behind=0 / 0d 三项断言，再进 Task 1 |

验收：0a、0b、0d 全过；behind=0。

## Task 1 — 采集当前快照（cursor 1/5）

```bash
git ls-tree -d --name-only HEAD | sort > /tmp/fly202-dirs.txt      # 本轮 design 实测 17 行；以现场为准
ls -R doc/ | head -50 > /tmp/fly202-ls.txt                        # 预期 50 行
git rev-parse HEAD:packages/qa-framework/README.md > /tmp/fly202-readme-blob.txt
```

§3 摘要的**已知基线**：README blob `cd8e822ab5fd1ce1e67975c83739e78c7e5eef26`（= commit `7049f7199` 时的 README，
2026-09-13 刷新 notes 时所依据的版本）。Task 2 V3 用 blob 精确比较，不用日级时间戳。

验收：三个快照文件存在。

## Task 2 — 校验现有交付物（verify；cursor 2/5）

对 `doc/qa/sandbox-notes.md` 跑四项断言，脚本输出 `V1..V4: PASS|FAIL <reason>`。
**解析必须以精确 H2 边界分段**：§1 = 首个 `## ` 之前；§2 = `## Top-level directories` 到下一个 `## `；
§3 = `## \`packages/qa-framework/README.md\` summary` 到下一个 `## `；§4 = `## \`doc/\` listing` 到文末。

| # | 断言 | 方法 |
|---|---|---|
| V1 | §1 恰 2-3 段正文 | §1 内非空、非标题行按空行分段计数 ∈ {2,3} |
| V2 | §2 表格：首列集合 == `/tmp/fly202-dirs.txt`；名字唯一；每行描述非空 | 只在 §2 内提取 `\| \`name/\` \| desc \|`；名字去反引号与尾斜杠后 (a) `sort -u` 与快照 `diff` 为空；(b) **独立唯一性断言** `sort \| uniq -d` 无输出（原始行数 == `sort -u` 行数）；(c) `desc` trim 后长度>0 |
| V3 | §3 bullet 数 ∈ [8,12]；且当前 README blob == 已知基线 blob | 只计 §3 内 `^- ` 行；`/tmp/fly202-readme-blob.txt` == `cd8e822a…`；blob 不等即 FAIL（强制重读刷新） |
| V4 | §4 fenced `text` block 内容 == `/tmp/fly202-ls.txt` | 只在 §4 内抽取 ```` ```text ```` 块，`diff` 为空 |

分支：
- **四项全 PASS** → 不改文件、不 commit，账本 `--next "verify PASS, no refresh needed"`，进 Task 3 的探针决定步（3b）。
- **任一 FAIL** → Task 3a 只刷新失败的 section。

## Task 3 — 条件刷新 + 探针决定（cursor 3/5）

### 3a 条件刷新（只在 Task 2 有 FAIL 时）
- V1 FAIL：重写 §1 为 3 段（要点：隔离靶仓/真 Runner 无 synthetic 模式；安全爆炸半径与 slot 隔离；
  一次性基础设施、走 deploy/inject/teardown 脚本、生产不得 pick up）。
- V2 FAIL：按 `/tmp/fly202-dirs.txt` 重建表格，每目录一行英文描述；新增目录须读其内容再写描述。
- V3 FAIL：通读当前 `packages/qa-framework/README.md`（section：Architecture / Quick Start / 5-Step Protocol /
  Config Schema / Test Slot Framework FLY-115 / FLY-60 / Mirror FLY-153 / Roundtable + Alert Mirror FLY-529 /
  Contracts）后重写为 10 条，并把本 plan 的已知基线 blob 更新为当前 blob。
- V4 FAIL：用 `/tmp/fly202-ls.txt` 原样替换 fenced block（保留 `Command:` 标签行）。
- 刷新后**重跑 Task 2**，必须四项 PASS；`git diff --check` 无输出。
- 提交（notes 与 plan 同一笔，避免新 basis blob 只留在工作树）：
  ```bash
  git add doc/qa/sandbox-notes.md
  git diff --quiet -- engineering/doc/FLY-202-sandbox-notes-e2e/plan.md || git add engineering/doc/FLY-202-sandbox-notes-e2e/plan.md
  git commit -m "docs(FLY-202): refresh QA sandbox notes to current snapshot"
  [ -z "$(git status --porcelain)" ] || { echo "DIRTY AFTER REFRESH"; exit 1; }
  ```

### 3b 探针决定（**始终执行**，无论 3a 是否发生）
```bash
node "$FLYWHEEL_COMM_CLI" check ce5d3cd1-0d5c-484d-b82d-cf1a25bb622b --json
```
- 答复明确为「删」→ `git rm FLY-2182-drill.md && git commit -m "chore(FLY-202): drop FLY-2182 drill probe per Lead"`。
- pending / 保留 / 其它 → 不改。
- **决定在此冻结**：后续 PR body 按此结果生成；mutation freeze 之后到达的新答复不再在本轮处理，
  由 implement 节点在 complete 回报里注明「探针答复迟到，交下一轮/Lead」。

验收：Task 2 全 PASS；探针决定结果已记入账本 `--next`。

## Task 4 — PR #155 元数据对齐（cursor 4/5；必达）

body 写到仓库外文件 `/tmp/fly202-pr-body.md`，必含：
1. `## Linear Issue` — `FLY-202: QA sandbox fixture — slot harness real-Runner E2E task (do not pick up)` + URL。
2. `## Summary` — 五步交付物状态（verify 全 PASS 未刷新 / 刷新了哪些 section）。
3. `## Known non-contract file` — `FLY-2182-drill.md`：上一 campaign 探针；按 3b 冻结结果写「保留待 Lead/founder 决定」或「已按 Lead 指示剔除」。
4. `## Test plan` — V1–V4 断言 + 「QA 段重跑 `ls -R doc/ | head -50` 比对」+ 白名单断言。
5. 尾注 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。

```bash
gh pr edit 155 --title "docs(FLY-202): QA sandbox fixture notes — slot-2 real-Runner E2E" --body-file /tmp/fly202-pr-body.md
gh pr view 155 --json state,title,body,baseRefName,headRefName,headRefOid
```

验收：state=OPEN、baseRefName=main、headRefName=project-slot-2-FLY-202、title 已更新、body 含 `## Linear Issue`。
**失败处理**：重试一次；仍失败 → ask Lead 后停止等裁决，**不得 complete**（Goal 明确 PR 元数据是必达结果）。

## Task 5 — 冻结、最终 push、只读校验（cursor 5/5）

顺序不可调换：

1. 硬断言 `git status --porcelain` 为空；然后写账本 `5/5`（`--next "mutation freeze; final push; wait CI; complete"`）——这是最后一笔 commit。
2. `git push origin project-slot-2-FLY-202`（fast-forward）。push 命令本身的网络失败可在**此步内**重试一次；push 成功即进入 **mutation freeze：此后不再 commit、不再 push、不再 `gh pr edit`，无任何写类例外。**
3. `EXPECTED=$(git rev-parse HEAD)`；校验 `gh pr view 155 --json headRefOid --jq .headRefOid` == `$EXPECTED`；不等 → 等 10 秒重读一次（排除传播延迟）；仍不等 → ask + 停止（**不再 push**：原因可能是并发写入，须 Lead 裁决）。
4. 等 CI（`gh pr checks --watch` 在 `statusCheckRollup=[]` 时会立刻 `no checks reported` 并 exit 1，**不会等**）：
   ```bash
   for i in $(seq 1 30); do   # 有界轮询 ≤ 5 分钟
     J=$(gh pr view 155 --json headRefOid,statusCheckRollup)
     [ "$(echo "$J" | jq -r .headRefOid)" = "$EXPECTED" ] || { echo "HEAD MOVED"; exit 1; }
     [ "$(echo "$J" | jq '.statusCheckRollup | length')" -gt 0 ] && break
     sleep 10
   done
   gh pr checks 155 --watch          # rollup 非空后才调用
   ```
   超时、任一 check 失败、期间 head 改变 → ask + 停止。
5. checks 结束后再复核一次 HEAD == PR headRefOid，并 `gh pr view 155 --json files --jq '.files[].path'` 对白名单。
6. 按 dispatch 指定的 route 完成本节点并回报 PR URL；**不 merge、不 approve、不请求 ship**。

验收：HEAD == PR head；CI 绿且绑定该 head；文件全命中白名单；节点 complete 输出确认。

## PR-diff 白名单（Task 0d / Task 5.5 / QA 节点共用）

```
doc/qa/sandbox-notes.md
doc/FLY-202-qa-sandbox-fixture/**              # 上轮 preserved 设计产物
engineering/doc/FLY-202-sandbox-notes-e2e/**   # 本轮设计产物 + progress
FLY-2182-drill.md                              # 已知探针（3b 冻结为「删」后应不再出现）
```

任何 `packages/**`、`scripts/**` 等生产路径出现 = FAIL。

## 风险与对策

| 风险 | 对策 |
|---|---|
| implement 入场时 origin/main 已改 `doc/` 树 | Task 0 merge-sync 后 Task 2 V4 会 FAIL → Task 3a 合法刷新 §4 |
| 误把 no-op 当成「必须有产出」再落 commit | Task 2 全 PASS 明确跳过 commit；账本 `--next` 写明「verify PASS, no refresh needed」 |
| README 改动与 notes 同日（日级时间戳假绿） | V3 用 blob 精确比较 |
| 远端分支被并发写入 / 工作树脏 | Task 0a/0b fail-closed，ask + 停止 |
| merge 冲突误覆盖 main 新事实 | 冲突一律 abort + ask，不预设解法 |
| `gh pr edit` 失败 | 重试一次 → ask + 停止，不 complete |
| 最终 push 后再落 commit 使 HEAD 漂离绿 CI | mutation freeze：账本 5/5 在 push 前写；push 后只读 |
| Lead「删」探针答复迟到 | 3b 冻结点后不再处理，complete 回报注明 |
| QA 节点把 `FLY-2182-drill.md` 判 FAIL | 白名单 + PR body 显式声明 |

## QA 段可验证断言（handoff）

1. `doc/qa/sandbox-notes.md` 存在，V1–V4 全 PASS（QA 现场重跑 Task 1 + Task 2，含 section 边界与描述非空）。
2. PR #155 open、base=main、head == 分支 HEAD、CI 绿且绑定该 head、未 merge。
3. PR 文件全部命中白名单；零生产代码路径。
4. PR body 含 `## Linear Issue` 段与 FLY-202 URL。
