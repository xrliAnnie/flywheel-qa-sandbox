# FLY-2144 派发容量输入 — 实施记录
Issue: FLY-2144 (https://linear.app/geoforge3d/issue/FLY-2144/2108e-派发判断的容量输入quota-机器内存当前值可读-附-dag-resolver-退役)
日期: 2026-09-02
基于: plan.md

## 实现期裁定

- Lead 授权只改根 `CLAUDE.md` 的一行过时架构图：将已退役的依赖排序路径改为当前的 Bridge run-dispatcher；本单没有其他根 `CLAUDE.md` 改动。PR body 必须显式说明这项例外。
- `plan.md` 的 design-review blob 保持不变；实现期证据只写入本文件。

## R8 最终代码头消费者 sweep

- 执行时间（UTC）：`2026-09-03T06:57:57Z`
- 被扫实现 head：`34dd9be614f95a1206b8ec507b7c0031b390c1ea`（Lead 治理后的阻塞修复代码头；此后仅允许 progress/证据/milestone 收尾提交）
- 匹配族：旧 workspace package 名、三个退役类名，以及旧 dependency-ordering 人类文本名。
- 主仓 `scripts/ packages/ docs/ .github/ CLAUDE.md`：`ZERO REFERENCES`（残留守卫本身按合同自排除）。
- 本机插件 cache 各 root：
  - `~/.claude/plugins/cache/claude-plugins-official`：`ZERO REFERENCES`
  - `~/.claude/plugins/cache/everything-claude-code`：`ZERO REFERENCES`
  - `~/.claude/plugins/cache/flywheel-plugins`：`ZERO REFERENCES`
  - `~/.claude/plugins/cache/matt-skills`：`ZERO REFERENCES`
  - `~/.claude/plugins/cache/minimalist-entrepreneur`：`ZERO REFERENCES`
  - `~/.claude/plugins/cache/openai-codex`：`ZERO REFERENCES`
  - `~/.claude/plugins/cache/superpowers-dev`：`ZERO REFERENCES`
  - 三个 `temp_git_*` cache root：均为 `ZERO REFERENCES`
- 插件 fork 源 `~/Dev/claude-plugins-official/external_plugins`：`NOT CHECKED — root missing`。
- 调用方处置：所有已存在并完成扫描的 root 均为零引用，因此没有需要同步迁移的调用方；缺失的 fork root 没有被冒充为已检查。

## 负向与旧产物证据

- `git ls-files packages/dag-resolver scripts/run-project.ts scripts/smoke-test.ts | wc -l` 输出 `0`。
- `runner-admission.ts` 相对 `origin/main` 只新增只读 `AdmissionProbe`/`probe()`；`tryAdmit()` 和 `AdmissionReason` 没有改动。
- 在已构建 checkout 中确认旧 `dist/DagDispatcher.js` 与 `.d.ts` 存在后运行 edge-worker build，两文件均被精确 prune；随后 `package-onboard` 28/28 通过，打包后两旧产物仍不存在。
- 新残留守卫路径层、内容层和两个拼接阳性对照为 4/4 PASS。

## 验证证据

- `pnpm lint`：PASS；仅保留 14 个既有 warning，零 error。
- `pnpm -r build`：PASS（21/22 workspace projects，根 workspace 按脚本约定排除）。
- `pnpm -r typecheck`：PASS。
- `pnpm test:packages:run`：准确执行，exit 1；core 中未改动的真实 Terminal.app/HiServices 用例在 resident 非 Aqua 环境报 `Connection invalid`。排除该 GUI 文件后 core 为 19 files / 219 tests PASS。
- 继续执行除 core 外的 package suite：teamlead aggregate 为 773 files PASS / 4 files FAIL，10171 tests PASS / 6 tests FAIL / 6 skipped，并有 1 个 worker timeout。三个失败文件独立运行全绿；`patrol-orphan-sweeper.test.ts` 的真实 tmux 用例可独立复现为本机 `tmux 3.7c` 拒绝包含 TAB 的 fixture window name。上述文件与对应实现均未被本单修改，因此不越界修复。
- FLY-2144 新残留守卫：4/4 PASS；CI matrix coverage：21/21 PASS；package-onboard：28/28 PASS；FLY-2121 node contract/setup：12/12 PASS。
- `ci-structure.test.sh`：PASS；修复后的新脚本步骤已进入 CI 精确清单。
- `pnpm --filter flywheel-edge-worker test:run`：105 files PASS / 1220 tests PASS / 6 files skipped / 14 tests skipped。
- 容量三个精确回归文件：3 files / 40 tests PASS，覆盖 snapshot、HTTP 与 patrol 两个出口、计数/pct 整数化、连续负载值两位小数，以及恶意 provenance 一致降级。
- SQLite UTC 修复遵循 TDD：新增裸 SQLite `2026-09-03 04:56:26` fixture 后先红，再归一化为 `2026-09-03T04:56:26.000Z`；capacity snapshot + patrol renderer 共 20 tests PASS，teamlead typecheck PASS。
- `git diff --check`：PASS。

## Code review

- 按角色要求先经 `codex:rescue` companion 发起只读审查；嵌套 macOS sandbox 在读取仓库前以 status 71 失败（`sandbox-exec: sandbox_apply: Operation not permitted`），未把该失败冒充为 review 通过。
- 正式 request-driven review round 1（question `53b7faf4-fce0-4d9a-998c-f99f546cfc58`）返回 `CHANGES_REQUESTED`：唯一 HIGH 指出 SQLite UTC `set_at` 被本地时区解释。
- 以 TDD 修复并推送后，正式 round 2（question `118c7c69-3138-4880-bff7-1f7ad9d936e3`，request `8ca9cb74-28a3-4781-af25-80cd79824557`）在 reviewed head `75ca9159ba4e0d2dcdfcf8fca0d133c419e15f76` 返回 `APPROVED`。
- 非阻塞 advisories 已通过唯一报告通道回报 Lead：两个 MEDIUM（展示数字精度、HTTP 出口净化一致性）随后由 Lead 作为本轮返工要求纳入并完成；三个 LOW（异常时间局部降级、部分有效账号继续显示、诊断 token 覆盖）保持非阻塞，不扩 scope。

## PR CI 修复证据

- PR #1043 的首轮 CI 在 Quick Gate 失败：新增的 `script-tests-3` 步骤没有同步进入 `ci-structure.test.sh` 的精确清单。本地先复现同一 RED，再只增加一条预期步骤名得到 GREEN；`ci-shell-suite-enumeration` 和 FLY-2144 残留守卫仍然通过。
- 修复头重跑 `pnpm lint`、`pnpm -r build`、`pnpm -r typecheck` 全部 exit 0；`ci-structure`、FLY-2144 残留守卫、matrix coverage、package-onboard 和 FLY-2121 契约全部通过。
- 精确 `pnpm test:packages:run` 仍只在 resident 非 Aqua 主机上的两个真 Terminal.app/HiServices 用例停止；失败前 core 其余 219 测试全通过，与上一轮环境证据一致。PR 的 Linux unit 与 shell shards 在旧头全绿；最终返工头等待 GitHub CI 重跑。

## QA 返工修复

- `[lead-instruction 1f2d91e3-291c-43e9-afb9-d42833d0c7bd]` 要求同步 CI 结构清单、收敛容量数字展示，并补齐验收记录。最终治理口径将校验与展示分开：计数/pct 取整，`load1`、`perCore` 与 `thresholdPerCore` 保留最多两位小数；生产长小数不再污染扫描行，也不会把 `2.6` 与 `2.5` 或空闲 `0.44` 抹成同值。
- `[lead-instruction 6d8bac9c-e3fc-4753-b4bf-eb4629d8f563]` 要求在共享 snapshot builder 内收敛 pressure-hold 来源。新集成夹具向真 `StateStore` 写入带换行和 `IGNORE PREVIOUS INSTRUCTIONS` 的 `set_by`/`watermark`，先证明 HTTP 原样外泄，再验证 builder 将两值稳定降级为 `unsafe-<hash>`；`GET /api/capacity` 与 patrol tick 两个出口都不再含原文。传感器的合法 `N.N% free`/`unknown` 水位形状继续保留。
- 遵循 Lead 对流程冲突的回复，不修改已锁定的 `plan.md`；验收增补写入 `design-correction.md`、本文档与 PR body。

## 最终返工审查与 CI

- 最终代码头 `9ef6de2b4db6961206593c875f9bcca27fdc15c5` 再次按角色合同调用 `codex:rescue` 只读审查；companion 仍在读取仓库前被 resident 外层 macOS seatbelt 以 status 71 拒绝，未冒充为 review 通过，也没有改走禁止的 raw `codex exec`。
- Fresh request-driven code review round 3（question `de9ff9b8-7f99-41b6-a010-d619e3055e2e`，request `e63b0ecf-ccf8-42b1-accd-c2314b2051bf`）在精确 reviewed head `9ef6de2b4db6961206593c875f9bcca27fdc15c5` 返回原始 `APPROVED`，带 2 个 MEDIUM 与 3 个 LOW。Lead 随后以 `[lead-instruction b144d613-48bf-4329-960a-f967b5935d3e]`、`[lead-instruction 8d829da2-4275-464e-ac46-cb4981db568f]` 与 `[lead-instruction 30ec196b-d5d9-4ed6-b86c-bd65ffa5d91c]` 明确将两个 MEDIUM 裁定为本轮必修，因此该旧头不能完成。
- PR CI run `33722681371` attempt 1 的 Script Tests 3/4 仅在未改动的 FLY-1986 load-probe 阳性对照因采样不完整失败；同 shard 此前 61 项通过，且本 PR 对该 shard 的唯一变化是插入 FLY-2144 残留守卫。GitHub 同头 attempt 2 中该套件通过，`9ef6de2b4` 的 12 个 jobs 与聚合 `CI OK` 全部 success；治理修复新头另行触发 CI。
- 最终本地 shell 复跑：`ci-structure`、`ci-shell-suite-enumeration`（256 个 shell suite / 3 个 Node suite 全部显式分类）、`ci-matrix-coverage`（21/21）、`package-onboard`（28/28）、`fly2121-node-contract-and-setup`（12/12）、FLY-2144 残留守卫（4/4）与 milestone layout（32/32）全部通过。
- 本地 teamlead 全包在 resident 主机上为 771 files / 10170 tests PASS，6 files / 10 tests FAIL / 6 skipped；失败均来自未改动的真 tmux、Claude profile/锁、Bridge 启动与固定 5–10 秒时间预算夹具。GitHub Linux 的 teamlead 3/3 分片全部通过，改动相关容量三个精确回归文件仍为 3 files / 40 tests PASS。

## Lead 治理后的阻塞修复

- 数值回归按 TDD 修复：新 fixture 先证明全局 `Math.round` 会把 `38.559.../18核=2.642...(阈 2.543...)` 错写为 `39/18核=3(阈 3)`，再把 `capacityNumber()` 恢复为纯校验器；展示调用点分别选择整数或最多两位小数，GREEN 为 `38.56/18核=2.64(阈 2.54)`，年龄仍为 `37m`。
- admission 泄漏按 TDD 修复：同一 HTTP 集成夹具用 `evil@example.com`、换行与 `IGNORE PREVIOUS INSTRUCTIONS` 同时污染 `StateStore` pressure hold 与 `AdmissionDecision.detail`，先证明 `brakes.admission.detail` 原样泄漏，再令 `admissionSnapshot()` 对 pressure-hold reason/detail 走 `canonicalCapacityToken()`；最终 HTTP 全文不含原串或邮箱，结构化 hold、admission detail 均稳定降级为 `unsafe-<hash>`，patrol 同样无原文。
- 修复代码头 `34dd9be614f95a1206b8ec507b7c0031b390c1ea` 的本地最终门：lint、全仓 build、全仓 typecheck、容量 40/40、edge-worker 1220、`ci-structure`、FLY-2144 残留 4/4、matrix 21/21、package-onboard 28/28、FLY-2121 12/12 全绿；精确 package 命令仍仅停在同两个非 Aqua Terminal.app 真机用例。
- 三个 LOW（异常时间局部降级、部分有效账号继续显示、诊断 token 覆盖）保持已记录边界；它们不改变本轮必修的两个泄漏/判读正确性修复。新代码头必须另开 request-driven review 并通过后才能完成。

## 默认拒绝 admission detail 的审查返工

- fresh review（question `f88a936b-d8cf-4758-aa7a-227766ec5fb9`，request `6d100af5-20f1-4540-8c06-cf4fcaba92c1`）在 reviewed head `ecb4f5c78bfb54e5d515e88749b2651cdf73e0c3` 返回原始 `APPROVED`；新 MEDIUM 指出 `admissionSnapshot()` 只净化 `pressure_hold`，其余 reason 默认原样放行。按 Lead 对 MEDIUM 必修的既有裁定，该头不完成。
- TDD RED 通过真实 `RunnerAdmissionController.setAdmissionPauseProbe()` 注入 `evil@example.com`、换行与 `IGNORE PREVIOUS INSTRUCTIONS`；`GET /api/capacity` 的 `brakes.admission.detail` 确实原样泄漏。修复改为穷尽式 reason allowlist：仅保留由 admission controller 本机纯数值生成的 `load_pressure` / `memory_pressure` detail，`admission_paused` / `pressure_hold` 统一降级为 `unsafe-<hash>`；reason 本身保持 typed token。新增 reason 未分类时 typecheck 会失败。
- GREEN 证据：容量/admission 三个精确文件 43/43；teamlead 与全仓 typecheck、全仓 lint、全仓 build 均通过；新增 FLY-2144 residue guard 4/4 与 `ci-structure` 通过；edge-worker 在移除 resident-only `FLYWHEEL_STATE_DB_PATH` 后 105 files / 1220 tests 通过。精确 `pnpm test:packages:run` 仍只在同两个未改动的非 Aqua Terminal.app/HiServices 用例失败（core 其余 219 通过）。
- reviewed head `ecb4f5c78` 的 GitHub run `33725916558` 为 13/13 checks 与聚合 `CI OK` 全绿；本轮代码修复 `fb8ffe637` 完成后必须恢复 milestone 最后一提交，推送并获得新的 formal review 与 final-head CI，旧 review/CI 不冒充新头证据。

## QA 二轮局部降级与诊断保全返工

- QA attempt 2 在精确被判头 `eec8086fd566b327e62f2f420f9ae0d0e4d9b690` 完成真实 529 N-to-N、真 Bridge `GET /api/capacity` 与全判据复测；除三个必须修复的既有 LOW 边界外全部通过。返工 authority 来自 QA claim `728`，新 implement attempt 3 只处理这三项，不扩 scope。
- pressure-hold 时间按严格 TDD 修复：新增 `set_at = "not-a-timestamp"` 夹具先红，证明 builder 产出 `active: true + setAt: undefined`，继而让 renderer 将整段容量退化；最小修复在共享 builder 把这一格归一为 `active: null + transient: state_store_unreadable`。memory、load、runners 与 quota 仍保留，既有三行局部不可用 renderer 无需放宽。
- 部分 Claude 账号按严格 TDD 修复：健康账号与一条非布尔 auth flag 同存时，旧 renderer 因任意 `unavailable` 直接打印整格 `?`；修复后先验证并渲染幸存账号，再附 `⚠️(transient: account_entry_invalid)`，不再藏掉健康 5h/7d 事实。
- 诊断覆盖按严格 TDD 修复：active 账号恰为被过滤的坏条目时，旧 builder 先写 `account_entry_invalid`、再被 `account_store_invalid` 覆盖。内部改为有序去重累积；单诊断继续保持既有 scalar HTTP 形状，多个诊断才输出数组。renderer 只接受 1–2 个精确 allowlist token、拒绝空列表与重复项，并逐项校验后输出全部诊断。
- attempt 3 精确回归：capacity snapshot / HTTP / patrol 三文件 `45/45` PASS；`pnpm lint`、`pnpm -r build`、`pnpm -r typecheck` PASS；edge-worker `105 files / 1220 tests` PASS；FLY-2144 残留守卫 `4/4`、CI structure、matrix `21/21`、package-onboard `28/28`、FLY-2121 `12/12` 全绿。
- `pnpm test:packages:run` 再次按原命令执行，仍只在未改动的两个真实 Terminal.app/HiServices 用例因 resident 非 Aqua 环境 `Connection invalid` 停止；core 其余 `19 files / 219 tests` PASS。该失败与本轮四个 teamlead 文件无交集，GitHub Linux final-head CI 仍需重新绑定证明。
