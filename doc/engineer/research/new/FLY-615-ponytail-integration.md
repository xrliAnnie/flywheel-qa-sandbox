# Research: ponytail 接入机制 + Flywheel 注入缝 — FLY-615

**Issue**: FLY-615
**Date**: 2026-06-28
**Source**: `doc/engineer/exploration/new/FLY-615-ponytail-per-project-rollout.md`

> 验证口径:ponytail 安装/启用机制来自 GitHub README + Claude Code 官方文档/CLI reference(WebFetch 实拉);Flywheel 缝来自 codebase grep + 文件读(下方均带路径 + 行号)。

---

## A. ponytail 安装 / 启用(已核 README + Claude Code 文档)

### A.1 安装(一次性,机器级)
```
# 两步分两个 prompt(README 明确:必须分开发)
/plugin marketplace add DietrichGebert/ponytail
/plugin install ponytail@ponytail
```
非交互等价(可脚本化):
```
claude plugin marketplace add DietrichGebert/ponytail
claude plugin install ponytail@ponytail
```
- 安装态写在 `CLAUDE_CONFIG_DIR`(默认 `~/.claude`)的 `~/.claude.json`;marketplace catalog 也缓存于此。
- 完整插件名 = `ponytail@ponytail`(plugin "ponytail" from marketplace "ponytail")。
- ships:plugin 结构 + Node 生命周期 hooks(每轮注入 ruleset,需 `node` 在 PATH)+ skills + `/ponytail` 命令 + rules。

### A.2 启用(per-project / per-launch)——已核 Claude Code CLI/Settings 文档
启用与安装分离:`enabledPlugins` 才决定插件是否加载干活。三种 scriptable 启用法:

| 法 | 机制 | 优先级 / 备注 |
|----|------|--------------|
| `--settings '<json>'` 内联 | `claude --settings '{"enabledPlugins":{"ponytail@ponytail":true}}' ...` | **命令行级、最高优先**(高于所有文件)。"override the same keys ...; keys you omit keep their file-based values" → 对 `enabledPlugins` 这个 top-level key 是整体覆盖。**本 issue 推荐**。 |
| 项目 `.claude/settings.local.json` | 写 `{"enabledPlugins":{"ponytail@ponytail":true}}` | local 级,高于 user `~/.claude/settings.json`;每次 launch 从 cwd 读。 |
| 项目 `.claude/settings.json` | 同上,project 级 | 低于 local。 |

settings 优先级(高→低):Managed > 命令行(`--settings`)> `.claude/settings.local.json` > `.claude/settings.json` > `~/.claude/settings.json`。

**否定结论**(已核):
- **无** `--plugin` / `--enable-plugin` flag。
- `--plugin-dir <path|.zip>` 只能从**文件系统路径/URL** 加载并自动激活,**不能**按名加载已装的 marketplace 插件 → 不适用。
- `enabledPlugins:false` 或省略 = 不加载(skills/hooks/MCP 都不触发)。
- 新写的 settings 在**下次 launch** 即生效(每次启动读 cwd 的 settings);本场景 Runner 每次都是全新 launch → 天然生效,无需 `/reload-plugins`。

### A.3 共享 CLAUDE_CONFIG_DIR 的含义
Flywheel 的 Lead/Runner 默认共享 `~/.claude`(§B.3)。所以:
- **装一次**(进 `~/.claude`)→ 所有 Runner 都"看得见"该插件。
- **全局保持 disabled**(不在 `~/.claude/settings.json` 写 enable)→ 默认谁都不开。
- **per-project enable** 经 `--settings`(2A)或 worktree settings(2B)→ 只选中的项目的 Runner 开。

---

## B. Flywheel 注入缝(带文件 + 行号)

### B.1 per-project config 加载链
- 类型:`packages/config/src/types.ts`(`FlywheelConfig` 根接口在 ~436-476;同类灰度开关 `DocFlowConfig` 193-205、`FounderUxGateConfig` 259-262、`QaConfig` 213-231、`ProofShotConfig` 101-120)。
- 校验:`packages/config/src/ConfigLoader.ts`(present 才校验、disabled/缺省走 byte-compat 默认)。
- 加载点:`packages/teamlead/src/bridge/run-infra.ts:560-628`
  - 567:`configPath = <root>/.flywheel/config.yaml`
  - 572-581:`flywheelConfig?.<key>` 逐个取(`doc_flow`/`founder_ux_gate` 等就在这几行)。
  - 616-628:`createRunBlueprint(...)` 把各 config 传进 Blueprint。

### B.2 Runner spawn / CLI flag 缝
- 起点:`packages/claude-runner/src/TmuxAdapter.ts`
  - `execute()`(~199-500):`tmux new-window ... <windowCommand>`。
  - `buildClaudeArgs(ctx, sessionId)`(~648-692):按需 push `--session-id` / `--permission-mode` / `--append-system-prompt-file` / `--model`(683)/ `--allowed-tools`(684-685)/ `--name`,最后 push prompt。→ **`--settings` flag 加在这里**(条件 = ponytail 开)。
- ExecutionContext 由 `packages/edge-worker/src/Blueprint.ts` 的 `runInner()`(~1196-1245)组装并调 `adapter.execute({...})`。新增字段(如 `enablePonytail` 或 `extraSettings`)走 `BlueprintContext` → execute ctx → `buildClaudeArgs`。
- 多 backend:`CodexTmuxAdapter` / `AntigravityTmuxAdapter` / `KimiTmuxAdapter` 各自 `buildCliArgs`;v1 只动 claude 路径,其余不碰(byte-compat)。

### B.3 worktree + settings 文件缝(2B 用)
- worktree 创建:`Blueprint.ts:498-519`,`cwd = worktreeInfo.worktreePath`(519)。**2B 在 519 之后写** `<worktree>/.claude/settings.local.json`(需 merge 已有)。
- 现成的 worktree 文件拷贝:`WorktreeIncludeService`(`packages/edge-worker/src/WorktreeIncludeService.ts`)只拷 `.worktreeinclude` ∩ `.gitignore` 的既有文件,**不**动态写 per-runner config(今天没人往 worktree 写 settings)。
- `.claude/settings.local.json` 通常 gitignore(测试夹具有 `**/.claude/settings.local.json`)。

### B.4 CLAUDE_CONFIG_DIR 现状(FLY-572 已验隔离可行)
- Lead:`packages/teamlead/scripts/claude-lead.sh:1049-1050` 仅在非空时透传 `-e CLAUDE_CONFIG_DIR`。
- Runner:`packages/agent-team-transport/src/claude/ClaudeCodeAdapter.ts` `runtimeEnv()` 透传 `process.env.CLAUDE_CONFIG_DIR`(非空时)→ `TmuxAdapter.ts:405-411` 注入 tmux window。默认未设 = `~/.claude` 共享。
- FLY-572(QA-only)已实证:CLAUDE_CONFIG_DIR + plugin cache 可 per-session 隔离。本 issue **不需要**隔离 —— 共享装一次 + per-launch enable 即可;隔离仅是未来需要时的退路。

---

## C. 推荐技术形状(供 plan 落地)

1. **config**:`FlywheelConfig.ponytail?: { enabled: boolean }`(mirror `DocFlowConfig`);缺省 = off;`ConfigLoader` present-时校验。
2. **加载**:`run-infra.ts` 取 `flywheelConfig?.ponytail`,经 Blueprint → ctx 传到 spawn。
3. **启用(2A)**:`buildClaudeArgs` 在 ponytail 开时 push
   `--settings` + `{"enabledPlugins":{"ponytail@ponytail":true}}`(JSON.stringify,单 arg)。
4. **接入(1A)**:`scripts/setup-ponytail.sh`(幂等:已装则跳过)+ 文档(放 `doc/engineer/implementation/` 或 README 运维段)。
5. **测试**:
   - ConfigLoader:present 合法 / 非法(类型错)/ 缺省 byte-compat。
   - spawn-args:开→含 `--settings` 且 JSON 正确;关/缺省→不含(逐字 byte-compat,其余 backend 不受影响)。
   - 真机 QA(FLY-616 配合 or 本 issue 收尾):on/off 对照,确认插件真加载 + 代码量/token 有差。

---

## D. 与 FLY-614 / FLY-616 的边界
- FLY-615(本 issue):接入 + per-project on/off 开关。**不**做度量。
- FLY-614:tracking(省多少 token)。需要能稳定知道"某 Runner 开了没" → 2A 的 `--settings` 出现在 spawn-args / 进程 argv,tracking 可直接观察。
- FLY-616:eval(质量掉没掉)。灰度 on/off 对照即其输入。
