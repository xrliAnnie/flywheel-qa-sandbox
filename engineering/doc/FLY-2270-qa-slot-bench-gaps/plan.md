# FLY-2270 529 房台架缺口:报告链隔离发布 + Bridge TMPDIR 固定 — 实施计划

Issue: FLY-2270 (https://linear.app/geoforge3d/issue/FLY-2270/529-房台架缺口-slot-bridge-结构上没有-vercel-token报告卡片链在隔离房覆盖不到-runner-环境-tmpdir)
日期: 2026-09-03
基于: research.md

**Status**: draft(Codex design review 进行中;v6:吸收 Round 5 全部 4 条——token 原子替换安装、阳性对照与 exit-70 用例真正打到目标实现、RED 1 传父 pid、措辞归一;v5:v4 的父进程绑定 + 吸收 Round 4 全部 6 条——关掉 ppid 基线竞争、包装脚本先校验再动文件系统、cycle 换端口语义、静态合同去掉分支依赖、research 对齐、措辞归一)

## 0. 一句话

slot 起来时顺带起一个只听 `127.0.0.1` 的「假 Vercel」(stub 托管服务),它由 Bridge 的启动包装脚本拉起、随 Bridge 进程一起消失;Bridge 拿 slot 自己铸的随机 token 往它上面发布;Bridge 的 TMPDIR、报告注册表、previews 全部固定到 `${SLOT_DIR}` 下;生产 Bridge 在开关未设时行为逐字节不变。

## 0.1 v3 → v4 变了什么(只删不加)

v3 把 stub 当独立守护进程管:pid / pid-identity / port 三份所有权元数据、start/stop 两个 shell 函数、teardown Step 5d、失败清理里的锁保留分支、启动事务、`teardown all` 聚合。Codex R2/R3 连续在这一处铸出新 BLOCKER(11 条 host 起点之后的直接删锁路径、启动期无元数据窗口、trap 早于 `SLOT_DIR`、`all` 吞 rc)。这些都是「一个与 Bridge 生命周期不同步的进程」带来的,不是修补能收敛的。

v4 让 stub 的生命周期**等于** Bridge 进程的生命周期:launch spec 的 `command` 前面加一个包装脚本,它起 stub、等就绪、把 URL 导出进环境、再在**同一个 pid** 里 `exec` Bridge;stub 每 500 ms 看一眼 `process.ppid`,父进程(即 Bridge)一死就自退。于是:

| v3 机制 | v4 |
|---------|----|
| `qa_report_host_start` / `qa_report_host_stop` | 删除;只剩一个 30 行的包装脚本 |
| pid / pid-identity / port 所有权文件 | 删除;只剩 `port`(就绪承诺,只读) |
| teardown Step 5d、`all` 聚合、失败清理锁保留、11 条删锁路径改造 | 全部不需要:teardown Step 5 杀 Bridge、`test-cycle-bridge.sh` 回放 spec,stub 自动跟随 |
| 启动事务 / 元数据窗口 | 不存在:stub 起不来 ⇒ 包装脚本非零退出 ⇒ Bridge 没起 ⇒ 既有 readiness 失败路径 fail loud(原因在 `bridge.log`) |

已在本机验证(2026-09-03,macOS 25.6):bash 起子进程后 `exec` 另一程序,父退出后子进程 250 ms 内观察到 `ppid` 变为 1 并自退。

## 0.2 Lead 对 v4 的六条要求如何落地

| Lead 要求 | 落点 |
|-----------|------|
| ① 净删除落到同一 PR | v3 机制从未进过代码;本 PR 内被替代/删除的只有 `qa_generalized_safe_tmpdir` 及其测试(Task 4)。launch-boundary 静态合同断言 `qa_report_host_start` / `qa_report_host_stop` / `pid-identity` / `Step 5d` 在 `scripts/` 中 0 次出现,`test-teardown.sh` 与 main 无 diff——「暂时保留」在合同上不可能 |
| ② 父死自退真测 + 阳性对照 | Task 3 RED 1 / 1b;R4 后新增的就绪前杀包装脚本用例同样带阳性对照(RED 3b / 3b-对照) |
| ③ stub 起不来 fail-loud + 会红的测试 | Task 3 RED 3(包装脚本 exit 70、原因进 `bridge.log`、Bridge 未启动) |
| ④ 保留 R3 仍成立的三条 | sites 符号链接(Task 3 RED 12 / GREEN);env-wrapper 可移植断言(RED 4);措辞(Task 3 元数据权威一句话) |
| ⑤ 不引入新开关 / env 旋钮 | 包装脚本只吃位置参数;stub 只吃 `--root <dir> --expected-parent <pid>`(后者由包装脚本填自己的 `$$`,是内部合同不是可调项);端口 0 与 `port` 文件是实现细节,没有任何 env / flag 能改;唯一的环境变量仍是 Bridge 读的 `FLYWHEEL_REPORT_HOST_OVERRIDE_URL`,由包装脚本导出 |
| ⑥ publish-html 两条要求 | §2 关闭态响应 + §2.1 生命周期 + Task 2 两态测试 |

## 1. 范围

**改**:
- 生产代码(4 个文件 + 1 个新纯函数模块):`vercel-deploy.ts`、`reports-route.ts`、`publish-html-route.ts`(只加一个「已关闭」分支)、`plugin.ts`、新 `report-host-override.ts`。
- QA 台架:`scripts/test-deploy.sh`、`scripts/lib/qa-generalized.sh`、新 `scripts/lib/qa-report-host.mjs`、新 `scripts/lib/qa-report-host-bridge-wrapper.sh`。**`test-teardown.sh` 不改。**
- 测试:见 §5;`ci.yml` 登记两个新 shell 套件;`test-deploy-fly1389.test.sh` fixture 与用例扩展。
- 文档:`doc/qa/framework/529-room-playbook.md`、`doc/reference/remote-report-pipeline.md`、milestone。

**不改**:`publish-report` CLI、`report-registry.ts`、`deployToVercel`、Discord 投递、`test-teardown.sh`、`TmuxAdapter` / `CodexTmuxAdapter` 的 runner 环境白名单、Lead 非 generalized 模式的 TMPDIR、默认模式 `/api/reports` 的 503。

## 2. 稳定标识与显示名

| 类别 | 值 | 说明 |
|------|----|------|
| 环境变量(Bridge 读) | `FLYWHEEL_REPORT_HOST_OVERRIDE_URL` | 唯一新开关;**原始字符串**必须匹配 `^http://127\.0\.0\.1:([1-9][0-9]{0,4})/?$` 且端口 ≤ 65535(先正则后 `new URL` 双重校验,拒绝 `127.1`/十进制/十六进制等 WHATWG 归一化写法);未设 = 生产路径。**由包装脚本在 Bridge 启动那一刻导出**,不在 launch spec 的 `environment` 里 |
| 环境变量(既有,slot 新注入) | `FLYWHEEL_REPORTS_DIR`、`VERCEL_TOKEN`、`TMPDIR` | 名字不变,只是 test-deploy 开始注入(`VERCEL_TOKEN` 走 spec 的 secret 文件) |
| slot 目录 | `${SLOT_DIR}/tmp`、`${SLOT_DIR}/state/reports/`、`${SLOT_DIR}/state/report-host/{token,port,sites/}`、`${SLOT_DIR}/report-host.log` | 全在 slot 树内 |
| `port` 文件 | 由 stub 在自探活成功后原子写;**只读承诺**,没有人删它(下次启动前由包装脚本 `rm -f` 重置) | 唯一的元数据 |
| 包装脚本 | `scripts/lib/qa-report-host-bridge-wrapper.sh <root> <node> -- <bridge command…>` | 进 launch spec 的 `command`;`test-cycle-bridge.sh` 回放时原样重跑。**cycle 会让 stub 绑到新端口**:之前投到 Discord 的 slot 报告链接与首次 `reportHost.url` 都会失效(注册表与页面仍在,重新 publish 即可);这是有意的、写进 playbook,cycle 测试断言旧 URL 拒绝连接、新 URL 200 |
| stub 启动参数 | `--root <dir> --expected-parent <pid>` | 由包装脚本填写,stub 在 listen 之前与每次轮询都要求 `process.ppid === expected`,否则退出(66);关掉「包装脚本在 Node 求值前被杀 ⇒ 基线变成 1 ⇒ 永不自退」的竞争 |
| test-deploy 输出字段 | `reportHost: {url, tokenPath, sitesDir} \| null`、`reportsDir`、`bridgeTmpDir` | 用 `jq -nc` 构造;`url` 在 Bridge 健康检查通过后读 `port` 文件得到 |
| Bridge 启动日志 | `[Bridge] report host override active (QA only): <url>` 与 `[Bridge] /api/publish-html disabled while FLYWHEEL_REPORT_HOST_OVERRIDE_URL is set (QA slot); use flywheel-comm publish-report` | QA 用它当「开关生效」证据 |
| 包装脚本失败日志 | `[qa-report-host-wrapper] report host did not become ready within 10s; refusing to start the Bridge`(exit 70) | 出现在 `bridge.log` |
| publish-html 关闭态响应 | HTTP 503 `{ "error": "HTML publishing is disabled while FLYWHEEL_REPORT_HOST_OVERRIDE_URL is active (QA slot report host). Use `flywheel-comm publish-report` (POST /api/reports/publish) instead." }` | fail-loud,文案直接指出正确通路(Lead 要求 ①) |
| stub 日志前缀 | `[qa-report-host]` | |
| 部署 id | `dpl_<12 hex>` | Bridge 只当不透明字符串 |
| 公开 URL 形状(override 时) | `http://127.0.0.1:<port>/<vercelProjectName>/r/<token>/` | 与生产同尾部,CLI 与 deliver 零改动 |
| 投递所有权 | **Lead / QA 操作者(master 凭证)** | runner 只有 ingest 凭证,CLI 已强制 `--publish-only`(`publish-report.ts:143-146`);不把报告目录穿透进 runner 环境白名单 |

### 2.1 publish-html「关闭」的生命周期(Lead 要求 ②)

- 关闭**不是旋钮**:它完全由 Bridge 启动那一刻 `FLYWHEEL_REPORT_HOST_OVERRIDE_URL` 是否被设定推导出来,没有任何运行时开关、DB 字段或 API 可以单独打开/关闭它。
- 成立条件:仅当 override 生效(即 529 slot Bridge)。生产 Bridge 从不设置这个变量,所以生产的 `/api/publish-html` 行为逐字节不变。
- 解除方式:让 Bridge 在**没有**这个变量的环境里启动。对 slot 来说就是 teardown(slot Bridge 与 stub 一起消失);没有「slot 内解除」的路径,也不需要——slot 里生成 HTML 的正确通路就是 `publish-report`。
- 谁负责:实现方在 `remote-report-pipeline.md` 写明这一段;任何未来想在 override 下重新打开 publish-html 的人必须先给它一个能被 stub 托管且返回 URL 可 GET 的语义(Codex R1 #5 指出的假成功),不能只拔掉关闭。

## 3. 数据 / 结构模型

```mermaid
classDiagram
  class TestDeploy {
    +SLOT_DIR 建好后立刻:初始化 BRIDGE_EXTRA_ENV / LEAD_EXTRA_ENV;解析并校验 QA_SLOT_BRIDGE_NODE
    +mkdir tmp, state/reports, state/report-host(所有模式)
    +BRIDGE_EXTRA_ENV += TMPDIR, FLYWHEEL_REPORTS_DIR
    +LEAD_EXTRA_ENV += FLYWHEEL_REPORTS_DIR
    +有 API token: 铸 token 文件(env -i node);BRIDGE_EXTRA_ENV += VERCEL_TOKEN;REPORT_HOST_WRAPPER_ARGS = (bash wrapper root node --)
    +三条 capture 分支:command = ${REPORT_HOST_WRAPPER_ARGS[@]} … npx tsx run-bridge.ts;env -u VERCEL_TOKEN
    +Bridge 健康后读 port 文件 → 输出 reportHost.url
  }
  class Wrapper {
    先校验:root 是真实目录、非符号链接、canonical 路径 == /tmp/flywheel-test-slot-N/state/report-host;token 存在且非符号链接
    然后才 rm -f root/port
    env -i HOME PATH node qa-report-host.mjs --root root --expected-parent $$ &(后台)
    等 port ≤10 s,否则 kill 子进程、exit 70
    export FLYWHEEL_REPORT_HOST_OVERRIDE_URL
    exec "$@"(同 pid 变成 Bridge)
  }
  class ReportHostStub {
    root: SLOT_DIR/state/report-host;拒绝 root / token / sites 为符号链接
    读 token;listen 127.0.0.1:0;自探活后原子写 port
    listen 前与每 500 ms 都要求 process.ppid === expected-parent,否则退出;SIGTERM 也退出
    POST /v13/deployments (Bearer == token,schema 校验,串行,staging rename,失败回滚)
    GET /v13/deployments/:id;GET /:name/r/:token/ 静态(path.relative 围栏)
  }
  class Bridge {
    startBridge 开头: parseReportHostOverride(env) → override | undefined | throw
    createReportsRouter(hostOverride)
    createPublishHtmlRouter(token, disabledByOverride) → 503 fail-loud
  }
  class VercelDeploy {
    deployFilesToVercel(token, name, files, timeoutMs, apiBaseUrl = api.vercel.com)
    override 时 fetch redirect = error
  }
  TestDeploy --> Wrapper : launch spec command
  Wrapper --> ReportHostStub : 起(子进程)
  Wrapper --> Bridge : exec(同 pid)
  ReportHostStub ..> Bridge : ppid 监视,Bridge 死则自退
  Bridge --> VercelDeploy : apiBaseUrl
  VercelDeploy --> ReportHostStub : POST (override) / api.vercel.com (生产)
```

## 4. 任务(TDD,每个任务 RED → GREEN)

### Task 1 — 生产缝:`vercel-deploy.ts` 接 `apiBaseUrl`

**Files**: `packages/teamlead/src/bridge/vercel-deploy.ts`, `packages/teamlead/src/__tests__/vercel-deploy.test.ts`

- [ ] RED:新增用例「`deployFilesToVercel(..., undefined, "http://127.0.0.1:4321")` → POST 到 `http://127.0.0.1:4321/v13/deployments` 且 `init.redirect === "error"`,非 READY 时轮询 `http://127.0.0.1:4321/v13/deployments/<id>`」;「默认 base 时 `init.redirect` 为 `undefined`」;既有 4 个 GEO-294 sentinel 用例与 2 个 FLY-203 用例一字不改并保持绿。
- [ ] GREEN:`export const VERCEL_API_BASE_URL = "https://api.vercel.com"`;`deployFilesToVercel(vercelToken, deploymentName, files, timeoutMs = DEFAULT_TIMEOUT_MS, apiBaseUrl = VERCEL_API_BASE_URL)`;`waitForReady(token, id, signal, apiBaseUrl)`;两处 `fetch` URL 由 `${apiBaseUrl}/v13/deployments…` 组装(base 去尾 `/`);`apiBaseUrl !== VERCEL_API_BASE_URL` 时 fetch init 加 `redirect: "error"`(生产请求对象不变)。`deployToVercel` 零改动。

### Task 2 — 生产缝:`report-host-override.ts` + `reports-route.ts` + `publish-html-route.ts` 关闭态 + `plugin.ts` 接线

**Files**: 新 `packages/teamlead/src/bridge/report-host-override.ts`、新 `__tests__/report-host-override.test.ts`、`reports-route.ts`、`__tests__/reports-route.test.ts`、`publish-html-route.ts`、`__tests__/publish-html-route.test.ts`、`plugin.ts`、`__tests__/bridge.test.ts`

- [ ] RED(override 纯函数):`parseReportHostOverride(undefined | "" | "   ")` → `undefined`;`"http://127.0.0.1:4321"` 与 `"http://127.0.0.1:4321/"` → `{apiBaseUrl:"http://127.0.0.1:4321", publicBaseUrl: 同}`;以下每个都 throw 且信息含 `FLYWHEEL_REPORT_HOST_OVERRIDE_URL`:`https://127.0.0.1:1`、`http://localhost:1`、`http://[::1]:1`、`http://127.1:1`、`http://2130706433:1`、`http://0x7f000001:1`、`http://10.0.0.5:1`、`http://127.0.0.1`(无端口)、`http://127.0.0.1:0`、`http://127.0.0.1:65536`、`http://127.0.0.1:1/x`、`http://127.0.0.1:1?x`、`http://127.0.0.1:1#x`、`http://u:p@127.0.0.1:1`、`not a url`。
- [ ] RED(reports-route):`hostOverride` 存在 → 响应 `url === "http://127.0.0.1:4321/<vercelProjectName>/r/<token>/"`,且注入的 `deployFiles` mock 收到第 5 参 `"http://127.0.0.1:4321"`;不存在 → 既有 `https://…vercel.app/r/<token>/` 断言不变,mock 第 5 参 `undefined`。既有用例只解构前三个参数(`reports-route.test.ts:258,316`),不受影响。
- [ ] RED(publish-html 两态):`createPublishHtmlRouter(token)` → 既有行为不变;`createPublishHtmlRouter(token, { disabledByReportHostOverride: true })` → 503,body.error 含 `FLYWHEEL_REPORT_HOST_OVERRIDE_URL` 与 `publish-report`,且 `deployToVercel` mock **未被调用**;`createPublishHtmlRouter(undefined, {disabledByReportHostOverride:true})` 也是 503(关闭优先于 501,文案一致)。
- [ ] RED(boot,`bridge.test.ts`):
  - 「`FLYWHEEL_REPORT_HOST_OVERRIDE_URL=http://10.0.0.5:1` 时 `startBridge` reject,且在 `scrubManagedTmuxEnvironments` 与 StateStore 打开之前」(spy 断言未被调用);
  - 「合法 override」用例:**先** `const reportsRoot = mkdtempSync(...)`,`vi.stubEnv("FLYWHEEL_REPORTS_DIR", reportsRoot)`,`vi.stubEnv("FLYWHEEL_REPORT_HOST_OVERRIDE_URL", "http://127.0.0.1:<本测试起的假 vercel 端口>")`,`vi.stubEnv("VERCEL_TOKEN", "t")`,然后 `startBridge`;断言 `/api/reports/publish` 返回 `http://127.0.0.1:<port>/…/r/<token>/`、`registry.json` 与 `files/` 只出现在 `reportsRoot`、`/api/publish-html` 503 且文案含 `publish-report`;`finally` 里 `close()` + `rmSync(reportsRoot)`;负向哨兵:用例开始前记录 `~/.flywheel/reports/registry.json` 的 mtime(不存在则记「不存在」),结束后断言不变/仍不存在。
- [ ] GREEN:
  - `report-host-override.ts`:`export interface ReportHostOverride { apiBaseUrl: string; publicBaseUrl: string }` + `parseReportHostOverride(raw)`:trim 后空 → `undefined`;先用 §2 的正则校验**原始字符串**并检查端口 ≤ 65535,再 `new URL()` 复核 `protocol/hostname/port/pathname/search/hash/username/password`;任一失败 throw `Error("FLYWHEEL_REPORT_HOST_OVERRIDE_URL must be exactly http://127.0.0.1:<port> (QA loopback only); refusing to start")`(不回显原值);返回值规范化为 `http://127.0.0.1:<port>`。
  - `reports-route.ts`:`ReportsRouterOptions.hostOverride?: ReportHostOverride`;`const deployFiles = opts.deployFiles ?? deployFilesToVercel;` 保留,调用改为统一 5 参 `deployFiles(token, name, files, undefined, opts.hostOverride?.apiBaseUrl)`;URL 组装抽成 `publicReportUrl(hostOverride, vercelProjectName, token)`。
  - `publish-html-route.ts`:`createPublishHtmlRouter(vercelToken, opts?: { disabledByReportHostOverride?: boolean })`;handler 第一步:`if (opts?.disabledByReportHostOverride) { res.status(503).json({ error: <§2 文案> }); return; }`;其余零改动。
  - `plugin.ts`:`startBridge` 开头、`FW_*` 退役凭证删除(`:4507-4511`)之后**立刻** `const reportHostOverride = parseReportHostOverride(process.env.FLYWHEEL_REPORT_HOST_OVERRIDE_URL)`;有则两行日志(§2)。经与 `vercelToken` 同层的 opts 传入 `createBridgeApp`;**在 `createBridgeApp` 内一律引用 `opts?.reportHostOverride`**(`:4298` → `createPublishHtmlRouter(opts?.vercelToken, { disabledByReportHostOverride: Boolean(opts?.reportHostOverride) })`;`:4316` → `createReportsRouter({ …, hostOverride: opts?.reportHostOverride })`)。

### Task 3 — QA stub:`scripts/lib/qa-report-host.mjs` + `qa-report-host-bridge-wrapper.sh`

**Files**: 新 `scripts/lib/qa-report-host.mjs`、新 `scripts/lib/qa-report-host-bridge-wrapper.sh`、新 `scripts/__tests__/qa-report-host.test.sh`、`.github/workflows/ci.yml`

元数据权威(一句话说清):**stub 只在自探活成功后原子写 `port`;包装脚本在校验 root 之后、起 stub 之前 `rm -f port`;没有别的元数据,没有人「拥有」这个进程——它的父进程(由 `--expected-parent` 钉死)就是它的生命周期。**

- [ ] RED(`qa-report-host.test.sh`,真起进程,每个用例**独立 root**,`trap cleanup EXIT INT TERM`,cleanup 按记录的 pid 逐个 TERM):
  1. **父死自退(真杀父进程)**:用一个测试父脚本(`bash -c 'node stub --root R --expected-parent $$ & exec sleep 60'`,`$$` 即该父 shell,`exec` 后 pid 不变)起 stub;**先**等 `port` 出现并 `curl` self-check 200(证明 stub 到达就绪、正在监听),记录 stub pid 与 port;然后 `kill -9` 父进程;断言 ≤ 3 s 内 `kill -0 <stub pid>` 失败**且** `lsof -nP -iTCP:<port> -sTCP:LISTEN` 为空(进程与端口两个实证)。这是 v4 的核心合同;
  1b. **阳性对照(判别力自检)**:测试把 `qa-report-host.mjs` 拷到临时文件并用 `sed` 删掉「listen 前比对」与「轮询比对」两处(拷贝后断言两处都不在了),用与 1 **完全相同的启动命令**(同样传 `--expected-parent $$`)、同样的就绪等待与同样的断言跑一遍,**期望断言失败**(stub 活过父进程);若阳性对照反而通过,整个套件以非零退出——证明第 1 条不是空转绿。stub 本身**不带**任何关闭自退的开关;
  2. **包装脚本**:`qa-report-host-bridge-wrapper.sh <root> <node> -- <fake bridge>`,fake bridge 是测试自建脚本,把自己收到的环境写到 `<root>/../bridge-env.txt` 后 `sleep 5`;断言 `bridge-env.txt` 含 `FLYWHEEL_REPORT_HOST_OVERRIDE_URL=http://127.0.0.1:<port 文件内容>`、fake bridge 的 pid == 包装脚本的 pid(`exec` 同 pid)、stub 的 ppid == 该 pid;杀掉 fake bridge 后 stub ≤ 3 s 自退;
  3. **包装脚本失败(exit 70 分支)**:root 是合法的 canonical 目录、`token` 是**存在的普通文件但模式 0644**——包装脚本的前置校验(存在、非符号链接)通过,stub 自己的 0600 校验失败以 64 退出,永不写 `port` → 包装脚本 ≤ 12 s 内以 70 退出、stderr 含 `did not become ready`、fake bridge **未被启动**(`bridge-env.txt` 不存在)、无残留 node 进程(用 `pgrep -f 'qa-report-host.mjs --root <root>'` 为空实证);
  3b. **包装脚本在就绪前被杀(ppid 基线竞争)**:用会 `sleep 2` 再 `exec` 真 node 的 Node 包装作为 `<node>`,起包装脚本后 0.5 s `kill -9` 包装脚本;断言 ≤ 3 s 内没有任何带 `qa-report-host.mjs --root <root>` 的进程、`port` 不存在、无监听。原理:stub 起来时 `process.ppid` 已不等于 `--expected-parent`,listen 前即退出;
  3b-对照. **阳性对照(判别力自检)**:包装脚本从**自己所在目录**解析 stub 路径,所以对照必须把 `qa-report-host-bridge-wrapper.sh` 与经 `sed` 删掉两处比对的 `qa-report-host.mjs` 副本一起拷进同一个临时 `lib/` 目录(拷贝后断言两处都不在了),然后调用**临时目录里的那份**包装脚本跑与 3b 完全相同的场景;**期望** 3 s 后仍有一个带 `qa-report-host.mjs --root <root>` 的进程在监听(孤儿);测试随后自己杀掉它。若对照没有产生孤儿,整个套件以非零退出——证明 3b 不是装饰;仍无运行时开关;
  3c. **包装脚本先校验再动文件系统**:`root` 为指向 slot 外目录的符号链接 → 包装脚本以 64 退出,`rm -f port` 与日志重定向都**未发生**(外部目录预放哨兵 `port` 文件,断言仍在;外部目录没有新文件);`token` 为符号链接 → 同样 64;
  4. **启动边界**:用测试自建的绝对路径 Node 包装(记录环境到 `<root>/../env-seen-<argv[1] 的 basename>.txt` 后 `exec` 真 node,因此 stub 与铸 token 两次调用各有一份文件)作为 `<node>`;父环境 `VERCEL_TOKEN=leak FOO=bar` 下起包装脚本;断言两份文件都**不含** `VERCEL_TOKEN`/`FOO`,`HOME`/`PATH` 等于预期值(允许 `PWD`/`SHLVL`/`_` 等 shell 自带变量);
  5. `POST /v13/deployments` 无/错 Bearer → 401,`sites/` 无变化;
  6. 对 Bearer + 合法 body → 200 `{id:/^dpl_[0-9a-f]{12}$/, readyState:"READY", url}`;`GET /fw-reports-abc/r/t1/` 200 `text/html; charset=utf-8`;`GET /fw-reports-abc/robots.txt` 200;
  7. `GET /v13/deployments/<id>` → `{readyState:"READY"}`;未知 id → 404;
  8. schema:`target` 非 `"production"`、`files` 非数组/空/超 200 项、任一 file 缺 `file`/`data` 字符串或 `encoding !== "utf-8"`、路径含 `..`/以 `/` 开头/含 `\`/含 `\0`、`name` 不匹配 `^[a-z0-9-]{1,64}$` → 400,`sites/` 无变化;
  9. 第二次部署只带 `r/t2/index.html` → `…/r/t1/` 404、`…/r/t2/` 200;两个并发 POST(不同 name)都 200 且互不污染;
  10. 遍历:`curl --path-as-is` 打 `/fw-reports-abc/../../etc/passwd`、`/fw-reports-abc/r/%2e%2e/%2e%2e/token`、预建的兄弟目录 `sites-evil/x.html` 经 `/../sites-evil/x.html` → 全部 404;`lsof` 证明只绑 `127.0.0.1`;
  11. 请求体 > 16 MiB → 413;发一半 body 就断开的请求不阻塞后续请求;
  12. **符号链接拒绝(stub 自身,直接启动)**:root 为符号链接、`token` 为符号链接、`sites` 为指向 root 外目录的符号链接 → stub 以 64 退出,`port` 不写,外部目录**零写入**(预放哨兵文件并比对目录列表);`--expected-parent` 缺失或非数字 → 64;
- [ ] GREEN(`qa-report-host.mjs`):零依赖 `node:http`;参数 `--root <dir> --expected-parent <pid>`(两者必填,pid 必须是正整数,否则 exit 64);启动第一步 `if (process.ppid !== expectedParent) process.exit(66)`;`lstatSync` 拒绝 root/token/sites 为符号链接(sites 不存在则创建),并断言 `realpath(sites)` 的父目录 == `realpath(root)`;读 `token`(存在、0600、单行,否则 exit 64);`listen(0, "127.0.0.1")`;拿到端口后用自己的 token `GET /v13/deployments/self-check`(200 `{}`)自探活,**成功后**才原子写 `port`;`setInterval(() => { if (process.ppid !== expectedParent) process.exit(0); }, 500)`(不 unref:这个定时器就是进程活着的理由);`SIGTERM/SIGINT` → `server.close()` 后退出;`server.requestTimeout = 10_000`、`headersTimeout = 5_000`、body 累计 > 16 MiB 立即 413 并 `destroy`;部署互斥用 promise 链串行;每次部署:schema 全量校验(§RED 8)→ 写 `sites/.staging-<name>-<seq>-<hex>/` → 若 `sites/<name>` 存在先 `rename` 到 `sites/.prev-<name>-<seq>` → staging `rename` 上位,失败则把 prev `rename` 回去并 500 → 成功后 `rm -rf` prev(有界 QA 交换);静态 GET 用 `path.relative(sitesRoot, path.resolve(...))`,结果为绝对路径或以 `..` 开头 → 404;错误响应不回显路径。
- [ ] GREEN(`qa-report-host-bridge-wrapper.sh`):
  ```bash
  #!/usr/bin/env bash
  set -euo pipefail
  root="${1:?root}"; node="${2:?node}"; [[ "${3:-}" == "--" ]] || exit 64; shift 3
  [[ "$node" == /* && -x "$node" ]] || exit 64
  # 先校验,再碰任何文件:root 必须是真实目录、非符号链接、canonical 路径就是 slot 树里的那个位置
  [[ -d "$root" && ! -L "$root" ]] || { echo '[qa-report-host-wrapper] report host root must be a real directory' >&2; exit 64; }
  canonical="$(cd "$root" && pwd -P)"
  [[ "$canonical" =~ ^/(private/)?tmp/flywheel-test-slot-[1-9][0-9]*/state/report-host$ ]] \
    || { echo '[qa-report-host-wrapper] report host root is outside the slot tree' >&2; exit 64; }
  [[ -f "${canonical}/token" && ! -L "${canonical}/token" ]] || { echo '[qa-report-host-wrapper] token missing or symlinked' >&2; exit 64; }
  slot_dir="$(cd "${canonical}/../.." && pwd -P)"
  lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  rm -f "${canonical}/port"
  env -i HOME="$HOME" PATH="$PATH" "$node" "${lib}/qa-report-host.mjs" --root "$canonical" --expected-parent "$$" >> "${slot_dir}/report-host.log" 2>&1 &
  stub=$!
  for _ in $(seq 1 100); do [[ -s "${canonical}/port" ]] && break; kill -0 "$stub" 2>/dev/null || break; sleep 0.1; done
  if [[ ! -s "${canonical}/port" ]]; then
    echo '[qa-report-host-wrapper] report host did not become ready within 10s; refusing to start the Bridge' >&2
    kill "$stub" 2>/dev/null || true; exit 70
  fi
  export FLYWHEEL_REPORT_HOST_OVERRIDE_URL="http://127.0.0.1:$(cat "${canonical}/port")"
  exec "$@"
  ```
`HOME`/`PATH` 来自 spec 环境(spec 的 `environment` 本来就带它们)。`$$` 在 `exec` 之后仍是同一个 pid,所以 stub 的 `--expected-parent` 在 Bridge 整个生命周期内都成立。
- [ ] `ci.yml` 新增一步 `Test — FLY-2270 QA report host stub`:`bash scripts/__tests__/qa-report-host.test.sh`。

### Task 4 — `test-deploy.sh`:TMPDIR 固定 + 报告链注入 + launch 边界

**Files**: `scripts/test-deploy.sh`、`scripts/lib/qa-generalized.sh`、`scripts/__tests__/test-deploy-generalized.test.sh`、`scripts/__tests__/test-deploy-fly1389.test.sh`、新 `scripts/__tests__/test-deploy-launch-boundary.test.sh`、`ci.yml`

- [ ] RED(`test-deploy-launch-boundary.test.sh`,静态合同):
  1. 恰好 3 处 `qa-slot-bridge-spec.mjs" capture`,每一处向上最近的 `env` 块都含 `-u VERCEL_TOKEN`,且每一处的命令尾部里 `${REPORT_HOST_WRAPPER_ARGS[@]+"${REPORT_HOST_WRAPPER_ARGS[@]}"}` 出现在 `"$QA_SLOT_BRIDGE_NPX" tsx` 之前(generalized 分支还要求它在 `qa-generalized-bridge-wrapper.sh` 之后);
  2. `qa_generalized_safe_tmpdir` 在 `test-deploy.sh` 与 `qa-generalized.sh` 中 0 次出现;v3 名字(`qa_report_host_start`、`qa_report_host_stop`、`pid-identity`、`Step 5d`)在 `scripts/` 中 0 次出现——grep 时**排除本合同测试文件自身**,且待查字符串用拼接构造以免自匹配;`test-teardown.sh` 不含 `qa-report-host`(零改动的语义断言;「与 main 无 diff」不做成运行时测试,CI 是浅 clone,放到 PR review 核对);
  3. 行号顺序:`BRIDGE_EXTRA_ENV=()` / `LEAD_EXTRA_ENV=()` < `QA_SLOT_BRIDGE_NODE=` 的早期解析 < `GENERALIZED_CHILD_TMPDIR=` < token 铸造;
  4. `BRIDGE_EXTRA_ENV+=("TMPDIR=${GENERALIZED_CHILD_TMPDIR}")`、`BRIDGE_EXTRA_ENV+=("FLYWHEEL_REPORTS_DIR=${SLOT_DIR}/state/reports")`、`LEAD_EXTRA_ENV+=("FLYWHEEL_REPORTS_DIR=${SLOT_DIR}/state/reports")` 各恰好 1 次;generalized 分支不再单独写 `TMPDIR=`;
  5. token 铸造与 `REPORT_HOST_WRAPPER_ARGS=(…)` 赋值处于 `-n "$GENERALIZED_API_TOKEN_PATH"` 条件内;铸造命令以 `env -i HOME=` 开头。
- [ ] RED(`test-deploy-generalized.test.sh`):删除 `:564-569`;新增 `qa_slot_child_tmpdir "/tmp/flywheel-test-slot-12"` → `/tmp/flywheel-test-slot-12/tmp`;`node -e` 计算 `Buffer.byteLength(result + "/tsx-65535/99999.pipe")`(保守 5 位 uid + 5 位 pid,后缀 21 字节,slot 12 合计 51 字节)断言 `< 104`;对 200 字符 caller `TMPDIR` 结果不变。
- [ ] RED(`test-deploy-fly1389.test.sh`,公开 deploy fixture):
  1. fixture 复制清单加 `qa-report-host.mjs` 与 `qa-report-host-bridge-wrapper.sh`;fixture 的 `$STUB_BIN/npx` 假 Bridge 保持原样(它由包装脚本 `exec`,pid 不变,既有 pid/listener 断言不受影响);
  2. 既有 `--no-lead` 默认用例:输出 `reportHost == null`、`reportsDir`、`bridgeTmpDir`,两目录存在;spec `environment` 含 `TMPDIR=<slot>/tmp` 与 `FLYWHEEL_REPORTS_DIR=…`,`secretEnvironment` **不含** `VERCEL_TOKEN`(父环境 `VERCEL_TOKEN=leak`);spec `command` **不含**包装脚本;
  3. 既有 reply-by-issue 用例(父环境 `VERCEL_TOKEN=leak`):spec `command[0..4]` == `[bash, …/qa-report-host-bridge-wrapper.sh, <slot>/state/report-host, <node>, --]`,`command[5]` 是 `npx`;secret 文件内容 == `tokenPath` 内容且 != `leak`;spec `environment` **不含** `FLYWHEEL_REPORT_HOST_OVERRIDE_URL`(它由包装脚本在启动时导出);`reportHost.url` 匹配 `^http://127\.0\.0\.1:[0-9]+$` 且 == `http://127.0.0.1:$(cat <slot>/state/report-host/port)`;`lead-env.txt` 含 `FLYWHEEL_REPORTS_DIR=<slot>/state/reports`;假 Bridge 记录的环境含 `FLYWHEEL_REPORT_HOST_OVERRIDE_URL=<url>`;`lsof -nP -iTCP:<port> -sTCP:LISTEN -t` 恰一个 pid,其 `ppid` == `bridge.pid` 里记录的 **Bridge 启动链首 pid**(`qa_slot_bridge_exec_spec` 的后台作业 pid;python → 包装脚本 → npx 都是 `exec`,pid 不变;真正的 `node --import tsx` 是它的子进程,不是这个 pid);`curl <url>/v13/deployments/self-check` 带 token 200、不带 401;**teardown 后** ≤ 5 s stub 进程消失、端口不再 LISTEN(靠父死自退,teardown 未改);
  3b. **旧 token 残留用例**:在 reply-by-issue 用例之前预先在 `<slot>/state/report-host/token` 放一个 0600 的旧普通文件(模拟上一次失败 deploy 保留的 slot 目录);deploy 后断言文件内容 != 旧值、== `secretEnvironment` 里 `VERCEL_TOKEN` 文件内容、模式 600,且带新 token 的 self-check 200、带旧 token 401;
  4. **cycle 用例**(既有 `test-cycle-bridge.test.sh` 或 fly1389 内):在 reply-by-issue slot 上跑 `test-cycle-bridge.sh` → 旧 stub 自退、新 stub 起、`port` 文件更新、新 Bridge 环境里的 URL 与新 port 一致;**并断言**旧端口 `curl` 拒绝连接、新端口的 self-check 200——cycle 使既有 slot 报告链接失效是有意语义(§2)。
- [ ] GREEN:
  - `qa-generalized.sh`:删除 `qa_generalized_safe_tmpdir`;新增 `qa_slot_child_tmpdir slot_dir` → `printf '%s/tmp\n' "$slot_dir"`。
  - `test-deploy.sh`:
    - 把 `LEAD_EXTRA_ENV=()` / `BRIDGE_EXTRA_ENV=()` / `GENERALIZED_ENV_UNSET_ARGS=()` 上提到 `SLOT_DIR` 创建之后(`:759` 之前);紧接着**只**把 `QA_SLOT_BRIDGE_NODE="${FLYWHEEL_QA_NODE:-$(command -v node)}"` 及其 `[[ == /* && -x ]]` 校验上提(失败用 `fail_preflight`);npx/bash/python3 的解析与校验留在原地;
    - `GENERALIZED_CHILD_TMPDIR=$(qa_slot_child_tmpdir "$SLOT_DIR")`;`mkdir -p` + `chmod 700` `${SLOT_DIR}/tmp` `${SLOT_DIR}/state/reports` `${SLOT_DIR}/state/report-host`(所有模式);三条 `+=`;删除 `:773-776` 条件回落,改为无条件 log;
    - `REPORT_HOST_WRAPPER_ARGS=()`;API token 块之后:`if [[ -n "$GENERALIZED_API_TOKEN_PATH" ]]; then tok=$(env -i HOME="$HOME" PATH="$PATH" "$QA_SLOT_BRIDGE_NODE" -e 'process.stdout.write(require("node:crypto").randomBytes(16).toString("hex"))'); rh="${SLOT_DIR}/state/report-host"; [[ -d "$rh" && ! -L "$rh" && "$(cd "$rh" && pwd -P)" =~ ^/(private/)?tmp/flywheel-test-slot-[1-9][0-9]*/state/report-host$ ]] || fail_preflight "report host dir must be a real slot directory"; [[ ! -L "${rh}/token" && ( ! -e "${rh}/token" || -f "${rh}/token" ) ]] || fail_preflight "token must be absent or a regular file"; (umask 077; set -o noclobber; printf '%s\n' "$tok" > "${rh}/token.tmp.$$") && mv -f "${rh}/token.tmp.$$" "${rh}/token" || fail_preflight "token install failed"; [[ -f "${rh}/token" && ! -L "${rh}/token" && "$(cat "${rh}/token")" == "$tok" && "$(stat -f %Lp "${rh}/token" 2>/dev/null || stat -c %a "${rh}/token")" == "600" ]] || fail_preflight "token read-back mismatch"; BRIDGE_EXTRA_ENV+=("VERCEL_TOKEN=${tok}"); REPORT_HOST_WRAPPER_ARGS=("$QA_SLOT_BRIDGE_BASH" "${SCRIPT_DIR}/lib/qa-report-host-bridge-wrapper.sh" "${SLOT_DIR}/state/report-host" "$QA_SLOT_BRIDGE_NODE" --); fi`(`QA_SLOT_BRIDGE_BASH` 的解析也需在此之前——它与 npx/python3 一起留在原地会晚于这里;因此把 `QA_SLOT_BRIDGE_BASH` 的解析与校验**一并**上提,npx/python3 留原地);
    - generalized 分支 `:1820` 的显式 `TMPDIR=` 删除;三条 launch 边界各加 `-u VERCEL_TOKEN`;三条 capture 的 `--` 之后插入 `${REPORT_HOST_WRAPPER_ARGS[@]+"${REPORT_HOST_WRAPPER_ARGS[@]}"}`(generalized 分支放在 `qa-generalized-bridge-wrapper.sh` 之后);
    - Bridge 健康检查通过之后(输出 JSON 之前):`if (( ${#REPORT_HOST_WRAPPER_ARGS[@]} )); then port=$(cat "${SLOT_DIR}/state/report-host/port") || fail_preflight "report host port file missing after Bridge became healthy"; REPORT_HOST_JSON=$(jq -nc --arg url "http://127.0.0.1:${port}" --arg tokenPath … --arg sitesDir … '{url:$url,tokenPath:$tokenPath,sitesDir:$sitesDir}'); else REPORT_HOST_JSON=null; fi`;输出加 `reportHost`、`reportsDir`、`bridgeTmpDir`;log 一行验收配方(research §5.3);
    - `cleanup_on_failure` / `test-teardown.sh` **零改动**。
  - `ci.yml` 登记 `test-deploy-launch-boundary.test.sh`(新一步);`test-deploy-qa-room.test.sh` 保持只在 `ci-shell-suite-manual-only.txt`,本单不改它。

### Task 5 — 文档

- [ ] `doc/qa/framework/529-room-playbook.md` 坑表第 2 行改为「Bridge TMPDIR 固定 `${SLOT_DIR}/tmp`,与调用方 env 无关」;新增「报告链在隔离房怎么验」= research §5.3 配方 + 负向对照 + 「投递由 Lead/操作者(master 凭证)执行,runner 只 `--publish-only`」+ 「stub 随 Bridge 进程生灭:`bridge.log` 里 `did not become ready` 表示 stub 起不来,看 `report-host.log`」+ 「`test-cycle-bridge.sh` 之后 stub 换端口,之前发出的 slot 报告链接失效,重新 publish 即可」。
- [ ] `doc/reference/remote-report-pipeline.md` 环境变量表加 `FLYWHEEL_REPORT_HOST_OVERRIDE_URL`(QA only,仅 `http://127.0.0.1:<port>`,其它形状启动即失败;生效时 `/api/publish-html` 503 并指向 `publish-report`;§2.1 生命周期原文)与 `FLYWHEEL_REPORTS_DIR`(529 slot 注入 slot 树)。
- [ ] milestone:`engineering/doc/milestones/FLY-2270.md`(按 README 单写者合同,ship 时最后一个 commit)。

### Task 6 — 全仓验证、code review、PR

```bash
pnpm install --frozen-lockfile
pnpm --filter flywheel-teamlead test -- vercel-deploy reports-route publish-html-route report-host-override bridge
bash scripts/__tests__/qa-report-host.test.sh
bash scripts/__tests__/test-deploy-launch-boundary.test.sh
bash scripts/__tests__/test-deploy-generalized.test.sh
bash scripts/__tests__/test-deploy-fly1389.test.sh
bash scripts/__tests__/test-cycle-bridge.test.sh
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
pnpm lint && pnpm typecheck && pnpm test
```

(`pnpm --filter teamlead` 在本工作区匹配不到任何包且退出 0,是假绿;包名是 `flywheel-teamlead`。)

PR body:变更摘要、测试计划(上面命令 + 真机 529 验收留给 QA 节点)、dead code 清单(`qa_generalized_safe_tmpdir` + 其 6 行测试)、`## Linear Issue` FLY-2270。

## 5. 测试证据矩阵

| 验收项(issue 原文) | 证据 | 类型 |
|--------------------|------|------|
| runner 环境不改 env 直接跑 `test-deploy.sh` 能起 slot Bridge | `qa_slot_child_tmpdir` 单测(`Buffer.byteLength` < 104);launch-boundary 静态合同(顺序 + 三分支);fly1389 fixture 断言**捕获后的 spec** 含 `TMPDIR=<slot>/tmp`;**真机**:QA 节点在 runner 环境跑 `test-deploy.sh … --generalized --stub-runner --no-lead`,`bridge.log` 无 `EINVAL`、`/health` 200 | 单测 + 合同 + fixture + 真机 |
| 隔离房内 `publish-report` 走完发布链并投到 529 频道 | stub 套件(端到端 HTTP);reports-route 单测(override URL);bridge 集成用例(临时 reports root,解析值到达 reports 路由);**真机**:slot Lead 或 QA 操作者用 master 凭证跑 research §5.3 配方,529 slot 频道收到消息,`curl` 报告 URL 200 | 单测 + 真机 |
| 不得写生产 previews 目录 | `FLYWHEEL_REPORTS_DIR` 注入合同(静态 + fixture spec + `lead-env.txt`);bridge 集成用例的 HOME registry mtime 哨兵;runner 侧负向:既有 `publish-report.test.ts:348`;**真机负向对照**:`~/.flywheel/reports/registry.json` mtime 与 `previews/` 计数前后不变 | 合同 + 单测 + 真机 |
| 生产 Bridge 行为不变 | 既有 vercel-deploy / reports-route / publish-html 用例逐字保留并绿;`parseReportHostOverride(undefined) === undefined`;默认 base 时 fetch init 无 `redirect`;publish-html 无 override 时行为不变 | 单测 |
| 开关不可被滥用 | 非 `http://127.0.0.1:<1-65535>` 的一切形状(含 WHATWG 归一化写法)→ throw,且发生在 `startBridge` 任何状态变更之前 | 单测 + boot 测试 |
| publish-html 关闭态 fail-loud(Lead ①) | 两态用例:开 → 既有;关 → 503 且文案含 `publish-report`,`deployToVercel` 未被调用;bridge 集成用例复核 | 单测 + 集成 |
| 生产 token 不进 slot | 三分支 `-u VERCEL_TOKEN` 静态合同;fixture 父环境 `VERCEL_TOKEN=leak` 下 spec secret == slot token;stub 与铸 token 的 Node 进程环境无 `VERCEL_TOKEN`(两份包装记录);stub 只认 slot token(401) | 合同 + fixture + 单测 |
| stub 不会活过 Bridge、也不会拖住 slot | 父死自退单测(≤3 s);包装脚本失败单测(Bridge 未启动、无残留);fixture:deploy 后 stub 的 ppid == Bridge pid,teardown 后 ≤5 s 端口释放;cycle 用例 | 单测 + fixture |

## 6. 负向守卫清单

1. `parseReportHostOverride`:原始字符串正则 + URL 复核,只接受 `http://127.0.0.1:<1-65535>`;在 `startBridge` 最早处 throw,Bridge 不启动。
2. 三条 launch 边界 `env -u VERCEL_TOKEN`;stub 与铸 token 的 Node 进程都 `env -i HOME PATH` 启动。
3. override 模式下 fetch `redirect: "error"`。
4. stub:Bearer 必须等于 slot token;请求 schema 全量校验先于任何写;路径/name 白名单;`path.relative` 围栏;只绑 `127.0.0.1`;16 MiB 上限;请求超时;拒绝符号链接的 root/token/sites 并校验 `sites` 真实父目录。
5. `FLYWHEEL_REPORTS_DIR` 对所有模式注入 Bridge 与 Lead;runner 保持 ingest-only。
6. override 生效时 `/api/publish-html` 503 fail-loud,文案指向 `publish-report`;关闭由启动环境推导,无运行时旋钮(§2.1)。
7. stub 生命周期 = Bridge 进程生命周期(ppid 监视自退);stub 起不来 ⇒ 包装脚本 exit 70 ⇒ Bridge 不启动 ⇒ 既有 readiness 失败路径。没有任何新的 pid/锁/元数据需要清理。
8. launch spec 校验器不变:`VERCEL_TOKEN` 走 0600 secret 文件;包装脚本是 `command` 的一部分,`command[0]` 仍是绝对路径的 bash。
9. bridge 集成用例自带临时 reports root + HOME registry 哨兵,测试本身不可能写生产注册表。

## 7. 迁移 / 回滚

- 无数据迁移;无 schema 变化;`FLYWHEEL_REPORT_HOST_OVERRIDE_URL` 生产不设。
- 回滚 = revert PR。生产 Bridge 侧新增的只是一个带默认值的可选参数、一个只在开关设了才生效的分支、publish-html 一个只在开关设了才走的 503 分支;revert 后 test-deploy 回到「501 + 继承 TMPDIR」的今天。
- 部署:普通 merge,等 00:00/12:00 班车;无需手动重启。

## 8. 风险与边界

- **proofshot 截图在 runner 沙箱可能失败**:CLI 可降级为纯链接投递,QA 判据是「消息到达 + URL 200」。
- **默认模式 `/api/reports` 仍 503**:既有设计;stub 只在有 API token 的模式起。
- **runner 不继承 `FLYWHEEL_REPORTS_DIR`**(已核实:pane 走 `env -i` 白名单):有意为之——runner 只有 ingest 凭证;投递所有者是 Lead/操作者。将来若要 runner 自己投递,必须显式穿透两个 adapter,不在本单。
- **stub 先于 Bridge 死**(自身崩溃):Bridge 的 publish 得到 502「report publishing failed」,CLI 透传 exit 1,`report-host.log` 有原因;不自动重启(QA 台架,fail loud 即可)。
- **ppid 监视的粒度**:500 ms 轮询,Bridge 死后 stub 最多多活 0.5 s;端口由内核回收,teardown 的 Bridge 端口残留清扫(Step 5c)只看 `SLOT_PORT`,与 stub 无关。
- **stub 的目录交换不是原子的**:有界 QA 交换 + 失败回滚,文档如实写;并发部署串行化。
- **`GENERALIZED_CHILD_TMPDIR` 变量名保留**;新 helper 名 `qa_slot_child_tmpdir`。
- **dead code**:`qa_generalized_safe_tmpdir` 及其 6 行测试随本 PR 删除,PR body 列出。

## 9. Self-review

- 与 issue 三条验收逐条对应(§5 矩阵),每条都有 hermetic 证据 + 真机证据两层;Lead 的 ①② 各有独立行。
- 生产路径字节不变:一个可选参数带默认值、两个只在开关设了才走的分支;既有 sentinel 用例逐字保留。
- 一处源头:数组与 Node/bash 解析上提到 `SLOT_DIR` 之后;TMPDIR 与 REPORTS_DIR 各只注入一次,三分支共用(顺序由静态合同锁住);包装脚本参数也是一个数组,三分支共用。
- 只删不加:v4 删掉了 v3 的整套所有权机制;publish-html 不开新缝而是关闭并 fail-loud;启发式 TMPDIR 函数删除;`test-teardown.sh` 零改动。
- 没有新周期定时器(stub 内的 ppid 轮询是 QA 台架进程自身的存活条件,不是 Bridge 的定时器)、没有新 feature flag、没有新抽象层。
