# FLY-2045 CLAUDE.md 里程碑表顶部插入 = 并行 PR 100% 互斥 — 实施计划

Issue: FLY-2045 (https://linear.app/geoforge3d/issue/FLY-2045/repo流程-claudemd-里程碑表顶部插入-并行-pr-100percent-互斥每合一单全舰-dirty分支失去-ci-能力8-25)
日期: 2026-08-25
基于: research.md

> **本文件是唯一执行权威。** `exploration.md` / `research.md` 是上游过程稿,被后续实测推翻的结论都在各自顶部 banner 标注;与本文冲突时以本文为准。
>
> **修订记录**
> - **v19(本稿)**:§7.2(4) 与 §10 回跳规则改口径 —— `origin/main` 前进后做 **merge-tree 等价复验**,
>   **真 PR 台架(§6)只在机制变更时重跑**。Tadashi 2026-08-25 裁定,起因是交卷窗口里 main 又前进了一次
>   而本单实现面零机制改动;边界与代价见 §7.2(4) 的 v19 方框与 `acceptance-evidence.md` 附录 A.4。
> - **v17**:R16 换成**纯计划级**评审(不再对三个脚本做对抗探测),立刻抓出三个前 15 轮没碰到的**计划自相矛盾**。
>   ① **milestone 的 owner 冲突**:D4 让 executor 在 PR 最后 commit 建 per-issue 文件,而 orchestrator A0 又要求
>   「目标不存在 → 创建」—— 于是**executor 做对了,A0 必然失败**;D13 让这个矛盾在本单自己身上就能看到。
>   A0 改为**幂等 ensure**并区分 base 与 branch(§4.1(1))。
>   ② **§6 台架没有绑定被交付的实现**:原文只说"记录 base SHA",于是从 stale commit、`origin/main`、
>   甚至手搭的最小目录起台架,都能产出形式完整的 D14 —— 证明不了交付 PR 里的实现被真 PR 验过。
>   现在把 `fly2045-accept-base` 的 parent **密码学绑定**到 `implementation_sha`,并写明失效条件(§6.1)。
>   ③ **§7.2 的 hard gate 时间上不可执行**:一边要求 ship 前"零未处置",一边允许 `post-B-migrate`,
>   而后者的合格证据**只能在 B 落地之后**产生。已改为**两阶段 cutover**,并把 inventory / land-before
>   移到 final D9 与真 PR 验收**之前**(§10 重排)。
>   ④ **MEDIUM(采纳):验证装置已经明显大于它保护的迁移**。前 15 轮不断在 meta-harness 自身找洞,
>   正说明它变成了主要 blast radius。按 R16 的建议**裁掉重复证明同一谓词的那一层**,保留全部承重检查(§5.5)。
>   ⑤ LOW:D10 补 `ci-shell-suite-manual-only.txt`、D14 补 disposition ledger;§12 记录一条**既有 baseline red**。
> - v16:R15 的 Codex 回合因内容过滤中断,但它在中断前点出的三条完整性缺口都是真的,已全部收口并各自留了验证:
>   ① `grep -c .` **不数空行**,所以往 failure 通道插一条**空记录**仍能满足 `raw == parsed`。改用 `wc -l`。
>   直接对照:1 条合法记录 + 1 条空记录 → `wc -l`=2、`grep -c .`=1、strict parse=1 ⇒ 旧写法 raw(1)==parsed(1) 看着干净,新写法 raw(2)≠parsed(1) 判 harness error。
>   ② controls **没有把 `failures` 计数与通道记录数对账** —— 未来某个分支直接 `failures=$((failures+1))` 绕过
>   `record_failure()`,只要同一轮还有别的正常记录,empty-channel 检查就抓不到。现在收尾处强制两者相等。
>   实测:注入一次直接自增 → `counter says 1 failure(s) but the channel holds 0` 并非零退出。
>   ③ 新加的 malformed self-control **自己重算 raw/parsed**,等于测了生产检查的一个**副本** ——
>   删掉生产分支它照样过。改为经 `classify_mutant` 驱动(新增 `controls:` 前缀的 edit,可变异 controls 副本)。
>   实测:把生产的 `raw != parsed` 分支改成 `if false` → self-control 立刻失败。
>   **通则**:控制必须驱动**被测的那一份实现**,不能驱动它的复制品。
>   现状:probe OK、controls **37/37**、mutants **11/11**。
> - v15:吸收 Codex design review R14 的 1 HIGH + 2 LOW(**连续四轮无 blocker**)。
>   ① **failure identity 也必须走自己的通道**(与 R13 的 metric 同类,只是换了一条链):mutant 判定仍从
>   人类 `FAIL:` 文案里截 id,而那条宽松正则会把 `FAIL: !!! …` 抽成空串、在 command substitution 里消失。
>   Codex 往一次**本来通过**的运行里插一条畸形记录,controls 报 37/37、整个 mutant suite 报 10/10。
>   现在 controls 经**唯一的 `record_failure()`** 把 id 写进调用方自有的 `--fail-file`;mutant harness
>   只读该通道、用**严格整行文法**解析,并断言 **raw 记录数 == 解析出的 id 数**(不能解析 = harness error,
>   不是静默丢弃),红了却零记录同样是 harness error;expected id 也过同一个 validator。
>   **baseline 从"rc=0"加严为"rc=0 **且** failure 通道为空"** —— 这才是真正抓住该反例的那一条
>   (现在 abort 并打印那行畸形记录)。另加**第二条 self-control** 端到端证明这条接线。
>   ② LOW:metric path 合同收窄 —— 空参数 / 与 `--source-file` **同路径**(会把探针自己的输入覆盖成 29 字节
>   记录却仍 exit 0)/ 目标是目录,全部具名 FATAL;写失败也 FATAL 而不是静默。并写明这里是
>   **destructive output**(truncate、跟随 symlink),不隐含相反语义。
>   ③ LOW:铁律 3 标题、§11 的 controls 条数与 comparator 描述一并对齐。
>   现状:probe OK、controls **37/37**、mutants **11/11**(6 谓词 + 3 metric 协议 + 2 self-control)。
> - v14:吸收 Codex design review R13 的 1 HIGH + 2 LOW(**连续三轮无 blocker**)。
>   ① **整行锚只约束行的"形状",不证明它的"出处"**:probe 会原样回显调用方给的 source path,
>   于是把目录名做成含**内嵌换行**再加一整行伪造记录,stdout 上就出现了一条**逐字节完美**的假 metric ——
>   一个**已经删掉真记录**的 probe 照样通过全部计数控制(36/36)。根治:machine record 改写到
>   **调用方自己提供的文件**(`--metric-file`),消费者只读该通道;human log 仍留一份副本但**不再权威**,
>   且不可信路径在回显前做**单行编码**。新增 `newline-injection-path` 控制。复现原攻击:现在 **9 条控制具名失败**。
>   顺带:provenance 分离后 metric printf 变成两处,**pin 住的 site 数量当场抓到**
>   (`MUTATION SITE COUNT 2, expected 1`),两个 metric mutant 已改指权威通道。
>   ② LOW:`sets_equal` **从来不是** set comparator(`a\nb` vs `b\na` 判不等),改名
>   `canonical_lists_equal` 并写明前置条件(调用方须先 sort -u + 校验 id);自检补齐顺序 / 重复 /
>   空对空 / id 合法性;任何**不能解析成裸 control id** 的 `FAIL:` 行改判 harness error,不再静默丢弃。
>   ③ LOW:§5.4.3(1) 不再写"每个 fixture 只违反一个谓词"(与 `drop-status-cell` 的 8 项集合矛盾);
>   mutant 汇总行也不再把 metric 协议 mutant 和 self-control 一律叫作 predicate branch。
>   现状:probe OK、controls **37/37**、mutants **10/10**。
> - v13:吸收 Codex design review R12 的 2 HIGH + 2 LOW(**连续两轮无 blocker**)。
>   ① **`expect_count` 从自由文本取数,source path 能冒充 metric**:probe 会先打印 `source: <path>`,
>   于是把 `TMPDIR` 设成名为 `(151 data rows spoof)` 的目录,一个**故意 +1** 的 probe 仍报 35/35。
>   现在 probe 输出**专用整行机读记录** `FLY2045_METRIC data_rows=N`,`expect_count` 精确锚定该格式并断言**恰好一行**;
>   新增 `spoof-path` 控制(用那个目录名跑合法 fixture),并给 metric 加**三个分支 mutant**(计数偏移 / 记录重复 / 记录缺失)。
>   复现原攻击:被破坏的 probe 现在**具名失败 8 条控制**。
>   ② **mutant self-control 只做子串匹配**:把 edit 参数换成字面量 `failure set mismatch`,生成器返回 `unknown edit` →
>   HARNESS ERROR,而外层仍打印「correctly rejected」和 7/7。现在 `classify_mutant` 返回**结构化 rc**
>   (0=集合精确相等 / 1=真实集合不符 / 2=harness error),self-control **必须看到 rc=1**,并显式拒绝 HARNESS ERROR / FATAL。
>   更根本的一步:把集合比较抽成**纯函数**,在任何 mutant 之前用「相等 / 缺项 / 多项 / 空集」四组输入**直接证明**,
>   坏了就 abort;端到端 sabotage 只负责证明接线。复现原攻击:现在是 HARNESS ERROR。
>   ③ LOW:「每个 fixture 只违反一个谓词」按真实模型**收窄**(见 §5.0 铁律 3);示例常量、§10/§12 的计数、
>   §11 枚举、脚本注释里 ordinary rogue heading 的旧说法一并对齐。
>   现状:probe OK、controls **36/36**(~10s)、mutants **10/10**(6 谓词 + 3 metric 协议 + 1 self-control,~118s)。
> - v12:吸收 Codex design review R11 的 3 HIGH + 1 LOW(**本轮无 blocker**;反斜杠 parity 与 separator regex 经定向攻击未发现绕过)。
>   ① **两份 awk classifier 会漂移,而全套测试假绿**:只把**第二份**(算 `data_rows` 的那份)的 status regex 改成不接受带 variation selector 的 `⚠️`,真实第 146 行就从计数里消失(177→176),而 probe/controls/mutants **全部照常报成功** —— 因为 `data_rows` 只断言 `>100`。现改为**一次 awk 调用、一个 `canonical()`**,一趟输出 `bad_count/first_bad/data_count`;新增 `expect_count`(断言**精确**行数)与**每个 marker 一条正向 fixture**(`✅`/`⏳`/`⛔`/`⚠`/`⚠️`/`↪` + 短正文 `✅ x`)。
>   ② **mutant harness 接受「预期 control + 无关 control」一起失败**:让 `drop-token-boundary` 同时删掉 status boundary,实际失败 5 个控制,suite 仍记 ok —— 正是铁律 3 说的 harness error。现改为**expected failure set 相等比较**(缺项/多项/空集全失败),每个 replacement **site 数量也 pin**(防「本该改两处只改到一处」),并给 harness 自己加了**负向控制**(故意两分支同时破坏 → 必须被拒)。
>   ③ **`substr(status, 4)` 是未被证明的冗余分支且不可移植**:trim 之后 marker-only 本就过不了 regex,该分支删掉后控制仍 28/28;固定 offset 还把正确性绑到 awk 按 byte 还是 character 计数(而 `⚠️` 比其它 marker 多一个 variation selector)。已删除,整条 grammar 收成**一个** predicate:`^(✅|⏳|⛔|⚠️|⚠|↪)[[:space:]]+[^[:space:]]`。
>   ④ LOW:§5.0 的「这两条」、示例常量、§11 的控制枚举、脚本里「至少三个 pipe」等旧描述一并对齐。
>   现状:probe OK、controls **35/35**(~10s)、mutants **7/7**(6 分支 + 1 self-control,~86s;它每个 mutant 都跑一遍完整控制套件)。
> - v11:吸收 Codex design review R10 的 2 BLOCKER + 2 HIGH + 1 LOW。
>   ① **删掉 backtick 状态机**(blocker):它既不是 GFM 规则也不是正确的 code-span scanner —— 按 GFM,inline-code 里**未转义**的 pipe 仍是 delimiter;而逐字符 parity toggle 会把「正文含一个未配对反引号」和 ``` ``a ` b`` ``` 这类**合法行 false RED**,判定还随反引号**个数**翻转。现在 **delimiter 只认未转义的 `\|`**,不对反引号建状态。实测 177/177 仍接受、两个合法反引号形态接受、7 条含多余 raw pipe 的历史行逐字节接受。合同正名为 **legacy-aware source-row classifier,不是 Markdown renderer**。
>   ② **status 只有 prefix、没有边界**(blocker):`\| … \| ✅NOT-A-STATUS \|`、`\| … \| ✅<!-- fake status --> \|`、`\| … \| ✅ \|` 全部 exit 0 —— 与 v8 的 `FLY-1NOT` token collision 是同一类缺失,只是右移了一个 cell。现收紧为 **完整 marker + 空白 + 非空正文**(实测 177/177 满足)。同时**收窄声明**:这证明的是「符合冻结账本的 status grammar」,**不是**能证明人的意图 —— `✅ KEEP THIS LIVE` 对任何机器都与状态文本不可区分。
>   ③ **铁律 3 还没兑现**(HIGH):删掉 escape 分支后控制仍 23/23、mutant 仍 4/4 —— 因为 escaped-pipe fixture 也会被 status 分支拒掉。隔离 fixture 换成 `\| FLY-7777: … mentions \\\| ⏳ fake status \|`(带 escape 处理→拒;删掉→接受,双向实测),并新增 `drop-escape` mutant。
>   ④ **mutant harness 把「mutant 自己坏了」算成 kill**(HIGH):只要生成器额外弄坏语法,坏 probe 让所有控制变红,suite 照记 ok —— 同一个 false pass 从 baseline 移到了 generated mutant。现在每个 mutant 必须逐项证明:变异确实生效 → 变异后的 probe **能解析** → 控制以**预期的那个 control id** 失败;FATAL / 工具错 / 无关控制一律判 harness error。已用 R10 的原始破坏手法复现,现在是 HARNESS ERROR。
>   ⑤ LOW:§5.0 标题改「三条铁律」、脚本注释里的「至少三个 pipe」「四个谓词」、控制套件的「全称 negative」、§11 的控制枚举一并对齐。
>   现状:probe OK、controls **28/28**(25 负向 + 3 正向)、mutants **6/6**。
> - v10:吸收 Codex design review R9 的 1 BLOCKER + 1 HIGH + 1 LOW。
>   ① **数 `\|` 字符不等于数 Markdown cell**(blocker,真实反例):`\| FLY-7777: … mentions \\\| but has no status cell \|` 有 3 个 raw pipe 却只有**一个** cell,`` `a \| b` `` 的 inline-code 变体同理,两者都被吞且 exit 0。已换成**有界 delimiter scanner**(识别转义与 inline-code)+ **terminal status cell 合同**。先验证前提再采纳:实测 177 条 status cell **全部**以 `✅`/`⏳`/`⛔`/`⚠`/`↪` 开头(95/78/2/1/1),scanner 接受 **177/177**(含正文里真的含 `\\\|` 的第 117 行),并拒绝全部反例(含藏在 code span 里的假 status)。
>   ② **控制在为错误的原因变红**(HIGH):R9 用 probe mutant 证明删掉 token-boundary 或 column-0 分支后控制仍 18/18 全绿。我复现并发现**第二个**原因 —— 我的 filler 行是 `\| … \| done \|`,本身就不满足 status 合同,于是控制其实红在 filler 上。**是我自己加的正向控制**(合法行必须保持 GREEN)把它抓出来的。现在每个 fixture 只违反**一个**谓词;新增 `cutover-merge-probe-mutants.sh`(删一个分支 → 控制必须察觉)。
>   ③ mutant suite 立刻抓出「至少两个 cell」这条分支**删掉也没人察觉** —— 实测带/不带该分支对 177 行与全部反例判定完全相同 ⇒ **冗余,已删除**。不可被隔离证明的分支只会虚增守卫规模。
>   ④ mutant suite 自己也需要控制:它曾在 probe 有**语法错误**时报 4/4(坏 probe 让所有 mutant 都红)。现在先证明未变异的 probe 能解析且其控制通过,否则拒绝报告 —— 双向实测过。
>   ⑤ LOW:D9 控制条数与两处注释、示例常量一并对齐。
>   (v10 当时的状态:controls 23/23、mutants 4/4;v11 已升级到 28/28 与 6/6。)
> - v9:吸收 Codex design review R8 的 1 BLOCKER + 1 HIGH + 1 LOW。
>   ① **canonical-row 谓词仍太松**(blocker,五个真实反例):v8 只断言"可选缩进 + `\|` + `FLY-`/`GEO-`/`v` + **一个**数字",于是 `\| FLY-1NOT-A-MILESTONE LIVE RULE \|`、`\| v1THIS-IS-NOT-A-VERSION …\|`、缩进的 `GEO-7NOT-…`、只有一个 cell 的 `\| FLY-7777: … \|`、以及 `\| FLY-7777NOT-A-MILESTONE \| preserve \|` 全部被吞(块尾 224→225,仍 exit 0)。已收紧为**三层**谓词(见 §5.1(6));**刻意不用"数字后必须紧跟冒号"** —— 实测 170 条 FLY/GEO 行里有 **41 条**不是 immediate-colon 形态(合并 ID / 版本注记 / track·inc 标记),那样会对真实数据 false RED。新谓词实测 **177/177 接受、10 个反例全拒**;probe 控制 14→**18**,D9 控制 14→**18**。
>   ② mutation schema 改实(HIGH):`#17`(块尾多加空行)同时改变 byte count 与 sha256,一个**正确且非 fail-fast** 的守卫本就该同时命中 `G3-byte-pin` 与 `G3-hash-pin`;硬要求"只见 byte"等于**强迫实现者把 byte 检查排在 hash 前并提前返回**,恰恰违反 §5.4.2 自己的通则。现改为 **37 singleton + `#16` regression(无 singleton target) + `#17` expected set `{G3-hash-pin, G3-byte-pin}`**,并撤回"39 行 target 全是单 literal"这句字面假声明。§11 的独立 byte 证据引 `#15`。
>   ③ LOW:D9 控制条数在两处仍写 11、上游 banner 仍写 v7、两个脚本注释仍说普通 rogue heading 会 truncate —— 一并清掉。
> - v8:吸收 Codex design review R7 的 1 BLOCKER + 1 HIGH。
>   ① **shape closure 太松**(blocker,五个真实反例):"以 `\|` 开头"不等于"是里程碑表" —— `\| CRITICAL ACTIVE RULE: preserve this \|` 与一整张无关三行表都被吞进去(块尾 224→225/227,仍 exit 0),`\|\|\|\|`/`\| \|`/`\|::\|` 也都冒充成了分隔行。已收紧为:分隔行必须匹配严格两列语法,分隔行之后每个非空行必须是 **canonical 里程碑行**。实测 177 行**全部**以 `FLY-<n>`/`GEO-<n>`/`v[0-9]` 开头、分隔行也满足严格语法,收紧零代价。五个反例现在全部具名 exit 2;probe 控制 **14/14**,D9 控制补到 **14 条**。
>   ② mutation 表的三个声明**都不成立**,已改实:机械计数是 **39 条**(不是 37/40);target 列**逐行换成 literal sub-ID**(不再有 `G2①`/`G3` 这类组级占位符,也不再需要"按语义对应"这一步,harness 直接从表里读 `(#, literal)` 并 pin 条数与身份);删除冗余的 `G1-dir`(README/ARCHIVE 的存在性已蕴含目录存在);`#16` 的独立性声明按 §5.4.2 统一收窄,§11 改引 `#17`。
> - v7:吸收 Codex design review R6 的 1 BLOCKER + 2 HIGH + 1 LOW。
>   ① **over-capture**(blocker,可复现):边界 preflight 只防"少抽"不防"多抽" —— 在表与 Doc heading 之间放一行普通规则,块尾会延伸把它吞进去,于是 B 把一条**活的 CLAUDE.md 规则**一起删掉,而双 pin 和 `cmp` 反而给这次删除盖章。R6 手工构造后 probe 报 `39..226 / 0 rows outside` 并 exit 0。已加 **table-shape closure**(§5.1 第 6 条):表头下一行必须是分隔行,且区间内**每个非空行都必须是 `\|` 开头的表行**。实测当前块 = 179 表行 + 7 空行 + **0 条其它非空行**,所以收紧零代价。修后:R6 的原始 fixture 具名 exit 2,控制 **11/11**,真跑仍 OK。
>   ② D9 自己的结构控制补到 **11 条**(加 `doc-before-header` 与 over-capture),并像 probe suite 一样把**条数**钉死。
>   ③ sub-ID **给出完整 literal 目录**(§5.4.1),37 行 target 列全部换成 literal;G2 residue 正则补 **unindented GEO** 与 **indented FLY** 两个形态;**撤回**"trailing LF 是一条独立子断言"的说法 —— 删块尾 LF 会先让 END 哨兵接到最后一行,首先是 sentinel 结构失败,不是隔离的 byte-pin 证明(诚实收窄,见 §5.4.2)。
>   ④ 清掉 v6 残留:§5.2 抬头仍说只打印 `G1…G6`、G4 断言表漏 repo predicate、多处仍写普通 rogue heading 会 "truncate"(实际是 over-capture)。
> - v6:吸收 Codex design review R5 的 1 BLOCKER + 2 HIGH + 2 MEDIUM。
>   ① **probe 的 "exact heading" 其实不 exact** —— `grep -F` 无 `-x`,`## Doc Structure & Lifecycle (renamed)` 被当成合法边界,R5 手工构造后脚本仍 `PROBE OK` exit 0。我复现确认,已改 `grep -cFx/-nFx`,加 `decorated-doc-heading` 控制,并把控制脚本的**条数本身**变成 fail-closed(`EXPECTED_CONTROLS=9`,原先打印 `$pass_n/$pass_n`,删一条控制会以 `8/8` 假绿)。修后:复现例 exit 2、控制 9/9、真跑仍 OK。
>   ② 守卫改用**稳定 sub-ID**,harness 断言"命中目标 sub-ID 且同组其它 sub-ID 不出现"—— 否则 #22(END 在 BEGIN 前)可能只是因为抽出空块导致 hash mismatch 而红,顺序分支根本没实现(§5.4)。
>   ③ 补两条 mutation:指针移到 `## Current Phase` **之前**、orchestrator 的 **repo predicate**(按 repo 判 Flywheel 而不是按 `FLY-` 前缀)。共 **37 条**。
>   ④ 修掉 §11 里 v5 重编号后残留的旧 mutation 号、§10/§12 里"按实测决定 D12"的旧措辞;**指针文字给出 authoritative literal**,不再让实现者临场发明被 exact-count 的句子。
>   ⑤ §7.2 ledger 补 `land-before-B` 的闭环证据与 `unrelated CLAUDE edit` 的 rebase 处置。
> - v5:吸收 Codex design review R4 的 2 BLOCKER + 2 HIGH + 2 MEDIUM。实质改动:
>   ① **probe 在 B 落地后跑不起来**(它读工作树 CLAUDE.md,而 D3 把表删了)—— 已加 `--source-sha` / `--source-file` seam,并把 8 条负向控制做成**可复跑的脚本**而不是计划里的一句"实测过";
>   ② **边界锚不稳**:「其后第一个 `## `」在 `## Doc Structure & Lifecycle` 被删时会滑到 `## Key Architecture Decisions` —— G2/D9 一律绑 **exact 唯一 heading** 并加"表内混进 rogue `##`"的完整性断言;
>   ③ mutation 仍有半实现能全绿的缺口 —— 按子断言重排为 **35 条**(missing-BEGIN / missing-END 分开、trailing-LF 精确化、orchestrator 的 target-exists 与 cached-commit 各一条、`ARCHIVE-*.md` 通配绕过);
>   ④ **D12 改为无条件删除三个 `fly1674` exemption**(不是改指 ARCHIVE);
>   ⑤ §7.2 补 disposition ledger 与"rebase 时怎么解那个冲突"的具体解法。
>   实施中自己撞到并修掉的一个真 bug:probe 的完整性断言里 `\|` 在 awk ERE 会退化成 alternation,让 `^[[:space:]]*` 单独成一支从而匹配每一行(报出 441−186=255 行"在块外")—— 改用 `[|]`。**这个 bug 是被我自己那条 fail-closed 断言抓住的**,不是靠肉眼。
> - v4:① **裁定从 A 改为 B**(Tadashi 2026-08-25 07:05,晚于 06:58 的 A 裁定,明确「选 B,按 plan.md §3 的 B 路线走」)—— 全文按 B 重写(§3);② 吸收 Codex design review R3 的 2 BLOCKER + 2 HIGH + 1 MEDIUM + 1 LOW:cutover 事件级 fence(§7.2)、mutation 覆盖面补齐(§5.4)、probe 改 fail-closed 且动态定界(已落地)、D9 的 authority 本身 fail-closed(§5.1)、探针 PR 清理措辞(§6)、exact-run 字段断言(§6.1)。
> - v3:吸收 Codex R2(临时 base 无 CI / pin 循环自证 / orchestrator staging+GEO+VERSION / cutover 形态 / G2 漏 legacy v 行 / mutation 计数矛盾)。
> - v2:吸收 Codex R1(路径、写入面、真 PR 硬门、portable sha256、fail-closed 守卫、A/B 不默认)。

---

## 0. 一句话

把 `CLAUDE.md` 的里程碑表**整块搬出并从 CLAUDE.md 删净**:历史 177 条逐字节搬进 `engineering/doc/milestones/ARCHIVE-pre-FLY-2045.md` 冻结,新里程碑改成 **一 issue 一文件**;`CLAUDE.md` 只留几行指针。只改 Flywheel 专属的写入指令,通用仓库流程一字不动;加一个跑在 always-on lane、全部 fail-closed 的纯 bash 守卫。

**为什么能归零**:两个 PR 各新建**不同路径**的文件时,git 三方合并对这两个路径没有可冲突的对象(实测 merge + rebase 双形态,`merge-evidence.md` CASE 3)。成立域的精确表述见 §7.1。

### 0.1 已排除的候选(带实测理由,防止将来重试)

| 候选 | 排除理由 |
| -- | -- |
| 追加到表**底部** | **实测同样 100% 冲突**(`merge-evidence.md` CASE 4)。两分支各在 EOF 追加 = 同一 hunk 的两次加性修改,与顶部插入同构,与"是否同刻"无关。**issue 原文对这条的判断不成立** |
| `.gitattributes merge=union` | 能合(CASE 2),但 CLAUDE.md 同时是**规则文件**;CASE 2c 实测 union **静默保留两条互相矛盾的规则**且不报冲突。另:GitHub 服务端是否读 `.gitattributes` 未验证 |
| 脚本聚合回 CLAUDE.md | 生成物一旦 tracked,就还是同一个共享 hunk,**不归零** |
| `engineering/milestones/` | §2.1:确定性打红两个 residue guard,且不在 `ci-classify.sh` 的 inert 前缀内 |
| A —— 历史表原地冻结 | Tadashi 复议后否决(§3)。附带发现:A 的 cutover 是 merge **CLEAN**,旧行会静默滑进哨兵,而 base 前进本身不产生新 `pull_request` run ⇒ 旧绿 head 可以在新守卫从未执行的情况下合入(Codex R3 #1)。B 的 CONFLICT 是**吵闹的**,反而更安全 |

---

## 1. 实测基线(现查,不是引用)

| 量 | 值 | 命令 |
| -- | -- | -- |
| CLAUDE.md | 441 行 / 178,228 B | `wc -l -c CLAUDE.md` |
| 里程碑块(39–224 行) | 186 行 / 167,009 B = **93.7%** | `sed -n '39,224p' CLAUDE.md \| wc -l -c` |
| 其中数据行 | **177 条** —— **170 条** `FLY-`/`GEO-` 开头、**7 条** `v0.x/v1.0` 旧格式 | `sed -n '41,224p' CLAUDE.md \| grep -c '^\|'` |
| 块 sha256 | `cd8798182939362ca374a2c837758155a9e34ef5bbf088701a60e2655c81f09b` | `sed -n '39,224p' CLAUDE.md \| shasum -a 256` |
| 同上 @ `origin/main@5a8fe51bf` | **相同** | `git show origin/main:CLAUDE.md \| sed -n '39,224p' \| shasum -a 256` |
| 行尾 | 全 LF,块尾有 LF | — |

> 独立交叉验证:`cutover-merge-probe.sh` 用**动态定界**(唯一表头 → 唯一 `## Doc Structure & Lifecycle` 之前的最后一个非空行)独立解析出同样的 `39..224` 与 `177` 条数据行,且断言**全文没有一行里程碑形状的数据落在该范围之外**。
> B 落地之后工作树里已经没有表,所以最终 candidate 上必须用 `--source-sha <D9 的 source>` 复跑(读 `git show <sha>:CLAUDE.md`),不能读工作树 —— 否则脚本会以 `expected exactly 1 milestone table header, got 0` / exit 2 停下(这正是 `cutover-merge-probe-controls.sh` 的 `post-cutover-shape` 控制)。

> ⚠️ 行号与 hash 只对 `origin/main@5a8fe51bf` 成立。main 每合一单就多一行 ⇒ 行号右移、hash 变。**落地前最后一次 rebase 之后必须用 §5.1 的 D9 重算**,不许沿用本文档的字面值。
> 用 `sha256` 不用 `md5`:`md5` 是 macOS 专有命令,Ubuntu quick-gate 上没有。

---

## 2. 路径:`engineering/doc/milestones/`

### 2.1 为什么不是 issue 原文写的 `engineering/milestones/`(两条实测硬理由)

1. **`ci-classify.sh` 的 inert 判定要 prefix + suffix 同时命中。**
   `allowed_prefixes = (b"doc/", b"product/doc/", b"engineering/doc/", b"content/doc/")`(`scripts/ci-classify.sh:51`)。`engineering/milestones/` 不在里面 ⇒ 每个里程碑 PR 都跑全量 CI。
   > 顺带更正 research.md 的一句错话:我写过「CLAUDE.md 与新路径 CI 分类相同」。**错。** 根目录 `CLAUDE.md` 本身也不在 inert 前缀内 —— **今天**带里程碑的 PR 就已经在跑全量 CI。改到 `engineering/doc/milestones/` 之后,纯里程碑 PR 才第一次变成 inert。

2. **两个 repo-wide residue guard 只排除 `engineering/doc/**` 和 `CLAUDE.md`。**
   `v2-retirement-cleanup.test.sh:88-93`、`fly1680-v1-extinction.test.sh:104-111` 的 pathspec 均为 `':(top,exclude)engineering/doc/**' ':(top,exclude)CLAUDE.md'`。历史块里 FLY-1631 / FLY-1497 / FLY-1549 三行含 `flywheel-v2-kernel`、`v2-issue-display`、`FLYWHEEL_V2_DB_PATH` 等被禁标识符 —— 放进 `engineering/milestones/` ⇒ **确定性打红**;放进 `engineering/doc/milestones/` 则被既有排除覆盖。

⇒ **不新增任何宽泛排除。**

### 2.2 布局与格式

```
engineering/doc/milestones/
├── README.md                      # 单写者合同 + 文件名规范 + 为什么不是一张表
├── ARCHIVE-pre-FLY-2045.md        # 历史 177 条,哨兵之间逐字节搬入,冻结
└── <ID>.md                        # 每 issue 一个,ship 时新建
```

**文件名规范:`^(FLY|GEO)-[0-9]+\.md$`**(`orchestrator.md:333` 的 `ISSUE_ID` 明确写 `FLY-{XX}` **或 `GEO-{XX}`**,根 CLAUDE.md 也写明历史 Flywheel issue 仍在 GEO team。只允许 `FLY-` 会让 GEO 单要么被守卫拒、要么继续走旧表 writer —— 两条都破坏"不同 canonical issue ID"的保证)。

单条格式(README 写死):

```markdown
# <ID> — <短标题>

**Status**: ⏳ Pending ship        <!-- ship 后由同一 owner 改成 ✅ Merged (PR #NNN) -->
**PR**: #NNN
**Date**: YYYY-MM-DD

<正文:原先写在 Milestone 列里的那一段>
```

### 2.3 为什么历史用**一个** ARCHIVE 文件而不是拆 177 个

- 零丢失可以做**字节级**证明(哨兵之间 sha256 + byte count 双 pin,authority 绑 `origin/main@<sha>`);拆分做不到 —— 要解析 177 条含大量 `|`、`**`、代码块的 markdown,任何解析 bug 都是内容损坏,收益为零。
- 冲突面:冻结的 ARCHIVE 没人写 ⇒ 已经是零。
- Tadashi 的「不留永久化石」指的是**不留在指令文件里**;历史进目录、要用主动读,正是他给的口径(§3)。

### 2.4 指针的 authoritative literal(G2 exact-count 的对象)

D3 往 `## Current Phase` 里放的指针块约 6 行,但**被 exact-count 的只有下面这一行**,逐字固定(R5 #4:
不给字面量,`#7`/`#8` 两条 mutation 与最终守卫的合同就要靠实现者临场发明):

```
里程碑账本在 `engineering/doc/milestones/` —— 一 issue 一文件,ship 时新建 `<ID>.md`。
```

其余几行(为什么不要写回表、历史在 ARCHIVE 哪个文件)是说明文字,不参与计数。
`cutover-merge-probe.sh` 里那句一行简版 pointer 只是合成 fixture,**不是**这个合同。

---

## 3. ✅ 裁定:方案 B —— 整表搬出并从 CLAUDE.md 删净

**两次裁定,以后者为准。** 06:58 对 ask `946c5af3` 裁的是 A(原地冻结);07:05 我把「A 守卫其实不比 B 弱」这条更正发过去后(ask `36b21c86`),Tadashi 复议并改判:

> **选 B,按 plan.md §3 的 B 路线走。** 理由三条:
> 1. founder 红线「简单=净删除」—— 在指令文件里冻结 167 KB 历史化石不算简化,搬走+删净才是;
> 2. 167 KB × 每个 session 的装载税是实打实可量化的收益,而「被动吸收 177 条历史里程碑」的价值不可测且大概率趋零 —— 指令文件只装指令,历史要用就主动读目录;
> 3. **开新路必须同 PR 删老路**:里程碑既然有新家,CLAUDE.md 里的旧块在同一个 PR 里删干净,不留永久化石。
> B 的字节级守卫(CLAUDE.md 不得再出现里程碑数据行)照 plan 落地。
> 已同步 founder thread,若她有异议我会再来更正。

⇒ 全文按 B 执行。A 只作为被否决候选保留在 §0.1,以及 §7.2 的对照证据。

> 我在最初的 ask 里写过「A 守卫更弱」。那句不准确(哨兵 + 双 pin 之后两者在字节完整性上等强),我主动更正了,而这次更正正是促成复议的输入 —— 记在这里,免得将来把 A→B 读成朝令夕改。

---

## 4. 写入面:只改 Flywheel 专属面

实测这 5 处文本命中**不是同语义的 5 个 Flywheel writer**:

| 位置 | 真实语义(现查) | 做法 |
| -- | -- | -- |
| `engineer-executor.md:29` | Flywheel 工程 Runner 专属 | ✅ 改成新建 `engineering/doc/milestones/<ID>.md`(**新文件,不要改 CLAUDE.md**) |
| `spin.md:342` | Flywheel 专属说明块 | ✅ 同上换名词,保留 flywheel 语义 |
| `spin.md:369` | Flywheel 专属说明块 | ✅ 同上 |
| `spin.md:359` | **位于 `Non-flywheel repos (generic path)` 段**;Flywheel 在 :341-351 已被要求 skip | ❌ **保留原样**。守卫正向锚住它继续说 CLAUDE.md、继续带 `(flywheel: in the PR, skip here)` |
| `orchestrator.md:452-457`(步骤 F) | **post-merge**(在 C 清 worktree、D 验归档、E 改 MEMORY 之后) | 见 §4.1 |

### 4.1 orchestrator 的三个实现级要求(逐条现查过)

1. **A0 是幂等 ensure,不是"必须不存在才创建"(R16 HIGH 1)。**
   现有 A0(`:332-345`)只用 `git mv` 自动 stage,再用 `git diff --cached --quiet` 决定是否 commit。
   **新建文件是 untracked,不会被 stage;没有 docs 要 move 时整个 commit 会被跳过,里程碑文件就留在工作区没进 PR。**
   但 v16 写的"目标不存在才创建"与 **D4 让 executor 在 PR 最后一个 commit 里创建**直接冲突 ——
   **executor 做对了,A0 就必然失败**;D13(本单自己的里程碑)让这个矛盾在本单身上就能复现。

   **owner = 该 issue 的 ship PR;primary creator = executor(D4);A0 = 不覆盖的 last-mile ensure / fallback creator。**
   (v17 写"唯一 creator = executor"与下面第 3 步"两者皆无则创建"**字面矛盾** —— R17 HIGH 1。
   若真要 executor 独占创建,A0 在缺文件时就必须 **fail** 而不是补建;这里选 fallback,因为 A0 是最后一道
   在 push 前的关口,让它在 executor 漏建时静默失败没有好处。)
   A0 的 Flywheel 分支写死四步:
   1. 路径**已存在于 base** ⇒ **fail closed**:canonical ID 已被占用。
      base 必须是**当前**的:先 `git fetch origin main`,或直接绑定该 PR 的实际 base SHA ——
      只查可能陈旧的本地 `origin/main:<path>` 不配叫 fail-closed(R17 HIGH 1)。
      **lookup 出错必须与"path 不存在"区分**:出错 ⇒ 具名失败,不得当成"不存在"往下走;
   2. 路径**不在 base、但已作为本 branch 的新增文件存在** ⇒ 校验它 **tracked、命名合法、属于当前 issue**,
      **绝不覆盖**,直接 handoff;
   3. base 与 branch 都没有 ⇒ 创建 → `git add -- "$milestone_path"`;
   4. 仅当 staged bookkeeping **非空**才 commit。

   ⇒ G4 与 mutation **不再锚"worktree 目标必须不存在"**,改锚三件事:**base collision fence**、
   **branch-local existing-file handoff**、**no overwrite**。
2. **Flywheel 判定按 repo,不按 issue 前缀。** 复用 B2 已有的 `basename "$MAIN_REPO" == flywheel` 形态;否则 GEO 单或其它仓库会走错语义。
3. **步骤 F 的 Flywheel 分支只 skip 里程碑,`doc/VERSION` 不动、也不背书。**
   现查到一个**先于本单存在**的矛盾:B2 在 `:418` 断言 main checkout clean,而 F 在 `:454-457` 仍会 post-merge 修改 tracked `doc/VERSION` —— 与 `spin.md:342-371` 的「Flywheel post-merge writes NO tracked files to main」直接冲突。**本单不修**(是 VERSION 记账的问题,不是里程碑冲突的问题;实测最近 12 个 merge **零个**改过 `doc/VERSION`,对 flywheel 事实上休眠),但**也不写「VERSION 照旧」把它背书掉** —— 留具名 TODO,并进 §11.1。Tadashi 已确认此 scope split 并记入 backlog。

> 记忆 `feedback_stale_usage_left_earlier_in_a_doc_wins`:每个文件改完全文 grep 旧写法,确认没有更靠前的位置还留着旧指令。

---

## 5. 守卫

### 5.0 四条守卫编写铁律(Tadashi 点名要求写进本章,实现者照做)

这四条都是本单评审里**实际发生过**的失败,不是预防性文字:

**铁律 1 —— 匹配"某一行必须是 X"时,一律用 whole-line exact match。**
`grep -F "$H"` 会让 `## Doc Structure & Lifecycle (renamed)` 通过;`grep -Fx -- "$H"` 才不会。
R5 手工把 heading 改名后,我的 probe 照样打印 `PROBE OK` / exit 0 —— 这就是**「守卫是绿的,但它什么都没守」**的病根。
凡是 anchor / sentinel / heading / 合同句这类"必须逐字是这一行"的判定,一律 `-Fx`(并加 `--` 防止内容被当成选项)。

**铁律 2 —— 控制的**条数本身**也要 fail-closed。**
原来控制脚本结尾打印 `$pass_n/$pass_n`,于是**删掉一条控制**会以 `8/8` 干净通过。
正确写法是把期望条数钉成常量并断言相等:

```bash
EXPECTED_CONTROLS=<当前值>   # 示例用变量表达:重点是"断言相等",不是记住某个数字
[ "$pass_n" -eq "$EXPECTED_CONTROLS" ] || { echo "ran $pass_n, expected $EXPECTED_CONTROLS; a control was dropped" >&2; exit 1; }
```

同理适用于 §5.4 的 mutation 条数(39)与 D9 的结构控制条数:**清单长度是合同的一部分,不是统计输出。**

**推论(R12)——被机器消费的数字必须走专用整行机读记录,不能从人类日志里 grep。**
`expect_count` 曾用 `sed` 在整段输出里找 `(N data rows`,而 probe 会先打印 `source: <path>` ——
于是把 `TMPDIR` 设成名叫 `(151 data rows spoof)` 的目录,一个**故意把计数 +1** 的 probe 照样全绿。
正确做法分两层:
- **格式**:输出 `FLY2045_METRIC data_rows=N` 这样的**专用整行记录**,消费者**精确锚定**并断言**恰好一行**;
- **出处**(R13/R14 补):整行锚只约束"形状",**不证明"谁写的"**。**任何被机器消费的身份或数量都适用**
  —— metric 是一例,control 的**失败身份**是另一例(R14 实测:从人类 `FAIL:` 文案截 id,一条畸形记录被
  静默丢掉,controls 37/37、mutants 10/10 全绿)。把记录写到**调用方自己提供的通道**
  (这里是 `--metric-file`),消费者只读该通道;任何不可信字段(路径等)在进 human log 前**单行编码**。
  否则一个含**内嵌换行**的目录名就能在 stdout 上伪造出逐字节完美的记录 —— 实测让一个**已删掉真记录**的
  probe 通过了全部计数控制。
该记录本身也要有分支 mutant(计数偏移 / 重复 / 缺失),且 mutant 必须指向**权威通道**而不是日志副本。
(当前实际值:probe 控制 **37**、mutants **10**、D9 结构控制 **28**;示例里写死哪个数不重要,**断言相等**才重要。)

**铁律 3 —— 控制自己也要有控制;每个目标分支都要有可判别 fixture(允许重叠但须精确枚举);kill 必须验明正身。**
控制套件会在"为错误的原因变红"时打印满分(§5.4.3 有**三个**实际发生的例子)。要求:

1. 每个谓词分支必须能被单独删掉**并被察觉**;删了没人红的分支是**冗余**,删掉它而不是留着虚增规模;
2. **每个 mutant 有完整且精确的 expected failure set;每个目标分支至少有一条可判别 fixture。**
   允许 fixture 覆盖重叠 —— 但重叠必须被**枚举并锁死**。
   (原来写的是"每个 fixture 只违反一个谓词"。实测**不完全成立**且脚本自己已经承认:`drop-status-cell`
   会翻掉 **8** 条控制,`escape-isolation` 同时依赖 escape scanner 与 terminal-status 分支,只有 `drop-escape`
   能单独翻它。精确集合足以表达这种重叠,继续喊那句口号只会让实现者以为重叠本身违规 —— R12 LOW。)
3. mutant suite 先证明**未变异的**被测件健康,**并且**对**每个生成的 mutant** 证明:
   变异确实生效(**连 replacement site 数量一起 pin**)→ mutant **能解析** →
   控制的**失败集合与预期集合相等**。
   判定必须走**结构化 rc**(0=相等 / 1=集合不符 / 2=harness error),不能靠在输出里搜字符串 ——
   R12 把 self-control 的 edit 参数换成一句文案,sabotage 根本没发生(rc=2),外层却照样报「正确拒绝」。
   集合比较器本身要先用「相等 / 缺项 / 多项 / 空集」**直接证明**,坏了就 abort。
   只看"控制红了"会把 **mutant 自己坏了**记成成功 kill(R10 #4:生成器多写一个引号);
   只看"预期 id 出现过"会把**同时破坏两个分支**记成单分支 kill(R11 #2:实际失败 5 个控制仍记 ok)。
   FATAL / 工具错 / **任何集合外的控制** = harness error。harness 自己还要有一条负向控制:
   故意同时破坏两个分支,必须被拒。

**铁律 4 —— 同一个谓词只许有一份实现;计数要断言精确值;控制必须驱动被测的那一份,不是它的复制品。**
两份手工同步的副本会漂移,而且漂移**完全不可见**:只改算 `data_rows` 那一份的 status regex,
真实的 `⚠️` 行就从计数里消失(177→176),而 probe / controls / mutants **全部照常报成功** ——
因为当时 `data_rows` 只断言 `>100`(R11 #1 实测)。所以:

- 一个谓词一份实现(这里收成一次 awk 调用、一个 `canonical()`,一趟出 `bad/first/data`);
- 计数类输出断言**精确值**,不写 `>N`;
- 每个**可枚举取值**(这里是 6 个 status marker,含带 variation selector 的 `⚠️`)都要有自己的正向 fixture;
- **控制不许重算被测逻辑**。malformed-record 自控曾自己重算 raw/parsed,于是删掉**生产**的解析检查它照样过 ——
  测的是复制品。改为经 `classify_mutant` 驱动之后,把生产分支改成 `if false` 会让它立刻失败(R15);
- **计数与账本要对账**:`failures` 计数必须等于 failure 通道里的记录数,否则一次绕过 `record_failure()` 的
  直接自增就会藏在别的正常记录后面;
- **数行要用 `wc -l`,不要用 `grep -c .`** —— 后者跳过空行,一条空记录就能冒充"全部可解析"。

`scripts/__tests__/fly2045-milestone-layout.test.sh` —— 纯 bash、零外部依赖(在 quick-gate 里跑在 `pnpm install` **之前**,与 `fly1773-delivery-semantics.test.sh` 同款)。每条断言失败时**具名**打印它守的是哪一条不变量(§5.4 的 N1–N13 / S1–S5 编号即可)。
**v18 起不再维护 sub-ID literal 目录与同组互斥协议** —— 那一层已按 §5.5 裁掉(理由见 §5.4 的替换说明)。

### 5.1 双 pin 的 authority 必须自身 fail-closed

两层问题都要关掉:

**(a) 不许循环自证。** 「从 candidate 重算 pin 并写回」只证明 candidate 与自己一致,证不了验收 2 要的"相对权威 main 零丢失"。

**(b) authoritative source 本身也要被证明**(Codex R3 #4):只让调用者传一个 SHA 并记录下来,传错一个旧 SHA 照样能 `cmp` 通过并盖章,却漏掉更晚 main 里新增的里程碑。

D9 (`scripts/fly2045-pin-archive.sh`) 的写死流程:

```
preflight(任一失败立即非零,绝不写 pin):
  1. 参数必须 resolve 成 40-hex commit
  2. 先做一次 fresh `git fetch origin main`
  3. 断言 source_sha == $(git rev-parse origin/main^{commit})     ← 必须是当前 main,不是某个旧 SHA
  4. 断言 git merge-base --is-ancestor "$source_sha" HEAD          ← 必须是 candidate 的祖先
  5. **block completeness**(Codex R4 #3):source 的 CLAUDE.md 里,里程碑表头必须**恰好一次**;
     `## Doc Structure & Lifecycle` 必须**恰好一次**且在表头之后;块尾 = 该 heading 之前最后一个非空行;
     并断言**全文所有里程碑形状的行**(表头 / `FLY-`/`GEO-` 行 / legacy `v[0-9]` 行)都落在该范围内。
     两个实现细节是 load-bearing:
     - **whole-line exact match**(`grep -Fx`,不是 `grep -F`)。子串匹配会把
       `## Doc Structure & Lifecycle (renamed)` 当成合法边界 —— 这不是理论:R5 手工构造后 probe 仍
       `PROBE OK` exit 0,我复现确认并已修(见 §11 的 probe 行)。
     - **完整性断言**。只查"其后第一个任意 `## `"是不够的:extractor 会合法地截到一个**前缀**,
       candidate 与这个前缀 `cmp` 相等、pin 也算得出来,D3 再把整块删掉 —— 后半张表无声丢失。
       SHA/ancestor 检查发现不了,因为它们证明的是 commit identity,不是 block completeness。
     > 措辞更正(R5 #2):**绑定 exact heading 之后,表内混进一个普通 `## Rogue Heading` 不再截断**
     > (实测:整块仍被正确解析)。真正能**少抽**的形态是「唯一的 exact Doc heading 被提前到表中间,
     > 后面还留着 milestone 行」—— 由 outside-row 完整性断言打红。
     > 但普通 rogue heading 也不是无害的:它会被**多抽**(见下条第 6 项)。
  6. **table-shape closure**(Codex R6 #1,blocker):上面几条只防"少抽",**不防"多抽"**。
     块尾定义是"Doc heading 之前最后一个非空行",所以在表与 Doc heading 之间放一行普通规则,
     块尾就会延伸把它吞进去 —— **B 会连这条活规则一起从 CLAUDE.md 删掉,而 `cmp` 与双 pin 会给这次删除盖章**
     (它们证明的是"candidate 与 source 的这一段一致",不是"这一段只含表")。
     R6 用真实 CLAUDE.md 构造后,probe 报 `39..226 / 0 rows outside` 并 exit 0。
     ⇒ 必须断言两件事:

     **(i) 分隔行**必须匹配严格两列语法 `^\|:?-{3,}:?\|:?-{3,}:?\|$`。
     "首尾是 `\|` + 字符落在宽松字符类里"不够:`\|\|\|\|`、`\| \|`、`\|::\|` 都能冒充(R7 #1 实测)。

     **(ii) 分隔行到块尾的每个非空行**必须通过 canonical 谓词。谓词是**三条**,每条都有独立控制:

     1. **column-0 起始**:必须以 `\| ` 开头,**不允许前导空白**;
     2. **完整 token + 边界**:`(FLY\|GEO)-[0-9]+` 后面必须跟一个**非 word 字符**(`[^0-9A-Za-z_-]`),
        或 legacy `v[0-9]+(\.[0-9]+)*` 后面跟空白 —— 不能像 v8 那样只前缀命中**一个**数字;
     3. **terminal status cell**:delimiter **只认未转义的 `\|`**(`\\\|` 不算),首尾必须是分隔符;
        **最后一个 cell** 去空白后必须匹配**一个** predicate:`^(✅|⏳|⛔|⚠️|⚠|↪)[[:space:]]+[^[:space:]]`
        —— 完整 marker + 至少一个空白 + 至少一个非空白字符。
        **不要**再配一条 `substr(status, N) == ""` 之类的"正文非空"补充分支:trim 之后它没有剩余职责
        (删掉后控制仍全绿 = 未被证明的冗余),而固定 offset 还把正确性绑到 awk 按 byte 还是 character
        计数 —— `⚠️` 比其它 marker 多一个 variation selector,长度本来就不齐(R11 #3)。

     > **不建 backtick 状态机**(R10 #1):按 GFM,inline-code 里**未转义**的 pipe 仍然是 delimiter;
     > 而逐字符 parity toggle 根本不是 code-span scanner —— 它会把「正文含一个未配对反引号」和
     > ``` ``a ` b`` ``` 这两种**合法行** false RED,判定还随反引号**个数**翻转。删掉整条分支后
     > 实测:177/177 仍接受、两个合法反引号形态接受、**7 条**含多余未转义 raw pipe 的历史行
     > (6 条来自历史 inline-code 文本、1 条是 `schema 1\|2`)逐字节接受。
     > ⇒ 这是一个 **legacy-aware source-row classifier**,**不是 Markdown renderer**,不声称渲染保真。

     > **status 必须有边界**(R10 #2):只做 prefix 判断时,`✅NOT-A-STATUS`、`✅<!-- fake status -->`、
     > 以及**只有一个 marker** 的 cell 全部通过 —— 与 `FLY-1NOT` 的 token collision 同类,只是右移一个 cell。
     > 实测 177/177 的 marker 后都有空白且正文非空,所以收紧零 false RED。
     > ⚠️ **声明只到这里**:它证明「符合冻结账本的 status grammar」,**不证明人的意图** ——
     > `✅ KEEP THIS LIVE` 对任何机器都与状态文本不可区分。若 cutover 前有人引入**新 marker**,
     > D9 会 named false RED 要求人工确认;在已冻结旧格式 ship 的窗口里这是安全行为,不是内容丢失。

     > **数 `\|` 字符 ≠ 数 cell**(R9 #1 实测):`\| FLY-7777: … mentions \\\| but has no status cell \|`
     > 有 3 个 raw pipe、却只有**一个** Markdown cell;`` `a \| b` `` 的 inline-code 变体同理。
     > 两者在 v9 都被吞进去(块尾 224→225、`data_rows=178`、报 `0 non-milestone inside`)。
     > 语义更宽的 `\| FLY-7777: … \| KEEP THIS LIVE \|` 也通过 —— 两列是真的,但第二列根本不是 status。
     > 所以必须验 terminal cell,不能只数分隔符样的字符。
     >
     > **前提先验证再采纳**:实测 177 条 status cell 全部以那五个 marker 开头(`✅`95 / `⏳`78 / `⛔`2 / `⚠`1 / `↪`1),
     > scanner 接受 **177/177**(含正文里真的含 `\\\|` 的第 117 行),拒绝全部 14 个反例。
     >
     > **刻意不加"至少两个 cell"这条分支**:mutant suite 证明它**删掉也没人察觉** —— 单 cell 行的
     > terminal cell 就是它的里程碑正文,status 合同已经拒了它;带/不带该分支对 177 行与全部反例
     > 判定完全相同。不可被隔离证明的分支只会虚增守卫规模,所以删掉而不是留着(§5.4.3)。
     >
     > ⚠️ 若 cutover 前有人引入**新的 status marker**,D9 会给出 named false RED,要求人工确认。
     > 在已冻结旧格式 ship 的 cutover 窗口里这是安全行为,**不是内容丢失**。

     只做第 1 层或只看首字节是不够的(R8 #1 五个真实反例,插进真实表后 v8 全部 exit 0、块尾扩到 225):
     `\| FLY-1NOT-A-MILESTONE LIVE RULE \|`(issue token 无边界)、
     `\| v1THIS-IS-NOT-A-VERSION LIVE RULE \|`(version token 无边界)、
     `    \| GEO-7NOT-A-MILESTONE LIVE RULE \|`(缩进仍被放行)、
     `\| FLY-7777: CRITICAL ACTIVE RULE - no status column \|`(只有一个 cell)、
     `\| FLY-7777NOT-A-MILESTONE \| preserve \|`(三个 pipe 补不了 token 边界)。

     > ⚠️ **也刻意不收紧成"数字后必须紧跟 `:`"**:实测 170 条 FLY/GEO 行里有 **41 条**不是 immediate-colon
     > 形态(合并 ID `FLY-51 + FLY-58`、版本注记 `FLY-115 v1.24.1`、track/inc 标记 `FLY-247 inc2a` 等),
     > 那样会对**真实数据** false RED。三层谓词实测 **177/177 接受**、上述 10 个反例(R7 五个 + R8 五个)**全拒**。

     `data_rows` 也必须用**同一个** canonical 谓词计数,不能另用 `grep '^\|'`,否则报出来的数字会和
     closure 实际接受的集合漂移。
     这不是合成边界 —— §7.2 明确要求保留 `unrelated CLAUDE edit`,而 cutover freeze 只冻结旧格式
     milestone ship;在 D9 最后一次 fetch 之前,main 完全可能合法地往 `## Current Phase` 里新增一段规则。
     实测当前块 = **179 表行 + 7 空行 + 0 条其它非空行**,所以现在收紧零代价。
主体:
  6. 从 source 取原始表块字节流 → $SRC_BLOCK(临时文件)
  7. 从 candidate 的 ARCHIVE 取两个哨兵之间的字节流 → $CAND_BLOCK(临时文件)
  8. cmp -s "$SRC_BLOCK" "$CAND_BLOCK" → 不一致立即非零并 diff 出前若干行,绝不写 pin
  9. 只有一致时,才从 **$SRC_BLOCK** 生成 sha256 与 byte count,写回守卫
 10. 把 source SHA / hash / bytes 写进 acceptance-evidence.md
```

**pin 的 authority 永远是 source,不是 candidate;而 source 是谁,由 preflight 证明,不由调用者声明。**

### 5.1.1 extraction 必须是字节流合同

```bash
# 对的:落到临时文件,再分别量
extract_archive_block "$ARCHIVE_MD" > "$TMP/block"
bytes=$(wc -c < "$TMP/block")
hash=$(sha256_of_file "$TMP/block")

# 错的:command substitution 会剥掉**所有** trailing newline
block="$(extract_archive_block "$ARCHIVE_MD")"   # ← 块尾增删空行就绕过了所谓 byte-level 证明
```

portable checksum(三级回退,**没有工具就 fail closed**):

```bash
sha256_of_file() {
  if   command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum    >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  elif command -v openssl   >/dev/null 2>&1; then openssl dgst -sha256 -r "$1" | awk '{print $1}'
  else return 3; fi
}
```
`return 3` 必须让守卫**非零退出并具名报 `checksum tool unavailable`**,不得静默通过。

### 5.2 六条断言(全部 fail-closed)

| ID | 断言 | fail-closed 理由 |
| -- | -- | -- |
| **G1** | `engineering/doc/milestones/` 存在;`README.md` 与 `ARCHIVE-pre-FLY-2045.md` 都存在 | 存在性 |
| **G2** | ① `## Current Phase` **恰好一次**;**exact whole-line** `## Doc Structure & Lifecycle` **恰好一次**;② **指针 anchor 行**(§2.4 的 authoritative literal)**恰好一次**;③ 顺序**两条都要查**:`## Current Phase` < 指针 **且** 指针 < `## Doc Structure & Lifecycle`;④ **`CLAUDE.md` 全文**不得出现里程碑表头 `\| Milestone \| Status \|`,也不得出现 `^\s*[\|]\s*(FLY\|GEO)-[0-9]` 或 `^\s*[\|]\s*v[0-9]` 数据行 | ① 绑 **exact heading**,不是"其后第一个 `## `"—— 删掉 `## Doc Structure & Lifecycle` 之后扫描会滑到 `## Key Architecture Decisions`(实测 226 → 346),一个只找"下一个任意 heading"的实现不会红(Codex R4 #2)。④ 覆盖三类:表头 / FLY-GEO 行 / **legacy `v[0-9]` 行**(块里真有 7 条 `\| v0.1.0 …`);可选前导空白防缩进绕过;查全文而非只查某一段,防"改个段名就 vacuously green"。正则里的竖线写成 `[\|]` 而不是 `\|` —— 后者在 awk ERE 会退化成 alternation(实施中已实测踩到) |
| **G3** | ARCHIVE 的哨兵 `FLY-2045-ARCHIVE-BEGIN` / `-END` **各恰好一次**且顺序正确;其间字节流 **sha256 == pin** **且 byte count == pin**;**保留原块末尾的 LF** | 双 pin + exactly-once + 顺序;任何一个字节变化都红 |
| **G4** | 逐 call site 的 exact semantic anchor:`engineer-executor.md`;`spin.md:342`;`spin.md:369`;**`spin.md` 的 non-Flywheel generic 锚必须仍在**(继续说 CLAUDE.md + 带 flywheel-skip 括注);`orchestrator.md` A0 的 **base collision fence + branch-local handoff/no-overwrite + absent-path `git add` 与 cached commit**(§4.1(1));F 的 Flywheel skip 锚;**A0/F 的 Flywheel 判定必须是 repo predicate 而不是 `FLY-` 前缀**(§4.1(2))| file-level 计数会让同文件其它 write site 悄悄丢失;必须**正向保护**通用面不被误改 |
| **G5** | 目录下除 `README.md` 与 **exact** `ARCHIVE-pre-FLY-2045.md` 外,文件名必须匹配 `^(FLY\|GEO)-[0-9]+\.md$`;且**至少存在一个**该模式的文件 | 豁免必须是 **exact basename** 而不是 `ARCHIVE-*.md` 通配 —— 否则 `ARCHIVE-notes.md` 直接绕过非法文件名检查(Codex R4 #2)。目录空时 vacuously green;正则必须真的接受 GEO(见正向 fixture P1) |
| **G6** | README 写死的**文件名规则**与 G5 正则一致,且**单写者合同**文本存在 | 防文档与守卫各说各话 |

### 5.3 CI wiring 也要被锁住

只把脚本加进 `ci.yml` 只能通过 `ci-shell-suite-enumeration.test.sh`(它只证明字符串在 ci.yml 出现过)。仿 `ci-structure.test.sh:563-580` 增加断言:

- FLY-2045 step 在 **quick-gate 恰好一次**,两个 script shard 中**零次**;
- `run` 逐字等于 `bash scripts/__tests__/fly2045-milestone-layout.test.sh`;
- 该 step **无** `if`、**无** `continue-on-error`;
- 位置在 `Install dependencies` step **之前**。

插入点:`Enforce FLY-1773 ACK-only delivery semantics` 之后。

**放 quick-gate 的理由**(实测):里程碑回归本质都是 `.md` 改动;迁到 `engineering/doc/milestones/` 后它们同时命中 inert 的 prefix 与 suffix ⇒ **重格子会被跳过**。quick-gate 永远运行,且没有 `expected_shard_tests` 那种精确顺序清单。

### 5.4 保留的 fixture 集合(裁剪后的**唯一**合同)

> **v18:整段替换。** v17 只在 §5.5 *声明* 要裁剪,却把 39 条 mutation、sub-ID literal 目录、同组互斥协议、
> D9 的 28 条 controls 与它自己的 mutant suite **原样留在正文里** —— 于是同一份"唯一执行权威"同时给出两套
> 相反要求,机械上无法实施(R17 MEDIUM)。原 §5.4 / 5.4.1 / 5.4.2 / 5.4.3 的详细协议**整体 superseded**,
> 其历史与理由保留在修订记录与 §5.0 的四条铁律里。

**流程**(不变,但只作用于下表):完整 green candidate → 临时 clone/fixture 里施加**单个** mutation →
断言非零且**具名** → 恢复 → 再次 green。harness 自带控制:任一"应红"没红 ⇒ 整体失败。

**D8 保留集合 —— 每个承重不变量一条直接 negative fixture,外加正向 fixture**:

| # | fixture | 守的不变量 |
| -- | -- | -- |
| N1 | `CLAUDE.md` 里放回里程碑**表头** | 旧表不得回流 |
| N2 | `CLAUDE.md` 里加一行里程碑**数据行**(覆盖 `FLY-`/`GEO-`/legacy `v[0-9]`,含缩进形态) | 旧表不得回流 |
| N3 | ARCHIVE **同长度**改一个字节 | hash pin |
| N4 | 只改 expected **byte pin**、内容与 hash 不变 | byte pin **独立**生效 |
| N5 | 目录里放一个**非法文件名** | per-ID 命名 |
| N6 | 删掉唯一的 per-issue 文件 | non-vacuous |
| N7 | 删 `engineer-executor.md` / `spin.md:342` / `spin.md:369` 任一新路径锚 | 活跃 Flywheel writer 不再指旧表 |
| N8 | 改 `spin.md` 的 **non-Flywheel generic 锚** | **反向**:通用面不得被误改 |
| N9 | 删 orchestrator A0 的 **base collision fence** | §4.1(1) |
| N10 | 删 orchestrator A0 的 **branch-local handoff / no-overwrite** | §4.1(1) |
| N11 | 删 orchestrator A0 的 **absent-path add + cached commit** | §4.1(1) |
| N12 | 删 orchestrator F 的 Flywheel skip 锚 | F 不得 post-merge 写 |
| N13 | 把 orchestrator 的 Flywheel 判定改成 `FLY-` 前缀 | 必须按 repo 判定(否则 GEO 单走错路径) |
| **P1** | 目录里放一个合法的 `GEO-145.md` | **必须保持 GREEN** —— 没有它,写死 `^FLY-` 的错误实现能通过上面全部 negative |
| **P2** | 无 `sha256sum`/`shasum`/`openssl` 时 | 守卫必须**具名非零**报 `checksum tool unavailable` —— 这是 fail-closed portability,**不随 meta-harness 一起裁掉**(R17 MEDIUM 点名) |

**D9 保留集合(高价值场景,不再维护 D9 自己的 mutant suite)**:

| # | 场景 | 期望 |
| -- | -- | -- |
| S1 | garbage / stale / non-ancestor source SHA(三条) | 具名非零,**不写 pin** |
| S2 | **少抽**:唯一 exact Doc heading 被提前到表中,后面仍留 milestone 行 | 同上 |
| S3 | **多抽**:表与 Doc heading 之间有 prose / pipe 前缀非里程碑行 / 整张无关表 / 畸形分隔行 | 同上 |
| S4 | candidate 与 source `cmp` 不一致 | 同上 |
| S5 | **真实 source positive** | 通过并写出正确的 sha256 + byte 双 pin |

`ci-structure` 侧**不再**建 meta-harness:它已经有 exactly-once / exact command / no-if / no-continue-on-error /
before-install 的**直接**断言,再套一层是重复证明同一谓词(R16/R17)。

`cutover-merge-probe{,-controls,-mutants}.sh` 的 37 controls / 11 mutants **作为设计期 evidence 留档**
(D15),交付门只重跑**主 probe(带 `--source-sha`)+ §6.2 反向 positive control**。

### 5.5 验证集合的裁剪(R16 MEDIUM,采纳)

R16 的观察是对的,而且前 15 轮的历史本身就是证据:**验证装置已经明显大于它保护的那次迁移**,
不断在 meta-harness 自己身上找洞,说明它已经变成主要 blast radius。这与本仓 `enforce simplicity` 相冲突。

**保留(全部承重检查,一条不减)**:

- D7 的核心不变量:CLAUDE.md 不回流、archive 双 pin、per-ID 文件名合法、活跃 Flywheel writer 不再指向旧表;
- D9 的 fresh-source / ancestor / exact boundary / shape closure / `cmp` / byte+hash;
- §6 真 PR 验收 + §6.2 反向对照;
- `ci-structure` 对 exactly-once / exact command / before-install 的**直接**断言;
- §8 的三个既有 residue suite。

**裁掉(重复证明同一谓词的那一层)**:

| 原定 | 改为 |
| -- | -- |
| D8 的 39 条 mutation + sub-ID 目录 + 同组互斥协议 | **每个核心不变量一条直接 negative fixture + 1 条 GEO positive fixture**;不再长期维护 sub-ID 协议 |
| D9 的 28 条 controls + D9 自己的 mutant suite | **收到少量高价值场景**:错误 SHA、少抽、多抽、candidate mismatch、真实 source positive。**删除 D9 的 mutant suite** |
| D15 的 37 controls / 11 mutants 进交付门 | **作为设计期 evidence 留档**;交付门只重跑**主 probe + 反向 positive control** |
| 6 条 workflow-structure mutation | 删除 —— `ci-structure` 已有直接结构断言,不需要再套一层 meta-harness |

**不许裁**:双 pin、真 PR 门、cutover fence。裁的是**重复证明同一谓词**的 meta-verification,不是承重梁。

---

## 6. 验收 —— 真 PR 是硬完成门

| # | 验收 | 证明手段 | 状态 |
| -- | -- | -- | -- |
| 1 | 两并行 PR 各加里程碑,先合一个,另一个不 DIRTY | §6.1 真 PR pair。git 层实测只是**前置**,不是验收 | 本节点执行(已授权) |
| 2 | 里程碑内容零丢失 | G3 的 sha256 + byte 双 pin,authority 由 §5.1 的 preflight 证明 | 本节点 |
| 3 | QA 报告 commit 不再与 main 赛跑 | §6.1 步骤 5:X 落地后向 Y 再 push 一笔 QA 报告 commit,证明 Y 仍非 DIRTY **且新 head 真的产生了 exact-head `pull_request` run 并最终 green** | 本节点 |

### 6.1 流程(写死)

**provenance 合同(R16 HIGH 2)**:台架必须**密码学绑定**到被交付的那份实现,否则从 stale commit、
`origin/main` 甚至手搭的最小目录起台架都能产出形式完整的 D14,却什么都没证明。

```
0. 记录 base SHA;并在 D9 / 实现测试 / code review 全部完成后记录 implementation_sha。
   证据文件 .../acceptance-evidence.md
0b. fly2045-accept-base 的 parent 必须 **精确等于** implementation_sha;该 base 分支上
    **只允许再有一个** commit —— §6.3 的 workflow-trigger commit。记录 parent / tree /
    该 commit 的唯一 diff。X、Y 必须从这个 rig commit 切出。
0c. 失效条件:D14 可在验收后追加;但交付分支相对 implementation_sha **只允许**新增证据文件
    或计划显式允许的 data-only repin。**任何** guard / writer / layout / workflow 实现变化
    都使 §6 失效,必须重跑。
1. 建 fly2045-accept-base(§6.3 的 test-rig trigger 也在这条分支上);从它切 branch-X、branch-Y
2. X 只加 engineering/doc/milestones/FLY-<X>.md;Y 只加 FLY-<Y>.md;两个都开 PR
   PR 标题必须以 [FLY-2045 验收探针] 开头(Tadashi 边界 1)
   有界轮询 gh pr view --json mergeable,mergeStateStatus —— mergeable=UNKNOWN 是"还在算",
   必须轮询到确定值再判,不得把 UNKNOWN 当结论
   期望:两个都 MERGEABLE。逐条记录 PR URL / base SHA / headRefOid / mergeable / mergeStateStatus
3. 合掉 PR-X(合进 fly2045-accept-base,永不碰 main)
4. 不动 branch-Y,重查 → 期望仍 MERGEABLE
5. 向 branch-Y push 一笔唯一的 per-issue QA 报告 commit;记录 new_headRefOid;有界轮询
     gh run list --workflow CI --event pull_request --commit "$new_headRefOid" \
       --json databaseId,event,headBranch,headSha,status,conclusion,url
   **fail-closed 选取**:结果必须**至少一条**匹配 event==pull_request && headSha==new_headRefOid
   && headBranch==branch-Y。**零条判失败**;多条(= rerun,合法)则**全部记录**并取 **最新的 databaseId**。
   (v16 同时写了"恰好一条,多条失败"和"多条取最新" —— 两者不能同时成立,R16 已点名;这里取后者。)
   取其 databaseId,watch 到 completed,断言 conclusion==success。
   **并且**对新 head 再跑一次有界 `gh pr view --json mergeable,mergeStateStatus,headRefOid`,
   断言 Y 仍是 `MERGEABLE` —— 验收表说的是"仍非 DIRTY",证明手段就必须真的查这一项(R16 HIGH 2)。
   判定条件是「该 exact head 的 pull_request run 被创建且最终 success」——
   **不要求观察到瞬态 queued**(run 可能在第一次轮询前就跑完了,拿 queued 当必要条件会造假失败)
6. 清理(R3 #5):**已 MERGED 的 PR 不能再 close** —— X 保持 MERGED 作为证据,只 close 未合入的 Y;
   删除 branch-X / branch-Y / fly2045-accept-base 三个 ref。GitHub 的 PR 记录本身删不掉。
```

**失败即停** —— 任一步不符预期就停止、不宣布完成、把原始输出贴进 `acceptance-evidence.md` 并上报 Tadashi。

### 6.2 反向对照的独立生命周期

反向对照证明的是**尺子有效**(能区分 DIRTY 与非 DIRTY);它不红 ⇒ §6.1 步骤 4 的绿是假绿,整个验收作废。

在**另一条从当前 `origin/main` 切出的 scratch base**(`fly2045-control-base`,同样永不碰 main、同样带 §6.3 的 trigger)上:两条分支各按**今天的旧机制**在 CLAUDE.md 表头下加一行 → 开两个 PR(标题同样带 `[FLY-2045 验收探针]`)→ 合掉一个 → 另一个**必须变 CONFLICTING**。

清理同 §6.1 步骤 6:合掉的那个保持 MERGED,只 close 未合入的那个,删三个 ref。

⇒ 两套 rig 合计留下 **2 个 MERGED + 2 个 CLOSED** 的探针 PR,以及 0 个残留分支。

### 6.3 临时 base 上必须补 test-rig trigger(已实测确认 + 已获 Tadashi 批准)

`.github/workflows/ci.yml:3-7` 是仓库**唯一**的 `pull_request` workflow,且:

```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```

`branches:` 过滤的是 PR 的 **base**。边界 2 又禁止以 `main` 为 base ⇒ **探针 PR 不会产生任何 CI run**,§6.1 步骤 5 要证的东西根本不存在。

处置:在 `fly2045-accept-base` / `fly2045-control-base` 上,**只在该分支**把 `pull_request.branches` 精确改成 `[main, <该 base>]`,job graph 一字不动。探针分支从 base 切出,因此 base、head 与合成的 `refs/pull/<n>/merge` 上都有这份 workflow。

Tadashi 2026-08-25 批准,三条硬约束逐字执行:

1. 改动**只活在两条一次性 base 及其子分支**,随 §6.1 步骤 6 删 ref 一起消失;
2. **交付 PR 显式 diff 自检、零 workflow 台架改动** —— §10 步骤 14 的 `git diff origin/main...HEAD -- .github/workflows/ci.yml` 只允许含 §5.3 那一步;
3. 报告写明这是**验收台架,不是 CI 策略变更**。

他同时明确:**不要转 QA/ship 硬门,验收第 3 条就在本单用真 run 证。**

### 6.4 Tadashi 的四条边界(逐字执行)

1. base 分支名**就用** `fly2045-accept-base`;探针 PR 标题**必须以 `[FLY-2045 验收探针]` 开头** —— 不许长得像正常交付 PR,避免与 founder 卡流程混淆;
2. merge **只许进那个临时分支**;**任何时刻不许以 `main` 为 base 或 target**;
3. 做完删分支、close 未合并的探针 PR(已 MERGED 的保持 MERGED;PR 记录不可删除),交付报告里留探针 PR 号与结果截录;
4. **这不算 ship 例外的先例** —— 红线针对的是 main / 生产,这次是验收台架。交付报告必须照这句写清,**免得后人引用成「可以 self-merge」**。

---

## 7. 「冲突归零」的成立域 + cutover

### 7.1 成立域

保证的是:**不同 canonical issue ID 的里程碑记账,冲突为零**(普通 merge / rebase / squash-merge / cherry-pick 均成立)。

**不**保证、必须写进 README 的三种情况:

| 情况 | 结果 | 合同 |
| -- | -- | -- |
| 同一 issue 的两个 PR 各建同名文件 | add/add 冲突 | **单写者**:一个 issue 的里程碑文件只由该 issue 的 ship PR 创建;重复路径 = fail,人工合并,不自动改名 |
| 同一文件的并发 status 更新(`⏳ → ✅`) | 冲突 | status 更新**只能由该 issue 自己的后续 PR 串行做**;不允许第三方 PR 顺手改别人的里程碑文件 |
| revert 后重加 / 改已归档文件 | add/add 或 modify/delete | 走人工;历史文件默认 immutable |

### 7.2 一次性 cutover —— B 的形态是 **CONFLICT(DIRTY)**,并且要有事件级 fence

`cutover-merge-probe.sh` 拿**真实 CLAUDE.md**、**动态定界**做三方合并(fail-closed,自带控制组):

```
B(整块删除)          vs 旧 writer(表头下加一行)   → CONFLICT   ← 本单走这条
A(只在块外加哨兵)    vs 同一个旧 writer            → CLEAN,旧行落进哨兵内部
控制:两个旧 writer 互相                            → CONFLICT   ← harness 有效
```

⇒ B 之下,仍带旧表行的在飞 PR 会**一次性变 DIRTY**。这是吵闹的、挡得住的失败;A 的 CLEAN 反而危险(见 §0.1 与下面的 fence 理由)。

**为什么必须是 fence 而不只是通知**(Codex R3 #1,已源码核实):
`ship-on-comment.yml:111-150` 读 `pr.head.sha`,`scripts/ship-await-ci.sh:37-75` 只检查**该 exact head 上已有的** `CI OK` / workflow run,merge API 也只用同一 head SHA 做 fencing —— **没有绑定 base SHA,也不会为新的 merge preview 主动制造 CI**。而 base 前进本身不触发新的 `pull_request` run。所以「cutover 前已绿的旧 head」在任何布局下都不能当作 cutover 后的有效证明。

**cutover hard gate —— 两阶段(R16 HIGH 3)**

v16 一边要求 ship 前"零未处置条目",一边允许 `post-B-migrate`,**而后者的合格证据只能在 B 落地之后产生** ——
时间上不可能同时成立。二选一,这里选**两阶段**(单阶段严格 gate 要求所有旧 writer 在 B 之前 land 或关闭,
对 3 个活跃 PR 不现实):

**阶段一(B merge 之前)**:每条旧 writer PR 必须**已分类**且**被安全 fence**,允许具名的
`post-B-migrate-pending`。**fence 是机制而不是承诺**:B 对 CLAUDE.md 是整块删除,旧 writer 是插入 ⇒
modify/delete 冲突,这些 PR 在 B 落地后**必然 DIRTY,合不进去**(`cutover-merge-probe.sh` 实测)。
⇒ 阶段一的"零未处置"指的是**零未分类**,不是零未迁移。

**阶段二(B merge 之后)**:逐条 rebase / 迁移 / close,每条取得**跑过新守卫的 exact-head `pull_request` green`。
**全部完成之前 FLY-2045 不算 Done。** 阶段二的权威记录**不在 delivery PR 的 D14 里**(那时它还不存在),
而在 **Linear issue FLY-2045 的 disposition ledger 评论** —— D14 只承载阶段一的分类快照与 §6 证据。
   rebase 的具体解法必须写清 —— 旧 writer 的插入 vs B 的整块删除**本来就会冲突**,不写等于让 owner 现场猜(Codex R4 #5):
   > `git rebase origin/main` → 在 `CLAUDE.md` 的冲突处**显式取 post-cutover 的 pointer-only 版本**(即完全丢弃自己那条旧表 mutation,不要试图保留那一行)→ 新建 `engineering/doc/milestones/<ID>.md` 放同样的内容 → `git add` 两者 → `git rebase --continue` → push,取得新的 exact-head CI。
**两阶段都适用的两条**:

3. **明确禁止**仅凭 cutover 前的旧绿 head 合并这些 PR;owner 通知不是 fence;
4. **交付 PR 自身同理**:D9 之后若 `origin/main` 又前进,必须 rebase → 重跑 D9 的 `cmp`/重算 pin →
   取得新的 exact-head CI;不能只看 mergeable 仍为 true。

   > **v19 修订(Tadashi 2026-08-25 裁定,起因见 `acceptance-evidence.md` 附录 A.4)。**
   > v17 在这里写的是「**并重跑 §6**」。实测下来那条太粗:交卷窗口里 main 前进了一次,
   > 而本单的实现面 diff 只有三个 pin 字面量 + 两处注释数字,**零机制改动** —— §6 台架证的是
   > 「不同路径 ⇒ 没有可冲突的对象」这条**机制**性质(含反向对照),它是布局的函数,不是 pin 值的函数。
   > 而重跑一次 §6 要新建 6 条远端 ref,runner 侧删不掉(push-guard `pre-push:33`),每次都要 Lead 兜底。
   >
   > **新口径**:
   > - `origin/main` 前进 ⇒ **merge-tree 等价复验** —— rebase + 重算 pin + 新 exact-head CI 绿,
   >   并对每一条仍在飞的 CLAUDE.md writer 用 `git merge-tree --write-tree <head> <B候选>` 逐条重证 fence,
   >   外加在新 source 上复跑 `cutover-merge-probe.sh`;
   > - **真 PR 台架只在机制变更时重跑** —— 布局、writer、guard 谓词、workflow 任一有逻辑改动就必须重跑;
   >   pin 字面量、archive 数据、散文不触发。
   >
   > **这条口径的边界,写清楚免得被引用过头**:merge-tree 是 **git 侧**的三方合并,
   > 不是 GitHub 自己算 mergeable 的那一侧。它能等价复核**机制**,**不能**替代 §6 对 GitHub 行为的证明 ——
   > 所以「机制变更」这个触发条件是承重的,不是形式。
   > (FLY-2046 独立 QA 的 F3 认证了 merge-tree 作为台架等价复核路径。)

**两套 ledger schema(R17 HIGH 2)。** v17 在上面写了两阶段,却把下面这张**单阶段** ledger 原样留着 ——
「零未处置才允许 ship」+ `post-B-migrate` 的证据是 B 之后的 run URL,正是 R16 点名的那个时间矛盾,
只是换了个位置。拆成两张:

**① 阶段一 ledger(D14 / PR body)—— ship 前必须零未分类**

| 列 | 取值 |
| -- | -- |
| PR + **exact head SHA** | fence 证据必须绑 head;head 变了结论作废(§10 步骤 18) |
| diff 形态 | `top-row writer` / `historical-table refresh` / `unrelated CLAUDE edit` |
| pre-B disposition | `land-before-B` / `close-or-supersede` / **`post-B-migrate-pending`** |
| **机械 fence 证据** | 该 exact head 与 final B candidate 的**三方合并确实 conflict** —— **不是**未来的 CI URL |

**② 阶段二 ledger(Linear FLY-2045 评论)—— B merge 之后**

每个 pending 项记 `migrated + 新 exact-head green`,**或** `closed/superseded + closure evidence`。
**已关闭的 PR 不需要伪造一个 CI green。**

**fence 的成立域要写窄(R17 实证)**:

- 当前 **#946 / #943 / #941** 的 exact head 都是**单条旧表插入**,已逐条实证三条都 conflict;
- `historical-table refresh` 很可能 conflict,但**仍须对其 exact head 做同样的三方证明**,不得类推;
- **`unrelated CLAUDE edit` 若完全位于被删块之外,可能 clean merge —— 它不受 B 的机械 fence 保护**,
  也不需要 milestone migration。**必须单独 disposition**,不能笼统塞进 `post-B-migrate-pending`。

原表(供填写):

| 列 | 取值 |
| -- | -- |
| diff 形态 | `top-row writer`(在表头下加自己那一行)/ `historical-table refresh`(整表刷新,如 #216)/ `unrelated CLAUDE edit`(改的是别的段) |
| disposition | `land-before-B` / `close-or-supersede` / `post-B-migrate` |
| 证据 | `land-before-B` = merged PR URL + merged head / merge commit / mergedAt,**并证明 delivery PR 最后一次 D9 的 source SHA 已包含该 merge**(否则「已落地」与「被 archive pin 吸收」之间没有审计连接);`close-or-supersede` = close 记录;**`post-B-migrate-pending` = 该 exact head 的三方合并 conflict 证据**(阶段二的 green 记在 Linear ledger) |

`historical-table refresh` 与 `top-row writer` **不是同一件事**,解法也不同(前者整块作废,后者只丢一行),不能笼统写「删掉自己那一行」。
**`unrelated CLAUDE edit` 更要单列**:下面那条「冲突处整份取 pointer-only 版本」**只适用于 top-row writer 与已作废的 historical refresh**;改的是 CLAUDE.md 别的段落的分支,rebase 时必须**保留它自己的非表改动**,只丢弃表相关的部分(R5 #5)。

**2026-08-24 dated snapshot**(不是当前事实,合入前必须重跑并填满上表):42 个 open PR 中 **7 个**改 `CLAUDE.md` —— #946(FLY-2034,活跃)、#943(FLY-2026,活跃)、#941(FLY-2027,活跃)、#772、#343、#338、#216(**这条是 milestone refresh,不是 top-row writer**)。
⚠️ 不保证这 7 条都只因 CLAUDE.md 冲突;具体 PR 仍可能因其它文件本来就 DIRTY。Codex R3 复核时 `api.github.com` 不可达,未能独立刷新。

---

## 8. residue guard 复核(实测,不推断)

| suite | B 案下预期 | 必做 |
| -- | -- | -- |
| `fly1674-residue.test.sh:41-43` 的 3 个 `CLAUDE.md\|...` allowlist 键 | **确定失效,不是"可能"** —— 已实测:`no-three-stage` 与 `three-stage-policy` 只出现在表内第 146 行,`three_stage` 只出现在表内第 45 / 146 行;删块之后新 `CLAUDE.md` 三者全部零命中,而 `:80-87` 的 liveness 循环会直接 `fail "dead compatibility exemption"` | **D12 = 无条件删除这三个 exemption**,**不新增 archive allowlist**(Codex R4 #4)。理由:`:136-143` 的 active scan 本来就排除 `engineering/doc/**`,archive 根本不进扫描;把键改指一个被排除的历史文件,只会造出一个「没有扫描作用、却被 liveness 强制保活」的僵尸 exemption,正是 FLY-1455 治的那类账目污染。删完跑一次 suite,确认 archive 被既有排除历史化、active residue 仍全绿 |
| `v2-retirement-cleanup.test.sh` | ARCHIVE 落在 `engineering/doc/**`,被既有排除覆盖 | 跑一次确认,**不新增排除** |
| `fly1680-v1-extinction.test.sh` | 同上 | 同上 |

---

## 9. 交付物

| # | 路径 | 动作 |
| -- | -- | -- |
| D1 | `engineering/doc/milestones/README.md` | 新增 —— 格式 + **单写者合同** + §7.1 三种不保证的情况 |
| D2 | `engineering/doc/milestones/ARCHIVE-pre-FLY-2045.md` | 新增 —— 哨兵之间**逐字节**搬入历史块 |
| D3 | `CLAUDE.md` | **删除**里程碑块,换 ~6 行指针;其中被 G2 exact-count 的 anchor 行按 §2.4 逐字固定 |
| D4 | `.flywheel/agents/engineering/engineer-executor.md` | 第 29 行改写 |
| D5 | `.claude/commands/spin.md` | 只改 342 / 369;**359 一字不动** |
| D6 | `.claude/commands/orchestrator.md` | A0 加 Flywheel 里程碑步,**按 §4.1(1) 的幂等 ensure 合同**(base collision fence / branch-local handoff 不覆盖 / 两者皆无才 add+commit);F 加 Flywheel skip 分支 + VERSION 矛盾的具名 TODO;**non-Flywheel 语义不动** |
| D7 | `scripts/__tests__/fly2045-milestone-layout.test.sh` | 守卫 G1–G6 |
| D8 | `scripts/__tests__/fly2045-milestone-layout-mutations.test.sh` | §5.4 的 **N1–N13 negative + P1/P2 positive**;**条数与身份从 §5.4 那张表机械 pin**(§5.0 铁律 2) |
| D9 | `scripts/fly2045-pin-archive.sh` | §5.1 的 preflight + `cmp` + 双 pin |
| D10b | `scripts/__tests__/ci-shell-suite-manual-only.txt` | 登记 D8(§5.3 要求 quick-gate step 的 `run` 逐字只有 D7)—— v16 只在动作里提了它、路径列没列,实施者会照路径清单漏改(R16 LOW) |
| D10 | `.github/workflows/ci.yml` | quick-gate 加一步跑 **D7**。**D8 进 `ci-shell-suite-manual-only.txt`**(§5.3 要求该 step 的 `run` 逐字只有 D7),并在自验证据中强制执行 |
| D11 | `scripts/__tests__/ci-structure.test.sh` | 加 §5.3 的结构断言 |
| D12 | `scripts/__tests__/fly1674-residue.test.sh` | **无条件删除** 3 个 `CLAUDE.md\|…` exemption(§8;不新增 archive allowlist) |
| D13 | `engineering/doc/milestones/FLY-2045.md` | 本单里程碑 —— **新机制的第一次真实使用** |
| D15 | `.../cutover-merge-probe{,-controls,-mutants}.sh` | 已随设计交付(可复跑);实现阶段只需在最终 candidate 上用 `--source-sha` 复跑 |
| D14 | `.../acceptance-evidence.md` | §6 的真实输出 + 探针 PR 号 + §6.4 第 4 条原话 + §6.3 台架生命周期 + D9 的 source SHA/hash/bytes + **`implementation_sha` 与台架 parent/tree/唯一 diff** + **§7.2 阶段一的 inventory 快照与逐 PR disposition**(阶段二的证据在 Linear ledger,不在这里) |

---

## 10. 实施顺序

> **排序理由(R16 HIGH 3)**:v16 把 final rebase + D9 放在步骤 12、真 PR 验收放 13、fresh inventory 放 15。
> 但只要 inventory 产生一个 `land-before-B`,main 就会前进 ⇒ 步骤 12 的 pin、exact-head CI 与步骤 13 的
> 台架绑定**全部过期**。所以 inventory / land-before 必须排在 final D9 **之前**。

1. ~~拿 A/B 决定~~ —— **已裁定 B**(§3)。
2. 写 D7 + D8,确认在当前布局下红(只是"守卫确实会跑"的起点,不是隔离证明)。
3. D1 建目录 + README;D9 pin 脚本(含 §5.1 的 preflight)。
4. D2 逐字节搬入 + D3 从 CLAUDE.md 删块换指针。**不做任何清洗** —— 不合并块内那 7 个空行、不补表头、不排序、不改标点。
5. D4/D5/D6 写入面(§4/§4.1),每个文件改完全文 grep 旧写法。
6. D13 用新机制写本单里程碑(**executor 是唯一 creator**,§4.1(1))。
7. D10/D11/D12 接 CI 与 residue allowlist;跑 `ci-shell-suite-enumeration` + `ci-structure`。
8. §8 三个 residue guard 各跑一次;**D12 无条件执行**,删完复跑确认(注意 §12 的既有 baseline red)。
9. §5.5 裁剪后的验证集合全绿。
10. 全仓 `pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`。
11. `codex:rescue` code review,loop 到 APPROVED。
12. **freeze + fresh inventory**(§7.2 阶段一):冻结旧格式里程碑 ship,逐 PR 分类,完成所有
    `land-before-B` / `close-or-supersede`,其余标 `post-B-migrate-pending` 并确认 fence 成立。
13. **final rebase / fetch** 到 `origin/main`(此时 main 已因步骤 12 稳定)。
14. **重跑 D9**:preflight + `cmp` + 重算双 pin;重跑 D7/D8/probe。
15. 取得 **exact-head CI + code review**(按 repo 既有门);记录 **`implementation_sha`**。
16. **§6 真 PR 门**:台架 base 的 parent 必须精确等于 `implementation_sha`(§6.1 步骤 0b);
    含 §6.2 反向对照、§6.3 台架 trigger;写 D14。
17. 交付前确认 `git diff origin/main...HEAD -- .github/workflows/ci.yml` 只含 §5.3 那一步,
    **不含 §6.3 的台架改动**。
17b. **push D14,并对最终 delivery `headRefOid` 取得 exact-head `pull_request` green**(R17 HIGH 3)。
    写 D14 会**改变 delivery head**;`0c` 说的"evidence-only 不必重跑 §6"**不等于**"不需要新 head 的 CI" ——
    issue 明确不许放松 exact-head green gate。若本仓的 Codex review approval 也绑 exact head,
    这里同时取一次 **evidence-only final review**;不得把"在 `implementation_sha` 上评审过"
    默认当成"最终 PR head 已评审"。
18. **最后一次 inventory / origin-main freshness 检查** → founder merge。
    - 若它改动了 D14 / PR 内证据 / 任何 tracked file ⇒ 再次 push 并**重复 17b**;
    - 若发现新的 `land-before-B` 或 main 前进 ⇒ 按回跳规则回步骤 13(按 §7.2(4) 的 v19 口径:
      **merge-tree 等价复验**,不自动重跑 §6);
    - 若只是新增一个**已机械 fence** 的 pending 项 ⇒ 更新证据 + 重复 17b,**不必**重跑 §6。
19. **阶段二**(B merge 之后):逐条迁移剩余 `post-B-migrate-pending`,每条取得新守卫下的 exact-head green;
    记录在 Linear 的 disposition ledger 评论。**全部完成前 FLY-2045 不算 Done。**

> **回跳规则**:任何时刻 main 前进 ⇒ 回到步骤 13,并按 §7.2(4) 的 **v19** 口径做 merge-tree 等价复验;
> 任何被守卫覆盖的实现改动 ⇒ 回到步骤 14;其中**机制**改动(布局 / writer / guard 谓词 / workflow)
> 才重跑 §6,pin 字面量与数据/散文不触发。

## 11. 风险

| 风险 | 处置 |
| -- | -- |
| 台架 workflow 泄漏进交付 PR | §6.3 约束 2 + §10 步骤 14 的显式 diff 检查 |
| pin 循环自证 / authority 传错 SHA | §5.1 的 preflight(40-hex / fresh fetch / == origin/main / ancestor / 结构唯一)+ `cmp` 先行 + D9 authority 控制 |
| `$( )` 剥掉 trailing newline 让字节证明失效 | §5.1.1 字节流合同 + fixture N3(hash)与 N4(byte pin **独立**对照) |
| byte-count pin 没被真正实现却看起来在生效 | fixture N4 独立对照 |
| 半成品守卫全绿 | §5.4 的 N1–N13 + P1/P2;每条只针对一个承重不变量,并保留正向 fixture |
| 旧绿 head 在 cutover 后仍被当作有效证明 | §7.2 的 cutover hard gate(fence,不是通知) |
| pin 随 main 前进失效 | §1 注意 + D9 + §10 步骤 12 + §7.2(4) |
| 误改 non-Flywheel 通用流程 | G4 正向锚 + fixture N8 反向验证 |
| A0 新文件未 stage,里程碑没进 PR | §4.1(1) 的 absent-path 分支写死 `git add` + cached commit;G4 锚它;fixture N11 |
| A0 覆盖 executor 已建好的文件 / 与 D4 自冲突 | §4.1(1) 幂等 ensure;fixture N9(base fence)、N10(handoff 不覆盖) |
| orchestrator 按 issue 前缀而不是 repo 判 Flywheel | §4.1(2) + fixture N13 |
| probe 的 heading 锚用子串匹配,decorated heading 蒙混过关 | 已修为 `grep -Fx`;`decorated-doc-heading` 控制 + 控制**条数**本身 fail-closed(`EXPECTED_CONTROLS`) |
| GEO 单漏账 | §2.2 文件名规范支持 `^(FLY\|GEO)-` + P1 正向 fixture |
| `fly1674` 僵尸 exemption | D12 无条件删除三项,不改指 archive(§8) |
| source block **少抽**(exact Doc heading 被提前到表中,后半表无声丢失) | §5.1(5) 的 exact-heading + 全文完整性断言 + D9 控制 ⑨ |
| source block **多抽**(表与 Doc heading 之间的活内容被一起删掉,而 pin 给它盖章) | §5.1(6) 的**三层** canonical-row closure + 严格分隔行 + probe 的 8 条 over-capture 控制 + D9 控制 ⑪–⑱ |
| CI 上没有 checksum 工具 | §5.1.1 三级回退 + fail closed + no-tool 控制 |
| probe 自身坏掉却报绿 | probe 已改 fail-closed + **whole-line** exact 定界 + 少抽/多抽双向断言 + 自带控制组;控制做成**可复跑的脚本** `cutover-merge-probe-controls.sh`(**37 条**:负向覆盖表头/边界/over-capture/token/status/分隔行/cutover 形态,正向覆盖 6 个 marker + 短正文 + 精确计数 + spoof-path + 3 个合法 pipe/backtick 形态:无表头 / 双表头 / 无 Doc heading / 双 Doc heading / heading 在表前 / 迷你表 / 表外有里程碑行 / 表内 prose 行 / 表内 rogue heading / pipe 前缀的非里程碑行 / 整张无关表 / **FLY-GEO token 碰撞** / **legacy v token 碰撞** / **缩进行** / **缺 status 列** / 畸形分隔行 / decorated heading / cutover 后形态),实测 37/37,且条数本身 fail-closed;另有 `cutover-merge-probe-mutants.sh` 11/11,每个分支由**预期失败集合**打红,comparator 先自证,self-control 要求结构化 rc=1 |
| 同一谓词两份实现悄悄漂移 | §5.0 铁律 4:**一份实现**;计数输出断言精确值;每个 marker 一条正向 fixture(R11 #1 实测:只改第二份就让真实 `⚠️` 行从 177 掉到 176 而全套仍绿) |
| 人类日志被当成机器协议(路径冒充 metric) | §5.0 铁律 2 推论:专用整行记录 + 精确锚定 + 恰好一行 + `spoof-path` 控制 + 3 个 metric 分支 mutant(R12) |
| 整行记录被**内嵌换行的路径**逐字节伪造 | 记录改走**调用方自有通道** `--metric-file`;不可信字段单行编码;`newline-injection-path` 控制(R13) |
| 失败**身份**从人类文案截取,畸形记录被静默丢弃 | id 改走 `--fail-file`;严格整行文法 + **raw 数 == 解析数**;baseline 要求 rc=0 **且**通道为空;第二条 self-control 端到端证明(R14) |
| self-control 只搜字符串,sabotage 没发生也报「正确拒绝」 | `classify_mutant` 结构化 rc(0/1/2)+ comparator 改名 `canonical_lists_equal` 并写明前置条件,自检覆盖 相等/缺项/多项/空集/顺序/重复/id 合法性(R12) |
| mutant 同时破坏两个分支却被记成单分支 kill | mutant 合同改为**失败集合相等**+ harness 自己的负向控制(R11 #2) |
| probe 在 B 落地后跑不起来 | `--source-sha` seam 读 `git show <sha>:CLAUDE.md`;§12 要求用 D9 的 source SHA 复跑 |

### 11.1 发现但未处理(写进交付报告)

| 发现 | 数据 | 为什么不在本单做 |
| -- | -- | -- |
| `orchestrator.md` F 对 flywheel 仍会 post-merge 写 tracked `doc/VERSION` | 与 `spin.md:342-371`「Flywheel post-merge writes NO tracked files to main」矛盾;实测最近 12 个 merge 零个改过 `doc/VERSION`(事实上休眠) | 是 VERSION 记账的问题,不是里程碑冲突的问题。本单**留具名 TODO,不背书也不修**;Tadashi 已记入 backlog |
| `CLAUDE.md` 12–19 行的 `Active Explorations` 列表 | 同类共享写点(`spin.md` 要求 ship 时删条目),频率低 | 独立一件事,不顺手改 |

> 167 KB/session 的装载税**不再是"未处理"** —— B 裁定之后它由本单直接消除(CLAUDE.md 178,228 B → 约 11 KB)。

**明确不做**:不拆分历史 177 条为 177 个文件(§2.3);不加 `.gitattributes` / merge driver;不改 `ci-classify.sh` 的前缀/后缀表;不给 residue guard 加任何新的宽泛排除;不改 QA 硬门、不允许零 CI head(issue 明确排除项);不做任何 ship / merge-to-main / 部署 / 重启。

---

## 12. 自验清单(交付前逐项留证)

> ⚠️ **一条既有 baseline red,必须先记录再实施**(R16 LOW,我已复核):
> `v2-retirement-cleanup.test.sh` 在本机是 **4 PASS / 1 FAIL** —— 失败在 hermetic Lead dry-run 的
> companion-role detection(`companion role detection inconclusive (state='error')`),**它的
> residue / pathspec 子断言本身通过**。`git diff origin/main...HEAD -- scripts/ packages/` 为**空**,
> 所以这不是 FLY-2045 引入的,也不推翻 §8 的 pathspec 结论。
> ⇒ 「自验清单全绿」在当前环境**并非已经可达**。实施前记录 baseline、在预期执行环境复跑;
> 最终若仍红,**必须先解决或取得明确处置**,不得归因成 D12,也不得报告整单全绿。

- [ ] `bash scripts/__tests__/fly2045-milestone-layout.test.sh`(D7 核心不变量)
- [ ] `bash scripts/__tests__/fly2045-milestone-layout-mutations.test.sh` —— **按 §5.5 裁剪后**:
      每个核心不变量一条直接 negative fixture + 1 条 GEO positive fixture
- [ ] `bash scripts/__tests__/ci-shell-suite-enumeration.test.sh`
- [ ] `bash scripts/__tests__/ci-structure.test.sh`(含新加的 §5.3 直接断言)
- [ ] `bash scripts/__tests__/fly1674-residue.test.sh`(§8;**含 D12 的无条件删除**)—— 本机基线 62/0
- [ ] `bash scripts/__tests__/v2-retirement-cleanup.test.sh` —— **见上方 baseline red**
- [ ] `bash scripts/__tests__/fly1680-v1-extinction.test.sh` —— 本机基线 7/0
- [ ] `bash scripts/ci-classify.sh` 对纯里程碑 diff 的实测分类(证明 §2.1)
- [ ] `bash .../cutover-merge-probe.sh --source-sha <D9 的 source SHA>` + §6.2 反向 positive control
      (§5.5:D15 的 37 controls / 11 mutants 作为**设计期 evidence** 留档,不进每次交付门)
- [ ] D9 在最终 `origin/main@<sha>` 上 preflight + `cmp` 通过,pin 已重算
- [ ] `git diff origin/main...HEAD -- .github/workflows/ci.yml` 不含 §6.3 台架改动
- [ ] `pnpm lint`(全仓)
- [ ] `pnpm -r build`(全仓)
- [ ] `pnpm test:packages:run` —— 本单零 TS 生产改动,但按 engineer-executor 硬规则仍全跑;
      非绿项逐条归因(宿主 Terminal.app / npm cache / 负载 timeout 这类既有项隔离复跑),**不伪报整门全绿**
- [ ] `codex:rescue` code review APPROVED
- [ ] §6 真 PR 门 —— `acceptance-evidence.md` 里有真实输出,且台架 parent == `implementation_sha`
      (**没有真实输出就不算完成,本清单没有移交逃生口**)
- [ ] §7.2 **阶段一**:freeze + fresh inventory 完成,逐 PR 已分类,`land-before-B` / `close-or-supersede` 已落地
- [ ] §7.2 **阶段二**(B merge 之后):剩余 `post-B-migrate-pending` 逐条迁移并取得新守卫下的 exact-head green,
      记录在 Linear ledger。**全部完成前 FLY-2045 不算 Done。**
