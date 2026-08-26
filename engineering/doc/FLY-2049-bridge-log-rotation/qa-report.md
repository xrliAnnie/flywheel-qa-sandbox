# FLY-2049 Bridge 日志轮转真运行 — 独立 QA 报告
Issue: FLY-2049 (https://linear.app/geoforge3d/issue/FLY-2049/infra日志-bridge-日志轮转未生效部署后-bridge-日志-94106mb-持续增长无任何轮转产物-查根因并让轮转真跑起来)
日期: 2026-08-25
基于: exploration.md / research.md / plan.md

> ## ⚠️ 本报告的判定已作废(2026-08-25 23:47 PT)
>
> 下面写的 **PASS 不再成立**。它是在补测失败面之前发出的。
> 之后的硬门专查实测到两条会把 Bridge 永久打死且无自愈的路径,Lead 已裁定 **FAIL 成立**,
> run 已走 operator rework 打回 implement(attempt 2,票 `rework:77188a36…`),ship 卡已在 thread 作废。
>
> **具体哪一段作废:** 只有「## 判定」的 PASS 和「### S5 失败面」整节。S5 原来把
> 「出错就写 marker 并 exit(1)」当成正确行为记为通过 —— 那正是缺陷本身。已按实测重写,见下方新的 S5。
> 其余各节(S1-S4 正向与阴性对照、S6 生产启动链、S7 迁移、S8 真 Discord、生产零污染、实测数字)未被推翻,仍可引用。
>
> **返工要求**(Lead 裁定):三点 fail-open + 四条 code review R1 MEDIUM 的处置落 PR body。
> 复验判据:两条注入(unsafe `.1` / 非目录 rotate lock)各 3 连启动必须全活,再加正向轮转与逐字节重建复核。

## 判定

**PASS**

被验版本: PR #955 `flywheel-FLY-2049`,远端 head `ff1219708`(代码字节即本 QA 所验;本地 `98c4b3ec7` 只多一条 progress.md 提交,无代码 delta)。PR 非 draft,mergeable。

## 验收对照(逐条)

| 验收要求 | 结论 | 证据 |
|---|---|---|
| 轮转真实发生:产物文件存在 | ✅ | 真 Bridge 上观测到 `.1` / `.2` 两代产物 |
| 主文件体积回落 | ✅ | 66,197 B → 190 B(真 Bridge,未重启) |
| Bridge 在线期间轮转不丢日志 | ✅ | 轮转前 active 全部字节是轮转后 `.1` 的前缀(逐字节 cmp) |
| 不断流(服务不中断) | ✅ | 轮转前后 PID 恒为 42490,`/health` 恒 200 |
| 正向证据(故意灌到阈值看触发) | ✅ | 见下 S2/S3;不接受"配置看起来对" |

## 我跑了什么

所有 harness 均由本 QA 独立编写(未复用实现者的测试),源码留在 `/tmp/fly2049-qa/`。

### S1 单元 / 集成
- `pnpm test:packages:run`:668 passed / 3 failed。**3 条红全部是 5s 超时**(`drift-scan`、`repository-baseline`),与本 PR 无关:同两文件 `--testTimeout=60000` 单跑 **31/31 全绿**。这两个文件是 git/fs 密集型,本机当时负载高。
- FLY-2049 专项:`rotating-stdio.test.ts` + `log-rotate.test.ts` = **18/18 绿**。
- Shell:`flywheel-log-rotate` 14/14、`packaged-seams` 17/17、`bridge-liveness-probe` 30/30、`r4-window`、`fly1663-bridge-launchd`、`supervisor` 全绿。
  - ⚠️ `r4-window` 首跑 EXIT=1,根因是 **本 runner 的 TMPDIR 长 89 字符** → tsx IPC unix socket 撞 `sun_path` 104 上限(`listen EINVAL`);`TMPDIR=/tmp/f2049t` 复跑 **EXIT=0**。环境坑,不是被测代码。

### S2 受控 producer(逐字节正确性)
用真编译产物 `packages/config/dist`,按 `run-bridge.ts` 的引导方式装适配器,写 5,000 行 × 206 B,cap=200,000、keep=3:

- 代际接缝逐行对齐,无空洞无重复:`.3` 头 `L0001907` → 尾 `L0002859`;`.2` `L0002860`→`L0003812`;`.1` `L0003813`→`L0004765`;active `L0004766`→ sentinel。
- 保留窗口 649,767 B **与期望输出的末尾逐字节相同**(`cmp` 通过);被丢弃的 400,260 B 正好是 keep=3 淘汰掉的第 4 代 —— 是保留策略,不是丢日志。
- 轮转后写的 sentinel 落在 **active**。
- producer PID 全程存活;`lsof` 显示它对 `bridge.log` 与 `.1` **零长期 FD**(fd 1/2 只指向独立的 raw capture)。

### S3 真 Bridge(529 隔离房 slot 2,零触碰生产)
从本 worktree 起真 Bridge(`[bridge-boot] running HEAD=98c4b3ec7…`),`FLYWHEEL_BRIDGE_LOG_PATH` 指向隔离路径:

1. 真 Bridge 的**全部**输出都进了轮转日志;`test-deploy` 自己的重定向文件 `slot-2/bridge.log` 停在 **0 字节** —— 说明没有输出从 fd 1/2 漏出去。
2. 把 active 灌到 66,197 B(> cap 65,536)后,Bridge 下一次自己写日志时**当场轮转**:`.1`=66,197 B,active 落回 190 B 且装着 Bridge 自己的新行。PID 42490 不变,`/health` 200。
3. 再灌一次:`.1`→`.2`、新 `.1`,代际正确轮换;**轮转前 active 的每一个字节都完整出现在新 `.1` 的开头**(前缀 cmp 通过)。
4. 附带发现(健壮性加分):我在 Bridge 在线时**外部 `rm` 掉了活动日志**,Bridge 下一次写入自动以 0600 重建该文件并继续服务。旧的长 FD 设计在这种情况下会永久写进已删除 inode。

### S4 阴性对照(证明我的检查器会变红)
- **对照 A**:不给 `FLYWHEEL_BRIDGE_LOG_PATH` → 适配器不安装(exit 9),**零轮转产物**。⇒ 轮转确实由被测适配器造成,不是环境。
- **对照 B**:复刻修复前的设计(长期 FD + 外部 rename)→ **主路径直接消失**,包括 sentinel 在内的后续字节全部落进 `.1`。我的「active 存在 + sentinel 在 active」检查**当场变红**。
  - 诚实说明:对照 B 的**行序连续性**仍然是绿的(字节没丢,只是位置错了)。所以连续性检查本身**不能**区分修复前后;真正有区分力的是 active 文件是否还在、sentinel 落在哪一代。

### S5 失败面 —— 🔴 这一节是 FAIL 的来源

第一版把下表读成了「fail-loud 正确」。换一个提问角度(不是「出错时报不报」,而是
「出错时 Bridge 还活不活得下去」)重测之后,结论反过来了:这两条是**永久崩溃循环**,没有自愈路径。

复测方法:按 launchd KeepAlive 的形状连起 **3 次**,跑真编译产物。

| 注入 | 前提 | 实测(3 连启动) | 结论 |
|---|---|---|---|
| **M1** `/tmp/flywheel-bridge.log.1` 预置为 symlink | active ≥ 1x(10 MiB) | start1/2/3 **全部 exit=1**,marker `log_generation_unsafe`,active 一字节未动 | 永久崩溃循环 |
| **M2** `.rotate.lock` 预置为**普通文件** | active ≥ 2x(20 MiB) | start1/2/3 **全部 exit=1**,marker `rotation_stalled` | 永久崩溃循环 |
| **M3** 同 M2,但把锁文件 mtime 改到 1 小时前(远超 5 分钟 stale 阈值) | 同上 | 仍 3/3 exit=1,**锁纹丝不动未被回收** | 无回收路径 |
| **M2b** 同 M2,但 active 还在 1x~2x 之间 | 潜伏期 | 进程存活(20s 超时未退),**无 marker、无告警**,日志继续无界增长 | 静默潜伏 |

**M3 是根因**:`acquireRotationLock` 的陈旧回收只认目录 —— `!lockStats.isDirectory() → return false`
(`packages/config/src/log-rotate.ts`)。锁路径若是普通文件或软链,**永远**进不了回收分支,与年龄无关。

**可达性**:`/private/tmp` 是 `drwxrwxrwt`(1777)。`.1` 与 `.rotate.lock` 这两个名字**当前都不存在**,
任何本地进程都能创建它们;sticky 位只挡删除/改名,不挡新建。M1 的抛错发生在任何轮转动作**之前**,
所以 Bridge 连"先把挡路的东西挪开"的机会都没有。

**时间线**(按本报告实测的生产增速 1.04 MiB/天):锁被占住后 Bridge 照常运行 —— 约 10 天到 1x、
约 20 天到 2x,然后**无预警地翻成永久起不来**。也就是先静默变胖 20 天,再一次性失去 Bridge。

**与今天的处境对照**:今天不轮转只是磁盘慢慢变大,Bridge 不会因日志而死;这一版引入了两条
今天不存在的「日志层直接打死 Bridge 且不自愈」的路径,而 Bridge 当天已因负载被杀过三次。

**给实现的公道话**:失败是**可诊断**的 —— marker 有界 688 B / 0600,带 message + stack,落在
`~/.flywheel/state/bridge-log-rotation-error.json`;wrapper 的 dirty-marker 告警正文与
bridge-liveness-probe 升级文案都已指向它。是「查得明原因但活不过来」,不是「死得不明不白」。

**建议的最小处置方向**(决定权不在 QA):让失败面「停轮转但不停 Bridge」——
unsafe generation 就把挡路路径改名让开(`.corrupt.<pid>.<ts>`)、非目录的陈旧锁也纳入回收、
`rotation_stalled` 改成「停轮转 + 持续告警」而不是 `process.exit(1)`。这三条都不动已验证的正向路径。

**另需落 PR body**:code review R1 的四条 MEDIUM 目前在 PR body、三份分支文档、PR review 里
**全部零命中**(reviews=0,comments=1 只有 Linear linkback),需要逐条给出「修掉」或「推迟 + 理由」。

### S6 生产启动链(真 wrapper)
用真 `scripts/flywheel-bridge-wrapper.sh`(隔离 FLYWHEEL_DIR / STATE_DIR / 端口 19899),打桩 `dist/run-bridge.js`:
- wrapper 正确导出三个路径变量并 `exec >` 到 raw capture;Node 运行时 `lsof -d 0,1,2` 显示 **fd 1/2 指向 `bridge-startup.log`,不再指向主日志**。
- Bridge 的 stdout **和** stderr 都落进轮转主日志。
- raw capture **每次启动截断**:预置 48,000 B 陈旧内容后重启,变成 80 B、陈旧行 0 条 ⇒ crash-loop 不会把它撑大。

### S7 迁移(今天的 106 MB 存量)
拿 111,149,056 B 的存量日志跑生产默认(10 MiB / keep=3):第一次写入就把它整体轮转成 `.1`,active 从 87 B 重新开始,旧字节完整保留。

### S8 真 Discord(本改动是 Discord-capable)
diff 改了两处**会渲染进 Discord 的文案**:`alert-kind-copy.ts` 的 `deploy_failed` body、`bridge-liveness-probe.sh` 的升级消息。按 529 房规矩用真 bot token 发进隔离测试频道并 **GET 回来**核对:
- deploy_failed body(真编译产物 `bodyFor()` 输出,286 字符)→ 消息 `1541952285087637604`,回读逐字一致。
- probe 升级文案(279 字符)→ 消息 `1541952286371221563`,回读逐字一致,中文标点与新路径无转义破坏,远低于 2000 字符上限。
- 频道:https://discord.com/channels/1485787271192907816/1493080993173737583

## 生产零污染
生产 Bridge PID 全程恒为 **71549**,uptime 连续,`/tmp/flywheel-bridge.log` **零轮转产物**(本 PR 未部署,符合预期)。QA 全程未触碰 :9876。

## 实测数字(供部署决策)
- 生产日志现值 **110,973,714 B(106 MiB)**,实测增速 **757 B / 60 s ≈ 1.04 MiB/天**(FLY-1995 修完洪水之后)。
- 按 10 MiB cap ⇒ 约 **10 天轮转一次**;keep=3 ⇒ 稳态磁盘上限约 **40 MiB**。

## honest boundary(没测到的部分)
1. **没有在生产上跑过**。本 PR 未部署,生产轮转要等正常班车窗口。风险:生产 launchd plist 传入的 fd 与 529 房的 `env … npx tsx` 不完全同形 —— 我用真 wrapper + 隔离端口补了这一段(S6),但那是打桩的 Bridge,不是真 Bridge 走真 launchd。剩余风险点是「真 launchd + 真 Bridge」这一个组合。建议部署后 24h 内核一次 `ls -l /tmp/flywheel-bridge.log*` 与 `~/.flywheel/state/bridge-startup.log` 体积。
2. **真 Bridge 的阈值跨越是我外部灌进去的**,不是 Bridge 自己写满的(自然写满需 ~2.4 小时)。轮转动作本身、代际轮换、Bridge 自己后续行的连续性都是真实观测;跨阈值这一步是人为加速的。
3. **106 MB 存量不会被立刻回收**:它变成 `.1`,按 10 天/次的轮转节奏要约 **30 天**才淘汰出 keep=3 窗口。这段时间磁盘上仍占 ~106 MB。不是缺陷,是留给运维的预期。
4. **两份 side log 未纳入本单**(`flywheel-cmux-watcher.log` 69 MiB、`flywheel-lead-…-infra-bot-lead.log` 16 MiB)。exploration §6 给了不复用的理由(Bash producer / TUI stdout 带协议语义),我同意该边界,但它们**仍在无界增长**,需要单独开单。
5. QA slot 2 的 teardown 首两次被 cmux mutator lease 挡住(watcher 持锁,与本 PR 无关),第 3 次重试成功;slot 已完全回收(`/tmp/flywheel-test-slot-2` 已删除、:19872 无响应)。

## 会过期的结论
| 结论 | as-of | 重核命令 |
|---|---|---|
| 生产日志 110,973,714 B、零轮转产物 | 2026-08-25 16:32 PT | `ls -l /tmp/flywheel-bridge.log*` |
| 增速 ≈ 1.04 MiB/天 | 2026-08-25 16:16 PT | 采两次 `stat -f%z` 求差 |
| PR #955 head `ff1219708`、非 draft、mergeable | 2026-08-25 16:33 PT | `gh pr view 955 --json headRefOid,isDraft,mergeable` |
| 生产 Bridge PID 71549 | 2026-08-25 16:32 PT | `lsof -ti:9876` |
