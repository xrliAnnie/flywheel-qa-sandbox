# FLY-2965 相关测试选择 — 实施证据
Issue: FLY-2965 (https://linear.app/geoforge3d/issue/FLY-2965/病根-定时班车-restart-servicessh-的非生产-tmux-残留只读审计对-tmpcmuxsock-跑-list)
日期: 2026-09-27
基于: plan.md

按 `local-test-policy/v1`:只跑相关测试,逐个具体文件执行;没有运行任何全仓或整包测试套件。
全套证据只能来自 exact-head PR CI;下列本地结果都不是全套证据。

## 改动文件

`scripts/restart-services.sh`、`scripts/lib/tmux-server-rescue.sh`、`scripts/flywheel-cmux-sync.sh`、
`packages/config/src/feature-flags/truth.ts`、`.github/workflows/ci.yml`,以及测试
`scripts/test-restart-services.sh`、`scripts/test-cmux-sync.sh`、`scripts/__tests__/{restart-storm-gate,ci-structure,codex-home-reconcile-cadence,legacy-swap-broadcast-retirement}.test.sh`、
`packages/config/src/__tests__/flag-truth.test.ts`,新增 `scripts/__tests__/tmux-server-rescue-fd-escape.test.sh`。

## 发现方法

对每个旧/新字面量与每个改动文件的完整路径、文件名、父目录执行 `git grep -lF -- '<literal>'`,只保留测试文件:

- 旧/新字面量:`audit_tmux_qa_residue_read_only`、`tmux-qa-residue-flywheel-session`、`FLYWHEEL_TMUX_AUDIT`、`_tmux_rescue_bounded_exec`、`tmux_rescue_probe`、`restart_lead_visibility`、`merge_lead_visibility`、`resume_admission_best_effort`、`_verify_sidebar_once`、`run_verify_agent_visible`、`verify-agent-visible`、`verify-agents-visible`、`RESTART_VISIBILITY_BATCH`、`FLYWHEEL_VISIBILITY_CMUX_SYNC`
- 路径/文件名/父目录:`scripts/restart-services.sh`、`restart-services.sh`、`scripts/lib/tmux-server-rescue.sh`、`tmux-server-rescue.sh`、`lib/tmux-server-rescue`、`scripts/flywheel-cmux-sync.sh`、`flywheel-cmux-sync.sh`、`flywheel-cmux-sync`、`packages/config/src/feature-flags/truth.ts`、`feature-flags/truth`、`truth.ts`、`feature-flags/`、`scripts/lib/`、`.github/workflows/ci.yml`、`ci.yml`

共命中 272 个测试相关文件:**110 个逐个运行,162 个排除**。每个文件的处置、命中字面量和排除理由见同目录 `test-selection-matches.tsv`(机器生成,逐行)。

## 排除项(162)

| 类别 | 数量 | 理由 |
|---|---|---|
| 仅父目录字面量命中(`scripts/lib/`、`feature-flags/`) | 140 | 只引用同目录下其他文件;逐文件核验不含任何改动文件名或改动符号 |
| `ci-shell-suite-manual-only.txt` 名单 | 16 | 需真宿主/Discord/launchd,非 hermetic;逐文件核验不引用任何改动函数 |
| fixture / 数据文件 | 5 | 其消费测试均已运行(kill-path-inventory、Blueprint.generalized-workflow、fly2278-retirement、ci-shell-suite-enumeration) |
| `scripts/test-teardown.sh` | 1 | QA 拆房工具,不是测试;运行会拆真实 529 房 |

## 运行结果(逐文件,worktree 或冻结快照)

改动直接覆盖的核心文件在冻结快照(`git archive` + 覆盖改动,避免运行中被我后续编辑干扰)上运行:

| 文件 | 结果 |
|---|---|
| `scripts/test-restart-services.sh` | R0 头 185/0;R1 修复后 188/0 |
| `scripts/test-cmux-sync.sh`(/bin/bash 3.2) | R0 623/0(基线 618 + 新增 5);R1 修复后 624/0 |
| `scripts/__tests__/tmux-server-rescue-fd-escape.test.sh`(新增) | 17/17,连续多轮 |
| `restart-storm-gate`(bash5,同 CI)、`tmux-server-rescue{,-lock,-instrumentation}`、`codex-home-reconcile-{cadence,cycle}`、`legacy-swap-broadcast-retirement`、`rollback-r4`、`restart-deploy-consistency`、`restart-deployed-range`、`restart-services-{admission-pause,no-voice-bridge}`、`host-tmux-selection-restart-mounts`、`restart-cmux-watcher`、`agent-visibility`(39/0,worktree 构建 dist 后)、`ci-structure` | 全部通过 |
| 其余 50 个路径命中的 hermetic shell 测试(cmux 系列、converge、launchd、provision、shuttle 等) | 46 个一次通过;4 个见下「环境性」。R1 改了 evidence 行格式后,cmux 系列 24 个 + agent-visibility 在 worktree 重跑:除已对照的 `fly1944-attach-protocol` 外全部通过 |
| CI 结构类:`ci-classify`、`ci-full-reuse`、`ci-matrix-coverage`、`ci-shell-suite-enumeration`、`release-workflows-structure`、`fly1663-launchd-foundation`、`qa-fly-2007-phase0-analyze`、`test-runner-workspace-trust`、`update-flywheel-sources`、`teamlead-shards.mjs`、`workflow-startup.mjs`、`runner-variable.mjs`、`wiring.mjs` | 全部通过 |
| flag 冻结类:`fly2102-flag-freeze`、`check-flag-truth`、`fly1674-residue`、`test-deploy-generalized`(短 TMPDIR) | 全部通过 |
| vitest(逐文件):config `flag-truth`(44)、`feature-flags-drift`(14)、`feature-flags-registry`(58)、`fly1808-wave-a`(6)、`fly1981-final-ledgers`(12);teamlead `fly2278-retirement`、`required-wall-clock-thresholds`、`workflow-permissions`、`fly-889-ci-workflow-timeout-guard`、`sync-flywheel-hooks`、`tmux-lookup.real-tmux`、`backend-migration-authority`、`execute-backend-migration`;comm `ci-full`、`ship-ci-guard`、`lead-backend-migration-{context,owner}`;claude-runner `kill-path-inventory`、`scaffold-prune.real-tmux`;edge-worker `Blueprint.generalized-workflow` | 全部通过 |
| `pnpm --filter flywheel-config exec vitest related src/feature-flags/truth.ts --run` | 18 文件 / 331 通过 |
| `pnpm --filter "flywheel-config..." build`、`pnpm --filter "flywheel-teamlead..." build`(RETIRED_FLAGS 依赖方 typecheck) | 通过 |
| `pnpm lint` | rc=0,0 error(25 个既有 warning,均不在改动文件) |

### TDD RED 记录

| 改动 | RED 证据(新测试 + 旧代码) |
|---|---|
| 退役审计 | storm-gate(bash5)与 restart 全流程 1b 在旧代码上失败:旧 restart 对假 tmux server 执行 `lsof -a -p 777777 -U -Fn` 与 `tmux -S <sock> -N list-sessions` |
| 旋钮墓碑 | 旧 `truth.ts` 上 flag-truth 新用例失败 |
| probe 捕获 | fd-escape 10 项失败:超时用例 8.164s、真 tmux 8.158s、已退出子进程被 Python `PermissionError` 崩成 rc=1、TMPDIR 故障 rc=0 且子进程已运行、捕获模式 660 |
| barrier 批量化 | 旧 restart + 新 `test-restart-services.sh`:8 项失败(旧代码对每个 Lead 调 visible 级 17 次),并因缺 `restart_lead_visibility_batch_visible` 中止 |
| R1 伪造回复 | 旧校验上 `no_report` / `bad_report` / `multi_doc` 三种回复均被当作 17 个 pass 消费(`0\|0\|0\|34\|1\|17`) |
| R1 回滚 pin | 旧代码无 `pin_restart_visibility_verifier`,用例中止 |
| R1 UUID 轮换 | 旧代码上 claude-private Lead 的 workspace/receipt UUID 轮换逃过稳定性比较(先用 Runner 标题写的版本在旧代码上也通过 —— Runner 的 authority 本含 ledger 哈希,故改用 Lead 标题重写才得到有效 RED) |

### QA 返工 1(head c945876b8 → 修复)

QA 指出 `feature-flags-drift.test.ts` 在本分支失败:我在 Chunk 1 后跑过它(14/14),但 Chunk 3 与 R1 之后新增的 shell 读取(`FLYWHEEL_VISIBILITY_CMUX_SYNC` 存在性判断)没有触发重跑 —— 本清单把它列为「已运行 · 通过」是基于过时的一次运行,属实报不足。返工后重跑:drift 14/14、flag-truth 45/45、feature-flags-registry 58/58、fly1808-wave-a 6/6、fly1981-final-ledgers 12/12、`vitest related truth.ts` 18 文件 / 332、fly2278-retirement 1/1,shell 的 check-flag-truth、fly2102-flag-freeze、fly1674-residue、test-deploy-generalized 全部通过;`pnpm --filter "flywheel-config..." build`、`pnpm lint`(0 error)通过。详见 `../qa-rework-1-disposition.md`。

### 环境性失败(与本单无关,均已对照)

| 文件 | 原因 | 对照 |
|---|---|---|
| `tmux-server-rescue-real-tmux` | runner TMPDIR 过长,socket 路径超 104 字节,起不了隔离 tmux server | 短 `TMPDIR=/tmp/...` 下:基线与补丁交替各跑多轮,基线出现 1 次失败、补丁 0 次(另在高负载并发时补丁出现过 2 次),属既有负载敏感抖动 |
| `r4-window`、`restart-summary-source-preflight`、`test-deploy-generalized` | tsx IPC socket 在超长 TMPDIR 下 `listen EINVAL` | 短 TMPDIR 下全部通过 |
| `fly1944-attach-protocol` | 宿主 tmux 路径进入 attach 命令语法 | 基线同样 9 passed / 1 failed |
| `restart-account-switch-runtime-preflight` | 账号切换流程在本机不能到达 post-journal pause | 基线同样失败 |
| `package-onboard-smoke` | worktree 只构建了 config/teamlead,缺 inbox-mcp dist;基线因完全无 dist 而 SKIP | 该用例只断言打包含 `tmux-server-rescue.sh`(路径未变) |
| `kill-path-inventory`(首次) | 与后台并发的 `check-global-path-hygiene` 临时目录竞态 | 单独重跑 5/5 |
