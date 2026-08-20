# 独立交叉设计评审 — FLY-1330 plan.md (Round 2)

Date: 2026-08-19
Reviewer: independent Claude (cross-family stand-in,同 R1 评审者,逐条复核 commit 5fbae6c90)
Status: **CHANGES REQUESTED**(仅剩小项残余,预期 R3 快速通过)

评审对象: `engineering/doc/FLY-1330-log-janitor/plan.md` @ 5fbae6c90(235 行)

## Summary

R1 的 14 条 findings 实质上全部被忠实折入:F2(codex-homes 29G 诚实边界)、F3(releases 并发规则)、F5-F9、F12-F14 的落法我逐条核过,与我建议的修法一致甚至更好(F2 的「不自扩权→上报建单」框架、F5 的「只挡删不放行」表述都是对的)。剩三个残余:**R-1** §5 已正确改为 mkdir 锁,但 §3 依赖清单、§3 mermaid、§13 三处仍留着 flock 旧文——同一文档里「flock 是既有依赖」与「生产 Mac 没有 flock」并存,恰好是 F1 判为 BLOCKING 的那句假话没删干净;**R-2** F4 的修法从「按退出码判定」过度矫正为「绝不按退出码判定」,丢掉了我建议规则的后半——exit>1(exec 失败/信号终止)时 stdout 为空,按「空输出=无持有者」会在主承重防线上开一条 fail-open 缝;**R-3** F11 的结构门装在 install 边,首个 `--apply`(最具破坏性的一次动作)仍无 dry-run 前置的机器约束。三处都是几行的编辑量。

## What's Good (keep)

逐条复核结果(对照 5fbae6c90 实文):

- **F1 主体已解决**:§5(:130)mkdir 原子锁 + 锁内 pid 文件 + `kill -0` stale 检测 + 清锁重试一次 + 审计 `skip: lock-held`,并正确引用了 `flywheel-config-lock.sh` 先例与 cmux-sync 的 `command -v` 守卫事实。方案本身我认可:mkdir 在同一文件系统上原子;PID 复用导致的假「活」只会多 skip 一天(fail-closed 方向);两个实例同时判 stale 竞争清锁,mkdir 原子性保证只有一个赢家。§10 断言组 3b(锁被持有→退出;stale→清锁重试成功)测的就是这两条难例。残余只是旧文未清,见 R-1。
- **F2 忠实且加分**:§1 表新增 codex-homes 行(29G/443/125,注明数据来源);§2 非目标显式条目引「授权内做不到→上报别自扩权」并点名 FLY-1759 族的终态语义依赖——归因准确(孤儿回收确实需要 runner 生命周期语义,不是按 age 能安全做的);G1 措辞收窄为「本单范围内的目录」且直言「不假装本单管全机」;§14 加 follow-up 行交 Tadashi 裁量。四处联动完整。
- **F3 规则表述无歧义**(专项确认):§4.1 的四条——严格老于 current 才是候选 / 新于 current 一律不碰 / 候选中保最新一个 / mtime<24h 不碰 / install.lock 不碰——把我担心的两个事故面都关死了:半成品新版本目录(新于 current → 不碰,且 mtime<24h 双保险)与「次新」歧义(候选定义先收窄到严格老于 current,「次新」只在候选内取,无歧义)。版本号等于 current 但非 current 目标的目录(如异构 arch)不满足「严格老于」→ 保留,fail-safe 方向正确。§10 fixture 行也补了「新于 current + mtime<24h 断言均不删」。
- **F4 测试要求足以防假绿**(专项确认,一处规格残余见 R-2):§10 断言组 3 要求 hold/release 两态**跑真实 lsof**(`tail -f` 持住→不删;kill→删),并点名「mock 只测 seam 会假绿」——这正是防 R1 所指假绿的正确形态;`command -v` 缺失用 PATH 注入空目录制造,合法(测的是 janitor 的处理,不是 lsof 本身);「exit 1 + 空输出 = 无持有者照常删」的两义性 case 也在。规格侧的 `-F n` 输出解析 + xargs 分批正确。
- **F5**:防线 3 降级为「保护性冗余,非承重柱」,附 416:1 实测,明确「只挡删不放行」「承重的是防线 1+2」。忠实。
- **F6**:rm 前 re-stat mtime 已入 §4.2(resume 即写入刷新 mtime,窗口收敛)。
- **F7**:§8 `FLYWHEEL_JANITOR_CODEX_HOMES` 显式「第一项 = main home」并标注作用域(§4.2 sessions 与 §4.3 archived_sessions 只作用于它)。
- **F8**:「session.json 存在但 db 无对应行 → 保护」入了防线 3 正文,§10 fixture 加了第三态断言。
- **F9**:`find <sessions-root> -mindepth 1 -type d -empty -delete`,防删根。
- **F10**:settings.json 固化挪到 install 脚本一次性执行(人工在场窗口,竞态窗口压到一次),已有键不动 + 原子写 + 回读校验 + 失败只警告不阻断。比我建议的「声明例外」更彻底——每日 tick 里干脆没有这个白名单外写点了。好。
- **F12**:§6 睡眠语义已校准(唤醒合并补跑;关机才顺延;两情形均无损)。
- **F13**:install 用 `cp` 真文件,引 `converge-nonlead-daemons.sh:227` 拒 symlink 的实锚;§10 断言组 8 加了「cp 非 ln -s」结构断言。
- **F14**:§4.4 明确 skip 原因不取 remediate 退出码(busy/missing/no-table 均 exit 1),先跑只读 `status` 解析输出入审计。
- **§15 评审记录**:轮次、verdict、findings 计数(1B+4M+6m+3N=14,与 R1 一致)、采纳情况、Codex 缺席原因(额度打满 + Tadashi 轮级裁定)都留了痕。归属链完整。

## Findings(残余)

### R-1 [MINOR,必须修] flock 旧文三处未清,与 §5 的 BLOCKING 修复自相矛盾

**What/Why**: §5(:130)已写明「不用 flock——生产 Mac 上没有这个命令」,但同一文档:
- §3 :74 仍是「依赖 jq / sqlite3 / lsof / **flock**——全部是 scripts/ 控制面既有依赖」——这句正是 R1 判 F1 为 BLOCKING 的那条假断言,原封未动;
- §3 mermaid :64 仍是 `L{flock 单实例锁}`;
- §13 :216 仍是「janitor 自身故障:flock 单实例」。

规范性小节(§5/§10-3b)是对的,但 §3 是实现者最先读的总览,依赖清单里那句「既有依赖」会把人重新引向 flock;§13 是 founder/运维读的风险表。一份 plan 内两个互斥事实并存,违反本仓「Confusion = stop」的前提——读者不该需要自行裁决哪句是真的。
**Fix**: 三处同步:§3 依赖清单 flock → 删(mkdir 锁零依赖);mermaid 节点改「mkdir 原子锁」;§13 改「mkdir 单实例锁」。纯文本编辑,零设计变更。

### R-2 [MINOR,必须修] 「绝不按退出码判定」过度矫正——exit>1 时空输出会 fail-open

**What/Why**: R1 F4 的问题是「exit 1 无法区分无匹配与出错」,建议的规则有四段:lsof 缺失→skip;**exit>1→skip**;exit==1 且有 err 迹象→skip;exit==1 且干净→信输出。R2 折入了第一段(`command -v` 前置)和输出解析,但把规则写成了「**绝不**按退出码判定」——丢了 exit>1 这段。后果:`command -v` 找到了 lsof 但 exec 失败(126/127,坏安装/权限)、或 lsof 被信号杀死(OOM)时,stdout 恰好为空,按「空输出=无持有者」→ **删掉可能被持有的文件**。这条缝恰好落在唯一危险的场景上:park-alive 的 codex 进程持着一个 30 天没写过的 rollout fd——mtime 防线(>30d 成立)、re-stat 防线(没在写,mtime 不会刷新)都拦不住它,lsof 是**唯一**挡它的防线(防线 3 已如实承认近乎不设防)。主承重防线不能有静默失败模式。另外实现时还有一层:候选经 `xargs` 喂 lsof,xargs 会把子命令退出码改写(部分批次非零→123;无法执行→126/127),「哪些码可信任输出」的规则不写清,实现者必然自己猜。
**Fix**: §4.2 防线 2 把「绝不按退出码判定」精确化为:「持有集合只从 `-F n` 输出解析,**但仅在 xargs/lsof 退出码 ∈ {0, 1, 123} 时信任该输出**(1/123 = 存在无匹配批次,正常);126/127/信号终止等其余退出 → 整个模块本 tick 跳过(fail-closed)」。§10 断言组 3 加一条:fake lsof(exit 127 / 被 kill)+ 空输出 → 断言模块 skip(这条允许用 seam/PATH 注入——测的是 janitor 对失败码的处置,真实 lsof 无法按需产出这些失败)。

### R-3 [MINOR,建议修] F11 结构门护的是 install 边,首个 `--apply` 仍无 dry-run 机器约束

**What/Why**: §6 的门是「无 `first-apply-ok` marker → install 拒装」——它保证的是「定时器不会先于一次成功的人工 apply 存在」。但整个特性里破坏性最大的单次动作是**首轮 `--apply`(一次性真删 12-13G)**,而它前面「必须先 dry-run 过目」这条边仍然只靠 §9 的人工顺序。F11 的原意正是把这条边变成机器约束;现在的落点只覆盖了链条的后半。§6 的措辞「把『先试跑过目再装定时』从人工纪律变成机器约束」按字面成立,但 issue 硬边界写的是「dry-run mode first」,最该被机器保证的是 dry-run→apply 这一跳。
**Fix**(同款机制顺手补齐,一个 if):`--apply` 在审计文件中不存在任何 `mode: dry-run` 的 summary 行时拒绝执行并提示先 dry-run(`--force` 同款逃生口,应急场景如审计目录被清);§10 断言组补一条。若 Lead 权衡后决定接受人序,则至少在 §9/§13 显式写明「首个 apply 的 dry-run 前置由人序保证,非机器约束」,不能让 §6 的表述被读成全链机器化。

### NITs(不阻塞,随手改)

- **N-1** §0 TL;DR 要点 1 仍是「保 current + 次新一个,其余删」——未反映 §4.1 新规(新于 current 不碰);TL;DR 是 founder 最可能只读的部分。
- **N-2** §3 :76 「漏掉的 tick 次日补上」与 §6 已校准的睡眠语义(唤醒合并补跑)不一致,统一为后者。
- **N-3** §10 断言组 5 文字(「current 目标与次新保留、其余删」)未同步 §4.1 新规——fixture 行已覆盖新 case,把断言组文字对齐即可。
- **N-4** mkdir 锁的 mkdir 与 pid 文件写入之间存在窗口:stale 检测读不到 pid 文件时应视为「无法证明 stale → 按 lock-held 退出」(fail-closed),plan 未写这半句。
- **N-5** F6 修法的后半句(「残余毫秒级竞态在 §13 如实记录」)未落——§13 风险表可加一行 TOCTOU 残余窗口的如实声明。
- **N-6** §8 `FLYWHEEL_JANITOR_KEEP_RELEASES` 的说明文字(「current + 次新,共保留 N 个版本」)与 §4.1 新规的语义(current + 严格老于中最新的 N-1 个)对齐一下,防止调参时按旧语义理解。

## Verdict

**CHANGES REQUESTED** — 仅小项残余:R-1(flock 旧文三处,与 BLOCKING 修复自相矛盾)与 R-2(lsof 退出码规则丢了 exit>1 段,主承重防线留了 fail-open 缝)必须修;R-3 建议补齐或显式声明;N-1~N-6 随手。全部是行级编辑,零设计变更;修订后可直接 APPROVE,无需再跑新的验证。
