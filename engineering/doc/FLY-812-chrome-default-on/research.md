# FLY-812 Chrome 默认开 — 调研

Issue: FLY-812 (https://linear.app/geoforge3d/issue/FLY-812/infrap1regression-fly-751-一刀切关掉所有非-qa-runner-的-claude-in-chrome-破坏-sub)
日期: 2026-07-03
基于: exploration.md

## 1. 调用链(逐处核实)

```
run-dispatcher.ts (start + retry 两处)
  resolveRunnerMcpProfile({ sessionRole, issueLabels, env })   // packages/config
    → RunnerMcpProfile { disabledPlugins: string[], disableChrome: boolean } | null
  → runnerMcpProfile 挂进 start payload
    → EdgeWorker / Blueprint 透传 → TmuxAdapter.buildCliArgs
       - disabledPlugins → --settings {"enabledPlugins":{plugin:false}}(与 ponytail 合并)
       - disableChrome   → --no-chrome            (TmuxAdapter.ts:764)
```

调用点(`rg resolveRunnerMcpProfile`):
- `packages/teamlead/src/bridge/run-dispatcher.ts:383`(start 路径)
- `packages/teamlead/src/bridge/run-dispatcher.ts:683`(retry 路径)
两处入参完全一致(`sessionRole` + `issueLabels`),所以只改纯函数即可覆盖两条路径,无需碰 dispatcher。

`sessionRole` 来源:`req.sessionRole ?? "main"`(dispatcher:258/608)。只有 auto-QA(FLY-579)起的 session 传 `"qa"`。

## 2. 纯函数现状(`packages/config/src/runner-mcp-profile.ts`)

关键逻辑(66-97):

```ts
if (env.FLYWHEEL_RUNNER_SLIM_MCP?.trim() === "0") return null;   // 全局 kill-switch(临时缓解用的就是它)
if (labels.some(l => l.toLowerCase() === "full-mcp")) return null; // 整体 opt-out
// baseList = env 覆盖 或 DEFAULT_RUNNER_DISABLED_PLUGINS
const isQa = args.sessionRole === "qa";
const disabledPlugins = isQa ? baseList.filter(p => p !== PLAYWRIGHT_PLUGIN) : baseList;
const disableChrome = !isQa;                                     // ← 要改的一行
if (disabledPlugins.length === 0 && !disableChrome) return null; // degenerate → 字节兼容 spawn
return { disabledPlugins, disableChrome };
```

`DEFAULT_RUNNER_DISABLED_PLUGINS = [discord, playwright, serena]`(均 `@claude-plugins-official`)。context7 **故意不在**列表(founder 2026-07-01 定:runner 保留 library-doc lookup)。

## 3. 两种「Chrome」的内存账(别混)

| 名字 | 是什么 | `--no-chrome` 管它吗 | 内存 | 谁清 |
|------|--------|--------------------|------|------|
| claude-in-chrome MCP 插件 | runner 经 Claude-for-Chrome 扩展驱动浏览器的 MCP server(常驻子进程) | 是 | 中等(FLY-751 spike:含 chrome 的 4 插件全关,MCP 子进程 8→0,~850MB RSS 差值里的一部分) | 进程随 session 退出 |
| agent-browser Chrome-for-Testing | ProofShot / visual-capture 按需 shell 出的 headless Chrome | 否(独立进程,非 MCP) | 大(每套一个 Chrome) | **FLY-766 reaper**(按 execId 归属,只杀终态 session 的泄漏实例) |

结论:751 的 `--no-chrome` 省的是**第 1 项**(claude-in-chrome MCP 常驻)。**第 2 项**(真正的内存大头)由 766 reaper 管,与本次改动正交。所以关 chrome 省的内存有限,而破坏的可用性(cron/research/video)是真刚需 —— tradeoff 明显偏向「chrome 默认开」。

## 4. FLY-766 现状(内存正解)

- reaper 已合并(`bb1ddf7a` / PR #422)。boot one-shot + periodic(`FLYWHEEL_CHROME_REAPER` 默认开,`=0` 关),单飞守卫防重入。
- 归属安全:匹配 OS `comm`(可执行身份)而非 argv 子串 —— 正在 review 本 issue 的 runner(命令行里恰含 chrome 路径)不会被误杀;Annie 真实的 Google Chrome.app 也不匹配。
- **并发上限(option C / admission gate)= 明确 defer**(`FLY-766/plan.md:12`「不做:C = fast-follow 单独 issue」)。**尚未实现。**

→ FLY-812 若走 surgical(方案 A),内存 backstop = 766 reaper(已在)+ 插件瘦身(保留);并发上限仍是 766 的未来 fast-follow。

## 5. 测试面(改动波及)

1. `packages/config/src/__tests__/runner-mcp-profile.test.ts` — 纯函数测试。断言非-QA `disableChrome: true` 的用例(default / non-qa main / env-list 等)→ 翻成 `false`。**新增** `no-chrome` label → `disableChrome: true` 用例。
2. `packages/teamlead/src/__tests__/run-dispatcher.test.ts:237` — `DEFAULT_PROFILE.disableChrome: true` → 翻成 `false`。QA 用例(:282 已 `false`)不变。
3. `packages/claude-runner/test/TmuxAdapter.test.ts:476-524` — 测的是**适配器机制**:给定 `disableChrome:true` → argv 含 `--no-chrome`;给定 absent → 不含。**这些不动**(机制仍需支持,opt-out runner 靠它)。

## 6. 最小 diff 形态(方案 A,待 gate 确认)

`runner-mcp-profile.ts` 内:

```ts
const isQa = args.sessionRole === "qa";
const disabledPlugins = isQa
    ? baseList.filter((plugin) => plugin !== PLAYWRIGHT_PLUGIN)
    : baseList;
// FLY-812: chrome 默认开(修 FLY-751 一刀切 regression)。opt-out = "no-chrome" label。
const disableChrome = labels.some((l) => l.toLowerCase() === "no-chrome");
```

`isQa` 保留(playwright carve-out 仍用它)。degenerate null 检查不变(现在非-QA + 空插件 + 无 no-chrome → `{[], false}` → return null,字节兼容,正确)。模块头注释 + 「QA exemption below」注释更新为「chrome 默认开、opt-out=no-chrome label」。

## 7. 上线后 ops(非代码,写进 plan checklist)

正式修 deploy(Bridge 重启拿新 dist)后,撤掉 `~/.flywheel/.env` 的 `FLYWHEEL_RUNNER_SLIM_MCP=0` → 瘦身以新语义恢复(chrome 开 + 插件瘦)。**顺序不能反**:先 deploy 新 dist,再撤 env;否则撤早了会退回 751 旧语义再次关 chrome。
