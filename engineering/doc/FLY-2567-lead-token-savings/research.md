# FLY-2567 Lead token 节省 — 调研
Issue: FLY-2567 (https://linear.app/geoforge3d/issue/FLY-2567/leadtoken-常驻-lead-一天烧-40-亿缓存读-token从lead-为什么这么耗的目标出发做设计找出并砍掉主要浪费源lead)
日期: 2026-09-14
基于: exploration.md

## 1. 数据口径与可复核证据

- 原始来源：`~/.claude/projects/-Users-xiaorongli--flywheel-lead-workspace-flywheel-eng-lead/c0058bba-296f-4832-ac37-38b49a2cd30b.jsonl`；已扫描最近会话文件，三天匹配数据均在本文件；main Lead 账本，不包含另起 subagent 的账单。
- 固定窗口：UTC 2026-09-12 00:00:00 至 2026-09-15 00:00:00（右端不含）。原 issue 的日期实际匹配 UTC；不要与现有 token-report 默认 America/Los_Angeles 混用。
- `evidence/summary.json` 保存固定文件前缀字节数、SHA-256、原始/唯一请求合计；`requests.csv` 保存逐请求 requestId、messageId、源输入 UUID、原始行号、usage 与工具集合。`inputs.json` 保存来源类型、事件 seq、batch_id、Bootstrap questionId，**不保存消息正文或凭证**。
- 按 requestId 去重；没有 requestId 时才使用 message.id，再回退 uuid。本日所有重复组 usage 一致，冲突数 0；跟现有 `packages/token-usage/src/scanner.ts:99-102,135-152` 的 requestId 去重一致。fallback 不足以证明 provider 计费，新增冲突必须显式报错/标为未知，不能悄悄取小值。
- 源类型通过 parentUuid 祖先追溯到最近非 tool_result 用户输入；一个输入可包含多个 mailbox 消息。混合保留 mixed，不按字符比例虚构 token 分配。usage 是处理该来源的**整次请求上下文成本**，不是这条消息自身 token 数，也不是删掉消息必然能省的因果量。本日未解析祖先请求为 0。
- 只统计 transcript 中可见模型调用；压缩/内部调用若未记录 usage 无法补造，复测须同时报告 provider/系统隐藏成本观测缺口。

### 三日原账本对齐

| UTC 日 | 原始 usage 行 | 原始缓存读 | 唯一请求 | 去重缓存读 |
|---|---:|---:|---:|---:|
| 2026-09-12 | 1,431 | 839,697,801 | 418 | 170,239,545 |
| 2026-09-13 | 2,117 | 1,308,540,917 | 812 | 496,136,391 |
| 2026-09-14 | 6,668 | 3,974,850,298 | 2,663 | 1,553,141,091 |

9/14 去重 cache_write=9,480,456、uncached_input=60,716、output=2,045,664。平均输入 `(read+write+input)/2662` = 587,033 token（缓存读单项均值 583,449）。同一请求的重复行不是独立“轮”。例如 `req_011Cf4AomcL43Uk7gCvXq97P`，原文件 42462–42672 行含 104 个块，每块重复 749,701 cache_read。

### 9/14 按输入来源的完整分解（互斥，可加总）

| 来源（代码标签） | 非合成请求 | 缓存读 token | 占比 |
|---|---:|---:|---:|
| runner_ask | 891 | 503,649,810 | 32.43% |
| mixed_without_founder | 514 | 312,712,692 | 20.13% |
| summary_due | 10 | 4,212,985 | 0.27% |
| self_schedule | 53 | 29,307,942 | 1.89% |
| stage_changed | 169 | 99,454,118 | 6.40% |
| session_started | 37 | 22,803,441 | 1.47% |
| workflow_claim_recorded | 4 | 2,516,553 | 0.16% |
| runner_report | 167 | 98,617,053 | 6.35% |
| other_mailbox | 195 | 111,672,236 | 7.19% |
| gate_question | 86 | 50,445,550 | 3.25% |
| founder | 121 | 89,964,744 | 5.79% |
| mixed_with_founder | 198 | 120,657,753 | 7.77% |
| workflow_replacement_eligibility | 31 | 23,392,819 | 1.51% |
| task_notification | 43 | 28,009,442 | 1.80% |
| compact_summary | 78 | 15,401,063 | 0.99% |
| bootstrap | 2 | 386,769 | 0.02% |
| other_input | 63 | 39,936,121 | 2.57% |

其中 mixed_with_founder 全部视为受保护输入；不能把其中例行事件的处理成本归成“founder 可优化掉”。other_mailbox 包含其他源，未证明都为 #core bot chatter，因此不报跨 Lead 讨论的精确浪费值。

### 第二个观察维度：工具调用（与来源维度不可相加）

| 请求内工具集合 | 请求 | 缓存读 |
|---|---:|---:|
| 仅 ACK | 412 | 241,327,898 |
| ACK + 其他工具 | 396 | 241,233,858 |
| 其他工具 | 1,008 | 564,498,669 |
| 无工具（含结尾答复） | 846 | 506,080,666 |

1519 次 Bash，2007 次 ACK。包含 FOLLOWUPS.md 操作的 452 个请求关联 282,716,461；未按全文扫描 vs 更新精确分出因果收益。保留计数作为后续同口径 before/after，禁止宣称全部能省。

## 2. Bootstrap 的真实问题

9/14 的五份渲染快照：

| 原行 | 正文字符 | 被标为 ASK 的条目 | DONE 开头（仅描述，不作状态判据） |
|---|---:|---:|---:|
| 22624 | 78,348 | 202 | 195 |
| 27484 | 43,218 | 108 | 104 |
| 31766 | 70,554 | 170 | 164 |
| 36308 | 69,607 | 181 | 176 |
| 39777 | 84,081 | 215 | 204 |

总计 345,808 字符；876 次条目展示、455 个唯一 questionId。随后一个只读 CommDB 事务看到其中 397 个 `kind=report`、2 个其他问题、56 个当前缺失（可能已归档）。397 中 321 terminal_disposed、76 protected。此时状态**不能回推到投递当时**，不能声称“当时 321 已答仍投”。证据是 renderer 无条件加 `[ASK]`，且 generator 只跳过特定 runner-stop report，导致其他真实 report 被错误显示。

`db.ts:3971-3983` 已排除持久 response / terminal_disposed；不要再加同样的 NOT EXISTS 作为修复。`listAttentionQuestions` 现有分页是 project 级、过滤 review gates、折叠 kind，不能直接当成 Lead 所有恢复义务分页。新 Bootstrap 分页应复用查询和游标方式，保留自身 to_agent / gate presentation / kind 语义。

## 3. 已有生产链路与消费者

- `EventFilter.ts` 只作优先级标注；`event-route.ts:3630-3684` 在 stage 副作用后 append / dispatch。`HeartbeatService`、`DirectEventSink`、`runtime-registry.ts:96-118` 和 `lead-inbox-runtime.ts:374-407` 重驱动必须共用同一持久投递选择。
- `mailbox-lead-runtime.ts:142-167` 用 Date.now() 生成 bootstrap 身份；`commdb-lead-runtime.ts:77-80` 每次新 instruction。`plugin.ts:4703-4748` POST 没有恢复调用身份；`claude-lead.sh:1551` startup 和 `post-compact-bootstrap.sh` 都触发恢复。五份不同时间快照不是同恢复三次的证明。
- `inbox-mcp/src/index.ts:83-106` 的 ACK queued 表示 protocol row 已插入；`protocol-ingress.ts:57-75` 才做效果。`lead-inbox-loop.ts:249-317` 先 expiry 后 protocol；`mailbox-queue.ts:2159-2168` 过期清 batch_id，晚消费变 ack_late_noop。要覆盖同一事务边界，不能只调两个 await 的顺序。
- batch transport 身份 `${batch_id}#r${lease_retry_count}`；全体成员必须属于 ACK 的 from_agent。confirmed delivery 未 ACK 重排会产生新 batch。未知/跨 Lead ACK 不得确认。
- `discord-chat-ingest.ts:133-191` 以 leadId + Discord messageId 固定交付身份；founder 用配置 author ID 判断、priority=1；正文、附件、来源 channel、reply route 保持。队列禁止混用 Discord 路由和其他批次。
- #core 当前插件已有 mention/reply/allowlisted bot 和 roundtable 分支。未验证 active fork 对应关系；本单先不改 Discord admission。

## 4. 规则与原生压缩能力

当前 active bundle 的观测时间、18 个源文件的 byte/char/hash 见 `rules-inventory.json`；其生成时间为 9/15 00:41Z，不冒充 9/14 每轮 exact bytes。runner-patrol-rules 79,335 bytes；department-lead-rules 40,511 bytes；founder-only-authority 46,576 bytes。18 个文件合为一次 append-system-prompt，禁止重现 legacy last-one-wins 多参数错误。没有可靠 provider token 分项，字符数不能当 token。

官方文档确认 `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` 和 `--autocompact 200k` 是原生设置；窗口是何时整理历史，**不是另一个模型档位**。环境变量优先级更高；状态栏仍按模型全窗口显示，不能拿百分比验证。来源：[环境变量](https://code.claude.com/docs/en/env-vars)、[模型与压缩配置](https://code.claude.com/docs/en/model-config)（2026-09-15 UTC 查阅）。当前 CLI 2.1.272 help 有该 flag；事故 transcript 为 2.1.270，需要 QA 固定版本实际演练。原生 1M 模型不妨碍提前整理。不要依赖未验证的百分比偏方。

## 5. 验证命令与限制

```sh
python3 engineering/doc/FLY-2567-lead-token-savings/analyze-transcript.py "$TRANSCRIPT" --bytes <summary.json.prefix_bytes> --out /tmp/fly2567-replay
```

对比输出 SHA / requests.csv / summary 总数，固定前缀以排除活跃文件继续追加。分析工具仅使用 Python 标准库、只读原记录。生产 DB 复制 helper 在本 checkout 缺 dist，绝对主 checkout helper 返回 `snapshot_owner_unavailable`；没有复制 live DB、没有修改 DB。当前状态补充使用 mode=ro 的短事务，连接已关闭。A 的主体证明来自真实 transcript，B/C/D 的运行验收由 Implement/QA 与部署后复测完成，设计阶段不能打勾。

## 6. Lead补充事故的独立取证（9/15，不并入9/14基线）

收到问题37eb1fb3的回复后，按Cass具体batch `249f1d64-cd65-446f-868f-a25830445ffe` 查会话 `b9976762-0bdf-44f9-a4a3-04951c547eb3`。原行3672在00:07:22出现一次；行3842在00:23:19的**同一个用户输入**中含9份完全相同正文（各1051字符，同SHA）。所以重复投递现象成立，但不是9个独立模型轮；新增9份由4个关联请求处理，缓存读3,300,543，且其中有其他工作，不能全部当可消除因果量。

可见ACK工具只调用两次（00:12:04.991、00:23:38.544），都返回queued。当前readonly DB里第一次ACK row `123357fc-a490-455f-a97a-331aae9f746d` 确已在00:12:05.256持久创建，于00:23:05.240才消费；第二次在00:23:38.767创建，00:37:28.815消费。原 `delivery_id=chat:flywheel-cos-lead:1549208715222188146` 当前ACKED、lease_retry_count=0。这**反证“ACK未落库”是本样本已证根因**；更应追查协议消费延迟与同attempt重发。保留原始输入UUID、行号、ACK row ID、时间与hash于incident-followup.json；当前state仍不代表每次历史效果。

Lead所报01:34:28.925生成的“无重启Bootstrap”，与原行46037的01:34:29.123 auto compact_boundary相隔198毫秒；整理前967,028、后14,003 token，耗时166.305秒。代码PostCompact会请求Bootstrap，因此**强烈支持压缩后恢复触发**，无需进程重启；没有hook调用receipt，仍不宣称逐请求因果已完全证明。这份恢复正文实际90,362字符，直到01:55:01进入transcript；“每份345k字符”与本样本不符（9/14五份合计345,808字符）。实施回归加入按cause=启动/压缩/显式恢复记录触发来源，不需要改变可靠性身份。

对应stock Agent Team载体的sidecar当前只有一个已finalized记录：逻辑交付`chat:flywheel-cos-lead:1549208715222188146#r0`、batch`249f1d64-cd65-446f-868f-a25830445ffe#r0`，pending到finalized相隔222.252秒；两次transcript外壳都是teammate-message，不是MCP channel reader。当前main inbox为空，无法重建历史实际写入次数。现有ClaudeMailboxCodec已有同attempt finalized幂等；应从该exact mainEntryRef追踪写入/通知，而不是增一套猜测性去重。另，ACK应用会COALESCE填入缺失delivered_at，不能把00:23:05的delivered_at误作首次送达时间。

## 7. R1 HIGH复核与基线补充

context-floor.json直接保存6次compact_boundary及随后真实请求的源行/ID/总输入；最低169,201，最高首请求184,617；单次压缩103.5–168秒。因此不能以14k摘要认定上下文只剩14k，也不允许直接把窗口压到200k。删除150k收益情景，规则瘦身前移；先测同配置恢复后底线F，满足W≥max(2F,F+200k)并完成隔离频率/延迟测试，才试原生窗口（首候选400k）。

附带查清零值：三日去重记录418/812/2663分别包含110/2/1条model=<synthetic>、四usage均0的CLI合成记录；真正可见模型请求为308/810/2662。`unique_by_day`保留原key对账，`model_requests_by_day`单列非合成请求；source/tool表排除合成记录。缓存读/写/输出总量完全不变。文件前缀与requests.csv不变，summary增加明确分类；后续比较不能把错误合成记录算成处理工作。原“2,663次”准确说是2,663个去重usage key，含1条合成记录。

400k首候选不是收益承诺。假设实测平均缓存读300–400k、真实请求仍2662，理想节省为754,541,091–488,341,091；规划净2–5亿需要扣额外压缩/Bootstrap/重查成本。若硬门未过，压缩项收益按0，靠有界恢复和例行事件等独立项获得一周内可证下降。
