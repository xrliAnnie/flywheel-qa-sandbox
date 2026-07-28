# FLY-1518 engine→actions 迁移 + 退役表删除 — v2 终稿映射

Issue: FLY-1518
日期: 2026-07-28
基于: founder 批准的 /tmp/v2arch/v2-final-design.html(SHA-256 e0078266d1bb852a17e484d9aea0b7f14ad076a9f48c79bac9394f463f334b17,托管 https://fw-reports-a53de2.vercel.app/r/c80de4dfa7a2bd33aa6f0d44824634d4/)+ FLY-1498 v2-final-approved-extract.md(四 🔴 裁定固化)+ FLY-1500 mapping-v2final.md §0.2(裁决 A 原始记录)+ 本单 brainstorm gate 裁定(2026-07-28)

> 本文是 FLY-1518 对 v2 终稿的落地映射与偏离台账。exploration/research 是审计与调研,
> 实施以本文 + plan.md 通过的评审为准。

## 1. 终稿落到本单的一句话

把 FLY-1499 引擎按旧 R13 文档实现的 commands outbox 外发路径,迁到 founder 终稿的
actions 黑匣子语义(Agent 转化期间亲手调工具,薄壳前后记账,结算只提交库内产出);
随后一条前向迁移删掉三张退役表;design-FINAL-v2.md 并稿修正案成为唯一权威终稿。

## 2. 审计发现(本单紧迫性的实证,Lead 指令入档)

**引擎在写一个无人消费的断头 outbox。** FLY-1500 修正案删除了 dispatcher 整包
(packages/v2-dispatcher 从未进 main,claim/候选扫描/探针/saga 全族不存在),但
FLY-1499 引擎的结算事务仍把 command effect 写进 commands(settlement.ts:89,
state='pending')。当前 main 上没有任何代码**读** commands——引擎每写一条 pending
command,它就永远停在 pending。若 v2 就此接线上线:所有经此路径的外发(回复、通知)
静默丢失,账面却显示"处理完成"。这正是 founder 复盘指出的"修正案跨单影响未传导"
的缝的机器形态,也是"本单必须在 v2 上线前完成"的根据。

## 3. brainstorm gate 裁定(Lead,2026-07-28)

1. **D1 = 方案 B 批准**:外部效果在转化期间由 Agent 亲手经 runRecordedAction 完成
   (intent→perform→outcome 全在结算前);ConversionProposal 删 command 变体只留
   task/event;结算原子性不动。方案 A(settle 内记 intent、commit 后执行)被否:
   换皮 dispatcher + commit 后崩溃留下无人唤醒的孤儿 intended 行。
   **补充硬要求**:invocationUid 必须含 per-action 分量——
   invocationUid = JSON.stringify(["conversion",messageUid,logicalEffectId,qualifier??null]),同一消息多个外发动作
   不得共享 uid;必测"一消息两动作,跨重投递各自恰一次"。
2. **D2 = 本单不动 attempts observation 三列,批准(有记录偏离,见 §4)**。
3. **D3 = 0008 批准**:fkMode rebuild;0001/0002 checksum 不动;fresh 全链 + 带旧
   数据升级双路径测试;**退役表带数据时 DROP 即弃,但弃行数必须留持久回执,不静默**
   (落法:0008 DDL 同事务写一行 events 弃行回执,fresh 链回执为全零)。

## 4. 对上游映射的有记录偏离

**attempts 的 observed_state / observation_kind / observed_at 三列本单不退役。**

- 上游口径:FLY-1500 mapping §0.2/§3 写"FLY-1518 engine→actions 迁移时一并退役旧
  observation 列"。
- 本单裁定(Lead 批准):issue 范围文本(founder/Lead 2026-07-28)只列三张表;三列
  生产零读者(修正案已删 attempt-observation 探针族)、只有引擎测试 fixture 显式写入
  且列有 DEFAULT;删列 = attempts 全表 rebuild,而 attempts 是并行单 FLY-1520(DAG
  引擎)正在消费的运行时域——本单 rebuild 它会把并行批次搞成隐性串行,重演本单要治
  的撞车。
- 处置:①本单清掉 fixture 的显式写入;②三列标注"过渡保留",退役归属 post-launch
  的 attempts 重建单;③该偏离同步写入 design-FINAL-v2 终稿 §1.1 attempts 条目;
  ④跨族评审必须看到本条。

## 5. 锁死边界

### 5.1 本单交付

1. v2-engine:Effect 删 command 变体;settlement/sql 删 insertCommand 路径;新增
   零 kind 知识的转化动作接缝(RegisteredAgent→ActionActor 映射、runner 经
   activations 解析 task/attempt 绑定、messageUid::logicalEffectId 派生
   invocationUid),供转化层以正确姿势调 flywheel-v2-actions。
2. v2-kernel:0008-drop-retired-command-obligation-tables(弃行回执 → DROP 两个
   tombstone 触发器 → DROP command_dependencies/commands/obligations);kernel/
   v2-actions 落 1500 rebase 轮 advisories(supersede 拒重用 predecessor uid、
   result 序列化诚实终态化、createdAt/completedAt canonical 校验、authorization
   replay 语义测试锁定、canonicalizer 边角测试、注释/横幅两处)。
3. 文档:design-FINAL-v2.md 并稿修正案成真终稿(research.md §4 逐节清点);
   FLY-1500 旧 plan.md 加 superseded 横幅。
4. 测试:研究 §3.3 期望集清点 + §6 迁移/等价证明矩阵(M1-M5、E1-E10、Z1-Z3)。

### 5.2 明确不做

- 不实现 DAG 派发/节点合同/ship 执行器(FLY-1520);不做切换(FLY-1502);不删 v1
  告警族(FLY-1503)。
- 不给 actions 加 retention/archiver/探针/自动重试/执行器注册——修正案明杀,不复活。
- 不动 0001/0002 已登记 checksum 的一个字节;不动 tasks 表形状与 insertTask
  (lineage_root_id 等 = 1520 域)。
- 不动 attempts 三列(§4 偏离);不碰 mailbox 消费协议/公平性/垫片(1499/1501 已交付)。
- 引擎不提供任何"取回 intended 再执行"的驱动面(方案 A 已否)。

## 6. 跨单接缝

| 对手 | 接缝 |
|---|---|
| FLY-1520 | 它不动 v2-engine 文件、不加迁移(其施工纪律明文);0008 编号归本单独占。design-FINAL 改动不触碰 DAG/节点合同/ship 三条批准语义,diff 供其比对 |
| FLY-1502(切换) | 本单合完 → 统一重启 → v2 终态上线;切换手册无退役表残留检查项(0008 已前置完成) |
| flywheel-v2-actions | 引擎接缝是它的消费者;runRecordedAction 合同(performed/replayed 区分)原样透传给转化层,不包装不吞 |
