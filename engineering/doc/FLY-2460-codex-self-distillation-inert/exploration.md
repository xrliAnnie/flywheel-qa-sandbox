# FLY-2460 Codex 自蒸馏为何不触发 — 探索
Issue: FLY-2460 (https://linear.app/geoforge3d/issue/FLY-2460/2355b3-codex-自蒸馏从不触发runner-家里模型拿不到原生-memory-工具memory-stage1-后台任务从不跑)
日期: 2026-09-08
基于: 无

## 0. 一句话结论

Codex 自蒸馏不是「没开」,是**两段门控叠加我们的家布局**:后台管线只在「同一个 CODEX_HOME 的下一次根会话 turn/start」时,对「别的、闲置 ≥6h、≤10 天、来源为交互式」的线程做 stage1;旧的一执行一家布局里每家只有 1 条线程(734/879),永远没有「下一次」,所以从不触发。FLY-2358 的 keyed 持久家已经让它**在生产里自然跑起来**(`agents/flywheel/implement` 家 10 个 stage1 done、10 篇真实 rollout 摘要);但仍缺「最后一次执行没人蒸馏」「间隔 <6h 跳过」「进程退出把 phase2 打断」「零可观测」。原生 memory **工具**对模型不可见是 Codex 默认(`dedicated_tools=false`),不是故障;写入路径本来就是后台蒸馏,不是模型手写。

## 1. 症状回顾(来自 FLY-2359 QA 补证,2026-09-09)

1. `codex debug prompt-input` 导出的模型可见 prompt 里 `ad_hoc_note / memory_search / memory_read / memory_list` 零命中,`--enable memories` 也一样。
2. 两次干净会话后 `memories_1.sqlite` 只有 `memory_consolidate_global`(done, input_watermark=0),没有 `memory_stage1`。
3. 878 个旧家里只有 1 个(0a23cb41)跑过 stage1;949 个 rollout 全文没有原生记忆工具调用。
4. (flywheel, implement) 288 个旧家:2 个真记忆、214 个模板文、72 个无内容。

## 2. 根因:Codex 0.153.2 源码逐门(file:line)

源码来自 `openai/codex` tag `rust-v0.153.2`(本机生产二进制同版:`~/.codex-242/packages/standalone/releases/0.153.2-aarch64-apple-darwin/bin/codex`),clone 在 scratchpad,路径前缀 `codex-rs/`。

### 2.1 门 A:模型看不到记忆工具 = 默认关闭,不是故障

| 位置 | 事实 |
|---|---|
| `ext/memories/src/extension.rs:44` | 扩展启用条件 `features.enabled(MemoryTool) && memories.use_memories` |
| `ext/memories/src/extension.rs:115` | **工具**只在 `config.enabled && config.dedicated_tools` 时注册 |
| `config/src/types.rs:346` | `dedicated_tools` 默认 **false**;`use_memories` 默认 true |
| `ext/memories/src/extension.rs:61-75` + `ext/memories/src/prompts.rs:27-40` | 读路径 = 把 `memories/memory_summary.md` 截到 2 500 token(`ext/memories/src/lib.rs:16`)当 developer 指令注入 |
| `features/src/lib.rs:1078-1083` | `[features] memories` 键 = `Feature::MemoryTool`,Stable,默认 false;我们 seed 的 host config 已设 true |

⇒ QA 看到「0 个工具名」是 Codex 的默认形态。主机 `~/.codex`(founder 自己的 TUI 家,MEMORY.md 420KB、987 个 stage1 done)同样没有开 `dedicated_tools`,记忆照样积累。**写入路径是后台蒸馏 rollout,不是模型手写。**

### 2.2 门 B:后台管线只从 app-server 的 turn/start 启动

| 位置 | 事实 |
|---|---|
| `app-server/src/request_processors/turn_processor.rs:657-669` | **唯一**调用点:`turn_has_input && started && is_primary_environment_configured()` 才 `start_memories_startup_task` |
| `memories/write/src/start.rs:33-38` | `ephemeral` / 特性未开 / 非根 agent(subagent、内部会话)直接返回 |
| `memories/write/src/start.rs:49` | state db 不可用则跳过 |
| `memories/write/src/start.rs:55-80` | 顺序:`ensure_layout`(建 memories/ 脚手架)→ 种 extension 说明 → prune → **限额守卫** → phase1 → phase2 |
| `memories/write/src/guard.rs:38-58` | 守卫:`rate_limit_reached_type` 有值即跳;primary/secondary 窗口 used% 必须 ≤ 100−`min_rate_limit_remaining_percent`(默认 25,`config/src/types.rs:51`) |
| `exec/src/lib.rs:16-35` | `codex exec` 走 in-process app-server,所以 exec 启动**也会**触发管线(主机证据:162 个 stage1 由 exec 来源的 worker 线程完成) |
| `cli/src/main.rs:2231` | `codex debug prompt-input` 固定 `ephemeral: Some(true)` ⇒ 永不触发管线、不落线程;适合当无副作用的读路径取证工具 |

### 2.3 门 C:stage1 候选 = 「别的线程」+ 来源白名单 + 时间窗

| 位置 | 事实 |
|---|---|
| `memories/write/src/phase1.rs:160-174` | `claim_stage1_jobs_for_startup(current_thread_id, {scan_limit 5000, max_claimed=max_rollouts_per_startup, max_age_days, min_rollout_idle_hours, allowed_sources=INTERACTIVE_SESSION_SOURCES})` |
| `rollout/src/lib.rs:70-77` | 白名单 = `Cli, VSCode, Custom("atlas"), Custom("chatgpt")`;**Exec 不在内** |
| `state/src/runtime/memories.rs:148-260`(claim SQL) | `threads.memory_mode='enabled'` ∧ `threads.id != 当前线程` ∧ `updated_at_ms ∈ [now−max_age_days, now−min_rollout_idle_hours]`,按 updated_at 倒序,最多 `max_claimed` 条;已成功水位 ≥ updated_at 的跳过 |
| `config/src/types.rs:48-50` | 默认 `max_rollouts_per_startup=2`、`max_rollout_age_days=10`、`min_rollout_idle_hours=6` |
| `config/src/types.rs:391-394` | **`min_rollout_idle_hours` 被 `clamp(1, 48)`**:配置成 0 也是 1 小时;`max_rollouts_per_startup` 钳在 1–128(`types.rs:56-57`);stage1 并发上限 8 是 `memories/write/src/lib.rs:81`。⇒ 刚结束的线程最快 1 小时后才可能被 claim(R1 Codex 评审指出,本单复核) |
| `protocol/src/protocol.rs:2740-2751` | `SessionSource` 枚举;`exec/src/lib.rs:553` exec 会话标 `Exec` |
| `memories/write/src/lib.rs:98-105` | stage1 输入截到模型上下文的 70%(`prompts.rs:100-125`),兜底 150k token;并发 8;lease 1h |

⇒ **每家只有一条线程时,这条线程永远是「当前线程」或根本没有下一次启动,不可能被 claim。**

### 2.4 门 D:phase2(真正写文件的一步)有硬编码 6h 冷却,且随进程死

| 位置 | 事实 |
|---|---|
| `memories/write/src/phase2.rs:49-125, 219` | phase2 = 全局单任务 `memory_consolidate_global`:claim → 准备 git 工作区 → 起受限 agent 合并 → `sync_rollout_summaries_from_memories` 才把 `rollout_summaries/*.md`、`MEMORY.md`、`memory_summary.md` 落盘 |
| `state/src/runtime/memories.rs:21, 1158-1163` | `PHASE2_SUCCESS_COOLDOWN_SECONDS = 6h`,**常量不可配置**;上次成功在 6h 内 ⇒ `skipped_cooldown` |
| `state/src/runtime/memories.rs:1152-1156` | 上一轮 `running` 且 lease(1h)未过 ⇒ `skipped_running` |
| 生产实证 | `agents/flywheel/implement` 家 `memory_consolidate_global` 自 2026-09-09 03:33 起 `running`,该执行已退出、lease 目录为空 ⇒ 最新 2 条 stage1 输出还没落成文件;旧家里另有 4 个同样卡 `running` |

stage1 平均 41s(主机 987 条)、phase2 61–93s;实验里 stage1 34s + phase2 61s。

### 2.5 我们这边的结构性原因

| 事实 | 证据 |
|---|---|
| 879 个 `~/.flywheel/codex-homes/*`:734 个恰好 1 条线程,23 个 0 条,只有 37 个 ≥2 条 | 本单全量扫描(state_5.sqlite threads 表) |
| runner 线程来源都是 `vscode`(daemon = `codex app-server --remote-control`,`codex-daemon-runtime.ts:729-746`),`memory_mode=enabled` | 同上;不是 exec 来源,所以门 C 的白名单**不是** runner 的问题 |
| 主机 9 月 61 个 `exec` 来源 rollout 全部无 stage1;`cli`/`vscode` 来源 17 个全部有 | 白名单只影响 Claude Code 驱动的 `codex exec` 评审会话(不在本单范围,记为副产品) |
| 唯一真蒸馏过的旧家 0a23cb41:13 条 vscode 线程(originator=Claude Code,codex-companion 反复复用同一家) | 正好是「同一家多次启动」的反例 |
| **FLY-2358 keyed 家 `agents/flywheel/implement`**(2026-09-06 起):32 条线程,`memory_stage1` done 10、`rollout_summaries/` 10 篇真实摘要(fly_2239 … fly_2444),MEMORY.md 26KB 真内容;claim 它们的 worker 全是后续 implement runner 自己的根线程 | 生产已在自然发生,但按 2/次、≥6h、10 天窗口「滞后一次执行」 |
| keyed 家 `agents/flywheel/eng_design`:6 条根线程,`jobs` 0 行,连 `memories/` 目录都没建 | 说明管线在门 B 就没进(`ensure_layout` 在守卫之前)。配置与 implement 家逐行相同;Codex 只把跳过原因记到 metrics(`skipped_rate_limit`/`skipped_no_candidates`),日志里找不到 ⇒ **零可观测是真实缺口**,原因待 QA 在房里用本设计的回执定位 |

### 2.6 复现实验(scratchpad 拷贝,生产旧家零写入)

`exp-evidence/exp-run.sh`:把旧家 8c6c9978(1 条 vscode 线程,2026-09-05 终态,jobs 0 行)整目录 rsync 到 scratchpad,`auth.json` 按 provisioning 同款做法软链到 canonical 主机凭据,然后

```
CODEX_HOME=<copy> codex exec --skip-git-repo-check -C <空 cwd> \
  -c memories.min_rollout_idle_hours=0 -c memories.max_rollout_age_days=400 \
  -c memories.min_rate_limit_remaining_percent=0 -c memories.max_rollouts_per_startup=4 \
  --json "Run the shell command: sleep 420 ; then reply ... done"
```

结果(`exp-evidence/exp-result.md`、`exp-poll.log`):触发后 34s `memory_stage1` 对该家原来的 vscode 线程 done,`stage1_outputs` 1 行(raw 2 297 B / summary 3 599 B,slug `fly-2142-dependency-ledger-exact-head-handoff`),`rollout_summaries/2026-09-05T02-04-26-vNSA-fly_2142_….md` 落盘;再 61s phase2 done,`MEMORY.md` 3 910 B、`memory_summary.md` 1 880 B,正文是 FLY-2142 的真实交接经验,不是模板。触发线程自己以 `exec` 来源入库,不会成为后续候选。

⇒ **只要在同一家再起一次根会话并覆盖年龄阈值,≥1 小时前结束的旧 rollout 就能被蒸馏。** 管线本身是通的。注意:被蒸馏的线程结束于 4 天前,实验没有、也不可能证明「刚结束的线程当场蒸馏」——`min_rollout_idle_hours` 的 1 小时下限(§2.3)使那条路在 0.153.2 上不存在。

## 3. 设计选项

### O1 什么都不加,靠 FLY-2358 keyed 家自然蒸馏
- 已在 implement 家发生。缺点:滞后一次执行;间隔 <6h 的执行永远等下一次;某岗位最后一次执行(或长期没派发)永远不蒸馏;phase2 在 runner 进程里跑,runner 收尾就把它打断(实证);Codex 不写日志,我们不知道它为什么没跑(eng_design 家)。
- 结论:作为基线保留,不够。

### O2 收尾蒸馏通道(v1 推荐,R1 评审后否决)
执行收尾、daemon 还活着、goal 已终态时,在同一 daemon 上 `thread/start` 一条**蒸馏触发线程**,带 per-thread 配置覆盖(`thread/start.config` 走与 `-c` 同一条 dotted-path 合并:`app-server/src/config_manager.rs:186-230` → `config/src/overrides.rs:18-22`):
- `memories.min_rollout_idle_hours=0`、`memories.max_rollouts_per_startup=N`(本家待蒸馏积压上限),
- `memories.generate_memories=false`(触发线程自身 `memory_mode=disabled`,永不成为候选,`config/src/types.rs:297`),
- 不设 `ephemeral`(否则 `start.rs:33` 直接跳过)。
然后 `turn/start` 一条最小输入,轮询 `memories_1.sqlite` 的 `jobs` 直到没有 `running` 行或到预算上限,再走原来的 `runtime.stop()`。
- 覆盖:本次执行的线程当场蒸馏(stage1 落 DB,持久);phase2 若在 6h 冷却内被跳过,则由下一次任何根会话启动(runner 自己的 turn/start,或下一次收尾通道)补齐;进程活到任务结束,不再打断 phase2。
- ~~只在本执行是该家唯一 lease 时把闲置阈值降到 0~~ **否决理由(R1 #1/#2)**:Codex 把闲置下限钳在 1 小时,收尾时本次线程不可能被 claim;lease 计数也只是瞬时观察。收尾通道能做的只剩「蒸馏上一次」,而这在准入时做效果更好(首轮就能读到),见 O3。
- 限额守卫保持 Codex 默认 25%(那是给 founder 账号的保护),但把**前后 jobs 快照差**写成一条结构化回执,eng_design 家那种「静默没跑」从此可见。

### O3 准入时蒸馏通道(v2 推荐)
在下一次执行准入(daemon 已起、runner 自己的线程还没建)跑通道:先用本家 `state_5.sqlite` 自己算候选(≥1h 闲置、≤10 天、未蒸馏的根线程),没有候选就零成本跳过;有候选才起触发线程(闲置覆盖=1h,即 Codex 下限),等本 worker 的 stage1(+phase2 若被 claim)结束再建 runner 线程。优点:上一次的 stage1 摘要一定在这一次首轮之前落库;若该家上次 phase2 成功已过 6h 冷却,phase2 也在通道内完成,这一次首轮就能读到(否则下一次);不依赖 lease 计数。缺点:有候选时派发多 1–3 分钟;某岗位「最后一次执行」要等该岗位下次派发才蒸馏。v1 曾以「首轮延迟不值得」否决它,R1 的 1h 下限事实反转了这个权衡:收尾通道同样只能蒸馏上一次,却拿不到首轮可读的好处。

### O4 开 `dedicated_tools=true` 让模型能当场记笔记
配置项存在、2359 白名单已收 `extensions/ad_hoc/notes/*.md`。但每轮多 4 个工具、模型写的笔记无审阅、并与后台蒸馏并存产生两套真相。**不默认开**;作为 founder 可选开关列出,本单不实现。

### O5 单独用 `codex exec` 子进程做通道(实验用法)
实验证明可行,但 exec 在 turn 结束即退出,要靠 `sleep` 保活才等得到 phase2,是 hack;还要复制 daemon 的 sandbox/approval/effort argv 拼装。**否决**,保留为 QA 手工取证手法。

### O6 旧家一次性回填(288 个 (flywheel,implement) 旧家)
机制同实验(覆盖 `max_rollout_age_days`),每家约 95s、一次 stage1 输入 ≈ 上下文 70%(10–15 万 token)⇒ 288 家 ≈ 8 小时串行、数千万 token 输入,吃 founder 账号额度;且必须在 FLY-2359 首次 seed **之前**做才有意义(manifest 一旦写就不重扫)。写入的是生产旧家,越过本单「旧家零写入」边界。**交 founder 决定,本单不做**;若做,应是独立单。

### O7 替代路线:runner 收尾按我们模板显式蒸馏
只有在 Codex 侧不可用时才需要;实验证明可用。**不采用**,仅作 fail-safe 记录。

## 4. 边界与不做

- 不改 FLY-2359 的运输/种回逻辑(它只管 legacy 家 → keyed 家的首次快照)。
- 不改 Codex 二进制、不改 `[features]`/`[memories]` 的家级 config(全部用 per-thread 覆盖)。
- 不动生产旧家;本单实验只在 scratchpad 拷贝上做,529 房的真机证据交 QA。
- `codex exec` 来源不进白名单的问题(Claude Code 的 Codex 评审会话永不蒸馏)是副产品,不在本单处理。

## 5. 待 Lead/founder 决定(非阻塞,已按默认继续)

1. O6 旧家回填要不要做、做多少(默认:不做)。
2. O4 `dedicated_tools` 是否开(默认:不开)。
3. 通道预算上限(默认:等待 ≤ 5 分钟;超时不阻塞,只记回执)。
4. (R1 后新增,question b24705c1)准入时触发的口径,以及 E4 从「retire → seed」改为「同一 keyed 家下一次执行首轮读到」——FLY-2358 之后有身份的新任务全部进 keyed 家,legacy → seed 链没有自然人口。
