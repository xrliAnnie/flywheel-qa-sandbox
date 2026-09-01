# FLY-2241 MCP 工具 schema 的 token 开销 — 调研(实测数据)

Issue: FLY-2241 (https://linear.app/geoforge3d/issue/FLY-2241/成本测量-量一次工具-schema-到底吃掉多少-token-静态可测不需要先建计量体系)
日期: 2026-09-01
基于: exploration.md

## 0. 测量条件(可复跑)

- Claude Code **2.1.257**,codex-cli **0.152.0**,2026-09-01。
- 每臂:`claude -p --strict-mcp-config --mcp-config <cfg> --settings '{"env":{"ENABLE_TOOL_SEARCH":"on|off"}}'
  --output-format json --no-session-persistence --model haiku --debug api --debug-file <log>
  "reply with exactly: OK"`,cwd 为一次性空目录。
- 读数:`usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens`。
- 工具数:debug 日志 `Dynamic tool loading: 0/N deferred tools included` 的 N,减去基线 19。
- 脚本:同目录 `measure.sh` / `run-matrix.sh`;配置:`cfg/*.json`(secret 已脱敏);原始输出:`raw-results.tsv`。

**复跑方式**:`./run-matrix.sh`(约 12 分钟,20 臂)。换了 MCP 配置后重新生成 `cfg/*.json` 再跑即可。

⚠️ **复跑前必做一步**:凡是 `cfg/*.json` 里出现 `${VAR}` 占位符的 server(现在是
`linear-api` 的 `Bearer ${LINEAR_API_KEY}`、`context7` 的 `${CONTEXT7_API_KEY:-}`),
必须先确认那个 VAR 在**探针进程**里也存在,否则该 server 连不上,会被静默测成 0 个工具。
Lead 的这些 env 由 `claude-lead.sh` 经 tmux `-e` 注入,不在 runner 环境里;
取法:`ps eww -o command= -p $(pgrep -f "claude --agent flywheel-eng-lead" | head -1)`。
本轮的 `*-auth` 臂就是这样补测的(见 §2)。

### 噪声与交叉验证

| 检验 | 结果 |
|---|---|
| 基线重复跑(`base` vs `base2`) | 25336 vs 25338(惰性开)、40397 vs 40399(惰性关)⇒ **噪声 ±2 token** |
| 加法性:runner 分臂之和 vs 合臂 | 14,732 + 8,190 = 22,922,合臂实测 22,922 ⇒ **完全一致** |
| 加法性:Lead 分臂之和 vs 合臂(linear-api 已认证) | 34,370 vs 34,338 ⇒ 差 32(0.09%) |
| 加法性:Runner 分臂之和 vs 合臂(linear-api 已认证) | 44,346 vs 44,296 ⇒ 差 50(0.11%) |
| 工具数:`Dynamic tool loading` 差分 vs 直连 MCP `tools/list` | gbrain 30/30、flywheel-terminal 6/6、flywheel-inbox 2/2、playwright 24/24 ⇒ **四个 server 全部吻合**(`tools-list.js`) |

## 1. 基线:零 MCP server

| 惰性加载 | 总输入 token |
|---|---|
| 开(生产实际) | **25,336** |
| 关 | **40,397** |

⇒ Claude Code **自带的 19 个可延迟内置工具**(WebFetch / WebSearch / SendMessage /
Monitor / Cron* / NotebookEdit / …)全量内联要 **15,061 token**。
这一块比我们**所有 MCP server 加起来还大**,而且同样已被惰性加载省掉。

## 2. 按 server 拆开

schema token = 该臂(惰性关) − 40,397;惰性名单 token = 该臂(惰性开) − 25,336。

| server | 挂在哪 | 工具数 | **schema token(全量内联)** | tok/工具 | 惰性名单 token | tools/list 字节 |
|---|---|---|---|---|---|---|
| `xiaohongshu-mcp` | Lead + Runner | 16 | **8,209** | 513 | 292 | — |
| `claude-in-chrome` | Runner | 22 | **8,190** | 372 | 1,692 | — |
| `playwright`(plugin) | Runner | 24 | **4,580** | 191 | 242 | 18,502 |
| `gbrain` | Lead | 30 | **2,469** | 82 | 311 | 6,923 |
| `context7`(plugin) | Runner | 5 | **1,955** | 391 | 224 | — |
| `flywheel-terminal` | Lead | 6 | **1,904** | 317 | 96 | 6,530 |
| `flywheel-inbox` | Lead | 2 | **376** | 188 | 48 | 1,166 |
| **`linear-api`(已认证 = Lead 生产实态)** | Lead | **57** | **21,412** | 376 | 765 | — |
| `linear-api`(未认证 = Runner 生产实态) | Runner | 0 | 4 | — | 191 | — |
| `lead_actions` | Codex Lead | 2 | 未测(见 §5) | — | — | 1,110 |

**`linear-api` 在 Lead 里是活的,在 Runner 里是死的 —— 而且这不是偶然。**

两处配置(Lead `.mcp.json` 与 user-scope `~/.claude.json`)都写的是
`"Authorization": "Bearer ${LINEAR_API_KEY}"` —— 一个 **env 占位符**。
`claude-lead.sh` 用 `lib/mcp-inherit.sh` 的 `list_required_envs` 把它扫出来,
经 `tmux new-window -e` 显式塞进 Lead 会话(该函数的注释就是为这件事写的)。
**Runner 的启动路径没有这一步**,占位符展开成空 Bearer ⇒ 401。

实测证据(不是推断):

| | Lead transcript(最近 20 个文件) | Runner transcript(最近 30 个文件) |
|---|---|---|
| 成功的 `mcp__linear-api__*` tool_use | **406 行** | **0 行** |
| auth 拒绝行 | 0 | **68 行** |

⇒ 表里必须分两行记:**Lead 侧 57 个工具 / 21,412 token(单个最大的 server)**,
Runner 侧 0 个工具。

> ⚠️ 这一条是本轮**自我更正**的结果。第一版探针没有 `LINEAR_API_KEY`
> (runner 环境本来就没有),于是把 Lead 的 linear-api 也测成了 0 —— 相当于把
> Lead 的工具数低估了一半(54 → 111)、schema 成本低估了 62%(12,930 → 34,338)。
> 更正办法:从在飞 Lead 进程 `ps eww` 取到该 env 后重测(`*-auth` 臂)。
> **教训:探针进程的 env ≠ 被测会话的 env;凡是配置里出现 `${VAR}` 的 server,
> 复跑前必须先确认那个 VAR 在探针里也在。**

**最肥的是第三方**:`xiaohongshu-mcp` 16 个工具吃 8,209 token(513 tok/工具),
`context7` 5 个工具吃 1,955(391 tok/工具)。我们自研的 `gbrain` 30 个工具只吃 2,469
(82 tok/工具)。这与 Uber「第三方 SaaS server 最肥」的观察方向一致,但**量级差一个数量级**。

## 3. 按会话类型汇总

| 会话类型 | MCP server | 工具数 | **全量内联** | **实际(惰性开)** | 节省 |
|---|---|---|---|---|---|
| **Claude Lead**(生产实态) | gbrain, flywheel-terminal, flywheel-inbox, xiaohongshu-mcp, **linear-api(活)** | **111** | **34,338** | **1,480** | 95.7% |
| **Claude Runner**(生产实态) | xiaohongshu-mcp, context7, playwright, claude-in-chrome, linear-api(死) | 67 | **22,922** | **2,591** | 88.7% |
| Runner 反事实:若 linear-api 修好 | 同上 + linear-api(活) | **124** | **44,296** | 3,131 | 92.9% |
| Runner 去掉 claude-in-chrome | — | 45 | 14,732 | 933 | 93.7% |
| **Codex Lead** | lead_actions | **2** | 未测(auth 阻塞) | — | — |

合臂实测原值:
- Lead(已认证):惰性关 74,735 / 惰性开 26,816
- Runner(生产实态,linear 死):惰性关 63,319 / 惰性开 27,927
- Runner(反事实,linear 活):惰性关 84,693 / 惰性开 28,467

## 4. 占每请求输入 token 的比例

分母取**真实在飞会话**的每请求总输入 token(`reqstats.py`,读
`~/.claude/projects/*/*.jsonl` 的 `usage`,只统计 >1000 token 的请求):

| 会话 | 样本 | 中位数 | 均值 | p10 | p90 |
|---|---|---|---|---|---|
| Lead `flywheel-eng-lead` | 22,006 请求 / 6 文件 | **595,358** | 584,263 | 262,620 | 899,874 |
| Lead `flywheel-cos-lead` | 4,526 请求 / 6 文件 | 447,422 | 440,065 | 183,545 | 681,677 |
| Runner(flywheel worktree) | 6,694 请求 / 25 文件 | **233,806** | 280,029 | 105,560 | 500,982 |

| 会话类型 | schema 全量内联占比 | **实际占比(惰性开)** |
|---|---|---|
| Claude Lead(生产实态) | 34,338 / 595,358 = **5.77%** | 1,480 / 595,358 = **0.25%** |
| Claude Runner(生产实态) | 22,922 / 233,806 = **9.80%** | 2,591 / 233,806 = **1.11%** |
| Runner 反事实(linear 修好) | 44,296 / 233,806 = **18.9%** | 3,131 / 233,806 = **1.34%** |

若惰性加载失效,还要再叠加 §1 那 **15,061 token** 的内置可延迟工具:
Lead 变成 49,399 token/请求(占 8.3%),Runner 反事实变成 59,357(占 25.4%)。

## 5. 明确的空白(未测到的部分)

1. **Codex 侧 token 探针没跑成。** 归因经两轮更正,以下为最终版:
   - 我在 20:47–20:52 逐个 profile 实测,看到 `school` / `business` / `personal1` /
     `personal2` 全是 `refresh_token_reused`。**真因不是 auth 本身坏了** —— 是当天 19:25
     的一次额度探针把 `school` 的 refresh 世系轮转进了一个 /tmp 临时家,
     global/pool 留在已用过的旧串上。该问题已于 **20:53Z 修好**
     (世系搬回 global+pool,实测 `codex exec` HEAL_OK)。
   - `personal` 的 auth 正常,但额度耗尽到 **2026-09-06 7:29 PM**(这半属实)。
   - ⇒ **既不需要 founder relogin,也不需要等 9/6**;codex 现在就能跑。
     我的逐号测试跑在 20:53Z 修复之前,所以当时得出的「9/6 前 codex 全不可用」**不成立**。
   - ⇒ 但本轮测量窗口落在修复之前,所以 Codex 的**每请求输入 token 绝对值**和
     **`lead_actions` 的 Codex-tokenizer schema 成本**两项**没有数字**。
   已拿到的替代证据:`lead_actions` 只有 **2 个工具**(`discord_send`, `ack_batch`),
   `tools/list` 序列化 **1,110 字节**(隔离探针实测,`cfg/lead-actions-iso.json`);
   生产 rollout 里的每请求 `last_token_usage.input_tokens` 中位数量级为 9–11 万。
   按 1,110 字节的体量,这在结构上不可能构成问题。
2. **Codex exec runner(账号 profile home)未测**。`~/.codex-247*/.codex-248*/.codex-267*`
   等 7 个 home 各挂 5 个 server(`chrome-devtools, pencil, linear, myco, xiaohongshu`),
   同样受 auth 阻塞。这是 Codex 侧唯一可能有量的面,**明确留白**。
3. `xiaohongshu-mcp` / `context7` / `claude-in-chrome` / `linear-api` 的 `tools/list` 字节数未取到
   (HTTP MCP 需要 session 握手,尝试两次未成)—— 不影响 token 结论,token 是直接测的。
