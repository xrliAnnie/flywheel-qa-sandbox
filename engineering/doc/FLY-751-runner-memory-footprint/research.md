# FLY-751 Runner 内存瘦身 — 调研

Issue: FLY-751 (https://linear.app/geoforge3d/issue/FLY-751/infra-runner-memory-footprint-太重-20g-swap-撑爆1m-context-每-runner-全套-mcp)
日期: 2026-07-01
基于: exploration.md(量化数据引用 FLY-753 `engineering/doc/FLY-753-memory-capacity/research.md`)

---

## 1. MCP 使用率实测(Lead 要求的 Q2 数据,不许跳)

**方法**:扫全部 runner worktree 的 claude session transcripts(`~/.claude/projects/-Users-xiaorongli-Dev-*`,近 30 天,按文件 mtime 过滤),grep tool_use 记录 `"name":"mcp__…<plugin>…"` 统计每个重 MCP 的真实调用。

**样本**:flywheel runner(`*-Dev-flywheel-FLY-*`)261 个 session 文件 + 其他项目 runner(GeoForge3D `GEO-*` / sub / joycon)114 个,合计 **375 个 runner session**。

| MCP / 插件 | 有调用的 session 数 | 使用率 | FLY-753 实测 footprint | 结论 |
|-----------|-------------------|--------|------------------------|------|
| **serena** | **0 / 375** | **0%** | 197 MB/session | **进默认禁用清单**(Lead 预期被数据证实:零使用,纯死重) |
| **context7** | 1 / 375 | 0.3% | 126 MB/session | **保留**(使用率虽低,Annie 拍板 runner 保留查库文档能力,2026-07-01;env 清单仍可按机器关) |
| **playwright** | 2 / 375 | 0.5% | 150 MB/session | 进默认禁用清单(QA 豁免保留) |
| **discord** | 7 / 375(见下) | ~1% | ~120 MB/session(Runner 形态) | 进默认禁用清单(escape hatch 覆盖特例) |
| **claude-in-chrome** | 58 / 261(flywheel 样本) | 22% | chrome 类实测最重(Lead 形态 272 MB) | **默认关 + 双豁免**:52/58 带 QA 标记(QA 豁免覆盖);其余 ~6 个是 research 型 runner(浏览网页)→ 需 label 逃生口 |

discord 的 7 个使用者拆开:3 个是 **joycon-lead**(Lead workspace 被 glob 误入样本,非 runner)→ 真实 runner 使用 ≈ 4/372(FLY-350/FLY-424 各 1 + sub 内容 runner 2)。sub 内容 runner 确有 Discord 交付场景 → 逃生口(`full-mcp` label,见 §3)覆盖,不为 1% 的特例给 99% 的 runner 背 120MB。

> **数据可信度**:transcript 的 tool_use 记录是 ground truth(非自报);30 天窗口覆盖 v1.4x-v1.5x 的完整 sprint 周期;375 样本跨 4+ 项目。局限:mtime 过滤按文件最后写入时间,极长寿 session 可能少量跨窗;不影响"serena=0"这种数量级结论。

## 2. 机制验证(代码层)

### 2.1 per-launch 插件禁用 — `--settings`(FLY-615 先例)

`TmuxAdapter.buildClaudeArgs` 已有 `--settings '{"enabledPlugins": {…: true}}'` 注入先例(ponytail,per-plugin merge、最高非-managed 优先级)。同机制传 `false` 即 per-launch 禁用。**注意两处 `--settings` 必须合并成一个 flag**(ponytail true + 禁用清单 false 合成一个 map)。

⚠️ 禁用语义(`false` 真的不 spawn 该插件的 MCP server)属 vendor CLI 行为,**implement 第一步真机 spike 验证**(gate 已拍:spike 不过不往下写)。

### 2.2 per-launch 关 chrome — `--no-chrome`

claude CLI 现成 flag(`--help` 确认存在:"Disable Claude in Chrome integration")。同属 spike 验证范围。

### 2.3 QA 豁免键 — `sessionRole`

auto-QA spawn 请求带 `sessionRole: "qa"`(`auto-qa-coordinator.ts:314`),已流到 `BlueprintContext`(Blueprint.ts:204);`session_role` 已持久化(StateStore sessions 表,retry 可恢复)。`issueLabels` 也在 `BlueprintContext`(:230)。→ profile 计算所需的输入全部就位。

### 2.4 model 解析与注入点

- 解析链:`resolveRoleAdapter`(role-adapter-resolver.ts)label > dispatch(FLY-728)> roles config > env backend > 内置;**model 无兜底** → 不传 `--model` → 继承账号默认 `claude-fable-5[1m]`(实查 `~/.claude/settings.json`)。
- medium tier 1M:`MODEL_TIERS.medium = "claude-opus-4-8[1m]"`(model-tiers.ts:40)。
- retry 路径复用持久化 `dispatch_model`(actions.ts;StateStore 明确 `dispatch_model` ≠ `runner_model`,后者仅展示/审计——run-dispatcher.ts:110-113 的注释是 stale 的,说的 runner_model 不对)→ 注入内置默认不影响 retry 的 dispatch 语义。
- `modelShortCode` 按 family 前缀匹配 → `claude-opus-4-8[1m]` / `claude-opus-4-8` 都是 "O",thread 短码不受影响。

## 3. 设计决定(汇总 gate 结论 + 数据)

| 决定 | 内容 | 依据 |
|------|------|------|
| 默认禁用清单 | discord / playwright / serena(3 个插件)+ `--no-chrome`;**context7 保留**(Annie 拍板);discord 待 Annie thread 终确认(移除=一行改动) | §1 使用率 ≤1%(chrome 除外)+ founder ruling |
| QA 豁免 | `sessionRole === "qa"` → 保留 playwright + chrome(浏览器验收能力),其余照禁 | QA 必须 Claude-in-Chrome(红线);§1 中 chrome 使用 90% 是 QA |
| label 逃生口 | issue 带 `full-mcp` label → 该 runner 完全不瘦身 | §1 的 sub 内容 runner / research 型 runner 特例 |
| 全局 kill-switch | `FLYWHEEL_RUNNER_SLIM_MCP=0` → 整体关闭,spawn 参数回到字节兼容 | Q3 gate 结论(默认 ON) |
| 清单可配 | `FLYWHEEL_RUNNER_DISABLED_PLUGINS`(逗号分隔)覆盖默认清单 | serena 若未来要用可零代码改回 |
| runner 默认 model | `claude-fable-5`(同模型去 [1m]);`FLYWHEEL_RUNNER_DEFAULT_MODEL` 覆盖,`off` 回退旧行为 | Q1 gate 结论;模型不变最保守 |
| medium tier | `claude-opus-4-8`(去 [1m]) | Q1 gate 结论;**ship approve gate 单列知会 Annie** |
| 1M opt-in | label + dispatch alias:`opus-1m` → `claude-opus-4-8[1m]`、`fable-1m` → `claude-fable-5[1m]` | Q1 gate 结论 |
| 作用范围 | 仅 claude-tmux runner;Lead / codex / agy / kimi backend 不碰 | exploration §5 scope 边界 |

## 4. 验收要求(Lead 硬要求,plan 必含)

1. **真机 spike 先行**:`--settings` 禁插件 + `--no-chrome` 真生效(ps 数 MCP 子进程),QA 形态豁免真保留 —— spike 不过不写实现。
2. **before/after 实测**:改完 spawn 真实 runner,`ps`/`footprint` 实测每 session footprint 前后对照数字。
3. **QA runner 浏览器豁免真机验证**。

## 5. 预期效果(FLY-753 口径重算)

非-QA runner:MCP -467MB(discord 120 + playwright 150 + serena 197;context7 126MB 经 Annie 拍板保留)+ chrome native host + context -0.35GB(1M→小)≈ **每 runner 省 0.8-1.0GB**,1.4GB → **0.4-0.6GB**。20 runner 场景省 ~16-20GB —— 当前 swap 撑爆量级;48GB 机器安全并发 ~18 → ~35-40(FLY-753 Q4 结论基本达成,不用换机器)。真机实测(改后代码):legacy 形态 7 个 MCP 子进程 1086MB → 3-插件 slim 形态保留 context7 约 2 进程 ~126MB。
