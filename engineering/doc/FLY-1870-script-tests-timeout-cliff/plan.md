# FLY-1870 Script Tests 超时悬崖防雷 — 实施计划

Issue: FLY-1870 (https://linear.app/geoforge3d/issue/FLY-1870/ci防雷-script-tests-已跑到-187-分钟-上限-20-距超时悬崖-13-分钟翻崖后症状会伪装成-flaky)
日期: 2026-08-18
基于: research.md

## 0. 方案一句话

把 `script-tests` job 按实测秒数拆成两个平级 job(`script-tests` + `script-tests-2`,step 连注释/env 整体搬家,每片 ~10.5min ≈ cap 的 53%),每片加一条 **85% 容量 tripwire**(job 自测 elapsed,越线即红,错误消息显式区分 CAPACITY vs flaky);四大头 suite 全部保留不动(处置记录见附录 A);同步更新 `ci-structure.test.sh` 守卫。纯 CI 变更,无生产部署面。

## 1. 变更清单

### 1.1 `.github/workflows/ci.yml` — 拆分 script-tests

**Job 顺序(硬约束,保护 `test-worktree-removal-contract.test.sh:64` 的 sed 范围)**:
`quick-gate → unit-tests → script-tests → script-tests-2 → payload-distribution → ci-ok`

两片共同骨架(每片各一份):

```yaml
  script-tests:            # 片 2 同构,id: script-tests-2
    name: Script Tests 1/2 — cmux/session (shell suites)   # 片 2: "Script Tests 2/2 — fleet/setup/packaging (shell suites)"
    runs-on: ubuntu-latest
    timeout-minutes: 20    # FLY-1482 capacity floor,两片都保持 20,不降(降 cap = 重造悬崖)
    steps:
      - name: Record job start (FLY-1870 tripwire)
        run: date +%s > "$RUNNER_TEMP/flywheel-job-start-epoch"
      - uses: actions/checkout@v4
      # …pnpm/node setup、git config、install、better-sqlite3、Build —— 与现状逐字一致
      - name: Install tmux/lsof/sqlite3/ripgrep for hermetic test scripts
        run: sudo apt-get update && sudo apt-get install -y tmux lsof sqlite3 ripgrep
      # …本片的测试 step(原样搬家,见 1.2 分配表)
      - name: Enforce FLY-1870 capacity tripwire
        if: always()
        run: bash scripts/ci-job-elapsed-tripwire.sh --cap-minutes 20 --threshold-pct 85 --start-file "$RUNNER_TEMP/flywheel-job-start-epoch"
```

要点:
- `Record job start` 是**第一个 step**(在 checkout 之前),elapsed 量到完整 setup;
- apt step 统一挪到 Build 之后、所有测试 step 之前(现状里 FLY-1707/1393/1436 三个 step 在 apt 前,搬到 apt 后无依赖问题——它们不用 apt 工具,顺序简化让两片结构同构);
- 每片 job 头部加分配注释:本片各 step 实测秒数表(as-of 2026-08-17)+ "rebalance 时挪整 step、同步 ci-structure、参见 engineering/doc/FLY-1870-script-tests-timeout-cliff/plan.md §5";
- `ci-ok.needs` 加 `script-tests-2`;
- 现有 FLY-889/1482 timeout 注释保留并追加 FLY-1870 拆分说明。

### 1.2 分配表(step 整体搬家,不改任何 step 的 run 内容/env/注释)

**片 1 `script-tests`(cmux/session 族,测试 ~542s,全片预计 ~10.9min = 54%)**,按原相对顺序:
FLY-1707 (1s) · FLY-1393 (2s) · FLY-1436 (0s) · FLY-1759 (2s) · FLY-1572 (12s) · FLY-1764 (2s) · FLY-1327 (1s) · cmux-sync hooks integration (10s) · **FLY-1364 (312s)** · FLY-183 (11s) · FLY-1402 (4s) · FLY-1496 (10s) · **FLY-1663 (97s)** · FLY-1678 (78s)

**片 2 `script-tests-2`(fleet/setup/packaging 族,测试 ~512s,全片预计 ~10.4min = 52%)**,按原相对顺序:
FLY-519 (2s) · FLY-1356 (0s) · FLY-1609 (1s) · FLY-648 (12s) · FLY-1023 (19s) · FLY-1189 multi-Lead (2s) · FLY-1775 (9s) · FLY-1189 fault-inject (2s) · FLY-1189 assert+driver (21s) · FLY-1389 (48s) · NPM packaging seams (13s) · **FLY-1501 (104s)** · FLY-1634 (10s) · FLY-1671 (2s) · payload real-install smoke (65s) · onboard-shell (13s) · FLY-882 (1s) · FLY-513 (1s) · FLY-697 (0s) · FLY-1018 (0s) · FLY-880 (1s) · FLY-1787 (0s) · FLY-1461 (0s) · FLY-1463 (0s) · FLY-913 (8s) · **FLY-1434 (134s)** · FLY-1715 (1s) · FLY-1726 (17s) · mailbox adoption (5s) · FLY-1649 (12s) · FLY-927 (1s) · FLY-957 (1s) · FLY-1729/1743 (3s) · FLY-1081 (2s) · FLY-1338 structure guard (0s) · FLY-1674 residue (0s) · FLY-1338 matrix parity (2s) · **FLY-1870 tripwire contract(新,~1s)**

### 1.3 新脚本 `scripts/ci-job-elapsed-tripwire.sh`

契约:
```
用法: ci-job-elapsed-tripwire.sh --cap-minutes N --threshold-pct P --start-file PATH [--now-epoch N]
```
- **fail-closed 参数校验**:cap-minutes 正整数、threshold-pct ∈ [1,100]、start-file 存在且内容为正整数 epoch 且不在未来 —— 任一违反打印 `TRIPWIRE MISCONFIGURED (FLY-1870): <原因>` 并 exit 1(缺 start 文件 = record step 没跑 = 守卫失效,必须红,绝不静默绿);
- `elapsed = now − start`,`budget = cap×60×pct/100`(整数运算);
- **每次都**打印观测行:`[tripwire] elapsed=<X>s budget=<Y>s cap=<C>s usage=<Z>%`(绿轮也打,保留逐轮时长可见性);
- `elapsed ≥ budget` 时打印容量告警块并 exit 1,消息必须含(英文,CI 语境):
  - 标记词 `CAPACITY TRIPWIRE (FLY-1870)`;
  - "This is NOT flakiness — this shard is approaching its timeout cliff"(直接拆掉"是不是 flaky"的下一轮误诊);
  - 行动指引:rebalance suites between script-tests shards / add a shard(指向 ci.yml 分配注释与本 plan §5),raise the cap 只作最后手段;
- `--now-epoch` 为 hermetic 测试注入 seam;**ci.yml 的真实调用禁止携带**(由 ci-structure 断言,防止有人用它把 tripwire 打成空转)。

### 1.4 新测试 `scripts/__tests__/ci-job-elapsed-tripwire.test.sh`(TDD 先行)

hermetic(临时目录 + `--now-epoch` seam,零外部依赖),场景:
1. elapsed < budget → exit 0,观测行存在;
2. elapsed == budget(边界,`≥` 触发)→ exit 1,消息含 `CAPACITY TRIPWIRE (FLY-1870)` 与 `NOT flakiness`(阳性对照);
3. elapsed > budget → exit 1;
4. start-file 缺失 → exit 1,`MISCONFIGURED`;
5. start-file 内容为垃圾 → exit 1;
6. start epoch 在未来 → exit 1;
7. 参数缺失/非法(cap=0、pct=0、pct=101)→ exit 1;
8. exit 0 的绿路径不含告警标记词(反空过绿:grep 断言输出**没有** `CAPACITY TRIPWIRE`);
9. **真实取时路径(不传 `--now-epoch`)**:用 PATH 上的 fake `date` shim 固定当前 epoch,绿/红两个变体各一 —— 防止"只在注入 seam 下才工作"的实现通过全部测试后在 CI 每轮失败(Codex R1 #4);
10. `--now-epoch` 值非法(非整数/负数)→ exit 1;
11. 未知 flag → exit 1(fail-closed 参数解析);
12. flag 重复出现 / flag 缺 value → exit 1。

注册进 ci.yml 片 2(enumeration guard 会强制要求注册,这是设计内行为)。

### 1.5 `scripts/__tests__/ci-structure.test.sh` 更新(守卫与新形态对齐,TDD 先行)

| 断言 | 改法 |
|---|---|
| `expected_job_ids` | + `script-tests-2` |
| **新增** job 顺序 | `list(jobs) == [quick-gate, unit-tests, script-tests, script-tests-2, payload-distribution, ci-ok]`(python3.7+ `yaml.safe_load` 保插入序;保护 worktree-removal 的 sed 范围) |
| no-`needs` 循环(现 :71-76) | **两片都**加入 "must start independently (no needs)" 循环 —— 否则未来误加 `needs: script-tests` 会静默串行化、关键路径重新越线(Codex R1 #3) |
| `ci-ok.needs` | + `script-tests-2` |
| timeout floors | `script-tests ≥ 20` 且 `script-tests-2 ≥ 20` |
| **新增** step inventory 机器合同 | §1.2 分配表落成代码:在守卫中声明**两片各自的有序测试 step name 列表**(片 1 = 14 个、片 2 = 37 个现有 + tripwire contract = 38 个),断言每片实际测试 step 列表与声明**逐项相等**;两片 union 恰好 = 现 51 个测试 step + 1 个新 step,**无缺失、无重复**;全部测试 step 禁 `if` / `continue-on-error`。这是防 strand 的主承重(弱"至多一次"断言在整步删除时 vacuous green,且 enumeration guard 因 `sort -u` 看不见重复、只 census 根目录 shell suite,覆盖不了 Node/python3/pnpm step —— Codex R1 #2) |
| **新增** setup 前奏合同 | 每片 setup 前缀恰为:record-start → checkout → pnpm-setup → node-setup → git config → install → better-sqlite3 → Build → apt,顺序一致、各 exactly-once("平级 job + 完整前奏"不再靠人工 diff,Codex R1 #3) |
| FLY-1364 step 逐字断言 | 检索目标改为片 1 steps,内容(命令表/禁 if/禁 continue-on-error/modern-Bash env)不变 |
| FLY-1715 step 逐字断言 | 检索目标改为片 2 steps,内容不变 |
| apt step | **每片** exactly-one,tmux/lsof/sqlite3 包名断言不变 |
| required_command exactly-once | 现有 **19 条** tuple(:386-406)+ 新增 tripwire contract test 命令 = 20 条;扫描范围改为**两片 runs 的 union**(作为 step inventory 之外的内容级冗余保留,不承担 inventory 职责) |
| **新增** tripwire 形态 | 每片:第一个 step 的 run 匹配 `date +%s > "$RUNNER_TEMP/flywheel-job-start-epoch"`;最后一个 step `if: always()`、run 调 `bash scripts/ci-job-elapsed-tripwire.sh`、`--cap-minutes` == 该片 `timeout-minutes`、`--threshold-pct 85`、`--start-file` 指向同一路径、**不含** `--now-epoch`、无 `continue-on-error` |
| bash 路径存在性 | 机制不变(全 job 扫描,自动覆盖新 job 与新脚本) |

### 1.6 `packages/teamlead/src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts` 更新(FLY-1482 "双守卫"的第二处;漏改会直接打红 required unit shard —— Codex R1 BLOCKER)

该 Vitest 文件跑在 required 的 unit-tests teamlead shard 里,解析真实 ci.yml。三个既有合同 + 一个新增:

| 合同 | 改法 |
|---|---|
| timeout floors(`timeoutFloors` map) | + `["script-tests-2", 20]` |
| apt exactly-one + tmux/lsof/sqlite3 | 从只查 `script-tests` 改为**遍历两片**,每片 exactly-one |
| ci-structure guard 挂载 | 从只查 `script-tests` 改为:**两片 union 中恰好一次**、位于片 2(与 §1.2 分配一致)、无 `if` / `continue-on-error`(保留其"shell 守卫不能自指失效"的职责——ci-structure 自己被 strand 时由这个 unit 测试兜底) |
| **新增** ci-ok.needs 钉从 unit 侧 | 断言 `ci-ok.needs` 包含 `script-tests` 与 `script-tests-2`(与 shell 守卫互为冗余,防止 shell 守卫和 ci.yml 一起被改) |

### 1.7 零改动但必须回归验证的文件

- `scripts/__tests__/ci-shell-suite-enumeration.test.sh` — 全文件 grep,搬家不可见;新 tripwire 测试文件会被它要求注册(1.4 已做);
- `scripts/__tests__/test-worktree-removal-contract.test.sh` — sed 范围因 job 顺序保持而不变,改完 ci.yml 后必须实跑确认(近似检查≠那个属性,不许只目测);
- `scripts/__tests__/ci-matrix-coverage.test.sh` — 只涉 unit-tests,实跑确认。

## 2. 实施顺序(TDD:RED → GREEN)

1. **RED**:写 `ci-job-elapsed-tripwire.test.sh` → 跑,失败(脚本不存在);
2. **GREEN**:写 `scripts/ci-job-elapsed-tripwire.sh` → 全场景绿;
3. **RED**:按 §1.5 更新 `ci-structure.test.sh` + 按 §1.6 更新 `fly-889-ci-workflow-timeout-guard.test.ts` → 对现 ci.yml 跑,双双失败(还没拆);
4. **GREEN**:改 ci.yml(拆两片 + tripwire steps + 注册 1.4 测试)→ 两个守卫绿;
5. 本机只跑**安全**回归(全部 hermetic 纯解析/grep,不 spawn 服务):`ci-structure` / `ci-shell-suite-enumeration` / `ci-matrix-coverage` / `test-worktree-removal-contract` / `ci-job-elapsed-tripwire` 五个 shell 套件 + **单文件定向 Vitest** `pnpm --filter flywheel-teamlead exec vitest run src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts`;**不得**在本机跑其余 shell suite(memory 红线:restart 族沙箱杀生产 Bridge;重型套件压死 host)——它们的回归由 PR CI 两片真实执行;
6. 全仓 gate:`pnpm lint` + `pnpm -r build`(执行者契约要求,虽本单不动 packages);
7. PR → PR 的 CI run 即是分片首轮实测:记录两片实际时长进 PR 描述,若任一片 >70%(预期 54%/52%,余量 3min,不太可能)按附录 A 秒数表挪 step 重跑。

## 3. 验收映射(对 issue 三条)

| issue 验收 | 落点 |
|---|---|
| 1. 单轮 ≤70% cap(分片后每片) | PR CI run + merge 后首轮 main:`gh api …/jobs` 实测两片时长,预期 ~54% / ~52%;QA 节点复测并留 run id 证据 |
| 2. 一条会失败的检查,逼近上限显式告警,落 founder 真会看的通道 | tripwire step:阈值 85%、exit 1 → 红的是 required 聚合 `CI OK` 依赖链 = 挡 merge 的通道(#flywheel-alerts 已弃用判据遵守);阳性对照 = 1.4 场景 2/3(hermetic 注入越线 elapsed,真实跑红);每轮绿 run 另有 elapsed 观测行 |
| 3. 四大头逐个列名 + 处置记录 | 附录 A(定稿),research.md §3(白盒依据) |

## 4. 风险与边界

- **tripwire 在真超时轮发不出声**(job 连 step 一起被 kill):设计内边界,价值在 85–100% 区间的之前轮次;分片后距 85% 有 ~6min 真实增长空间,不会毫无预警直接翻崖;
- **误触面**:轮间抖动实测 ±1%,阈值余量 30+ 个百分点 → 触发即真容量信号,按 §5 runbook 处置;
- **分配表过期**:数字 as-of 2026-08-17(research §9 保质期表);实施时以 PR 首轮实测为准微调;
- **不做**:不动任何 suite 内部(零新 flaky 风险);不提 cap;不建外部时长监控管线;不动 unit-tests/payload-distribution(tripwire 可复制过去,留后续单);不碰 FLY-1233(ship-on-comment 超时,别归并——issue 判据继承);
- **回滚**:5 个文件(ci.yml + 2 个新文件 + 2 个守卫更新:`ci-structure.test.sh` 与 `fly-889-ci-workflow-timeout-guard.test.ts`),revert 单 commit 即回到现状(现状 = 39s 缓冲,回滚只在拆分本身出问题时用)。

## 5. Runbook:tripwire 变红之后(写进 ci.yml 分配注释的指针目标)

1. 读红 step 的 `[tripwire]` 行确认 usage%(以及最近 main 轮两片的观测行,判断是单片失衡还是双片齐涨);
2. **首选 rebalance**:从红片挑整 step 挪到另一片(参考 ci.yml 分配注释的秒数表 + 最近 run 实测),同步 `ci-structure.test.sh` 的 step 归属断言;
3. 双片都逼近 → **加第三片**:复制 job 骨架为 `script-tests-3`(插在 `script-tests-2` 之后、`payload-distribution` 之前),更新 ci-structure 的 job set/顺序/needs/timeout/tripwire/inventory 断言 + `ci-ok.needs`,**并同步扩展 §1.6 的 `fly-889-ci-workflow-timeout-guard.test.ts`**(timeout/apt/needs 合同以片清单为准,别让第三片只受自指的 shell 守卫保护);
4. **最后手段才提 cap**,且必须同步 ci-structure floor 与 tripwire `--cap-minutes`(守卫强制一致,想只提 cap 不动 tripwire 会先红在守卫上);
5. 任何时候不许:给 suite 加 `if:`/`continue-on-error`、把 suite 移出 ci.yml(enumeration guard 会红)、缩短大头 suite 的真实等待(附录 A 的处置理由)。

## 附录 A:四大头处置记录(验收 #3 定稿)

| # | step(实测) | 内部大头 | 处置 | 理由 |
|---|---|---|---|---|
| 1 | FLY-1364 cmux sync repair(312s / 27.0%) | `test-cmux-sync.sh` ~226s(537 tests,FLY-1482 真机 lease/watcher harness,含 16s live-watcher 让位 E2E);`tmux-server-rescue*` ~66s | **保留不动,置片 1** | 真 kernel lock / 真 tmux server 的覆盖是 FLY-1482/1596 多轮 review+QA 换来的;FLY-1853 刚修过其中墙钟赛跑 flake——在此抠秒 = 制造下一轮 flaky |
| 2 | FLY-1434 unified restart + quota caller(134s / 11.6%) | `test-restart-services.sh` 内 2×~36s idle-gate 真实等待(FLY-1224) | **保留不动,置片 2** | 等待时长就是被测契约;缩短 = 改契约或打桩绕过 ship-critical 路径 |
| 3 | FLY-1501 restart brake + heartbeat(104s / 9.0%) | `qa-fly1501-bounded-run` 5×15s malformed-bound 终止证明 | **保留不动,置片 2** | 15s = 生产默认 bound 本身;注入测试 bound 后被测对象不再是生产默认回落路径(隔离改语义教训)。若未来要提速须给生产代码加带守卫的覆写口 = 行为变更,另立单 |
| 4 | FLY-1663 launchd-native Lead lifecycle(97s / 8.4%) | `fly1679-dev-channels-v2` E/H 族挂起证明(13–17s×3)+ '1' 键真 pane 投递 | **保留不动,置片 1** | hang-proof 天然消耗等待上限;上限已紧 |
