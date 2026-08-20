# FLY-1867 playwright-mcp Chrome 泄漏 — 调研

Issue: FLY-1867 (https://linear.app/geoforge3d/issue/FLY-1867/playwright-mcp-chrome-泄漏实例从不回收且有可见窗口盖住-founder-桌面-点击落空)
日期: 2026-08-20
基于: exploration.md

---

## 0. 这份文档回答什么

exploration 定住了因果链，留了四个取舍没答。这份文档逐个用实测回答，并给出**落点**(改哪个文件)与每条路的代价。

调查对象:`@playwright/mcp@0.0.79`(`~/.npm/_npx/9833c18b2d85bc59/`)，本机 npx 缓存的实际运行版本。

---

## 1. 取舍一 — 默认 headless 会不会打断谁?

> *headless*(无头) = 浏览器照常干活，但不画窗口。*headed*(有头) = 画一个真窗口出来。

### 先量真实用途，不猜

我扫了最近 14 天全部 1200 份会话记录，统计 playwright 工具的**真实调用**(不是"工具被列在可用清单里"——那个数字是 1395/2163，是噪音)。

尺子先做了阳性对照:在一份已知调用过的记录上验证判据能量出 `browser_resize`，确认有效后才信零值。

| 工具 | 14 天调用次数 | headless 下可用? |
|---|---|---|
| `browser_navigate` | 77 | ✅ |
| `browser_evaluate` | 17 | ✅ |
| `browser_close` | 13 | ✅ |
| `browser_take_screenshot` | 9 | ✅ |
| `browser_click` | 6 | ✅ |
| `browser_snapshot` | 4 | ✅ |
| `browser_file_upload` | 3 | ✅ |
| `browser_run_code_unsafe` | 2 | ✅ |
| `browser_resize` | 2 | ✅ |
| `browser_console_messages` | 2 | ✅ |
| `browser_wait_for` | 1 | ✅ |
| **合计** | **~136** | **无一需要可见窗口** |

### 结论

**没有任何一个被实际使用的能力需要可见窗口。** playwright 是自动化库 —— 点击、上传、截图、量尺寸、跑 JS、读控制台，全部通过 CDP 协议完成，与窗口画不画无关。

> *CDP* = Chrome DevTools Protocol，浏览器对外的程控接口。agent 是通过这条协议操作页面的，它读的是页面的结构化数据，不是"看屏幕"。

可见窗口对 agent 的价值 = **0**;对 founder 的代价 = 抢焦点、盖住桌面、点击落空。这是一个纯负价值的默认值。

### 两条值得记下的副产品

1. **`browser_navigate` 77 次 vs `browser_close` 13 次** —— 大约每 6 次开页面只有 1 次主动关。这从使用侧印证了泄漏:绝大多数会话开完就走。
2. **`browser_resize` 的用途是量 founder HTML 页面高度**(交付前必须 ≤6000px，超了 Discord 预览会崩)。这是一个**真实且重要**的合法用途 —— 不能因为"用得少"就把 playwright 整个砍掉。这条排除了"直接禁用插件"这个看似省事的方案。

### 保留的例外

人类想**旁观** agent 在浏览器里干什么(调试用)。这是真需求但极低频，应该是显式 opt-in，不该是默认。

---

## 2. 取舍二 — 进程回收放哪一层?

### 现有两个回收器的判据(逐字读源码)

**FLY-1185 `mcp-descendant-reaper.ts`**

```ts
r.ppid === 1 &&
r.elapsedSeconds >= MCP_ORPHAN_MIN_ELAPSED_SECONDS &&   // 30min
matchesMcpFamily(r.command, families)                    // argv 含 @playwright/mcp
```

它抓的是 **MCP server 这个 node 进程**。实测泄漏的 MCP server 数 = 0(19 个全部父进程健在)，**永久空转**。

**FLY-766 `chrome-session-reaper.ts`**

```
comm ∈ Chrome 家族  且  user-data-dir 含 "agent-browser-chrome-"
→ 读 .flywheel-owner.json 拿到 execId → 查 owning session 是否终态
```

它抓 Chrome，但只认 `agent-browser` 那一支。playwright-mcp 的 Chrome 用的是 `~/Library/Caches/ms-playwright-mcp/mcp-chrome-<hash>`，**既不带那个前缀，也没有 owner 标记文件**。

### 为什么 owner 标记这条路走不通

FLY-766 的归属证明依赖两样东西，playwright-mcp 一样都给不了:

1. `TMPDIR` 重定向 —— TmuxAdapter 把 runner 的 TMPDIR 指到 `~/.flywheel/runner-state/<execId>/browser-tmp/`，于是 agent-browser 的 user-data-dir 天然带 execId。但 playwright-mcp 的 profile 路径是**写死**在代码里的 `defaultCacheDirectory()/ms-playwright-mcp`，**不看 TMPDIR**:
   ```js
   const dir = process.env.PWMCP_PROFILES_DIR_FOR_TEST ?? path.join(defaultCacheDirectory(), "ms-playwright-mcp");
   ```
   唯一的重定向钩子叫 `PWMCP_PROFILES_DIR_FOR_TEST` —— 名字里写着 FOR_TEST，是上游的测试钩子，生产依赖它等于把系统建在一个上游随时可以删的私有变量上。**不采纳。**

2. `.flywheel-owner.json` 标记 —— 由我们自己在 TMPDIR 里写。既然 profile 目录不在我们控制的路径下，也就没地方放这个标记。

### 但 playwright-mcp 给了一个**更强**的归属信号

profile 目录名 = `mcp-chrome-<sha256(clientInfo.cwd)前7位>`，而在我们的场景里这个路径实测就是 runner 的 worktree 路径(66/73 命中)。

> **⚠️ R3 纠正**:`clientInfo.cwd` 来自 MCP 的 `roots/list`(向 Claude Code 要的根目录清单,取第一个),**不是进程的 OS cwd** —— 只有客户端一个有效 root 都没给时才 fallback 到 `process.cwd()`。归因结果不受影响,但**反向推断不成立**:不能从一个 live 进程的 OS cwd 算出它的 profile 目录。这一条直接决定了 P2 不能用「读 live server 的 cwd 算 profile」当 ownership 证明(plan §3)。

这意味着(**注意下面两句都是有条件的**,R4 LOW-5 要求收窄):

> Chrome 的 user-data-dir 里编码的是 **第一个 client root 的 7 位哈希**。在**当前实测的 root 映射**下,它恰好对应 runner 的 worktree —— 但 7 位十六进制**不是无碰撞的 worktree 身份**,也不能反过来从进程算。

worktree 路径存不存在,是一个**文件系统事实** —— 不需要标记文件、不需要查数据库、不会因为 Bridge 重启而丢失。这一点仍然成立,而且是 P3 用一次性人工审阅 manifest(而不是运行时推断)的理由。

判据可以做到相当保守:

```
Chrome 主进程(comm ∈ Chrome 家族，argv 无 --type=)
  且 user-data-dir 在 ms-playwright-mcp/ 下
  且 ppid == 1                      ← 生它的 MCP server 已经死了
  且 存活 ≥ 宽限期
→ 才是候选
```

`ppid==1` 是关键安全垫:MCP server 还活着时,Chrome 不会是候选。

> **⚠️ 但这个保证有版本前提**(plan §3):它成立是因为**当前这版**上游由 MCP 进程直接 spawn Chrome、且 `detached` 只建进程组不 reparent。我们的启动命令是 `@playwright/mcp@latest`,**没有钉版本**;上游若引入短命 launcher 或转移 browser ownership,活会话的 Chrome 就可能变成 `ppid==1`。所以正确的表述是「**对已审阅的上游版本与拓扑成立**」,不是「永远不会」。

### 落点建议:扩 FLY-766，不新写

`chrome-session-reaper.ts` 已经有 885 行成熟基建 —— Chrome 家族的 `comm` 识别(**不用 argv 匹配**，这是它踩过坑后的教训:曾用进程名 grep 误杀了 FLY-766 自己的 runner)、`--type=` 排除渲染进程、杀之前重核 `lstart`+argv 身份防 pid 复用、TERM→轮询→KILL、审计。

新写一套等于把这些坑重踩一遍。新增的是**一类新的候选来源**，判据独立、不碰现有的 agent-browser 路径。

代价与风险:改动落在一个正在生产跑的回收器里，必须保证 agent-browser 路径**字节不变**。这是可测的(现有测试全绿 + 新增独立用例)。

---

## 3. 取舍三 — 631MB 磁盘归谁清?

### 现状:没有任何机制负责

两个回收器都只管进程。73 个目录 / 631MB 目前是**零机制**状态。

### 现成框架:FLY-1330 janitor(昨天刚 merge 进 main)

`scripts/flywheel-log-janitor.sh`(43KB) + `com.flywheel.log-janitor.plist`(每日 04:15 launchd)。它已经把清理这件事该有的安全性全做完了:

- schema-v2 **dry-run receipt** 绑定脚本 SHA-256 —— 换了参数或改了代码，旧 receipt 不放行
- 真实 **`lsof +D` 活体门** —— 有人正在用的目录不删
- 每次删除前先写 **delete-intent** 审计
- 持锁执行、INT/TERM 分别以 130/143 终止、jq 失败 fail-close
- 清理报告经 `publish-report` 投递到通知频道

**加一个 module 明显比新建一套便宜**，而且直接继承上面每一条安全性。

### 判据可以做到很硬

exploration 里已经用正向哈希坐实:73 个目录中 **57 个对应的 worktree 已经物理不存在**。判据就是这个:

```
mcp-chrome-<hash> 的 hash 能对应到某个已知 worktree 路径
  且 那个路径在文件系统上不存在
  且 目录 mtime 超过保留期
  且 lsof 证明没有进程在用
→ 可删
```

**必须默认保留无法归因的目录。** 73 个里有 7 个我归因不到(候选集覆盖不到 Lead 的工作目录等其他 cwd)。零命中只说明"我扫的范围里没有"，不说明它是垃圾。设计上要**allowlist 而非 denylist** —— 只删能证明是垃圾的，不删"看起来像垃圾的"。

---

## 4. 取舍四 — 能不能从源头少开?`--isolated`

> **⚠️ 本节结论已被后续设计评审推翻,`--isolated` 已撤出本期。**
> 下面保留原始分析(它对「上游怎么写的」的引用仍然准确),但**两个结论是错的**:
> 1. 「根本不创建磁盘 profile 目录」—— 错。它走 `browserType.launch()`,仍会在 `os.tmpdir()` 下 `mkdtemp` 出 `playwright_chromiumdev_profile-*` 并作为 `--user-data-dir` 传给 Chrome。只是**正常退出**时 Node 侧会删掉它;而在 MCP server 被 SIGKILL 这条我们真正关心的路径上,清理代码根本跑不了。
> 2. 「值得采纳」—— 错。启用它会让回收器的选择器**对所有新孤儿失明**(它们的 profile 不再在 `ms-playwright-mcp/` 下),基于目录计数的验收还会假绿。它必须等回收器能同时覆盖两种 profile 形态之后才能启用。
> 完整理由见 plan §6。

### 它到底做什么(读源码，不看文档)

```js
async function createIsolatedBrowser(config, clientInfo) {
  const browser = await browserType.launch({ ... });   // ← 完全不调用 createUserDataDir
}

async function createPersistentBrowser(config, clientInfo) {
  const userDataDir = config.browser.userDataDir ?? await createUserDataDir(config, clientInfo);  // ← 落盘
}
```

`--isolated` 走 `browserType.launch()`，**根本不创建磁盘 profile 目录**。CLI 描述逐字是 "keep the browser profile in memory, do not save it to disk."

### 它解决哪一半

| | 磁盘 631MB | 孤儿 Chrome 进程 | 可见窗口 |
|---|---|---|---|
| `--isolated` | ✅ **从源头消除** | ❌ 照样漏 | ❌ 照样弹 |

它是**预防**磁盘泄漏的最干净手段 —— 不产生垃圾，比产生垃圾再定期扫强一个量级。但它对进程和窗口这两条**完全无效**。

### 代价:丢掉的 persistent profile 有价值吗?

persistent profile 的价值 = 跨 MCP server 重启保留登录态/cookie。

但 profile 是按 **cwd** 分的，而 Flywheel 一个 issue 一个 worktree —— **登录态本来就不跨 issue 复用**。它唯一的价值是"同一个 issue 内、MCP server 重启前后"保留登录态。这个窗口非常窄。

反过来，persistent 还带一个**已知坏处**，写在上游的错误消息里:

```
Browser is already in use for ${userDataDir}, use --isolated to run multiple instances of the same browser
```

同一个 worktree 里两个会话同时用 playwright → profile 锁冲突 → 直接报错。`--isolated` 顺带消掉这个故障模式。

### 结论

`--isolated` 值得采纳，但它是**磁盘那一半的预防腿**，不能拿它冒充整个修复。已经堆下的 631MB 还是要清(取舍三)，孤儿进程还是要收(取舍二)。

---

## 5. 落点问题 — 这两个 flag 加在哪里才有效?

这是本次调研**最麻烦**的一块，因为最直觉的落点都是错的。

### 现状

playwright MCP server 由**官方插件**提供，定义在:

```
~/.claude/plugins/cache/claude-plugins-official/playwright/4d8c0bde0e99/.mcp.json
{ "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } }
```

光秃秃的一行，没有任何 flag。

### ⚠️ 更正 — 本节初稿的 B 是错的

初稿我判定「环境变量 ❌ —— playwright-mcp 只读 4 个 env，没有 headless 也没有 isolated」。**这个结论是错的，B 才是最优落点。**

错在判据:我 grep 的正则是 `process\.env\.(PLAYWRIGHT_MCP\w*)`，只匹配 `process.env.XXX` 这种写法。而真正的 env 表在 `configFromEnv(env)` 里，用的是局部变量:

```js
function configFromEnv(env) {
  const e = env ?? process.env;          // ← 换了个名字
  options.headless = envToBoolean(e.PLAYWRIGHT_MCP_HEADLESS);
  options.isolated = envToBoolean(e.PLAYWRIGHT_MCP_ISOLATED);
  ...                                     // 共 40 个 PLAYWRIGHT_MCP_* 变量
}
```

我的正则把答案挡在了窗外，然后我把「我没扫到」写成了「它不存在」。零命中只能说明扫的范围里没有。下面是修正后的对比。

### 五个候选落点，逐个验

| 落点 | 可行? | 说明 |
|---|---|---|
| **A. 直接改 plugin cache 的 .mcp.json** | ❌ | 路径带版本哈希 `4d8c0bde0e99`，插件一更新就换目录，改动蒸发。而且它不在我们仓库里，无法版本管理 |
| **B. 环境变量** | ✅ **最优** | `PLAYWRIGHT_MCP_HEADLESS=true`(**本期只此一个** —— `PLAYWRIGHT_MCP_ISOLATED` 已撤出,见 §4 顶部横幅)。见下 |
| **C. user-scope 加同名 server 覆盖** | ⚠️ | 会得到 `mcp__playwright__*` 与插件的 `mcp__plugin_playwright_playwright__*` **并存**(两个 server)。要避免并存就得禁用官方插件，而那会连带撤销 FLY-1185 §2.7 的「默认关、按需开」机制 —— runner 将无条件拿到 playwright。代价太大 |
| **D. fork 插件进 flywheel-plugins marketplace** | ⚠️ | 有先例(`discord@flywheel-plugins`)且与 FLY-1185 兼容，但要长期跟上游维护一个 fork，且工具前缀会变 |
| **E. `~/.playwright/cli.config.json` 全局配置** | ❌ | 逐行读了 `resolveCLIConfigForMCP`:**MCP 模式根本不读这个文件**，它只在 `resolveCLIConfigForCLI`(给 `playwright-mcp <sessionName>` 命令行用的)里被加载 |

### 为什么 B 明显胜出

MCP 模式的配置合并顺序(`resolveCLIConfigForMCP` 逐字):

```js
result = mergeConfig(result, configInFile);    // --config 文件
result = mergeConfig(result, envOverrides);    // ← 环境变量
result = mergeConfig(result, cliOverrides);    // ← 命令行 flag(最高优先级)
```

env 是「默认值层」，显式命令行参数仍能覆盖它。

> **⚠️ 更正**:初稿在这里写「上游还留了反向 flag `--headed` 作为显式 opt-in 出口」。**这是错的** —— 实测 MCP 命令的 `--help` 里 `--headed` 出现 **0 次**;我 grep 到的那个 `option("--headed", …)` 属于另一个命令(Playwright CLI-daemon)。所以这是一条**没有 per-launch 出口的舰队级策略**,回滚 = 改配置 + 重启。详见 plan §2。

B 相对其它落点的优势:

| | B(env) | C(user server) | D(fork) |
|---|---|---|---|
| 改插件定义 | 否 | 是(要禁官方) | 是 |
| 工具前缀变化 | **无** | 变 | 变 |
| 影响 FLY-1185 按需机制 | **无** | 撤销 | 无 |
| 长期维护负担 | **无** | 低 | 要跟上游 fork |
| 回滚方式 | **unset 一个变量** | 改配置+重启 | 改 marketplace |

B 是唯一一个**不改变任何现有结构**的方案 —— 它只是给一个已有的上游开关拨了个值。

### 注入点(两类进程要分别覆盖)

> **⚠️ 下表已被推翻,以 plan §2 为准。** Lead 的 claude 子进程走 `env -i` + 显式白名单,`~/.flywheel/.env` **到不了它**;而且这两个落点都覆盖不到 founder 自己开的 Terminal 会话。正确落点是 Claude 配置的 `env` 块。

| 谁 | 初稿设想的注入位置(**已否**) |
|---|---|
| Runner | `TmuxAdapter` spawn 时的 env |
| Lead | `~/.flywheel/.env` ❌ 被 `env -i` 挡住 |

两处都要覆盖 —— 实测 19 个 MCP server 里 **5 个属于 Lead**，只管 runner 会漏掉它们。

### 顺带核清的前置项(原本担心的硬编码问题)

`~/.claude/settings.json` 的 `permissions.allow` 里有 44 条 playwright 条目:22 条带 `plugin_` 前缀、22 条不带。选 B 不改前缀，**这 44 条一条都不用动**。这也是 B 比 C/D 省事的地方。

### 另有一个**独立于以上四条**的发现

FLY-1185 当初就写好了预防腿 `scripts/setup-mcp-on-demand.sh` —— 把 playwright 插件在机器级设为默认关闭，只让 QA role / `playwright` label / `full-mcp` label 按需开。

**实测这个 ops 步骤从来没有执行过:**

```
~/.claude/settings.json 里 playwright@claude-plugins-official = True   (应为 false)
setup-mcp-on-demand 的备份文件数 = 0                                   (跑过必留 .bak)
```

代码 merge 了，人没跑。这直接解释了为什么 19 个会话(**包括 5 个 Lead 和全部 runner**)每一个都挂着一个 playwright-mcp server —— 按 FLY-1185 的设计它们本不该有。

这条要不要一并做，是 plan 阶段的取舍:它能把 19 个 server 砍到个位数(**减少泄漏的发生面**)，但它也会改变现有 runner 的能力边界(没有 `playwright` label 的 runner 将失去 browser 工具，比如量 founder HTML 高度的那类)。**不宜在本 issue 顺手做掉** —— 它是一个独立的行为变更，值得单独评估。本文只负责把"它没跑"这个事实记下来。

---

## 6. 三条腿的组合与各自能证明什么

> **⚠️ 本节初稿已被设计评审推翻,以 plan §0/§6/§7 为准。** 下表保留初稿原貌 + 逐条更正,便于看清判断是怎么变的。

| 腿(初稿) | 初稿判断 | 评审后的实际情况 |
|---|---|---|
| **① `--headless`** | 预防,改配置即生效 | ✅ 保留,但落点从 `.env` 改到 Claude 的 `env` 块(Lead 走 `env -i` 白名单,`.env` 到不了),且需要 ops writer + 存量会话收敛 |
| **② `--isolated`** | 预防磁盘增长,`ms-playwright-mcp/` 不再新增目录 | ❌ **撤出本期**。它并不消除磁盘 profile,只是换成 `os.tmpdir()` 下的 `mkdtemp` 目录;而在 MCP server 被 SIGKILL 这条我们真正关心的路径上,清理代码根本跑不了。更糟:启用它会让回收器的选择器**对所有新孤儿失明** |
| **③ Chrome 回收 + 目录清理** | 治理存量 | ✅ 保留,但拆成 P2(进程)与 P3(磁盘),且**前面新增了 P0 根因腿** |

**初稿「①② 不依赖 ③」这个结论是错的。** `--isolated` 与回收器之间存在硬依赖(plan §6),必须等回收器的选择器能同时覆盖两种 profile 形态之后才能启用。

真实的依赖有三条(以 plan §7 为准):**P0 → P2**、**activation → P2 发信号 / P3 清磁盘**、**P2 → P4(`--isolated`)**。`--headless` 与它们都无依赖,可以独立先上。

---

## 7. 明确的未知与边界

诚实记下没验的:

1. **没有实测 headed→headless 的行为等价性。** 依据是 CDP 协议语义 + 全部 136 次调用无一需要窗口。但我没有真跑一次 headless 下的 `browser_take_screenshot` 做像素对照。**在 founder 机器上起一个 headed Chrome 会弹窗干扰她**，我判断这个实验的干扰代价大于收益，留给 plan/QA 在隔离环境做。
2. **7 个无法归因的 profile 目录** 归属未知，设计上按"保留"处理。
3. **`ppid==1` 之外还有没有别的逃逸形态** —— 比如 MCP server 活着但 Chrome 已经该关没关(会话结束、server 仍驻留)。我这次观测到活实例为 0，没能抓到这种形态的现场。回收器判据用 `ppid==1` 是保守的:抓不到这类，但也绝不误杀。
4. **exploration §1 记录的"45 进程 / 1.5GB RSS"复现不出来**(此刻活实例 0)，不作为验收基线。可复现的基线是磁盘数据。
5. **Typeless 挂起** 与本 issue 无已证实因果，不在范围内(exploration §6)。
