# FLY-1870 Script Tests 超时悬崖 — QA 验证报告

Issue: FLY-1870 (https://linear.app/geoforge3d/issue/FLY-1870/ci防雷-script-tests-已跑到-187-分钟-上限-20-距超时悬崖-13-分钟翻崖后症状会伪装成-flaky)
日期: 2026-08-18
基于: plan.md

**判定:PASS**

PR #880 · 验证 head `92f31f49da1199b3f5e88d972d79dafef5f3b278`(local == origin == PR head,非 draft,mergeable)

---

## 1. 结论

工单三条验收全部达成,且证据取自**真实 GitHub Actions 跑批**(逐步骤时间戳),不是本地推算。

顺带纠正一个数字:工单写「已跑到 18.7 分钟 / 缓冲 1.3 分钟」。拆分前 main 上最近一次成功跑批实测是 **1161 秒 = 19 分 21 秒 = 上限的 97%,只剩 39 秒余量**。悬崖比工单描述的更近。

---

## 2. 验收逐条

| # | 工单验收 | 证据 | 判定 |
|---|---|---|---|
| 1 | 单轮时长 ≤ 上限 70%(或分片后每片) | run `32120143497`(head `92f31f49`):车道 1 = 639s = **53%**;车道 2 = 614s = **51%**。tripwire 自报 `usage=52%` / `usage=50%`。对照基线 run `32080816590`(拆分前 main)= 1161s = **97%** | PASS |
| 2 | 一条会失败的检查,逼近上限显式告警,落 founder 真会看的通道 | `scripts/ci-job-elapsed-tripwire.sh`,阈值 85% → budget 1020s。**真边界实测**:1019s → rc=0;1020s → rc=1 且首句为「This is NOT flakiness」。落点 = job 变红 → `CI OK` 变红;GitHub 分支保护接口确认 **`CI OK` 是 main 上唯一的 required status check**,判定式 `jq -e 'all(.[]; .result == "success")'`,`needs` 含两片 | PASS |
| 3 | 四大头逐个列名 + 处置记录 | plan.md 附录 A:FLY-1364(312s/27.0%)、FLY-1434(134s/11.6%)、FLY-1501(104s/9.0%)、FLY-1663(97s/8.4%),合计 647s = 拆分前 1161s 的 **55.7%**,与工单「4 个测试吃掉 55%」自洽。每项含内部大头、处置(全部保留不动)、理由 | PASS |

---

## 3. 覆盖完整性 — 最高风险项,用两条独立路径验

「拆分时静默丢掉一个测试」会让 CI 保持绿而覆盖消失(= 没看到坏消息 ≠ 好消息)。两条路径都做了:

**路径 A — 静态(YAML 解析,name+run 精确签名)**
- 旧 job 59 个 step,新两片 24 + 48 个 step
- 旧集合 → 新并集:**缺失 0**
- 新并集 → 旧集合:**新增 3 个**(`Record job start`、`Enforce ... tripwire`、`Test — FLY-1870 job elapsed tripwire contract`)
- 跨片重复 10 项,**全部是 setup/infra**(checkout / pnpm / setup-node / git config / install / better-sqlite3 / build / apt-get / 计时起点 / tripwire),无一个测试步骤被重复跑

**路径 B — 动态(真实跑批里实际执行过的步骤名,在终点取证)**
- 基线 run `32080816590`:50 个 `Test —` 步骤
- 拆分后 run `32120143497`:13 + 38 = **51** 个
- 集合比对:**少 0 个、重复 0 个、多 1 个**(= 新增的 tripwire 自测)

**测试墙钟守恒**:基线测试步骤合计 1044s;拆分后 508s + 504s = 1012s(−3%,轮间抖动)。两片负载均衡 50.2% / 49.8%。setup 重复开销 = 每片约 108–126s。车道墙钟 19.4min → 10.7min。

---

## 4. 守卫是不是真尺子 — 9 个破坏实验(阳性对照)

守卫在未改动状态下必须绿(否则是永远红的噪声),被破坏时必须红(否则是空过绿测)。用与真仓语义等价的 fakeroot 跑,**先复核 baseline 为 GREEN**(证明隔离没有悄悄改掉被测语义),再逐个注入:

| # | 注入的破坏 | 结果 |
|---|---|---|
| baseline | 未改动 | GREEN(非空壳) |
| M1 | 删掉片 2 的一个测试步骤(FLY-1434) | RED — inventory drifted |
| M2 | 删掉 tripwire 执行步骤 | RED — inventory drifted |
| M3 | 删掉计时起点步骤 | RED — setup prefix drifted |
| M4 | `ci-ok.needs` 里去掉 `script-tests-2` | RED — needs must be exactly [...] |
| M5 | 阈值 85% 偷偷调成 99% | RED — tripwire invocation drifted |
| M6 | 只改 `timeout-minutes` 不改 `--cap-minutes` | RED — tripwire invocation drifted(两者被强制同步) |
| M7 | 删掉另一个测试步骤(FLY-1389) | RED — inventory drifted |
| M8 | `timeout-minutes` 与 `--cap-minutes` **同步**提到 40 | GREEN — **设计如此**(见 §6 边界) |
| M9 | 两者同步降到 12 | RED — must be at least 20(FLY-889 floor 仍在) |

自动化契约:`ci-job-elapsed-tripwire.test.sh` **36/36**(含参数校验、时钟异常、真 `date` 路径、边界);`fly-889-ci-workflow-timeout-guard.test.ts` **4/4**;`ci-structure.test.sh` 通过。

---

## 5. Discord / N-to-N 面

**本单没有 N-to-N 面 —— 明确声明,不静默略过。**

PR 的生产文件只有 `.github/workflows/ci.yml` 与 `scripts/ci-job-elapsed-tripwire.sh`(其余为 `__tests__` 与文档)。零 Discord send / relay / render / founder 交互 / roundtable / 跨 Lead 协作代码。

改用的真实面 = **真实 GitHub Actions 跑批**(对 CI 改动而言这就是生产面)+ §4 的 9 个破坏实验 + §3 的终点取证。

---

## 6. 诚实边界

1. **真正翻崖的那一轮,tripwire 发不出声** —— job 连同它的步骤一起被系统杀掉,`if: always()` 也救不回来。它的价值区间是 85%–100%。残余风险 = 「一步跨过 85%」:现在离报警线约 6 分钟,需要一次性多出 6 分钟才会毫无预警翻崖(例如新加一个 hang-proof 长等待套件)。plan §4 已把这写成设计内边界。
2. **拆分后只有 2 轮跑批,均绿** —— 「两片之间无隐藏先后依赖」是经验支持,不是压力验证。套件本身文档化为 hermetic。
3. **`CI OK` 挡合并是合同级,不是强制级** —— founder 是 repo ADMIN,可绕过分支保护(FLY-350 已确认的既有形态)。与现有全部 gate 同一信任模型,非本单引入。
4. **同步提高上限可以通过全部守卫**(M8 绿)—— 这是有意留的最后手段(工单本身把「提上限」列为可接受的第三优先项,且 tripwire 会自动跟着新 cap 走),但意味着这条路除代码评审外没有额外阻力。
5. **计时起点比 GitHub 的超时时钟晚约 3 秒**(实测:job startedAt 09:10:02 vs 记录起点推算 09:10:05)。低估 3s = cap 的 0.25%,可忽略。
6. **`fly-889-ci-workflow-timeout-guard.test.ts` 存在 sparse-checkout 时的 `expect(true).toBe(true)` 空过分支** —— FLY-889 既有形态,非本单引入;完整 checkout 下不可达。

---

## 7. 全仓 gate

`Quick Gate (build + typecheck + lint)`、`Unit` 五分片、两条 `Script Tests`、`payload-distribution`、`CI OK` 在 head `92f31f49` 上全绿(run `32120143497`)。

## 8. 交付物

- 本报告
- founder ship 报告:`ship-report-FLY-1870.html`(3 张 mmdc 预渲染 inline SVG;实测高度 5665px ≤ 6000px、无横向溢出;一键复制的失败路径实测不会谎报「已复制」)
