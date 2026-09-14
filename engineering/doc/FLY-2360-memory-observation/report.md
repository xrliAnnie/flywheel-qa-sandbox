# FLY-2360 常驻 Lead 记忆一周观测 + 节流闸诊断 — 诊断报告
Issue: FLY-2360 (https://linear.app/geoforge3d/issue/FLY-2360/2355d-一周观测-节流闸诊断a-上线一周后读三个-lead-家-memories-读数为空才逐道排查四道闸先量出哪一道在拦只调那一道)
日期: 2026-09-14
基于: engineering/doc/FLY-2119-codex-identity-memory/prd.md(§5.1 / §5.6.3,分支 flywheel-FLY-2119)、engineering/doc/FLY-2357-lead-memory-pins/implementation-evidence.md

> 本单只读:没有写任何 Lead 家、没有改配置、没有重启进程。所有 sqlite 查询都在 scratchpad 里的**拷贝**上做。
> 观测时刻:2026-09-14 09:11Z。A(FLY-2357,PR #1095)合入 2026-09-05 22:39Z,窗口 ≈ 8.4 天。

## 一句话结论

**三个目标家的 `rollout_summaries/` 全部为空。但四道节流闸里没有任何一道是「调了就能出记忆」的那一道 —— 不建议调任何一道闸,本单不开 simple_code 子单。**

- **Mufasa**:管线真的在跑(过了额度闸、phase2 跑过 3 次),phase1 每次候选数都是 **0**。真正拦住的是 Codex 源码里的**第五个条件:「排除当前线程」**(`threads.id != current_thread_id`)。Mufasa 这个 Lead 的全部对话都在**同一条长线程**里(2026-06-09 创建,至今在用),而 memory startup 恰恰是在这条线程的 turn 里触发的 ⇒ 这条线程**永远被排除**;其余线程最新一条停在 08-20,早已超过 10 天。
- **Infra Bot**:A 之后**一次 memory startup 都没发生过** —— Codex Infra Bot Lead 自 A 上线后没有任何 turn(最后线程活动 08-23),launchd 现在是崩溃循环(`identity_command_invalid: Unknown option '--include-capabilities'`)。这是「Lead 没在跑」,不是闸的问题,**本单无从诊断闸**。
- **Raya**:`~/.codex-raya` 不存在(与 FLY-2357 证据一致:尚未首次 activation)。无读数。

## ① 三个家的 memories/ 读数

目标名单按 FLY-2357 的 Lead 裁定:**Raya · Infra Bot · Mufasa**(PRD §5.1 原写的 Honey Lemon 已被裁出,`~/.codex-honeylemon` 是 FLY-1911 voice-avatar 家,无 memory 开关,不在本单)。

`find ~ -maxdepth 2 -type d -name memories -path '*/.codex*' | sort`:

```
/Users/xiaorongli/.codex-mufasa/memories
/Users/xiaorongli/.codex/memories
```

| 家 | memories/ | rollout_summaries/ | 其它文件 | memories_1.sqlite |
|---|---|---|---|---|
| `~/.codex-mufasa` | ✅ 存在(birth 09-06 07:09Z) | **空**(0 文件) | `MEMORY.md` 107B · `memory_summary.md` 495B(09-12 17:17Z,phase2 零输入写出的骨架)· `raw_memories.md` 37B(最后 09-13 18:00Z) | `stage1_outputs`=0 行;`jobs` 只有 1 行 `memory_consolidate_global=done`,**无任何 `memory_stage1` 行** |
| `~/.codex-infra-bot` | ❌ 不存在 | — | — | `jobs`=0、`stage1_outputs`=0,文件 mtime 停在 09-07 |
| `~/.codex-raya` | ❌ 家不存在 | — | — | — |
| 对照组 `~/.codex`(founder 本人,非目标) | ✅ | 116 文件 | `MEMORY.md` 336KB | `stage1_outputs`=125,`memory_stage1 done`=995,最近产出 09-13 22:56Z |

样例条目摘要:三个目标家**没有任何条目可摘**(Mufasa 的三个文件只是 phase2 在零输入下写出的空骨架;内容未展开引用,Mufasa 是 founder 私人陪练家)。对照组证明**同一台机器上的 Codex memory 管线本身是能产出的**。

两个目标家的 pin 均已落盘(`[features] memories = true` + `[memories] dedicated_tools = true`,四道闸与 `disable_on_external_context` 均未写 ⇒ 全是默认值):Mufasa `config.toml` mtime 09-13 21:38Z,launcher 日志有 `home OK (full-access)` + `§10 config gate PASSED` + `daemon OK`;Infra Bot `config.toml` mtime 09-07 07:04Z。

## ② 逐道排查(只测不调)

### 管线判据(读的是源码,再用生产二进制核)

- 源码:本机 `~/Dev/codex-oss`(HEAD `49025589`,2026-07-28)。生产是 **0.154.0**,所以关键 SQL 片段又在 `~/.codex-mufasa/.../0.154.0-aarch64-apple-darwin/bin/codex` 里 `strings` 核过,**原文存在**:
  `AND threads.memory_mode = 'enabled' AND threads.id != … AND threads.updated_at_ms … ORDER BY threads.updated_at_ms DESC LIMIT`
- memory startup 的顺序:**额度闸**(`memories/write/src/guard.rs`,拦了会打 INFO 日志)→ **phase1 选候选**(`state/src/runtime/memories.rs::claim_stage1_jobs_for_startup`)→ phase2 合并。
- phase1 候选 = `threads` 里同时满足:未归档 + 交互式来源 + `memory_mode='enabled'` + **`id != 当前线程`** + `updated_at ≥ now-max_rollout_age_days` + `updated_at ≤ now-min_rollout_idle_hours`;按 `updated_at DESC` 扫至多 5000 行,claim 至多 `max_rollouts_per_startup` 个(`phase1.rs:166-175`)。
- 默认值(`config/src/types.rs:46-49`):2 / 10 天 / 6 小时 / 25%。
- `context.thread_id()` = 触发 startup 的那个会话的线程 id。日志实证:09-13 00:00:26Z 的 `Phase 2 no changes` 与主线程 `019eaf5d` 的 `turn/start` 同一秒,即 **startup 由 Lead 主线程自己的 turn 触发**。

### Mufasa 四道闸逐道读数

| 闸 | 默认 | 实测 | 是否在拦 |
|---|---|---|---|
| `min_rate_limit_remaining_percent` | 25 | 日志 45 次 `skipping memories startup because Codex rate limits are below the configured threshold`:09-06 6 次、09-07 39 次(最后 09-07 00:37Z)。**09-12 起没再出现**;09-12 17:16Z / 09-13 00:00Z / 09-13 18:00Z 三次 startup 都跑到了 phase2 | **前两天拦过,之后没拦**。它不是今天为空的原因 |
| `max_rollout_age_days` | 10 | 除主线程外 180 条线程,最新一条 `updated_at` = **08-20 08:35Z**;在上面每个 startup 时刻,「排除当前线程后在 10 天内」的线程数都是 **0** | 在拦**旧线程**(08-20 及以前) |
| `min_rollout_idle_hours` | 6 | 主线程在 A 之后确有 ≥6h 静置窗口(09-06 14.3h、09-07 11.4h、09-07→09-12 118.3h、09-13 6.0h)| **形式上不起作用**:唯一够新的线程已被「排除当前线程」先挡掉 |
| `max_rollouts_per_startup` | 2 | 每次候选数 0 | **不在拦**(0 个候选,上限 2 还是 200 都一样) |
| (源码第五条件)`threads.id != current_thread_id` | — | 主线程 `019eaf5d` 自 06-09 创建一直在用,也是每次 startup 的发起者 | **这才是结构性的拦截点** |

每个 startup 时刻的候选数(对 state_5.sqlite 拷贝逐条套用上面的 WHERE):

```
startup@2026-09-06 07:09:39Z  候选(四闸全过+排除当前线程)=0  10天内非当前线程=0
startup@2026-09-12 17:16:34Z  候选=0  10天内非当前线程=0
startup@2026-09-13 00:00:26Z  候选=0  10天内非当前线程=0
startup@2026-09-13 18:00:56Z  候选=0  10天内非当前线程=0
now    2026-09-14 09:00:00Z   候选=0  10天内非当前线程=0
```

### 反事实:如果真去调某一道闸会怎样

- 调 `max_rollouts_per_startup`(2→16):0 个候选,**零效果**。PRD §5.6.3 预言的「看起来像是做了事」的情形。
- 调 `min_rollout_idle_hours`(6→1):主线程仍被「当前线程」排除,**零效果**。
- 调 `min_rate_limit_remaining_percent`(25→更低):09-12 之后它本就没拦,**零效果**,且拆额度保护。
- 调 `max_rollout_age_days`(10→40):会一次性吃进 08-20 之前那批 160 条旧线程(每次 startup 2 条)——那是八月里这个家跑过的历史会话,**不是 Mufasa Lead 正在进行的对话**;吃完就又归零。它产出的是一堆旧记忆,不是「Lead 开始记事」。**不推荐。**

### Infra Bot

- `threads` 236 条,最新 `updated_at` = **08-23 15:24Z**(全部集中在 2026-W33);A 合入之后**零新线程、零 turn**。
- `logs_2.sqlite` 覆盖 08-28 → **09-08 19:35Z**,其中 **0 条** `memories/*` 日志(无额度跳过、无 phase2);`memories_1.sqlite` jobs 表为空。
- launchd `com.flywheel.lead.flywheel-codex-infra-bot-lead` 当前 `-  1`(无 PID、上次退出码 1),`/tmp/flywheel-lead-flywheel-codex-infra-bot-lead.log` 每 30 秒一条:`{"ok":false,"code":"identity_command_invalid","message":"Unknown option '--include-capabilities'"}`;更早一段是 `[link-truth] … state=refused reason=lead-job-running`。同时 Claude 版 Infra Bot(`flywheel-claude-infra-bot-lead`)在跑。
- ⇒ **没有任何 memory startup 可以观测,闸无从量起。** 就算它在跑,它的形态(W33 那周 107 vscode + 28 exec + 子代理,多线程)也和 Mufasa 不同,不能把 Mufasa 的结论直接套过去。

## ③ 建议(不执行)

1. **四道闸一律不调。** 判据:在每个已发生的 startup 时刻,把四道闸放到「任意宽」都得不到 Mufasa 当前对话的候选;唯一有产出的调法(拉长 age)产出的是旧会话,不是 PRD §5.1 要的东西。按 issue 规则,**不开 simple_code 子单**。
2. **需要 Lead 裁定的真问题(建议另开设计单,不是配置单)**:Codex memory 只蒸馏「别的、已静置的」线程,而常驻 TUI Lead 是**单条永不结束的线程**。要让常驻 Lead 攒出记忆,方向只能是改变线程形态(例如按周期/按话题轮换到新线程,让旧线程变成「非当前 + 已静置 + 10 天内」的合格候选),或者接受「常驻 Lead 不走 Codex 自动记忆」。这属于 Lead runtime 设计,超出本单只读边界。
   - 量法(给后续单用):每个 startup 时刻跑本报告里的候选数 SQL;轮换后应看到 `10天内非当前线程 ≥ 1` 且 `memory_stage1` 行出现。
3. **Infra Bot 崩溃循环是独立事故**,与记忆无关:`identity_command_invalid: Unknown option '--include-capabilities'`。建议 Lead 按告警流程另派;修好之后才有资格重开它的一周观测。
4. **Raya**:首次 activation 之后再算观测起点。
5. ⛔ `disable_on_external_context` 保持 false,未触碰。

## 方法与可复现命令

```sh
find ~ -maxdepth 2 -type d -name memories -path '*/.codex*' | sort
# DB 一律先拷贝再查(WAL 家用 mode=ro 打不开)
cp -p ~/.codex-mufasa/{memories_1,state_5,logs_2}.sqlite* "$SCRATCH/"
sqlite3 memories_1.sqlite "select kind,status,count(*) from jobs group by 1,2; select count(*) from stage1_outputs;"
sqlite3 logs_2.sqlite "select date(ts,'unixepoch'),count(*) from logs where file like 'memories/write/src/guard.rs%' group by 1;"
# 某 startup 时刻 T 的候选数(MAIN = 发起 startup 的线程)
sqlite3 state_5.sqlite "select count(*) from threads where archived=0 and memory_mode='enabled' and id!='$MAIN'
  and updated_at_ms >= (strftime('%s','$T')-10*86400)*1000 and updated_at_ms <= (strftime('%s','$T')-6*3600)*1000;"
strings -n 6 <0.154.0 codex binary> | grep "AND threads.id != "
```

## 已知边界

- 源码读的是 07-28 的 codex-oss,生产 0.154.0 只用二进制字符串核了 SQL 片段,没有逐行对齐调用链;「startup 由当前会话 turn 触发、排除的是该会话线程」由 09-13 00:00:26Z 日志同秒事件佐证,不是 0.154 源码直读。
- `allowed_sources` 是否包含 `vscode` 未单独核实;对结论无影响(主线程无论如何被「当前线程」排除,其余线程无论来源都已超 10 天)。
- Mufasa 额度闸在 09-07 00:37Z 之后到 09-12 之间没有日志,是因为那段主线程没有 turn(118h 静置),不是额度恢复的直接读数;09-12 起 phase2 能跑,才证明额度闸已放行。
- Infra Bot 崩溃循环的起始日期未精确定位(wrapper 日志只有时分秒);`logs_2.sqlite` 最后一行 09-08 19:35Z 是它最后一次有 Codex 活动的上界。
