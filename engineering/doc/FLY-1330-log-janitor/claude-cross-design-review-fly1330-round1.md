# 独立交叉设计评审 — FLY-1330 plan.md (Round 1)

Date: 2026-08-18
Reviewer: independent Claude (cross-family stand-in,无先验上下文,逐条对照 codebase + 生产机只读实测)
Status: **CHANGES REQUESTED**

评审对象: `engineering/doc/FLY-1330-log-janitor/plan.md`(2026-08-18 版,219 行)

## Summary

计划整体形态正确:诚实重测量修正了 issue 的 22G 口径、复用 codex-log-guard 而非重造、搭 FLY-1830 converge 而非新建 reconcile、Claude 转录交内置清理——这些决策我逐一验证后都站得住。但有一个 BLOCKING(`flock` 二进制在生产 macOS 上不存在,而 plan 声称它是既有依赖;CI ubuntu 有 flock 会全绿,生产每晚必死——janitor 自己会变成新的「交付了没跑起来」)和四个 MAJOR:测量表漏掉了全机最大单一积攒源(`~/.flywheel/codex-homes` 29G,比本单全部清理目标还大)、releases 清理与 codex 自升级的并发不安全、lsof fail-closed 承诺在真实 lsof 退出码语义下无法兑现、防线 3 实际近乎不设防但被呈现为三大支柱之一。

## What's Good (keep)

以下各点我均已对照实物验证,应保留:

1. **诚实重测量**。§1 的数字我抽查全部吻合:`~/.codex/sessions` 5637 个 jsonl(plan 写 5635,一天漂移)、>30d 5086 个(plan 5084)、3.6G;`~/.claude/projects` >30d 恰好 13 个文件且**全部**在 `*/subagents/` 下(逐条核过路径);`~/.claude/settings.json` 确无 `cleanupPeriodDays` 键;`_cleanup-20260818-172132` 存在。对 founder 讲「能清的是 12-13G 不是 22G」是对的。
2. **codex-log-guard 复用成立**。`scripts/codex-log-guard.sh` 实有 `CODEX_LOG_DB` 覆盖(:43)、lsof 不可用时 fail-closed 假定 in-use(:82-96)、`monitor`/`remediate` 子命令(:184/:177)、写操作一律 `refuse_if_in_use`。「交付了没装上」的判断也实:`~/Library/Logs/flywheel/codex-log-guard.log` 生产上不存在。
3. **FLY-1830 converge 依赖成立**。`scripts/lib/converge-nonlead-daemons.sh` 确以「`~/Library/LaunchAgents/com.flywheel.*.plist` 且非 `com.flywheel.lead.*` 且未 disabled」为 roster,挂在 `restart-services.sh:2716`(deployed-sha 推进之后,部署波次末尾);`com.flywheel.log-janitor` 命名会落进 glob。§10 的结构断言测试也有真实先例(converge 测试 :405-:430 正是这个 grep-行号-顺序模式)。
4. **不自删 Claude 转录是对的,不是偷懒**。「claude 进程不持转录 fd → lsof 防线失效」这条理由链成立,且内置清理确在工作(>30d 只剩 subagents 孤儿)。自建第二个清理器与内置清理并存才是危险形态。
5. **不碰 Codex Lead home sessions 是对的**。mufasa 活 thread 的 rollout mtime 可陈旧(plan 实测 4 天)直接证明 age 判定对 Lead 记忆 thread 结构性不安全;<220M 收益完全不值。
6. **终态集合引用准确**。`ZOMBIE_IRREVERSIBLE_TERMINAL_STATUSES`(StateStore.ts:412-420)逐字 = completed/failed/terminated/blocked/rejected/deferred/shelved;`awaiting_review`/`approved_to_ship`/`approved`/`running` 被排除即被保护——保守方向正确。`~/.flywheel/teamlead.db` 默认路径与 config.ts:150 一致,且生产 `~/.flywheel/.env` 未设 `TEAMLEAD_DB_PATH` 覆盖(实测 key 不存在)。
7. **session.json 数据源真实**。`codexSessionStateDir` = `~/.flywheel/state/codex-sessions/<executionId>`(CodexTmuxAdapter.ts:190-198),`persistSessionState` 确写 `threadId` 字段(:1189),原子 rename 落盘(:1240)。rollout 文件名格式实测吻合 `rollout-<ISO-ts>-<uuid>.jsonl`,尾段 uuid 提取可行。
8. **plist / 安装 / CI 惯例全对齐**。现有 `com.flywheel.daily-digest.plist` 等就是 StartCalendarInterval + RunAtLoad false + 绝对 repo 路径 + PATH env 的形态;`ci-shell-suite-enumeration.test.sh` 确实强制新 suite 进 ci.yml literal 列表或 manual-only 清单;审计先例(`session-start-adopt-inflight.sh` 的 `clear_audit()`、`setup-quota-monitor.sh:294` 的轮转前置检查)都在所述位置。
9. **审计 schema、fail-closed 总则、白名单+排除清单双层、dry-run==apply 集合断言、symlink 逃逸负向测试**——测试策略覆盖了对的难例(符合「验收必须覆盖难的那些情况」)。
10. **被拒方案表**(§12)论证质量高,尤其 staged-trash 拒因引用了 Annie 的简单性定案,cron 拒因点出了只有 launchd 才被 converge 覆盖。

## Findings

### F1 [BLOCKING] `flock` 在生产 macOS 上不存在——janitor 会「CI 全绿、生产每晚必死」

**What/Why**: plan §3(:72)把 `flock` 列为「scripts/ 控制面既有依赖」,§5(:123)规定「`~/.flywheel/state/log-janitor/lock` flock 非阻塞,拿不到即退出」。实测:生产 Mac 上 `which flock` → **not found**(macOS 从不自带 util-linux flock)。仓库里所谓的「既有依赖」实为两种形态:`scripts/flywheel-config-lock.sh` 明确注释「flock via **python3 fcntl**」(正因为没有 flock 二进制),`flywheel-cmux-sync.sh:9147` 是 `elif command -v flock` 守卫的**fallback 分支**。照 plan 字面实现 `flock -n`,行为是:GitHub ubuntu runner 有 flock → 测试全绿;生产 04:15 launchd 触发 → command not found(127)→ 走「拿不到即退出」路径或直接崩——**janitor 永远不清任何东西**,且审计里若记成 `skip: lock-held` 还是错误归因。这正是 founder 捞回评论点名的「delivered but never installed」失效类,只是从"没装上"换成了"装上了永远不跑"。
**Fix**: 单实例锁改用仓库既有形态之一:(a) 复用 `scripts/flywheel-config-lock.sh`(python3 fcntl,短持有);或 (b) `mkdir` 原子锁(+ 陈旧锁按 pid 存活判定回收,防 crash 后永久自锁)。§10 测试加一条「PATH 中无 flock 时脚本仍能完成一轮」的负向断言(或结构断言脚本不含裸 `flock` 调用),否则 CI 会永久遮蔽这个平台差(同 MEMORY「macOS-vs-CI 平台差」条目)。

### F2 [MAJOR] 测量表漏掉全机最大单一积攒源:`~/.flywheel/codex-homes` 29G(443 个 per-runner home,125 个 >30d)

**What/Why**: §1 自称「现状实测」,但只读实测发现 `~/.flywheel/codex-homes` 有 **29G**——比本单全部清理目标(12-13G)加起来还大。这是 FLY-123 的 per-runner 隔离 CODEX_HOME(`codex-home.ts:242-258`,每个 runner execution 一个目录,含各自的 sessions/auth/config)。正常退休路径会 rmSync 整个 home(CodexTmuxAdapter.ts:1697 附近,FLY-123 P5),但 crash/kill 即孤儿:当前 443 个目录中 **125 个 mtime >30d**(>30d 的 home 不可能是活 runner),且我在 teamlead/scripts 里 grep 不到任何针对 codex-homes 的 prune/reap 机制——它在单调积攒。issue 硬边界「不碰 ~/.flywheel」可以尊重(本单不必去清它),但 plan 的 G1「稳态下磁盘不再单调积攒」在它未被点名的情况下**不成立**,§2 非目标清单细到 `xiaohongshu-mcp.log` 都点了名却没提这 29G——这是没看见,不是取舍。按「话对但没交代边界=被读成更大的断言」:founder 读完本 plan 会以为 FLY-1330 做完磁盘问题就收口了。
**Fix**: §1 表补一行 `~/.flywheel/codex-homes` 实测数字;§2 非目标显式声明「不碰(issue 边界),但它是当前最大孤儿积攒源,归属 X」——X = FLY-1329(session 收尾族,孤儿 home 本质是 runner 生命周期没走完)或新开 follow-up issue,由 Lead 裁;§9 给 founder 的首轮报告里如实带上这个数字。

### F3 [MAJOR] releases 清理与 codex 自升级并发不安全 + 「次新」语义歧义 + `install.lock` 未提

**What/Why**: 实测 `~/.codex-mufasa/packages/standalone/` 下有 `install.lock`(plan 全文未提),且 releases 从 6 月至今积到 17/20 个版本 ≈ 升级器**每周都在跑**,与每日 04:15 的 janitor 存在真实并发窗口。两个具体问题:(a) 升级器先把新版本下载进 `releases/<new>/` 再翻 `current` symlink——下载中途 janitor 扫描时,`sort -V` 的最新目录是**比 current 新的半成品**;§4.1 的保留规则「current + 按版本号排序的次新一个」字面上此时可解读为保 current + 保那个半成品、也可解读为把半成品排进删除集(「次新」到底是全序第二新,还是 current 之下最新?plan 没定义)。若删了它,轻则升级失败重下,重则升级器翻完 symlink 才发现目录残缺 → Lead 的 codex 二进制不可用 → Lead 下次重启起不来。(b) `install.lock` 的存在说明升级器有自己的互斥语义,janitor 对它零感知。
**Fix**: 规则改为**只删版本号严格小于 current 目标版本的目录**,并在这些「更老」目录里保留最新一个作回滚垫;比 current 新的目录**一律不碰**(留给升级器自己管理);再加一道 mtime <24h 的目录跳过(挡正在写入的下载);§4.1 显式点名 `install.lock` 不碰(它在 `packages/standalone/` 根,不在 `releases/*` 删除范围内,但要写进排除清单表明已考虑)。

### F4 [MAJOR] lsof「命令失败 vs 无匹配」在真实 lsof 上无法由退出码区分——fail-closed 承诺兑现不了

**What/Why**: §4.2 防线 2 承诺「lsof 命令本身失败(非"无匹配"的退出)→ 整个模块本 tick 跳过(fail-closed)」。但真实 lsof 的退出码语义是:**0 = 至少找到一个持有者;1 = 没找到任何持有者 或 发生错误**——两种情况同为 1,退出码上不可分。§10 的测试用「lsof seam 可 override 模拟命令失败」会绿,但那验证的是 seam 不是真实判定(「近似检查≠那个属性」)。现有 codex-log-guard 同样只处理了「lsof 二进制缺失」这一种可探测的失败(:85-88),其余 exit 1 一律当无持有者——plan 抄它的话就要如实降级承诺,不能写成能识别任意命令失败。另:候选 5000+ 文件的批量 `lsof -- <files>` 会撞 ARG_MAX,必须分块,而分块后「哪个文件被谁持有」要靠解析输出(`-F n`)而非退出码。
**Fix**: §4.2 把 fail-closed 判定写成可实现的具体规则,例如:lsof 缺失/不可执行 → 模块 skip;`exit > 1` → skip;`exit == 1` 且 stderr 非空 → skip;`exit == 1` 且 stderr 为空 → 视为无持有者;持有集合从 `-F n` 输出解析,输入用 xargs 分块。测试相应改为断言这套规则(含 stderr 注入的负向 case),而不是只测 seam。

### F5 [MAJOR] 防线 3(账本终态 join)对被扫树近乎不设防——应如实降级表述

**What/Why**: FLY-123 起,Flywheel runner 的 codex rollout 落在 per-runner home(`~/.flywheel/codex-homes/<exec>/sessions/`),**不在** `~/.codex/sessions`。实测交叉验证:`~/.flywheel/state/codex-sessions/` 下 416 个 ledger threadId,在 `~/.codex/sessions` 里能命中 rollout 的**只有 1 个**。即 §4.2 被扫的 5637 个文件里,防线 3 结构上预期保护 ≈0 个——`~/.codex/sessions` 的真实构成是 Annie 个人会话 + rescue 会话(plan 自己也承认这类"无账可查凭防线 1+2"),真正兜底的只有 mtime + lsof 两道。防线 3 保留无害(只多不少)且对未来形态有防御纵深价值,但把它并列为「三防线」支柱,会让 founder/reviewer 高估安全余量,也让 §10 断言组 4 的测试(fixture 里造 running execution 保护 rollout)测的是一个生产上几乎不发生的路径而自我感觉良好。
**Fix**: §4.2 加一句实话:「当前架构下 runner rollout 在 per-runner home,防线 3 对主 `~/.codex/sessions` 预期命中≈0(实测 416 中 1),保留作防御纵深;被扫树的实际保护 = 防线 1+2 + 30d 保守期」。这同时回答了「30d 对个人会话意味着什么」——个人 >30d 未动的 thread 会被清,这是保留期语义本身,应在 §8/§9 对 founder 讲明。

### F6 [MINOR] lsof 检查与 rm 之间的 TOCTOU:`codex resume` 恰好复活老 thread 的窗口

**What/Why**: 扫描期(候选收集+批量 lsof)与逐文件 rm 之间存在窗口:04:15 时若有人/agent 恰好 `codex resume` 一个 >30d 的 thread,lsof 时未打开、rm 时已是活会话——删的就是 issue 硬边界禁止碰的「活会话转录」。概率极低(每日一次 × 秒级窗口 × 恰好复活 30d 老 thread),但边界性质敏感。
**Fix**: 每文件 rm 前就地重查 mtime(resume 一旦写入即刷新 mtime,窗口收敛到毫秒级)——成本一次 stat;残余竞态在 §13 风险表如实记录一行,不装作为零。

### F7 [MINOR] 「主 home」在 env 注入下如何识别未定义

**What/Why**: §4.2 说 sessions 模块「仅主 `~/.codex`,硬编码排除 Lead home」,但 §8 的 `FLYWHEEL_JANITOR_CODEX_HOMES` 允许整表注入假目录、§10 测试也依赖注入。若 sessions 模块真硬编码 `$HOME/.codex`,测试就无法用假目录驱动它;若它从注入列表推断,「哪个是主」的规则(第一个?名字等于 `.codex`?)plan 没写。这是个会在实现时被随手填掉的歧义(「Confusion = stop」类)。
**Fix**: 明确约定,建议:列表第一项即 main home(sessions/archived_sessions 仅对它生效),其余项只参与 releases/generated_images;§10 fixture 按此构造。

### F8 [MINOR] executionId 在 teamlead.db 无行时的处置未显式

**What/Why**: §4.2 防线 3「execution 非终态或查询失败 → 保护」——但「session.json 存在、teamlead.db 打得开、查询成功返回零行」是第三种情况,字面上两边都不沾。保守方向应是保护(session.json 存在即说明这是 Flywheel 管理的 execution,账对不上更要停手)。
**Fix**: 补一句「查无此 execution_id 行 = 保护」,§10 断言组 4 加对应 fixture(session.json 有、db 无行)。

### F9 [MINOR] `find -type d -empty -delete` 会连 `sessions/` 根目录一起删

**What/Why**: §4.2 空目录随手清若写成 `find "$sessions" -type d -empty -delete`,当 sessions 整树清空时会把 `sessions/` 本身删掉。codex 大概率会重建,但无谓地制造一次「目录消失」的意外面。
**Fix**: 加 `-mindepth 1`。

### F10 [MINOR] `settings.json` 写点在删除白名单之外,且与 Claude Code 自身写有丢失更新竞态

**What/Why**: §5 白名单管的是删除,§4.5 动作 1 是对 `~/.claude/settings.json` 的**写**——janitor 唯一一个白名单四根之外的写点,plan 没把它标出来。且 Claude Code 自己会重写 settings.json(用户改配置时);jq tmp+mv 原子替换在并发下是 last-writer-wins,可能吞掉对方刚写的其他键。概率低(该写只在键缺失时发生一次),但值得写实。
**Fix**: §5 显式列出「settings.json 固化是唯一白名单外写点,一次性、已有键即不动」;实现上读-改-写间隔压到最小即可,不必上锁(写一次的事不值得)。

### F11 [MINOR] 「dry-run 先行」只靠人序保证,可选加结构闸

**What/Why**: §9 的顺序保证(先手动 dry-run → apply → 才装定时)依赖运维照做;没有任何机制阻止有人直接跑 install。issue 把 dry-run first 列为硬边界,靠纪律兑现硬边界与本仓「让它无从发生」的偏好有张力。
**Fix**(可选,简单性权衡后由 Lead 裁): `--apply` 在审计目录无任何历史 summary 时拒绝执行并提示先 dry-run(一个 if,不新增状态概念);或者接受现状但在 §13 风险表点名「该边界由 §9 人序而非机制保证」。

### F12 [NIT] launchd 睡眠语义可写得更准

**What/Why**: §3「漏掉的 tick 次日补上」——macOS 实际行为是:睡眠中错过的 StartCalendarInterval 在**唤醒时合并补发一次**(只有断电关机才真正顺延到次日)。所以不存在「永远不跑」的风险(结论安全),但补发可能落在白天负载时段,而非设想的 04:15 静默窗。鉴于全链 fail-closed(busy 即 skip)且生产机 24/7 常开,无实质影响。
**Fix**: §3 一句话写实即可(「睡眠错过 → 唤醒补发;关机错过 → 次日」),避免下一个读者按错误模型推理。

### F13 [NIT] plist 必须是真实文件而非 symlink(converge 会拒收)

**What/Why**: `converge-nonlead-daemons.sh:227` 显式拒绝 symlink plist。§6 说「生成 plist 到 LaunchAgents」,按现有 install 惯例是 cp/generate 没问题,但这是安装完整性通道的前置条件,值得钉住。
**Fix**: §10 结构断言组 8 加一条:install 脚本落盘方式为复制/生成(测试断言目标非 symlink)。

### F14 [NIT] codex-log-guard `remediate` 的失败面要在调用侧区分

**What/Why**: guard 的 `die` 对 db-busy、db-missing、no-logs-table 一律 exit 1 + stderr 文案。§4.4 审计要记 `skip: db-busy`,意味着 janitor 要解析 guard 的 stderr 或先自行探测——这个契约点 plan 没写,实现时容易变成「exit 非零一律记 busy」的错误归因。
**Fix**: §4.4 写明区分方式(建议 janitor 调 `status` 先读 `in_use=`/`db_exists=` 字段再决定跑不跑 remediate,审计 reason 取自 status 输出而非猜 stderr)。

## Verdict

**CHANGES REQUESTED** — 1 BLOCKING(F1 flock)+ 4 MAJOR(F2 codex-homes 29G 盲区、F3 releases 并发、F4 lsof 语义、F5 防线 3 诚实性)必须回改;MINOR/NIT 建议随手折入。计划的骨架(模块划分、复用决策、fail-closed 姿态、测试形态)是对的,以上问题全部可以在不改变总体设计的前提下修掉;修订后我预期可以 APPROVE。
