# FLY-2912 全天回放证据修复 — 验证记录
Issue: FLY-2912
日期: 2026-09-26
基于: plan.md, rework.md

本轮针对 QA `rework:63f43c70e0b5b5258c09db4aca91537dfba470403252154c688549e3552457c5`，基准 `82344f98c949d74840bcb9d0d2230248f0ab411d`。生产通知策略及四个独立开关保持已批准实现。已合并 `origin/main`（merge `18e447c12`）。

## 当前结论

**历史节省验收仍未通过。** 旧 `99→92/87` 是晚间 2.5 小时输入分组的条件估计，不能作为实际 wake 比较。本轮新增完整 PT 日元数据、运行时 turn 边界、源联接及可复算工具，没有把缺失的历史授权补成静默证据。

Lead 在问题 `63109e39-9fb3-4ada-8464-e08476cf4f2a` 的当前答复确认：检查过 `db-backups`、`backup`、`patrol-repairs`，没有 9/25 producer authority/run-state 快照。要求基于现存转录、mailbox/归档、DB 历史区分可重建与 UNKNOWN；未知部分不计通过；若比较失去意义，明确说明并提出最小未来测量。

时间窗为 `[2026-09-25T07:00:00Z, 2026-09-26T07:00:00Z)`，即 9/25 PT 完整一天。范围限定 flywheel / flywheel-eng-lead。

| 事实或指标 | 结果 | 能证明什么 |
| --- | ---: | --- |
| 当天 Lead 原始事件 | 1,855 | 源事件分母，包括已 audit 的事件 |
| 可重建处置 | 1,010 | 1,008 条本单范围外事件，2 条带不可静默的非空 last_error |
| 可重建处置的 model 前后 | 1,010 → 1,010 | 源事件处置不变；不是 wake 数 |
| UNKNOWN 事件 | 845 / 1,855（45.55%） | 缺当时生产者、obligation/owner、启动结果或监控 episode 授权 |
| 当天开始的已完成 runtime turn | 538 | 由原生 turn_duration 的时间与 durationMs 计算，不数 API 请求或输入行 |
| 可沿父链绑定起始输入的 turn | 533 | 包括 compaction 的 logicalParentUuid；不靠时间相邻冒认因果 |
| 未能唯一绑定起始输入 | 5 | 完整保留，不当作零次或已证明 wake |
| 存在源 batch 联接缺口的 turn | 6 | 完整保留原 batch ID、预期/实际成员数 |
| 仅含四类目标通知的候选 turn | 36 | 仅类型/成员资格，全部缺静默授权；不计节省 |
| 全日实际 idle→busy / 改后 wake | 未证明 / 未证明 | 保持 null，不以 538、1,010 或 36 代替 |

45.55% 的事件 UNKNOWN，且真正可能体现静默收益的 36 个 turn 全部没有足够的历史静默授权。因此可重建子集的 1,010→1,010 **不能衡量本单节省收益**；它只证明这批已知即时事件未被当作静默收益。`acceptance.complete` 保持 false。

## 修复内容及来源

- `evidence/reconstruct-wake-timeline.py`：读取指定本地转录，按原生 turn 边界及父链重建；同 turn 多输入、多模型请求不重复计数；午夜归属按开始时间；meta/定时任务和混合 founder 输入保留；正文引用不冒充源成员；缺 batch、重复冲突和缺父链显式记录。
- `evidence/full-day-turn-input.json.gz`：三个会话的 allowlist 元数据、完整前缀 SHA/字节长度、mailbox/归档成员元数据、Lead 事件身份及只含字段名的 last_error 守卫证明。没有正文、标题、工具参数、凭证或全文的逐条哈希。生产数据库只做只读查询，没有复制 live DB。
- `evidence/full-day-turn-result.json`：逐 turn 起止、起始输入、模型请求 ID、batch/member/source 关联、缺口、UNKNOWN event IDs 及输入文件 SHA。这是新增证据；旧 `replay-result.json` 和 257 行晚间 fixture 保留为历史台架记录，不据此宣称通过。
- 非空 last_error 只支持恢复 model，不支持静默；对应生产判定在 `lead-notification-evidence.ts` 的 ACTION_TEXT / notificationPayloadIsPure。事件 #130082、#130167 的源字段确实非空。其余目标事件没有凭当前 mutable session 状态或未知 dispatch purpose 生成历史 proof。

可复算命令（无需生产数据库、模型或网络）：

```sh
python3 engineering/doc/FLY-2912-quiet-notification-expansion/evidence/test_wake_timeline.py
python3 engineering/doc/FLY-2912-quiet-notification-expansion/evidence/reconstruct-wake-timeline.py replay \
  --input engineering/doc/FLY-2912-quiet-notification-expansion/evidence/full-day-turn-input.json.gz \
  --output /tmp/fly2912-full-day-recomputed.json
cmp engineering/doc/FLY-2912-quiet-notification-expansion/evidence/full-day-turn-result.json /tmp/fly2912-full-day-recomputed.json
```

重新提取使用同脚本 `extract`，另传 `--transcript-dir`、`--teamlead-db`、`--comm-db`。源库查询限定 Lead、两天事件边界上下文及精确缺失 seq；mailbox/log/两种归档按精确 batch IDs 查询，不以日期截掉积压消息；SQL 取显式元数据列；连接关闭；不写生产状态。capture-time 数据没有被称为 at-event 授权。归档/current mailbox 的 batch 改写或消失仍可能造成缺口，脚本不会凭文本补造成员。

## 最小后续测量提案（尚未执行）

交给 QA/Lead 决定是否接受历史 UNKNOWN 边界及启用未来测量。实现节点不部署、不切生产开关、不自行开 QA 房。

在获批部署后，选一个固定的完整 24 小时窗口，保留每条四类通知的 producer binding、实际 policy reason/proof、五个开关的当时值、原始事件、队列 batch/member/receipt，以及载体真实 turn-start/turn-end/idle 记录。原始正文留受控存储。窗口结束前冻结行集和转录前缀，按精确身份核对缺失率。

在已授权的隔离 QA 载体中，以相同事件顺序和已冻结授权分别回放 ON / OFF，通过真实载体 turn-start 及 idle→busy 记录计数，记录队列忙闲与批处理；不拿 adapter 调用或 ACK 当 wake。先验证所有真实待办均消费、纯通知无独立 turn，再报告两组实测 wake 数、批处理差异和未重建事件。任何缺 proof/receipt/载体边界仍标 UNKNOWN。若载体耗时产生不同合批，保留两组完整时间线，不宣称确定性的生产节省比例。

## 验证范围

新脚本先红后绿，当前 12 个单测：多输入单 turn、午夜、父链、隐私/meta、混合 founder、缺 batch、UNKNOWN 子集、compaction、引用标头、非空 error、重复冲突、跨日积压消息的精确旧源/归档联接与正文隔离。

消费者发现对新脚本全路径、文件名、父目录及旧 carrier-observation 的 literal 逐项搜索。唯一相关既有可执行消费者为 `fly2912-evening-replay.test.ts`，保留执行；命中的 plan/rework/implementation 文档、旧 consumer-audit JSON 和 fixture README/build-fixture.py 均不是测试，且不消费新增脚本输出。新增脚本未修改 TypeScript，无新增 TS related 选择。merge 后另保留 EventFilter、registry 与 fly2139 查询证据守卫。无本地全包/全仓测试，QA 持有新冻结头完整 CI。

实测结果：12 个 Python 单测通过；上述四个 Vitest 文件共 106 passed；全天结果重新计算后逐字节一致；lint exit 0（25 条既有 warning），teamlead 及依赖 build exit 0。命令、日志归档及哈希见 `evidence/full-day-verification.json`。没有复用旧头的 full CI 作为本头证据。
