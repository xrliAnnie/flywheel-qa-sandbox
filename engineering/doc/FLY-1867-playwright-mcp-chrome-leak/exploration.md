# FLY-1867 playwright-mcp Chrome 泄漏 — 探索

Issue: FLY-1867 (https://linear.app/geoforge3d/issue/FLY-1867/playwright-mcp-chrome-泄漏实例从不回收且有可见窗口盖住-founder-桌面-点击落空)
日期: 2026-08-20
基于: 无

---

## 0. 一句话

issue 说的「playwright-mcp 实例从不回收」实测下来是**两条独立的泄漏**加**一个默认值问题**，而现有的两个回收器(FLY-1185 MCP reaper / FLY-766 Chrome reaper)因为各自的判据，**都恰好扫不到它**。

---

## 1. 审计推翻了 issue 的一个前提

issue 写「7 个并发浏览器实例 / 45 个进程」并推测「ppid 显示它们的父进程都是 Chrome 自己，原始 spawn 者已经不在了」。实测:

**MCP server 层面没有泄漏。** 当前机器上 19 个 `npm exec @playwright/mcp@latest` 进程，**每一个的父进程都还活着**(5 个 Lead + 14 个 runner 的 claude 进程)，ppid==1 的孤儿数 = **0**。

```
mcp=36961 ppid=33780 parent='claude --dangerously-skip-permissions'
mcp=30685 ppid=27908 parent='claude --agent flywheel-cos-lead ...'
mcp=12377 ppid=11672 parent='claude --agent-id runner-63fa337b@flywheel-eng-lead ...'
... (共 19 条，无一 ppid=1)
```

这条实测直接决定了修法:**FLY-1185 已有的 orphan reaper 帮不上忙**，因为它的判据是 `ppid == 1 && elapsed >= 30min && argv 含 @playwright/mcp`(`mcp-descendant-reaper.ts:286-291`)。泄漏的东西从来不满足第一个条件，所以那个回收器对本 issue 永远是空转的。

「父进程是 Chrome 自己」的观察对应的是 Chrome 的 **renderer 子进程**(renderer 的 ppid 本就是 Chrome 主进程)。真正逃逸的是 Chrome **主**进程，它的 ppid 才是 1。

> 名词:*ppid* = 父进程号。Unix 里进程死了以后它的孩子会被"过继"给系统的 1 号进程(macOS 上是 launchd)，所以 `ppid==1` 通常意味着"生我的那个人已经不在了"。

---

## 2. 三个必答问题的实测答案

### Q1 — 生命周期由谁结束?会话结束时有 close 路径吗?

**有一条 close 路径，而且它在正常退出时是好使的;但它有一个结构性的逃逸口。**

playwright-mcp 装了退出看门狗(`coreBundle.js` 的 `setupExitWatchdog`):

```js
process.stdin.on("close", () => handleExit("close"));
process.on("SIGINT",  () => handleExit("SIGINT"));
process.on("SIGTERM", () => handleExit("SIGTERM"));
// handleExit → gracefullyCloseAll() → 关掉它开的所有浏览器
```

也就是说 **MCP server 自己好好退出时，Chrome 会被关掉**。

逃逸口在 Chrome 的启动方式上。playwright 起 Chrome 时用的是:

```js
const spawnOptions = { detached: process.platform !== "win32", ... }
```

> 名词:*detached*(分离) = 让子进程自立门户成为一个新"进程组"的头儿。好处是父进程可以用一条命令连锅端掉整棵子树;坏处是**它不再跟着父进程的进程组一起被杀**。

于是有两条路径:

| MCP server 怎么没的 | Chrome 的下场 |
|---|---|
| 收到 SIGTERM / SIGINT / stdin 关闭 → 优雅退出 | ✅ 看门狗跑完 → Chrome 被关 |
| 被 SIGKILL / 崩溃 / 整个 tmux pane 被硬杀 | ❌ 看门狗没机会跑 → Chrome **活下来变孤儿** |

Flywheel 的 runner 收尾恰好大量走第二条:pane kill、close-runner、post-merge 清理、OOM。而且因为 `detached`，杀 pane 的进程组**杀不到** Chrome。

所以答案是:**close 路径存在，但只覆盖"温柔的死法"。Flywheel 里最常见的死法是不温柔的那种。**

### Q2 — 7 个并发实例是预期的还是全是孤儿?

**是孤儿，不是并发。** 而且它是 churn(不断生成/消亡)的，不是静态堆积:

- 本次调查时刻扫描活的 ms-playwright-mcp Chrome 主进程 = **0 个**
- issue 记录的时刻 = 7 个
- issue 自己也记了两次测量间隔几分钟 Chrome 总进程从 75 掉到 48

**这条也修正了 issue 的一个说法**:它不是"从不回收"的单调堆积。Chrome 有回收(温柔死法那条路)，只是漏了一部分，而漏掉的那部分**永久留存**直到手动清理。峰值不可预测这一点 issue 说对了。

（副产物:issue 里"45 个进程 / ~1.5GB RSS"这类数字我这次复现不出来，因为此刻活实例为 0。我不把它当作可复现的验收基线;可复现的基线是下面的磁盘数据。）

### Q3 — 老 profile 目录能否安全清理?

**能，而且证据很硬。**

目录名不是随机的，是一个路径的哈希:

```js
const rootPathToken = createHash(clientInfo.cwd);   // sha256(...).slice(0,7)
path.join(dir, `mcp-${browserToken}-${rootPathToken}`)   // → mcp-chrome-<7位>
```

> **⚠️ 这里的 `clientInfo.cwd` 不是进程的工作目录**(R3 评审纠正了我的初稿)。它来自 MCP 协议的 `roots/list` —— 服务端向客户端(这里是 Claude Code)要一份「根目录清单」，取**第一个**;只有在客户端一个有效 root 都没给时，才 fallback 到 `process.cwd()`:
>
> ```js
> const clientInfo = { cwd: firstRootPath(clientRoots), ... };
> // allRootPaths(): 逐个解析 root.uri;若一个都解析不出，才 push(process.cwd())
> ```
>
> 对下面的归因结果没有影响 —— 实测 66/73 命中说明在我们的场景里这个 root 恰好就是 worktree 路径。但**机制上不能反过来用**:不能从一个进程的 OS cwd 去推它的 profile 目录，两者语义不等价(客户端给多个 root 时尤其)。这个区分在设计回收器时是要命的，见 plan §3。

我用正向哈希对候选路径集做了归因(哈希不可逆，只能正着算再比对):

```
profile 目录总数        : 73
可归因到具体路径        : 66
  └ 路径仍然存在        :  9   ← 现存的 9 个 worktree
  └ 路径已被删除        : 57   ← FLY-709 / 914 / 922 / 1038 / 1136 / 1140 / 1178 / 1199 / 1260 / 1262 …
无法归因                :  7
```

**57 个 profile 目录对应的 worktree 已经在文件系统上物理不存在了** —— 那些 issue 早就 merge 关闭、worktree 删掉了。不可能再有任何会话依赖它们。

这也解释了为什么增长是**单调**的:Flywheel 一个 issue 一个 worktree(`~/Dev/flywheel-FLY-XXXX`)，worktree 是一次性的 —— 开一个新 issue = 一个新 cwd = 一个新哈希 = 一个新 profile 目录;worktree 删了，目录留着。playwright-mcp 侧只有 `mkdir`，**没有任何一行清理代码**。

> 关于那 7 个"无法归因":零命中只说明"我扫的候选范围里没有"，不说明它们是垃圾。我的候选集是 flywheel/GeoForge3D 的 worktree 命名模式 + `~/Dev` 下的现存目录，覆盖不到 Lead 的工作目录等其他 cwd。**设计上必须默认保留无法归因的目录**，不能按"扫不到就删"处理。

磁盘现状(**注意它在涨**):

| 时刻 | 目录数 | 占用 |
|---|---|---|
| issue 记录时 | 57 | 495 MB |
| 本次调查(2026-08-20) | **73** | **631 MB** |

最旧 `mcp-chrome-ae84304` = Jul 1 14:52，跨越 7 周无人回收。

---

## 3. 为什么两个现成的回收器都接不住它

Flywheel 里已经有两个回收器，本 issue 正好掉在它们中间的缝里。

| | FLY-1185 `mcp-descendant-reaper` | FLY-766 `chrome-session-reaper` |
|---|---|---|
| 它认什么 | argv 含 `@playwright/mcp` 的 **node 进程** | `comm` 是 Chrome 家族 **且** user-data-dir 前缀是 `agent-browser-chrome-` |
| 判据 | `ppid==1` + 存活 ≥30min | 归属标记 `.flywheel-owner.json` → owning session 终态 |
| 为什么接不住 | 泄漏的 MCP server 数 = **0**，永远空转 | playwright-mcp 的 Chrome 用的是 `ms-playwright-mcp/mcp-chrome-*`，**既不带那个前缀，也没有 owner 标记** |

FLY-766 的注释里其实写明了它治的是 `agent-browser` CLI 起的 `--headless=new` Chrome —— 那是**不可见**的。本 issue 的 Chrome 是**可见**的，是另一个来源。两者是不同的泄漏，不是同一个 bug 的两次发作。

第三条缝:两个回收器**都只管进程，没有一个管磁盘目录**。631MB 那部分现在没有任何机制负责。

---

## 4. 「盖住桌面、点击落空」的根因 — 一个默认值

这是 issue 标题里对 founder 影响最直接的一半，根因非常短:

```js
// resolveCLIConfigForMCP —— MCP 模式的默认值裁决，逐字
if (browser.launchOptions.headless === void 0)
  browser.launchOptions.headless = os.platform() === "linux" && !process.env.DISPLAY;
```

在 macOS 上这个表达式**恒为 false** → 默认 headed。CLI 帮助文本也是同一句话:`"run browser in headless mode, headed by default"`。

> 换句话说:上游的默认值是为「Linux 无显示器的 CI 机器自动无头、有桌面的机器给你看窗口」设计的。放在 founder 唯一的 macOS 工作机上，这个默认恰好选中了最差的那一档。

playwright-mcp 的浏览器**默认是有可见窗口的**(headed)。Flywheel 从来没传过 `--headless` —— 插件的 MCP 定义就是光秃秃的一行:

```json
{ "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } }
```

于是每次有 agent 用一次 playwright browser 工具，founder 桌面上就真的弹出一个 Chrome 窗口，抢焦点、盖住她正在操作的东西，她的点击落到那个窗口上而不是她以为的应用上。孤儿 Chrome 让这个窗口**永久留在桌面上**。

> 对比:FLY-766 治的 agent-browser Chrome 明确带 `--headless=new`，所以它泄漏时只吃内存，不打扰 founder。本 issue 之所以体感更糟，就是因为多了这个默认值。

---

## 5. 影响面 — 为什么这条值得修

1. **无上限。** 磁盘侧完全没有回收路径，7 周从 0 涨到 631MB，且我这次实测比 issue 记录时又多了 16 个目录 / 136MB。
2. **发生在 founder 唯一的机器上。** stabilization 的目标是"这台机器可信"，一个 7 周无人管的单调增长项与之直接冲突。
3. **它把噪音算到了 founder 头上。** issue 里记了这件事:排查 Typeless 卡顿时看到 Chrome 占大头，于是建议 Annie"关一批标签"，而她实际只有 5 个标签 / 0.01GB —— Chrome 的量全是我们的。这类误导只要泄漏在就会重复发生。
4. **可见窗口是直接的操作干扰**，不只是资源问题。

---

## 6. 明确不在本 issue 范围内的事

issue 里 Tadashi 已经点名要求不要把两件事混为一谈，我照办并复述一遍边界:

**Typeless / DiskImageMounter 被挂起在 `T` 状态**(发 SIGCONT 后立刻恢复)与本 issue **没有已证实的因果关系**。issue 自己记了反证:排查时内存压力已缓解到 51% 空闲，Typeless 仍然卡着 —— 所以"内存不足导致挂起"这个解释至少不完整。挂起的根因未知，**不写进本 issue 的验收**。

本 issue 只对下面这些负责，且每条都有可复现的判据:

| 要治的 | 可验证的判据 |
|---|---|
| 孤儿 Chrome 进程 | 扫不到 user-data-dir 指向 `ms-playwright-mcp` 且 ppid==1 的 Chrome 主进程 |
| 单调增长的 profile 目录 | 对应 worktree 已删除的目录数收敛，不再单调增长 |
| 可见窗口抢焦点 | 新起的 playwright-mcp Chrome 不在桌面上出现 |

---

## 7. 待定的取舍(留给 research / plan)

调查确认了因果链，但修法有真实的取舍，不预设:

1. **默认 headless 是否会打断合法用途?** QA runner 用 playwright 做视觉验证时，headless 截图与 headed 是否等价?founder 自己是否有需要看见浏览器的场景?
2. **进程回收放哪一层?** 扩 FLY-766 的 chrome-session-reaper 认一类新 user-data-dir(它已有成熟的身份校验与 race 防护)，还是新写?扩的风险是它的归属判定依赖 `.flywheel-owner.json` 标记，而 playwright-mcp 的 Chrome 没有这个标记 —— 得靠别的判据证明"这个能杀"。
3. **磁盘清理归谁?** 刚 merge 的 FLY-1330 日志 janitor(`flywheel-log-janitor.sh`，每日 04:15 launchd)已经是一个现成的、带 dry-run receipt + 活体门 + 审计的滚动清理框架。加一个 module 可能比新建一套便宜得多。
4. **能不能从源头少开?** `--isolated` 会不会直接消掉磁盘这一半?代价是什么?
   > **⚠️ 后续评审已否掉这条初始理解**:`--isolated` 并非「只存内存」—— 它走 `browserType.launch()`,仍会在 `os.tmpdir()` 下 `mkdtemp` 一个目录;而在 MCP server 被强杀这条我们真正关心的路径上,清理代码根本跑不了。它已撤出本期,理由见 plan §6。

这四条是 research 阶段要回答的。
