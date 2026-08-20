# FLY-1867 playwright-mcp Chrome 泄漏 — 设计修正
Issue: FLY-1867 (https://linear.app/geoforge3d/issue/FLY-1867/playwright-mcp-chrome-泄漏实例从不回收且有可见窗口盖住-founder-桌面-点击落空)
日期: 2026-08-20
基于: plan.md

---

## 0. Founder 原话与本次修正

> 「思考的不是说开了之后怎么关,而是我们为什么需要开它?如果不需要开的话,一开始就不应该打开呀。」

这句话在原 plan R18 批准后到达。随后 founder 又校准了目标:**不是禁 Playwright MCP,而是做到「没事干不白起浏览器」**。这没有推翻已经查明的生命周期事实,但改了优先级与论证:Chrome 已经 first-tool lazy,真正的浏览器问题是「用过一次后不回收」;普通会话默认不带 MCP 是额外减少 19 个空挂 server 的手段,不是把 server 本身冒充成可见窗口根因。

因此新增 **P-1 源头消除**,压在 P0–P3 之前。原 plan 作为调查与残余风险设计继续有效;实现顺序与验收入口按本文修正。

## 1. 废弃概念

废弃下面这个默认思路:

> 把「治理已开的浏览器」当第一问,先围绕 close、reaper、census、quarantine 建方案。

它的问题不是这些器官都错了,而是把「每个会话都先开着 playwright-mcp」当成不可改变的前提。对没有 browser 需求的普通会话,默认不启动 server 可以减少常驻开销;对真正调用过 browser tool 的会话,P0 才负责让已经启动的 Chrome 在 teardown 时关干净。两者不能混成一条因果。

## 2. P-1 审计结论

### 2.1 谁在无差别拉起 playwright-mcp

`@playwright/mcp` 来自 `playwright@claude-plugins-official`。只要这个插件在 Claude settings 中是 enabled,Claude 会在会话启动时拉起 MCP server 子进程。

Flywheel 其实已经有一条正确但未落地到现机的 prevention leg:

- `scripts/setup-mcp-on-demand.sh` 把 machine settings 的 `enabledPlugins["playwright@claude-plugins-official"]` 设为 `false`;
- `scripts/provision-fleet-host.sh` 已经调用它,覆盖未来 provision;
- `resolveRunnerMcpProfile()` 只为 QA role、`playwright` label、`full-mcp` label 写 per-launch positive opt-in;
- `TmuxAdapter` 把 positive opt-in 合进单一 `--settings` 参数,其优先级高于 machine default。

但 2026-08-20 对当前 host 的只读核验是:

```
~/.claude/settings.json:
  enabledPlugins["playwright@claude-plugins-official"] = true
  settings.json.bak-mcp-on-demand-* 数量 = 0
```

结论:设计和新机 provisioning 已经有 default-off,但当前唯一生产 host 从未执行这次 cutover。普通 runner 没有 positive opt-in,却仍因 machine setting 的 `true` 继承到了 Playwright。Lead 与 founder Terminal 默认读同一 machine settings,也一起继承。

进程 census 把浪费的形状量清楚了:

- 23 个 playwright-mcp server 与 Claude 会话一一对应:15 个 Lead、6 个 Runner、1 个 reviewer、1 个 founder Terminal;
- 其中 21 / 23 当时没有 Chrome,所以不是「23 个浏览器都泄漏」,而是大量从未使用的 server 常驻;
- `@playwright/mcp@0.0.79` 没有 inactivity / idle-close,所以不能把「等它空闲后自己关」写成机制或验收。

### 2.2 MCP server 与 Chrome 是两级 lazy boundary

审阅本机实际运行的 `@playwright/mcp@0.0.79`:

1. 插件 enabled → MCP server 随 Claude 会话启动,这是 eager;
2. MCP server 的 `CallToolRequest` handler 第一次收到 browser tool 调用时才 `factory.create(clientInfo)`;
3. `factory.create()` 才进入 `createBrowserWithInfo()` 并启动 Chrome。

所以 Chrome 本身已经是 first-tool lazy;本期不需要自造 browser supervisor 或 lazy launcher。缺口在更前一层:**没有 browser 需求的会话仍然 eager 启了 MCP server。**

当时 23 个 server 中 21 个没有 Chrome,也与这条两级边界一致:server 可长期常驻,Chrome 只在工具真正被调用后出现。上游 browser 生命周期只有显式 `browser_close` 与 MCP session teardown 两个可信 close 边界;没有 idle timer。本期不发明第三个。

### 2.3 第二次审计:Playwright 与 Claude-in-Chrome 分开算

第一次「四个 browser Lead」结论不可用:它按 transcript 文件 mtime 选了 14 天文件,却没有再按每条事件的 timestamp 过滤,也把泛称 browser 使用与两套工具混在一起。2026-08-20 重审计做了三道收窄:

1. 每条 `tool_use` 自己的 timestamp 必须落在 14 天窗口;
2. Playwright 只认实际出现的 `mcp__plugin_playwright_playwright__*`(并兼容规范化的 `mcp__playwright__*` / `mcp__plugin_playwright__*`),`mcp__claude-in-chrome__*` 单列;
3. Lead 身份只认 `~/.flywheel/lead-workspace/<leadId>` 的真实 cwd。

结果:

| 范围 | Playwright | Claude-in-Chrome |
|---|---:|---:|
| 全部会话 | 98 次 / 66 sessions | 2335 次 / 93 sessions |
| 常驻 Lead | 32 次 / 4 sessions / 2 identities | 320 次 / 2 identities |

Lead 的 32 次 Playwright 调用只来自 `flywheel-eng-lead`(25)与 `flywheel-product-lead`(7),用途都是 bounded HTML/report visual QA;`flywheel-cos-lead` 与 `tidal-echo-content-lead` 在严格窗口内是 **0**。这不是「Playwright 从来没人用」,但只有四次短任务,不足以让任何 resident Lead 永久持有插件与一次调用后无 idle-close 的 Chrome。结论改为:

- 当前 production Lead allowlist **为空**;仓库 example 也不预置 true;
- `playwrightMcp?: true` 只保留为未来有明确、持续需求时的显式能力门,本次不启用任何身份;
- Lead 日常 browser 路径继续使用 Claude-in-Chrome;Playwright visual QA 放到 QA / labeled Runner 或一次性会话,完成即退出;
- P0 仍是泄漏主修:显式 opt-in 会话用过 browser 后,teardown 必须给上游完整 close window。

## 3. 修正后的目标状态

| 会话 | playwright-mcp server | Chrome | 入口 |
|---|---|---|---|
| 普通 Runner | **不启动** | 不存在 | machine default-off |
| QA Runner | 按需启动 | 第一次 browser tool 才启动 | `sessionRole=qa` positive opt-in |
| 明确需要 Playwright 的 Runner | 按需启动 | 第一次 browser tool 才启动 | `playwright` 或 `full-mcp` label |
| 所有当前 Lead | **不启动** | 不存在 | machine default-off;production allowlist 为空;日常 browser 用 Claude-in-Chrome |
| 未来明确需要 Playwright 的 Lead | 显式 opt-in | 第一次 browser tool 才启动 | 需求成立后才在 `projects.json` 声明 `playwrightMcp: true` |
| founder Terminal | **默认不启动** | 不存在 | machine default-off;需要时用一次性显式 launch command |
| 其他人工明确要 Playwright 的会话 | 显式 opt-in | 第一次 browser tool 才启动 | per-launch Claude settings;不是全机常开 |

这里的 `playwright-mcp` 与 Claude-in-Chrome 是两套独立能力。本期不改 `--no-chrome` / `no-chrome` 的 FLY-812 合同,也不拿另一套 browser plugin 冒充本 issue 的进程来源。

## 4. P-1 实现合同

### 4.1 合并而不是再造第二个 settings writer

原 plan P1 要新增一个只写 `PLAYWRIGHT_MCP_HEADLESS=true` 的 writer。P-1 到达后,再保留两个脚本分别改同一个 `settings.json` 会重复 symlink、坏 JSON、mode、backup、atomic replace 与 rollback 防线。

实现改为扩现有 `scripts/setup-mcp-on-demand.sh`,由一个事务管理两个 owned path:

1. `enabledPlugins.playwright@claude-plugins-official = false` —— P-1,普通会话源头不开;
2. `env.PLAYWRIGHT_MCP_HEADLESS = "true"` —— P1,显式 opt-in 的残余会话也不画窗口。

公开入口只有 `apply` 与 receipt-aware `rollback`;不提供无收据的裸删 key。重复 apply 不覆盖第一次 receipt。

### 4.2 Lead positive opt-in 是身份配置,不是全机例外

给 `ProjectConfig.LeadConfig` 增加可选布尔字段 `playwrightMcp`。缺失 / `false` 都是不启用;非布尔值在 `parseAndValidateProjects()` fail loud。`claude-lead.sh` 在已经确定 `projectName + leadId` 后读取这一份同源 registry:

- 精确身份命中且 `playwrightMcp === true` → 给最终 `CLAUDE_ARGS` 合并一个 `--settings '{"enabledPlugins":{"playwright@claude-plugins-official":true}}'`;
- 缺失、false、project / Lead 未命中、registry 读取失败 → 不产生 opt-in;launcher 原有的身份 fail-stop 仍负责无效身份;
- 不设置 `CLAUDE_CONFIG_DIR`,不改 machine file,不创建第二份 settings root。

本次 production roster **不设置任何 true**。当前 `~/.flywheel/projects.json` 的 15 个 Lead 全部 absent,仓库 `fleet/example/projects.json` 也不预置 allowlist。字段与 exact-identity launcher seam 只作为显式需求入口;没有需求记录就保持空集。

founder Terminal 不进入常驻 allowlist。切换前先在现有 thread 明确告知 Annie 这个用户可见变化;临时需要 Playwright 时使用:

```bash
claude --settings '{"enabledPlugins":{"playwright@claude-plugins-official":true}}'
```

该命令只对这次 Claude launch 生效。退出会话后仍靠 MCP teardown 关闭;上游没有 idle-close。

### 4.3 Rollback 不覆盖别人的后续配置

receipt 对两个 owned path 分别记录 absent / 原值,并记录 whole-file preimage / postimage SHA 与 backup 路径:

- 当前 SHA 等于 postimage → 恢复 whole-file preimage;
- SHA 已分叉 → 对每个 owned path 做三方比较:
  - 仍等于 apply 值 → 只恢复该 path 的 preimage;
  - 已等于 preimage → no-op;
  - 是第三值或类型不符 → `rollback_conflict`,零写入,非零退出。

这保留原 plan 的 receipt 安全性,只是 owned path 从一个变成两个。切换后新增的 hook、plugin、permission 不得被 whole-file 旧备份覆盖。

### 4.4 现机 cutover

代码合入、独立 QA 通过且进入受控部署窗后:

1. 用 writer `apply` 写 machine settings 与 receipt;
2. 新起一个 ordinary Runner,证明没有 playwright-mcp server;
3. 新起当前 roster 的 Lead,证明没有 server;另用测试 fixture 验证未来 `playwrightMcp:true` 的 exact-identity seam,不把 fixture 写进 production roster;
4. 新起 QA / `playwright` opt-in Runner,做同一层级验证;
5. 调用 browser tool,证明 Chrome 才出现且无 on-screen 窗口;
6. cutover 前在 founder thread 告知默认变化与上述一次性命令;founder Terminal 由 Annie 人工重开;
7. Lead 与 founder Terminal 要在受控重启 / 人工重开后才收敛;不能把「配置已改」冒充「所有存量进程已换代」。

本 implement node只交付可 review 的代码、测试、cutover 命令与证据格式;不在 PR 前直接改生产 settings,也不 inline 重启生产服务。

## 5. 保留器官与新顺序

| 器官 | 是否保留 | 修正后的职责 |
|---|---|---|
| P0 优雅退出 | 保留 | 只服务 QA / 显式 opt-in 等**真需要开**的残余场景;不再是第一道防线 |
| P1 headless | 保留 | opt-in 后的桌面止血;由同一 policy writer 管理 |
| 一次性 legacy drain | 保留 | 处理 cutover 前已经活着的个位数孤儿;不自动化扩权 |
| audit-only census | 保留 | 量 P-1 + P0 上线后的残量;零 signal、零告警 |
| P3 quarantine | 保留 | 处理 cutover 前已经堆下的 profile;默认只 rename,观察后人工删 |
| 自动 Chrome 回收器 | 仍不做 | 先看 P-1 + P0 后两周 census;数据达到原 plan 数字门才重开 |

新顺序:

```
P-1 普通会话默认不开
  ├─ 显式 opt-in → upstream first-tool lazy → P1 headless
  └─ 真正启动过的 MCP → P0 完整 graceful window
                              └─ P2 census 量残量

cutover 前存量:operator drain → P3 quarantine → 观察 ≥7 天 → 人工删除
```

## 6. 验收与 RED seam

1. 配置 writer:ordinary apply 后 plugin=false + headless=true;坏 JSON、symlink、mode、atomicity、receipt、重复 apply、三路 rollback 全部测试。
2. Runner policy:ordinary session 不含 positive opt-in;QA / `playwright` / `full-mcp` 保持 positive opt-in。
3. Lead policy:`playwrightMcp` 非布尔 fail loud;absent / false 无 `--settings` opt-in;true 只给精确 project + Lead 身份加 Playwright true;optional capability 查询异常时安全降级 disabled、不能让空 allowlist 变成 fleet launch fail-stop;dry-run launch plan 可观测且不泄漏配置值。
4. Spawn seam:per-launch positive opt-in 仍能覆盖 machine false;disabled / enabled merge 不互相 clobber。
5. 真机 ordinary session:新会话没有 playwright-mcp server,不是「有 server 但没有 Chrome」。
6. 真机 opt-in session:server 只在 opt-in 会话存在;首次 tool 前 Chrome=0;首次 tool 后 Chrome 精确身份出现且 on-screen window=0。当前执行 QA / labeled Runner 与 founder one-shot 两行;production Lead allowlist 为空时 Lead browser 行明确 deferred,未来 true 身份进 roster 前补验。
7. founder Terminal 默认无 server;一次性显式命令可恢复本次会话能力;advance notice 留在 founder thread。
8. P0 / P2 / P3 原 plan 的 exact identity、tri-state、zero-alert、quarantine-first 验收不降级。

## 7. 会过期的结论

| 结论 | as-of | 什么时候会过期 | 重核方式 |
|---|---|---|---|
| 当前 host 的 machine setting 仍为 true、且旧 cutover backup 为 0 | 2026-08-20 | writer apply 后 | 只读解析 `~/.claude/settings.json` 的目标 key并统计 `settings.json.bak-mcp-on-demand-*` |
| runner positive opt-in 只有 QA / `playwright` / `full-mcp` | branch `ac98e8c` | `runner-mcp-profile.ts` 改动后 | focused config tests + `git diff` |
| Runner positive opt-in 当前可用依赖 `FLYWHEEL_RUNNER_SLIM_MCP` 未设置/不为 `0` | 2026-08-20 host `.env` + LaunchAgents audit | 该 kill-switch 被设为 `0` 或 launcher profile 逻辑改变后 | cutover preflight 重扫持久 env;设为 `0` 时必须把 QA / labeled Runner Playwright 标成不可用,不能声称 machine false 被 per-launch 覆盖 |
| `@playwright/mcp@0.0.79` 在 first tool request 才 create browser | 0.0.79 cache | `@playwright/mcp@latest` cache 版本变化后 | 重读 cache package version与 `CallToolRequest` → `factory.create` → `createBrowserWithInfo` 调用链 |
| `@playwright/mcp@0.0.79` 没有 inactivity / idle-close | 0.0.79 cache | cache 版本变化后 | 搜索 server/browser lifecycle 的 timer、close 与 disconnect paths;没有源码证据不得宣称存在 |
| ordinary Lead 与 founder Terminal 共用 machine settings root | 2026-08-20 | 某 Lead 设置独立 `CLAUDE_CONFIG_DIR` 后 | 审计 launcher env与每个 live Lead 的 config root;独立 root逐个 apply/验收 |
| 14 天严格审计只有 2 个 Lead、4 个 sessions 调过 Playwright,当前 allowlist 仍为空 | 2026-08-20 timestamp-bound census | 使用窗口或明确需求变化后 | 分开统计 Playwright / Claude-in-Chrome 的真实 `tool_use`;只有需求成立才改 `projects.json` |

## 8. 本次增量不恢复什么

P-1 不是恢复 R1–R14 那套 supervisor、managed plugin fork、launch shim、六相 activation 或自动 kill。恰好相反:source elimination 让这些机制更没有必要。

也不运行 `setup-mcp-on-demand.sh` 以外的 FLY-1185 能力边界变更,不禁用官方插件身份,不启用 `--isolated`,不把 Typeless / DiskImageMounter 挂起写进验收。
