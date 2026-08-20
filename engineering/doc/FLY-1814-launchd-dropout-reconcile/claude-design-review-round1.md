# FLY-1814 plan.md — Claude Stopgap Design Review (Round 1)

Date: 2026-08-18
Author: Claude (independent stopgap reviewer; formal Codex xhigh review pending quota reset)
Status: CHANGES REQUESTED

## Summary

计划形状是对的:分母落 repo、寄生既有触发点、零新 timer/flag/daemon、收敛尊重 disabled、反向普查只点名不删除。§2.2 的事实修正(8 个 aux 是 `=> disabled` 挡住的,不是 #866 救不回)是本单最有价值的一段——它把一个错误的机制结论换成了真的。行号引用逐条核对全部准确(`converge-nonlead-daemons.sh:256` disabled skip ✅、`restart-services.sh:2716` converge 调用点 ✅、`:2830-2843` 通知尾 ✅、`:2149` `do_restart_all_leads` ✅)。终稿五项范围(① 8 aux ② never-installed 含 codex-log-guard ③ qa528 ④ CI 盲区 ⑤ Lead 分批)映射齐全,没有漏项。

但有四个 HIGH 必须先解决:

- **收敛的两个锚点都挂在 `com.flywheel.updater` 下游**——正是这次消失 10 天、定义了本 issue 的那个 job。计划把它写成「三重兜底」,实测下来两条是同一条,第三条(登录重载)在不重启的机器上永不触发。
- **`policy=copy` 会亲手制造它自己要查的 zombie**:repo 里这批 plist 全部硬编码 `/Users/xiaorongli/...` 绝对路径。
- **plist `git mv` 会打断两条 hard-fail 路径**(release 打包门、r4 灾难恢复里恢复 updater 的那个函数),而计划提的「零残留 grep 断言」按其字面形态抓不到其中一条。
- **census 的 Lead 分母(数 `~/.flywheel/manifests` 文件数)必然长期误报**——QA test-slot manifest 也在那个目录里。

其余 14 条是 MEDIUM/LOW,多数是「把已经想对的东西写死到可执行的精度」。

## What's Good (Keep)

1. **事实修正没有为了省事顺着旧结论走。** 08-18 20:21 那次「disabled=0」是 parse pattern 对着 `true` 匹配、没对上 `=> disabled` 字面;计划推翻了它并给出双域读数,还把 provenance(6 个带 `*.bak-fly886-*` 戳、FLY-886 已 Canceled)标成「线索不是结论」。这正是 `feedback_conclusion_cannot_survive_on_inertia` 要求的动作。

2. **收敛 vs 检测的立场一致。** `converge-nonlead-daemons.sh:14-21` 的 header 把「startup self-check + alert」判过死刑,计划没有偷偷把它以 census 的名义放回来——census 只在既有通道上外露,不新建 timer。§6 把 Bridge FleetSensors 路线显式推到 follow-up 并说明理由(新 alert kind + 告警风暴是有疤的类),是正确的 scope 纪律。

3. **保质期表放在第 0 节。** 每条带 as-of + 复核命令 + 过期后影响,符合 `feedback_put_shelf_life_split_on_first_screen` 与 `feedback_process_docs_need_an_expiry_table`。

4. **仪器正对照被显式写进设计(D2.3 `instrument_suspect`)**,而不是等 QA 阶段补。这是 `feedback_positive_control_needs_its_own_control` 的正确应用位置(谓词本身待改,见 Issue 11)。

5. **`copy` 行的 drift 只点名不自动改写(§6)**,理由是「会碰 operator 手改现场」。这个克制是对的,且与 `#866` 只 bootstrap 不改文件的既有边界一致。

6. **D5 对同源盲区的因果解释是真的。** `converge-nonlead-daemons.test.sh` 的 seam(`_cnd_launchctl` / `_cnd_launch_agents_dir` / `_cnd_domain`,test 文件 :33-81)确实驱动的是 fixture 化的「已装目录」,「codex-log-guard 该不该在这套 plist 里」不在它的宇宙里。结论没有编。

## Issues & Recommendations

### 1. [HIGH] 两个收敛锚点都在 `com.flywheel.updater` 下游 —— 本 issue 的根因没有被结构性关掉

**Issue.** §3 写「收敛逻辑寄生在全舰保活最强的两个锚点上(重启波本身、被每个波收敛 + self-ship FATAL 校验 + 登录重载三重兜底的 updater)」。实测这两个锚点是同一条链:

- `update-flywheel.sh:95` → `restart-services.sh --reason updater`;`converge_nonlead_daemons` 在 `restart-services.sh:2716`。所以**重启波这个锚点由 updater 触发**。
- 全仓扫 `restart-services.sh` 的自动调用者:只有 `update-flywheel.sh:95`(+ `provision-fleet-host.sh:522` 的一次性 bring-up + 人手直跑紧急路径)。没有第三个常驻触发器。
- 「self-ship FATAL 校验」只**检测**不**恢复**:`self-ship-restart.sh:81-86` 在 updater 未 loaded 时 `return 69` 让 ship 失败,`:100-106` 在 kickstart 失败时同样 FATAL。它把 marker 留在盘上并要求「operator / the next deploy 重新 enable」——而 next deploy 需要 updater。这是一个闭环依赖,不是兜底。
- 「登录重载」在一台从不注销的常驻 macOS 上永不触发。

**Why it matters.** FLY-1814 的原始事故就是 updater 自己掉出去 10 天。计划交付后,如果 updater 再次掉出 domain,**没有任何东西会把它放回来**,census 也永远不会跑一次——和今天完全一样。08-18 那 6 个核心 job 之所以被 `#866` 捞回来,是因为有人**手动**跑了一次重启波。计划把这条人力依赖写成了自动兜底。

**Fix.** 本仓已有一个成熟的三挂点先例可以直接抄:`converge-flywheel-bin.sh:13` 的注释列出它的三个 mount point —— `claude-lead.sh` 每次 Lead 启动(non-fatal)/ `update-flywheel.sh` 日历 sweep(non-fatal)/ `restart-services.sh::do_restart_all_leads` pre-kickstart(FAIL-LOUD)。FLY-1814 只用了后两个。补第三个:

- 在 `claude-lead.sh` 的 Lead 启动路径挂**只读 census**(不做 bootstrap,避免 16 个 Lead body 并发抢 launchd)。任一 Lead 因 launchd KeepAlive 重生就会跑一次,**完全不依赖 updater**;
- census 发现 `com.flywheel.updater` 不在 domain ⇒ 走 `lead-alert.sh` 报一条(日签名,见 Issue 13)。这条告警是本单唯一能在「updater 已死」世界里发出声音的东西;
- 若判定 Lead 启动挂点代价太高,**至少在计划的 §6 诚实边界里写死这条残留 SPOF**,而不是把它描述成三重兜底。

### 2. [HIGH] `policy=copy` 会在非 founder 主机上亲手制造 zombie,并与在飞的 FLY-650 相撞

**Issue.** D1 定义 `copy` = 「plist 以 repo 为字节权威,缺装 → `cp` + `bootstrap`」。但 repo 里这批 plist 的内容是**机器专属的绝对路径**:

- `scripts/com.flywheel.updater.plist`:`ProgramArguments` = `/Users/xiaorongli/Dev/flywheel/scripts/update-flywheel.sh`;`PATH` = `/Users/xiaorongli/.local/bin:...`;`QueueDirectories` = `/Users/xiaorongli/.flywheel/self-ship-pending.d`;
- `scripts/com.flywheel.daily-standup.plist`:`/Users/xiaorongli/Dev/flywheel/scripts/daily-standup.sh`;
- `scripts/launchd/com.flywheel.codex-log-guard.plist:24`:`/Users/xiaorongli/Dev/flywheel/scripts/codex-log-guard.sh`。

这些文件同时**进 packaged 分发**:`package-onboard.sh:126-130` 的 `PO_SCRIPT_DIRS` 包含 `launchd`(整目录递归拷),`:102-103` 的 `PO_SCRIPT_FILES` 单列 updater + daily-standup。而 `provision-fleet-host.sh:520-522` 明确写着 darwin 主机的 aux job 部署「delegated to restart-services.sh」。

**Why it matters.** 在任何不是 `/Users/xiaorongli` 的 darwin 主机上,`copy` 会 `cp` + `bootstrap` 一个 `ProgramArguments` 指向不存在路径的 job —— 它会 loaded、会按 calendar 触发、会每次以非零退出失败。**这正是 D2.3 定义的 zombie(qa528 类)**。收敛机制生产它自己要查的故障类,是本计划最尖锐的自反问题。

另有相撞:`doc/engineer/plan/new/v1.58.0-FLY-650-portable-provisioning.md:66` 已批准把 `com.flywheel.updater.plist` 等**改为渲染期注入**、darwin 渲染默认值逐字等于今天。`copy`(repo 字节权威)与 FLY-650(模板 + 渲染)是两个互斥的权威模型。

**Fix.**
1. `copy` 行在 `bootstrap` **之前**必须校验 `ProgramArguments` 里的脚本路径在本机存在 —— 这与 census 的 zombie 谓词是**同一个判据**,复用即可,零新机制。不存在 ⇒ 不装、计 `failed`、点名「plist 路径不适用于本机」;
2. manifest 顶部显式声明 host scope(「本 manifest 的 `copy` 行只对 repo 与 `$HOME` 布局逐字匹配的主机成立」),并在 §6 写明 packaged/fleet 主机不走 `copy`;
3. §7 增一行 A4:与 FLY-650 的权威模型冲突如何收口(要么 `copy` 只覆盖 FLY-650 不接管的单元,要么等 FLY-650 落地后 `copy` 改读渲染产物)。这个答案不写,两单会在同一批文件上打架。

### 3. [HIGH] plist `git mv` 打断两条 hard-fail 路径;计划命名的引用点有一个不存在、有两个漏掉;「只挪位置不改内容」不成立

**Issue.** D1 提「所有引用(`package-onboard-files.allow`、`flywheel-daemon.sh`、r4-window 校验、文档)grep 全量改写,CI 加零残留断言」。逐条核:

| 计划说的 | 实测 |
|---|---|
| `package-onboard-files.allow` | ✅ 存在(`:37-38`),但**它不是会炸的那个**:`:63` 已有 `scripts/launchd/*` 通配,gate② 只要求「树里每个文件命中某条 pattern」,`:37-38` 变成僵尸行不报错 |
| `flywheel-daemon.sh` | ❌ **该文件没有任何对这 5 个 repo plist 的引用**(全文只有 `PLIST_DIR="${HOME}/Library/LaunchAgents"` 与 Lead plist 生成)。这条引用是编的 |
| r4-window 校验 | ✅ 真实且严重:`scripts/r4/r4-window.sh:538` `r4_restore_updater()` 读 `$R4_REPO/scripts/com.flywheel.updater.plist` |
| 文档 | ✅ 大量(runbook `doc/engineer/implementation/FLY-222-a0-a10-runbook.md:138`、`packages/token-usage/README.md:79` 等) |

**计划漏掉的两个,都是 hard-fail:**

- **`scripts/package-onboard.sh:102-103`** 把 `com.flywheel.daily-standup.plist` / `com.flywheel.updater.plist` 列进 `PO_SCRIPT_FILES`,而 `po_copy_curated_scripts()`(`:548-551`)对缺失文件是**硬失败**:`po_err "whitelisted script missing: scripts/$f"; return 1`。`git mv` 一落,打包直接红。
- **两个 plist 的自述安装注释**:`scripts/com.flywheel.token-usage-daily.plist:6,8` 与 `scripts/com.flywheel.daily-digest.plist:6,9` 的文件**内容**里写着 `cp scripts/com.flywheel.X.plist ~/Library/LaunchAgents/`。所以 D1 的「收编只挪位置不改内容」与「引用全量改写」自相矛盾:要么留下指向已不存在路径的操作说明,要么内容必须改(那 `git mv` 的 zero-diff 性质就不成立,需要在计划里说清并单独 commit)。

**并且计划提议的检测器抓不到 `package-onboard.sh:103`** —— 那行是**裸 basename**(`com.flywheel.updater.plist`),不含 `scripts/com.flywheel` 前缀,任何「路径形态」的零残留 grep 都会漏过。这与 FLY-205 sub#17 的多形态 sweep 教训是同一类,但计划只列了 `scripts/com.flywheel` 与相对路径两种形态。

**Why it matters.** `r4_restore_updater` 是**灾难恢复里把 updater 装回去的那个函数**。它在 FLY-1814 的故障态下正是最后一根救命绳。默默打断它 = 在下一次同类事故里失去恢复工具。打包门则会在 PR 的 CI 上就红,属于可承受,但会把 PR 卡在一个和本单无关的地方。

**Fix.**
1. 迁移清单逐条列入计划(至少:`package-onboard.sh:102-103`、`package-onboard-files.allow:37-38`、`r4-window.sh:538`、两个 plist 自述注释、`packages/token-usage/README.md:79`、`FLY-222` runbook `:138`);删掉 `flywheel-daemon.sh` 这条不存在的引用;
2. 零残留断言必须是**三形态**:`scripts/com\.flywheel\.[a-z-]*\.plist`(路径形)、相对路径形、**裸 basename 出现在 `PO_SCRIPT_FILES` / allowlist 这类清单文件里**(名单形)。第三种才是抓 `package-onboard.sh` 的那把尺子;
3. 明确 packaged 产物布局变化(`scripts/X.plist` → `scripts/launchd/X.plist`)并跑一次 `package-onboard` 相关测试作为验收证据;
4. 「只挪位置不改内容」改写成「代码引用改写 + 两个 plist 的自述注释同步(单独 commit,内容 diff 只有注释)」。

### 4. [HIGH] census 的 Lead 分母数 manifest 文件数 —— 必然长期误报

**Issue.** D2.3 最后一条:「Lead 分母:`~/.flywheel/manifests` 期望数 vs `launchctl list` 中 `com.flywheel.lead.*` 实载数,不一致点名」,摘要行示例 `lead=15/16`。

但 `~/.flywheel/manifests` 里**不只有生产 Lead**:`lead_restart_collect_candidates()`(`scripts/lib/lead-restart-lifecycle.sh:733`,`:760`/`:800` 把 `flywheel-test-*` 归为 `skip-test`)存在的全部理由,就是那个目录里混着 QA test-slot manifest;`scripts/test-teardown.sh:907-909` 写得更直白:「A production deploy's restart-services.sh iterates ALL manifests; ... restart-services.sh now skips flywheel-test-* manifests」。另有 `manifestless` 类(已 loaded 但没 manifest,`restart-services.sh:2258-2264`)会让实载数**大于**期望数。

**Why it matters.** 一个每次重启波都亮红、且红得有道理的指标,三周后就没人看了 —— 这是 `feedback_label_substituting_for_fact_bug_class` 的量化版本。更糟的是它会**掩盖真的 Lead 掉队**(FLY-1814 场景 D:mufasa/codex-infra-bot 掉队),因为分母天天不对,没人能从噪声里分辨出真信号。

**Fix.** 不要自己数文件。`lead_restart_collect_candidates` 已经是 `scripts/lib/lead-restart-lifecycle.sh` 里的可 source 函数,输出带 classification 的统一候选清单。census 直接消费它:期望 = `classification != skip-test` 的候选数,实载 = 同一清单里 domain 探测为 loaded 的数,`manifestless` 单列。零新逻辑,且与重启波用的是同一把尺子(这本身就消除了两套分母打架的可能)。

### 5. [MEDIUM] D4 按现在的写法会打断 `scripts/test-restart-services.sh`;seam 需要指定形态

**Issue.** D4 说「常量写死脚本头,不加 env 旋钮/flag」+「sleep 经变量间接,测试置 0」。但既有测试的驱动方式是 awk **只抽函数体**:

```
scripts/test-restart-services.sh:349-351
awk '/^do_restart_all_leads\(\)/ { capture=1 }
     capture && /^# Build$/ { exit }
     capture { print }' "$SCRIPT_DIR/restart-services.sh" > "$rn_restart_all_func"
```

抽出来的文本在 `bash -c 'set -uo pipefail; source "$1"; ...'`(`:358-380`)里跑,**不含脚本头**。所以一个定义在脚本头的 `LEAD_BATCH_PAUSE_SECONDS` 在这里是 unbound,`set -u` 下函数在批边界处直接中止 → `skipped:0 failed:0 total:1` 永远不会打印 → 既有 FLY-1603 断言(`:382-388`)变红。**这是确定会发生的 CI 失败,不是概率问题。**

顺带:`sleep` 本身也需要能被测试短路,否则任何未来落到 ≥5 个 restart 候选的 harness 会真睡 60 秒。

**Why it matters.** 计划把 D4 描述为「stdout 契约与调用点行为不变」,读起来像零风险改动,实际它会在实施第一天撞红一个和它无关的既有断言,浪费一轮排查。

**Fix.**
- 批长与暂停秒数用**函数内 `local`**(`local batch_size=4 pause_secs=60`),不进脚本头,不用 `${VAR:-60}`(那就是新 env 旋钮,违背铁律);
- sleep 走一个与 `_cnd_launchctl` 同款的单点 seam(如 `_dral_sleep() { sleep "$1"; }`),测试里 stub 成 no-op —— 这与本仓已验证的 seam 纪律一致,且不引入任何生产可配置面;
- 同时把 §5 的 gate 清单里加一句「跑 `scripts/test-restart-services.sh` 全套」,因为它不在 `scripts/__tests__/*.test.sh` 的 glob 里(它在 `scripts/` 根下),现在的 gate 描述会漏掉它。

另:180 秒纯 sleep 落在 `lead_result=$(do_restart_all_leads)` 的 command substitution 子 shell 里,而父进程的 `trap ... TERM`(`restart-services.sh:1365`)在子 shell 中已重置为默认 —— 这把「波跑到一半被 TERM 打断」的窗口扩大了约 3 分钟,结果是 `lead_result` 空 → `unreadable` 分支。概率低,但值得在计划里记一句(不必改设计)。

### 6. [MEDIUM] 「最迟 12h 被收敛」不成立 —— `fallback_sweep` 的控制流在两条常见路径上到不了 no-op 分支

**Issue.** D2.5 把收敛挂在 `fallback_sweep()` 的 `fallback: nothing to do` 分支上。看实际控制流(`update-flywheel.sh:201-212`):

```
201  fallback_sweep() {
202    git fetch origin main --quiet || { log "fallback fetch failed"; return 0; }   ← 网络抖动直接 return
206    if [[ head != remote || deployed != head ]]; then
208      "$SELF_SHIP_DEPLOY_CMD" || log "fallback deploy returned non-zero"          ← 有 drift 就走这里
210    else  log "fallback: nothing to do"                                           ← 只有这里挂收敛
```

两条到不了 no-op 分支的常见路径:
1. **fetch 失败**(网络/DNS/凭据)→ `return 0`,当天两次日历触发全部空转;
2. **有 drift 但 deploy 失败** → 走 `default_deploy`,而 `default_deploy:82-84` 在 checkout dirty 时 `return 3` **根本不会跑 restart-services.sh**;`:88-91` 的 discord pointer cutover guard 同样 `return 3`。checkout dirty 在这台机器上不是罕见态。

即:**恰好在「主仓卡住、没人部署」的时候——也就是最需要收敛的时候——收敛一次都不跑**。

**Why it matters.** §6 把「两波之间最迟 12h」写成诚实边界,但这个边界在最相关的故障态下不成立。这是 `feedback_absence_of_bad_news_is_not_evidence` 的结构版本:判据只覆盖了 happy path。

**Fix.** 把收敛调用从 no-op 分支移到 `fallback_sweep()` 的**入口**(fetch 之前)或用 finalizer 保证三条出口都跑一次。收敛是纯 launchd 侧动作,不依赖 git 状态,没有理由被 fetch 结果门控。

### 7. [MEDIUM] 「非阻塞尝试取 restart lock」用现有 helper 实现不了,而且会引入一个 2 小时的部署阻塞面

**Issue.** 计划要求 updater 路径「非阻塞尝试取 restart lock(拿不到 = 有波在跑,跳过)」。实测:

- restart-services 的锁是 `LOCK_DIR="${HOME}/.flywheel/restart.lock.d"`(`restart-services.sh:41`),acquire 逻辑是**脚本内的顶层函数** `acquire_lock()`(`:1308-1373`),该脚本 `set -euo pipefail` 且在 `:1375` 无条件执行 `acquire_lock`,**不可被 source 复用**;
- update-flywheel 用的是完全另一把锁:`ssq_lock_acquire`(`scripts/lib/self-ship-queue.sh:308`)操作 `$SELF_SHIP_LOCK_DIR`。**两者今天不共享任何锁 helper**;
- 若 updater 自己 `mkdir restart.lock.d` 来「取锁」,它就成了 owner;一旦崩溃/被 launchd 杀,残留锁目录会让**后续每一次** `restart-services.sh` 走 `:1322-1323`「Another restart in progress, exiting」并 `exit 0` —— 静默的、最长 7200 秒(`:1317` 的 stale 阈值)的部署阻塞。self-ship 的 marker 会照常堆积,而没有任何东西在跑;
- 另有一个具体 bug 面:`update_main` 在 `:221` 已装 `trap 'ssq_lock_release' EXIT INT TERM`,再装一个释放 restart lock 的 trap 会**覆盖**它(bash trap 是替换不是追加)。

**Why it matters.** 为了一个辅助性的 census,给唯一合法重启入口引入一个可以静默锁死 2 小时的失效模式,收益/风险明显失衡。

**Fix.** 不要取锁,**只读探测**。本仓已有逐字先例:`scripts/daily-standup.sh:38-56` 用 `[ -d "$RESTART_LOCK_DIR" ]` 判断「restart-services 正在部署」,只读、不创建、不释放、无所有权。updater 路径照抄:`[[ -d "${HOME}/.flywheel/restart.lock.d" ]] && { log "restart wave in progress — skipping census"; return 0; }`。收敛本身是幂等的(`converge_nonlead_daemons` 只对证明为 missing 的 label 做 bootstrap),即便探测有 TOCTOU 也最多多一次会失败的 bootstrap,代价可忽略。

### 8. [MEDIUM] manifest / `cp` 路径缺 seam,会把既有行为测试耦合到真实 manifest 内容

**Issue.** 既有 suite 的 seam 只有三个:`_cnd_launchctl`、`_cnd_launch_agents_dir`、`_cnd_domain`(test 文件 `:33-82`)。D2 新增两个外部输入(manifest 文件路径、repo `scripts/launchd/` 源目录)和一个新副作用(`cp`),计划一个 seam 都没提。

**Why it matters.** 如果 manifest 路径写死成 `${FLYWHEEL_DIR}/scripts/launchd/units.manifest`,那么既有的每一个行为测试(`reset_world` 建一个空的 fixture LaunchAgents 目录后调 `converge_nonlead_daemons`)都会**顺带把真实 manifest 的十几行 `copy` 单元往临时目录里装一遍**。后果:①既有断言(如「idempotent — 已在 domain 的不重复 bootstrap」)被无关行污染;②**往 manifest 加一个新单元会让一批与它无关的行为测试变红** —— 这是最典型的脆弱测试形态,会在半年内被人用「注释掉」解决。

**Fix.** 明确列出新 seam:`_cnd_units_manifest()`(打印 manifest 路径)、`_cnd_repo_launchd_dir()`(打印源目录)、`_cnd_install_plist()`(封装 stage+validate+mv,见 Issue 12)。行为测试用 fixture manifest;manifest 内容的正确性由 D5.1 的闭环测试单独守。**两类测试的分母必须分开**,这正是 D5 自己诊断出的病。

### 9. [MEDIUM] manifest 缺失/不可读的语义未定;`copy` 行与 disabled 门的先后次序未定

**Issue (a).** D2.1 只写了「manifest 读取失败/格式行错 → 该行 fail-closed 计 failed,整体 degraded」——那是**行级**语义。**文件级**缺失(旧 checkout、部分部署、packaged 树)未定义。如果实现默默回落到「只枚举盘上 plist」(即 v1 行为),状态会是 `healthy`,而「交付但从未安装」的盲区**原样复活且无声**。

**Issue (b).** 现有代码里 disabled 门在 `:256`,位置在 domain 探测**之前**、在 `considered` 计数之前。新的 manifest 分支(「manifest `copy` 行且盘上缺 plist → `cp` + `bootstrap`」)必须汇入**同一个**门,否则会出现:operator 显式 `launchctl disable` 了某个 label、但因为盘上没有 plist,新分支照样 `cp` + `bootstrap` —— 直接违背「不自动 enable」这条计划自己立的红线。注意 launchd 的 override DB 是**按 label 索引、与 plist 是否存在无关**,所以「从未安装 + 已 disabled」是一个真实可达状态。

**Fix.** (a) manifest 文件缺失/不可读 ⇒ `NONLEAD_DAEMON_CONVERGE_STATE=degraded` + 明确 detail(`units manifest unreadable: <path>`),**永不 healthy**;可考虑更严:与 `print-disabled` 解析失败同级,走 `unverifiable` + 收敛零动作。(b) 计划里写死一句:manifest 分支在做任何 `cp`/`bootstrap` 之前,先过 `disabled_labels` 门,与盘上枚举路径共用同一段代码。

### 10. [MEDIUM] census 的「我们的」判据是一张硬编码 label 前缀表 —— 正是被测库 header 判过死刑的形状

**Issue.** D2.3 第一条:「按 fleet 前缀(`com.flywheel.*` + `com.xiaohongshu*` + `com.codex.xiaohongshu*`)取「我们的」」。

而 `converge-nonlead-daemons.sh:23-31` 的 header 写着:

> A side roster ("register your daemon here") is the every-call-site-must-remember shape that leaks by construction, and **a hardcoded label list rots**.

**Why it matters.** 下一个卫星前缀(tidal-echo / joycon / 任何新项目)对 census 隐形,而隐形的方式与今天完全一样:没人会想起来去改那张表。计划的 §2.4 把「缺一个期望集」列为四条结构原因之一,却在反向普查里重新引入了一张代码内的名单。同时它也解释不了 `com.xiaorongli.weee-weekly.plist` 这类主机上真实存在的私人 job 该怎么归类。

**Fix.** 两条路都比硬编码好:
- **首选**:把卫星前缀放进 `units.manifest` 的一个 `# census-scope:` 段(分母落 repo,与 D1 的整体主张一致,而不是分裂成「manifest 管正向、代码管反向」);
- **更强**:「我们的」= plist 的 `ProgramArguments` 里出现 `${FLYWHEEL_DIR}` 或 `${HOME}/.flywheel` 路径 —— 按**载荷**判归属而不是按名字。这条判据不会 rot,且顺手把 qa528(指向 `/var/folders/.../tmp*`)归成 unmanaged 而不是靠名字碰巧命中 `com.xiaohongshu*`。

### 11. [MEDIUM] `instrument_suspect` 谓词写反了一半:`print-disabled` 为空是合法状态

**Issue.** D2.3 最后一条:「`launchctl list` 可见的 `com.flywheel.*` < 3 **或 `print-disabled` 空** ⇒ `instrument_suspect`」。

一台从没执行过 `launchctl disable/enable` 的干净主机,`print-disabled` 的 `disabled services = { }` 就是空的,这是**正确读数**不是仪器故障。而 `nonlead_daemon_disabled_labels()`(`:136-173`)已经把「解析失败」(`return 1`)和「解析成功但列表为空」(`return 0` + 零行输出)区分得很清楚 —— 计划的谓词把这个既有区分给抹平了。

**Why it matters.** 干净主机上 census 永久 `instrument_suspect` ⇒ 永远「不产出任何缺席结论」⇒ 整个反向普查在那台机器上静默失效,而且失效方式看起来像是安全设计。另一半(`< 3`)则把 founder 主机今天的规模写进了库,是 header 反对的同一类 rot。

**Fix.** `instrument_suspect` 的触发条件收敛为**可证的仪器故障**:`nonlead_daemon_disabled_labels` 返回非零(解析失败/不可读),或 `launchctl list` 本身返回非零/输出不可解析。数量阈值要么删掉,要么改成与分母相对的形式(「manifest 声明了 N 个 enabled 单元,但 `launchctl list` 一个都看不到」),这样它跟着 manifest 走而不是跟着某台机器的当前规模走。

### 12. [MEDIUM] `cp` 安装非原子;本仓已有 stage+validate+mv 的先例可直接抄

**Issue.** D1/D2 写的是 `cp` 到 `~/Library/LaunchAgents/` 然后 `bootstrap`。中断/磁盘满会留下截断的 plist。计划完全没提这个失败模式。

**Why it matters.** 截断的 plist 的下一波表现是:`nonlead_daemon_plist_label` 解析失败 → 计 `failed` + 点名(既有代码 `:233-238` 会兜住,不会静默),所以不是灾难。但它会把一个本可避免的、每波复发的 degraded 变成常态噪声,而且 `bootstrap` 一个半截 plist 的 launchd 行为是未定义的。

**Fix.** 抄 `r4/r4-window.sh:538-552` 的 `r4_restore_updater()`:同目录 `mktemp` stage → `chmod 0644` → 校验(它用 `plutil -lint` + 语义 jq 断言;这里至少 `nonlead_daemon_plist_label` 能解析出与 manifest 一致的 Label)→ `mv` 原子替换 → 再校验目标 → 才 `bootstrap`。这条路径已经在本仓被 review 过,直接复用比新写一个便宜。

### 13. [MEDIUM] updater 路径的告警签名/严重级/身份未指定 —— 这是有两次生产事故的类

**Issue.** D2.5 只写了「经 `lead-alert.sh` 报警(kind 如 `launchd_census_degraded`,severity warning,日签名去重)」。缺三样:

1. **签名必须与内容无关。** 正确先例是 `restart-services.sh:410` 的 `--signature "restart-guard-launchd-refusal-$(date -u +%Y%m%d)"` —— 固定前缀 + 日期,不含任何会变的明细。如果签名嵌进失败 label 列表,列表一抖动就是新签名 → 绕过 claims.db 去重 → 刷屏。**FLY-218 与 FLY-220 都是这个根因**(内容派生 eventId 绕过去重),不是假设风险。
2. **`lead-alert.sh` 在 update-flywheel.sh 里现成的封装是错的那个。** 该文件唯一的 helper 是 `severe_alert()`(`:63-73`):severity **severe**、`--signature "$1-$(date -u +%Y%m%d%H%M)"`(**分钟**粒度)、并且 `--mention-user` @founder。census degraded 直接复用它 = 每天 @ founder、且分钟级签名意味着同一天可发多条。
3. **测试污染面。** `update-flywheel.sh:34-38` 的注释明确写着:sourced 测试把 `ENV_FILE` 指向 `/dev/null`,就是为了避免 `severe_alert→lead-alert.sh` 往生产告警频道 POST(「FLY-218/220 spam zone;qa-fly-270 finding」)。新增告警点必须遵守同一纪律。

**Fix.** 在 D2.5 里写死:新建一个 `census_alert()`(severity=warning、`--lead updater`、`--signature "launchd-census-$(date -u +%Y%m%d)"`、**不 mention founder**、`1>&2 || true`),明细只进 body。并在 §5 的验收里加一条:sourced 测试路径下确认零真实 POST。

### 14. [MEDIUM] D3 迁移脚本是一条 FLY-913 看不见的 launchctl mutation 通道 —— 计划的描述与实际相反

**Issue.** D3 写「FLY-913:launchctl mutation 对 agent Bash 是硬拦;此脚本属 operator 通道,同 restart-services」。实测 guard 的判据(`scripts/hooks/flywheel-restart-guard.py:80-95`)是**对 Bash 工具收到的命令字符串**做模式匹配:

- P1 = `launchctl` + 变更动词(`:83`)**且**同串里有 `com.flywheel.` 或 `restart-services|self-ship-restart|update-flywheel`(`:84-87`);
- 只读子命令(`print`/`list`/`print-disabled`)永不命中(`:25` 注释 + P1 正则)——所以 census 从 agent Bash 跑也放行,这部分计划是对的。

但 `bash scripts/fly1814-restore-aux-jobs.sh --apply` 这条命令串里**没有 launchctl、没有变更动词、脚本名也不在 `RESTART_SCRIPT_RE` 里** ⇒ P1/P2/P3/P4 全不命中 ⇒ **guard 放行**,而脚本内部的 `launchctl enable` / `bootstrap` 在子进程里发生,hook 永远看不见(docstring `:10-12` 对 updater 就是这么描述的)。

**Why it matters.** 计划把这写成「被硬拦所以只能 operator 跑」,实际是「不会被拦,任何 agent 都能跑」。这个误判会直接影响 D3 的执行纪律 —— 尤其它要做的是 `launchctl enable` 8 个 label(撤销有记录的 operator 决定)+ `bootout` 一个 job。

**Fix.** 二选一,写进计划:
- **(a) 脚本自证 operator 身份**:非 TTY 或检测到 agent 环境时拒绝 `--apply`,只允许 dry-run;或要求一个显式的 `--i-am-operator` 参数 + 在 `lead-alert.sh` 留一条审计(与 guard bypass 的记账形状一致:审计写成功 + 告警确认送达,缺一不可);
- **(b) 让 guard 看得见**:把该脚本的标识加进 `RESTART_SCRIPT_RE` 并在 guard 里为「已知 launchctl-mutation 脚本」加一条 P5(脚本名 + `--apply`)。代价是改 guard,需要单独的 review。

无论选哪条,**先把「FLY-913 会拦住它」这个错误陈述从计划里删掉** —— 它会让下游读者据此放松纪律。

### 15. [LOW] 已经存在一份 launchd 期望集(`fleet/manifest.json .launchdJobs[]`),两份分母未做关系说明

**Issue.** `scripts/provision-fleet-host.sh:526` / `:578` 消费 `jq -r '.launchdJobs[] | [.label, .kind] | @tsv' "$MANIFEST"`($MANIFEST = `fleet/manifest.json`,`:76`),按 `kind=="aux"` 驱动 darwin/linux 的 aux job bring-up;`scripts/fleet-capture.sh:124,179` 生成它(「labels only, classified lead vs aux」)。

它是**抓取**产物(分母来自机器)而不是**声明**,所以不与 D1 的主张直接冲突。但它确实是第二份「哪些 launchd job 应该在」的清单,并且真的在被 provisioning 消费。

**Fix.** §6 或 §7 加一行:说明 `units.manifest`(声明,主机权威)与 `fleet/manifest.json .launchdJobs`(抓取,provisioning 输入)的关系,以及二者漂移时以谁为准。若判定不做收口,写明理由即可 —— 但不要让下一个人从零发现它。

### 16. [LOW] D5 新增的测试文件缺 CI 注册,会撞 `ci-structure.test.sh` 的精确相等断言

**Issue.** `.github/workflows/ci.yml:221` 注明「FLY-1759: script-tests are explicitly enumerated (no glob discovery)」;`:334` 逐字列了 `bash scripts/__tests__/converge-nonlead-daemons.test.sh`;而 `scripts/__tests__/ci-structure.test.sh:585` 断言 `fly1830_commands == ["bash scripts/__tests__/converge-nonlead-daemons.test.sh"]` —— **精确相等**。

D5 要新增 `launchd-units-manifest.test.sh` + 迁移脚本测试,不改这两处的话:新测试根本不在 CI 跑(而它正是 D5 的全部意义),或者一改 ci.yml 就把 ci-structure 撞红。

**Fix.** §5 的实施顺序里显式加一步:同步 `.github/workflows/ci.yml` 的 script-tests 枚举 + `ci-structure.test.sh:585` 的断言集合。另注意 `ci.yml:166` 提到的 FLY-1870 script-tests 20 分钟上限,新增两个 shell 套件要确认还有余量。

### 17. [LOW] 两处未经核实的事实

- **「三个 `$( )` 调用点」(D4)**:全仓实测只有**两个** —— `restart-services.sh:2380`(rollback)与 `:2614`(deploy)。第三个是历史的(`doc/engineer/plan/archive/v1.18.0-FLY-20-auto-restart-cd.md:548` 的 `do_restart_all_leads > /dev/null`),已不存在。这个「三」来自 `restart-services.sh:2168` 的注释,那条注释本身已过期。计划照抄了一个没核的数。**顺手把那条注释也修了**(它是下一个人踩同一坑的源头)。
- **「FLY-1330 janitor 走同通道」(§2.3 表)**:全仓 `grep -rl 'FLY-1330'` 只命中本计划自己,`scripts/` 下无任何 janitor 脚本或 plist。要么它在别的仓/尚未交付(那 ② 的验收就只有 codex-log-guard,应写明),要么这条是继承自上游未核的表述。`copy` policy 要求 plist_source 在本仓,一个不存在的交付物进不了 manifest。

### 18. [LOW] D4 没有留下任何可用于事后评价这个参数的观测

**Issue.** 4×4/60s 是 founder 拍板的,不重议。但计划同时写明「不加就绪门」,于是波内**不存在**任何「body 是否已经暖起来」的观测 —— 60 秒是否够、16 个 Lead 的冷启是否仍然重叠,交付后无法回答。

**Why it matters.** 下一次有人要调这个参数(或要论证它没用可以删),会和今天一样只能靠感觉。本仓已有现成的落点:`LEAD_BODY_OBSERVATIONS_FILE` sidecar(`restart-services.sh:2254-2256` 的 `record_successful_lead_body_observation`)已经在逐 Lead 记录。

**Fix.** 顺手在既有 sidecar 里多记一个 per-Lead 的 verify 耗时(从 kickstart 到 `launchd_lead_outcome_ready` 返回),完成消息里出现一行分布。零新机制、零新文件,但让下一次决策有数据。参数保持 founder 拍板的 4/60 不变。

## Verdict

**CHANGES REQUESTED.**

计划的形状、doctrine 一致性与行号准确度都在水准之上,五项批准范围一项不漏,§2.2 的事实修正是硬功。但下列四项必须在实施前解决,否则交付物要么解决不了 issue 的根因(1)、要么会亲手制造它要治的故障类(2)、要么会静默打断灾难恢复工具(3)、要么会产出一个天天误报因而三周后没人看的指标(4):

- **Issue 1**(收敛仍全挂在 updater 下游 —— 补第三个不依赖 updater 的挂点,或把这条 SPOF 诚实写进 §6);
- **Issue 2**(`copy` + 硬编码 `/Users/xiaorongli` 绝对路径;bootstrap 前必须复用 census 的 zombie 谓词;与 FLY-650 的权威模型冲突要有答案);
- **Issue 3**(`git mv` 的完整引用清单 + 三形态残留断言 + 承认两个 plist 需要改内容;删掉 `flywheel-daemon.sh` 这条不存在的引用);
- **Issue 4**(Lead 分母改用 `lead_restart_collect_candidates`,不要数 manifest 文件)。

Issue 5-14 的 MEDIUM 建议在同一轮一起折入(多数是把已经想对的东西写到可执行精度,成本很低);Issue 15-18 的 LOW 可随实施顺手带上。

补一句边界:本文是 Codex xhigh review 不可用期间的替代审查,所有判断基于本节点(worktree `/Users/xiaorongli/Dev/flywheel-FLY-1814`,2026-08-18 head)的**静态代码阅读**,未在生产主机上执行任何 launchctl 或部署动作;§0 保质期表里的所有实测读数按 ground truth 采信,未重新验证。
