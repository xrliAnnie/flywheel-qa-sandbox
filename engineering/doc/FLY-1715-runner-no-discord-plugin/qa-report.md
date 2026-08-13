# FLY-1715 非 Lead Claude spawn 的 Discord/身份/凭据默认拒绝 — 独立 QA 报告

Issue: FLY-1715 (https://linear.app/geoforge3d/issue/FLY-1715/runner-进程不应加载-discord-plugin-server-个例-roguefly-1704-runner-名下-bun)
日期: 2026-08-13
基于: plan.md, spike-notes.md

## 0. 结论

**PASS。** 被验版本 = `8b03b29a0aaaf00a95bf3b67c4f8e2e537bf55a5`(开跑前与发 verdict 前两次核 head,均等于 `origin/flywheel-FLY-1715`)。

判据 V1–V8 全部有真机证据支撑;下面第 6 节列出**没有测到的部分**与理由,不含糊带过。

---

## 1. 修前基线(生产实测,2026-08-13 01:2x PT)

尺子 = `pgrep -f 'discord/0\.0\.4/server\.ts'` 后按 `ps -o command=` 只保留真正的 `bun …/discord/0.0.4/server.ts` 适配器进程,再按父进程分类。

| 归属 | 适配器数 | 说明 |
|---|---|---|
| Claude 型 Lead | **14** | 正常基线,每个 Lead 恰 1 个 |
| **Runner**(`--agent-id runner-*`) | **8** | 病灶 —— 含本 QA runner 自己 |
| 其它非 Lead | **2** | 一个是 `claude -p You are the CROSS-FAMILY REVIEWER for FLY-1687` 的 **headless 交叉评审进程**(正是本单要覆盖的 spawn 面);一个 `claude --dangerously-skip-permissions` |

本 QA runner 自身 env 亦带 `LEAD_ID=flywheel-eng-lead` / `DISCORD_STATE_DIR=…/discord-flywheel-eng-lead` / `PROJECT_NAME=flywheel` —— 与 issue 描述的「出生即继承」形态一致。**病是活的、可复现的**,不是历史记录。

---

## 2. V1 / V3 / V5 — 真机污染 tmux server 矩阵

做法:用**本分支已构建的生产代码**(`TmuxAdapter.buildCliArgs` + `buildAmbientSafeWindowCommand`)生成 pane 命令,放到一台**故意投毒**的隔离 tmux server(`tmux -L qa1715`,server 启动环境注入六名污染值 + 一个 deny-list **之外**的 canary)上真跑 `claude`,再按进程树数适配器、用 `ps eww` 读 child env。

| Case | `--settings` | 适配器 | 六名污染 | `PROJECT_NAME` | 未列名 canary |
|---|---|---|---|---|---|
| **C0 修前对照**(去掉两枚 forbidden key) | 只剩 playwright false | **1**(pid 45327) | 全消失 | =ctx `flywheel` | 保留 |
| **C5 修前对照**(全空源 → 旧行为「无 flag」) | **无 `--settings`** | **1**(pid 95275) | 全消失 | =ctx | 保留 |
| C1 默认 runner | forbidden false | **0** | 全消失 | =ctx `flywheel` | 保留 |
| C2 **调用方主动开 discord**(`enabledPluginsExtra` 两枚都 true) | forbidden false(覆盖 opt-in) | **0** | 全消失 | =ctx | 保留 |
| C4 全空源(本分支) | forbidden false | **0** | 全消失 | =ctx | 保留 |
| C3 ctx 无 projectName | forbidden false | **0** | 全消失 | **变量缺席** | 保留 |

- **V1 ✔**:同一台投毒 server 上,修前对照长出适配器,修后 0。对照与被测配对存在,不是「只看修后」。
- **V5 ✔**:调用方显式正向 opt-in(= `full-mcp` / QA label 的机制)被 forbidden 覆盖;「双源皆空 → 不带 flag」的旧逃生口已消失(C4 vs C5)。
- **V3 ✔**:六名全剥;`PROJECT_NAME` 按 ctx 有条件重设(有 ctx = ctx 值而非 `wrong-project`,无 ctx = 缺席);**deny-list 之外的 canary 仍在** —— 开集边界如实取证,没有假称「env 已净化」。

> **harness 更正记录**:第一轮把同一份生成的 argv 同时用于对照与被测,两次启动带同一个 `--session-id`,第二次 claude 秒退 → C1 被记成假阴(`paneCmd=-zsh`, `rawEnvLen=5`)。已改为每个 case 各自生成 argv 重跑,上表是重跑后的结果。

### 2b. `execute()` 接线证明(真实生产入口)

上面的矩阵驱动的是两个 helper;交付的 adapter 测试也只驱动 helper。二者都**没有**证明 Blueprint/dispatcher 真正调用的 `TmuxAdapter.execute()` 会走这条路。独立补测:用 recording exec seam 驱动真 `execute()`,断言它发出的 `tmux new-window` argv —— direct 路径 / gated(FLY-245 commit-file)路径 / 无 projectName 路径共 **39/39 PASS**,pane argv 逐字为:

```
env -u LEAD_ID -u DISCORD_STATE_DIR -u DISCORD_BOT_TOKEN -u TEAMLEAD_API_TOKEN \
    -u BRIDGE_URL -u PROJECT_NAME PROJECT_NAME=flywheel claude --session-id … \
    --settings {"enabledPlugins":{"playwright@…":false,"discord@flywheel-plugins":false,"discord@claude-plugins-official":false}}
```

`--settings` 恰一枚;调用方自己的 disabled 项保留;forbidden 最后写。

### 2c. 合并函数对抗性探针

`buildNonLeadClaudeSettings` / `mergeNonLeadClaudeSettingsArgv` 真跑:调用方开 discord(对象/字符串两种)→ 仍 false 且其它插件保留;畸形 JSON / 数组 / `null` / `--settings` 缺值 / `--settings=` 空值 → **抛错 fail-closed**;两枚 `--settings` → 合并成**恰一枚**;`--settings --model` 这种「值长得像 flag」→ fail-closed。

---

## 3. V6 / V8(服务端) — Bridge 挂载层鉴权矩阵

独立 harness(不是实现者的 vitest 文件):用本分支已构建的 `createBridgeApp` 起**真监听 socket**,用真 `fetch` + 真 `Authorization` 头打。**51/51 格全过**(42 + 补测 9)。

| 面 | master | ingest | 未知 bearer | 缺失 |
|---|---|---|---|---|
| `POST /api/reports/publish` | 501(过鉴权) | 501(过鉴权) | 401 | 401 |
| `POST /api/reports/deliver` | 501(过鉴权) | **403** | 401 | 401 |
| `POST /api/lead-inbox/nudge` | **202** | **202** | 401 | 401 |

- ingest + **未配置 projectName** → 403;master 同请求 → 501(廉价校验只加在 ingest 层,master 字节兼容)。
- **tier 伪造负测**:ingest bearer 同时带 `x-report-credential-tier: master` 头 / body 里塞 `reportCredentialTier:"master"` → 仍 403(tier 只从 `res.locals` 取,请求侧不可伪造)。
- **gemini scoped token**:publish / deliver / nudge **三面全 401**(没有顺带升权)。
- **其余 `/api` 没被放宽**:`/api/sessions`、`/api/runs`、`/api/projects`、`/api/leads`、`/api/fleet/snapshot`、`/api/actions/approve`、`/api/publish-html`、`/api/events`、`/api/runs/start` —— ingest bearer **9/9 全 401**;同样 9 条路径用 master bearer **全部非 401**(200/400/404/501),证明上面的 401 来自鉴权而不是「路径不存在」。
- **503 sentinel**:master 未配置时 `/api/reports/*` 一律 503(FLY-203 合同不破)。
- **publish 队列上限**:`MAX_OUTSTANDING_REPORT_PUBLISHES = 8`。用阻塞 deploy seam 打 12 并发 → `[200×8, 429×4]`;饱和期间第 13 发 **429 且不触发 deploy**;放行后额度恢复(下一发 200)。审计行 `[reports] publish succeeded credentialTier=master project="QAProject"` 实测打出。
- 路由面清点:`/api/reports` 与 `/api/lead-inbox/nudge` 在全仓各**只挂载一次**,delegation 开的口恰好是这两处。

> 补测记录:第一轮 nudge 两格拿到 404 而非 202 —— 原因是我没接 `RuntimeRegistry`,404 是 handler 级「Lead inbox loop not found」,master/ingest **同码**,鉴权其实是过的;接上 stub registry 后两者都是 202。publish 上限第一轮 0 个 429,是因为 handler 在无 vercelToken 时 501 秒回、计数器攒不起来(不是产品缺陷),换阻塞 seam 后复现。

---

## 4. V4 / V8(客户端) — runner-tier CLI 真跑

跑**真的**已构建 `flywheel-comm` CLI 子进程(异步 spawn —— 用 `spawnSync` 会阻塞本进程事件循环,让「零网络」断言变成空过绿),配一个**统计连接数**的假 Bridge 和一个装了 master canary 的假 HOME + fs 探针。**22/22 PASS**。

- ingest-only + 默认投递 / `--channel` / `--issue` 三种 → 一律前置拒(`runner has no report delivery authority…`),**且**:`--html` 指向不存在的文件却**从未**报 `failed to read --html` → 拒绝发生在读文件之前;假 Bridge **连接数 = 0** → 零 fetch、零截图。
- ingest + `--publish-only` → 成功,线上抓到的 bearer 就是 **ingest**。
- master 在场 → 用 master;master + 投递意图 **不**被前置拒(走到读文件那步)。
- `FLYWHEEL_INGEST_TOKEN="   "`(纯空白)→ 视为缺席,不误判成 ingest tier。
- **零磁盘 master 回读**:ingest tier 的 `ask` → `check` → `gate --no-block` 全链,nudge 全部带 ingest bearer;Bridge 回 401 后**不重试**;fs 探针对 `~/.flywheel/.env` **读取次数 0**。
- **阳性对照(证明尺子有效)**:同一条链换 master tier,fs 探针**确实**记录到读 `~/.flywheel/.env`,并且第二次 nudge 用的就是磁盘里的 canary token —— 即 FLY-* 轮换回读行为字节保留。

---

## 5. V2 + 529 隔离房真机 Discord(N-to-N)

`scripts/test-deploy.sh 2 --from-branch qa-fly-1715 --lead-label Flywheel --extra-lead 3:Ops-Test`
→ **一个 Bridge + 两个真 Lead**(flywheel-test-2 / flywheel-test-3,各自 bot、各自隔离频道)= N-to-N 拓扑;生产 Bridge / 生产 Lead / 机器级配置全程未动。

- 隔离 Bridge `/health`:`ok:true`,`buildSha = artifactBuildSha = 8b03b29a…`(= 被验 head),两个 Lead 的投递环 fresh。
- **两个 Lead 各恰 1 个 Discord adapter,各 2 条 ESTABLISHED :443**(gateway 真连)。
- **真出站**:Lead 在隔离频道发出真消息 —— `🚀 [FLY-202] … 开始跑了 (exec: 42c025c3-…)。Runner 已进入 running`(09:08:21Z)。
- **真机 end-to-end runner**:`inject-linear-issue.sh 2 FLY-202` → 真 Runner 由**完整生产链**(Bridge → Blueprint → dispatcher → TmuxAdapter → tmux → claude)拉起,pane `FLY-202-runner-claude-Fable-…`,pid 14963:

  | 观察 | 结果 |
  |---|---|
  | 进程树 5 个后代 | context7-mcp / playwright-mcp / caffeinate —— **Discord adapter = 0** |
  | argv `--settings` | `{"serena@claude-plugins-official":false,"discord@flywheel-plugins":false,"discord@claude-plugins-official":false}` |
  | `LEAD_ID` / `DISCORD_STATE_DIR` / `DISCORD_BOT_TOKEN` / `TEAMLEAD_API_TOKEN` / `BRIDGE_URL` | **全部 absent** |
  | `PROJECT_NAME` | `test-slot-2`(registry 派生,非继承) |
  | `FLYWHEEL_LEAD_ID` / `FLYWHEEL_PROJECT_NAME` / `FLYWHEEL_BRIDGE_URL` | 在位 |

  与第 1 节生产基线(8/8 runner 各带 1 个适配器 + 继承 LEAD_ID/DISCORD_STATE_DIR)是同尺子下的前后对照。

- 隔离 Bridge(master 未配置)上实测:`/api/reports/publish|deliver` 无论无 bearer 还是坏 bearer 都 **503**;`/api/lead-inbox/nudge` 无 bearer **202**、`/api/sessions` 无 bearer **200** —— 即**无 master 时的 tokenless 姿态逐字保留**,新中间件没有偷偷收紧或放宽。

### Lead 侧未受影响的直接证据

- 本 diff **未触碰** `claude-lead.sh` / lead wrapper / launchd / 机器级 `settings.json`(按文件名清点)。
- 机器级 `~/.claude/settings.json` 现值:`discord@flywheel-plugins: true`、`discord@claude-plugins-official: false` —— 与修前一致,本单没有交付 `setup-discord-plugin-default-off.sh`(该脚本确认不存在)。
- 生产 14 个 Claude 型 Lead 的适配器数在整个 QA 期间保持 14。

---

## 6. 诚实边界(没测到的 / 只测了一半的)

1. **人类作者的入站 Discord 消息未跑通**。计划是用 slot-3 的 bot 往 slot-2 的隔离频道发一条 @ 消息,Discord 回 **403**(该 bot 未被邀请进那个频道,bot 无 MANAGE_CHANNELS 无法自助)。Chrome 扩展当时是连着的,但用 founder 登录态代发需要 `AskUserQuestion`(headless 禁用)且本单没有任何 founder-gate 交互面,故未走。**已取证的是**:两个 Lead 的 gateway socket 真连 + Lead 真出站消息 + Lead 收到 Bridge 事件后正常播报。**没取证的是**「一条人类消息进来、Lead 回一条」这个完整往返。风险面:本 diff 不改任何入站/relay/render 代码路径(按文件清点),所以我判断这条缺口不影响 ship 判定;要补的话在下次 529 窗里让 Annie 在隔离频道发一句即可。
2. **`/api/reports/deliver` 的真 Discord 投递未在隔离房跑**。隔离 Bridge 默认不带 master token(`env -u TEAMLEAD_API_TOKEN`),该面返回 503。deliver 的鉴权行为在第 3 节的真 HTTP 矩阵里覆盖(master 过、ingest 403、伪造 tier 403),但「master 真发一条报告到 Discord」这一步只在生产才具备条件,留给 ship 后观察。
3. **生产部署本身没做**。本单只验候选 head 的行为,`request-restart.sh` 受管全舰事务(含 voice-bridge 纳管)未执行。voice-bridge 那段用交付的 hermetic harness 覆盖(20/20,含「voice 失败不推进 deployed-sha」「rollback 时 Lead 恢复波次先于 voice 复验」两条顺序断言),**真机重启未跑**。
4. **deny-list 是闭集,不是「env 已净化」**。C0–C5 每个 case 都刻意留了一个 deny-list 外的 canary 并确认它**仍在**。整 env 重建归 FLY-1726。
5. **同 UID 的主动规避不在本单射程**。runner 与 Lead 同 UID 同 HOME 且带 Bash,`cat ~/.flywheel/.env` 仍能拿到 master —— 计划 §1 已显式接受,本 QA 复核该表述与实现一致(CLI 层只堵了**自动**回读,不是能力边界)。
6. **`pnpm test:packages:run` 全量门没跑**。理由:同宿主跑全量 vitest 会把生产 Bridge 压垮(既有教训)。改跑本单触达面的定向文件(见第 7 节)。

---

## 7. 全仓门与测试(V7)

| 项 | 结果 |
|---|---|
| `pnpm lint` | exit 0,13 条既有 warning(与 main 基线一致),无本单 error |
| `pnpm -r build` | 22 个 workspace package 全绿 |
| 定向 vitest(本单改动的全部 18 个测试文件所在包) | claude-runner 199 · flywheel-comm 173 · teamlead 107 · voice-core 40 · edge-worker 36 · config 4 = **559 全过** |
| shell harness | `restart-services-voice-bridge` 20/20 · `runner-tier-token-preflight` 9/9 · `agent-cli-provider-contract` 19/19 |
| 独立 QA harness | 真机矩阵 6 case · execute 接线 39/39 · Bridge 鉴权 51/51 · CLI tier 22/22 |
| `git status --porcelain` | 空(本 QA 未改动任何源码/配置) |

### ops 预检(ship 卡硬前置)

对**真实生产** `~/.flywheel/.env` 跑 `scripts/runner-tier-token-preflight.sh`:

```json
{"gemini_present":false,"ingest_present":true,"master_padded":false,"master_present":true,"ok":true,"pairwise_distinct":true}
```

exit 0 —— master/ingest 都在、互异、master 无外层空白。**部署硬前置当前满足。**

### spawn 面独立清点(不采信实现者的清单)

自查全仓 TS/shell 里所有会拉起 `claude` 二进制的位置,除已覆盖的 6 个面外另找到三处,逐个核实:

- `packages/claude-runner/src/ClaudeCodeAdapter.ts` —— 自身注释即写明 dormant,全仓无任何注册/实例化点(`lead-inbox-runtime.ts` 用的是 agent-team-transport 的同名类)。
- `packages/claude-runner/src/ClaudeCodeRunner.ts` —— 仅被 index 导出,零调用方,死代码。
- `packages/agent-team-transport/src/claude/ClaudeCodeAdapter.ts` —— 只执行 `claude --version`。**实测**:跑一次 `claude --version`,适配器计数 23 → 23,不拉起 MCP。

结论:交付覆盖的生产 spawn 面是完整的。

---

## 8. 建议(不阻塞 ship 的 advisory)

1. `scripts/restart-services.sh` 有两处纯缩进回退(`check_discord_plugin_fork` 里的 `if [[ "$DRY_RUN" …` 被顶到行首;文件级 `if [[ "$DRY_RUN" …` 多了 4 空格)。功能等价,建议顺手抹平。
2. 529 隔离房本身在这次 QA 里暴露两个**既有**(非本单)问题,已影响到 QA 节拍,值得单独立单:
   - `test-deploy.sh` 会把调用方 shell 的 `FLYWHEEL_ROUNDTABLE_CHANNEL_ID` 原样继承给隔离 Bridge,导致 `loadRoundtableConfig` fatal、Bridge 秒死(讽刺的是这正是本单在治的「ambient 继承」病的同族)。
   - `test-teardown.sh` 第一次调用撞上 FLY-1482 那条 cmux mutator lease 死锁(`timed out after 60s waiting for cmux mutator lease (owner mode=watch pid=40357)`),导致 slot lock 悬挂、下一次部署被拒;第二次调用才成功。
3. QA runner pane 的 `TMPDIR` 指向很深的 runner-state 路径,`tsx` 建 IPC unix socket 会撞 `sun_path` 上限而 `EINVAL`(本次隔离 Bridge 第一次启动即因此秒死,与本单无关)。529 相关脚本建议自带短 `TMPDIR`。
