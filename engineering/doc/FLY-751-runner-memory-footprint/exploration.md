# FLY-751 Runner 内存瘦身 — 探索

Issue: FLY-751 (https://linear.app/geoforge3d/issue/FLY-751/infra-runner-memory-footprint-太重-20g-swap-撑爆1m-context-每-runner-全套-mcp)
日期: 2026-07-01
基于: 无(量化数据引用上游 FLY-753 `engineering/doc/FLY-753-memory-capacity/research.md`)

---

## 1. 问题

48GB 机器上 ~20 个 runner 就吃满 20G swap → Bridge flapping、整机变慢。FLY-753 实测定量:每 session ≈ 1.4GB,其中 **MCP 套件 ~1.0GB(大头)** + claude 主进程 0.28GB(小 context)/ 0.63GB(1M context)。Annie 目标:撑住 100+ 并发;FLY-753 给出的量化 target:**per-session 1.4GB → ~0.4GB**。

## 2. 代码库审计(根因定位)

### 2.1 为什么每个 runner 都是 1M context

Runner model 解析优先级(`packages/teamlead/src/bridge/role-adapter-resolver.ts`):

```
issue label > FLY-728 dispatch model(难度分级) > 项目 roles config > env > 无 → 不传 --model
```

两个 1M 来源:

1. **兜底缺失(主根因)**:生产 flywheel 项目 `.flywheel/config.yaml` **没有 `roles:` block**,大多数 dispatch 也不带 model label/param → 解析结果为空 → `TmuxAdapter.buildClaudeArgs` 不传 `--model` → runner 直接继承**账号默认** `~/.claude/settings.json` 的 `model: claude-fable-5[1m]` —— 每个无标签 runner 都是 1M。
2. **medium tier 显式 1M**:`packages/config/src/model-tiers.ts` 的 `MODEL_TIERS.medium = "claude-opus-4-8[1m]"` —— Lead 难度分级判为 medium 的 issue 显式跑 1M。

### 2.2 为什么每个 runner 都挂全套 MCP

Runner 由 `TmuxAdapter` spawn(interactive claude in tmux),**不传任何 MCP/plugin 限制 flag** → 继承用户级全部配置:

| 来源 | 内容 | footprint(FLY-753 实测) |
|------|------|--------------------------|
| `~/.claude/settings.json` `enabledPlugins` | discord / playwright / serena / context7 等插件,每个自带 stdio MCP server,**每 session 各起一套** | discord ~120MB(Runner 形态)、playwright 150MB、serena 197MB、context7 126MB |
| claude-in-chrome 内建集成 | Chrome native host 进程 | Lead 形态实测 chrome 类 272MB |
| `~/.claude.json` `mcpServers` | linear-api / xiaohongshu(均 `type: http`) | ≈0,无需处理 |

> Lead 的 audible/pencil/gbrain/chrome-devtools 来自 `~/.flywheel/lead-workspace/<lead>/.mcp.json` —— 属 Lead 侧机器配置,**不在本 issue(Runner)代码 scope**,见 §5。

### 2.3 现成机制(可复用,不用发明新轮子)

- **`--settings` per-launch 注入**:FLY-615 ponytail 先例(`TmuxAdapter.buildClaudeArgs` 里 `--settings '{"enabledPlugins": {...}}'`,per-plugin merge,不扰动其他插件)→ 同机制传 `false` 可 per-launch 禁用插件。
- **`--no-chrome`**:claude CLI 现成 flag,per-launch 关闭 Claude-in-Chrome 集成。
- **QA 识别**:auto-QA spawn 请求带 `sessionRole: "qa"`(`auto-qa-coordinator.ts`),已流到 `BlueprintContext` → 可传入 adapter ctx 作豁免键(QA 必须用 Claude-in-Chrome,见 memory 红线)。
- **`roles.runner.model` 配置层**(FLY-241/671)已存在,作 per-project 覆盖通道。

## 3. 方案

### Lever 1 — context 瘦身(~0.35GB/runner)

- **1a. Runner 内置默认 model**:`resolveRoleAdapter` 中,当 role=runner、backend=claude-tmux 且各层均未解析出 model 时,注入内置默认 **`claude-fable-5`**(同模型、去 [1m])——不再裸继承账号 [1m] 默认。env `FLYWHEEL_RUNNER_DEFAULT_MODEL` 可覆盖(设 `off` 恢复旧行为)。
- **1b. medium tier 去 [1m]**:`MODEL_TIERS.medium` → `claude-opus-4-8`(小 context)。
- **1c. 1M 显式 opt-in**:新增 label + dispatch alias `opus-1m` → `claude-opus-4-8[1m]`、`fable-1m` → `claude-fable-5[1m]`,真需要 1M 的重活由 Lead 打标签/难度分级传参。

### Lever 2 — MCP 瘦身(~0.6GB+/runner,最大杠杆)

非-QA 的 claude-tmux runner spawn 时注入:

- `--settings '{"enabledPlugins": {discord:false, playwright:false, context7:false, serena:false}}'`(默认清单,env `FLYWHEEL_RUNNER_DISABLED_PLUGINS` 可覆盖)
- `--no-chrome`

**QA runner(sessionRole="qa")豁免浏览器**:保留 playwright + chrome,仍关 discord(Runner 从不直发 Discord,靠 Lead relay —— FLY-753 判定)。
kill-switch:`FLYWHEEL_RUNNER_SLIM_MCP=0` 整体关闭(回到全套)。

### 默认开关方向

**默认 ON**(带 kill-switch)。依据:FLY-707 default-enable 政策(非安全闸的建成功能默认启用);且本 issue 就是当下生产止血,default-off + 逐项目 opt-in 达不到目的。

### 预期效果(FLY-753 口径)

非-QA runner:1.4GB → ~0.4-0.5GB(MCP -0.6GB、context -0.35GB)。20 runner ≈ 省 15-19GB —— 正好是当前吃满 swap 的量级;48GB 机器并发上限 ~18 → ~40。

## 4. 待 Lead/Annie 拍板的点(brainstorm gate)

1. **medium tier 去 [1m]**(§3 1b):FLY-728 时 founder 确认过含 [1m] 的 tier 映射,改默认需拍板(1M 改为 `opus-1m`/`fable-1m` 显式 opt-in)。
2. **serena 是否进默认禁用清单**:197MB/session,有开发价值(语义代码检索)。推荐 v1 也关(runner 有 Grep/Read/LSP 兜底,清单可配置随时改回);保守选项 = v1 先保留 serena,只关 discord/playwright/context7/chrome(省 ~0.4GB 而非 ~0.6GB)。
3. **默认 ON + kill-switch** vs 默认 OFF 逐项目 opt-in(§3,推荐默认 ON)。

## 5. 明确不做(scope 边界)

- **不动 Lead**:Lead 的 1M(FLY-360)是 Annie 拍的;lead-workspace `.mcp.json` 删 audible/pencil/gbrain 是机器配置动作(FLY-753 清单),不属本 PR 代码 —— 作为 ops 建议随 PR 说明附带。
- **不做共享 MCP 单例架构**(FLY-753 提的"serena/context7 共享"):对 runner 而言 v1 直接禁用即达同等节省;共享单例(需 http/SSE 化改造)复杂度高,留 follow-up。
- **不动 codex/agy/kimi backend**:非 claude-tmux 的 runner 不吃 claude 插件,天然不受影响。
- **不动死/僵 session reaper**:FLY-293/720 已覆盖(issue 方向 3)。
- **不改 `~/.claude/settings.json` 账号默认**:那是 Annie 交互 session 的配置,代码侧显式传 `--model` 即可绕开。

## 6. 风险

- `--settings enabledPlugins:false` 的禁用语义需**真机验证**(memory 红线:vendor CLI flag 必须真 auth 实测)—— implement 第一步 spike:spawn 一个带禁用清单的 claude session,`ps` 数进程树验证 MCP 子进程真没起。
- QA 豁免键 `sessionRole` 需从 BlueprintContext 铺到 `AdapterExecutionContext`(一条新字段,照 enablePonytail 模式)。
- retry 路径:model 从持久化 `runner_model` 再派生 —— 内置默认注入后持久化的就是显式 id,retry 天然保持,需单测覆盖。
