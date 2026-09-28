# FLY-2909 ACK 开关返工 — 实现验证
Issue: FLY-2909
日期: 2026-09-26
基于: plan.md

## 行为与红绿证据

- 首先 pin `e10312c5a^` OFF 与 `f75e35f14` ON 四个规则源的 SHA。旧代码的两个 OFF 测试失败；接线后 2×2 通过。
- Codex v2 capability selector 的 ON 测试在未接线时失败；加入同一启动 reader 后通过。最终本单规则测试 10/10，含 shell/capability 缺开启资源的拒绝路径、两种载体和 Bootstrap 源字节。
- 只读 SQLite launch 测试覆盖默认关、项目覆盖、* 继承、clear 恢复默认、ON→OFF、缺库/非法值回退、shell reader 真实 dist 调用、读取不建库/不迁移/不改字节。治理 stage/apply 通过。

## 本地验证边界

均为指定文件或 changed-file `vitest related`，未运行整包 suite。

- config `vitest related src/feature-flags/registry.ts src/__tests__/feature-flags-drift.test.ts src/__tests__/feature-flags-registry.test.ts --run`：21 文件、381 测试通过。
- teamlead 首轮 related（flag-store-runtime、launch reader、rule-sources、default-runtime）：189 文件，187 通过；2586 pass / 3 fail / 1 skip。3 个失败均已定位并在下述范围复验，保留首轮结果，不把首轮说成全绿。
- 两个 ON 源路径断言在运行期间资产迁往已有打包的 lead-rules-base 后读到旧路径；最终 `vitest related src/lead-capabilities/rule-sources.ts src/__tests__/lead-ack-action-batching.test.ts --run`：23 文件、373 测试全部通过。
- DAG 恢复用例首轮返回 404；无相关代码修改，单用例重跑 1 pass，整文件重跑 72/72。该初次失败不能作为新功能证据。
- `git grep -lF` 对生产改动的完整路径、文件名、父目录发现消费者，逐匹配保留/排除清单见 consumer-audit.json。直接消费者 Vitest：20 文件、386 测试通过。规则/bootstrap/预算另 5 个指定文件 50/50；原有 token-savings 字节/digest/Bootstrap 检查通过。
- `pnpm --filter "flywheel-teamlead..." build`、最终 teamlead build、`pnpm lint` 退出 0。Lint 保留仓库既有 warnings。依赖类型检查 `pnpm --filter "...flywheel-teamlead" --filter "...flywheel-config" typecheck` 在补建缺失的 `flywheel-voice-bridge...` 产物后通过。
- shell 消费者最终结果另见 shell-validation.json；两个基线失败：fly231-companion-launch-plan 的五个 golden 未含现有 visible-tui-default.md；screencap-skill-gate 的夹具未定义 IS_COS_ROLE。两者用隔离的 f75e35f14 源码与同一依赖产物复现，分别仍为 49 pass/5 fail、2 pass/2 fail，未改无关快照/夹具。
- 本次新增 legacy ON 副本触发 residue 精确路径登记遗漏；仅追加既有 three_stage_turn 的新副本路径后，`fly1674-residue.test.sh` 86/86。未扩大检测模式或白名单范围。

## 尚需独立证据

本地通过不证明真实 Lead 会遵守规则，也不证明 529 真批次的 lease/ACK/重投/唤醒无回归。QA 必须按 qa-handoff.md 取得 Claude 与 Codex ON/OFF 真实证据，并请求冻结头 full exact-head CI；实现节点仅走代码评审与 needs_review，不请求 full CI、不 dispatch QA、不合并或部署。生产开关由 Lead 合入上线后打开观察。

## QA FAIL 后 implement 返工（attempt 2）

- QA 在 `bd40e1eb0` 上因 full CI run `36256758303` 的 `qa-fly-1986-load-probe.test.sh` 正控一次得到 `incomplete_expected=3` 而 fail-close；没有进入 529，未产生产品行为 FAIL 证据。
- 该 FLY-1986 脚本与当时 main 字节一致，同版本在 main 的完整 Script E 曾通过；本地原样复跑又在更早的 SIGTERM 时序断言红，而非复现 R6-3。证据只支持共享 timing harness 抖动，不支持改 ACK 产品或无关 harness。
- 合入 `origin/main` 的 FLY-2934 后，唯一冲突是 feature-flag registry 的冗余固定总数断言；按上游删除法解决，保留 FLY-2909 `EXPECTED_WHEN_ON` 映射和所有语义断言。未改 Bridge、mailbox、lease、ACK 或 FLY-1986 文件。
- 新 merge 头的定向证据：config 2 files / 71 tests，config changed-file related 57/57，teamlead 4 files / 94 tests，FLY-2909 shell contract，FLY-1674 88/88，affected build、dependent typecheck、`pnpm lint` 均退出 0。lint 只报告仓库既有 warnings。
- full exact-head CI 与 Claude/Codex 529 四项矩阵仍由 QA retest 取得；implement 不把此次定向验证冒充 full CI 或真实 Lead 行为证据。

## QA@1 FAIL 后 implement 返工（attempt 3，Codex 路径）

- **根因**：529 的 Codex Lead 是窗口式 TUI，`codex remote-control` daemon 与其中已加载的 thread 在 sidecar 重启/被杀后仍存活（证据：10:31:12Z SIGKILL 后同一 turn 仍在 10:31:18 发 STEP2、10:31:22 ACK）。开关 ON 后 kickstart，sidecar 对仍加载的 thread 调 `thread/resume`；codex app-server 对 running/有订阅者的 thread 忽略 `baseInstructions`（codex-oss `thread_processor.rs`：`baseInstructions override was provided and ignored while running`）。rollout 的 base_instructions 仍是 OFF §6「Process all N ... then acknowledge」，ON 规则从未到达模型；`ack_batch` 工具描述也写着 “after processing every message”。
- **修法（只动 Codex sidecar 提示，不动 Bridge）**：TUI sidecar 每进程读一次 `lead_ack_action_batching` 启动回执（同一只读 launch reader、同一 `TEAMLEAD_DB_PATH`），ON 时在每个 mailbox-batch 的 turn 输入与 steer 输入末尾追加 `CODEX_ACK_ACTION_BATCHING_DIRECTIVE`：与首个处理动作同一模型步骤发 `ack_batch`（并行 tool call 或同一 `exec` 脚本），并显式覆盖旧规则/工具描述的「处理完再 ACK」。journal 持久 payload 保留 Bridge 原字节；OFF/缺省时 turn 输入逐字节不变；Discord 直连输入永不追加。启动时打一行 `[lead-ack-action-batching] Codex mailbox turn receipt=0|1`。
- **RED→GREEN**：新增 `ack-action-batching-turn-input.test.ts` 8 例（纯函数、router、steer）；RED 为 router/steer ON 用例失败。TUI 端到端 3 例放在 `codex-lead-tui-runtime.rotation.test.ts`（真实 StateStore flag 行 + 真实 launch reader + 捕获 `turn/start`/`turn/steer`）：ON 用例在接线前失败，接线后通过；建 sidecar 后翻转开关行为不变，证明是启动回执而非每代重读。
- **真模型探针（gpt-5.6-sol，codex-cli 0.158，本地 `codex exec`）**：stub `lead_actions` MCP（同名工具、原样工具描述），开发者指令放旧 OFF §6 + reply contract（模拟 529 里冻结的旧 base instructions），输入为 529 的 compare 批次。ON 3/3：`discord_send` 与 `ack_batch` 在同一个 `exec` 脚本内以 `Promise.all` 发出；ON 纯状态批次 1/1：立即单独 ACK；OFF 负对照 1/1：动作与 ACK 分在两个采样步骤（复现 529）。输入 sha256 前缀：prompt-on b6adbf0d3d01ee1b、prompt-off 29524802aa44fc1b、statuson 40d145b7d4e1bf90、OFF 规则摘录 7f75029e04db4e49。探针只证明提示有效，不替代 529 真房。
- **有意不动**：headless `codex-lead-runtime.ts`（FLY-398 规定生产 Codex Lead 只用 TUI；headless 每次冷启 app-server，`thread/resume` 会采用新 baseInstructions）；`ack_batch`/`flywheel_inbox_ack_batch` 工具描述（改它会改变 OFF 字节）；Bridge 批次头。
- **A/C 格 INCONCLUSIVE 核查**：本单 diff 不含任何 runner 提示、skill 或 local-test-policy 文本；新增行里与测试相关的只有两个 vitest import。A/C 的发现（`unresolved_test_wrapper`、`dynamic_test_selection`、`literal_test_not_executed`）出自 fixture runner 自身的测试命令，与本单改动无关，本单不改。
