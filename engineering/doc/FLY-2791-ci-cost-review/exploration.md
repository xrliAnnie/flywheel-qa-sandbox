# FLY-2791 CI 开销与作业梳理 — 探索

Issue: FLY-2791 (https://linear.app/geoforge3d/issue/FLY-2791/ci开销与作业梳理-调研迁-ubicloud-后-ci-实际花多少是否比-github-时期更省系统梳理所有-ci)
日期: 2026-09-22
基于: 无

## 1. founder 要回答的三个问题

1. **迁 Ubicloud 之后花的钱在合理范围吗?会不会比以前更贵?**
2. **是不是跑了很多 unnecessary 的 CI job?** 不管在哪家跑,白花钱的都要清掉。
3. **Ubicloud Canary 流程是不是已经完全不需要了?能删吗?**

附带一条口径:"所有 Flywheel 对应的 CI/CD 我想都迁过去比较好;但如果只是 release 流程,留在 GitHub 也可以。"

## 2. 边界(本单不做)

- 不改任何 workflow 文件、不改 repo variable、不改账单设置。
- 不触发任何 workflow(包括不做 `gh workflow run`、不 rerun)。
- 清理动作本身由后续实现单执行;本单只出清单。

## 3. 关键未知 / 需要验证的假设

| # | 未知 | 为什么重要 | 打算怎么定 |
|---|------|-----------|-----------|
| U1 | 真实账单拿不拿得到 | founder 说 GitHub 本月已花 800+/上限 850;这是唯一的地面真值 | 本机 gh token scope 只有 `gist, read:org, repo, workflow`,`/users/{u}/settings/billing/actions` 需要 `user` scope ⇒ 确认拿不到,写明需要 founder 提供哪一页 |
| U2 | Ubicloud 单价 | 决定"省没省" | 读 Ubicloud 官方 pricing 文档,区分 standard / premium |
| U3 | premium runner 开关状态 | FLY-2718 实测"装完后 premium 是 ON 的",premium 单价 = standard 的 1.6 倍;同一个 `ubicloud-standard-2` label 在 premium 开着时按 premium 计费 | 控制台状态只有 founder 能看 ⇒ 列为待 founder 确认项,报告里给开/关两种口径 |
| U4 | GitHub 2026 年改过价 | 如果还按 $0.008/min 算会高估"以前花了多少" | 查 GitHub 官方 2026 pricing change |
| U5 | 自建/第三方 runner 的 $0.002/min 平台费是否生效 | 若生效,Ubicloud 分钟还要再叠一层 GitHub 费用,省下来的会少一大半 | 查官方公告的最新状态 |
| U6 | Ubicloud standard-2 是不是更慢 | 更慢 ⇒ 分钟数变多 ⇒ 抵消单价优势。记忆里有"慢约 1s 翻红三条时序测试" | 用同名 job 在 cutover 前后的真实时长对比(只比 success 的) |
| U7 | `CI_SCOPED_MODE` 现在是 on 还是 off | 决定 docs-only / scoped 跳过有没有在生效 | `gh variable list` |

## 4. 取数方案

- 口径统一用 **job 级**数据(GitHub 按 job 计费、按分钟向上取整),不是 run 级。
- 数据源:`repos/xrliAnnie/flywheel/actions/workflows/<wf>/runs` + `runs/{id}/jobs`,取 `started_at/completed_at/conclusion/labels`。
- 迁移分界线:`vars.CI_RUNNER` 改成 `ubicloud-standard-2` 的时间 **2026-09-22T03:00:25Z**(`gh variable list` 的 updatedAt)。
- 迁移后只有约 25 小时的数据 ⇒ 迁移后成本用"同样的工作量 × 新单价"折算,并用这 25 小时的真实 job 时长做校验,不直接拿 25 小时外推一个月。

## 5. 预期产出

1. `research.md` — 开销对比 + 全量 workflow/job 清单(触发条件、时长、次数、cancel 比例、重复性、可跳过性)。
2. `cleanup-checklist.md` — 每条含"删/合并/降频/按范围跳过" + 预计节省 + 风险。
3. `founder-report.html` — 一页,经 `flywheel-comm publish-report --publish-only` 发布,URL 交 Lead。
