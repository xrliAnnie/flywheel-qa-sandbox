# FLY-1870 Script Tests 超时悬崖防雷 — 探索

Issue: FLY-1870 (https://linear.app/geoforge3d/issue/FLY-1870/ci防雷-script-tests-已跑到-187-分钟-上限-20-距超时悬崖-13-分钟翻崖后症状会伪装成-flaky)
日期: 2026-08-18
基于: 无

## 1. 问题一句话

CI 的 `script-tests` job(Script Tests, shell suites)实测已跑到 **19m21s**,而 `timeout-minutes: 20` —— 最近一轮 green main 距超时悬崖只剩 **39 秒**;翻崖后的症状(时好时坏、重跑有时过)会伪装成 flaky,让下一轮排查从零重走 FLY-1863 那条路。

## 2. 独立复测:比 issue 报的还糟

issue 引 FLY-1866 的 32 天均值 ~18.7 分钟。本单开工先做独立复测(不信标签,拿 `gh api` 直接量最近三轮 green main 的 job 起止):

| run(main, success) | Script Tests 时长 | 距 20min 悬崖 |
|---|---|---|
| 32080816590 (2026-08-17 23:32) | **19m21s** | **39s** |
| 32005399130 (2026-08-17 07:20) | 19m06s | 54s |
| 32003288115 (2026-08-17 06:50) | 18m48s | 72s |

两轮 per-step 对照(312s/297s、134s/132s、104s/103s、97s/97s)证明这是**确定性慢**(测试里刻意的真实等待),不是 runner 负载抖动 —— 意味着:不会靠"哪天负载好"自愈,且套件每加一条自然增长都在直线逼近悬崖。

## 3. 四个大头(实测,与 issue 的"4 个吃 55%"精确吻合)

| ci.yml step | 实测 | 占比 | 内部大头 |
|---|---|---|---|
| Test — FLY-1364 cmux sync repair(12 个 suite 捆绑) | 312s | 27.0% | `test-cmux-sync.sh` 独占 ~226s(537 tests,FLY-1482 真机 lease/watcher harness) |
| Test — FLY-1434 unified restart + quota caller | 134s | 11.6% | `test-restart-services.sh` 内 2×~35s idle-gate 真实等待(FLY-1224 契约) |
| Test — FLY-1501 restart brake + heartbeat guard | 104s | 9.0% | `qa-fly1501-bounded-run` 内 5×15s malformed-bound 终止证明(15s = 生产默认 bound) |
| Test — FLY-1663 launchd-native Lead lifecycle(9 个 suite) | 97s | 8.4% | dev-channels 自动确认 E/H 用例的挂起证明等待(13s+17s+17s+8s ≈ 55s) |

合计 647s / 1157s = **55.9%**。✓ 与 FLY-1866 的结论互相印证。

## 4. 三个修法方向的探索

### 方向 1:治大头(白盒提速)—— 结论:有硬地板,不作主修

白盒(CI job log 逐行时间戳 gap 分析)显示,四个大头的时间不是浪费,而是**「用真实墙钟证明终止/等待契约」的结构性成本**:

- `qa-fly1501-bounded-run` 的 5×15s:每个用例证明一种 malformed bound 输入会回落到**生产默认 15s** 并真实终止 —— 缩短 = 注入测试专用 bound = 被测对象不再是生产默认路径(正是 memory 里「隔离会悄悄改掉被测语义」的教训);
- `test-restart-services.sh` 的 2×~35s:idle-gate 的等待时长**就是契约本身**;
- `test-cmux-sync.sh` 226s:FLY-1482/1596 反复用真 watcher、真 kernel lock、真 tmux server 换来的覆盖,FLY-1853 刚修过它的 probe-budget 与墙钟赛跑 —— 在这里抠秒 = 亲手制造下一轮 flaky;
- `package-onboard-smoke` 的 40s 是真 npm registry install(网络),本来就是该 suite 的验收口径("installs ≠ boots")。

判断:**保留全部四个大头,逐个记录处置理由**(即验收 #3),不做任何 suite 内部改动。可挤的水分估计 <2 分钟且每一分钟都要为"改被测语义吗"付一轮 review + QA 成本,而悬崖缓冲需要的是 5 分钟级的空间。

### 方向 2:拆分(分片)—— 结论:主修法

像 teamlead 三分片一样把 script-tests 拆开,但机制不同:teamlead 分片是 vitest `--shard`(测试运行器切),script-tests 的天然分片单位是 **ci.yml 里的 step**(每个 step 是一族 shell suite,自带注释、env、顺序约束)。两种落法:

- **A. 同一 job id + matrix + per-step `if:`** —— 被否。ci-structure guard 明确要求 FLY-1364/FLY-1715 step "must not be conditional"(防静默 strand,FLY-1501 那次"shipped unregistered, green CI proved nothing"的教训);几十个 step 各带条件也是 typo-strand 的温床。
- **B. 拆成两个平级 job id(`script-tests` + `script-tests-2`),step 整体搬家** —— 采纳。每个 step 连注释、env 原样搬,守卫围绕"具名 job + 无条件 step"推理的形状不变,防 strand 靠(a)enumeration guard 对整个 ci.yml 文件 grep(搬家不可见)+(b)ci-structure 的 exactly-once 断言改为跨两片 union。

按实测秒数平衡分配后,每片 ≈ 10.5 分钟 ≈ **上限的 53%**(验收 #1 要求 ≤70%),各留 ~6 分钟增长空间。代价:setup(checkout+install+build+apt ≈ 110s)每片重复一份,+~2 分钟 billable;换来 CI 关键路径 19.3 → ~11 分钟(ship gate 等 CI 的墙钟直接减半)——在 FLY-1866 的成本语境里净收益为正。

### 方向 3:提上限 —— 结论:拒绝作主修;但"逼近上限告警"必做(验收 #2)

提上限只买时间且抬高翻崖后的浪费(超时前烧的 runner 分钟更多)。**不提。** 20 分钟 cap 原样保留在两片上(它同时是 FLY-1482 定下的 capacity floor,守卫断言 ≥20,不降——降 cap = 亲手重新造一座悬崖)。

告警(tripwire)设计要点:
- **落点 = CI 自己的红检查**,不是 #flywheel-alerts(issue 明说该频道被裁定没人看)。一条 required check 变红会挡 merge、进 ship 流程、Lead 和 founder 必然看见 —— 这就是"founder 真会看的通道"。
- 每片末尾一个 `if: always()` 的 tripwire step:job 开始时(第一 step)记 epoch,末尾算 elapsed,≥ **85% × cap** 就 exit 1,错误消息显式写明「这是 CAPACITY 不是 flaky,见 FLY-1870,先重平衡分片再考虑提 cap」。
- 与 issue 草案的差异:issue 设想用 FLY-1866 的逐轮时长数据做外部监控;但那份数据是 runner 一次性拉的,不是常设管线 —— 外部监控 = 新增一套机制 + 落到没人看的频道。in-job tripwire 零新基建、每轮自检、在人人都看的位置爆红。同时每轮 green run 也打印一行 elapsed 观测值,保留时长可见性。
- 诚实边界:真正翻崖那一轮(20:00 被 kill)tripwire 自己也被 kill,发不出声 —— 它的价值在 85%~100% 区间的**之前那些轮**就把人叫来。85% 阈值给悬崖前 3 分钟的预警带。

## 5. 关键约束发现(改 ci.yml 结构前必须知道的暗依赖)

审计出 4 处会被拆分触碰的守卫/依赖(细节见 research.md §5):

1. `scripts/__tests__/ci-structure.test.sh` — job id 集合精确断言、FLY-1364/1715 step 命令逐字断言、apt exactly-one、20 条命令 exactly-once、timeout floor ≥20 → 需按分片形态更新;
2. `scripts/__tests__/ci-shell-suite-enumeration.test.sh` — 对整个 ci.yml 文件 grep,分片不可见,自动保持绿;
3. `scripts/__tests__/test-worktree-removal-contract.test.sh:64` — 用 `sed -n '/^  unit-tests:/,/^  script-tests:/p'` 切片 ci.yml 检查 unit 段:**job 顺序是它的隐式前提**。新 job 必须插在 `script-tests` 之后(顺序 quick-gate → unit-tests → script-tests → script-tests-2 → …),并在 ci-structure 里把 job 顺序钉成显式断言;
4. branch protection required check = 仅 `"CI OK"`(实测 `gh api`)→ 分片对 merge gate 不可见,只要 `ci-ok.needs` 加上新 job。ci.yml 之外 grep 零处引用 "Script Tests" 名字。

## 6. 方向决定

**拆 2 片(按实测秒数平衡,step 整体搬家)+ 每片 85% tripwire 红检查 + 四大头逐个保留并记录处置。** 不动任何 suite 内部(零新 flaky 风险),不提 cap,不建外部监控管线。

未解决而留给 plan 的点:精确分配表、tripwire 脚本契约与 TDD 场景、ci-structure 逐断言改法、增长后的 runbook(挪 suite / 加第三片)。
