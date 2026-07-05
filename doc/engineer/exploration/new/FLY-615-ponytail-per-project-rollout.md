# Exploration: 接入 ponytail + per-project 灰度开关 — FLY-615

**Issue**: FLY-615 ([token] 接入 ponytail + per-project 灰度开关)
**Date**: 2026-06-28
**Status**: Draft (plan-first — 等 Annie brainstorm 定方向)

> Lead(Tadashi)指令 [9b615e76]:本 issue 走 **plan-first**。先做 exploration + design + 写 plan,present review,然后等 Annie brainstorm 定方向。**先别 implement、不开 PR**。
> 本文把"想要的效果"和"两块的设计选项"摊开,作为 Annie brainstorm 的输入。

---

## 1. Problem / Goal

3 件套之一(FLY-614 tracking + FLY-615 接入&开关 + FLY-616 eval),目标:让 Flywheel 的 Runner 在写代码时**少写不必要的代码**,从而省 token、提速,且不掉质量。手段 = 接入 **ponytail**(一个 code-minimalism 插件),并能**按项目灰度**(有的项目开、有的不开),配合 tracking + eval 量化"省多少 token、质量掉没掉"。

Annie 明确纠正过 framing:这**不只是一个开关**,是**两件合一**——

1. **接入 ponytail**(我们还没接,应该很小,大概 npm / `/plugin install` 级别)。
2. **做成 per-project 灰度开关**(更复杂的那块)—— 在现有 per-project config(Docker / model 配置那套)里加 `ponytail: on/off`。

---

## 2. ponytail 是什么(已核 GitHub + Claude Code 文档)

| 维度 | 事实 |
|------|------|
| 本质 | code-minimalism / "决策梯子" 插件:写代码前先停在"能满足任务的最低一档"(YAGNI → 用 stdlib → 用平台原生 → 用已装依赖 → 一行 → 最后才写最小实现);review 时专挑过度工程删 |
| 形态 | **真 Claude Code 插件**:marketplace `DietrichGebert/ponytail`,装为 `ponytail@ponytail`;含 skills(ponytail-review/audit/debt/gain/help)+ **Node 生命周期 hooks**(每轮注入紧凑 ruleset,需 `node` 在 PATH)+ `/ponytail` 命令(lite/full/ultra/off mode 切换)|
| 许可 | MIT,开源,不碰凭证 / 不 MITM |
| npm 包 | `@dietrichgebert/ponytail` |
| mode | lite / full / ultra(默认 full);可经 `/ponytail <mode>`、env `PONYTAIL_DEFAULT_MODE`、或 `~/.config/ponytail/config.json` 设 |
| 多 agent | 支持 14 个 agent(含 Codex / Gemini CLI / Copilot 等),但各家装法不同 |
| 收益画像 | **大码项目最受益**(measured ~54% mean、up to 94% less code);视频 / 音乐 / 玄学类近零触发 |

**关键含义**:ponytail 通过 **plugin 的 hooks** 干活 —— 所以"启用这个插件"(让它的 hooks/skills 加载)才是激活点。mode 只调强度,不负责启用。

---

## 3. 现状审计(为什么"接入"是从零、"开关"要仿现成 pattern)

- **Flywheel 现在零 Claude Code 插件机制**:没有 marketplace / install / `enabledPlugins` 任何处理(唯一沾"plugin"的是 Discord 插件 fork 的缓存版本校验,与本 issue 无关;全局 skill 走 `flywheel-skills` 的 skills-sync,不是 plugin 机制)。
- **per-project config 已成熟**:`.flywheel/config.yaml`,经 `ConfigLoader` 校验、`run-infra.ts` 加载。已有三个 **default-off 灰度开关** 是直接可仿的 pattern:
  - `doc_flow`(`{ enabled: boolean }`,FLY-205)
  - `founder_ux_gate`(`{ mode: off|audit_only|enforce }`,FLY-598)
  - `qa`(`{ auto: boolean, ... }`,FLY-579)
  - 共同纪律:**缺省即 off、byte-compatible**(不配置 = 行为逐字不变)。
- **Runner 起法**:`TmuxAdapter` 用 `tmux new-window` 起 `claude` CLI;`buildClaudeArgs()` 已按需追加 `--model` / `--allowed-tools` / `--permission-mode` 等 flag —— 这是注入"per-runner 启用 ponytail"的现成缝。
- **Runner 跑在目标项目的 git worktree 里**(`Blueprint.ts` worktree 创建后 `cwd = worktreePath`)。
- **CLAUDE_CONFIG_DIR**:Lead/Runner 默认共享 `~/.claude`(从 launcher 继承)。所以**插件一次装进共享 `~/.claude` 即所有 Runner 可见**;启用与否再 per-project 控制。

---

## 4. 设计:两块各自的选项

### 块 1 — 接入(让 ponytail 在本机"可用")

| 选项 | 做法 | 评价 |
|------|------|------|
| **1A(推荐)** | shipped 幂等脚本 `setup-ponytail.sh` = `claude plugin marketplace add DietrichGebert/ponytail` + `claude plugin install ponytail@ponytail` 进共享 `~/.claude`,**保持全局 disabled**。操作员(Annie/Tadashi)跑一次。 | 最贴现状(同 flywheel-skills「全局 setup + 一条命令」)。**PR 没法替机器装全局插件**,所以"装"本身天然是一次性操作步,PR 交付 = 脚本 + 文档 + 流水线接线。 |
| 1B | Runner spawn 时 lazy 检测未装就装 | 加 spawn 延迟 + 网络依赖 + 复杂度,拒。 |
| 1C | 不用真插件,直接把 ponytail 的 ruleset 文本塞进 `--append-system-prompt` | 绕开插件 = 失去更新 / hooks / skills,且 eval(FLY-616)就量不到"真 ponytail"。与 issue "接入 ponytail" 相悖,拒。 |

### 块 2 — per-project 灰度启用

config 侧:`.flywheel/config.yaml` 加 `ponytail`(default off,mirror `doc_flow`)。
启用机制(把 `ponytail: on` 翻译成"这个 Runner 的 claude session 启用插件"):

| 选项 | 做法 | 评价 |
|------|------|------|
| **2A(推荐)** | Runner spawn 时给 `claude` 加 `--settings '{"enabledPlugins":{"ponytail@ponytail":true}}'`(命令行内联 JSON,优先级最高) | **per-runner、不往 worktree 写任何文件、复用 `buildClaudeArgs` 现成 seam = 最小改动**。已核 Claude Code CLI:`--settings` 接受内联 JSON,覆盖文件级同名 key。 |
| 2B | worktree 创建后写 `<worktree>/.claude/settings.local.json`(`enabledPlugins`) | 更重(要 merge 已有文件、写入时机、worktree 清理);**仅当目标项目自己也用 `enabledPlugins` 时更安全**(2A 内联会整体覆盖 `enabledPlugins` key)——目前没项目用,所以 2A 的覆盖风险≈0。 |
| 2C | env var | Claude Code 无"按 env 启用某插件"的机制,拒。 |

> **2A 的唯一已知 trade-off**:`--settings` 对 `enabledPlugins` 是 key 级整体覆盖,若将来某目标项目在自己 `.claude/settings.json` 里也配了 `enabledPlugins`,会被盖掉。目前 Flywheel 所有目标项目都没配 —— 风险当前为零,文档记录 + Codex/QA 兜底。若 Annie/Tadashi 觉得不放心,退 2B。

---

## 5. Scope v1 边界(建议,待 Annie brainstorm 确认)

1. **只接 Claude Runner**(`claude-tmux`)。Codex runner 的 ponytail 装法不同 → follow-up。
2. **只做 on/off**;mode(lite/full/ultra)默认 full、v1 不暴露(留 `ponytail.mode` 作未来 knob)。
3. **开了就对该项目所有 Runner 生效**:ponytail 自身只在写代码时触发,非代码活(doc/research/玄学)近零开销,无需 per-issue / per-role 细分。
4. **默认全 off**(byte-compatible)。第一个灰度开:建议大码项目(flywheel 自己 或 GeoForge3D),配合 FLY-614/616 量化。

---

## 6. 给 Annie brainstorm 的方向决策点

1. **"接入"的分工**:同意"shipped 脚本 + 操作员一次性 install"?(PR 不替机器装全局插件)
2. **启用机制**:2A(`--settings` flag,最小改动)还是 2B(worktree settings 文件,更稳但更重)?
3. **scope 四条边界**(§5)对不对?尤其"先只接 Claude、不接 Codex"、"只 on/off 不暴露 mode"。
4. **第一个灰度项目** 选哪个?
5. **量化口径**:本 issue 只负责"接入 + 开关";"省多少 / 质量掉没掉"的度量分别归 FLY-614(tracking)/ FLY-616(eval)。确认本 issue 不揽这部分。

---

## 7. Risks / Open

- ponytail hooks 需 `node` 在 Runner PATH(tmux 起 claude 时继承 shell profile,应有 —— QA 真机验)。
- `--settings` 内联 JSON 在 spawn-args 里要正确转义(`buildClaudeArgs` 已有把长 system-prompt 写文件避免 argv 过长的先例;JSON 串短,直接传即可,但需测真实启用生效)。
- 启用是否真的"让 ponytail 加载并干活" = 必须真机 QA(写一个会过度工程的小任务,对照 on/off 看代码量 / token)。
- 与 FLY-614/616 的接口:eval 需要能稳定区分"这个 Runner 开了没"——2A 的 spawn-args 可被日志/tracking 直接观察到,利于关联。
