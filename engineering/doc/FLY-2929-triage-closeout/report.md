# FLY-2929 盘点落地:关单与挂修复单 — 执行报告
Issue: FLY-2929 (https://linear.app/geoforge3d/issue/FLY-2929/2072-盘点落地-逐张复核并关闭-48-张可关单32-张已修未关-8-张重复-8-张一次性把-118-张有效单挂到对应修复单下)
日期: 2026-09-25
基于: FLY-2915 PR #1347 的 engineering/doc/FLY-2072-triage/tickets.json、fixclasses.json

> 本文件与 FLY-2929 issue 评论同文;逐张复核证据见同目录 evidence.json。本 PR 仅为 runner 收尾,不含代码。


基于 FLY-2915 盘点(PR #1347)的 `tickets.json` / `fixclasses.json`。复核时间 2026-09-26(UTC)。

**结果:已关 44 张 / 未关 4 张 / 新挂 related 关系 87 条**(48 张可关单中 44 张复核通过)。

### 复核方法
- 已修未关:修复 PR 经 `gh pr view` 核 MERGED,merge commit 是 `origin/main` 祖先(35 个 PR 全部通过,无 revert);生产 `deployed-sha` 59123848a 已包含除 #1330 以外的全部修复;逐张查合入之后的单下评论 + eng-lead 巡检报告(786 份)有没有新实例——合入后、班车部署前的实例按旧字节处理。
- 重复:读两张单的描述,确认报错点/代码位置/修法落点一致才标 Duplicate。
- 一次性:确认最后一次实例之后单下评论和巡检都没有再出现,并核实触发源已消失。


### 已修未关 → Done(30)

| 单号 | 处置 | 依据 |
|---|---|---|
| FLY-2120 | Done | #1053(069013b25,2026-09-03)、#1059(86387f17d,2026-09-03);返工看门狗把正在干活的体误判卡死并冻住整单,冻住后无路解除 |
| FLY-2128 | Done | #982(078f1811e,2026-08-29)、#1080(df815b841,2026-09-04)、#1089(73f438996,2026-09-05)、#1119(d294723ea,2026-09-07);founder 点了 ✅ 批准却没生效,原因是卡已被系统误判作废 |
| FLY-2129 | Done | #1119(d294723ea,2026-09-07);系统把没合并的 ship 卡误判成已合并作废,founder 三次批准全被吞 |
| FLY-2231 | Done | #1137(5cbd540f1,2026-09-10);测试房的 Bridge 继承了生产 Codex 路径,把生产 Codex 体当孤儿成批杀掉 |
| FLY-2299 | Done | #1310(88eb9fadc,2026-09-24);验证路返工的投递在 QA 已完成后还挂着「等回执」,每 30 秒假告警并挡住下一次打回 |
| FLY-2315 | Done | #1047(61e6c6798,2026-09-04);founder 卡还没答,卡上链接的报告页已被清理成 404 |
| FLY-2321 | Done | #1067(7e1c93cf7,2026-09-04);Lead 给 Codex 体的回复永远排在队里,体一直说「没有新指令」 |
| FLY-2333 | Done | #1077(54cdf97f4,2026-09-04);返工重试时提交凭据丢了,QA 通过了却记不上账 |
| FLY-2335 | Done | #1079(96db86e58,2026-09-04);审查体跑测试不限线程还重复起审,把整机内存打爆、Bridge 被杀 |
| FLY-2340 | Done | #1224(aaf8e9c0e,2026-09-17);Bridge 死后落地车道被死进程攥一小时,批完的卡全排队 |
| FLY-2348 | Done | #1084(641734888,2026-09-05);死信改投时撞唯一约束,死信 hold 两扇门都打不开 |
| FLY-2438 | Done | #1155(bece7de15,2026-09-11);换来的替身把活干完了,账还停在「待换体」,交卷被 409 拒 |
| FLY-2466 | Done | #1224(aaf8e9c0e,2026-09-17);死体留下「我在停驻」的声明,合入后收尾永远不收账 |
| FLY-2477 | Done | #1164(26ebc4931,2026-09-13);Codex 体交卷前停驻过一次,交卷那刻就被系统杀掉 |
| FLY-2518 | Done | #1168(9713de9e5,2026-09-13);把卡住的投递改投给已完成的替身被静默拒,操作永远挂着 |
| FLY-2521 | Done | #1246(1efbb9332,2026-09-18)、#1260(487799b80,2026-09-19);切号子系统没装好却默认开着,额度满一次就静默挡住所有 Codex 启动 |
| FLY-2522 | Done | #1168(9713de9e5,2026-09-13);引擎已换体,给旧死体的返工信还把整条 run 打成 held |
| FLY-2535 | Done | #1170(c2820ba3c,2026-09-14);PR 改坏的 CI 配置文件测不出来,合入后定时班车整体停摆 |
| FLY-2564 | Done | #1207(156601a2e,2026-09-15);Bridge 每 3 秒全表扫描把主线程占死,HTTP/Discord/信箱全停 |
| FLY-2565 | Done | #1207(156601a2e,2026-09-15);Bridge 文件句柄上限 256 被泄漏的数据库连接顶满,主线程空闲也不回包 |
| FLY-2592 | Done | #1216(66f84d74e,2026-09-16);性能测试的 50ms 墙钟断言在共享 CI 上被调度延迟误红 |
| FLY-2594 | Done | #1223(2768d5dc7,2026-09-16)、#1222(a3686d960,2026-09-16);心跳热切换测试在并行分片偶发红 |
| FLY-2600 | Done | #1251(60f2fd04c,2026-09-22);Codex Lead 的查看窗一开就退,founder 在 cmux 看不到 Raya,日志却说已起 |
| FLY-2614 | Done | #1238(45bda46ef,2026-09-17);合入后收尾因 worktree 分支名不一致拒删,run 永不终结 |
| FLY-2615 | Done | #1227(3876a76fe,2026-09-17);founder 批完卡、别人先合了同文件,落地冲突打回,founder 看到「批了又失败」 |
| FLY-2640 | Done | #1310(88eb9fadc,2026-09-24);返工唤醒已签收却没记账,投递永远挂着,把后续打回和冲突返工全挡死 |
| FLY-2652 | Done | #1272(e844b4545,2026-09-19)、#1283(72706eb97,2026-09-23)、#1311(5393ce2d5,2026-09-25);cmux 同步器被几千个早已不存在的旧窗口名单拖死,新 runner 窗口在 cmux 里看不见 |
| FLY-2660 | Done | #1233(e41a86cfc,2026-09-17);机器试判历史页每 30 分钟把 24 页全量重发,一天烧光报告托管额度 |
| FLY-2715 | Done | #1243(58693d28c,2026-09-22);测试房里的 Codex Lead 去读生产的登记收据,永远起不来 |
| FLY-2728 | Done | #1262(ef3e6f35a,2026-09-19);进度页把 Linear『进行中』直接显示成『在跑』,零活体也说在跑 |

### 重复 → Duplicate(6)

| 单号 | 处置 | 依据 |
|---|---|---|
| FLY-2462 | Duplicate | → FLY-2586:[归并] 与 FLY-2586 同一缺口:重启后 reown 恢复提交后 turn reconcile 失败(active_turn_mismatch)即判死,错误码逐字相同;2586 次数更多(24)、实例延续到 9-24。原批次判定:m… |
| FLY-2572 | Duplicate | → FLY-2814:与 FLY-2814 同一缺口:引擎账面已判终态(usageLimited→failed / Lead 收尸),Codex goal runtime 仍自续干活,两边真相分裂;FLY-2893 普查把 2572 与 2814 同归 K13「… |
| FLY-2629 | Duplicate | → FLY-2771:与 FLY-2771 是同一段 CTE(lead-patrol-snapshot.sh:736 `WHEN c.row_count > 0 AND c.owner_count <> c.row_count THEN 'current_own… |
| FLY-2637 | Duplicate | → FLY-2109:与 FLY-2109 同一缺口:切号器只换机器级凭据,在飞 Claude 体凭据焊死在旧号,撞周额度后停在空提示符、Bridge 无事件无告警,只能人眼发现(2109 为 8-28 首例、×2)。本单多出的 Fable 专属额度观测已由 F… |
| FLY-2710 | Duplicate | → FLY-2474:与 FLY-2474 同一缺口:停驻 Codex 体被 resident grace(RESIDENT_GRACE_MS=30min)到期主动收掉,账面仍 parked/ship_parked、节点仍绑死体、引擎不换体。本单实例 #2 明写… |
| FLY-2743 | Duplicate | → FLY-2630:与 FLY-2630 同一缺口:codex-daemon-adapter-helpers.ts:~205 把任何 goal 非 complete 结束当终态失败拆体,不区分上游错误类型(本单是不可重试的 400 access_program… |

### 一次性 → Canceled(8)

| 单号 | 处置 | 依据 |
|---|---|---|
| FLY-2081 | Canceled | 描述首行明写「⚠️测试用·可删」:FLY-2080 QA attempt 4 按 founder 8-27 05:36 授权建的补测夹具,×2 均为合成实例(run 92626055 rework:qa4-synthetic),未对生产库执行;巡检 7 天 0 命中。非真实病根。 |
| FLY-2089 | Canceled | 描述明写「⚠️测试用·可删」:FLY-2080 qa@5 复测「截断安全查重 + ×N 累加」的夹具,形状 qa_retest_synthetic_root_2080,根因「无」;巡检 0 命中。 |
| FLY-2172 | Canceled | 仅 1 例(FLY-2121, 08-30),触发条件是 Lead 手工把 stall-hold 的 delivery 从 held 拨到 awaiting_receipt(合同外账本手术),引擎自身路径是否同病“待查”且此后无复现、巡检零命中。产生该 held 的 stall … |
| FLY-2176 | Canceled | 误读:teamlead.db flag_scan_runs 只读核实为每周一次(08-17/08-23/08-30/09-06/09-13/09-20),“停更 6 天”就是周节拍间隔;08-30 那次扫描已把离场落账(flag_departures 49 行,max 08-30… |
| FLY-2308 | Canceled | 仅 9-3 一晚 1 例,巡检零复现(21 天)。main 上 patrol-tick.ts 每个 tick pass 都新建 capacityPromise 调 buildCapacitySnapshot(9-3 时的 4555e82bc 版本相同),与描述「tick 构建时没… |
| FLY-2372 | Canceled | 宿主双 tmux 二进制事故:2026-09-25 实测 /usr/local/bin/tmux 已不存在,仅剩 /opt/homebrew/bin/tmux→3.7c,PATH 顺序已无法再命中 3.5a。只出现 1 次(9-5T19:45Z),巡检最后命中 9-6,Lead … |
| FLY-2376 | Canceled | 本单自述为存量迁移缺口:只有加 episode 列之前写下的 waiting_founder 收据 episode_started_at 为 NULL,新收据都带 episode。仅 FLY-2309 同一 episode 在 9-6 连续 3 个 tick 出现,之后 19 天… |
| FLY-2595 | Canceled | 仅 2557 上线首轮 backfill(2026-09-15T19:02Z)命中 8 张遗留 QA 测试夹具单,Lead 当场逐张 resolve 并请 founder 关闭(FLY-127 已于 2026-09-16 Done);巡检零提及、无复现。epic-intake-r… |

### 未关(4)

| 单号 | 盘点判定 | 不关的理由 |
|---|---|---|
| FLY-2287 | 已修未关 | 修复 #1137 的 boot 守卫只在设置了隔离根(slot)时生效;本单最后一例正是 QA 体手工起「隔离」Bridge 未 env -i、未设隔离根而继承生产 env——这条路径 #1137 不覆盖(隔离根为空即按 production 模式放行),盘点证据自己也写「未逐行核」。现象不能确认已根除。 |
| FLY-2472 | 重复 | 与 FLY-2202 只共享修法②(implement_done 不校验产品代码 diff);本单独有的机制①——resume 替身重放死体 transcript 末尾的 complete 步——不在 2202 范围内,不是同一病根。改挂到修复单 #6 FLY-2921。 |
| FLY-2558 | 重复 | 本单描述明写与 FLY-2462(active_turn_mismatch,postCommit)「不同类」:报错点是 prepareCodexRecoveryAgentHome 的 arm 漂移(precommit)、修法是 arm 漂移容忍 + 不计 episode 预算;与 FLY-2586 同属「重启后 reown 失败」大类但不是同一病根。改挂到修复单 #7 FLY-2925。 |
| FLY-2892 | 已修未关 | 修复 #1330(6523b997c)2026-09-25T23:20Z 才合入;生产 deployed-sha 仍是 59123848a(不含 #1330),要等 09-26 00:00 PDT 班车才上线,修复后尚无任何生产观察窗;盘点证据也写「生产侧 2873 收尾尚待核」。 |

### 挂修复单(related)

| 类 | 修复单 | 挂上张数 |
|---|---|---|
| #1 | FLY-2923 | 9 |
| #2 | FLY-2919 | 9 |
| #3 | FLY-2924 | 8 |
| #4 | FLY-2920 | 6 |
| #5 | FLY-2373 | 6 |
| #6 | FLY-2921 | 7 |
| #7 | FLY-2925 | 7 |
| #8 | FLY-2922 | 9 |
| #9 | FLY-2926 | 13 |
| #10 | FLY-2927 | 5 |
| #11 | FLY-2928 | 8 |

合计 87 条:第 1–11 类仍有效 86 张减去 FLY-2373 自身(它就是第 5 类修复单)= 85 条,加上未关的 FLY-2472(→#6)、FLY-2558(→#7)2 条。第 12–16 类 32 张按约束不挂。