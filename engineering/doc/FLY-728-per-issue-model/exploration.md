# FLY-728 per-issue 模型路由 — 探索

Issue: FLY-728 (https://linear.app/geoforge3d/issue/FLY-728/model-per-issue-模型路由-按-issue任务定模型heavyfable-smallopussonnet覆盖项目默认)
日期: 2026-06-30
基于: 无

## 1. 目标（Annie 原话）

Fable 5 明天出。Annie 要 **给不同 issue 定不同模型** —— heavy 的 task 用 **Fable**、小 task 用 **Opus / 甚至 Sonnet**。按任务量级选模型、**覆盖项目默认**。

四条硬性要求（issue 正文）：

1. **per-issue 模型覆盖机制**（Linear label / 字段 / 或 dispatch 时传）→ 该 issue 的 runner 用这个模型、覆盖项目默认。
2. **模型选项含 Fable** + Opus / Sonnet / Haiku。
3. runner dispatch（`/api/runs/start`）resolve 顺序：**issue 覆盖 > 项目默认 > account 默认**。
4. **可见**：issue/runner 上看得到用的哪个模型（呼应 FLY-562）。

## 2. 关键发现 —— 机制其实**大部分已存在**

审计代码库后（`resolveRoleAdapter` + `parseRunnerLabels` + dispatch 链路），结论是 **per-issue 模型覆盖机制在 opus/sonnet/haiku 上已经能用**，不是从零造。

### 2.1 现有 resolve 链路（Bridge dispatcher，`/api/runs/start` 权威路径）

```
/api/runs/start (runs-route.ts)
  → 已 fetch + 归一化 issue labels（issueLabelNames → normalizedIssueLabels）
  → startDispatcher.start({ issueLabels, ... })
    → RetryDispatcher/RunDispatcher 构造 BlueprintContext
      → buildRunnerSpawnFields(execId, leadId, issueLabels, rolesConfig)   [run-dispatcher.ts:92]
        → resolveRoleAdapter({ role:"runner", issueLabels, projectRoles })  [role-adapter-resolver.ts:147]
          → { backend, model, effort }
      → ctx.runnerModel = resolved.model
    → adapter.execute({ model: ctx.runnerModel })   [Blueprint.ts:1355]
      → TmuxAdapter: args.push("--model", ctx.model)  [TmuxAdapter.ts:683]
```

### 2.2 `resolveRoleAdapter` 的优先级（**已经就是 issue 要的顺序**）

| 层级 | 来源 | 设 model? |
|------|------|-----------|
| 1. task 覆盖 | issue **label**（`parseRunnerLabels`） | ✅ `modelOverride` |
| 2. 项目默认 | `.flywheel/config.yaml` `roles.runner.model` | ✅ |
| 3. 全局 env | `FLYWHEEL_RUNNER_BACKEND` | ❌（只定 backend） |
| 4. 内置默认 | `claude-tmux` | ❌ → 省略 `--model` = **account 默认** |

映射到 issue 要求：**issue 覆盖（label）> 项目默认（roles.model）> account 默认（省略 --model）** —— **完全一致**。而且 layer-1 设了 backend 后 layer-2 直接跳过，所以 issue label **确实覆盖项目默认**（req 3 已满足）。

### 2.3 label→model 解析（`packages/config/src/runner-label.ts`）

`resolveModelFromLabels` 现已识别：`opus` / `sonnet` / `haiku` / `gemini-*` / `gpt-*-codex`。
→ 一个 issue 打 `opus` label，runner 就会 `claude --model opus`，**这已经是 per-issue 覆盖**。

## 3. 真正缺的东西（gap）

### Gap A —— `fable` 没被识别（**核心 enabler，必做**）

`resolveModelFromLabels` **没有 `fable`**。所以今天给 issue 打 `fable` label = 无效、掉进项目/account 默认。Fable 5 是 Annie 明天要用的头号模型，这是**唯一真正卡住 heavy→Fable 的点**。

- 规范 id：全库统一用 **`claude-fable-5`**（`fleet-capabilities.ts:58`、`token-usage/pricing.ts`、`render-html.ts` 都是这个）。`--model` 直传（`TmuxAdapter.ts:683`）。
- 修：`resolveModelFromLabels` 加 `fable → "claude-fable-5"`；`inferRunnerFromModel` 让 `fable`/`claude-fable-5` 归到 `claude` runner（`claude-fable-5` 本就 `startsWith("claude")`，天然归 claude；补 bare `fable` 防御 project-config/dispatch 传裸词）。
- 副作用零：token-usage 已认 `claude-fable-5`→"Fable 5"，可见性/计价自然对齐。

### Gap B —— 模型不可见（req 4）

sessions 表**没有 model 列**。模型只体现在 `adapter_type`(backend) + CLI flag，没持久化、dashboard 看不到。

- 修：**镜像 `adapter_type` 的现成模式**（FLY-493）——`EventEnvelope.runnerModel` → `session_started` payload → `event-route.ts` + `DirectEventSink.ts` 落 `runner_model` 新列（StateStore ADD COLUMN + upsert list + patch 白名单 + Session type）→ Bridge dashboard active-sessions 表加一列「Model」。
- 这是 req 4「可见」的最小真实落地（呼应 FLY-562/709，完整 issue/Linear 可见性归它们）。

## 4. 可选（非核心）—— per-run dispatch 参数

issue req 1 写「Linear label / 字段 / **或 dispatch 时传**」。label 已满足「per-issue 定模型」。「dispatch 时传」是并列可选项：给 `/api/runs/start` 加 `model` body 参数（最高优先级，完全镜像 FLY-615 `ponytail` / FLY-205 `docTier` 的线路：body 校验 → StartRequest/RetryRequest → dispatcher → resolveRoleAdapter 新最高层）。

- **价值**：给 Cass/Lead 程序化在起 runner 时定模型（不必先打 label）。
- **成本**：中等（body 校验 + 2 个 request 类型字段 + dispatcher 穿线 + resolver 新分支 + retry 保值）。
- **判断**：Annie 的实际工作流是**在 Linear 打 label**；label（Gap A）已覆盖她说的场景。倾向 **今晚不做 C、作为 fast-follow**，除非 Lead 要一并做。

## 5. 建议 scope（今晚）

- **A（必做）**：`fable` label → `claude-fable-5`。opus/sonnet/haiku 已能用。→ 满足 req 1（机制=label）、req 2（含 Fable）、req 3（顺序已对，补测试）。
- **B（必做）**：可见性 —— 持久化 `runner_model` + dashboard 显示。→ 满足 req 4。
- **C（可选/倾向 fast-follow）**：per-run `model` dispatch 参数。

TDD、字节兼容（不打 label/不加列查询 = 现状零变化）、镜像 ponytail/doc_tier/adapter_type 既有模式。

## 5b. 【scope 扩展 2026-07-01】分拣器 fold 进 728（Lead 转 Annie 拍板）

Annie 要求 728 = 完整 per-issue 模型系统、**一个 PR**（标签+可见性+**分拣器**全做完，不拆 phase、不留 follow-up；729 已取消）。A+B 已实现在 #405（绿灯待扩）。

**完整 resolve ladder**（dispatch 时）:
1. issue 手动标签(含 fable,Lead 对话式打) — 已实现(A)
2. **分拣器**(无手动模型标签时,读 issue 判难易→tier→模型) — **新增,待建**
3. 项目默认(FLY-671 `roles.runner.model`) — 已有,不重造
4. account 兜底(`claude-opus-4-8`-1M) — 已有,不重造(= 现状 omit `--model`)

tier→模型:难→Fable5 / 中→Opus4.8 / 简单→Sonnet5 / 很简单→Haiku。映射的**可配置化归 FLY-709**;728 内先用内置默认映射。

### 集成架构调研（invariant to Annie 的 heuristic 选择,已勘定）

**① 分拣器落点**:
- 需要 issue 的 title + description + labels 才能判难易。`runs-route.ts` 已 fetch issue(有 title/labels),`issue.description` **同一个 fetch 可取**(现未下传)。
- 若 **heuristic**(纯函数、确定性):`classifyIssueTier(title, description, labels) → tier|null` + `tierToModel(tier)`,插进 `resolveRoleAdapter` 的 label 层与 project 层之间;需把 title+description 经 StartRequest→BlueprintContext→buildRunnerSpawnFields→resolveRoleAdapter 下传(labels 已下传,加 description)。
- 若 **便宜 LLM**:异步、须在 `runs-route`(async)里跑,产出模型再下传 —— 不能塞进纯 `resolveRoleAdapter`。
- 触发条件:仅当 label 层**未解析出模型**(不覆盖 Annie 手动标签);产出的 4 档全是 Claude 模型 → backend=claude-tmux。

**② 可见性 F/O/S/H 短码**:
- 搭现有 **FLY-560 thread-title badge** 机制(`stage-utils.ts` STAGE_EMOJI/badge + `event-route.ts stampStageEmojiForSession` → `chatThreadCreator.stampStageEmoji`)。
- 但 F/O/S/H 是**模型标记**、区别于 stage emoji,须与现有 prefix-strip/re-stamp 逻辑(`splitStatusEmoji` 只剥单个 status emoji)共存 —— 倾向做成**标题后缀**(如 `🔨实现中 [FLY-XX] title [F]`)避免与 stage-emoji 前缀冲突。`runner_model` 已由 A+B 持久化,数据就绪。
- 待 Annie 确认:短码格式 + 『顶端像 tmux 显示』是 728 还是归 FLY-562。

**③ heuristic vs LLM**:Decision Layer 已有 Haiku triage 先例(便宜 LLM 分类可复用);但 heuristic 更快/确定/可测,建议基础版先上。

### 待 Annie 拍板（brainstorm gate 已发 Lead 转)
- Q1 判难易依据(核心):heuristic 用什么信号?(Linear size/type 标签 + 标题关键词 + 描述规模)
- Q2 每档真实 issue 例子做边界校准
- Q3 基础版 heuristic vs 便宜 LLM
- Q4 可见性范围(短码格式 + 顶端显示归属)
- Q5 确认『分拣器盖过项目默认』的含义

## 6. 已知/有意的行为（surface 给 Lead）

- 纯 model label（fable/opus/…）会把 backend 定成 `claude-tmux`（`inferRunnerFromModel`）。对 Annie 的用法（Fable/Opus/Sonnet/Haiku 全是 Claude 模型）**正确且是想要的**。若项目默认 backend 是 codex，打 `opus` label 会切成 claude-tmux+opus（无法在 codex 上跑 Claude 模型，符合直觉）。
- 同时打 vendor label（如 `codex`）+ model label（`fable`）：agent label 赢、不兼容的 model 被丢弃（`parseRunnerLabels` 现有规则，fable 遵循同规则、不改）。
