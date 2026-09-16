# FLY-2606 独立 QA 验收报告 — 判定 FAIL（有界返工）

Issue: FLY-2606 (https://linear.app/geoforge3d/issue/FLY-2606/热生效-founder-2026-09-16-0038z改模板effort-要等重启才生效本来就有问题-工作流模板从仓库种子发布到)
日期: 2026-09-16
基于: plan.md, operator.md, verification.md

**验收头**: `ea790d24cd8780dc90a59876ee0c80c7ce5211e9`（PR #1222，验收开始与结束时 worktree HEAD 一致）
**判定**: **FAIL** — 单点缺陷，Lead reply `df6e4ec5-d78a-435b-bd14-4aea05a22294` 裁定有界返工。

---

## 1. 判定摘要

| 项 | 结果 |
|---|---|
| 模板热发布 / 回滚 / 重开保留（隔离副本真跑） | PASS |
| Lead effort 热改 → 原生 applied | PASS |
| Lead effort 热改 → 真实 turn observed | PASS |
| Lead 配置 rollback → applied | PASS |
| 精确 head CI（16/16 job） | PASS |
| 新增/触及单测与集成测试（我独立复跑 373 项） | PASS |
| **同值 no-op set → applied** | **FAIL（阻塞项）** |

---

## 2. 阻塞缺陷：同值 `lead-config set` 永不收敛

**现象**：对当前值已等于目标值的 Lead 执行 `lead-config set`，命令阻塞约 10s 后返回
`effectiveStatus=pending_runtime`（CLI exit 2），且 reconciler 每轮重试结果相同，永不到达
`applied`。若之后没有别的操作把它 supersede，这条操作就永远停在 pending。

**根因（在真 binary 上取证，不是推断）**：真 `codex app-server` 只在设置**实际发生变化**时才发
`thread/settings/updated` 通知；同值更新不发通知。而
`LeadRuntimeConfigCoordinator.applyOne` 把这条通知当作 `applied` 的**唯一**判据
（`const matched = await notification; if (!matched) return pending_runtime`）。

实测对照（`qa-artifacts/qa-native-settings-notification-probe.mjs`，真 codex-cli 0.153.2）：

| 操作 | `thread/settings/updated` 条数 |
|---|---|
| low → low（同值） | **0** |
| low → high（变更） | 1 |
| high → high（同值） | **0** |

实现体的替身 RPC 测试永远会发这条通知，所以这个缺口被藏住了——这正是本轮真 native 取证的目的。

**产品影响**：`operator.md` 的 drift 善后写了两条分支：
- 「显式运行 set（可填相同值）建立新代际」——若原生已漂离 registry，set 回 registry 值在原生层是**真实变更**，实测可用；
- 「或按实际选择写回 registry」——这条在原生层是**同值**，会永远停在 pending_runtime，**打穿**。

同时这也违背本单对 founder 的承诺：改完要有确定的完成点。

**Lead 裁定的返工范围（只此一处 + 测试）**：`applyOne` 在原生 readback 已等于目标值时直接记
`applied`（附 readback 证据），不等 `thread/settings/updated` 通知；配一条真 app-server 或
fixture 的同值回归测试。其余逻辑不动。

---

## 3. 已通过项的证据

### 3.1 模板热发布（隔离副本，真 CLI + 真 StateStore + 真 HTTP 路由，跨进程重开）

`node scripts/qa-fly2606-hot-config.mjs` 由我独立复跑，exit 0，三个阶段三个不同 PID：

- publish：revision 1 → 2，receipt `24ea4328-c4f4-4ee9-9202-70bce68daf15`，
  `runtime_build_sha=ea790d24…`，`GET /api/workflow/templates/tpl_simple_code` 与别名
  `/api/workflow-templates/…` 立即返回 revision 2；
- **run pinning**：新起的 simple_code run 快照 `template.revision=2` 且 implement 节点 effort 为新值；
  在跑的 `old-run` 快照 sha 逐字节未变；
- rollback：revision 3，`after_digest` 等于原始 manifest digest，新 run 用 revision 3；
- reopen（新进程重开同一 DB）：`current_published_revision=3` 保留手工发布版、`seed_owner=founder`
  未被种子回滚，审计 6 行。

产物：`qa-artifacts/template-acceptance.json`。全程只在 `/tmp/fly2606-acceptance-*`，未碰生产模板/DB/服务。

### 3.2 Lead 配置热生效（真 codex app-server，**非替身 RPC**）

装配：slot 隔离 HOME/registry/summary 收据/models.json/StateStore + 真
`codex app-server --strict-config`（codex-cli 0.153.2）+ 真 `NativeLeadRuntimeConfig` +
真签名 Lead inbox socket + 真 `LeadConfigRegistryWriter`/`LeadConfigRuntimeAdapter`/
`LeadConfigService` + 真 `flywheel-comm lead-config` CLI 打 loopback 路由。
两次独立复跑结论一致（`qa-artifacts/native-lead-config-run-9e.json` / `-9f.json`）。

**稳定 PID / carrier / thread / turn**（run 9e）：

- 原生进程：`/Users/xiaorongli/.local/bin/codex app-server --strict-config`，PID 90811，
  lstart `Wed Sep 16 04:16:07 2026`，窗口内 PID 稳定（另一次取证 `probe5`）；
- carrierId `8225a4a9-b0f2-4f5b-8a65-2f51e1346c12`（= socketOwnerId，adapter 已校验）；
- threadId `01a0a9ec-b4fd-7090-9321-698f80cda645`；
- turnId `01a0a9ec-e72e-7271-a717-c45e633313b7`。

**② effort 改动（low → high）**：CLI exit 0，`effectiveStatus=applied`，configGeneration 2；
真 binary `thread/read` 回读 effort=`high`。

**observed（founder 的核心判据）**：真跑一个 turn 后，
`effectiveStatus=observed`，来源 `registry_hot`，证据 `rollout_turn_context`：
rollout `…/codex-home/sessions/2026/09/16/rollout-…-01a0a9ec-….jsonl` 里
`turn_id=01a0a9ec-e72e-…, model=gpt-6-astra, effort=high, ts=2026-09-16T11:14:30.406Z`，
recordDigest `a97fd49e7b7c90b2e48b2b49258fd22a2909d853eb952bb2deb9ad42c73833a6`。
即**不重启的情况下，改动确实进了下一个真实 turn 的执行参数**。

**③ rollback**：`lead-config rollback --operation-id <②>` exit 0，`applied`，configGeneration 3；
registry 回到 `effort: low`，真 binary 回读 `low`。

**审计行**（slot StateStore）：

```
gen1 superseded "QA isolated no-op"        4 行  null→prepared→registry_committed→pending_runtime→superseded
gen2 superseded "QA isolated effort change" 6 行  …→pending_runtime→applied→observed→superseded
gen3 applied    "QA isolated rollback"      4 行  …→pending_runtime→applied
```

每行带 actor / reason / preProjectsSha / postProjectsSha / configDigest / modelRegistryRevision。

### 3.3 slot 走漏预检（起 slot 前逐项核对，2174/2284/2478 病根）

harness 启动前用 `qa-slot-env-scrub.mjs` 剥掉并重指向，断言无任何
`FLYWHEEL_*/CODEX*/TMUX*/TMPDIR` 仍指向 `~/.flywheel`，不满足即拒绝启动：

```
TMPDIR, TMUX_TMPDIR, FLYWHEEL_STATE_DIR, FLYWHEEL_RUNNER_STATE_DIR, FLYWHEEL_COMM_DB,
FLYWHEEL_CODEX_HOMES_ROOT, FLYWHEEL_CODEX_SESSION_DIR, FLYWHEEL_CODEX_DAEMON_SOCKET_ROOT
→ 全部 /tmp/fly2606-slot-9{b,e,f}/…
HOME → slot；CODEX_HOME → slot；未使用 tmux；未起 slot Bridge。
```

未改生产注册表、未重启生产 Bridge、未碰生产 Codex 舰队、未使用共享 Codex 凭据
（原生 401 websocket 属预期：本验收不需要模型请求）。

### 3.4 测试与 CI

我独立复跑（非引用实现体日志）：

| 批次 | 结果 |
|---|---|
| lead-config registry/plan/ledger/service/routes/bridge | 6 files / 44 tests pass |
| workflow template publication ×6 | 6 files / 31 tests pass |
| codex inbox socket + process + TUI runtime ×4 | 4 files / 116 tests pass |
| flywheel-comm lead-config / workflow-template CLI | 2 files / 19 tests pass |
| config model-registry | 1 file / 10 tests pass |
| lead-runtime build/tuning + workflow-menu + bridge adapter ×6 | 6 files / 52 tests pass |
| management console + fleet ×6 | 6 files / 101 tests pass |

精确 head `ea790d24c` 的 CI：16/16 job 全绿（run 35086012563）。

---

## 4. 诚实边界（未测到的部分）

- **未跑 529 房 / 真 Discord N-to-N**：本 diff 无 Discord 发送、relay、渲染或 founder 互动面的改动
  （diff 中 `discord` 字样均为既有上下文行）；改动面是 Bridge HTTP/CLI、注册表写入与 Codex Lead
  运行期设置。因此按 QA 合同记为「no N-to-N surface — 已用隔离 slot 的真 app-server 端到端验证」，
  也因此**没有 strength-two / evidence-run record**（无 `slot_529:<n>` site，绝不编造）。
- **未做浏览器视觉验收**：Fleet 管理页热配置入口本轮只有 DOM/HTML 单测覆盖（101 项），没有真实
  Chrome 截图。风险：页面渲染层面的回归测不到。建议在返工头上补一次 proofshot。
- **未验证生产容量表**：`~/.flywheel/models.json` 无 Codex `contextWindowTokens`，所以**模型热切换**
  在生产上按设计 fail-closed；我只验证了 effort 热改。model 切换路径仅有隔离 test-only models.json
  的覆盖，不能当作生产可用。
- **未在生产上执行任何发布**：生产模板、生产注册表、生产 Bridge 全程未动，按单里的分工由 Lead 在
  founder 放行时执行。
- **未验证长跑稳定性**：每次 harness 只活几分钟，carrier 轮换/重连后的热配置行为没有长窗口证据。
- **本地测试环境提示（非产品缺陷）**：runner 的 `TMPDIR` 过长会让 socket 测试报
  `listen EINVAL`（unix socket 路径 >104 字节）；缩短 TMPDIR 后 116/116 全过，CI 亦全绿。
  生产 socket 路径取自 stateDir，不走 TMPDIR，无此风险。

## 5. 返工后的复核范围

按 Lead 裁定：新头到达后只复核 ① 同值 no-op 收敛为 `applied`（真 app-server 上取证）
与 ②③ 的回归，不重跑全量。
