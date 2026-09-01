# FLY-2241 MCP 工具 schema 的 token 开销 — 结论与建议

Issue: FLY-2241 (https://linear.app/geoforge3d/issue/FLY-2241/成本测量-量一次工具-schema-到底吃掉多少-token-静态可测不需要先建计量体系)
日期: 2026-09-01
基于: exploration.md, research.md

> 本单边界:**只测量 + 给建议,不改任何运行行为**。下面的建议全部是「另开单」级别,本 PR 不含任何行为改动。

## 1. 验收问题的直接回答

> **我们有没有 50–70K 这个量级的浪费?**

**schema 体量确实到了那个量级 —— 但我们没有付出它,因为惰性加载已经在生产开着。**

| | Uber 报告 | Claude Lead | Claude Runner(生产实态) | Claude Runner(若 linear-api 修好) |
|---|---|---|---|---|
| 工具数 | 1000+ | **111** | 67 | **124** |
| schema 全量内联 | 50–70K | **34,338** | 22,922 | **44,296** |
| **实际每请求付出** | (未上惰性加载) | **1,480** | **2,591** | 3,131 |
| 占中位每请求输入 | — | **0.25%** | **1.11%** | 1.34% |

再叠加 Claude Code **自带的 19 个可延迟内置工具**(全量内联 **15,061 token**,
比我们全部 MCP 加起来还大),若惰性加载失效:
Lead 每请求要多付 **49,399 token(占 8.3%)**,Runner 反事实 **59,357(占 25.4%)**
—— **正好落在 Uber 说的 50–70K 区间里。**

⇒ 结论不是「我们没有这个问题」,是「**我们有这个体量,但已经被惰性加载压掉了 89–96%**」。
issue 的猜测成立:两个 vendor 的生产会话都在用惰性加载,这一单量完即收。

直接证据(不是推断):最近 40 个在飞 Lead transcript 里有 **374 次真实 `ToolSearch` tool_use**
(最近一次 2026-09-01T19:16);Codex `.codex-mufasa` 生产 rollout 里有真实
`tool_search_call` / `tool_search_output` 条目。

## 2. 值不值得改 —— 逐项结论

| 候选改动 | 惰性加载下能省 | 结论 |
|---|---|---|
| 从 Lead `.mcp.json` 摘掉 `xiaohongshu-mcp`(13/14 个 Lead 都挂,实际只有 rafiki / tidal-echo / cos 用) | 292 token/请求(0.05%) | ❌ **不值得**。惰性加载已把它从 8,209 压到 292。为 0.05% 动一个 13 个 Lead 共用的生成路径,风险 >> 收益 |
| 从 Lead 摘掉 `linear-api`(单个最大:57 工具 / 21,412 token) | 765 token/请求(0.13%) | ❌ **不值得**,且 Lead 真的在用它(20 个 transcript 里 406 次调用) |
| 关掉 Runner 的 `claude-in-chrome` | 1,692 token/请求(0.72%) | ❌ 会砍掉真实能力(founder HTML 投递 / Deep Research / QA 截图) |
| 关掉 `playwright` / `context7` plugin | 各 242 / 224 token | ❌ 噪声级 |
| 实现惰性加载 | — | ✅ **已经在用了**,不需要做 |
| Codex Lead 精简 MCP | — | ❌ 只有 2 个工具 / 1,110 字节,没有可精简的 |

**一句话:在惰性加载开着的前提下,这条成本线上没有可拿的东西。**
每请求 23–60 万输入 token 里,工具 schema 占 0.25%–1.11%。
真正的分母在别处(上下文累积),那属于「六项成本方程」那条线,需要先有埋点。

## 3. 但这里有一个单点故障 —— 这是本单最该留下的东西

**惰性加载现在只由一行不在仓库里的用户级配置托着:**

`~/.claude/settings.json` → `env.ENABLE_TOOL_SEARCH = "true"`

- 不在 git 里、没有测试守着、没有告警看着。
- Lead / Runner 都走 `CLAUDE_CONFIG_DIR:-${HOME}/.claude`(`claude-lead.sh:966,1157`);
  QA 用过隔离 `CLAUDE_CONFIG_DIR` 的路径(FLY-1439),那条路径上这一行**不会自动跟过去**。
- 一旦失效,**静默**退化:
  - Lead:1,480 → **49,399** token/请求(0.25% → 8.3%,**×33**)
  - Runner:2,591 → **37,983**(1.11% → 16.2%,**×15**)
- 我们是订阅制、不按 token 计费(CLAUDE.md「Cost tracking: N/A」),所以后果不是钱,
  是**上下文窗口压力和限流** —— 而 Lead 的 p90 每请求已经到 **899,874 token**,
  离窗口顶不远,再叠 5 万是能把边缘请求推过线的量。
- 而且它**没有任何外显症状**:工具照常能用(只是全量内联),没人会注意到。

⇒ **建议另开一单(小)**:在 Lead / Runner 启动路径加一条只读断言 ——
启动时读 `[ToolSearch:optimistic] ... result=` 这一行(`claude --debug api` 已经在打),
为 `false` 就发告警。几行代码,换掉一个「静默 ×15~×33 且没人会发现」的失效模式。
**本单不做**(边界:不改运行行为)。

## 4. 顺带查出来的一个独立问题(建议另开单)

**Runner 的 `linear-api` MCP 是死的,Lead 的是活的 —— 而且是结构性的,不是偶发。**

- 两处配置都写 `"Authorization": "Bearer ${LINEAR_API_KEY}"`(env 占位符)。
- `claude-lead.sh` 用 `lib/mcp-inherit.sh::list_required_envs` 扫出它,经
  `tmux new-window -e` 塞进 **Lead** 会话。**Runner 的启动路径没有这一步。**
- 实测:最近 20 个 Lead transcript = **406 次成功调用 / 0 次拒绝**;
  最近 30 个 Runner transcript = **0 次成功 / 68 次 401 拒绝**。
- 后果:runner 拿不到 Linear MCP(只能退回 `flywheel-comm` / `gh`),
  并且每个 runner 会话都在系统提示里背一条 191 token 的「连接失败」告知。

这不是成本问题(191 token 是噪声),是**能力缺口 + 每会话噪声**。
要不要修由 Lead 判 —— 修法是把 `list_required_envs` 那一步接到 runner 启动路径上。
**本单不做。**

## 5. 遗留空白(交给 Lead 判是否补)

1. **Codex 侧 token 探针没跑成。** 归因经两轮更正,以下为最终版:
   我在 20:47–20:52 逐个 profile 实测,看到 `school`/`business`/`personal1`/`personal2`
   全是 `refresh_token_reused`。**真因不是 auth 本身坏了** —— 是当天 19:25 的一次额度探针
   把 `school` 的 refresh 世系轮转进了 /tmp 临时家,global/pool 留在旧串上;
   已于 **20:53Z 修好**(世系搬回 global+pool,实测 HEAL_OK)。
   `personal` 的 auth 正常但额度耗尽到 **2026-09-06 7:29 PM**(这半属实)。
   ⇒ **既不需要 founder relogin,也不需要等 9/6**;codex 现在就能跑。
   我的逐号测试跑在修复之前,所以当时得出的「9/6 前 codex 全不可用」**不成立**。
   撞额度只上报不换模(未动模型)。
   本轮测量窗口落在修复之前 ⇒ 已有替代证据表明 **Codex Lead 结构上不可能有问题**
   (2 个工具 / 1,110 字节),但 **Codex exec runner 的 5-server profile home 是明确留白**;
   Lead 裁定这格留白照旧,不补跑。
   补法(若日后要补):`codex exec --json -s read-only -c 'approval_policy="on-request"'
   -c 'mcp_servers={}'` vs 默认,同样的差分法即可出数。
2. 本 PR **没有跑 `/codex-code-review` / `/codex-design-review`** —— Lead 裁定:
   纯文档、零运行时改动的交付按惯例免 codex 评审轮,由他直接过目采纳,manifest 不重铸。

## 6. 复跑说明(验收要求)

```bash
cd engineering/doc/FLY-2241-mcp-schema-token-cost
# 0. ⚠️ 先确认带 ${VAR} 占位符的 server 的 env 在探针进程里存在(见 research.md §0)
export LINEAR_API_KEY=$(ps eww -o command= -p $(pgrep -f "claude --agent flywheel-eng-lead" | head -1) \
  | tr ' ' '\n' | grep '^LINEAR_API_KEY=' | cut -d= -f2-)
# 1. 换了 MCP 配置后重新生成 cfg/*.json(见 research.md §0)
# 2. 跑全矩阵(~12 分钟,20 臂)
./run-matrix.sh          # 结果写到 results.tsv
# 3. 重新取分母
python3 reqstats.py
# 4. 单个 stdio server 的工具数/字节数
node tools-list.js "$(cat cfg/gbrain.json)"
```

四个不变量,复跑时先核:
1. 基线重复跑的差 ≤ 几个 token(本轮 ±2);
2. 分臂之和 ≈ 合臂(本轮 Lead 差 0.09%、Runner 差 0.11%);
3. 每臂 debug 日志的 `ENABLE_TOOL_SEARCH=..., result=...` 要与该臂声称的一致
   —— 直接 `export` **无效**,必须走 `--settings` 注入(见 exploration.md §5);
4. 每臂的 `connected` 列必须列出你以为挂上的**每一个** server。
   少一个就是那个 server 没连上、被静默测成 0 —— 本轮第一版就是这么把 Lead
   低估了一半(见 research.md §2 的自我更正框)。
