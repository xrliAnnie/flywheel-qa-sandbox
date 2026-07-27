# FLY-1504 ship-on-comment 10 分钟超时拦住所有 :cool: ship — 探索

Issue: FLY-1504 (https://linear.app/geoforge3d/issue/FLY-1504/基建卡点-ship-on-comment-流水线-10-分钟超时-拦住所有-cool-ship)
日期: 2026-07-27
基于: 无

## 一句话

`.github/workflows/ship-on-comment.yml` 的 `timeout-minutes: 10` 早已装不下 job 内单机跑的全套测试(step 级实测:前置 3m08s + Test 跑到 7m05s 被砍时远未结束;由 CI shard 时长折算,全程估 ~18–20 分钟),导致每一次 :cool: ship 都在 Test 步被强制 cancel、Merge 步 skipped、PR 永不合入 —— 仓库级 ship 断路。

## 症状实证(2026-07-27,run 30305893305,FLY-1497 / PR #710)

从 `gh run view 30305893305 --json jobs` 的 step 级时间线:

| 步骤 | 开始 | 结束 | 耗时 | 结论 |
|------|------|------|------|------|
| Set up → Lint(前置 11 步) | 21:12:54 | 21:16:02 | **3m08s** | 全部 success |
| Test(`pnpm test:packages:run`) | 21:16:02 | 21:23:07 | **7m05s 时被砍** | **cancelled** |
| ✅ Merge PR | — | — | — | **skipped** |

job 总时长 10m18s 触顶 `timeout-minutes: 10` → GitHub 强制 cancel。verify-approval 已 approved:true、:cool: 已正确触发、run 正常启动 —— 死因只有超时这一个。

`concurrency` 是 `group: ship-pr-<PR号>` + `cancel-in-progress: false`,已排除并发抢占;`skipped` 的历史 run 都是重复评论被 concurrency 排队跳过,与本病无关。

## 根因链

1. **ship job 是「一个 job 跑完整套 CI」**:steps 串行(install → better-sqlite3 → build → typecheck → lint → Test),其中 Test = `pnpm test:packages:run`(= `pnpm --filter './packages/*' test:run`,包任务按拓扑序、pnpm 10 默认最多 4 路并发,受限于 4 核 runner)。
2. **测试规模早已长过 10 分钟**。历史脉络:
   - FLY-2(PR #76)创建本 workflow 时定的 `timeout-minutes: 10`,当时全套跑得完;
   - FLY-889(2026-07-05)常规 CI 单 job 撞了同一堵墙 —— 当时实测 suite ~750s、Test 步单独 446–467s、约一半 run 被超时 cancel,修法是 `ci.yml` 超时 10→20;
   - FLY-1338 进一步把常规 CI 拆成 5 路并行 shard(teamlead×3 + heavy + light,各 15 分钟预算)+ Script Tests(15 分钟)。常规 CI 靠**并行**才把墙钟压回 ~9–10 分钟;
   - **ship-on-comment.yml 两次都没跟着改**(FLY-1375 动过该文件但没动超时)。它还是单 job 串行,预算还是 10 分钟。
3. 总时长**估算**(以 2026-07-25 成功 CI run 30145247672 的并行 shard 时长折算,非直接实测 —— 完整实测要等合入后第一次跑通):teamlead 三个 shard 测试净时长各 ~3.5–4 分钟、heavy ~3.5 分钟、light ~1 分钟(Script Tests 不在 ship 范围)—— 单机 Test 步 ≈ **14–17 分钟**,加 3 分钟前置 ≈ **18–20 分钟**,约为预算的 2 倍。实测下界佐证:Test 步跑到 7m05s 被砍时远未结束。

## 影响面

- **所有走 :cool: 的 ship 全断**:FLY-1497(已实撞)、FLY-1496、批次 2 四张、以及之后每一张。
- 失败形态有迷惑性:❌ Report failure 步在 job cancel 时同样被 skipped(`if: failure()` 对 cancelled 不触发),所以 PR 里连失败评论都没有,只有 receipt 停在 `status=started`。

## 方案选项

### 选项 A(推荐,issue 指定的最小改动):`timeout-minutes: 10 → 30`

- 一行改动 + 一条解释性注释(沿 FLY-889 在 ci.yml 留量化注释的先例)。
- 30 的依据:估算全程 ~18–20 分钟,30 留 **~10–12 分钟余量(占上限 ~33–40%)**,吸收 runner 慢机/缓存 miss/套件继续增长;且 30 与本仓 payload-* 三个 workflow 的既有取值一致(payload-activation / payload-beta-release / payload-promote 均为 30)。
- 20(照抄 FLY-889)不够:对 18–20 分钟只剩 0–2 分钟余量,FLY-889 的数据已经证明套件 22 天能长 30%+。45 则无证据地把真挂死的检测再推迟 15 分钟。

### 选项 B(issue 明示暂不做):ship job 复用 PR CI 结论 / 只跑关键子集

- 能把 ship 从 ~20 分钟压回 ~4 分钟,但改变信任模型(merge 前最后一道全量验证消失/变形),需要独立设计与验证。issue 明确「本单先只做最小改动」。留 follow-up。

### 选项 C:ship job 内并行 shard(复刻 ci.yml matrix)

- merge-gating workflow 引入 matrix + job 间依赖,复杂度和风险远超一行超时,同样违背最小改动原则。不做。

## 合入路径(本单特殊,必须写进设计)

GitHub 对 `issue_comment` 触发的 workflow **永远执行默认分支(main)上的定义** —— 功能分支上改这个文件对 :cool: 无效;而任何 PR 想合入又必须走这条坏掉的流水线 = 死循环。

**唯一解:founder 在 GitHub 网页上直接点 Merge 合入本 PR。** 合并是 Annie 的权限;Runner/Lead 不代合(FLY-945/FLY-248 铁律)。本单的 ship 环节不是 :cool:,是「Annie 网页点 Merge」。

## 已识别的次生边界(不在本单改,交 Lead 决策)

**Runner 协议的 10 分钟 merge 轮询窗口**(`packages/edge-worker/src/Blueprint.ts:2307`:「poll … every 30s until MERGED, max 10 min」):超时改 30 后 ship job 正常也要跑 ~20 分钟,按现协议 Runner 会在 10 分钟处假报 blocked —— 而 blocked 路由会作废活着的 founder 批准(两层),PR 却在服务端继续合入,状态撕裂。这是产品代码,超出本单「只改 workflow 一行」的范围,建议开 follow-up issue 把轮询窗口同步放宽到 ≥35 分钟。

## 验收(来自 issue)

1. 合入 main 后,FLY-1497(PR #710)重发 :cool: 能跑完并真正 merge;
2. ship job 总时长对 30 分钟上限有明显余量(预期 ~18–20 分钟,余量 ~10–12 分钟,占上限 ~33–40%);以该次实跑数据回填替换本文档的估算值。
