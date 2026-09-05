# FLY-2357 常驻 Lead 记忆开关 — 实施计划
Issue: FLY-2357 (https://linear.app/geoforge3d/issue/FLY-2357/2355a-配置半三个常驻-lead-家开-codex-记忆features-memoriestrue-memories-dedicated)
日期: 2026-09-05
基于: research.md

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. This DAG node forbids dispatching successor/subagent work, so execute inline with review checkpoints.

**Goal:** 让 Raya、Infra Bot、Mufasa 三个常驻 Codex Lead 的共同启动器持续写入并 fail-close 校验 `[features].memories=true` 与 `[memories].dedicated_tools=true`，不触碰节流参数、Honey Lemon voice-avatar home、公共家或生产 daemon。

**Architecture:** 在 `codex-lead-tui-home.sh` 增加单一 `ensure_memory_pins(config, repair_path)` 组装单元，用 `tomllib` 校验有效值，缺表时追加、正确时不动、漂移/错段/无法安全追加时拒绝。read-only 对目标文件调用；full-access 先把旧配置复制到同目录 staging，在 staging 上跑同一状态机，再把已经验证的 `[features]` / `[memories]` 平面表块逐字带入现有原子 renderer，最后整体校验后 swap。这样既能看到旧配置漂移，又不会丢弃未来节流值；既有 TypeScript §10 gate 不改。

**Tech Stack:** Bash 4+、Python 3 `tomllib`、现有 shell 测试 harness、TypeScript runtime gate 的已构建 JS。

---

## 文件职责

- 修改 `packages/teamlead/scripts/codex-lead-tui-home.sh`：新增唯一的 memory pin 写入/验证函数，并接到两条配置组装路径。
- 修改 `packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh`：逐行为完成红绿测试、禁改旋钮负控、full-access gate 共存证明。
- 修改 `.github/workflows/ci.yml`：在已有 Codex daemon mutation safety step 中登记聚焦 suite，并确保已构建的 teamlead dist 存在。
- 新建 `engineering/doc/FLY-2357-lead-memory-pins/implementation-evidence.md`：记录非生产先行、禁止项、生产重启/回滚交接与最终命令输出摘要。
- 新建 `engineering/doc/milestones/FLY-2357.md`：作为 PR 的字面最后提交，记录交付范围与未执行的生产重启。

## Task 1：先消除测试载体的静默跳过与环境污染

**Files:**

- Modify: `packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh`
- Modify: `.github/workflows/ci.yml`

- [x] **Step 1: 复现 ambient env 污染并保留 RED 输出**

用父进程注入 `FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS`、`FLYWHEEL_ROUNDTABLE_CHANNEL_ID`、`FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD` 等变量运行当前 suite，得到 `43 passed, 2 failed`；两个无 resolvable parent 的用例都生成了意外 marker。此时 gate dist 缺席且 xcheck 静默跳过。这是 harness 隔离与覆盖缺口的修改前 RED。

- [ ] **Step 2: 清空 ambient 状态并让缺 dist fail-loud**

suite 顶部额外 `unset` cross-dept、roundtable、chat/core channel 与 aliases 等会影响 config 的变量；每个用例继续显式注入自身输入。把 `if [ -f "$GATE_JS" ]` 改为：任一 gate/runtime dist 缺席就 `fail`，二者都存在才定义并运行 `run_fa_xcheck`。

- [ ] **Step 3: 构建后确认 GREEN 且 xcheck 实际出现**

```sh
pnpm --filter flywheel-teamlead build
env FLYWHEEL_LEAD_CROSS_DEPT_CHANNEL_IDS=ambient-leak FLYWHEEL_ROUNDTABLE_CHANNEL_ID=ambient-roundtable TMPDIR=/tmp \
  /bin/bash packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh
```

Expected: exit 0，`0 failed`，并出现五条 `shell→gate FA` 结果；不能只有总数 green 而没有 xcheck。

- [ ] **Step 4: 把 suite 登记进 CI**

在 `.github/workflows/ci.yml` 已有 `FLY-1955/2211 Codex daemon mutation safety` step 中、zombie suite 之前加入 `bash packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh`。该 shard 已在更早的 `Build` step 跑 `pnpm build`；注释明确此 suite 依赖 dist 且现在会 fail-loud。

- [ ] **Step 5: 提交测试基础设施批次**

```sh
git add packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh .github/workflows/ci.yml
git commit -m "test(FLY-2357): make Lead home gate coverage fail loud"
```

## Task 2：先在生产同形的 full-access 路径写入正确 pin

**Files:**

- Modify: `packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh`
- Modify: `packages/teamlead/scripts/codex-lead-tui-home.sh`

- [ ] **Step 1: 写 full-access 与 read-only 的段位 RED 断言**

在 home 30 的 full-access happy path 和 home 1 的 read-only path 后分别用 `tomllib` 断言：

```python
cfg["features"]["memories"] is True
cfg["memories"]["dedicated_tools"] is True
```

同时让 `run_fa_xcheck` 解析配置并断言这两个值，再继续执行原有 MCP/sandbox runtime gate。

- [ ] **Step 2: 跑聚焦 suite，确认 RED 精确来自 memory pin 缺席**

Expected: full-access/read-only 新断言失败；既有安全断言仍 green。

- [ ] **Step 3: 实现共同状态机的最小 GREEN**

新增 `ensure_memory_pins(config, repair_path)`，用 `tomllib` 检查表/键状态。为本步的单一正向行为，只需让缺席表各自追加下面独立片段，并在追加后重新 parse 断言两个有效值；read-only 在 trust 后、notice 前调用，full-access 在现有原子 renderer 完成后、MCP/notice 之前调用。

已有正确 pin 必须不重复追加；其余漂移与错段分支先保持 fail-close，后续 Task 3 用逐项 RED 锁定精确错误与写前拒绝。本步不提前实现 Task 4 的表块保留。

```toml
[features]
memories = true
```

```toml
[memories]
dedicated_tools = true
```

read-only 在 trust 组装后、notice 前直接调用。

- [ ] **Step 4: 重跑聚焦测试并确认 GREEN**

Run:

```sh
TMPDIR=/tmp /bin/bash packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh
```

Expected: exit 0、0 failures，五条 shell→runtime xcheck 实际运行；现有 read-only idempotence 仍通过。

- [ ] **Step 5: 提交 pin 批次**

```sh
git add packages/teamlead/scripts/codex-lead-tui-home.sh packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh
git commit -m "feat(FLY-2357): pin memory in managed Lead homes"
```

## Task 3：生产路径的漂移与静默错段必须 fail-close

**Files:**

- Modify: `packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh`
- Modify: `packages/teamlead/scripts/codex-lead-tui-home.sh`

- [ ] **Step 1: 写 full-access 显式 false 的 RED 测试**

建立 provisioned full-access 临时 home，写 `[features].memories=false` 与 `[memories].dedicated_tools=true`。运行 `ensure-home` 后同时断言：exit 1、输出包含完整目标键与 `Fix <home>/config.toml manually`、原文件 SHA 不变。

- [ ] **Step 2: 确认 RED 后把 drift 检查移到 full-access 重写之前**

不能把“任意非零”当作通过；先确认 Task 2 实现会重写并返回 0。然后在 full-access writer 动原文件前调用状态检查：false/非 boolean/已有 table 缺目标 key/非 table/parse error 都给出完整目标 key 与字面 `Fix $CONFIG manually.`，不改原文件。

- [ ] **Step 3: 写 `[memories].memories=true` 的 RED，最小实现后 GREEN**

走 full-access，断言 exit 1、指出错段和正确目标 `[features].memories`、原文件字节不变；尤其不能自动追加正确表来掩盖坏行。先看到 Task 2/Step 2 仍会补正确表的 RED，再增加写入前错段负控并重跑 GREEN。

- [ ] **Step 4: 写 `[features].dedicated_tools=true` 的 RED，最小实现后 GREEN**

同样走 full-access，断言 exit 1、指出正确目标 `[memories].dedicated_tools` 且原文件不变。增加第二个写入前负控后重跑；最终 drift、present-without-pin、非 table、parse error 与两种错段全部给出可执行文案且不改原文件。

- [ ] **Step 5: 提交 fail-close 批次**

```sh
git add packages/teamlead/scripts/codex-lead-tui-home.sh packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh
git commit -m "test(FLY-2357): fail closed on memory pin drift"
```

## Task 4：逐字保留禁改旋钮并证明 §10 gate 共存

**Files:**

- Modify: `packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh`
- Modify: `packages/teamlead/scripts/codex-lead-tui-home.sh`

- [ ] **Step 1: 写 full-access 保留合同 RED 测试**

配置正确 pin、注释与五项非默认哨兵值；记录原始 `[features]` / `[memories]` 两个表块，跑 full-access ensure 后逐字比较。哨兵仅证明不修改 operator 值，不是生产推荐：

```toml
[memories]
dedicated_tools = true
max_rollouts_per_startup = 17
min_rollout_idle_hours = 19
max_rollout_age_days = 23
min_rate_limit_remaining_percent = 29
disable_on_external_context = true
```

- [ ] **Step 2: 确认 RED 是旧 renderer 丢表**

Expected: 当前 full-access renderer 丢掉表块；不是断言脚本或 TOML fixture 错误。

- [ ] **Step 3: 用 staging 完成 raw table preservation 的最小 GREEN**

full-access 创建同目录 source staging，复制旧配置（不存在则为空），对 staging 调共同函数但让错误仍显示 `$CONFIG`；renderer 从 staging 读取 trusted projects，并逐字抽取恰好一份 `[features]`、`[memories]` 平面表块。解析值与原始块形状必须一致；inline/dotted、nested table 或无法无损抽取的形状 fail-close。最终临时配置同时验证 sandbox 与两个 memory pin，再 `mv`。任一失败都删除本次两个明确的 staging 文件，原配置保持不变。

禁止在 renderer 中枚举五项节流键或赋默认值；提取必须保留注释、顺序与未知 flat keys，安全无法证明就要求人工修复，不做有损序列化。

- [ ] **Step 4: 重跑并读取 xcheck 证据**

Expected: 表块逐字相同；所有五条 full-access shell→runtime xcheck 运行并通过 MCP + sandbox/writable-roots gate，证明新增顶层表不触发 §10 漂移。

- [ ] **Step 5: 提交 full-access 批次**

```sh
git add packages/teamlead/scripts/codex-lead-tui-home.sh packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh
git commit -m "test(FLY-2357): preserve memory tuning across rewrites"
```

## Task 5：非生产 home 先行与零触碰证据

**Files:**

- Create: `engineering/doc/FLY-2357-lead-memory-pins/implementation-evidence.md`

- [ ] **Step 1: 在唯一临时目录备份并运行真实 Codex parser 探针**

选用本机中性 `codex 0.153.2` 或一个非生产 home-scoped 同版本 binary，所有 `CODEX_HOME` 都指向 `/tmp` 下的唯一目录，不复用真实 auth。先保存 bare `config.toml` pre-image，再依次验证：bare config 报 memories false；正确 `[features].memories=true` 报 true；错误 `[memories].memories=true` 仍报 false；`[memories].dedicated_tools=true` parser rc=0。每个变体恢复自备份开始，失败立即恢复并停止该演练。

- [ ] **Step 2: 运行 hermetic launcher/daemon 演练**

在独立临时 full-access home 中创建 fake auth 与 suite 同形 standalone stub，先备份 config，再顺序执行 `ensure-home`、有效 TOML/§10 gate、`ensure-daemon`；确认日志含 `home OK` 与 `daemon OK`，且不含 `ERROR`、`Fix ... manually` 或 gate failure。结束后只清理这一个已验证目录，不启动/停止任何生产 Lead。stub 证据只代表 launcher 生命周期。

- [ ] **Step 3: 核对两个排除 home 与实现 diff 禁区**

实现后重新只读计算 `~/.codex-honeylemon/config.toml` 与 `~/.codex/config.toml` 的 SHA-256、mtime、size，必须和 research 基线完全相同。`git diff`/`rg` 证明五项禁改键只出现在测试哨兵与文档，launcher 产品代码没有枚举它们，也没有这两个 home 的写路径。

- [ ] **Step 4: 写 implementation evidence**

文档必须明确区分：真实 parser 与临时 launcher/daemon stub 验证已完成；Raya/Infra Bot/Mufasa 三个生产 Lead 尚未重启，因此不能声称生产 daemon 已读取新配置。生效需 R4 00:00/12:00 班车或 founder 重启票；生产执行者按备份→Raya/Infra/Mufasa 中一次一个→日志确认→下一个推进，任何 `Fix $CONFIG manually` 或 §10 gate failure 立即回滚本 Lead 并停队列；一周后读数归 FLY-2355·D。

- [ ] **Step 5: 提交证据**

```sh
git add engineering/doc/FLY-2357-lead-memory-pins/implementation-evidence.md
git commit -m "docs(FLY-2357): record nonproduction memory pin drill"
```

## Task 6：全仓验证、代码审查、PR

**Files:**

- Create last: `engineering/doc/milestones/FLY-2357.md`

- [ ] **Step 1: 先检查测试清单的真实风险**

确认全仓命令不会运行 `**/tmux-viewer.macos.test.ts`；若默认脚本会包含该 GUI 测试，使用仓库既有的正式排除机制，不直接单跑它。列出本次新增的 `scripts/__tests__/*.test.sh`；预期为零，因为只修改 package 下既有 shell suite。

- [ ] **Step 2: 运行 fresh verification**

依次运行并读取完整退出状态：

```sh
TMPDIR=/tmp /bin/bash packages/teamlead/scripts/__tests__/codex-lead-tui-home.test.sh
pnpm lint
pnpm -r build
pnpm test:packages:run
```

另外逐个执行本分支新建的 `scripts/__tests__/*.test.sh`；若列表为空，记录“0 个新增”，不把跳过写成通过。

- [ ] **Step 3: 用 `codex:rescue` 做代码审查**

获取 `BASE_SHA=641734888` 与当前 `HEAD_SHA`，通过已安装 companion 的 rescue wrapper（禁止 raw `codex exec`）运行：

```sh
COMPANION=/Users/xiaorongli/.claude/plugins/cache/openai-codex/codex/1.0.0/scripts/codex-companion.mjs
node "$COMPANION" review --wait --base 641734888 --scope branch
```

Critical/Important 或 HIGH correctness/security finding 必须按 `receiving-code-review` 的核验流程修复，并重跑相关红绿与 full verification。

- [ ] **Step 4: 注册 code review gate**

```sh
node "$FLYWHEEL_COMM_CLI" stage set code_review
review_json="$(node "$FLYWHEEL_COMM_CLI" gate review_code --lead flywheel-eng-lead --exec-id 3aa78485-4bdc-4276-92f9-464d5645aac2 --no-block "Code review requested for FLY-2357")"
question_id="$(python3 -c 'import json,sys; print(json.load(sys.stdin)["questionId"])' <<<"$review_json")"
node "$FLYWHEEL_COMM_CLI" request-review --type code --question-id "$question_id"
node "$FLYWHEEL_COMM_CLI" check "$question_id"
```

CHANGES_REQUESTED 时按 findingKey 修复并开全新 gate/request round；APPROVED with advisories 时通过 `ask --report` 转告 Lead。

- [ ] **Step 5: 先读 milestone 约定，再新建字面最后提交**

先读 `engineering/doc/milestones/README.md`。`engineering/doc/milestones/FLY-2357.md` 记录修正后的三个目标、测试、未重启生产 Lead、后续 R4 与 FLY-2355·D 观测；提交时不虚构尚不存在的 PR 号。提交后不得再改其他文件：

```sh
git add engineering/doc/milestones/FLY-2357.md
git commit -m "docs(milestone): record FLY-2357 Lead memory pin delivery"
```

- [ ] **Step 6: push 与创建 PR**

push `flywheel-FLY-2357`，创建目标 `main` 的 PR。PR body 写明两个 pin、五项明确未改、临时非生产证据、三个生产重启待 R4/founder 票、回滚条件和一周后 FLY-2355·D 读数。

- [ ] **Step 7: 报告并完成 bounded node**

通过唯一报告通道发送自包含 DONE 报告，然后执行：

```sh
pr_number="$(gh pr view --json number --jq .number)"
node "$FLYWHEEL_COMM_CLI" complete --route needs_review --pr "$pr_number"
```

不 dispatch QA、不请求 ship、不 merge、不部署、不重启 Lead。

## 计划自审

- 规格覆盖：两个正确段、三 Lead 全开、launcher 持久化、非生产先行、逐 Lead/备份/回滚、§10 共存、五项禁改、公共家不动、生产重启边界、一周后观测均有对应任务与证据。
- 完整性扫描：review question id 由命令输出解析；injected exec id 按当前工作流权威值原样使用；实现步骤没有含糊的后补动作。
- 类型一致：所有有效值均以 TOML boolean `true` 校验，不接受字符串或 truthy 值；wrong-table key 在任何写入前拒绝。
- 范围一致：不改 TypeScript gate、不新增节流默认值、不碰 Honey Lemon voice-avatar/public/IC home、不触发生产 daemon 生命周期。
