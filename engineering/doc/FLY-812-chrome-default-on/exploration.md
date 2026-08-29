# FLY-812 非-QA runner Chrome 被一刀切关掉 — 探索

Issue: FLY-812 (https://linear.app/geoforge3d/issue/FLY-812/infrap1regression-fly-751-一刀切关掉所有非-qa-runner-的-claude-in-chrome-破坏-sub)
日期: 2026-07-03
基于: 无(regression bug,上游 = FLY-751 已合并代码)

## 1. 问题(Annie 2026-07-03 ~02:00 PT,live P1 regression)

今晚所有新起的非-QA runner 突然没有浏览器工具:806 skill runner 连不了 claude-in-chrome、Annie 每晚跑的 **Sub 夜间 cron**(需要浏览器)也用不了。判断「之前都可以、今晚才坏」正确。

## 2. 根因(已核实代码,非推测)

`packages/config/src/runner-mcp-profile.ts:90`(FLY-751,commit `13747f9f`,deployed-sha `cf422a67` 已含):

```ts
const isQa = args.sessionRole === "qa";
const disabledPlugins = isQa
    ? baseList.filter((plugin) => plugin !== PLAYWRIGHT_PLUGIN)
    : baseList;
const disableChrome = !isQa;          // ← 这一刀:除 QA 外所有 runner 都 --no-chrome
```

`resolveRunnerMcpProfile` 由 `run-dispatcher.ts`(start + retry 两处)调用,产出的 `disableChrome` 经 `RunnerMcpProfile` → `TmuxAdapter.ts:764` → 拼进启动 argv 的 `--no-chrome`。= 除 `sessionRole==="qa"` 外,fleet 级、跨项目(Sub 也中招)所有 claude-tmux runner 的 Claude-in-Chrome 被强制关掉。

751 的设计假设「浏览器 ~90% 是 QA 在用」→ 把非-QA 的 chrome 一并关掉省内存。**漏掉了正当的非-QA 浏览器用户**:Sub 夜间 cron / research runner / 806 视频 skill。

## 3. 已生效的临时缓解(Tadashi,不是本 issue 的正式修)

`~/.flywheel/.env` 加 `FLYWHEEL_RUNNER_SLIM_MCP=0`(751 官方 kill-switch,`runner-mcp-profile.ts:71` 直接 `return null`)+ 重启生产 Bridge → 瘦身**整个**跳过 → 新 runner 恢复全 MCP + chrome。

代价:751 的省内存**全撤**(安全的插件瘦身 discord/playwright/serena 也一起撤了)。这个临时开关在正式修上线后必须撤掉。

## 4. 关键事实核对(为方案定边界)

- **两种「chrome」是不同的东西,别混**:
  - `claude-in-chrome` MCP 插件(`--no-chrome` 关的就是它)= runner 经 Claude-for-Chrome 扩展驱动浏览器的 MCP server。Sub cron / 806 要的是它。
  - `agent-browser` CLI 的临时 Chrome-for-Testing(headless)= ProofShot / `flywheel-comm visual-capture` 按需 shell 出来的,泄漏的那些才是 **FLY-766 reaper** 清的对象。
- **FLY-766(chrome 生命周期回收器)已合并**(`bb1ddf7a`,PR #422):按 `execId` 归属 + `.flywheel-owner.json` marker,只杀「归属 session 已到终态」的泄漏 Chrome。这是内存的**正解**,和 751「关 chrome」职责重叠但更精准。
- **FLY-766 的并发上限(option C / admission gate)= 明确 defer 的 fast-follow**,尚未实现(见 `FLY-766/plan.md:12`「不做:C = fast-follow 单独 issue」)。
- **插件瘦身(discord/playwright/serena)是安全的**:transcript 分析 375 runner/30 天,serena 0/375、playwright 2/375、discord ~4/372 使用率;每个 ~120-200MB。这部分**不动**。
- TmuxAdapter 对 `disableChrome` 的处理(`--no-chrome`)是**机制**,与本次策略修无关 —— 仍需保留,让 opt-out 的 runner 能真正关掉 chrome。**不碰 TmuxAdapter**。

## 5. 方向(Annie 已在 issue 里定的 5 条)

1. **chrome 改默认开** —— 不再对非-QA 一刀切 `--no-chrome`。← 这是修复的核心一刀。
2. **保留插件瘦身**(serena/playwright/discord)—— 不动。
3. 内存改靠 **766 reaper + 并发上限**兜(766 option C),不靠禁 chrome。
4. 若仍要「某些确定不用浏览器的 runner 关 chrome」→ 做成 **opt-out**(默认开、显式关),别 opt-in。
5. 上线后**撤掉临时 kill-switch**。

## 6. 待 Annie 在 plan 阶段拍的 tradeoff(内存 vs 浏览器可用性)

核心矛盾:chrome 默认开后,fleet 内存靠什么兜?

- **A(推荐)= 保持 FLY-812 surgical**:只翻转 chrome 默认 + 加 opt-out;内存靠**已合并的 766 reaper + 安全插件瘦身**兜;并发上限(766 option C)维持 766 的 fast-follow 计划,不拉进本 issue。
- **B = 把并发上限拉进本 issue**:FLY-812 同时实现 claude-in-chrome 会话全局限流(admission gate)。范围明显变大、且和 766 的 fast-follow 重叠。

我的判断:选 A。regression 修要快、要小;并发上限是 766 已规划的独立工作,拉进来会让 P1 修膨胀(踩 minimal-fix 红线)。但这是 Annie 的内存 tradeoff,plan 阶段请她拍。

## 7. 待定的设计小问(倾向已给,brainstorm gate 里确认)

- **opt-out 机制形态**:倾向复用现有 label 模式,加 `no-chrome` issue label(和 `full-mcp` 对称);labeled runner → `disableChrome=true`。不引入新 env。
- opt-out 是否 v1 必须?Annie 用「若仍要」措辞(条件)。倾向包含(近乎零成本、Annie 点名过),但可作为可选项。
