# FLY-1863 post-ship 两条测试假 flake 定性 — 探索

Issue: FLY-1863 (https://linear.app/geoforge3d/issue/FLY-1863/p0main-红-869-引入的两条-post-ship-finalization-测试在-main-上就失败-ci-ok)
日期: 2026-08-17
基于: 无(上游 = Linear 单顶部 Tadashi 的「假说尸检榜」)

## 一句话

那两条 post-ship-finalization 测试不是间歇 flake、不是分片邻居依赖 —— 是**墙钟定时炸弹**:测试种子把 lease 到期时间硬编码成 `2026-08-18T01:00:01.000Z`,而被测实现用真实 `new Date()` 校验 lease,所以 UTC 2026-08-18T01:00:01Z 之前跑必绿、之后跑必红。「间歇」是把引信两侧的样本混在一起看出来的错觉。

## 输入:接手时的假说地形(尸检榜)

接手时榜上已判死 4 条(#869 确定性破坏 main / 分片邻居文件数不同 / 只在 merge 态失败 / head_sha=被测树),存活 3 条:

| 存活假说 | 本轮处置 | 判死证据(详见 research.md) |
| --- | --- | --- |
| 1. 高失败率间歇,main 那次绿是幸存者 | **判死** | 不是概率,是时间阶跃:引信前样本 100% 绿(3/3),引信后 100% 红(lease=2026 的全部样本);本地单跑 ×10 = 10/10 红,零方差 |
| 2. 跨文件/worker 状态泄漏 | **判死** | 单跑(无邻居)确定性红;只改测试内一个日期字面量(2026→2099)单跑立刻 40/40 绿 —— 状态完全在测试文件自身种子里,与邻居/worker 无关 |
| 3. push 与 pull_request 的 env 差异 | **判死** | 同一环境(本地)改日期即翻转;#875(带 2099 的分支)在 pull_request merge 态、引信之后全绿 |

新事实(榜上没有的):**#875 分支里已经有人把 lease 改成 `2099-08-18`**(FLY-1833 顺手改的)—— 这既解释了榜上最后一个"绿色反例",又等于现实免费替我们在 CI merge 态跑了一次单变量突变实验。

## 病灶拆解(两个;病灶 B 已被 founder 裁出本单)

> **2026-08-17 founder 范围裁决:**病灶 B 是独立问题,不在 FLY-1863 实现。以下 B 的分析保留为取证和后续立单输入;本 PR 只修病灶 A。

**病灶 A(直接)**:`seedLandOperationClaim`(post-ship-finalization.test.ts:89-109)把绝对未来时间戳种进 `lease_expires_at`,而实现路径(post-ship-finalization.ts:1057 → StateStore.recordLandOperationStep:45742)用真实墙钟做 `lease_expires_at <= now` 校验。测试写下时"未来"只有 ~25 小时,#869 合入 46 分钟后引信烧完,从此每条 PR 的 merge 态 CI、以及下一次 main push CI,这两条测试全部确定性红 → `CI OK` 聚合门红 → 全仓被挡。

**病灶 B(结构,已裁出 → 独立问题)**:main push 的 CI 一直存在且会红,但**红了没有任何人/机制被通知** —— 信号存在、无人接。#869 自己的 merge-后 main run 是绿的(赶在引信前),但假如它红了,也要等下一条 PR 被连坐才有人开始逐条错误归因。这正是本次事故消耗掉整晚侦查的形状。

## 方向选择

**病灶 A 修法:把种子时间改成相对真实时钟派生**(base = `Date.now()`,created = base−1s、claimed = base、lease = base+1h)。
- 弃选「vi.useFakeTimers 冻结时钟」:该文件 :1273 之后已有另一组 fake-timers 用例,给前段 describe 再叠一层 fake Date 增加交叉污染面;而相对时钟是最无聊、最自包含的修法,零新机制。
- 弃选「改实现注入 clock」:实现用真实墙钟是正当语义(lease 就该按真实时间过期),为测试注入 clock 是把病往生产代码里推。
- 弃选「调分片 / skip」:Lead 明令禁止,且都治不了病(单跑也红)。
- 附加一条**时间免疫回归测试**:用 `vi.useFakeTimers({toFake:["Date"]})` 把时钟拨快 400 天跑一次 happy path,把"这类引信不许再埋"直接编码成会失败的检查(修的是结构,不是加报警器 —— 它锚死的是「种子必须相对时钟」这个性质本身)。

**病灶 B 修法(历史方案,已裁出):ci.yml 加一个只在 `push`+`main` 且有 job 失败时运行的 `main-red-alert` job**,经 Discord webhook 把失败 job 清单 + run URL 发进 #flywheel-alerts(该频道已有工单 owner 闭环)。
- 弃选「Bridge 侧轮询 gh」:依赖本机 Bridge 活着(main 红常与本机高负载同窗),且 FLY-1624 刚给 gh API 上了配额纪律,不宜再添轮询;GitHub Actions 侧自报独立于本机。
- 弃选「独立 workflow_run 工作流」:多一个文件、无额外收益。
- secret 缺失时该 job **fail-loud**(只影响 main 自己的 run,不进 `ci-ok` 的 needs,PR 门零变化)。

## 范围边界

- 本单只改:测试种子函数 + 一条新回归测试。
- 已裁出:ci.yml 新 job、告警脚本、结构测试和 webhook secret setup;整体移交独立问题。
- 不改:StateStore / post-ship-finalization 生产代码零字节变化;不动分片矩阵;不 skip 任何测试。
- 顺带产出但不顺带修:全仓测试里同形状潜在引信的 bounded 排查清单(如 merge-ship-gate.integration.test.ts 的 `2027-07-16`,11 个月引信)→ 排查结果如有实弹,另立 issue。
- 与 #875 的协调:它分支里带着 lease→2099 的同行改动,先后合入都会撞一行 trivial conflict,解法写进 plan。
