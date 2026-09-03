# FLY-2270 529 房台架缺口:报告链隔离发布 + Bridge TMPDIR 固定 — 调研

Issue: FLY-2270 (https://linear.app/geoforge3d/issue/FLY-2270/529-房台架缺口-slot-bridge-结构上没有-vercel-token报告卡片链在隔离房覆盖不到-runner-环境-tmpdir)
日期: 2026-09-03
基于: exploration.md

## 1. 调研问题

1. 缺口 2 的 EINVAL 是否精确可复现、阈值是多少、固定 `${SLOT_DIR}/tmp` 是否在所有模式下都够短且不破坏别的合同?
2. 缺口 1 要在生产代码里开几条缝、开在哪、怎么保证开关未设时字节不变、怎么防止开关被滥用?
3. stub 托管服务需要实现 Vercel API 的哪个子集?
4. slot 的隔离边界(reports 目录 / previews / token / 端口 / teardown)分别落在哪、由谁清理?
5. 测试与 CI 的落点。

## 2. 缺口 2:TMPDIR / tsx IPC

### 2.1 精确公式(已从安装的 tsx 4.20.6 dist 读出)

```
temporary-directory-*.mjs : e = path.join(os.tmpdir(), `tsx-${geteuid()}`)
get-pipe-path-*.mjs       : pipe = path.join(e, `${pid}.pipe`)
```

| 组成 | 长度 |
|------|------|
| runner TMPDIR `~/.flywheel/runner-state/<36 位 uuid>/browser-tmp` | 89 |
| `/tsx-501/` | 9 |
| `<pid>.pipe`(macOS pid ≤ 5 位) | ≤ 10 |
| 合计 | ≤ 108 > 103(`sun_path` 104 含 NUL) |

`${SLOT_DIR}/tmp` = `/tmp/flywheel-test-slot-N/tmp`:N 为 1 位时 29 字节、2 位时 30 字节;保守按 `/tsx-<5 位 uid>/<5 位 pid>.pipe`(+21)算,最长 51 字节,余量 52。即使 macOS 把 `/tmp` 解析成 `/private/tmp`(Node `os.tmpdir()` 不解析符号链接,只读 `TMPDIR` 原值),也只是 +8。测试用 `Buffer.byteLength` 算字节数,不数字符。

### 2.2 既有守卫的覆盖面

`qa_generalized_safe_tmpdir`(`scripts/lib/qa-generalized.sh:141-149`):判据 `${candidate}/tmux-${uid}/default` 长度 > 100 才回落 `/tmp`。tmux 尾巴 18 字符,tsx 尾巴 19 字符,阈值 100 比 103 严 3 字符,所以 generalized 模式**碰巧**也保住了 tsx。它只在 `GENERALIZED=1` 时被调用(`test-deploy.sh:773`);默认与 reply-by-issue 两条分支没有任何 TMPDIR 处理,capture 把 runner 的 89 字符 TMPDIR 原样写进 `bridge-launch.json`。

### 2.3 Bridge 进程的 TMPDIR 消费者(改成 slot tmp 后会受影响的地方)

| 消费者 | 现状 | 改后 |
|--------|------|------|
| tsx IPC pipe | 由 `os.tmpdir()` 决定 | 落 `${SLOT_DIR}/tmp/tsx-501/` |
| tmux socket | 由 `TMUX_TMPDIR=${SLOT_DIR}`(FLY-1999)决定,与 TMPDIR 无关 | 不变 |
| runner pane TMPDIR | `TmuxAdapter.ts:665` 每个 runner 单独 `appendPaneEnv("TMPDIR", browserTmp)` | 不变(仍是 runner-state/browser-tmp) |
| chrome-session-reaper 归属 | 只认 `runner-state/<execId>/browser-tmp` 前缀 | 不变 |
| Bridge 内部 `mkdtemp` 等 | 之前落 runner 的 browser-tmp(错位:Bridge 不是 runner)或 `/tmp` | 落 slot 自己的目录,teardown Step 6 `rm -rf $SLOT_DIR` 一并清掉 |

结论:固定为 `${SLOT_DIR}/tmp` 是纯收益;它还顺手修正了「Bridge 用 runner 的 browser-tmp 当自己 TMPDIR」这个错位。

### 2.4 `test-cycle-bridge.sh`(FLY-2237 slot 内重启 Bridge)

它**回放** `bridge-launch.json`(`test-cycle-bridge.sh:340 qa_slot_bridge_exec_spec`),不重新 capture。TMPDIR 写进 spec 的 `environment`(名字不匹配 SECRET 正则),所以 cycle 后仍是 slot tmp。需要 `mkdir -p` 的目录在 test-deploy 建好即可,cycle 不会删它。

## 3. 缺口 1:报告链的缝

### 3.1 需要开缝的三处生产代码

| 文件 | 现状 | 缝 |
|------|------|----|
| `packages/teamlead/src/bridge/vercel-deploy.ts:63,140` | `fetch("https://api.vercel.com/v13/deployments")` 与轮询 URL 写死 | `deployFilesToVercel(token, name, files, timeoutMs?, apiBaseUrl = "https://api.vercel.com")`;`waitForReady` 同样接 base;`deployToVercel` 零改动(publish-html 在 override 下关闭,见下行) |
| `packages/teamlead/src/bridge/reports-route.ts:315` | `url: https://${vercelProjectName}.vercel.app/r/${token}/` | `ReportsRouterOptions.hostOverride?: { apiBaseUrl: string; publicBaseUrl: string }`;有则 `${publicBaseUrl}/${vercelProjectName}/r/${token}/`,且默认 `deployFiles` 绑定 `apiBaseUrl` |
| `packages/teamlead/src/bridge/plugin.ts:4507-4511`(startBridge 开头)与 `:4298,:4316` | 只读 `VERCEL_TOKEN` | 在 `startBridge` 最早处读 `FLYWHEEL_REPORT_HOST_OVERRIDE_URL`,经纯函数校验后传给 reports router;override 生效时 publish-html router 走一个新的「已关闭」分支,返回 **503 且文案指向 `flywheel-comm publish-report`**(Lead 要求 fail-loud),因为 `deployToVercel` 返回的 `triage-<project>.vercel.app` 在 override 下会是假成功(Codex Round 1 #5,选择关闭而不是加缝);关闭只由启动环境推导,无运行时旋钮 |

`publish-html-route.ts` 与 `deployToVercel` 签名零改动。

### 3.2 开关校验(纯函数,便于单测)

新模块 `packages/teamlead/src/bridge/report-host-override.ts`:

```
parseReportHostOverride(raw: string | undefined): { apiBaseUrl; publicBaseUrl } | undefined
```

规则(fail-closed,任何一条不满足就 **throw**,Bridge 启动失败,绝不静默忽略):
- 未设或空白 → `undefined`(生产路径,字节不变);
- 必须能被 `new URL()` 解析,`protocol === "http:"`;
- `hostname === "127.0.0.1"`——只接受这一种回环写法(不接受 `localhost`,避免 DNS 依赖;不接受 `[::1]`),这样这个开关**不可能**被用来把生产 `VERCEL_TOKEN` 送到任何远端;
- `port` 为 1–65535 的整数(拒绝 0 与空);`pathname === "/"`、无 `search`、无 `hash`、无 `username/password`;
- 返回值规范化为 `http://127.0.0.1:<port>`,两个字段相同,分开命名是为了让调用点语义清楚。

启动日志一行:`[Bridge] report host override active (QA only): http://127.0.0.1:<port>`。

### 3.3 `publish-report` CLI 对 URL 形状有没有假设?

`packages/flywheel-comm/src` 非测试代码里 **零处** 出现 `vercel.app`;CLI 只把 Bridge 返回的 `url` 原样交给 proofshot 与 `/deliver`。`/deliver` 只校验 `url` 非空字符串(`reports-route.ts:361`)。所以 `http://127.0.0.1:<port>/…` 可以走完整条链,不需要动 CLI。

### 3.4 stub 需要实现的 Vercel API 子集

Bridge 只调用两个端点(`vercel-deploy.ts`):

| 端点 | 请求 | Bridge 消费的响应字段 |
|------|------|----------------------|
| `POST /v13/deployments` | `Authorization: Bearer <token>`;JSON `{name, target:"production", files:[{file,data,encoding:"utf-8"}], projectSettings:{framework:null}}` | `{id, url, readyState}`;`readyState === "READY"` 则不轮询 |
| `GET /v13/deployments/:id` | Bearer | `{readyState}`(`READY` 结束,`ERROR/CANCELED` 抛错) |

部署文件集(`report-registry.ts:430-444`):`robots.txt` + 每个保留报告的 `r/<token>/index.html`。默认保留上限 100 条 / 8.5 MiB(`DEFAULT_RETENTION_MAX/BYTES`),JSON 化后请求体 < 16 MiB。

Vercel 语义:每次部署是**全量替换**——stub 把 `sites/<name>/` 整目录换成新集合(串行化、先校验后写、staging 目录 rename 上位、失败把旧目录 rename 回去;这是有界的 QA 交换,不是原子替换),这样「过期链接在下一次发布后消失」的既有语义在隔离房也能验(FLY-203 的 TTL 行为)。

### 3.5 stub 的静态托管

- `GET /<name>/r/<token>/`(与 `/index.html`)→ `sites/<name>/r/<token>/index.html`,`Content-Type: text/html; charset=utf-8`;
- `GET /<name>/robots.txt` → 对应文件;
- 其余 404;`..`、绝对路径、反斜杠、编码后的 `..` 一律 400/404,并用 `path.resolve` 后前缀校验限制在 `sites/` 内;
- 只监听 `127.0.0.1`,端口 `0`(系统分配),自探活成功后把端口原子写进 `${root}/port`(唯一的元数据,只读承诺);日志追加到 `${SLOT_DIR}/report-host.log`。
- **生命周期 = Bridge 进程**(plan v4/v5):由 Bridge 的启动包装脚本拉起,包装脚本把自己的 pid 作为 `--expected-parent` 传入;stub 在 listen 之前与每 500 ms 都要求 `process.ppid` 等于这个固定值,否则退出(基线不在 JS 里取,关掉「先出生再认爹」的孤儿窗口);本机已验证父 `exec` 后退出时子进程 250 ms 内感知。不写 pid、不做所有权核对、teardown 零改动。

不实现:自定义域名、alias、团队、删除部署、`target` 校验以外的任何字段。

### 3.6 为什么不是「起第二个 Bridge 路由」或「让 Bridge 自己托管」

Bridge 是被测对象;把托管塞进 Bridge 等于在生产代码里加只为 QA 存在的 HTTP 面,与「生产路径字节不变」冲突。stub 作为 `scripts/lib/` 下的 QA 台架代码,与 `qa-529-generalized-stub.mjs`(runner stub)是同一类东西、同一处维护。

## 4. slot 隔离边界

| 资源 | 落点 | 注入到 | 清理 |
|------|------|--------|------|
| Bridge TMPDIR | `${SLOT_DIR}/tmp`(0700) | `BRIDGE_EXTRA_ENV`(三分支共用);generalized 分支 Lead / clone watchdog 沿用同一变量 | teardown Step 6 `rm -rf $SLOT_DIR` |
| 报告注册表 | `${SLOT_DIR}/state/reports/{registry.json,files/,previews/}` | `BRIDGE_EXTRA_ENV` + `LEAD_EXTRA_ENV`(`FLYWHEEL_REPORTS_DIR`),**所有模式** | 同上 |
| slot Vercel token | `${SLOT_DIR}/state/report-host/token`(0600,用 slot 的 node 二进制 `crypto.randomBytes(16)` 铸,fixture 的受限 PATH 里不依赖 openssl) | `BRIDGE_EXTRA_ENV` 的 `VERCEL_TOKEN=`;capture 因名字匹配 `TOKEN` 自动进 `secretEnvironment`,spec 明文里不出现 | 同上 |
| stub 进程 | 由 launch spec `command` 前缀的包装脚本 `qa-report-host-bridge-wrapper.sh` 以 `env -i HOME PATH` 拉起;只有 `port` 文件 | 包装脚本在 `exec` Bridge 前导出 `FLYWHEEL_REPORT_HOST_OVERRIDE_URL=http://127.0.0.1:<port>`(不在 spec 明文里) | 无需清理:stub 监视 ppid,Bridge 死即自退;teardown Step 5 杀 Bridge、`test-cycle-bridge.sh` 回放 spec 都自动覆盖 |
| 生产 token 隔离 | 三条 launch 边界加 `-u VERCEL_TOKEN`(在显式赋值之前) | — | — |

launch spec 校验(`qa_slot_bridge_validate_spec`)要求 `environment` 里的名字**不能**含 TOKEN 等词,`secretEnvironment` 的文件必须 0600 且单行——`VERCEL_TOKEN` 走 secret 通道自然满足;`FLYWHEEL_REPORT_HOST_OVERRIDE_URL`、`FLYWHEEL_REPORTS_DIR`、`TMPDIR` 走明文通道,名字不触发 SECRET 正则。

runner pane **不**继承(Codex Round 1 纠正):Claude pane 的命令行由 `TmuxAdapter.ts:59` 的 `/usr/bin/env -i <白名单>` 构造(`RUNNER_PANE_BASE_ALLOWLIST` + 显式 `appendPaneEnv`),Codex daemon 侧(`CodexTmuxAdapter.ts`)剥离继承的 `FLYWHEEL_*`;`:2144` 的 `{...process.env, ...opts.env}` 只是 Bridge 调用 tmux 二进制时的环境,不是 pane 内容。这与既有授权模型一致:runner 只有 ingest 凭证,`publish-report.ts:143-146` 强制 `--publish-only`,不做截图与投递。所以**投递所有者是 Lead / QA 操作者(master 凭证)**,`FLYWHEEL_REPORTS_DIR` 注入 Bridge 与 Lead 即闭环;不把它穿透进 runner 白名单。

## 5. 测试与 CI 落点

### 5.1 vitest(`packages/teamlead`)

| 文件 | 用例 |
|------|------|
| `__tests__/vercel-deploy.test.ts` | 传入 `apiBaseUrl` 时 POST 与轮询都打该 base;不传时既有 4 个 sentinel 用例逐字不变 |
| `__tests__/reports-route.test.ts` | `hostOverride` 存在 → `url === http://127.0.0.1:4321/<name>/r/<token>/`;不存在 → 既有断言不变;`hostOverride` 时默认 `deployFiles` 收到 `apiBaseUrl`(用 `deployFiles` 注入观察参数) |
| `__tests__/report-host-override.test.ts`(新) | 未设→undefined;`http://127.0.0.1:1`→通过;`https://…`、`http://10.0.0.5:1`、`http://127.0.0.1`(无端口)、带路径/查询/凭据 → throw |
| `__tests__/bridge.test.ts` | 新增:非法 override 在 `startBridge` 任何状态变更前 reject;合法 override 时 `/api/reports/publish` 返回本机 URL 且 `/api/publish-html` 503(文案含 `publish-report`);用例自带临时 `FLYWHEEL_REPORTS_DIR` 与真实注册表 mtime 哨兵 |

### 5.2 shell / node(`scripts/__tests__`)

| 文件 | 内容 | CI 入口 |
|------|------|---------|
| `qa-report-host.test.sh`(新) | 起真 stub:错 token 401;对 token 200 且页面可 GET;schema/遍历/符号链接拒绝;二次部署全量替换(旧 token 404);父死自退(真杀父进程,进程与端口实证)+ 阳性对照;包装脚本 exit 70 分支 + 就绪前杀包装脚本 + 对照;启动环境边界 | `ci.yml` 新增一步(macOS/Linux 都能跑,纯 node + curl) |
| `test-deploy-generalized.test.sh` | 删除 `:564-569` 的 `qa_generalized_safe_tmpdir` 断言;新增 `qa_slot_child_tmpdir` 断言(返回 `${SLOT_DIR}/tmp`,拼上 `/tsx-501/99999.pipe` 后 < 104) | 已在 CI |
| `test-deploy-qa-room.test.sh` | 组合断言:`BRIDGE_EXTRA_ENV` 含 `TMPDIR=` 与 `FLYWHEEL_REPORTS_DIR=`,`LEAD_EXTRA_ENV` 含 `FLYWHEEL_REPORTS_DIR=` | manual-only 清单(既有) |
| `test-deploy-launch-boundary.test.sh`(新,静态合同) | 对 `scripts/test-deploy.sh` 做文本断言:三条 Bridge launch 分支各自含 `-u VERCEL_TOKEN`;`GENERALIZED_CHILD_TMPDIR` 不再引用 `qa_generalized_safe_tmpdir` | `ci.yml` 新增;必须同时进 `ci-shell-suite-enumeration` 的字面清单 |

`ci-shell-suite-enumeration.test.sh` 要求每个 `*.test.sh` 要么在 `ci.yml` 里字面出现,要么在 `ci-shell-suite-manual-only.txt` 里;新建的两个 shell 套件都要登记。

### 5.3 真机 529 验收(QA 节点执行,不在本单实现 PR 里假装完成)

在 runner 环境(TMPDIR 89 字符)**不改任何 env**:

```bash
scripts/test-deploy.sh <slot> --generalized --stub-runner --no-lead --expect-head "$(git rev-parse HEAD)"
# 期望:JSON 输出含 reportHost.url / reportHost.tokenPath / reportsDir;bridge.log 出现
# "[Bridge] report host override active (QA only): http://127.0.0.1:<port>";无 EINVAL
```

然后用输出里的配方(test-deploy 直接打印)跑:

```bash
FLYWHEEL_BRIDGE_URL=http://localhost:<port> TEAMLEAD_API_TOKEN="$(cat <apiTokenPath>)" \
FLYWHEEL_REPORTS_DIR=<slotDir>/state/reports \
node packages/flywheel-comm/dist/index.js publish-report --html <某 html> --project <projectName> --channel <chatChannelId> --title "FLY-2270 probe"
# 期望:envelope url 以 http://127.0.0.1:<hostPort>/ 开头;curl 该 url 200;529 slot 频道收到一条消息(截图或纯链接)
```

负向对照(必须同轮做):`stat -f %m ~/.flywheel/reports/registry.json` 前后不变;`ls ~/.flywheel/reports/previews | wc -l` 前后不变;`<slotDir>/state/reports/registry.json` 恰好 1 条。

## 6. 结论

- 缺口 2:一个变量(`GENERALIZED_CHILD_TMPDIR` → 所有模式统一 `${SLOT_DIR}/tmp`)+ `BRIDGE_EXTRA_ENV` 一行,启发式函数与其测试删除。
- 缺口 1:生产代码两处开缝(一个带默认值的可选参数 + 一个纯校验函数)加一处 fail-loud 关闭(override 时 publish-html 503 指向 `publish-report`),一个 QA stub(`scripts/lib/qa-report-host.mjs`)与一个 Bridge 启动包装脚本(`qa-report-host-bridge-wrapper.sh`):test-deploy 在有 API token 的模式下铸 token、注入 `VERCEL_TOKEN`,并把包装脚本前缀进 launch spec 的 command;stub 由包装脚本拉起、以 `--expected-parent` 钉住父进程、Bridge 死即自退;teardown 零改动。
- 生产路径:开关未设 → 与今天逐字节同行为;开关设了非回环 → Bridge 拒绝启动。
