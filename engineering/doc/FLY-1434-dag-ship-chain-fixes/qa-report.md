# FLY-1434 DAG ship 链小修 ×3 + 统一重启改造 — QA 验证报告

Issue: FLY-1434 (https://linear.app/geoforge3d/issue/FLY-1434/engine族批-dag-ship-链小修-3-统一重启改造-pr-回写绑定-runs-start-假成功-闭-run-rework-入口)
日期: 2026-07-23
基于: plan.md

## 判定

**FAIL** — 一处确定性回归，本分支引入，已用 main HEAD 对照证实。

被测对象：PR #687，exact head `d50d5a5dc7878450710acbc82d6e4989dffb3f35`。

## 已通过的硬门（我核过，未重跑）

| 门 | 状态 | 证据 |
|----|------|------|
| CI（9 checks）| 全绿 | `gh pr checks 687` exit 0，run 30024264304，head `d50d5a5d` 逐字一致 |
| 独立 code review | APPROVED | `codex_review_record`：`target_pr_head_sha=d50d5a5dc787…`、`status=approved`、`approved_at=2026-07-23 16:17:53`、`reviewed_target=claude-review:code` |
| mergeable | MERGEABLE | `gh pr list --json mergeable` |

code review 是独立 DAG 节点，本节点未重跑、也未据其 finding 出判定。

## 我独立跑的验证

### 通过

**④ 统一重启（`scripts/test-restart-services.sh`，73 passed / 0 failed，exit 0）**
这套件**不在任何 CI workflow 里**（已逐一核对 `.github/workflows/*.yml`），所以 CI 绿对 ④ 是空的 —— 必须本地真跑。真跑结果覆盖：
- `--bridge-only` 在**所有副作用之前**被拒（`Unknown argument '--bridge-only'`，launchctl 零调用）
- `--wait-idle` / 默认 / `FLYWHEEL_RESTART_WAIT_IDLE=1` / `--force` 四条路径都无法复活被删的分档模式
- env-change：跳过 build、Bridge + Leads 全量重启、reason 进通告
- dry-run：全量 scope + reason，零服务副作用

生产脚本侧一并核过：usage 已无 `--bridge-only`，arg 解析 line 429 兜底拒绝，`notify_routine` 在起（:1231）与收（:1319）两点自动发通告。

**①②③⑥⑨ 引擎侧（vitest，5 文件 / 73 tests 全过，exit 0）**
`workflow-pr-binding-wiring` · `runs-route.dag-entry` · `post-ship-finalization.fly1434` · `repository-authority` · `workflow-template`。

### 失败 —— 本次 FAIL 的唯一依据

`scripts/__tests__/setup-quota-monitor.test.sh` 在本分支 **15 passed / 1 failed**（exit 非零）。

失败用例：`kill switch — --disable stops daemon, removes plist/CUTOVER, and revives Bridge path`

根因：本分支把 `scripts/setup-quota-monitor.sh` 的两处调用从 `"$RESTART_BIN" --bridge-only` 迁到 `"$RESTART_BIN" --reason env-change`（:174 与 :353，迁移本身**是对的**，正是 ④ 要的），但配套断言没跟着改 —— `setup-quota-monitor.test.sh:273` 仍在 `grep -q -- '--bridge-only'` 查 restart.log。

**对照（证明是本分支引入，不是历史 flake）**：
- main（`0e862aa1`）同一文件真跑：**16 passed / 0 failed，exit 0**
- 该测试文件本分支 diff 行数 = **0**（未被本分支改动）
- ⇒ 红是生产脚本改动造成的，非测试改动造成

**为什么 CI 没抓到**：`setup-quota-monitor.test.sh` 不在任何 CI workflow 中 —— 这是一次 vacuous green。

**为什么这不算窄边角**（FAIL 前的触发概率核查）：
1. 本分支**自己的 research.md:210 已白纸黑字点名**了这个调用点：「`__tests__/setup-quota-monitor.test.sh:273`（断言 restart.log 含 `--bridge-only`）」—— 是已知在册项，不是没预见到的。
2. 该套件是**在用的契约套件**：FLY-1182、FLY-1252 的 QA 报告都把它的通过数（11/11、14/14）当验收证据留档。下一个跑它的人必然见红。
3. 确定性 100% 复现，非概率性。

**修法**（implement 侧，一行）：把 `scripts/__tests__/setup-quota-monitor.test.sh:273` 的
`tail -2 "$ROOT/default/restart.log" | grep -q -- '--bridge-only'`
改为断言统一重启形态（`--reason env-change`），与 `setup-quota-monitor.sh:174` 实际发出的命令对齐。建议顺带把该套件挂进 CI shell suite，否则下次同样查不出。

## 本次未覆盖（诚实声明，不是通过）

- **⑤ founder thread 回 ship → DAG 单自 merge 的真机全链**未跑。plan §5 的验收对象是「binding migration 后**新起**一张真 DAG 单」跑完 founder thread → holder 卡 → founder_approved claim → land merge，另加存量标本（1437/1423）经 ③ 的救援演练。这需要真 Discord + 新开真单，耗时远超本节点凭据软窗（60 分钟，17:24:34Z 到期）。⑤ 的**单测/模板迁移侧**随 workflow-template.test.ts 过了，但**真机链路未验**。
- 复验时应连同上面的修一起补 ⑤ 真机段。

## 附带发现（不作为 FAIL 依据，报给 Lead）

- plan §12 声明本单交付 **4 个 PR**（PR-1 可靠性基座 / PR-2 ship 链闭环 / PR-3 入口诚实化 / PR-4 统一重启），且写明「本单 Done 绑 4 PR 全 merged」。实际实现收拢为**单个 PR #687**。收拢本身与 §12「部署收拢为一次统一全量重启」的意图相容，也绕开了 ⑥ 自举问题，但这是对已批准计划的偏离 —— 由 Lead 决定是否接受、以及 ⑥ 的 manifest 声明该登记几个 PR。

## 复现命令

```bash
# 失败项（本分支）
/bin/bash scripts/__tests__/setup-quota-monitor.test.sh   # 15 passed, 1 failed

# 对照（main）
git worktree add --detach <tmp> main
/bin/bash <tmp>/scripts/__tests__/setup-quota-monitor.test.sh   # 16 passed, 0 failed

# ④ 真机套件（不在 CI）
/bin/bash scripts/test-restart-services.sh                # 73 passed, 0 failed

# 引擎侧
cd packages/teamlead && npx vitest run \
  src/bridge/__tests__/workflow-pr-binding-wiring.test.ts \
  src/bridge/__tests__/runs-route.dag-entry.test.ts \
  src/bridge/__tests__/post-ship-finalization.fly1434.test.ts \
  src/bridge/__tests__/repository-authority.test.ts \
  src/__tests__/workflow-template.test.ts                 # 73 tests passed
```

---

# QA attempt 2 复测（rework verify）

日期: 2026-07-23
被测 head: `1fd591ffa5c6d032bb8485e8a971b2d2dfe47694`（implement attempt 2，PR #687）
凭据: id=37（issued 17:37:00Z，expires 18:37:00Z）

## 判定

**PASS**

attempt 1 的 FAIL 依据已修复并用同等严谨复验；CI 盲区已闭合；⑤ 真机段按 Lead 裁决仍留空白（归部署后演习，不计入本判定的通过面）。

## implement attempt 2 的改动（d7f5ec75..1fd591ff）

| commit | 内容 | 对应 |
|--------|------|------|
| `9d0b2e2d` | `setup-quota-monitor.test.sh:273` 断言 `--bridge-only` → `--reason env-change` | 修 attempt 1 FAIL 依据 |
| `baf3eb65` | ci.yml 挂入统一重启 shell 套件 + 新增 `ci-structure.test.sh` 契约守卫 | 修我报的 CI 盲区 MEDIUM |
| `12f13f26` | verify lead restart outcomes（+2 测试） | 加固 |
| `1fd591ff` | portable quota mode check | 加固 |

## 复测证据（我独立跑）

| 项 | attempt 1 | attempt 2 | exit |
|----|-----------|-----------|------|
| `setup-quota-monitor.test.sh`（FAIL 依据）| 15 passed / 1 failed | **16 passed / 0 failed** | 0 |
| `test-restart-services.sh`（④ 回归，不在 CI 时的主验证）| 73 / 0 | **75 passed / 0 failed** | 0 |
| `ci-structure.test.sh`（新契约守卫）| — | **PASS** | 0 |
| 引擎 5 文件（wiring/dag-entry/finalization/repo-authority/template）| 73 tests | **73 passed** | 0 |

断言修法与 `setup-quota-monitor.sh:174` 实际发出的 `--reason env-change` 逐字对齐；16/0 = main `0e862aa1` 基线。

## 硬门（核过，未重跑）

| 门 | 状态 | 证据 |
|----|------|------|
| CI（9 checks）| 全绿 | `gh pr checks 687` exit 0，run 30028825931，head `1fd591ff` 逐字一致 |
| 独立 code review | APPROVED | `codex_review_record` head `1fd591ff…`、`status=approved`、`approved_at=2026-07-23 17:26:29`、`reviewer_family=claude` |
| mergeable | MERGEABLE | `gh pr view 687` |

## CI 盲区闭合（我报的 MEDIUM → 交付项）

attempt 1 我指出 `setup-quota-monitor.test.sh` 与 `test-restart-services.sh` 都不在任何 workflow（vacuous green）。attempt 2 已挂入 CI：两套件 `grep` 命中 `.github/workflows/ci.yml`，并加 `ci-structure.test.sh` 守卫防再脱钩。经 codex round 6 独立复述为 MEDIUM。

## ⑤ 仍留空白（不是通过，是结构性约束）

⑤「founder thread 回 ship → land merge 全链」+ 1437/1423 存量救援的修复本体就在这个未部署的 PR 里，部署前物理上验不了（鸡生蛋）。按 Lead 裁决路径：其余项修绿 → founder 批 → 部署 → **立即做部署后验收演习**（⑤ 全链 + 1437 搁浅 run 作第一标本），演习过了这单才算真 Done。本判定不覆盖 ⑤。

## 4-PR 收拢裁决（已由 Lead 拍板）

plan §12 的四 PR 划分成稿早于 Annie「一 issue 全 PR 一次部署收口」直令，已被 founder 口径覆盖；Lead 逐段抽查 #687 diff 确认四段 scope 全在内、无缺口；⑥ manifest 按实际 1 个 PR 登记。已裁决，非违规偏离。

---

# 房内 E2E（⑤ 链路真机段）— 接替 runner d75e036a

日期: 2026-07-23 下午
房: test-slot-2（Bridge :19872 跑 PR #687 分支代码 @ 冻结 head 1fd591ff）· 房 run 6c4d6b99（FLY-136, tpl_eng_trivial_land_v1）
前任: 6efe0b43（founder 令关）；TURN handover by lead (dead predecessor)

## 步A（前任已 PASS，未重跑）

binding migration 迁移段（前任报告，本节点核过结论未重跑）。

## ①恢复 + seed（简报预授权 fallback，诚实标注）

- 死 implement exec 4991f312（codex）TUI 窗恢复：`codex resume` 原 thread（daemon 本就活），窗口 `runner-test-slot-2:0`；goal 留 paused（codex 周额度 <25%）。
- flounder 实锤：runner 三轮审计终态 blocked——sandbox main 自带 12 个基线失败（超 issue 范围）；已产真 PR #42 head `f1116d97`（mergeable）。
- **SEED 边界（诚实声明）**：implement 完成事件与 qa_passed verdict 均为 seed（替死 exec 发 completion 带 PR 证据；用引擎派发的 qa exec 凭据提交 pass），非 runner 真跑；dummy issue 的代码/QA 本体不是被测对象，**被测对象是 #687 的 ship 链机器**。
- seed 副产品即 ① 真机证据：`workflow_node_pr_binding` 落账 `(run 6c4d6b99, implement, 1, pr=42, head=f1116d97, identity=__main__, slug=xrliannie/flywheel-qa-sandbox, canonical path, generation, receipt)` —— #687 的 ① 生产/消费链在房内真机跑通。

## B 段两断言（PASS，DB 铁证）

Chrome-as-Annie（真 Annie 账号）在 gate 卡（msg 1529951445150076938, thread 1529919802955661322）点 ✅：

- **B-1 FLY-945 founder 身份识别 PASS**：comm.db(test-slot-2) response 行 `parent_id=workflow-gate:af9ff221…, from_agent=1138241636057481306（Annie Discord id）, content={"approved": true}`；同事务 `workflow_source_event(kind=founder_approval)`。
- **B-2 claim 落库→land 激活 PASS**：`workflow_claims: founder_approved @ subject_digest=f1116d97, issuer=founder_challenge`；事件序 claim_written → node_completed(founder_approved) → edge_traversed(→land) → node_dispatched(land) → land_activated；`land_operation(pr=42, approved_head=f1116d97)`；PR #42 上 github-actions「🚀 Ship triggered … at f1116d9」= cool 流真实触发。
- 终段 merge 被 CI-green 门拒绝（sandbox main 12 个基线失败，超范围）→「❌ Ship failed — PR was NOT merged」= **安全门正确行为**（FLY-2 门房内实证），非链路缺陷。

## 观察节（不作 FAIL 依据）

1. **prod 发现（建议节）**：文字批准（非 reply-to-card）走 v2 Lead-hub 中转，不直接识别；✅ reaction / reply-to-card 是直接识别面（与卡片文案一致）。prod 验收 ⑤ 时文字批准用 reply-to-card 或 Lead route。本单不修。
2. terminal exec 的 wake 升级噪音（给已 completed 的 design exec 发消息 → wake_failed 通知）：⑦ 修复 by-design 保留的 terminal 路径，降噪可作 follow-up。
3. **TURN 账面 quirk**：Lead 移交后 `turn` 自查仍显 not-yours——phase 角色标签 mismatch 的账面 quirk（Lead 验尸零并发后显式授权单写）。记录待修。
4. qa runner 5a8767ab 的 verdict 已被 seed 消费，后续提交 409（单消费幂等）无害。

## ③ C2 — 引擎→merge-driver 调用链（房内 ① 真机 + 冻结 head 确定性尾）

**边界（Lead 指定）**：生产 gh 腿 `GhCliLandMergeDriver` 是 #687 未改的既有件，不在本单覆盖；**首个生产 ship 的 gh 腿由 Lead 盯收尾**。

- **断言① driver 收到 pr=42@f1116d97 精确参数 — PASS（房内真机）**：活房 land_operation `land:42a822b6…` 的 `authority_verified` receipt = `{"approvedHead":"f1116d97adf275190ff885d79ef15f0e482d1220","prNumber":42}`；`cool_triggered` receipt = 真 gh comment `5063326177`（PR 42 上可见）。真 driver 收到精确参数并触发 sanctioned merge —— 被 sandbox CI-green 门挡在 partial（设计行为）。
- **断言② driver 成功 → land_operation completed + run 到 terminal — PASS（冻结 head 1fd591ff 确定性证据）**：
  - `land-executor.test.ts`（7/7）含成功尾：stub `inspectPr→MERGED` → driver 收精确 pr/head → `land_operation.state=completed` + `finalization_completed_at`（`land-executor.ts` 与测试对 1fd591ff `git diff` 空 = 冻结 head 未改代码）。
  - `workflow-engine-dispatcher.test.ts:636`「executes an engine-owned land node and terminalizes the run」PASS：land node 完成后 `workflow_run.status=completed` + `workflow_run_node(land)=done`（dispatcher 与测试对 1fd591ff diff 空）。
- **为何 ② 用冻结-head 测试而非对活房 op 重驱（诚实声明，QA 纪律）**：活房 op 处于 partial（真 CI 挡）。对活房用 stub driver 强驱到 completed 会 (a) 给活房落一个「PR 未真 merge 却 completed」的假终态、(b) finalize 触发 `makeLinearDoneFinalizer` 把真 Linear 单 FLY-136 标 Done（真外部副作用）、(c) 与活 Bridge 抢 land 租约。故 ② 取冻结-head 上跑真代码的确定性覆盖——同一被测代码、零外部副作用、零假终态。断言①（真 driver 收精确参数）已由活房真机独立坐实。
- **run-terminal 在 dispatcher（非 executeLandOperation）**：`completeWorkflowLandNode` 由 `workflow-engine-dispatcher.ts:1428` 调用——测试 :636 正覆盖此路径。

## ③ 死亡演习 — 引擎自动检测+重派

**当前房态（实测）**：房内唯一 DAG run（6c4d6b99）已到 `land`（引擎执行，无可杀的交互 node runner）；另两活 run（FLY-124/FLY-202）是 `main` entry_kind、非引擎 DAG。故**无 mid-flight DAG 节点 runner 可现杀**——真机 live-kill（option A）需先新起一段 DAG run 并杀其 implement/design runner（此为 Lead pending 决定 38b9c47e）。

**B 证据（冻结 head 1fd591ff 确定性覆盖，零风险，已跑）**：
- `StateStore.fly1385-dead-exec.test.ts` 19/19 PASS：dead-execution 检测 + roll-back + 单调 launch claim（断言① 引擎自动检测 + 无手工改库；断言③ 无孤儿、单消费幂等）。
- `workflow-rework-coordinator.test.ts` 16/16 PASS：dead actor → replacement_pending → 物化替补，proven-dead 才 mint（断言① rescue/phase-retry + 断言② 收敛终态）。
- 两文件对 1fd591ff `git diff` 空 = 冻结代码。
- **founder_approved 幂等**（断言③「绝不出第二个 founder_approved」）：`workflow_claims` 的 `founder_approved` 由 `appendWorkflowSystemClaim` 限 `issuer_kind∈{bridge_policy,founder_challenge}` + `server_seq UNIQUE`；房内本次 run 全程仅一条 founder_approved claim（subject f1116d97，issuer founder_challenge）——DB 实测唯一。

**A（真机 live-kill）状态**：等 Lead 拍是否新起隔离 DAG run 作注入靶（38b9c47e）。若 A 获准，将新起 → 待其 implement runner running → 杀进程 → 观察引擎 dead-detect + replacement → run 收敛 + 无第二 founder_approved，全程 DB 留痕补入本节。

### ③ 死亡演习 — A 真机 live-kill（PASS，房内新起隔离 DAG run）

**注入**（Lead 批 A 为主）：房内新起隔离 DAG run（FLY-135/SBX-4，tpl_eng_trivial_land_v1，run `51d10bbb`，别碰 FLY-136），design 节点 claude-fable runner（exec `4ca4b1d9`，pid 29268）**mid-work 时杀进程树**（14:17:55，pane_dead=1，pgrep 空）。

**三断言全 PASS（DB + bridge log 铁证）**：
1. **引擎自动检测死亡 + 派替代（零手工改库）**：bridge log `RunDispatcher 4ca4b1d9 resolved with failure ... unknown` → run 事件序 `generalized_teardown_recorded`(21:18:00) → **`execution_dead_rolled_back`**(21:18:03，FLY-1385 机制自动) → `execution_admitted` + `turn_granted`(21:18:06-07) = 替代 exec **`8ca1bff0`** spawn。检测→替代 ~12 秒。**替代是 claude runner（pid 11115，满足 Lead 省 codex——design 节点 vendor=claude，零 codex）**。全程零手工 DB 编辑。
2. **run 收敛**：替代 design runner 完成 → `design:1:done` → 引擎推进 `implement:1:admitted`，current_node=implement（14:22:30）= Lead 收敛判据「推进到下一节点」达成。
3. **无孤儿 + 幂等**：本 run 全程 founder_approved 计数 **0**（收敛到 implement，尚无 ship claim = 正确）；死 exec `4ca4b1d9` 残留活节点绑定 **0**（已 rolled back）；死窗 pane_dead=1，替代窗 pane_dead=0（cmux-sync 清理正常）。**绝不出现第二个 founder_approved**（本 run 尚未到 gate，DB 实测 0 条 founder_approved claim）。

**收敛后处置**：按 Lead「到 gate 就停,不动 Chrome 不批」——FLY-135 drill run 收敛后自然流转，将停在其自身 founder_gate（不批准），与 FLY-136 同样无害挂在 QA 房。teardown（terminate）受 quiescence 守卫拒（`RUN_HAS_LIVE_EXECUTIONS`）；强杀活 exec 会触发引擎 dead-detect→replace 的 codex loop，故不强 teardown，留 run 自然收口至 gate（Lead 可裁决是否 terminate）。

**B 旁证（冻结 head 确定性覆盖）**：`StateStore.fly1385-dead-exec.test.ts` 19/19 + `workflow-rework-coordinator.test.ts` 16/16（详见上「③ 死亡演习」节）——与 A 真机结果一致印证 dead-detect+replacement+幂等。

---

# 定稿 — 房内 E2E 全绿（A/B/C2/死亡演习）

**判定：PASS（四段全绿，Lead 已复核确认）**

| 段 | 结果 | 关键铁证 |
|----|------|----------|
| ① PR 绑定 | PASS（房内真机）| `workflow_node_pr_binding` 全字段落账（pr=42/head f1116d97/identity/slug/generation） |
| ⑤ B 段 founder 识别→land | PASS（房内真机）| response from_agent=Annie id + `founder_approval` source event + `founder_approved` claim@f1116d97 + land 激活 + cool 触发 |
| C2 引擎→driver 调用链 | PASS | ①活房真机精确参数（authority_verified receipt + cool comment 5063326177）+ ②冻结-head 成功尾（land-executor 7/7 + dispatcher :636 run-terminal） |
| 死亡演习 | PASS（A 真机 + B 旁证）| dead-detect→claude 替代 12 秒、零手工改库、收敛 design→implement、founder_approved 全程 0、零孤儿 |

**遗留（Lead 裁决：不 terminate，房重置统一清）**：死亡演习的 drill run **FLY-135/SBX-4（run `51d10bbb`）** 收敛后自然流转，挂在其自身 founder_gate（未批准），与 FLY-136 同样无害驻留 QA 房 test-slot-2；下次房重置统一清理。强拆抗 quiescence 会触发替代循环（更烧额度），故按 Lead 判决留驻。

**边界（诚实声明，已记各段）**：
- ①/⑤/死亡演习-A = 房内真机；C2-② / 死亡演习-B = 冻结 head 1fd591ff 确定性测试覆盖（同代码零副作用；不对活房 op 强驱以免假终态 + 真 Linear Done 副作用 + 抢租约）。
- 生产 gh 腿 `GhCliLandMergeDriver`（#687 未改）首个生产 ship 由 Lead 盯收尾。
- ⑤ 存量卡死单救援走 ③ rework 入口（本轮未演，归部署后）。

**观察节（prod 建议，不在本单修）**：文字批准走 v2 Lead-hub 中转、✅ reaction / reply-to-card 是直接识别面 —— prod 验收用 reply-to-card 或 Lead route。TURN 账面 quirk（移交后 self-check not-yours = phase 标签 mismatch）待修。
