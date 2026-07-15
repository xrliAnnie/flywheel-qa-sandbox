# FLY-1236 Codex goal objective 超 4000 上限 — 探索

Issue: FLY-1236 (https://linear.app/geoforge3d/issue/FLY-1236/bug-codex-implement-段-goal-objective-超-4000-字符上限-setup-failed-秒阻塞1225)
日期: 2026-07-14
基于: 无

## 1. 问题陈述

FLY-1224 per-phase vendor 上线后,第一单自然派发的 **Codex implement 段**(exec `b5709306`,FLY-1225)起跑即 `blocked`。Bridge log 铁证:

```
[CodexTmuxAdapter] b5709306-… failed: goal run setup_failed: goal setup failed:
rpc "thread/goal/set" error: {"code":-32600,"message":"goal objective must be at most 4000 characters"}
```

`thread/goal/set` 的 `objective` 参数被 Codex daemon 硬限制在 **≤ 4000 字符**;超限直接 RPC 报错 → runner 的 goal 建立失败 → `setup_failed` → 秒阻塞。这挡住**所有真实规模的 Codex implement**。

## 2. 根因(代码级已核实)

`CodexTmuxAdapter.execute()` 组装 objective 的方式(`CodexTmuxAdapter.ts:349`):

```ts
const systemLayer = ctx.enablePonytail ? (PONYTAIL_RULESET + appendSystemPrompt) : ctx.appendSystemPrompt;
const objective = buildGoalObjective({ systemLayer, prompt: ctx.prompt });
```

`buildGoalObjective`(`codex-daemon-adapter-helpers.ts:46`)只是把两段**原文**拼接:

```ts
return input.systemLayer ? `${input.systemLayer}\n\n---\n\n${input.prompt}` : input.prompt;
```

- `systemLayer` = ponytail ruleset(~2KB)+ appendSystemPrompt
- `ctx.prompt` = issue 描述 + design 交接内容 + pipeline 规则,Blueprint 侧截断上限 **40000 字符**

真实三段式 implement 的 prompt 单独就轻松超 4000,再叠 systemLayer,`objective` 必然超限。而这个 objective 被原样送进 `runGoal → runGoalToTerminal → setGoal(objective)`(`codex-daemon-client.ts:638`),没有任何长度防御。

**为什么 529-B 沙箱没抓到**:冒烟用短句 objective("implement {feature}" + 小 notes),`prompt` 小 → 拼接后 < 4000,从不触限。这是生产规模才暴露的组装缺陷。

## 3. 关键机制(为修法奠基)

Codex daemon 的一次 run 有三个内容通道:

| 通道 | RPC | 长度限制 | 当前用途 |
|------|-----|----------|----------|
| `$CODEX_HOME/AGENTS.md` | 文件 | 无 | daemon 持久契约(vendor 固定层) |
| `/goal` objective | `thread/goal/set` | **≤ 4000** | 现在被塞满全文 → 炸 |
| kick turn input | `turn/start` | **无此限制** | 现在只发 stub `"Begin working toward the goal now."` |

即:**正文本该走 kick turn(无限制),却被塞进了有 4000 限制的 objective;而 kick turn 反而只发了一句 stub。** 通道用反了。

`objective` 的另一职责:`objectiveIsOurs`(`codex-daemon-client.ts:558`)用它判断 goal 是否被别的 control end 顶替(resume/重连场景)。因此 objective 必须**跨 resume 稳定**,但其**内容不需要等于工作正文** —— 短的稳定 north-star 完全够用。

## 4. 顺带症状:founder TUI 窗口秒死 = **同因**

同一次 spawn founder cmux 窗口秒死。代码路径已核实为**同一根因的连带**:

- `onThreadReady` 在 setGoal **之前**触发(`CodexTmuxAdapter.ts:451` 注释明确 "onThreadReady fires BEFORE setGoal"),此时 `openWindow` 已把 founder 窗口开出来;
- 随后 setGoal 因 objective 超限抛 `GoalRunError` → `caughtError` → `finally` 块 `killWindow` 把刚开的窗口拆掉。

所以窗口"秒死"就是整个 run 在 goal-set 失败后被拆带走的。**修好 goal-set → run 继续 → 窗口存活**。自愈,不另立 issue。

## 5. 正确的部分(保持,回归测试勿破坏)

fail-closed 表现完美:turn-belt 秒回收 stale turn、交还 parked design holder、无 husk 占带。本修不碰 teardown/reclaim 路径,只让真实规模 run 在 goal-set 阶段成功,失败路径的回归测试保持绿。

## 6. 候选修法

### 方案 A(采纳)— objective 传"指针",正文走 kick turn(镜像 Claude 成熟做法)
- `objective` = **有界 north-star 指针**,由 `ctx.issueId` + `ctx.label` 构造(+固定指引句),天然 <4000、跨 resume 稳定。
- **完整正文**(systemLayer + prompt)改走 **kick turn**(`turn/start` input,无长度限制)—— 这才是 codex 实际读取工作指令的地方。
- **防御(fail-loud,不静默截断)**:送入 setGoal 前断言 objective ≤ 4000;万一超限(病态超长 label),降级为最小指针 + **loud log**;正文永远不丢(它在 kick turn 里)。

### 方案 B — 写 durable goal 文件,objective 只指文件路径
issue 描述提到的形态("读 <goal 文件路径> 后按 plan.md 施工")。但需要额外文件 I/O、sandbox 可写路径管理、清理。kick turn 直接在带内投递正文,更简洁、无新增文件生命周期。**否决**(过度工程)。

### 方案 C — 仅截断 objective 到 4000
违反 issue 明令"不许静默截断丢内容",且丢的是工作指令。**否决**。

## 7. 采纳:方案 A

单一一致路径:objective **永远**是短指针(primary),正文**永远**走 kick turn;再叠一层 setGoal 前的 fail-loud 降级防御(defense)。范围隔离在 Codex daemon 路径(`codex-daemon-adapter-helpers.ts` + `CodexTmuxAdapter.ts`),不影响 claude/kimi/antigravity tmux adapter。
