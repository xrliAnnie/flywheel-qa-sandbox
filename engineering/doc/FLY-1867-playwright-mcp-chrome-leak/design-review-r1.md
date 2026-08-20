# Design Review — FLY-1867 plan.md (Round 1, cross-family)

Date: 2026-08-20
Reviewer: independent Claude reviewer (Codex unavailable — all 5 accounts in one shared quota window)
Status: CHANGES REQUESTED

## Summary

上游侧的事实核查几乎全对 —— `configFromEnv` / `mergeConfig` / headed 默认 / `--isolated` / profile 目录命名 / `setupExitWatchdog` 六条 load-bearing claim 我逐条在 3.4MB bundle 里验过,**全部成立**,而且 `mergeConfig` 用 `pickDefined` 剥 undefined 这个最容易翻车的细节(空的 `--headless` CLI 值会不会把 env 覆盖回去)刚好是安全的。仓库侧的三个事实却错了两个半:**P2 声称复用的 `FLYWHEEL_WORKTREE_AUTOCLEAN` 已被 FLY-1806 焊死并进了 tombstone**(现在是 `return true` 常量,且 flag-truth 守卫会主动拒绝这个 env),**P1 的注入面漏掉了 founder 自己终端里的 claude 会话**(我抓到了活的:Terminal.app → zsh → `claude` → playwright-mcp),而 `~/.claude/settings.json` 已经有一个在用的 `env` 块可以一处覆盖全部。

更要紧的是两条方向性问题。其一,**泄漏的主因很可能是我们自己造的**:`reapRunnerMcp` 在 6 个生产 teardown 位点 SIGTERM playwright-mcp 后 **3 秒**就 SIGKILL,而上游看门狗给 `gracefullyCloseAll()` 的预算是 **15 秒** —— plan 把一个一行可修的自伤当成了"结构性逃逸口",于是 P2 从"兜底"被抬成了"主修"。其二,**P1 会把 P2 的判据饿死**:`--isolated` 之后新 Chrome 根本不再带 `ms-playwright-mcp` 的 user-data-dir,P2 的候选域只剩 P1 之前的存量,plan 却写"两者顺序无依赖"。

## Claims I verified against real code

| claim | verdict | evidence |
|---|---|---|
| `configFromEnv` 读 `PLAYWRIGHT_MCP_HEADLESS` / `PLAYWRIGHT_MCP_ISOLATED`(以 `e.X` 形式) | **TRUE** | `coreBundle.js` `configFromEnv`:`const e = env ?? process.env;` … `options.headless = envToBoolean(e.PLAYWRIGHT_MCP_HEADLESS)`;两个符号各命中 1 次 |
| `envToBoolean` 认 `"true"`/`"1"` | **TRUE** | `envToBoolean`:`"true"\|"1"→true`,`"false"\|"0"→false`,其余 `undefined` |
| `resolveCLIConfigForMCP` 合并顺序 default → configFile → env → CLI | **TRUE** | `resolveCLIConfigForMCP`:`result2 = defaultConfig` → `mergeConfig(configInFile)` → `mergeConfig(envOverrides)` → `mergeConfig(cliOverrides)` |
| 显式 CLI flag 能覆盖 env,且**未传的 flag 不会反向清掉 env** | **TRUE**(比 plan 说的更值得写进去) | `configFromCLIOptions` 无条件写 `launchOptions.headless = cliOptions.headless`(可能是 `undefined`),但 `mergeConfig` 用 `pickDefined()` 过滤 undefined —— 所以 undefined 不覆盖。这是整个 P1 成立的关键,plan 没点出来 |
| macOS 默认 headed:`headless = platform()==="linux" && !DISPLAY` | **TRUE** | `resolveCLIConfigForMCP` 末尾逐字如此 |
| `--isolated` → `createIsolatedBrowser` → `browserType.launch()`,不调 `createUserDataDir` | **TRUE** | `createIsolatedBrowser` 只 spread `config.browser.launchOptions`;`createUserDataDir` 只在 `createPersistentBrowser` 里被调 |
| profile 目录名 = `mcp-chrome-<sha256(cwd)前7位>` | **PARTIAL** | `createUserDataDir`:`mcp-${config.browser.launchOptions?.channel ?? browserName}-${createHash(clientInfo.cwd)}`,`createHash` = sha256 前 7 位。前缀是**变量**(channel),不是字面量;当前 73 个目录确实全是 `mcp-chrome-*` |
| `setupExitWatchdog` 只在 stdin close / SIGINT / SIGTERM 触发(SIGKILL 逃逸) | **TRUE**,且有 plan 漏掉的关键数字 | `setupExitWatchdog`:三个 handler + **`setTimeout(() => process.exit(0), 15e3)`** —— 优雅关闭预算 15 秒 |
| Chrome 以 `detached: true` spawn | **TRUE** | `spawnOptions = { detached: process.platform !== "win32", … }` |
| 存量 73 目录 / 631MB | **TRUE** | `ls ~/Library/Caches/ms-playwright-mcp/ \| wc -l` = 73;`du -sh` = 631M;73/73 前缀均为 `mcp-chrome` |
| `mcp-descendant-reaper` 的 orphan 判据是 `ppid==1`,接不住本 issue | **TRUE(但只说了一半)** | `mcp-descendant-reaper.ts:286-291` 确为 `ppid===1 && elapsed>=30min && matchesMcpFamily`。**但同文件还有 `reapMcpDescendants()`(:254),它在 pane kill 前主动 SIGTERM→SIGKILL 这些 MCP server** —— plan/exploration 完全没提。见 Issue 2 |
| `chrome-session-reaper` 的安全机件(comm 非 argv / 排除 `--type=` / lstart+argv 重核 / TERM→轮询→KILL) | **TRUE** | comm:`isChromeFamilyComm`(:379-385)+ `parseChromeProc`(:435-448);`--type=` 排除::399/:442;pid 复用重核:`revalidateAndKill`(:811-819)+ `sameHeadlessShot`(:664-675);TERM→poll→KILL:`handleHeadlessShot`(:596-646) |
| "扩展点是真的、不碰 agent-browser 路径" | **TRUE** | `reapChromeSessions` 主循环(:510-559)已是 `parseHeadlessShotProc` → `parseChromeProc` 的**多候选来源**结构,FLY-1828 已经加过一类;再加一类是同构操作 |
| TmuxAdapter 有真实 env 注入面 | **TRUE** | `extraPaneEnv()` 可覆盖 seam(:413-419,FLY-494,默认 `{}` 保证 codex/agy/kimi 字节一致)+ `envArgs` 数组(:506-729)最终作为 `-e KEY=VAL` 进 `tmux new-window`(:771-783) |
| 注入是字节兼容敏感面 | **TRUE** | `AMBIENT_IDENTITY_DENYLIST`(:68-75)+ `buildAmbientSafeWindowCommand` 的 `env -u` 边界(:169-181)+ `assertLaunchCommandBudgets` 的 tmux 命令字节预算(:154-162)。新增两个 key 不在 denylist 里 → 能活着传下去 |
| FLY-1185 的 ops 步骤从没跑过 | **TRUE** | `~/.claude/settings.json` 的 `enabledPlugins["playwright@claude-plugins-official"] = True`;`permissions.allow` 里 44 条 playwright 条目 |
| FLY-1330 janitor 的 module 结构 + 安全机件 | **TRUE** | module 派发 `module_enabled X && run_X`(:1107-1111,共 5 个);SHA-256 绑定 `dry_run_scope_json`(:1006-1016);receipt 比对 `dry_run_receipt_matches`(:1052-1060);apply 门 `die`(:1094);`resolve_lsof`(:472-479);delete-intent 审计 3 处 |
| **P2 复用 `FLYWHEEL_WORKTREE_AUTOCLEAN` 作主开关** | **FALSE** | `worktree-cleanup.ts:64-66` 现为 `/** FLY-603: permanently enabled */ return true;`;`truth.ts:752` 是 tombstone `retiredBy: "FLY-1806"`;`flag-truth.test.ts:195-203` 断言 `validateFlagTruthEnvironment(["FLYWHEEL_WORKTREE_AUTOCLEAN=0"]).ok === false`。见 Issue 1 |
| **P1 两处注入即覆盖全部 playwright-mcp 来源** | **FALSE** | 实测活进程:`pid 33780 = claude --dangerously-skip-permissions`,祖先链 `Terminal.app → login → -zsh`,带一个 2 小时的 playwright-mcp 子进程。另有 `tmux -L atlas` 下的 Lead(独立 tmux server)。见 Issue 3 |
| `--isolated` 的代价只是丢 persistent profile | **FALSE / 不完整** | `createBrowserWithInfo` 分支序为 `remoteEndpoint → cdpEndpoint → **isolated** → extension → persistent`,isolated **排在 extension 之前**;且 `createPersistentBrowser` 独有 `ignoreDefaultArgs:["--disable-extensions", …]` 与 `...contextOptions` 合并,isolated 两者皆无。见 Issue 4 |
| "`--isolated` 一个磁盘目录都不再产生" | **PARTIAL** | profile 目录确实不再产生;但 `computeTracesDir` → `outputDir()` 在两种模式下都解析到 `<cwd>/.playwright-mcp`(或 tmpdir),trace/截图产物照落 |

## What's Good (Keep)

- **上游侧的取证质量很高。** 六条 load-bearing claim逐条成立,而且是真读了 bundle 而不是读文档 —— `createIsolatedBrowser` vs `createPersistentBrowser` 的对照、`isProfileLocked5Times` 那条错误消息当反证,都是硬证据。
- **research §5 那段自我更正应该保留在正文里。** "我 grep 的正则是 `process\.env\.(...)`,而真表在 `configFromEnv(env)` 里用局部变量 `e`,我把'我没扫到'写成了'它不存在'" —— 这正是仓库反复吃过亏的那一类。别在定稿时把它删掉当"已解决"。
- **正向哈希归因 + "无法归因一律保留"。** 73 里 66 可归因、57 已死,判据是 allowlist 不是 denylist,7 个扫不到的明确不动。这比任何"看起来像垃圾"的启发式都硬。
- **exploration §1 推翻了 issue 自己的前提**(ppid 全活、孤儿 MCP server = 0),并把 issue 里"45 进程/1.5GB"明确排除出验收基线 —— 用可复现的磁盘数据当基线是对的。
- **落点选择的方向对。** 扩 `chrome-session-reaper` 而不是新写,理由(comm 非 argv 的误杀教训、pid 复用重核)属实且扩展点是真的;拒绝 `PWMCP_PROFILES_DIR_FOR_TEST` 也判得对。
- **P1 优先、代价最小的那条腿承担 founder 最直接的体感伤害** —— 排序动机是对的,只是排序本身有个副作用(Issue 8)。

## Issues & Recommendations

### 1. P2 的"回滚开关"引用了一个已被焊死并 tombstone 的 flag —— 严重性 HIGH

**问题。** plan §2 写"复用 `FLYWHEEL_WORKTREE_AUTOCLEAN` 主开关(现有 mutator 都挂在它下面)"。这在今天的 main 上是假的:

- `worktree-cleanup.ts:64-66` —— `/** FLY-603: worktree autoclean is permanently enabled in production. */ export function worktreeAutocleanEnabled(): boolean { return true; }`。它已经不是开关,是常量。
- `truth.ts:752` —— `{ envVar: "FLYWHEEL_WORKTREE_AUTOCLEAN", retiredBy: "FLY-1806" }`,已进 tombstone。
- `flag-truth.test.ts:195-203` —— 对 31 个 FLY-1806 退役 flag 逐个断言 `registered.has(envVar) === false`、`tombstones.get(envVar) === "FLY-1806"`,且 **`validateFlagTruthEnvironment([`${envVar}=0`]).ok === false`**。也就是说,把这个变量写进持久环境是会被守卫**主动判红**的。

**为什么重要。** 三层伤害:(a) P2 事实上**没有任何回滚杆**,而 plan 的风险表把"有开关"当成了误杀风险的兜底;(b) 文档会教未来的 operator 去设一个系统会拒绝的 env —— 出事时那一步不会生效,而他会以为生效了;(c) 这条恰好违反了 plan 自己援引的 FLY-1806 flag 纪律(复活一个刚被焊死的 flag 语义)。

**建议。** 照抄同一个文件里已经存在的先例,而不是发明新的:`chrome-session-reaper` 的 unattributed 路径就是 **默认 log-only**(`wouldKillUnattributed` + 一行日志,:771-780),真杀要显式 `FLYWHEEL_CHROME_REAPER_MIGRATE_UNATTRIBUTED=1`(`plugin.ts:7026-7027`)。新候选来源应当:① 默认只统计 + 日志,不杀;② 需要一次性清理时走一个同族的 **非 flag ops 旋钮**(与 `FLYWHEEL_CHROME_REAPER_ORPHAN_GRACE_MIN` / `_INTERVAL_MS` 同类,按 FLY-1455 登记进 `NON_FLAG_ALLOWLIST`);③ 在 plan 里**诚实写明**"稳态无 kill switch,回滚 = revert + 重新部署",不要用一个不存在的开关制造安全感。

### 2. 泄漏的主因很可能是 Flywheel 自己 3 秒后 SIGKILL,plan 把自伤当成了不可改的结构 —— 严重性 HIGH

**问题。** exploration §2 的因果表把 Chrome 存活归到"被 SIGKILL / 崩溃 / 整个 tmux pane 被硬杀 → 看门狗没机会跑",并据此认定只能靠回收器兜底。实测链条不是这样:

- `runner-teardown.ts:77` 的 `reapRunnerMcp()` 在**每次 pane kill 之前**调 `reapMcpDescendants(panePid)`,生产有 **6 个调用点**:`post-merge.ts:101`、`close-runner.ts:680`、`plugin.ts:2650 / 3885 / 6580`、`actions.ts:1647`。
- `reapCandidates` 的序列是 SIGTERM → `sleep(graceMs)` → SIGKILL,而 **`graceMs = deps.graceMs ?? 3_000`**(`mcp-descendant-reaper.ts:178`)。我 grep 过全仓:**没有任何生产调用点传 `graceMs`**,所以恒为 3 秒。
- 上游 `setupExitWatchdog` 收到 SIGTERM 后跑 `gracefullyCloseAll()`,并给自己 **`setTimeout(() => process.exit(0), 15e3)`** —— 即上游认为优雅关掉浏览器可能需要**最多 15 秒**。

也就是说:我们发 SIGTERM(看门狗**确实**开始关 Chrome 了),3 秒后 SIGKILL 打断它,而 Chrome 因为 `detached: true` 不跟着进程组死 → 变孤儿。**这不是"不温柔的死法",这是我们把温柔的死法掐断了。**

**为什么重要。** 它同时改变了三件事:(a) 存在一个 ~1 行的**根治**候选,而 plan 里根本没有这条腿;(b) P2 的定位应当从"治已漏出的孤儿"降级为"兜底",而现在 plan 用 ~120 行代码 + 一个新候选来源去承接一个可能被参数修掉的问题;(c) plan §5 把"逃逸形态没抓到现场"记为未验项,但真正没被追一层的是**谁在制造逃逸**。仓库记忆里那条"结构性拒绝要再追一层到『什么在铸这个约束』"正好命中。

**建议。** 加一条 **P0**,排在 P1 之前或并列:把 MCP teardown 的 grace 从 3 秒改成**大于上游 15 秒预算**的轮询式等待(TERM → 每 500ms 轮询进程是否已退 → 最多 ~16-18s → 仍在才 KILL),或者在 KILL 前先确认该 MCP server 的 Chrome 子树已消失。判据可证伪:改前/改后各跑 N 次真实 `close-runner`,数 `ms-playwright-mcp` 的 `ppid==1` Chrome 增量。如果这条把增量打到 0,plan 的 P2 就该重新定价(仍值得做,但作为 backstop 而非主修)。**在没做这个测量之前,不要把 P2 描述为"治已漏出的孤儿"的正解。**

### 3. P1 的注入面漏掉 founder 自己的 claude 会话,而 `settings.json` 的 `env` 能一处全覆盖 —— 严重性 HIGH

**问题。** plan §1 只覆盖两类进程:runner(TmuxAdapter)+ Lead(`~/.flywheel/.env`)。实测的第三类:

```
pid 33780  claude --dangerously-skip-permissions
  祖先链: Terminal.app(1466) → login -pf xiaorongli(1544) → -zsh(1545) → claude(33780)
  子进程: npm exec @playwright/mcp@latest (36961, et=02:00:28)
```

这是 **founder 自己在 Terminal 里开的 claude**,挂着一个活的 playwright-mcp。它既不经过 TmuxAdapter,也不 source `~/.flywheel/.env`。另外还有跑在**独立 tmux server** 上的 Lead(`tmux -L atlas` → `claude --effort medium … --channels plugin:discord@…`),它是否读 `~/.flywheel/.env` 取决于那个 launcher,plan 把 "Lead" 当成了一个统一面。

**为什么重要。** issue 的核心伤害是"可见窗口盖住 founder 桌面、点击落空"。**她自己那台终端里的会话,恰恰是她在键盘前时最可能正在跑的那一类** —— P1 按现在的范围交付,窗口照弹,而验收(`ps` 查 argv 含 `--headless`)只要挑一个 runner 去量就会显示通过。这是"判据写成 allowlist 不写 denylist"的经典形态。

**更要紧的是:research §5 列了 A–E 五个落点并宣称 B 胜出,但把最自然的那个漏了。** `~/.claude/settings.json` 顶层**已经有一个在用的 `env` 块**:

```json
"env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1", "ENABLE_TOOL_SEARCH": "true",
         "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING": "1", "MAX_THINKING_TOKENS": "128000" }
```

它是 Claude Code 的机器级会话环境,**MCP stdio server 作为子进程继承它**,一处即可覆盖 runner + 全部 Lead(含 `-L atlas` 那种)+ `claude -p` 子会话 + founder 自己的终端会话,且**零生产代码改动、零字节兼容风险**。它和 `~/.flywheel/.env` 一样是不进版本库的机器级配置(plan 已经接受了这个性质),而且 FLY-1185 的 `setup-mcp-on-demand.sh` 本来就是改这个文件的 —— 先例和工具都在。

**建议。** ① 把 `settings.json` 的 `env` 作为 **主落点**补进 research §5 的候选表并重新裁决;② 若仍保留 TmuxAdapter 注入,把理由写清(runner 级覆盖 / 与 Lead 解耦),而不是当作必需的两条腿之一;③ **验收必须包含 founder 自己终端起的会话**(从 Terminal 新开一个 `claude`,触发一次 `browser_navigate`,确认无窗口),否则等于没验最痛的那一类;④ 需要确认一件我没能在本机证到的事:`ps eww` 在 macOS 上读不到他人进程 env,所以"MCP server 继承 settings.json `env`"我只做到了**结构推断**(stdio 子进程继承),没做实测 —— **这条必须在实现前用一个真实探针坐实**(例如临时往 `env` 里塞一个哨兵变量,再从 MCP server 侧读回)。别把它当已验证的前提。

### 4. `--isolated` 会静默抢占 extension 路径,plan 的"唯一代价"说法不成立 —— 严重性 MEDIUM

**问题。** `createBrowserWithInfo` 的分支序是:

```
remoteEndpoint → cdpEndpoint → isolated → extension → persistent
```

`isolated` **排在 `extension` 之前**。所以机器级设 `PLAYWRIGHT_MCP_ISOLATED=true` 会让 `--extension` / `PLAYWRIGHT_MCP_EXTENSION`(连到真实 Chrome 的那条路)**永远走不到,而且不报错**。另外两处差异:`createPersistentBrowser` 独有 `ignoreDefaultArgs: ["--disable-extensions", …]`(即持久模式**允许**扩展加载)和 `...config.browser.contextOptions` 并进 launchOptions;`createIsolatedBrowser` 两者都没有。

**为什么重要。** research §4 的结论是"`--isolated` 值得采纳,代价 = 丢掉 persistent profile",plan §1 照抄。实际代价至少还包含"扩展能力关闭 + extension 模式被静默旁路"。这类"多了一个不会报错的行为改变"正是以后排查时最贵的那种。CDP 路径不受影响(`cdpEndpoint` 优先级更高),这点 plan 没说错。

**建议。** 在 plan §1 的取舍里补一行明确边界:`--isolated` ⇒ 扩展禁用 + `--extension` 模式不可达;如果将来要用 extension 模式,必须先 unset 这个 env。不需要改方案,需要改说法。

### 5. P3 会让**已经在生产跑的** janitor 静默停摆 —— 严重性 MEDIUM

**问题。** janitor 的 apply 门是:`dry_run_receipt_matches()`(:1052-1060)把当前 scope JSON 与磁盘 receipt 逐字比,而 scope JSON 的第一个字段就是 **`script_sha256` = `${BASH_SOURCE[0]}` 的 SHA-256**(:1006-1016);不匹配则 `die "apply requires a matching full-scope dry-run…"`(:1094)。

现场状态:

```
launchctl:  com.flywheel.log-janitor  已加载
plist ProgramArguments → /Users/xiaorongli/Dev/flywheel/scripts/flywheel-log-janitor.sh  ← 生产仓路径
~/.flywheel/state/log-janitor/full-dry-run-ok   存在(Aug 19 17:42)
~/.flywheel/state/log-janitor/first-apply-ok    存在(Aug 19 19:43)
audit.jsonl 11MB
```

也就是说它**已经完成首轮 apply、正在每日跑**。P3 一旦 merge、生产 `git pull`,脚本 SHA 变 → receipt 不匹配 → **下一个 04:15 的 apply 直接 die**,连带把已经在工作的 Codex/Claude 日志清理一起停掉,而且是安静地停(die 进 launchd 日志,没人盯)。

**为什么重要。** 这正是 plan 自己在 §4 里正确指出的那类问题(FLY-1185"代码 merge 了,人没跑")—— 但 P3 会亲手制造同一形态的第二起,而交付顺序里没有这一步。

**建议。** ① plan §6 的交付顺序里显式加一步:**P3 merge + 生产 pull 之后,必须按新 SHA 重跑一次 full-scope `--dry-run` 重新签发 receipt**,并把"下一次 apply 真的跑成功"作为 P3 的验收判据之一(不能只验"57 个目录归零");② 顺带纠正一处 plan 的遗漏:**P3 其实有回滚杆**而 plan 没提 —— `FLYWHEEL_JANITOR_DISABLE_MODULES`(:36 + `module_enabled` :466)可以单独禁用新 module,`--only <module>` 也能隔离跑。这条应该写进 P3 的回滚段(对照之下 P2 没有杆,见 Issue 1)。

### 6. P2 的验收命令用的正是 P2 设计里明令拒绝的 argv 匹配 —— 严重性 MEDIUM

**问题。** plan §2 的验收:

```bash
ps -axwwo pid,ppid,comm,command | grep "ms-playwright-mcp" | grep -v -- "--type=" | awk '$2==1'
```

这是**纯 argv 子串匹配、没有 comm 过滤** —— 就是同一节里引为教训的那个 FLY-766 footgun("当初用进程名 grep 误杀过 FLY-766 自己的 runner")。我跑等价命令时**当场复现了假阳性**:

```
65113  8660  claude   claude --agent-id runner-3aa411da@flywheel-eng-lead … (argv 里含 ms-playwright-mcp)
```

—— 一个正在干活的 **claude runner** 被这把尺子选中,只因为它的命令行里出现了这个字符串(审这个 issue 的 runner 本身就会中招)。

**为什么重要。** 尺子与判据不一致会双向出错:验收侧给假阳性(报"没扫干净"),而如果哪个 operator 拿这条命令去手工 kill,就会重演 FLY-766 的误杀。plan 的实现判据是对的(`comm ∈ CHROME_FAMILY_COMMS`),错的只是验收命令。

**建议。** 验收命令改成与实现同源的形态,并在 plan 里写明"comm 来自 `ps -Awwo comm=`,不看 argv":

```bash
ps -Awwo pid=,ppid=,comm=,command= \
  | awk '$2==1' \
  | grep -- "--user-data-dir=[^ ]*ms-playwright-mcp" \
  | grep -v -- "--type=" \
  | awk '{c=$3; sub(/.*\//,"",c); if (c ~ /^(Google Chrome|Google Chrome for Testing|Chromium|chrome|headless_shell)$/) print}'
```

阳性对照那条(人为造孤儿 → 命中 → 再验空)保留,很好。

### 7. headless 的爆炸半径用错了语料:GeoForge3D 是 WebGL 产品 —— 严重性 MEDIUM

**问题。** plan §5 把"headless 下某个能力静默退化"的 QA 硬前置定为"真跑一次 screenshot + resize 量高度"。136 次调用的普查是**用量普查,不是能力普查**;而这 14 天的语料以 Flywheel 自身开发为主。真正会静默退化的那格没被覆盖:**headless Chrome 走的是不同的合成/GPU 路径(软件 GL / SwiftShader),GPU 合成内容的截图与 headed 可能不同或失败** —— 而车队里的另一个产品 **GeoForge3D 就是 3D/WebGL 产品**,"QA runner 截 3D viewer 图"正好是 headed≠headless 的那一类。相反,DOM 高度测量(plan 引为 load-bearing 的那个用途)对窗口完全不敏感,是最安全的一格。

顺带一条**对方案有利、但 plan 没写**的事实:上游工具表里有 `browser_pdf_save`,而 Playwright 的 `page.pdf()` 在 Chromium 上**只在 headless 下支持**(headed 会抛)。也就是说这条能力是 headless **变好**而不是变差。同理 `browser_start_video` / `browser_stop_video` 走 `recordVideo`,headless 正常。

**为什么重要。** "验收必须覆盖难的那些情况"—— 只验最容易通过的那格,一个系统性回避难题的实现照样全绿。

**建议。** QA 硬前置里加**一格 WebGL/canvas 截图**(拿一个 GeoForge3D viewer 页面或任意 WebGL demo),并把结果如实记下来(通过 / 像素不同但可接受 / 失败)。同时把 `browser_pdf_save` 的 headless-only 性质写进 §5 —— 这是对方案有利的证据,不写等于漏报。

### 8. "P1 与 P2 顺序无依赖"是错的:P1 会把 P2 的候选域清零 —— 严重性 HIGH

**问题。** plan §3 写"P1 上线后不再产生新目录,P3 是一次性 + 滚动兜底。两者顺序无依赖",§6 的图也把 P1 → P2/P3 画成纯并行。但 P2 的判据第三条是 **"user-data-dir 在 `ms-playwright-mcp/` 下"**,而 `--isolated` 走 `browserType.launch()` —— **它根本不用 `ms-playwright-mcp` 下的目录**(Playwright 自建临时 profile)。

推论:**P1 交付之后,任何新泄漏出来的孤儿 Chrome 都不再满足 P2 的判据。** P2 的候选域从那一刻起只剩 P1 之前的存量,并随时间收敛到 0。plan 把 P2 描述为"清掉已漏出的孤儿"的常驻回收器,实际交付的是一个域在缩小到零的一次性清理。

**为什么重要。** 这直接影响 P2 该不该做、以及做成什么形状:如果它只是一次性清存量,~120 行进一个正在生产跑的回收器 + 新增一类候选来源的风险定价就不一样了(一个 ops 脚本可能更合适);如果它要当常驻兜底,判据必须**同时**认 isolated 模式的 profile 路径,否则 P1 之后它永远是空转 —— 这正是 plan 自己批评 `mcp-descendant-reaper` 的那句话("泄漏的东西从来不满足第一个条件,所以那个回收器对本 issue 永远是空转的")会原样落到 P2 头上。

**建议。** 二选一并写进 plan:(a) **诚实定位为一次性存量清理**,验收写"P1 之前的存量归零",并说明 P1 之后本判据结构性不再命中;或 (b) **补一条 isolated 模式的识别判据**(isolated Chrome 的 user-data-dir 形态需要先实测确认,不能推),让它真能当常驻兜底。无论选哪条,§3"两者顺序无依赖"这句必须改。另外这也回答了 Issue 2 的定价问题:先做 P0(grace 修复)+ P1,再重新量 P2 还剩多少事。

### 9. "一个磁盘目录都不再产生"是没有边界的绝对句 —— 严重性 LOW

**问题。** `--isolated` 消掉的是 `~/Library/Caches/ms-playwright-mcp/` 下的 **profile** 目录。但 `createIsolatedBrowser` 仍调 `computeTracesDir` → `outputDir()`,后者解析到 **`<cwd>/.playwright-mcp`**(cwd 不可写或是系统目录时退到 tmpdir),trace 与截图产物照落盘 —— 两种模式都一样,不是新增,但"一个都不再产生"不成立。

**建议。** 改成"不再产生 `ms-playwright-mcp/` 下的 profile 目录"。能写"等价"就别写"一模一样"。

### 10. "`--headed` 仍是 opt-in 出口"在实操上够不着 —— 严重性 LOW

**问题。** plan §1/§5 两次把上游 `--headed` flag 作为"人类想旁观"的保留出口。但 MCP server 是由**插件 cache 里那个带版本哈希的 `.mcp.json`** 拉起的,而 plan §4 已经(正确地)拒绝去改它 —— 所以没有任何受支持的路径能把 `--headed` 传进去。

**建议。** 把出口改写成真正可用的那个:在需要旁观的那次会话上设 `PLAYWRIGHT_MCP_HEADLESS=false`(`envToBoolean` 认 `"false"` / `"0"`,且 `pickDefined` 保证它不被空 CLI 值覆盖)。这条我验过,是成立的。

### 11. profile 目录前缀是变量不是字面量 —— 严重性 LOW

`createUserDataDir` 用 `mcp-${channel ?? browserName}-${hash}`。当前 73/73 都是 `mcp-chrome-*`,所以 P3 今天没问题;但一旦有人设 `PLAYWRIGHT_MCP_BROWSER` 或换 channel,就会出现 `mcp-chromium-*`。P3 的 allowlist 应按 `mcp-<token>-<7位hex>` 的**模式**匹配并对 token 保持开放(不认识的 token → 落入"无法归因 → 保留"),而不是硬编码 `mcp-chrome-`。

### 12. §5 未验项清单本身漏了两项,且有一项被当成已验 —— 严重性 LOW

- §5 未验项 3 把"MCP server 活着但 Chrome 该关没关"记为"有意的保守取舍,宁可漏收"。但结合 Issue 8,P1 之后它会**从边角形态变成唯一剩下的形态**。这条的性质变了,应重写。
- 未验项里应补上 Issue 3 末尾那条:**"MCP stdio server 继承 Claude Code 会话 env"我只有结构推断,没有实测**(macOS `ps eww` 读不到他人进程 env)。这是 P1 的地基,必须实测。
- 反过来,plan 把"现有 mutator 都挂在 `FLYWHEEL_WORKTREE_AUTOCLEAN` 下面"当成已知事实陈述,它是错的(Issue 1)。未验项清单的价值在于分辨"验过 / 没验",错误地把一条假陈述放进"验过"那一侧,比漏记一条未验项更伤。

## Verdict

CHANGES REQUESTED — address items above.

阻塞项(必须改):**1**(引用了已焊死+tombstone 的 flag,P2 实际无回滚杆)、**2**(3s vs 15s:泄漏主因很可能是我们自己的 teardown,缺 P0 根治腿)、**3**(P1 漏掉 founder 自己的终端会话;`settings.json` 的 `env` 落点未评估;env 继承未实测)、**8**(P1 会让 P2 判据结构性失效,"顺序无依赖"不成立)。

应在同一轮修掉:**4**(isolated 抢占 extension 路径)、**5**(P3 会 disarm 已在跑的 janitor,缺 receipt 重签步骤)、**6**(验收命令用了被自己否掉的 argv 匹配,已复现假阳性)、**7**(headless QA 缺 WebGL 那一格)。

**9-12** 是措辞与边界收窄,可随下一稿一并改。

方案的骨架我认同:两个环境变量的确是止血代价最小的那条路,扩 `chrome-session-reaper` 而非新写也判得对。需要改的是**因果链的最后一层**(谁在制造逃逸)、**注入面的覆盖集**(founder 自己那台在哪)、**三条腿之间的真实耦合**(P1 会不会把 P2 饿死),以及**两个被写成事实的假陈述**。
