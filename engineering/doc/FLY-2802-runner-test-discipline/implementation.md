# FLY-2802 Runner 测试纪律 — 实施证据
Issue: FLY-2802 (https://linear.app/geoforge3d/issue/FLY-2802/runner测试纪律-本机只跑相关测试写进-promptfly-2753后-runner-仍跑整包全量把-prompt-写到不留口子-在)
日期: 2026-09-23
基于: plan.md

## 已实现范围

- `local-test-policy/v1` 是唯一人工编辑的共同规则块；同步器把同一字节投影到 implement、QA、engineer 与 Codex runner contract。规则逐项堵住「先扫整包发现影响面」、全仓字面量替换、空输出重试、skill 收尾、coverage、目录/glob、package filter 和 wrapper/loop 等借口，并给出 literal grep、逐文件 Vitest 与 `vitest related` 的替代步骤。
- Flywheel 自有 skill templates 不再要求裸跑配置的 `testCommand`；第三方 Superpowers / Everything Claude Code 源码未修改，实际 prompt 明确覆盖其 full-suite 惯例。完整可达性和触发条件保存在 `skill-audit.md`。
- 行为验收提供 `prepare` / `run` / `evaluate`：构造负控可稳定判 FAIL；缺日志、未知 wrapper、动态命令、错误身份或未完成任务只能 INCONCLUSIVE；真实 slot 入口检查 exact candidate head、built health、real backend、role/model receipt、prompt hash、fixture hash 与完成回执，且不调用 approve/ship。
- 529 driver 增加显式 `--test-discipline` 模式。generalized A/B 采用合法的 cross-vendor `simple_code`，standalone C/D 通过真实 ConfigLoader + AgentDispatcher 证明 engineer mapping；原有非该模式调用保持原拒绝/输出语义。
- QA suite、README、CI suite enumeration、package payload allowlist 和仓内可达 runner 指南均已同步。没有加入 PATH hook、Vitest 替身或生产命令拦截。

## 判定器补强

在候选 `c3bf201054a4db2e7a41db4c92e636b18207e4fd` 的人工审阅中又发现两处 approved plan 已要求、原测试未覆盖的边界：未解析的测试 wrapper 会被误当成非测试，未加引号的 `echo/grep ... vitest run` 可能被误当成执行。提交 `9da77d96c` 先用 RED 用例复现，再改为只识别 shell segment 的真实 executable 链；含测试语义但无法展开的 wrapper 现在 fail-closed 为 INCONCLUSIVE。负控仍判 FAIL，合法显式文件与 related 仍判 PASS。

Code review R1（gate `61b8371f-bec9-4da3-a541-58231181af9d`，request `60602a28-575f-48e5-8a2b-149f268bedc4`，reviewed head `f1074e248`）有效 verdict 为 CHANGES_REQUESTED。提交 `65a35db21` 处理全部 5 HIGH 与 4 MEDIUM，而不是把 advisory 留给真实矩阵碰运气：

- redirect/pipe 不再被计作 Vitest 位置参数，heredoc 正文不再被当作执行；未知 test wrapper 继续 fail-closed。
- Codex parser 接受真实 rollout 的 quoted `"cmd"`，优先读取结构化 exit code，并识别成功的 `Script completed` envelope；真实 broad command 仍判 FAIL。
- fixture checker 用 exact-boundary 查旧值，新值 `claude-opus-5.5` 与近似值 `claude-opus-50` 不再造成永远失败；七次独立 Vitest 输出逐次解析并相加，`testsRun` 不再写死。
- generalized config 不再注入 standalone-only engineer mapping；ordinary C/D 仍由真实 ConfigLoader + AgentDispatcher 验证。
- shallow CI 缺少 `origin/main` 历史时不再访问不存在的 `HEAD^`，而是 fail-closed 要求 A–D 全矩阵；正常完整 checkout 仍用 merge-base diff。
- TDD 的早期 RED 不再永久污染 verdict；required literal files 与 related 各自必须至少有一次成功 GREEN 才能 PASS。

Code review R2（gate `bc7d4764-5f44-4265-b756-eb6be25d96b6`，request `125be1c1-72d4-4f03-b0f6-d30f31d42c14`，reviewed head `635b713ba`）再次有效判 CHANGES_REQUESTED。提交 `01c08e24a` 处理唯一 HIGH 和全部 advisory：Codex `functions.exec` 内已知非 shell tool（如 `apply_patch` / `web__run`）不再生成假 `command_unparseable`，而 `write_stdin`、动态或未知 shell 仍 fail-closed；heredoc 识别改为 quote/comment-aware，未闭合 heredoc 为 INCONCLUSIVE，真实 heredoc 后的 broad command 仍为 FAIL；恒真的 `Script completed` banner 不再证明内层测试成功，只认结构化 exit 0 或正向测试摘要。另把 CI prepare 测试改为事件无关的 manifest invariant、fixture test count 改为实际值不低于基线、未知 Vitest option value 改为 INCONCLUSIVE 而不是误报 FAIL。

Code review R3（gate `a07ca02d-db39-47b6-868c-81079ff5cd40`，request `973ad1b7`，reviewed head `42865edebddf0f591bb268b04d4237bdce36611e`）有效判 APPROVED；三个 MEDIUM advisory 已通过 report `8a19049a-fc23-4957-b425-29d0af46af52` 交给 Lead，没有在已审 head 上静默加改动。

## QA FAIL 后的实现返工

QA 在 head `42865edebddf0f591bb268b04d4237bdce36611e` 记录 FAIL（claim `1420`），返工只包含两个 blocker：

1. `commandIndex` 只会展开赋值、裸 `env` 和 `timeout`。`env -u` / `env --unset=` / `/usr/bin/env -u`、`sudo`、`nice`、`time`、`caffeinate`、`stdbuf`、`script`、`xargs` 以及 `bash -c` / `sh -c` 后面的 broad Vitest 会落成 `not_test`，导致带真实违规命令的完整证据错误 PASS。
2. PR 与 `origin/main` 冲突，GitHub `mergeStateStatus=DIRTY` 且没有 CI run。唯一冲突是 main 在 `8fc0fab1a` 已删除 `scripts/ci-ubicloud/fixtures/ci-source.yml`，而本分支仍修改该历史 CI fixture。

返工先在 `scripts/__tests__/runner-test-discipline.test.mjs` 加行为用例，得到 36 pass / 2 fail 的 RED；提交 `3e872d301` 再引入参数感知的 wrapper 展开和 `bash/sh -c` 递归解析。已知 wrapper 后的裸 Vitest 现在直接 FAIL，未知或动态 wrapper 为 INCONCLUSIVE，显式单文件仍 PASS；`command -v vitest`、`which vitest`、`npm view vitest`、`pnpm why vitest` 等非执行查询继续是 `not_test`，避免把 fail-closed 做成机械假红。QA 留下的独立 probe 最终为 40/40、`problems=0`；五个 wrapper mutant 和 plain control 均被判 FAIL，合法 fixture 仍 PASS。

技术同步用 merge commit `ea6bb13bc` 合入 `origin/main@8fc0fab1a`，接受 main 对 Ubicloud fixture 和 canary 的删除；`.github/workflows/ci.yml` 中 FLY-2802 的三个定向 suite 登记仍在。没有 rebase、force-push、修改 main 或恢复被退役 fixture。

首次推送返工 head `ef167ebfee6ff5750f183d1f2639e1f22566bbe2` 后，自动 Quick Gate run `35846718885` 的真实 runner 正常启动，但在 job `107134533006` 的 `Test — FLY-1338/1861 CI structure guard` 失败：`.github/workflows/ci.yml` 已新增 FLY-2802 step，`ci-structure.test.sh` 的 script-tests-6 精确顺序表却漏了该名称。先本地复现同一 RED，再由提交 `485a01cdc` 补一条结构登记；同 job 的 `ci-structure`、`ci-scope`、`ci-full-reuse` 分别 PASS、20/20、28/28，CI enumeration 仍为 345 shell / 87 Node。没有把红 job 当外部噪声，也没有手动重跑旧 head。

Code review R5（gate `a59f8158-2cd3-4739-9422-19a2490eef5c`，request `f1f63b43-dae9-4f52-84d1-0a61526d30c6`，reviewed head `859e9b78de545e1799c532ea94f3bf9a87f88f7c`）判 CHANGES_REQUESTED：`zsh` / `ksh` / `dash` / `fish -c` 未进入递归分析会错误 PASS，而 `bash <script> -c ...` 会把脚本参数误认成 shell command option。提交 `fc46e3386` 先用聚焦 RED 同时复现两个方向，再让常见 shell 仅在首个非 option token 之前识别 `-c`；绝对路径 shell 由 basename 归一化。`zsh -c 'npx vitest run'` 和 `/bin/zsh -c 'pnpm test:packages'` 现在稳定 FAIL；`bash scripts/run-all-tests.sh -c 1` 不再被猜成安全，而是 INCONCLUSIVE；shell 包住的合法显式单文件仍 PASS。

R6（gate `c52f6e09-c948-46fb-a97b-dc5e79a714e9`，request `899c5a6d-f3a8-4abf-a2ec-41e650121ecc`，reviewed head `809bc4a4c1cb07accb39cae50976578ced186391`）有效判 APPROVED，但 Lead 将同一 finding 的窄 residue 提升为交卷前必修：`bash -o pipefail -c ...`、`bash -eo pipefail -c ...`、`zsh -o pipefail -c ...`、`sh -e -o x -c ...` 仍可能错误 `not_test`。提交 `240c09775` 让 shell option 扫描一旦先落到 operand、后面又出现 command option，就返回 INCONCLUSIVE，不再猜成安全；直接可解析的 `bash -e -c` broad command 仍 FAIL，显式单文件仍 PASS。聚焦用例先 1/2 RED，再 2/2 GREEN；每个 ambiguity case 还在完整 evidence bundle 上断言最终 verdict 为 INCONCLUSIVE。其余四项 MEDIUM 依 Lead 裁定仅列 PR follow-up，不在本轮扩张范围。

## QA@2 exact-head CI 返工

QA 在精确 head `82611ef14fc08398a619885bd3bc004e532b66a2` 请求 full CI run `35851186134`。13 个执行 job 通过，`Unit (heavy)` 与 `Unit (teamlead 1 of 4)` 失败，`CI OK` 因聚合红灯而失败。QA 的独立根因取证证明：

- `Unit (heavy)` 的 6 个 FLY-2533 cell 都在 `Blueprint.generalized-workflow.test.ts:646` 失败，CI 实测值相对作者本机 pin 恰少 28 UTF-16/UTF-8 units。`appendSystemPrompt` 内嵌绝对 `commCliPath` 7 次，而 CI checkout 比作者 worktree 路径短 4 字符，因此 raw exact byte pin 天生依赖机器路径；旧 ratio guard 的分子分母同步漂移，所以此前未暴露。
- `Unit (teamlead 1 of 4)` 只红了未被本分支修改的真实 tmux 用例 `real tmux exit evidence without a client locale`（期望 `1 42`、实得 `1`）；同 shard 其余测试通过。返工中精确复跑该用例 1/1 PASS，不把它误写成本分支产品缺陷。

提交 `93d0023c1` 只修预算测试，不改生产 prompt：测试先确认 raw prompt 确实含当前 checkout 的 `flywheel-comm/dist/index.js`，再把所有该绝对路径替换为固定 `<FLYWHEEL_COMM_CLI>` token，之后才计算 ratio 与 exact UTF-16/UTF-8；fixture 的六组 exception 值按 normalized 输出重钉。TDD RED 为同一 6 个 cell 全红、每项与旧 pin 差 399（7 次路径 × 每次 57 字符归一差）；GREEN 为聚焦 18/18，且输出显式标记 `machinePathsNormalized=true`。这保留 byte-growth fail-closed，又消除 checkout 长度这一非产品变量。

Code review R8（gate `785b01d8-7bf2-463d-8e20-11e8c75f18a1`，request `2566eaa5-1151-4712-b0b7-876b381ccc1a`，reviewed head `66cee56f418908694c135924a5003fff1b5676ab`）判 CHANGES_REQUESTED，并指出三个 HIGH：test-discipline 菜单 jq 因 pipe/or 优先级让 A/B 必然部署失败；`pnpm|yarn|bun vitest --run` 会被判 `not_test`；未知仓内脚本委托同样会落成 `not_test`。提交 `c1f959554` 对三项逐个先加 RED 再最小修复：菜单谓词移到 `qa_generalized_menu_ready` 单源 helper，测试真实喂入 ordinary 与 `simple_code` 菜单 JSON；包管理器全局 option 解析后把直调 `vitest` 当真实二进制执行，`pnpm why vitest` 仍保持查询语义；shell/node/直接本地脚本及 `make` 委托在无法证明脚本内容时 fail-closed 为 INCONCLUSIVE。R8 的四条 MEDIUM/LOW 继续作为非阻断 follow-up，没有混入本次 HIGH 返工。

## QA@3 manager delegation 假绿返工

QA@3 在精确 head `1656a694e247c429d2e325eed16b1b70f6a06ace` 通过真实 transcript extractor 证明另一条同类假绿：`pnpm|npm|yarn|bun exec`、`pnpm dlx`、filtered/recursive `exec` 以及 `npx|bunx` 委托任意 executable 时，delegate 没有重新进入裸命令的 shell/local-script/make 规则，最终会落成 `not_test`。在完整合规 evidence 上额外加入 `pnpm exec sh -c 'npx vitest run'` 后 evaluator 仍错误 PASS；`pnpm exec bash scripts/verify.sh`、`npx ./scripts/verify.sh`、`pnpm exec make test` 同样被放行。Lead 对 question `82c210fe` 裁定为本单 must-fix，与 claim 1420 同类：任意代码委托必须递归，无法证明时只能 `unknown`，不得默认 `not_test`。

提交 `248cc93cb` 先加入 evaluator-level RED：首个 `pnpm exec sh -c 'npx vitest run'` 实测为 `not_test`，定向用例 0/1。最小修复在剥离 manager/npx 的已知 option 后，把真实 delegate words 递归交回同一个分类器；内层 broad Vitest 因此直接 FAIL，内层 shell command 继续递归，local script / node script / make / 未识别 delegate 则 fail-closed 为 INCONCLUSIVE。递归结果若仍只是普通 `not_test` 也会收紧为 `unknown`，只有 manager 自身的显式非测试命令（如 `pnpm lint`、`pnpm why vitest`）沿用既有安全语义。回归覆盖 13 个隐藏 broad-run 形态、13 个未知脚本/make delegate、四个 Lead 指定 related/dlx control，并逐个断言最终 evaluator 为 FAIL 或 INCONCLUSIVE；合规显式单文件与 changed-file related 保持 PASS。

## QA@3 后代码复审返工

Code review R9（gate `6209634f-bed6-4fa0-b269-80af7acd520c`，request `2f79b2d6-c954-426c-822a-59e05f342487`，reviewed head `79b1aa5434ff6ca7d8114bd2e8e3c27f376528c5`）判 CHANGES_REQUESTED，唯一 HIGH 指出 Codex 同一个 `custom_tool_call:exec` 内若同时存在可静态解码的 `cmd` 和动态 `cmd`，提取器只返回前者并静默丢掉后者。构造的合规显式文件命令加动态 broad Vitest、再加合规 related 命令因此会错误 PASS，正是 observer 必须避免的假绿。

提交 `a6ab4e5a2` 先加入同形回归并得到 0/1 RED，再让静态提取器记录任一无法解码的 `cmd:`；只要同一 tool call 含动态 command，整次调用便产生 `parseStatus: unknown`，最终 verdict 为 INCONCLUSIVE，不再把部分静态列表冒充完整执行记录。修复后聚焦回归 1/1、整个直接相关 Node 文件 42/42、discipline deploy contract 15/15。R9 的另五项 MEDIUM/LOW 是非阻断 advisory（allowed chain 聚合、shell-variable positional、evidence env-token 脱敏、near-value exclusion、非 test 名 script alias），保留为 PR Follow-ups，不在本轮扩张范围。

## QA@4 delegated read-only 对称返工

QA@4 在 head `27babc7e6a4f59fa4a1b855b2c7fe26837f075ec` 证明 QA@3 blocker 与 mixed-dynamic HIGH 已关闭，且 full CI run `35866669958` 经同头 failed-job rerun 后达到 `CI OK` / `full_green`。但 QA 的 symmetry battery 发现递归 delegation 会把所有内层 `not_test` 一律降成 unknown：`pnpm exec git status`、`npx biome check .`、`pnpm exec tsc --noEmit`、`pnpm exec pnpm install` 四个普通本机检查都会令 529 cell 永远 INCONCLUSIVE。Lead 对 question `b49d18d3` 裁定这不是 follow-up，而是本轮 blocker：delegated path 必须复用裸命令的正向非测试 allowlist，其余未知 delegate 仍 fail-closed，测试执行仍 FAIL。

提交 `8ccbef1f8` 先加入四组 bare/delegated 对称断言和完整 evidence PASS 回归，定向得到 0/1 RED；随后抽出共享的明确非测试判定，只覆盖 git/cat/rg/jq 等发现命令、Biome check、TypeScript `--noEmit`、ESLint、Prettier `--check` 以及 package install 等明确维护命令。delegation 递归只有命中这份 allowlist 才保留 `not_test`，其他内层 `not_test` 继续降为 unknown。QA 独立 battery 从 `violations=4` 变为 `violations=0`；25 个违规 delegate、未知脚本/make、显式单文件与 related controls 全部保持原 verdict。`node verify.mjs` 的过严判定仍按 Lead 裁定留作 follow-up。

## QA@5 真实矩阵观察器返工

QA@5 在 head `2ce1802054a48f77d2566c9f3bb024be4fec6a39` 首次跑通真实 cell A 的两侧 runner：implement 的 `claude-opus-5` 只用 literal grep、逐文件 Vitest、changed-file related、fixture verifier 与 lint；QA 的 `gpt-5.6-sol` 也没有运行裸 Vitest、整包或整仓命令。产品 prompt 因此有效，FAIL 来自新增 observer 本身。原 observer 把七个显式测试文件组成的静态 shell loop 错判为 forbidden，并且没有完整追踪 Claude subagent、Claude 发起的 Codex review thread、Codex `CommandExecution` 真命令、`/tmp` realpath、workflow node 的 durable done 回执及 Vitest 写入的 `.vite` cache；干净 checkout 还可能因 inbox MCP 未构建而卡在 Lead ready。

本轮先以 QA 原始 transcript 形态写 RED，再做最小 observer 修复：

- Codex rollout 优先读取 resolved `CommandExecution`，不再把外层 `functions.exec` JavaScript envelope 当 shell；动态或缺失内层命令仍 fail-closed。静态 `for f in <明确文件...>` 会展开为逐文件选择，动态测试 loop 仍 unknown；只读 discovery loop、真实 runner 的明确非测试 wrapper 与数组赋值不再制造假 unknown。
- transcript 定位优先绑定 `sessions.thread_id`，把 worktree 与 transcript 路径 canonicalize 后再比对，并仅在 durable id 缺失时以 exact execution id 作唯一 fallback；Claude 主 session 会纳入其 owned subagents 及 transcript 中明确报告的 Codex review threads。任一子 session 缺失、未完成或无完成回执仍令 cell 不得 PASS。
- generalized implement/QA completion 接受 authoritative workflow node `state=done` 且有 `ended_at`；这与 QA session 因 founder gate 保持 running 的真实 DAG 形态兼容，而不把普通未完成 session 放行。
- fixture tree hash 仅忽略顶层 `node_modules` runtime cache，源树的额外文件仍会改变 hash。`test-deploy.sh` 在 teamlead 前构建并校验 `flywheel-inbox-mcp/dist/index.js`，修复 clean-checkout room 的真实启动依赖。

Lead instruction `dd41d630-ec0c-4f74-b985-20e152889274` 又把边界钉窄：脱离可静态展开 loop 的 shell 变量位置参数必须是 unknown，不能误报 forbidden；`pnpm exec vitest` 与 `./node_modules/.bin/vitest` 必须同形判定。两种入口的 `"$test_file"` 都先 RED 为 forbidden，修复后都稳定为 `dynamic_test_selection`；静态显式 loop 仍 PASS，真实 broad command 仍 FAIL。

把 QA@5 的 live DB 行、Claude 主/子 transcript、嵌套 Codex review rollout 与 QA Codex rollout 原样送入新 collector 后，implement 收集 3 个 session / 81 条命令，QA 收集 1 个 session / 54 条命令；用真实 selection 与 manifest 重新 evaluate，两侧 verdict 均为 PASS、findings 为空。既有 FLY-2775 broad-command 负控仍为 FAIL。这里证明的是 observer 对 QA@5 原始件的离线重放，不冒充新的真实 room A–D 或 QA 复测结果。

## QA@5 后代码复审返工

Code review R10（gate `af195613-e336-4788-84cb-10c6dd6a7769`，request `13719555-1ddb-4981-8748-0e002cad3168`，reviewed head `8817e6331723af4e416875df31f5cf0efb3bf467`）有效判 CHANGES_REQUESTED。唯一 HIGH `quoted-command-substitution-bypass` 证明双引号/反引号中的 command substitution 会被 shell tokenizer 吞成普通 word，使 `OUT="$(pnpm exec vitest run)"` 与等价 `eval` / `find -exec` broad run 在完整 evidence 中错误 PASS。

返工先以 reviewer 给出的五种真实形状复现 0/1 RED，再让 observer quote-aware 地提取 `$()` 与 backtick body 并递归使用同一分类器；single quote 仍是 literal，动态/未闭合 substitution 为 INCONCLUSIVE。静态 `eval` 与 `find -exec|-execdir` 同样递归，已证明 broad run 为 FAIL；合法显式单文件 substitution 仍为 allowed，普通 `$(git status)` 仍为 non-test。最终直接 Node suite 54/54、policy 5/5、discipline deploy 15/15、targeted Biome、语法检查与 `git diff --check` 全绿。R10 的五项 MEDIUM 和一项 LOW 均是非阻断 advisory，按 Lead 锁定的 QA@5 四条范围不在本轮扩修。

Code review R11（gate `c88505b2-8e03-4bd8-ae4e-4b140f70edf3`，request `ca5eaa6b-acea-48c3-9588-20de75cb54f0`，reviewed head `d6040e8ae737fe973f9d78796eab667620251e49`）再次阻断同一 HIGH 的两个早退面：anchored `for ... in ...` 在 scanner 前返回，且所有 heredoc body 都被删除，导致 loop item substitution 与未引用 delimiter heredoc 中的 broad Vitest 继续错误 PASS。

本轮先用 `$()` / backtick loop list、unquoted heredoc 与最终 evaluator 加 0/1 RED；随后在 loop raw item list 内先递归 substitution，并让 heredoc scanner 只保留 shell 会展开的未引用 body，单引号/双引号/反斜线 delimiter 仍保持 literal。为避免修 HIGH 时重开 QA@4 false-red，`$(cat $EVIDENCE/...)`、`$(dirname "$0")` 与 benign `find -exec rm` 均沿用裸命令的 non-test 语义，只有动态 executable 保持 unknown。最终直接 Node suite 55/55、policy 5/5、discipline deploy 15/15、targeted Biome、语法检查与 `git diff --check` 全绿；其余非阻断 advisory 未扩修。

Code review R12（gate `ba1c5625-a65e-40fd-826b-2365b85ee2b7`，request `391c8fba-f571-461c-a286-6a326b512349`，reviewed head `4c826b995dedc655e783032d6bb4b9d5f99414ec`）又发现 unquoted heredoc 的正文被拼回主 scanner 后会泄漏 quote state：普通 `don't forget` 会把后续 `$()` 隐藏，完整 evidence 再次错误 PASS。返工以 reviewer 原命令先得到 0/1 RED，然后把外层命令与每个可展开 heredoc body 分离扫描；正文 quote 字符按 heredoc 语义视为 literal，而 substitution 内部仍用正常 shell quote 规则。quoted delimiter body 完全不扫描，unquoted body 内与 body 后的 broad substitution 都稳定 FAIL；其余 advisory 未改。

Lead instruction `2cd0c5cf-21d1-4f65-8633-6f1f6d48c22b` 同轮指出 suite 文档的 standalone C/D 房间没有 generalized 对 FLY-127 的 scope override，而合成单又没有标签，实际会被 403。generalized 配置刻意没有 standalone `engineer` 映射，因此保留 C/D ordinary room，并把两条部署命令与两张合成单共同绑定 `runner-test-discipline` 标签。deploy contract 先出现 3/18 RED，文档修复后 18/18 GREEN；合并定向回归为 Node 55/55、policy 5/5、deploy 18/18、targeted Biome、语法与 diff 检查全绿。

## QA@6 精确头返工

QA@6 在 head `4041ed76ab82166430321050e4a504534885f6a0` 证明 generalized 完成回执的修复仍是死代码：等待查询只投影 `n.state` 与 `s.*`，但 `sessions` 没有 `ended_at`，所以真实 QA 行虽已 `workflow_run_node.state=done`，`hasRoleCompletionReceipt` 仍返回 false；原单测手工构造了生产查询无法产出的行。返工先加入 SQLite 级查询测试得到缺失 export 的 RED，再抽出生产共用的 `loadGeneralizedRoleRows`，把 `n.ended_at AS ended_at` 放在 `s.*` 后显式投影。冻结的 QA 旧查询仍得到 `wait would succeed: false`，同一 slot-1 / run `5dfae666-2341-4037-b5be-ffec65ad9fe3` 用新生产查询实测两侧 `ended_at_key_present=true`，最终 `wait would succeed: true`。

同一 exact-head full CI run `35959595822` 的 15 个执行 job 中 14 个成功，唯一失败是 `Script Tests 1/6`；其 `test-deploy-fly1389.test.sh` 假仓没有新 preflight 守卫要求的 `packages/inbox-mcp/dist/index.js`，而 `pnpm` stub 为 no-op，导致 18 条 hermetic deploy 连锁失败。返工只对称 edge-worker fixture 创建假 `dist/index.js`；完整脚本从 7 passed / 18 failed 变为 24/24。合并验证为 Node 56/56、fly1389 24/24、`pnpm lint` exit 0（仅既有 warnings）、targeted Biome、shell/MJS 语法与 `git diff --check` 全绿。

## QA@7 nested heredoc quote-state 返工

QA@7 在 head `1d61ccfa0676367704e72b65ec0f155100d28a11` 用保留的真实 cell-A transcript 证明合规 implement 命令仍会令 529 cell 永远 INCONCLUSIVE：仓内常用的 `gh pr ... --body "$(cat <<'EOF' ... EOF)"` 形状若正文含奇数个单引号或双引号，quoted heredoc body 会污染 command-substitution scanner 的 quote state。更严重的同根现象是正文中的奇数双引号会把终止符后的 broad `npx vitest run` 从明确 `forbidden` 降成 `unknown`。独立 QA probe 在修复前为 `mismatches=6/11`。

根因在 `heredocOpeners`：它看见外层 `"$(...)"` 的双引号后，没有为 `$(` 建立独立 shell scope，因而跳过 substitution 内的 `<<'EOF'` opener；后续 `dollarCommandSubstitution` 直接扫描未隔离正文。返工先把五种合规 PR/commit prose 与两种“正文后 broad Vitest”写入 owning suite，得到定向 0/1 RED；随后让 opener scanner 在双引号内遇到 `$(` 时进入独立 scope，并为 substitution scan 提供“移除 body、保留 delimiter”的视图。word scanner 仍使用原来的“移除 body 与 delimiter”视图；quoted body 仍不分析，unquoted body 仍单独扫描 expansion，delimiter 后的命令仍保留。修复后新用例 1/1、owning suite 57/57，QA probe `mismatches=0/11`。

## QA@4 F17/F18 验收门返工

QA 在精确头 `8862eee26ec021e9deb3c579f29a5b1c5036d20c` 证明产品 prompt、判定器既有红臂与 full CI 均绿，但 529 验收门还有两个自身缺陷。本轮只修这两项：

- F17 先用 standalone `expected=[generic]` 行为用例得到 31/32 RED。`qa_generalized_menu_ready` 的 code 拓扑检查改为与既有 simple_code 检查同构：只有 expected 含 code 才要求 code；generic-only 转绿，两组 generalized control 保持原判定。QA 原始 probe 中另有一格要求“实际含额外 code、expected 仍仅 generic”也 ready；这与 helper 保留的 `menus == expected` 精确合同冲突，不为让 probe 数字归零而放宽 unexpected-menu 守卫。
- F18 采用 Lead 允许的方案 (a)，不猜一个尚未测完的更大 wall-clock：首轮 implement/QA 已有 durable `ended_at`、implement@2 已 admitted，且 attempt 2 的原生 transcript 至少出现一条已完成成功的 allowed 测试命令或一条 forbidden 测试命令后即可结算。首轮完成角色仍是正式 verdict cases；attempt 2 命令另存带 hash、tool call id 和分类理由的 observation，forbidden 仍优先令总结果 FAIL。
- `/api/runs/start` 成功后、进入长等待前立即写 exact cell/slot/head/request/response 绑定的 `run.json`。180 分钟窗口到期会冻结所有已终态角色并写 `observation_window_expired`，因此证据根不会再是零字节，也不能误绿。新增 `collect --slot --run-id ...` 只读取这份 receipt 和既有 run，不再次 POST；case 与 observation 按 attempt/execution 身份追加，后续 PASS 不得覆盖同 run 的既有 FAIL/INCONCLUSIVE。

F18 冻结时间线回放先证明旧逻辑在 `current_node_id=implement` 时只能返回 false；新增回归用同一形状的 implement@1 done、qa@1 done、implement@2 running 行验证 bounded completion，并用两个已完成 case + timeout observation 验证总 verdict 必为 INCONCLUSIVE。修复后 owning Node suite 91/91、discipline deploy 32/32、QA generalized helper 9/9、test-deploy generalized 全绿；没有启动或拆除任何 529 房。

本轮重新发现的直接消费者是 `scripts/test-deploy.sh`、discipline deploy shell contract、owning Node suite、QA suite 文档与本 issue 实施证据；均已覆盖。`qa-generalized.sh` 的其余 filename 命中是历史 docs、路径/kill inventory、只 source helper 但不调用 menu predicate 的 teardown/wrapper/独立 room tests，排除；仍额外保留并运行 `test-deploy-generalized.test.sh`。`qa-runner-test-discipline.mjs` 的其他命中是 plan/README/phase prompt 中的协议链接或 CI 登记，不执行 F18 completion/collection 分支，排除。根级 MJS 与 shell/helper 改动没有 TypeScript `vitest related` 输入，也没有 workspace package build target。

这些仍是本机定向证据，不代替 QA 对新精确头的 F17/F18 真房复测或 exact-head full CI。

Code review R14（gate `15387055-451d-472f-9743-5f642da625e8`，reviewed head `ad80811b20d0d8e97a0d5e3254cec09a58e9ae48`）判 CHANGES_REQUESTED：F18 只保留每个 role 最新 attempt，且 collect 会复用 role 目录与替换同 run observation，使 attempt 1 的整包违规可被后续 PASS 洗掉；同路径还只看第一条测试命令，正常 TDD RED 会永久挡住 bounded settle。返工先把两项写成定向 RED，再让每个已终态 attempt 使用 attempt/execution 唯一目录且拒绝覆盖，observation 按身份追加并保留最严重 verdict；rework scanner 遍历当前全部命令，forbidden 优先，随后才接受任一成功 allowed 命令。聚焦 3/3、owning Node 文件 93/93、两个改动文件 targeted Biome 与 `git diff --check` 全绿。其余三条 MEDIUM/一条 LOW 为非阻塞 advisory，只进 PR Follow-ups。

## 消费者发现与取舍

按每个改动文件的 full path、file name、parent directory 以及 policy/test-discipline literal 执行 `git grep -lF`。保留并运行的直接消费者包括 policy/phase 同步器、package gate、FLY-2121/2533 prompt assets、SkillInjector、Blueprint composed prompt、workflow phase protocol、ConfigLoader/AgentDispatcher、test-deploy generalized/multilead、QA executor contracts、milestone/diagram guards及 CI suite enumeration。

排除项及理由：

- `README.md`、`package.json`、`plan.md`、`scripts`、`packages`、`engineering/doc` 等通用 basename/parent 命中只表示同目录或历史文档重名，不读取或执行本次改动载体，排除。
- `doc/`、`engineering/doc/`、`product/doc/` 中历史设计/报告命中只记录旧流程或 529 叙述，不是 runtime consumer，排除；本 issue 自己的 docs 保留为交付证据。
- test-deploy 的大量 smoke/历史脚本仅字符串提及通用入口，实际改动分支由新增 deploy contract、既有 generalized/multilead suites 和计划点名的直接消费者覆盖；未把目录共址命中冒充因果依赖。
- ConfigLoader/AgentDispatcher 的其余测试只共用类名；本次未改两个类，保留 registry/dispatch 直接测试以及用真实 dist 的 standalone fixture，排除无关 feature-specific suites。

返工再次对两个改动文件运行同一发现法：完整路径与 filename 的直接 runtime consumer 是 `scripts/qa-runner-test-discipline.mjs`，直接测试是 `scripts/__tests__/runner-test-discipline.test.mjs`，CI 登记是 `.github/workflows/ci.yml`；plan、implementation 与 QA suite 仅是说明文档。R5 修复后的通用 parent 查询 `scripts/lib` 有 718 个命中（原始 `git grep -lF` 输出 SHA-256 `51d95c0706dc478abbe3dd029f23f8d2ceab0b78a337c164ba793eef97c7fca2`），`scripts/__tests__` 有 842 个命中（SHA-256 `d86e2f8f500c66f149463d43368092b01f1655560c91481a01fdb2bfe8047201`）；除上述直接消费者外，这两个集合的每个命中都只引用通用目录或其他 suite，作为整集合排除。清单可由 `git grep -lF -- <parent>` 重建，没有用共址命中扩张本地测试范围。

Quick Gate 返工文件 `scripts/__tests__/ci-structure.test.sh` 的完整路径/filename 查询中，直接执行者只有 `.github/workflows/ci.yml`；文件自身的两个命中是自检。`ci-matrix-coverage.test.sh` 只在注释解释职责边界，`qa-fly-2007-phase0-analyze.test.sh` 只 grep 自己的 FLY-2007 名称，其他命中都是历史文档，因此排除。实际运行与红 job 相同的三个结构命令，并补跑枚举，不扩成全仓 shell suite。

QA@2 返工再次按两个改动文件的完整路径、filename、parent directory 做 `git grep -lF`。六个结果集合依次为 7 / 19 / 88 / 5 / 9 / 8 个文件，排序输出 SHA-256 分别为 `50e8a59a94648c592b1496e678c20fa58fdadd0ab919f14ba0bd74e7b825934d`、`7e13ccbe32471f758f5dca15a2a89640a082fc22ce722d237ec97fcec556ffb5`、`42c9505db890bd0d8e0394bcedca0b42d18e957cbeaffb2e1fd4e056c0385668`、`aad0d5c0f784beca29d0c12228f92d6ab98291bd5316b934e42c558ff5b1ebb0`、`7aa67888898b67909a7ee0450ab44145bdf6a2a196cda71dd5f7eb204118baf2`、`e4898ff5e2e9f22ffca5bad291b74a57c43eb3d21c6bd408aaac575f2299146e`。唯一 runtime consumer 是改动的 Blueprint 测试读取该 fixture；保留它的聚焦 Vitest 与 `vitest related`，并保留计划点名的 FLY-2533 packed asset shell contract。其余每个命中都是历史 plan/research/report、成本/路径 inventory、archive 文档或同目录泛称，不执行这两个测试资产，按上述完整集合排除。

R8 对六个改动文件再次逐一用 full path、filename、parent directory 运行 `git grep -lF`。关键集合为：`runner-test-discipline.mjs` 1 / 5、`qa-generalized.sh` 14 / 20、`test-deploy.sh` 234 / 334、三个测试文件 full-path 分别 3 / 1 / 30；parent `scripts/lib`、`scripts`、`scripts/__tests__` 分别为 718 / 3332 / 842。对应排序输出 SHA-256 依次为 `75a05c448850b63002ecb414d82ad95340a328376cf6b56506de7dd1e1bd491c` / `4ea8329b41be88e23400e82fd65070487f4761372209d29a5f62309368758cc0`、`09e919e5729a7b7ae2b2fea9ae3279ce885904fc255a3ad2f166f26eaabce03c` / `0337a09130b1496faa7a0581234a58ccac5bdac6fa7e39d509572805303c2f0c`、`c9e3b196902c7995d28d45ad025971d98dbde5cbe67ff5a22b921884ef3707c3` / `8f30f4bd09b840a8bb90dda9a89f9dc5d4e1031c6463e2ec4b0291bf64ecd338`、`29c43d97c1b3b00479f9601216bb9ed7e3898030cf4d3dd55bbee92202f64b78` / `b1e4fcd28055c712644fe84f6a1e30a41018cf387dd808cec348f2e505e33a2a` / `acca895b52fbca1565cfa7c8fa31729cd1aa5fd994da88973b7bfdadd9f642e3`，以及 `51d95c0706dc478abbe3dd029f23f8d2ceab0b78a337c164ba793eef97c7fca2` / `dcab4e6c2cc6a3cf4bab6ce4859f9c898aaf80d954bef930f4d67634eee7c953` / `d86e2f8f500c66f149463d43368092b01f1655560c91481a01fdb2bfe8047201`。保留的直接消费者是 evaluator CLI、test-deploy 对 generalized helper 的调用，以及三个变更测试；`.github/workflows/ci.yml` 仅登记 suite。其余每个命中属于历史文档/证据/路径 inventory、未调用新增 helper 的既有 room 测试，或通用目录共址；它们不经过本次三个分支，按这些完整集合整体排除。另保留并运行 `test-deploy-generalized.test.sh`，因为它直接断言被抽取的 menu predicate；其他 source-only helper tests 不调用新增函数，排除。

QA@3 本轮两个改动文件重复执行同一发现法。`runner-test-discipline.mjs` filename 集合仍为 5 个文件、SHA-256 `4ea8329b41be88e23400e82fd65070487f4761372209d29a5f62309368758cc0`：直接 runtime consumer 只有 `scripts/qa-runner-test-discipline.mjs`，直接回归是本次改动的 Node test，QA suite 与本 issue docs 是协议/证据。`scripts/lib` parent 集合仍为 718 个文件、SHA-256 `51d95c0706dc478abbe3dd029f23f8d2ceab0b78a337c164ba793eef97c7fca2`；`runner-test-discipline.test.mjs` filename 集合为 workflow + 两份本 issue docs，`scripts/__tests__` parent 集合仍为 842 个文件、SHA-256 `d86e2f8f500c66f149463d43368092b01f1655560c91481a01fdb2bfe8047201`。除 evaluator CLI、其直接 Node suite、529 deploy contract 与 CI 登记外，所有命中都是通用目录共址、其他独立 suite 或历史文档，不调用此次 delegate 分支，按完整集合排除。

R9 返工仍只改上述两个文件，并再次运行同一六组查询。filename/full-path 直接命中为本 issue 的 plan/implementation、QA suite、直接 Node test、evaluator CLI 与 `.github/workflows/ci.yml` 登记；`scripts/lib` parent 仍为 718 个文件（SHA-256 `51d95c0706dc478abbe3dd029f23f8d2ceab0b78a337c164ba793eef97c7fca2`），`scripts/__tests__` parent 仍为 842 个文件（SHA-256 `d86e2f8f500c66f149463d43368092b01f1655560c91481a01fdb2bfe8047201`）。保留 evaluator CLI、直接 Node suite、deploy contract 和 CI 登记；其余每个命中仍是说明文档、通用目录共址或不经过 Codex command extraction 的独立 suite，按完整集合排除。

QA@4 symmetry 返工仍只改相同两个文件，六组发现结果未变：filename/full-path 直接命中仍是 evaluator CLI、直接 Node suite、QA suite/docs 与 workflow 登记；parent 集合仍为 `scripts/lib` 718 个（SHA-256 `51d95c0706dc478abbe3dd029f23f8d2ceab0b78a337c164ba793eef97c7fca2`）和 `scripts/__tests__` 842 个（SHA-256 `d86e2f8f500c66f149463d43368092b01f1655560c91481a01fdb2bfe8047201`）。保留 evaluator CLI、直接 Node suite、deploy contract 与 CI 登记，其余每个命中继续按说明文档、通用目录共址或独立 suite 排除。

QA@5 对五个改动文件逐一用 full path、filename 与 parent directory 重新发现消费者。保留的直接路径是 evaluator CLI、直接 Node suite、529 deploy contract、launch-boundary contract、generalized/multilead deploy tests、preflight GitHub contract 与 CI suite enumeration；`test-deploy.sh` 的大量历史 smoke 命中及 `scripts` / `scripts/__tests__` 共址命中不执行本次新增的 inbox build 或 transcript collector，按整集合排除。根级改动均为 MJS/shell，没有 changed TypeScript，因此没有可运行的 `vitest related` 输入；唯一新增 workspace build 边是 `flywheel-inbox-mcp...`。

QA@7 仍只改 evaluator 与 owning Node suite，六组 full path / filename / parent 查询保持直接集合不变：`runner-test-discipline.mjs` full path 1、filename 5，test full path/filename 各 3；parent `scripts/lib` 718（SHA-256 `51d95c0706dc478abbe3dd029f23f8d2ceab0b78a337c164ba793eef97c7fca2`），`scripts/__tests__` 842（SHA-256 `d86e2f8f500c66f149463d43368092b01f1655560c91481a01fdb2bfe8047201`）。保留 evaluator CLI、直接 Node suite、QA probe 与 CI 登记；其余命中是本 issue 文档、QA suite 说明、通用目录共址或其他独立 suite，不调用本次 heredoc opener 分支，按完整集合排除。根级 MJS 没有 workspace package build 或 TypeScript `vitest related` 输入。

## 本机定向验证

全部命令均在本分支运行；没有本机整包 Vitest/package suite。

- 同源/静态：`sync-runner-test-policy --check` 4 projections；`sync-phase-protocols --check` 9 projections；policy Node suite 5/5；package gate 22/22；QA generalized helper 9/9。
- 行为判定器：返工前新增用例得到 36 pass / 2 fail，修复后 38/38；R5 shell 用例先得到定向 0/2 RED，Lead residue 用例再得到 1/2 RED，修复后全套仍 38/38。构造的 FLY-2775 `npx vitest run --exclude ...` 为 FAIL 负控，合法 Codex 显式文件+related fixture 为 PASS；redirect/heredoc/non-shell Codex/quoted Codex/shallow checkout/TDD red→green/exact fixture/measured count 均有回归，未知 wrapper/option/unterminated heredoc 为 INCONCLUSIVE。QA 独立 `probe-classify.mjs` 为 40/40、`problems=0`，`probe-e2e.mjs` 的 `env -u` / `sudo` / `nice` / `time` / `stdbuf` mutant 全部判 FAIL；Lead residue 修复后重复运行结果不变。
- 包级 Vitest：SkillInjector 14/14；Blueprint FLY-2533 18/18（另 12 skipped by name filter）；teamlead phase protocol 11/11；ConfigLoader registry 6/6；AgentDispatcher registry 3/3；四个改动 skill template 的 `vitest related ... --run` 14/14。
- shell：新增 deploy contract 13/13；FLY-2121 12/12；QA executor 529 20/20；ship-report 26/26；runtime-role retirement PASS；milestone layout 32/32 与 mutations 27/27；diagram roles 14/14；FLY-2533 assets PASS；test-deploy generalized PASS；multilead 29/29；merge 返工后 CI enumeration 再次 PASS（345 shell suites classified、87 Node suites enumerated）；Quick Gate 红灯返工后 CI structure PASS、scope 20/20、full-reuse 28/28。
- 构建：`flywheel-edge-worker...`、`flywheel-teamlead...`、`flywheel-claude-runner...` 的合并 affected graph 共 13 workspace projects通过。
- lint：R5 修复后 `pnpm lint` 再次退出 0；报告的是未改历史文件 warning。本单原变更的 27 个 JS/TS/MJS 与返工的两个 MJS 文件分别跑 targeted Biome，零诊断；`git diff --check` 通过。返工没有 TypeScript 文件，因此不存在需要补跑的 `vitest related` TypeScript 输入；根级 Node CLI 也没有 workspace package build target。
- QA@2 prompt-budget 返工：先 6/18 RED，再聚焦 18/18 GREEN；`vitest related Blueprint.generalized-workflow.test.ts --run` 30/30；FLY-2533 packed asset contract PASS；CI 的另一个 tmux 红项精确复跑 1/1 PASS；两个改动资产的 targeted Biome 与 `git diff --check` 均通过。`flywheel-edge-worker...` affected build graph 10/10 projects通过；`pnpm lint` 退出 0，仅报告 26 条未改历史 warning。
- R8 三项 HIGH 返工：新增两个 Node case 与两个 deploy behavior case 均先 RED；修复后 evaluator 全文件 40/40、discipline deploy 15/15、generalized deploy helper 全绿，三个 shell 文件 `bash -n`、两个 MJS targeted Biome、`git diff --check` 均通过。`pnpm lint` 首次准确抓到本次一处 formatter error，修正后退出 0，仍只有 26 条未改历史 warning。此次只改 root scripts，没有对应 workspace package build 或 TypeScript `vitest related` 输入，也没有运行不存在的整包 suite。
- QA@3 delegation 返工：新增聚焦用例先 0/1 RED；修复后 evaluator 全文件 41/41，QA 独立 delegation battery 的全部 26 个任意 delegate 与 broad/allowed/read-only controls 均符合预期、`violations=0`，discipline deploy 15/15。两个改动 MJS 的 targeted Biome 与 `git diff --check` 零诊断，`pnpm lint` 退出 0、仅 26 条未改历史 warning。根级 MJS 没有 workspace package build 或 TypeScript `vitest related` 输入；没有运行本机 full package/repository suite。
- R9 mixed dynamic exec 返工：新增聚焦用例先 0/1 RED，修复后 1/1 GREEN；直接相关 Node 文件 42/42、discipline deploy 15/15。两个 MJS targeted Biome 与 `git diff --check` 零诊断，`pnpm lint` 退出 0、仍仅 26 条未改历史 warning。根级 MJS 没有 workspace package build 或 TypeScript `vitest related` 输入；没有运行本机 full package/repository suite。
- QA@4 delegated read-only 对称返工：新增聚焦用例先 0/1 RED，修复后 1/1 GREEN；QA 独立 symmetry battery `violations=0`，直接相关 Node 文件 43/43、discipline deploy 15/15。两个 MJS targeted Biome 与 `git diff --check` 零诊断，`pnpm lint` 退出 0、仍仅 26 条未改历史 warning。根级 MJS 没有 workspace package build 或 TypeScript `vitest related` 输入；没有运行本机 full package/repository suite。
- QA@5 observer 返工与 R10–R12/C/D 门禁：新增回归均先 RED，修复后直接 Node suite 55/55、policy suite 5/5、discipline deploy 18/18、launch-boundary PASS、multilead 29/29、generalized helper PASS、preflight GitHub 3/3、CI enumeration 345 shell / 87 Node、policy 4 projections 与 phase 9 projections 全绿；`flywheel-inbox-mcp...` affected graph 5 个 workspace project build 通过。三个 MJS 的 targeted Biome、两个 shell 文件的 `bash -n` 与 `git diff --check` 通过。`pnpm lint` 已执行，但被未改的 FLY-1547/1563 研究夹具及旧脚本中的 4 个仓库基线 error 阻断；本次改动文件单独检查为零诊断。generalized suite 前两次在并发残留下分别抖动于未改的 5 秒 daemon fixture，清空并发后完整串行复跑全绿；没有修改该夹具来掩盖时序红项。
- QA@6 完成回执/CI fixture 返工：数据库级查询回归先 RED，修复后真房 `wait would succeed: true`；直接 Node suite 56/56，`test-deploy-fly1389.test.sh` 24/24，`pnpm lint` exit 0（仅既有 warnings），两个 MJS targeted Biome、shell/MJS 语法与 `git diff --check` 全绿。没有扩大到 QA 明列的既有 `bash -s` follow-up，也没有在本机运行 full package/repository suite。
- QA@7 nested heredoc 返工：新 owning case 先 0/1 RED，修复后 1/1；直接 Node suite 57/57；QA heredoc probe 从 6/11 mismatch 转为 0/11。delegation battery `violations=0`，100-case wrapper matrix仍为已接受的 `holes=1 / false_red=0`，R8 battery仍为历史基线 `holes=0 / false_red=3`。两个 MJS targeted Biome、MJS 语法、`git diff --check` 全绿；`pnpm lint` exit 0，仅 26 条未改历史 warning。没有本机 full package/repository suite。

这些是本机定向证据，不是 full-suite 或 exact-head CI 证据。

## 529 挂起与后续硬门

Lead instruction `fafa5293-965c-4d63-9356-5d68312acd8f` 裁定：不得摘除 `cmux-maintenance`，不得绕过或重试 deploy；旧 watcher 的修复 FLY-2770 尚未上线。候选 `c3bf201054a4db2e7a41db4c92e636b18207e4fd` 及既有证据均保留，后续判定器补强也未删除旧证据。Lead 随后更正职责：实现节点完成代码/PR 后立即交卷，真实矩阵由 QA 在其余判据完成后等待撤标记；QA 的 claim `1420` 也明确把 A–D 未跑列为“不计入 FAIL”。

上述是早期返工的历史等待状态；QA@5 已在真实 slot 跑出 cell A，并证明两侧 runner 行为合规，但旧 observer 把正确行为判坏，所以这仍不是 A–D 矩阵 PASS。当前返工 head 必须先通过新的精确头代码审查，再由 QA 复跑 A–D、保留所有 FAIL/INCONCLUSIVE 尝试，并以修复后的同一 evaluator 全绿；full exact-head CI 也只由 QA 对 frozen head 请求，`CI Scope OK`、旧 full CI 和本地回放都不能替代。实现节点不会 dispatch QA、approve、merge、ship、deploy 或重启服务。
