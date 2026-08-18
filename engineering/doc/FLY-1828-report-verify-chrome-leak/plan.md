# FLY-1828 报告页验证 headless Chrome 泄漏修复 — 实施计划

Issue: FLY-1828 (https://linear.app/geoforge3d/issue/FLY-1828/infraops-html-报告页验证会泄漏-headless-chrome-12-个卡住进程吃-17gbfounder-桌面冒-8-个图标)
日期: 2026-08-17
基于: 无

---

## 0. 范围(最小,按 issue 三条修法,不扩大)

**做**:
- **A. 统一验证命令** `flywheel-comm verify-report` — 轻量校验(curl 级,零浏览器)为默认;截图 opt-in,单次 headless Chrome + **进程组级硬超时收尸**(后置条件 = 整个 PGID 消失,不是 direct child 退出)。
- **B. 收尸兜底** — 扩展既有 `chrome-session-reaper.ts`(FLY-766),新增 **headless one-shot 截图进程**类别:`--headless` 且 `--screenshot` 且存活 > 5 分钟 ⇒ TERM→KILL escalation,退出确认后才计数。该窄类别刻意不要求 owner marker,否则会放过本次事故的 legacy / 手拉无 marker 进程。
- **C. 分级验证规矩文本** — founder-html-delivery skill(flywheel-skills 跨仓 PR)改为引用 verify-report,写明分级与禁令。

**不做**(诚实边界):
- 不放宽「发给 founder 的 HTML 必须验证托管页」规矩本身 — 只换更便宜的验证手段。
- 不动 FLY-766 归属型 reaper 逻辑(agent-browser 长驻类别行为零变化);admission gate 限流仍是 FLY-766 的 fast-follow,不在本单。
- 不动 `publish-report` 内置 ProofShot 截图链路(spike 验证过 stop 收尸干净;`--publish-only` 路径完全跳过截图)。
- 不做「量页面高度」新工具(有既有配方且频次低;verify-report 截图附带输出 PNG 实际尺寸作信息字段,不承诺高度测量语义 — 固定 viewport 截图的高度 = viewport 高,不是页面高,文档写明)。
- 不做 dock 图标专项治理:headless one-shot 不产 dock 图标;图标来自 Playwright MCP/agent-browser headed 实例(活跃 QA 会话,受保护不杀);「per-runner 浏览器不得产生可见图标」硬约束由 FLY-1825 落地。
- **零新 feature flag / 零新 env**(Annie「不加新 flag」铁律,FLY-1466/1806 收敛方向):阈值写常量;`--chrome-bin` 是 CLI 参数不是 flag,不进 registry。

**时序约束**:本单应**先于或同批于 FLY-1825**(Codex runner 配浏览器)落地 — 1825 会把开浏览器的主体从 QA 扩到 implement,无收尸机制时泄漏成倍。

---

## 1. 根因与证据(2026-08-17 本单审计)

### 1.1 泄漏进程的真实形态(实抓)

审计时(founder 处置后约 10 小时)**仍有 2 个卡死进程存活 10+ 小时**:

```
7752  10:08:32 /Applications/Google Chrome.app/.../Google Chrome --headless=new --disable-gpu
      --hide-scrollbars --window-size=980,700 --screenshot=after.png --virtual-time-budget=3000
      --user-data-dir=./cp7 http://127.0.0.1:18781/flag-report.html
40575 10:05:22 ... --window-size=1200,5900 --screenshot=p1.png --virtual-time-budget=4000
      --user-data-dir=./cp8 http://127.0.0.1:18781/ship-report.html
```

三个关键事实:
1. **可执行是正牌 `/Applications/Google Chrome.app`**,不是 agent-browser 的 "Google Chrome for Testing"。
2. **one-shot 截图模式**(`--screenshot=<file>`):设计寿命 = 秒级(`--virtual-time-budget=3~4s`),存活 10 小时 = 必然卡死。
3. **目标是 `127.0.0.1:18781` 本地预览 server**(agent 临时起的 http server 预览 flag-report/ship-report)。独立 QA 进一步证实目标机 Chrome 151 即使对健康页面写完 PNG 也不会自行退出;server 先退只会让问题更明显。结论不依赖单一页面状态:`--virtual-time-budget` / Chrome `--timeout` 都不是可信的 OS 生命周期边界,外层进程组收尸才是权威。

### 1.2 为什么 FLY-766 的 reaper 收不了它

`packages/teamlead/src/bridge/chrome-session-reaper.ts` 的命中判据(`parseChromeProc`,FLY-766 Codex R1 HIGH-2:身份认 `comm` 不认 argv)要求**同时**:
- comm = "Google Chrome for Testing" 或路径在 `~/.agent-browser/browsers/` 下;
- argv 的 `--user-data-dir` 含 `agent-browser-chrome-` 段。

本次泄漏形态两条都不满足 — 文件头注释明确写着:*"`/Applications/Google Chrome.app` (default profile, no `agent-browser-chrome-` user-data-dir) never matches"*。**这不是 FLY-766 的 bug,是它当时的 scope**(agent-browser 生命周期);本单补的是它明确排除在外的那一类。

### 1.3 截图行为的来源(是习惯层,不是代码层)

- `founder-html-delivery` skill 的验证要求(72-75 行)本来就只是 **curl**:HTTP 200 + 占位符残留 0 + `<script nonce="...">` 存在。**没有要求截图**。
- Blueprint 的 design-node founder HTML 合同也不要求 hosted 页截图(runner `--publish-only` 出 URL 即报 Lead;`Blueprint.ts:883-889`)。
- `publish-report` 内置截图走 ProofShot(agent-browser 链路,含锁 + spike 验证过的收尸);`--publish-only` 路径(runner)完全跳过截图(`publish-report.ts:218-230`)。
- **真实来源 = agent(Lead/QA/Runner)在验证/预览报告页时 ad-hoc 手拉 raw chrome one-shot 截图,或拉起 Playwright MCP 整套浏览器** — 各自 memory 里的配方(如「验托管页」「量高度」)被过度执行,且 raw chrome 命令无任何 wrapper 超时。

所以修法是**给一条便宜的正路(A)+ 收尸兜底(B)+ 把正路写进共享 skill 文本(C)**,而不是改运行时合同。

---

## 2. 交付物 A:`flywheel-comm verify-report`

新文件 `packages/flywheel-comm/src/commands/verify-report.ts`;`src/index.ts` 注册 `case "verify-report"`(照 `publish-report` 的注册、参数解析与 help 文本模式,`index.ts:1673-1748` 一带)。

### 2.1 CLI 契约与输入校验

```
flywheel-comm verify-report --url <http(s)://…>
    [--expect <substring>]          # 可选自定义断言(出现于 body)
    [--screenshot <abs-path.png>]   # opt-in:单次 headless 截图
    [--shot-window <WxH>]           # 默认 1280x2000
    [--timeout-ms <n>]              # HTTP 超时,默认 15000
    [--shot-timeout-ms <n>]         # 截图硬超时,默认 20000
    [--chrome-bin <abs-path>]       # 默认 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

**边界校验(全部在解析层 fail-fast,统一 fail envelope)**:
- `--url` 必填,scheme 必须 `http:`/`https:`(`new URL` 解析失败 = fail);
- 两个 timeout:正整数,范围 `[1_000, 300_000]` ms;
- `--shot-window`:`/^\d{2,5}x\d{2,5}$/`,宽高各 `[320, 8192]`(防超大 viewport 打爆 Chrome 资源分配);
- `--screenshot` / `--chrome-bin`:必须绝对路径;
- 未知 flag ⇒ fail。

stdout **任何路径下恰好一行 JSON envelope**(同 publish-report 契约):

成功形态:
```json
{ "ok": true, "url": "...", "status": 200,
  "checks": { "http": "pass", "noncePlaceholder": "pass", "scriptNonce": "pass|skipped", "expect": "pass|skipped" },
  "warnings": ["braces: found '{{' 3x"],
  "info": { "hasInlineSvg": true, "imgCount": 2 },
  "screenshot": { "path": "...", "width": 1280, "height": 2000 } }
```

失败形态(**稳定 `error` 字段**,exit 1):
```json
{ "ok": false, "url": "...", "error": "screenshot timeout (pgid 1234 killed)", "checks": { ... } }
```

### 2.2 默认轻量校验(零浏览器)

用 Node 内置 `fetch` + `AbortSignal.timeout(timeoutMs)`:

| 检查 | 判据 | 级别 |
|---|---|---|
| http | `res.ok`(2xx) | hard fail |
| noncePlaceholder | body 不含 `__CSP_NONCE__` | hard fail |
| scriptNonce | body 含 `<script` 时必须存在 `<script nonce="` 且值非占位符;无 `<script` 则 `skipped` | hard fail |
| expect | `--expect` 给出时 body 含该子串 | hard fail |
| braces | body 含 `{{`(ship-report 模板假样板句陷阱) | **warning only** |
| 图存在 | `<svg` / `<img` 计数 | info only |

`{{` 只作 warning 的理由:mermaid 源码(`{{hexagon}}` 语法)或内嵌 JS 可能合法含有 `{{`,hard fail 会误杀;warning 保留信号让验证者人工判断。「图在」不作硬门:并非所有报告有图,info 字段够用。

### 2.3 `--screenshot`:单次 headless + 进程组级硬超时收尸

1. **chrome binary 解析**:`--chrome-bin` CLI 参数(供测试与非标准安装)→ 默认固定绝对路径 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` → 不存在/不可执行 ⇒ `ok:false` 报错(fail-loud,不静默降级)。零新 env。
2. **唯一临时输出**:Chrome 的 `--screenshot=` 指向**用户目标文件同一父目录下的唯一临时 sibling 文件**(如 `.<target>.fly1828-tmp-<rand>.png`;temp profile 仍放系统 tmp)— 排除「旧文件冒充本次产物」,且同文件系统保证最终 `rename` 真原子。若目标目录不可写 ⇒ 解析层 fail。**不用 copy+unlink 冒充 atomic**(会暴露半成品);理论 EXDEV 情形因 sibling 同目录而不存在,测试注入 rename EXDEV 错误时断言旧 target 内容不变、命令 fail。
3. **spawn**:`spawn(bin, args, { detached: true, stdio: "ignore" })` — `detached: true` 使 chrome 成为**新进程组组长**(POSIX 语义,Node 官方文档明确),这是能一枪收尸整棵树(main + gpu helper + renderer)的前提。args =
   `--headless=new --disable-gpu --hide-scrollbars --window-size=<WxH> --screenshot=<tmp.png> --virtual-time-budget=4000 --timeout=<shot-timeout-ms 的 80%> --user-data-dir=<mkdtempSync(os.tmpdir()+"/fly1828-shot-")>` + url。
   - Chrome 原生 `--timeout` 作**内层防线**(页面仍 loading 时强制 capture 并退出);OS wrapper 仍是最终权威 — 本次事故证明页面永不 commit 时 Chrome 自身的预算机制不可信。
   - **spawn 失败处理**:监听 `error` 事件(ENOENT 等);`child.pid === undefined` ⇒ 直接 fail envelope,**绝不对 `-undefined` 发信号**。
4. **进程组后置条件(统一 `ensureProcessGroupGone(pgid)`,三条退出路径全走)**:
   - 核心不变量:**命令结束前 PGID 必须已消失**(探测 `process.kill(-pgid, 0)` 抛 ESRCH)。direct child 的 `exit` 不能证明这一点 — main 退出而 helper 存活时 `kill(pid,0)` 已 ESRCH 但 `kill(-pgid,0)` 仍活(Round 1 Codex 本机控制实验实证)。
   - `ensureProcessGroupGone(pgid)`:探测组仍在 ⇒ `SIGTERM(-pgid)` → 宽限 2s 再探 ⇒ 仍在 ⇒ `SIGKILL(-pgid)` → 有界轮询(每 200ms,上限 5s)直到 ESRCH;耗尽仍未 ESRCH(理论罕见)⇒ 返回 survived(fail-loud,进程留给 reaper B 兜底)。
   - **exit 0 路径**:先给 1s 自然退出窗口(headless one-shot 正常会整组退干净),然后跑 `ensureProcessGroupGone`;若发生了 escalation 但截图产物验证合法 ⇒ **`ok:true` + warning**(`"helper processes outlived main; pgid … escalated"`)— 产物可信、尸体已收,不静默也不浪费一次合法截图;
   - **非零 exit 路径**:跑 `ensureProcessGroupGone` 后返回 `ok:false`(Chrome 自身失败);
   - **timeout 路径**:直接 `ensureProcessGroupGone`(TERM 起手);若临时 PNG 已完整写出并通过下述校验,原子安装后返回 `ok:true`,不把目标机 Chrome 的常态 timeout cleanup 报成 warning;未产生合法 PNG 才返回 `ok:false, error:"screenshot timeout (pgid … killed)"`;
   - **验证/rename 只在 PGID 确认消失之后**;survived 情形 ⇒ `ok:false, error:"pgid … survived SIGKILL"`,不安装 target。macOS 在 SIGKILL 后可能对 PGID probe 返回 EPERM:视为不可判并继续轮询;后续 ESRCH 才确认已死并安装合法 PNG,最终仍只有 EPERM 则沿用 survived 语义。
5. **产物验证(exit 0 或 timeout 已收尸路径)**:临时输出必须是 regular file + **8 字节 PNG signature**(`\x89PNG\r\n\x1a\n`)+ IHDR chunk 校验(偏移 8-16 = length 13 + type "IHDR")+ 宽高非零 + 文件末尾完整 IEND chunk ⇒ 读 IHDR 宽高(偏移 16/20,big-endian)输出 `width/height`;任何一步不满足(本次未创建文件 / 短文件 / 错 magic / 缺 IHDR / 缺 IEND)⇒ `ok:false` 对应 error。验证通过后原子 rename 到用户目标。
6. **清理**:进程组终止流程尝试完成后,无论成功、signal 抛错或最终仍不可判,都在 `finally` 中 `rm -rf` 临时 profile 与 tmp 输出(best-effort,失败进 warnings)。判定分支只决定是否安装 target,不能决定临时磁盘是否泄漏;仍活的异常进程由 Bridge one-shot reaper 兜底。

### 2.4 为什么是 flywheel-comm 子命令而不是 shell 脚本

- 验证者是任意 cwd 下的 Lead/Runner,`flywheel-comm` 已在 PATH(founder-html-delivery skill 现文本就直接调 `flywheel-comm publish-report`);
- 可被 skill 文本(交付物 C)一行引用;
- TS + vitest 可测(spawn/fetch 全部依赖注入);
- 与 publish-report 同包,复用 envelope 风格与 CLI wrapper 模式。
shell 脚本(`scripts/…`)则依赖仓库路径,QA slot / 其他项目 worktree 下不可达 — 弃。

---

## 3. 交付物 B:reaper 新增 headless one-shot 类别

改 `packages/teamlead/src/bridge/chrome-session-reaper.ts`(+ 既有测试文件扩展)+ `plugin.ts` 日志接线。**`parseChromeProc` 与既有归属逻辑一字不动**。

### 3.1 新纯分类器(优先于既有分类器)

```ts
export const CHROME_FAMILY_COMMS = ["Google Chrome", "Google Chrome for Testing", "Chromium", "chrome", "headless_shell"];
export function parseHeadlessShotProc(pid, comm, command): { pid: number } | null
```

命中当且仅当**全部**满足(身份认 `comm`,argv 骗不了 — 沿用 FLY-766 R1 HIGH-2 教训):
1. `basename(comm)` ∈ `CHROME_FAMILY_COMMS`,或 comm 含 `~/.agent-browser/browsers/` 段(复用现有常量);
2. argv 匹配 `/(^|\s)--headless(=|\s|$)/` **且** `/(^|\s)--screenshot(=|\s|$)/`(one-shot 模式的特异标记);
3. argv 无 `--type=`(main 进程)。

**分类优先级:one-shot 优先** — 主循环对每个 pid **先试 `parseHeadlessShotProc`**,命中即走 one-shot 处理(年龄门 + escalation),miss 才走既有 `parseChromeProc` 归属路径。one-shot 判据与归属无关:带 `agent-browser-chrome-` profile 的 Chrome for Testing 若以 one-shot 模式卡死超龄,同样是尸体;legacy / 手拉进程可能没有 owner marker,不能以 marker 豁免。agent-browser **长驻** CDP 浏览器不带 `--screenshot`,永不进 one-shot 分支 ⇒ 既有类别行为零变化。

**不误杀分析**(issue 处置时明确保护了活跃 QA 浏览器):
- Playwright MCP / agent-browser 驱动的长驻浏览器:CDP 远控模式,**不带 `--screenshot`** ⇒ 永不命中;
- headed 浏览器(dock 图标那些):不带 `--headless` ⇒ 永不命中;
- runner(claude/node)进程 prompt/argv 里带这些字符串:comm 是 claude/node ⇒ 身份判据挡住;
- 正常 one-shot 截图(verify-report 或手动):秒级退出,活不到 5 分钟年龄门。

### 3.2 进程年龄 + 启动时间身份(单一新 sensor,故障隔离)

新增可注入 dep `listAgeByPid?: () => Promise<Map<number, { ageMs: number; lstart: string }>>`,默认第三个 ps pass:`ps -Awwo pid=,etime=,lstart=`(pid 与 etime 不含空格,`lstart` 是行尾整段固定格式字符串,按前两列切分后取余)— **不改既有两个 pass 的格式**(它们的 mock fixtures 保持 byte-compat)。导出 `parseEtimeToMs`(格式 `[[dd-]hh:]mm:ss`)供测试。`etime`/`lstart` 均为 macOS `ps` 正式 output keyword。

**故障隔离(Round 1 issue 5)**:这个 pass **不进**既有 `Promise.all` — 单独 try/catch。失败 ⇒ headless-shot 类别整体 fail-closed 跳过(记一条 sensor error 进 `errors[]`),**既有两类 census 与处理完全不受影响**。

阈值:**常量 `HEADLESS_SHOT_MAX_AGE_MS = 5 * 60_000`**(不加 env/flag)。依据:one-shot 设计寿命 = `--virtual-time-budget` 的 2.5~4s + 启动开销;实测卡死者 12 分钟~10 小时;5 分钟给正常路径 ≥75 倍余量。

### 3.3 kill 规则:身份栅栏 + TERM→KILL escalation + 退出确认才计数

初扫命中且 `ageMs > HEADLESS_SHOT_MAX_AGE_MS` 的进程,携带**身份签名 `{ pid, lstart, command }`** 进入 kill 序列:

1. **exact-process 身份栅栏**:kill 前**分三个独立 ps 调用**复读该 pid — `ps -p <pid> -o etime=,lstart=`、`ps -p <pid> -o comm=`、`ps -p <pid> -o command=`。三者组合后必须:**lstart 逐字相同**且仍通过 `parseHeadlessShotProc` 且 age 仍超阈;任一调用失败或行不可解析 ⇒ fail-closed 不发信号、不记退出;不符 ⇒ `racedSkipped`。安全性由进程身份精确性交付,不是归属范围。
2. `SIGTERM`(对 **pid**,不对 -pgid — raw Chrome 不是本 wrapper detach 出来的,可能与调用者共享进程组,盲杀负 PGID 会伤及无辜);
3. 有界轮询(每 500ms,上限 3s):按同一三调用纪律复读 — 进程消失(或 lstart 变了 = 已换人)⇒ 确认退出;
4. 仍是同一进程(lstart 相同)⇒ `SIGKILL`(仍对 pid,受同一身份栅栏约束)→ 再有界轮询 2s;
5. **只有确认退出后**才 `killedHeadlessShot++` 并写 audit event;KILL 后仍存活(理论罕见)⇒ 记 `errors[]`(`headless-shot pid … survived SIGKILL`),**不计 killed、不写 reaped event** — 杜绝 TERM-immune 个体每 tick 制造虚假 reaped audit(Round 1 issue 2)。

其余 disposition:命中但未超龄 ⇒ `skippedHeadlessShotFresh`;age sensor join 不上该 pid ⇒ 保守 skip + error 记录。

`ChromeReapResult` 新增 `killedHeadlessShot` / `skippedHeadlessShotFresh` 两字段(既有测试的 `toEqual` 断言同 PR 同步)。

### 3.4 audit event(脱敏,Round 1 issue 8)

复用 `chrome_session_reaped`,合成 `execution_id: "chrome-headless-shot:<pid>"`、`issue_id/project_name: "unknown"`(满足 session_events NOT NULL)。payload **不存原始 argv**(verify-report 的 URL 可能含不可猜 report token / query secret,截断保存仍会把 capability 搬进长期审计库):只存 `{ commBasename, flags: ["headless","screenshot"], ageMs, pid, lstart, urlOrigin, urlPathHash }` — URL 从 argv 提取后**去 query/fragment**,path 只存 hash(hosted token path 不落库)。测试含带 token URL 的脱敏负例。

### 3.5 挂载与日志接线(plugin.ts 需要改,修正 Round 1 前稿的说法)

boot one-shot + periodic timer 挂载机制复用(`plugin.ts:6907-6961`,零新 timer);但现有日志的触发条件与文本只认识旧计数(`plugin.ts:6938-6948`)— 会出现 `scanned>0` 而所有 kill 数为 0 的哑巴日志。**同 PR 更新**:condition 与输出加 `killedHeadlessShot` / `skippedHeadlessShotFresh`。

**boot 与 periodic 两种 mode 都处理**。候选以最多 4 路并发分批处理,避免事故规模 12–17 个时串行 TERM/KILL 把一次 sweep 拖到一分钟以上。整机范围是有意设计:marker fence 会豁免本次事故的 cp7/cp8 类无 marker 病灶;blast radius 由严格 Chrome MAIN + `--headless` + `--screenshot` + >5min + lstart/argv 复验约束。

---

## 4. 交付物 C:分级验证规矩文本(跨仓)

**flywheel-skills repo**(canonical `xrliAnnie/flywheel-skills`,skills-sync launchd 分发,单独 PR,Tadashi founder-gated merge — 同 FLY-510 模式):

`skills/flywheel/founder-html-delivery/SKILL.md` 的验证段(现 72-75 行)改写为(措辞按 Round 1 issue 7 修正):

1. 验证托管页 = 跑 `flywheel-comm verify-report --url <url>`(可执行 PATH 形式,同 skill 现文本调 `publish-report` 的写法;它做齐 HTTP 200 / 占位符 / nonce 检查);
2. **分级**:
   - 仅是 QA/Lead 自产的报告页(triage/ship/flag 报告)→ 轻量校验**足够,截图非必须**;
   - 需要看渲染效果 → `verify-report --screenshot` 生成 PNG 后**必须实际 Read/inspect 那张图**(截图文件本身不构成视觉验收);
   - 交付物本身是 founder 要点按的交互页面(候选卡、评论层)→ 行为级视觉验收,复用已有 QA browser session(playwright-mcp);**不为普通报告页新开 MCP 浏览器**;固定 viewport 截图不得宣称 full-page / interaction acceptance;
3. **禁令**:验证报告页不要手拉 raw chrome 截图命令(无超时会永久泄漏进程 — FLY-1828 事故)。

本仓侧**不改 Blueprint 合同**(§1.3:合同本来就不要求截图;在合同里新增验证义务反而增加浏览器使用)。

依赖方向:C 的文本引用 A 的命令 ⇒ **A 所在的本仓 PR 先 merge/ship,C 的 skills PR 随后**(skills PR 不先于本仓 ship — ship 前生产 dist 里没有这个命令)。

---

## 5. 测试计划(TDD,先红后绿)

### 5.1 verify-report(`packages/flywheel-comm/src/__tests__/verify-report.test.ts`)

**轻量校验(mock fetch 注入)**:200+干净 body ⇒ ok;404 ⇒ fail;含 `__CSP_NONCE__` ⇒ fail;任一 `<script` 无 nonce ⇒ fail;无 script ⇒ scriptNonce skipped;`{{` ⇒ warning 且 ok;`--expect` 命中/未命中;fetch abort(超时)⇒ fail envelope。

**CLI 边界(built-dist subprocess,照 `publish-report.test.ts:628-706` 模式)**:missing `--url`;unknown flag;非 http(s) URL;负数/NaN/越界 timeout;坏 `--shot-window`;相对路径 `--screenshot`;ENOENT `--chrome-bin`;每条路径断言 **stdout 恰好一行 JSON** 且带稳定 `error` 字段。

**截图路径(mock spawn)**:正常 exit 0 + 本次写入的 tmp PNG ⇒ ok 且 IHDR/IEND 完整、宽高正确 + rename 到目标;exit 0 但组仍活 ⇒ `ensureProcessGroupGone` escalation 后 `ok:true` + warning;超时 ⇒ 断言 TERM(-pgid)→ probe → KILL(-pgid)→ 轮询序列,合法 PNG 被保留且常态 timeout cleanup 不告警、缺失/非法 PNG 才 `ok:false`;SIGKILL 后短暂 EPERM 继续轮询至 ESRCH 后才安装/清理,持续 EPERM 沿用 survived;spawn `error` 事件 / `child.pid === undefined` ⇒ fail envelope,无任何 `-undefined` 信号;rename 注入 EXDEV 错误 ⇒ 命令 fail 且旧 target 内容逐字节不变。

**产物新鲜度负例(Round 1 issue 4)**:目标路径预置旧 PNG 而本次 Chrome 未写 tmp 文件 ⇒ fail(stale 不被采信);短文件 / 错 magic / 缺 IHDR ⇒ 各自 fail。

**收尸行为级真验(不 mock,核心属性)**:`--chrome-bin` 指向 fixture 脚本,三种:① **parent spawn 一个忽略 SIGTERM 的 grandchild 后自己退出**(复现 Round 1 控制实验:direct child ESRCH 但组仍活)⇒ `--shot-timeout-ms 1000`,断言最终 `kill(-pgid, 0)` 抛 ESRCH(**整组**真死了);② parent 本身忽略 TERM 永不退出 ⇒ 同断言;③ **parent 写出合法 PNG 后 exit 0,但 grandchild 忽略 TERM 存活**(Round 2 issue 1)⇒ 断言 PGID 被清空且 envelope `ok:true` + escalation warning。

**真 chrome 集成(host-gated,无 chrome 则 skip)**:测试内启动绑定 `127.0.0.1` 随机端口的最小 HTTP server(`afterEach/finally` 必关),对 `http://127.0.0.1:<port>/report.html` 跑 built CLI ⇒ ok + PNG 验证通过 — 同时走真 fetch 与真 Chrome 路径,**不为测试放宽 `file:` scheme 合同**(Round 2 issue 3)。

### 5.2 reaper(扩展 `chrome-session-reaper.test.ts`)

- **must-kill fixture = 本次泄漏的两条真实 argv**(包括 ownerless cp7/cp8 profile)+ mock age 10h ⇒ 走完 TERM→确认退出 ⇒ `killedHeadlessShot=2`,audit payload 已脱敏;
- **escalation**:TERM 后 mock 进程仍在(同 lstart)⇒ KILL ⇒ 确认 ⇒ 计数;KILL 后仍在 ⇒ **不计数不写 event**,errors 有记录;
- **身份栅栏**:kill 前复读 lstart 不同(PID 复用)⇒ `racedSkipped`,原进程的 10h age 不会转嫁给新进程;
- **分类优先级**:active attributed Chrome for Testing + `--screenshot` + age 10min ⇒ `killedHeadlessShot`(不被旧分支的 skippedActive 截走);agent-browser 长驻(`--headless=new` 无 `--screenshot`)⇒ 走既有归属路径,旧类别计数与既有用例逐字节不变;
- must-skip:headed(无 `--headless`);comm=claude 而 argv 带全套字符串(身份判据);命中但 age 3min ⇒ `skippedHeadlessShotFresh`;age sensor join 不上 ⇒ skip + error;
- **sensor 故障隔离**:`listAgeByPid` 整体 reject ⇒ headless-shot 类别零处理 + 一条 sensor error,**既有 attributed/unattributed 处理计数不变**(旧类别行为零变化的回归锚);
- `parseEtimeToMs` 表驱动:`05`、`4:20`、`1:02:03`、`12-01:02:03`、垃圾输入 ⇒ null;`lstart` 含空格的行解析正确;复验三调用用 production-shaped 输出(完整 `/Applications/Google Chrome.app/.../Google Chrome` 含空格 comm + 含空格 argv),任一 sensor 调用 reject ⇒ fail-closed 零信号 + error 记录;
- plugin.ts 日志:新计数出现在触发条件与文本中(单测或最小集成断言)。

### 5.3 全仓 gate

`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run`(host 负载下按仓库惯例如实报告环境项,不伪报整门全绿);定向:flywheel-comm + teamlead 相关文件。

---

## 6. 风险与兼容

| 风险 | 处置 |
|---|---|
| `ChromeReapResult` 新字段破坏既有 `toEqual` 断言 | 同 PR 同步更新(§3.3),diff 里可见 |
| 第三个 ps pass 每 tick 多一次 `ps` | 与既有两 pass 同级成本(bounded timeout),独立 try/catch 故障隔离(§3.2) |
| verify-report 对 Vercel hosted URL 的网络抖动 | bounded timeout + fail-loud,重跑即可;验证命令失败本就该拦交付 |
| 5 分钟阈值误杀正在跑的合法 one-shot 截图 | one-shot 设计寿命秒级(virtual-time-budget ≤4s);≥75 倍余量;若真有超长合法用例,那本身就是该被 verify-report 硬超时取代的形态 |
| reaper KILL 后仍存活(D-state 等理论情形) | 不计数不写 event,errors 可见;下一 tick 重进序列;不会制造虚假 reaped audit |
| skills PR 与本仓 PR 跨仓时序 | §4:本仓先 ship,skills PR 随后 |
| agent memory 里的旧配方(量高度 playwright 法等)不受本单管辖 | 诚实边界:C 只改共享 skill 文本;memory 收敛靠 agent 自身撞到新 skill 文本后更新 |

## 7. 实施顺序(单 PR,分 commit)

1. RED:verify-report 测试骨架(含收尸 fixture 真验 + 产物新鲜度负例)+ reaper 新用例(含两条真实泄漏 argv fixture + escalation + 身份栅栏 + sensor 隔离)
2. GREEN:`verify-report.ts` + index.ts 注册(含边界校验层)
3. GREEN:reaper `parseHeadlessShotProc` + age/lstart pass + one-shot 优先分支 + escalation + 脱敏 audit
4. GREEN:plugin.ts 日志接线
5. 全仓 gate + codex code review
6. (随后)flywheel-skills repo 单独 PR(交付物 C)

---

## 附:Codex design review 记录

- R1(2026-08-17,xhigh):CHANGES REQUESTED — 8 项(4 HIGH:PGID 后置条件/reaper escalation+确认计数/lstart 身份栅栏+分类优先级/截图产物新鲜度;2 MEDIUM:sensor 故障隔离+plugin 日志接线、CLI 边界+一行 JSON 契约;1 MEDIUM skills 措辞;1 LOW audit 脱敏)。全部采纳,零 reject。
- R2(2026-08-17,xhigh):CHANGES REQUESTED — 4 项(1 HIGH:PGID 后置条件统一到 exit 0 / 非零 exit / timeout 三路径,`ensureProcessGroupGone` + escalation 后合法产物 = ok+warning;2 MEDIUM:复验拆三个独立 ps 调用不设模糊列 parser、host-gated 集成改 127.0.0.1 迷你 server 不放宽 file: 合同;1 LOW:tmp 输出放目标同父目录保真原子 rename,EXDEV 注入负例)。全部采纳,零 reject。
- R3(2026-08-17,xhigh):**APPROVED — ready to implement**。
- 独立 QA rework(2026-08-17):发现 macOS SIGKILL 后 PGID probe 偶发 EPERM,导致约 1/3 假失败并泄漏 profile 目录。增量实现补 EPERM tri-state、PNG IEND、不可解析 ps fail-safe、4 路有界并发,并把截图默认硬超时降到 20s(真实 Chrome 集成测试独立给 30s,避免把宿主负载抖动误当产品默认)。后续 review fault injection 又覆盖 TERM signal EPERM、persistent probe EPERM 与 SIGKILL survivor 三条失败出口,临时 profile/tmp 现统一由 `finally` 清理。审阅曾建议 owner fence;Lead 复核事故 argv 后否决:cp7/cp8 等 legacy/手拉病灶没有 marker,加 fence 会让泄漏复发,故维持有意的整机窄选择器并在 PR 披露 blast radius。
