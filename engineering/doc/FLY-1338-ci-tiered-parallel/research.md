# FLY-1338 CI 分层 + 并行 — 调研

Issue: FLY-1338 (https://linear.app/geoforge3d/issue/FLY-1338/cycle-time-ci-分层-并行-单轮-ci-墙钟砍半)
日期: 2026-07-18
基于: exploration.md(方案 A 已过 brainstorm gate,Lead 确认)

本文是方案 A 的机制核查:每个关键机制都在本机真跑验证过,标注「✅实测」;查不到的标注来源。

## 1. vitest --shard 真跑验证 ✅实测

vitest 3.2.4(仓库锁定版本),在 flywheel-dag-resolver(2 个测试文件)上实测:

- `vitest run --shard=1/2` → 只跑 LinearGraphBuilder.test.ts(1 file);`--shard=2/2` → 只跑 DagResolver.test.ts。**两片不重不漏,并集 = 全量**。
- shard 按测试文件切分,新增文件自动进入某一片,无手工维护成本。
- teamlead 的 collect/transform 开销(217s)只发生在本片文件上,随 shard 同步三分。

### 1.1 ⚠️ pnpm 传参形式坑(实测抓到,必须写死在 workflow 里)

| 形式 | 结果 |
|---|---|
| `pnpm --filter flywheel-teamlead test:run -- --shard=1/3` | **flag 被 pnpm 静默吞掉,全量照跑**(危险:CI 绿但 shard 无效,3 片各跑全量,墙钟不降且三倍计费) |
| `pnpm --filter flywheel-teamlead test:run --shard=1/3`(无 `--`) | ✅ flag 到达 vitest,shard 生效 |
| `pnpm --filter flywheel-teamlead exec vitest run --shard=1/3` | ✅ 生效 |
| `pnpm -C packages/teamlead test:run --shard=1/3` | ✅ 生效 |

**契约:workflow 一律用「无 `--`」形式**。这个坑的失败模式是「假拆分静默全量」——绿灯掩盖,必须配结构守卫(见 §6)。

## 2. 分桶与时间模型(基于 run 29646776775 实测)

有 test:run 脚本的包共 16 个。分桶:

| job | 内容 | 测试净耗时 | 预估 job 墙钟(+~1.7min 开销¹) |
|---|---|---|---|
| unit-teamlead-1/2/3 | `flywheel-teamlead --shard=k/3` | ~175s/片² | ~4.5-5min |
| unit-heavy | claude-runner(74s)+ flywheel-comm(67s)+ edge-worker(67s) | ~208s³ | ~5-5.5min |
| unit-light | 负向 filter:`./packages/*` 排除上述 4 包(实测匹配 18 包,含无测试包被脚本运行形式自动跳过) | ~86s | ~3.5min |
| quick-gate | build + typecheck + lint | 63+53+11s | ~3.2min |
| script-tests | apt(7s)+ test:cycle-time + 全部 ~25 个 hermetic bash 步骤 | ~173s | ~5min |
| payload-distribution | 不动 | — | ~1min(现状) |
| ci-ok | needs 全部,`if: always()` 聚合判定 | ~0 | 秒级 |

¹ 开销 = checkout+pnpm/node setup(~30s)+ install(~8s,pnpm store 缓存已有)+ better-sqlite3 prebuilt(~1s)+ build(~63s)。**每个跑测试的 job 必须自带 build**:各包 package.json 的 types/main 指向 dist/(实测 flywheel-core),跨包 import 走 dist,typecheck 与测试都以 build 为硬前置。
² 525.9s / 3,shard 按文件数切、非按时长,可能不均;实测值以实现 PR 首跑为准,plan 里留「若最长片 >250s 调成 4 片」的调节阀。
³ 3 个包在同一 4-vCPU runner 上由 pnpm 并发跑(现状同机 4 包并发下测得的数值,独占 runner 只会更快)——净耗时取 max(74s) 到 sum(208s) 之间,保守按 sum 估。
⁴ 现状对照:单 job 18m06s;新布局理论墙钟 = max(所有 job) ≈ **5.5min,-70%**。

自建 vs artifact 传递(build 产物 upload/download):build 仅 63s,artifact 链路会把关键路径变成 build-job(~2.5min)+ 下载 + 测试(串行依赖,反而 ~6.5min),且引入跨 job 耦合失败面。**各 job 自建更快也更简单**,已选定。

## 3. GitHub 平台事实

- **仓库 xrliAnnie/flywheel = PRIVATE + Free 计划** ✅实测:`gh api .../branches/main/protection` 与 `/rulesets` 均返回 403「Upgrade to GitHub Pro or make this repository public」→ **私仓 Free 计划下 branch protection / rulesets 功能整体不可用,按名 required check 不可能存在**。exploration §5 的 check 名风险直接闭合;此 403 输出即 PR 附带的核查证据(Lead gate 回复要求的 gh api 实查)。
- `gh pr checks` 聚合全部 check 的结论(exit 0 全绿 / 8 pending / 其他=有失败),不认名字、不关心 job 数量 → flywheel-comm 的 CI 前置探针、approve gate 流程零改动兼容。
- Free 计划并发上限 20 jobs(GitHub 官方文档,标准 GitHub-hosted runner);新布局峰值 ~8 jobs,两个 PR 同时跑也不顶格。
- concurrency `ci-${{ github.ref }}` + cancel-in-progress 是 workflow 级,拆多 job 后行为不变(新 push 取消同 ref 整组 job)。

## 4. 计费影响(交 Lead 呈 Annie 的口径)

- 单次完整 run 总计算分钟:现状 ~19min → 新布局 ~33min(**+~75%**)。私仓 Linux runner 计费 $0.008/min → 每完整 run 约 +$0.11。
- 运行量实测:2026-07-15/16/17 分别 161/96/114 次触发(大量被 cancel-in-progress 提前截断,截断 run 只计费已执行部分)。
- 二阶效应两头都有:并行化让「被取消的 run」在被取消前烧得更快(同一分钟内 7 job 并行);但单轮 6min 完成也让更少 run 活到被取消。净效应以实现后一周实测为准。
- 降级阀(Lead 已确认作为备选):teamlead 改 2 片 → 总分钟 +~50%,墙钟 ~7-8min。

## 5. 各 job 的环境依赖映射(从现状 ci.yml 逐步骤核对)

| 依赖 | 需要它的 job |
|---|---|
| git config user(部分测试做真 git 操作) | 全部跑测试的 job(照抄现状步骤) |
| better-sqlite3 prebuilt install | 全部跑测试的 job + quick-gate(build 后 typecheck 会加载?否——typecheck 纯 tsc,不需要;保守起见跑测试的 job 全带,quick-gate 不带) |
| apt tmux/lsof/sqlite3 | 仅 script-tests(cmux-sync / orphan-reaper / codex-log-guard / cycle-time 等) |
| built dist(pnpm build) | 全部跑测试的 job + quick-gate(typecheck 前置)+ script-tests(FLY-648/1023/1062 套件驱动真 dist) |
| node_modules/typescript(FLY-1062 fixture packer) | script-tests(install 自带) |
| python3 / jq / shasum(FLY-913/927) | ubuntu-latest 自带,无需显式装(现状也没装) |

FLY-1323 的注意事项(payload-distribution job 内 preflight 两套件必须串行,因为共用 de-placeholder 的 config.mjs)只涉及 payload job 内部顺序——该 job 不动,无影响。

## 6. 防「假拆分静默全量」守卫(承接 §1.1)

仓库已有 workflow 结构 lint 先例:`scripts/__tests__/release-workflows-structure.test.sh`(FLY-1323,纯文本断言 workflow 合同形态)。同款思路加一个轻量 `ci-structure` 断言脚本,进 script-tests job:

1. ci.yml 中每个 teamlead shard 步骤必须是「无 `--`」传参形式(grep 拒绝 `test:run -- --shard` 形态);
2. shard 分母一致性(3 片就必须恰好 1/3、2/3、3/3 各一);
3. 负向 filter 桶的排除清单与 heavy/teamlead 桶的包名一一对应(排除即被别桶显式覆盖,不允许凭空排除)。

运行时对账(实现阶段验收,非常驻):3 片 Test Files 数之和 = 全量 615(以当时实际数为准),且每片 < 全量——直接否掉「flag 被吞」的失败模式。突变验证:故意把一片改成 `--` 形式,确认守卫变红。

## 7. 已知不动项

- ship-on-comment.yml:整体不动(近 200 次触发 196 skipped,实际弃用;其自带 CI 重跑 timeout 10min < 现 Test 12m46s,真触发也必超时——既有尸体,另单处理)。
- payload-distribution job:字节不动。
- 已知 flaky 测试(auto-qa-coordinator escalates-exactly-once、claude-profile display-identity):正交,不在 scope,已有 task 跟踪。
- vitest 各包配置、测试代码本身:零改动(覆盖不变的最强保证——跑的是同一批文件)。
