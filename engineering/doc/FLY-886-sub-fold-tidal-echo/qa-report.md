# FLY-886 projects.json 编排层折干净：Sub 并入 tidal-echo — QA 报告

Issue: FLY-886 (https://linear.app/geoforge3d/issue/FLY-886/org722-收尾-projectsjson-编排层折干净-删独立-sub-projectasha-挂-tidal-echo-下终态sub)
日期: 2026-07-05
基于: plan.md（本次 QA 验证 implement 阶段交付的 prep 产物是否正确、安全，是否与计划一致）

## 0. QA 范围界定（重要）

本 issue 的 implement 阶段按 plan §0 硬边界只交付 **prep**（精确 diff / apply 脚本 / repo PR / runbook），**不 apply**。真正的 D1-D4 激活（projects.json 折、Asha launchd 换轨、876 cron/plist 重指、Bridge 重启）明确留给 **founder 在场的早上激活窗口**（plan §4）执行，其终态 QA（plan §6 / D5，共 11 项，含"派一个真 Sub label issue 验路由"等需要真实运行时状态的项）只能在**那之后**做。

因此本次 QA 验证的是：**已提交在本分支上的 prep 产物（apply 脚本 + activation bundle + tidal-echo repo PR #22）是否正确、安全、与计划一致** —— 不是终态。激活 + plan §6 终态 QA 是**独立的后续步骤**，需要 founder 在场执行 runbook 后再验，不在本次范围内。这不是失败或遗漏，是计划本身的分工（避免重蹈 FLY-722 "org 层完就报 done" 的教训——本报告明确不冒充终态验证）。

## 1. 验证方法与结果

### 1.1 脚本语法与安全性

```
bash -n apply/fold-projects.sh                        → OK
bash -n activation/repoint-876-cron-content.sh        → OK
bash -n activation/repoint-876-plists.sh              → OK
bash -n activation/swap-asha-launchd.sh               → OK
bash -n activation/transform-asha-manifest.sh         → OK
```

### 1.2 Dry-run 实跑（对真实机器状态只读，默认不 `--activate` 不写入）

| 脚本 | 结果 |
|---|---|
| `apply/fold-projects.sh`（默认 dry-run） | 对真实 `~/.flywheel/projects.json` 跑出精确 diff：删 `sub` 整条 + Asha lead 逐字段平移进 `tidal-echo.leads[]`（agentId/chatChannel/alertChannel/botTokenEnv/department/canSpawnRunners/model/match.labels 全部匹配 plan §2.1）+ `memoryAllowedUsers` 并入 `sub-lead`/`sub`。**跑后复核真实文件未变**（sub 仍存在、tidal-echo leads 仍 2 个、无 `.bak-fly886-*` 残留）。 |
| `transform-asha-manifest.sh`（dry-run） | 打印出的新 manifest 字段与旧 manifest（`sub-sub-lead.json`）逐一核对：`workspace`/`botTokenEnv`/`model`/`leadBackend` 原样保留，只改 `projectName`/`projectDir`，`pid` 已去除。跑后确认 `manifests/` 目录无残留临时文件。 |
| `swap-asha-launchd.sh`（dry-run） | 正确识别前置条件缺失（新 manifest 不存在、`tidal-echo/.lead/sub-lead/identity.md` 不存在）并 WARN（非 `--activate` 时不 BLOCK），打印精确的 uninstall/archive/install 命令序列。 |
| `repoint-876-plists.sh`（dry-run） | 正确读出真实 6 个 plist 现状（均指向 `~/Dev/sub/content/scripts`），打印精确 EDIT 计划；因 `~/Dev/tidal-echo/sub` 尚未 pull 出现 WARN（预期行为，正确识别前置条件未满足）。 |
| `repoint-876-cron-content.sh`（dry-run） | 因 `~/Dev/tidal-echo/sub/content/scripts` 目录不存在（tidal-echo PR #22 尚未 merge+pull），脚本按设计 `refusing:` 拒绝执行并退出 1 —— fail-closed 行为符合预期，非缺陷。 |

**结论**：全部 5 个脚本行为与文档描述、plan.md 规格完全一致；默认 dry-run 对真实系统零副作用；`--activate` 路径未被触发（也不应在本次触发）。

### 1.3 硬边界核验（"今晚不 apply" 是否被诚实遵守）

```
真实 ~/.flywheel/projects.json:  sub project 仍独立存在（1 个），tidal-echo.leads 仍为 2 个（Triton+Ariel）
真实 ~/.flywheel/manifests/:      只有 sub-sub-lead.json，无 tidal-echo-sub-lead.json
真实 LaunchAgents/:               6 个 sub/growth plist 均在，均无 -fly886- 备份后缀
真实 ~/Dev/tidal-echo/:           无 sub/ 子树、无 .lead/sub-lead/（PR #22 尚未 merge+pull）
```

confirmed：implement 阶段的 commit message 声明"real state untouched"属实，无任何提前 apply 的痕迹。

### 1.4 D2（tidal-echo repo PR #22）内容校验 —— 用真实生产代码验证，非目检

PR https://github.com/xrliAnnie/tidal-echo/pull/22（OPEN, MERGEABLE）改动 3 个文件，与 plan §3 规格逐项核对：

1. **`.flywheel/config.yaml`**：新增 `sub-content` agent，排在 `content` 之前；用本仓 `packages/config/src/ConfigLoader.ts`（tsc 编译到临时 dist，未改动仓库任何被跟踪文件）对 PR 里的实际 config.yaml 内容跑真实 `ConfigLoader.load()`：

   ```
   ConfigLoader.load() OK
   agents order: [ 'sub-content', 'content' ]
   default_agent: content
   ```

   **通过**（无 throw；agent_file 路径 `.flywheel/agents/content/sub-content-executor.md` 与 `department: content` 一致性校验通过；YAML 插入顺序确认 sub-content 排前）。

2. **AgentDispatcher 派发顺序断言**：用本仓真实 `packages/edge-worker/src/AgentDispatcher.ts`（编译后直接调用，非 mock）构造三个场景验证 plan §6.4 的断言：

   ```
   dual-label (Sub+content) dispatch -> sub-content   ✓ 期望 sub-content
   generic content-only dispatch -> content            ✓ 期望 content
   Sub-only dispatch -> sub-content                    ✓ 期望 sub-content
   ALL DISPATCH ORDER ASSERTIONS PASS
   ```

   这是本次 QA 新增的验证覆盖（implement 阶段只验证了 ConfigLoader 顺序，未实际调用 AgentDispatcher.dispatch() 模拟双标签场景）——用真实生产类而非目测 YAML 顺序，确认双标签 issue 确实会路由到 `sub-content` 而非 Ariel 的 `content`。

3. **`.flywheel/agents/content/sub-content-executor.md`**（executor 副本）：grep 全文，路径 sweep 完整 —— 除文档开头显式声明的"doc-flow 例外"（`content/doc/<ISSUE-KEY>-<slug>/` 有意留根目录）外，找不到任何遗漏的未加 `sub/` 前缀的 `content/scripts|brief|references|docs`、裸 `AGENTS.md`、裸 `.agents/` 引用。

4. **`.lead/sub-lead/identity.md`**（Asha identity 副本）：grep 全文核对语义 sweep —— 无 `generalChannel == chatChannel` 或"顶层发 #sub"类残留错误表述；唯一命中的"独立 project/standalone project"字样是**正确**的新表述句（"Sub is no longer a standalone project"），不是残留错误。频道 ID 交叉核对真实 `projects.json`：`#tidal-echo-core` = `1517041708855197908`（真实 tidal-echo.generalChannel 字段值一致 ✓）、`#sub` = `1511267947551653918`（真实 sub project 现 chatChannel/generalChannel 值一致 ✓）。

### 1.5 文档一致性

`exploration.md` → `research.md` → `plan.md` 三份文档链路完整：research.md 明确标注了对 exploration.md 三处方案的"勘误"（Codex R1/R2 反馈已并入），plan.md 是最终版本，与 apply 脚本、activation bundle、tidal-echo PR 的实际内容三方一致，无脱节。

### 1.6 Byte-compat（Lead 复核要求，2026-07-05 第二轮）

对 `apply/fold-projects.sh` 的 fold 结果做逐字段 diff，确认**除 sub 条目删除 + tidal-echo.leads[]/memoryAllowedUsers 追加外，其余字节完全不动**：

- 其余 5 个 project（geoforge3d / joycon-typeless / personal-assistant / growth / flywheel）：`diff` 零差异。
- tidal-echo 除 `leads`/`memoryAllowedUsers` 外的其余字段（`generalChannel` 等）：`diff` 零差异。
- tidal-echo 原有 2 个 lead（Triton、Ariel）：`diff` 零差异，逐字节保持。

### 1.7 活跃测试回归检查（Lead 复核要求）

本 PR 未改动任何 flywheel 仓库源码（`git diff main...HEAD --stat` 只涉及 `engineering/doc/FLY-886-sub-fold-tidal-echo/*`），因此理论上不可能引入回归；仍实跑确认：

- `packages/config`（含 `ConfigLoader.test.ts`）：**323/323 通过**。
- `packages/edge-worker`（含 `AgentDispatcher.test.ts`、`Blueprint.test.ts` 等）：**1040/1045 通过，5 个既有 skip**（与本 PR 无关）。
- `packages/teamlead` 单独隔离跑 `ProjectConfig.test.ts`（`loadProjects` 校验，`apply/fold-projects.sh` 直接依赖）：**121/121 通过**（`TMPDIR=/tmp` 隔离运行，避开下条环境噪音）。
- `packages/teamlead` 全量套件：默认环境下出现 ~28 个 `codex-lead-runtime.test.ts` 失败，报 `FLYWHEEL_CODEX_LEAD_WORKSPACE ... must not overlap ~/.flywheel` —— **已知环境性问题**（见 memory `reference_qa_codex_lead_runtime_tmpdir_overlap`：QA runner 自身 `TMPDIR` 落在 `~/.flywheel/runner-state/<exec-id>/...` 下，命中 FLY-245/350 的沙箱路径校验，与被测 PR 无关；`TMPDIR=/tmp` 隔离后这批全部消失）。`TMPDIR=/tmp` 下全量重跑两次，残余 2-3 个失败（`LeadAlertNotifier.test.ts` 一条 POST 断言、`createLeadRuntime-preflight.test.ts` 两条），两次跑失败集合不同——**flaky，非本 PR 引入**（本 PR 零源码改动，且这些失败与 `ProjectConfig`/`AgentDispatcher`/`ConfigLoader` 无关）。

**结论：无回归。**

### 1.8 876 覆盖面复核（Lead 明确要求 grep-check）—— 发现一处非阻塞性 gap

对照 `activation/repoint-876-cron-content.sh` 的 `CANDIDATES` 清单，用同一组 grep pattern 扫描 `~/Dev/sub/content/scripts/` 下**全部** `.sh`/`.py` 文件（不局限于清单内 11 个），核实清单是否遗漏活跃调用面：

- 清单覆盖的 python 文件（`growth_dr.py`/`growth_policy.py`/`dryrun_growth_wired.py`）已是全部命中项——`growth_improve.py`/`growth_learn.py`/`growth_report.py`/`growth_retro.py`/`growth_notify.py`/`growth_publish_gate.py`/`growth_backlog_ingest.py`/`growth_bind.py`/`growth_brain.py`/`growth_research_refresh.py` 均无 project/channel 引用命中，清单无遗漏。
- **发现一处 gap**：`test-sub-daily-loop-tick.sh:208`（**不在** CANDIDATES 清单内，也不是脚本注释所说的排除对象——注释只提到 `test_*.py` 命名的 python 测试文件排除在外，未提及这个 dash 命名的 shell 冒烟测试）含一条功能性 mock 断言：
  ```
  A_comm "send :: send --project sub --from sub-lead --to $GHOST"
  ```
  这条断言验证生产脚本 `sub-daily-loop-tick.sh`（**在**清单内，会被 876 sweep 改成 `--project tidal-echo`）在"parked-idle 重新接入"场景下调用 `flywheel-comm send --project sub ...`。876 sweep 完成后，生产脚本会发 `--project tidal-echo`，但这条测试断言仍写死 `--project sub` —— **sweep 之后重跑这个冒烟测试会得到假 FAIL**（测试期望值与生产实际输出不再匹配），除非同时更新这一行。
  - 非阻塞：这是**测试断言过期**，不是生产行为错误或数据丢失；生产脚本本身的行为是正确的（改指 tidal-echo 是本意）。
  - 对照检查：`test_growth_dr.py:43` 里唯一命中的 `--project sub` 是**注释**（描述测试 fixture 来源），不影响执行，符合脚本注释里"test_*.py（assertions/comments）"的排除预期；`test-sub-create-nightly-tick.sh`（另一个冒烟测试）无此问题。
  - **建议**：FLY-876 在跑 `repoint-876-cron-content.sh` 时，同步手动把 `test-sub-daily-loop-tick.sh:208` 的 `--project sub` 改成 `--project tidal-echo`（不建议放进自动 sweep 的 CANDIDATES，因为该文件是测试断言，语义上需要人读一遍再改，不宜和生产脚本走同一条自动 perl 替换）。

## 2. 结论

**PASS**（针对本次 implement 阶段实际交付的 prep 范围）：

- 5 个脚本语法正确、dry-run 行为与文档一致、对真实系统零副作用、fail-closed 前置条件检查正确触发。
- tidal-echo PR #22 的三个文件改动与 plan §3 规格完全一致，并通过真实 ConfigLoader + AgentDispatcher 代码验证（非目测），新增了双标签路由断言的实机测试覆盖。
- 硬边界（今晚不 apply/不 bootout/不重启 Bridge）确认被诚实遵守，真实系统状态零改动。
- 两个 PR（flywheel #454 / tidal-echo #22）均为 OPEN + MERGEABLE。
- Byte-compat：fold 结果对其余 5 个 project + tidal-echo 原有字段/leads 逐字节零改动（§1.6）。
- 活跃测试套件（config/edge-worker/teamlead ProjectConfig）无回归；teamlead 全量套件的残余失败已定位为已知环境噪音 + 既有 flaky，与本 PR 无关（§1.7）。
- 876 覆盖面 grep-check：python 调用面清单无遗漏；发现一处非阻塞性 gap——`test-sub-daily-loop-tick.sh:208` 需在 876 sweep 时同步手动更新（§1.8），已记录建议给 876。

**明确未验证（不在本次范围内，需 founder 在场的激活窗口之后才能验）**：
plan §6 / activation/README.md §6 列出的终态 QA 11 项（Asha 实际以 tidal-echo lead 身份在线、真实 Sub label issue 路由验证、无残留、Triton/Ariel 不受影响、记忆延续、876 夜报链路等）—— 这些需要先完成 founder 合并两个 PR + 按 runbook 实际执行 `--activate` + 批量 Bridge 重启，才具备可验证的运行时状态。本 QA 会话未执行、也不应执行任何 `--activate` 操作或 Bridge 重启（超出 QA 范围，且是不可逆/跨系统动作，需 founder 在场决策）。

**建议下一步**：本 PR（#454）+ tidal-echo PR #22 可进入 approve_to_ship 流程，由 founder 决定何时合并；合并后按 `activation/README.md` 的 runbook 在 founder 在场窗口执行激活，激活后需要**新一轮**QA（对照 plan §6 / D5 的 11 项终态清单）才能确认 FLY-886 真正 done。
