# FLY-1870 Script Tests 超时悬崖防雷 — 调研

Issue: FLY-1870 (https://linear.app/geoforge3d/issue/FLY-1870/ci防雷-script-tests-已跑到-187-分钟-上限-20-距超时悬崖-13-分钟翻崖后症状会伪装成-flaky)
日期: 2026-08-18
基于: exploration.md

## 0. 数据口径与采集方法

- 数据源:GitHub Actions API(`gh api repos/{owner}/{repo}/actions/runs/<id>/jobs`,per-step `started_at/completed_at`;`gh api .../jobs/<job_id>/logs` 逐行时间戳)。
- 样本:main 分支最近三轮 `success` 的 run(32080816590 / 32005399130 / 32003288115,均 2026-08-17);per-step 全表取 32080816590,32003288115 做交叉对照。
- 本单**没有**在本机跑任何一条被测 suite(memory 红线:`restart-services` 族在沙箱能杀生产 Bridge;全量重型套件压死 host)。所有数字来自 CI 真实执行记录。
- 保质期:下表秒数会随套件演进过期(as-of 2026-08-17 main)。重核命令:
  `gh api "repos/{owner}/{repo}/actions/runs/<run_id>/jobs?per_page=50" --jq '.jobs[] | select(.name|startswith("Script Tests")) | .steps[] | "\(.name)|\(.started_at)|\(.completed_at)"'`

## 1. Job 级事实

| 指标 | 值 |
|---|---|
| 最近三轮 green main 时长 | 19m21s / 19m06s / 18m48s |
| `timeout-minutes` | 20(ci.yml `script-tests`,FLY-1482 定的 capacity floor,ci-structure 守卫断言 ≥20) |
| 最近一轮距悬崖 | **39s** |
| FLY-1866 32 天均值 | ~18.7min(2,175 轮非抽样) |
| 增长史 | FLY-1482 时代注释记 "~14min on main"(≈数周前)→ 现 19.3min,增速 ~5min/月级 |
| 两轮 per-step 偏差 | 大头 312/297、134/132、104/103、97/97 —— **确定性慢**,非负载噪声 |

## 2. Per-step 全表(run 32080816590,总 1157s = 19.3min)

Setup 前奏(两片拆分后每片都要付一份的部分):

| step | 秒 |
|---|---|
| Set up job + checkout + pnpm/node setup | ~14 |
| Install dependencies(pnpm, 有 cache) | 5 |
| better-sqlite3 prebuilt | 3 |
| **Build(pnpm build, 22 workspaces)** | **73** |
| apt(tmux/lsof/sqlite3/ripgrep) | 8 |
| **setup 合计** | **~103** |

测试 step(≥8s 的;<8s 的合并列出):

| step | 秒 | 占比 |
|---|---|---|
| **Test — FLY-1364 cmux sync repair** | **312** | **27.0%** |
| **Test — FLY-1434 unified restart + quota caller** | **134** | **11.6%** |
| **Test — FLY-1501 restart brake + heartbeat guard contracts** | **104** | **9.0%** |
| **Test — FLY-1663 launchd-native Lead lifecycle** | **97** | **8.4%** |
| Test — FLY-1678 statusline model-scoped bar + installer | 78 | 6.7% |
| Test — payload real-install smoke | 65 | 5.6% |
| Test — FLY-1389 path-hygiene + 529-Room repair batch | 48 | 4.1% |
| Test — FLY-1189 assert library + driver trap owner | 21 | 1.8% |
| Test — FLY-1023 Buddy onboarding | 19 | 1.6% |
| Test — FLY-1726 canonical Lead identity delivery | 17 | 1.5% |
| Test — NPM packaging pipeline + packaged-mode seams | 13 | 1.1% |
| Test — onboard-shell public install chain | 13 | 1.1% |
| Test — FLY-1572 mailbox migration CLI | 12 | 1.0% |
| Test — FLY-648 one-command setup wizard | 12 | 1.0% |
| Test — FLY-1649 r4 migration-window hardening | 12 | 1.0% |
| Test — Discord adapter orphan reaper (FLY-183) | 11 | 1.0% |
| Integration test — cmux-sync hooks | 10 | 0.9% |
| Test — FLY-1496 model resolution + Lead derivation | 10 | 0.9% |
| Test — FLY-1634 restart net-deletion contracts | 10 | 0.9% |
| Test — FLY-1775 generalized-DAG 529 room | 9 | 0.8% |
| Test — FLY-913 restart-guard hook + install + strict-delivery | 8 | 0.7% |
| 其余 24 个 step(FLY-1707/1393/1436/1759/1764/1327/1402/519/1356/1609/1189×2/882/513/697/1018/880/1787/1461/1463/1715/927/957/1729-1743/1081/1338×2/1674/mailbox-adoption/1671 等,各 0–5s) | ~37 | 3.2% |

四大头合计 647s = **55.9%**(✓ issue 的 "4 个吃 55%")。

## 3. 四大头白盒(job log 逐行时间戳 gap 分析)

### 3.1 FLY-1364 cmux sync repair — 312s

12 个 suite 捆绑一个 step。内部分解(log 时间戳):

| suite | 秒 | 时间去向 |
|---|---|---|
| `scripts/test-cmux-sync.sh` | **~226** | 537 tests;FLY-1482 真机 harness:真 kernel lock、真进程、真 tmux server;含 16s 的 "live watcher yields for teardown and resumes"(真 watcher 让位→回收 lease 的 E2E) |
| `tmux-server-rescue*.test.sh` ×4 | ~66 | 47+3+16+7 tests,rescue-real-tmux 起真 tmux server |
| 其余 7 个(link-only/autostart/ownership/live-watcher/lease-contract/finalize/restart-watcher) | ~20 | — |

**处置:保留,不动。** 这套 harness 是 FLY-1482/1596 拿多轮 review + 真机 QA 换来的 lease/teardown 覆盖;FLY-1853 刚修过其中 probe-budget 与墙钟赛跑的 flake。在这里抠秒的期望收益(~1min)撑不起改被测语义的风险。

### 3.2 FLY-1434 unified restart + quota caller — 134s

`setup-quota-monitor.test.sh` + `scripts/test-restart-services.sh`。gap 分析显示两段 ~36s 真实等待:
- "FLY-1224 env wait restores the full-fleet idle gate"(~36s)
- "FLY-1224 FULL restart --wait-idle: idle gate waits (~35s, rc=0)"(~36s)

**处置:保留,不动。** idle-gate 的等待时长就是被测契约(restart 必须等 fleet idle ~35s);缩短 = 改契约参数或打桩绕过真实等待,两者都削弱这条 ship-critical 路径的证明力。

### 3.3 FLY-1501 restart brake + heartbeat guard — 104s

三个 suite;大头是 `qa-fly1501-bounded-run.test.sh` 的 malformed-bound 矩阵:`''`/`'abc'`/`'0'`/`'-5'`/`'2.5'` 五种畸形输入,各等 **15s** 证明"回落到生产默认 bound 并真实终止" = 75s。

**处置:保留,不动。** 15s 是生产默认值本身;注入更短的测试 bound 后,被测对象就不再是"畸形输入回落到生产默认"这条路径(memory:隔离会悄悄改掉被测语义)。若未来必须提速,唯一诚实做法是给生产代码加带独立守卫的 bound 覆写口——那是行为变更,超出本单"防雷"scope,且 75s 换不来。

### 3.4 FLY-1663 launchd-native Lead lifecycle — 97s

9 个 suite;时间集中在 `fly1679-dev-channels-v2.test.sh` 的 E/H 族:E1/E2/E3("恰好一个 '1' 到达真 pane",8s+)、E6→H1 13s、H1/H2 各 17s(证明"tmux 起不来/stty 失败时套件**变红而不是挂死**"——只能真等超时)。

**处置:保留,不动。** 挂起证明(hang-proof)天然要消耗等待上限;这些上限(13–17s)已是紧的。

### 3.5 大头之外的诚实说明

第 5 名 `fly1678-statusline`(78s)与第 6 名 `package-onboard-smoke`(65s,含 ~40s 真 npm registry install,网络界)同理:结构性成本,分片时按秒数参与平衡,不做内部改动。

## 4. 结论:治大头没有 5 分钟级的空间

四大头 647s 里,可辨认的"纯等待"(15s×5 + 36s×2 + 13/17/17s + 16s ≈ 210s)全部是**契约本身**;剩余 ~437s 是 537+ 个真机测试的执行体。零风险可挤水分 <2min,而防雷需要的缓冲是 5min 级 ⇒ 主修法必须是结构(拆分),与 memory「修结构别加报警器·删的比加的多」一致——tripwire 是 issue 验收显式要求的第二道,不是替代结构修的报警器。

## 5. 改 ci.yml 结构会触碰的守卫/依赖(逐文件审计)

### 5.1 `scripts/__tests__/ci-structure.test.sh`(444 行,FLY-1338)— 需更新

拆分会撞上的断言(逐条):

| 行为 | 现断言 | 拆分后需要 |
|---|---|---|
| job id 集合 | `== {quick-gate, unit-tests, script-tests, payload-distribution, ci-ok}` | + `script-tests-2` |
| `ci-ok.needs` | `== {quick-gate, unit-tests, script-tests, payload-distribution}` | + `script-tests-2` |
| timeout floor | `script-tests ≥ 20` | 两片均 ≥ 20 |
| FLY-1364 step | 在 `script-tests` 内,命令列表逐字、禁 `if`/`continue-on-error`、env 必须带 `FLYWHEEL_CMUX_TEST_ALLOW_MODERN_BASH=1` | 断言移到拥有它的分片,内容不变 |
| FLY-1715 step | 同上形态,在 `script-tests` 内 | 移到拥有它的分片 |
| apt step | `script-tests` 内 exactly-one,须含 tmux/lsof/sqlite3 | 每片 exactly-one |
| 20 条 required_command | 在 `script-tests` 的 runs 里 exactly-once | 改为**跨两片 union** exactly-once(防 strand + 防重复跑) |
| bash 路径存在性 | 全 job 扫描 | 不变(自动覆盖新 job) |

另需**新增**断言(见 plan):job 顺序钉死(保护 5.3 的 sed 暗依赖)、每片 record-start + tripwire step 形态与阈值一致性。

### 5.2 `scripts/__tests__/ci-shell-suite-enumeration.test.sh`(FLY-1764)— 零改动

机制 = 对**整个 ci.yml 文件** `grep -Eo 'bash scripts/__tests__/....test.sh'`,与 job 归属无关。suite 在 job 间搬家不可见;新增 tripwire 契约测试文件(`*.test.sh`)会被它强制要求注册进 ci.yml —— 这是我们要的。

### 5.3 `scripts/__tests__/test-worktree-removal-contract.test.sh:64` — 暗依赖,需保护

`sed -n '/^  unit-tests:/,/^  script-tests:/p'` 靠 job **顺序**切出 unit-tests 段。若新 job 插到 unit-tests 与 script-tests 之间、或 `script-tests` 改名,切片范围**静默变化**(近似检查≠那个属性)。约束:保持顺序 `quick-gate → unit-tests → script-tests → script-tests-2 → payload-distribution → ci-ok`,且在 ci-structure 里把顺序变成显式断言(python 3.7+ `yaml.safe_load` 的 dict 保插入序,`list(jobs)` 可断言)。

### 5.4 Merge gate / 外部引用 — 零改动

- branch protection required check 实测仅 `["CI OK"]`(strict=false)→ 分片对 `:cool:` ship gate 不可见,只要 ci-ok 聚合;
- `grep` 全仓(workflows/scripts):ci.yml 之外零处引用 "Script Tests"/"script-tests" 名字;
- `ci-matrix-coverage.test.sh` 只管 unit-tests 的 package filter,零改动。

### 5.5 suite 间顺序依赖 — 无跨 step 依赖

逐 step 注释审计:所有 suite 自述 hermetic(隔离 HOME/私有 tmux socket/临时目录);唯一顺序约束是工具链(apt 的 tmux/lsof/sqlite3/ripgrep 须在依赖它们的 suite 之前、`pnpm build` 的 dist 须在需要 built teamlead dist 的 suite 之前)——分片后每片自带完整 setup 前奏即满足。payload-distribution job 里的 "keep SEQUENTIAL" 警告属于另一个 job,不受影响。

## 6. 分片平衡计算(按实测秒数)

原则:大头 2+2 拆开、族群尽量同片(cmux/tmux/session 一片,fleet/restart/packaging/onboarding 一片)、余量给平衡让路。

| | 片 1 `script-tests`(cmux/session 族) | 片 2 `script-tests-2`(fleet/setup/packaging 族) |
|---|---|---|
| 大头 | FLY-1364 (312) + FLY-1663 (97) | FLY-1434 (134) + FLY-1501 (104) |
| 中头 | FLY-1678 (78) | payload smoke (65) + FLY-1389 (48) |
| 其余 | 1707/1393/1436/1759/1572/1764/1327/hooks/183/1402/1496 (~55) | 其余全部 (~161) |
| 测试合计 | ~542s | ~512s |
| + setup(~110s) | **~652s ≈ 10.9min** | **~622s ≈ 10.4min** |
| 占 20min cap | **54%** | **52%** |
| 距 85% tripwire | ~6.1min 增长空间 | ~6.6min 增长空间 |

验收 #1(每片 ≤70% = ≤14min)双片达标,余量 ~3min/片。

## 7. 成本账(FLY-1866 语境)

| 项 | 变化 |
|---|---|
| billable runner 分钟 | +~110s/轮(第二片重复 setup+build)≈ +9% job 成本 |
| CI 关键路径墙钟 | script-tests 19.3min → ~11min;ship gate(`:cool:` 等 CI green)每次 merge 提前 ~8min |
| 翻崖事故成本(避免项) | 一次误诊按 FLY-1863 口径 = 全员数小时;翻崖后每轮超时浪费整个 20min job |

不选 build-artifact 共享方案(一个 build job 产 dist 供两片下载):upload/download 本身 ~1min 级、两片要 `needs:` build job = 串行化反而拉长墙钟、新增一处缓存失效面。重复 build 73s 是更便宜的那个代价。

## 8. Tripwire 机制调研

- GitHub Actions **没有** job 内可读的"本 job 已用时长"原语;`${{ }}` 上下文无 job start time。可靠做法:job 第一个 step 内联 `date +%s > "$RUNNER_TEMP/flywheel-job-start-epoch"`(在 checkout 之前,量到完整 setup),末尾 step 调用 repo 内脚本计算 elapsed(此时 checkout 早已完成)。
- 末尾 step 用 `if: always()`:suite 失败的轮次也输出 elapsed 观测行;正常轮 elapsed < 阈值时打印一行 `elapsed Xs / budget Ys (Z% of cap)` 作观测。
- 触发即 `exit 1`:红的是 required 聚合 `CI OK` 依赖的 job,挡 merge —— 这是 repo 里唯一保证有人看的通道(issue 判据:#flywheel-alerts 没人看)。
- 阈值 85%(issue 建议值):分片后 ~53% 起步,触发需 +6min 真实增长(≈再挂 3 个 FLY-1364 级 step),不会被 ±1% 的轮间抖动误触;触发点距真悬崖还有 3min 缓冲带,红了之后老 PR 重跑仍能过(85–100% 区间是预警不是死区)。
- 诚实边界:真正 20:00 超时的那一轮,tripwire step 连同 job 一起被 kill,不会执行 —— 它的价值在之前的轮次把 85%+ 显性化。它**不能**替代分片,只能守住分片后的缓冲。

## 9. 会过期的结论表

| 结论 | as-of | 重核命令 |
|---|---|---|
| job 19.3min / 大头 4 步 55.9% | 2026-08-17 main 三轮 | §0 的 gh api 命令 |
| branch protection = ["CI OK"] | 2026-08-18 | `gh api repos/{owner}/{repo}/branches/main/protection --jq .required_status_checks.contexts` |
| ci-structure 断言清单 | 2026-08-18 @ `ca2eb8546` | 重读 `scripts/__tests__/ci-structure.test.sh`(行号会漂,按断言文本 `git log -S` 定位) |
| worktree-removal sed 范围在 :64 | 同上 | `grep -n "unit-tests:/,/" scripts/__tests__/test-worktree-removal-contract.test.sh` |
| setup ≈ 110s(pnpm cache 命中前提) | 2026-08-17 | 任一 green run 的 setup steps 加和 |
