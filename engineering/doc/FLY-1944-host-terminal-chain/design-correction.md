# FLY-1944 第二轮 — design-correction(增量修正,由当前 TURN 持有者落盘)

Issue: FLY-1944 (https://linear.app/geoforge3d/issue/FLY-1944/宿主终端链-tmux-统一升级-brew-护栏-cmux-守护看门狗并-19501951)
日期: 2026-08-21(design 节点完成后追加;来源 = Aunt Cass 22:49Z Linear 评论实测 + Tadashi lead-instruction a4ff27d5 / e87b1336)
基于: plan.md(R1-R7 APPROVED 版,blob 3f8bfe2d)

> 本文件由 design 作者(exec be4d5873)起草于 TURN=implement(holder 3a8687c3)期间,按 design-correction 合同交 TURN 持有者原样落入
> engineering/doc/FLY-1944-host-terminal-chain/design-correction.md 并 commit。**不回滚 plan.md、不重开 design gate**;
> 与 plan 冲突处以本文为准,implement 按 plan + 本文执行。

## C1 第④类断口:workspace 在、活着,但标题是一串原始命令(present 但不对)

**现场(Cass 22:49Z,清理前 38 个 workspace)**:4 个命令标题(ws:94/93/103/105)+ 1 个 `~`(ws:71)+ 2 个 Terminal NN。
每个命令标题都配对一个**编号更大、正名**的同胞(94↔97、93↔96、103↔107、105↔8):同一 session 先建出「拿命令当标题」的,再建正名的,前者永不回收。founder 验收原话「每个终端都在、都对」——第④类过得了「在」,过不了「对」。

**同源裁定(Tadashi 指令 ③,已用证据裁定:同源,机制层)**:
- 证据 A(账本对):view-ledger 中 4 个命令标题长者**全部无收据**;存活的正名同胞(97/107)**全部 committed**。[实测 2026-08-21 ~00:2xZ,ledger grep]
- 证据 B(代码面):候选匹配(workspace_title_candidates)只认两种形态——expected title 或 exact canonical 命令;命令标题(旧 raw 语法)两者都不是 → 建 tab 时看不见它(于是建出正名同胞)、清理时无法证明归属(于是永不回收)。
- 结论:第④类与 unreceipted-preserve 锁是**同一根因的两个分支**——「收编/归属证据面过窄,半成品 fail-closed 保留」。入口不同:第④类来自 create 事务收据腿丢失(rename-lag / crash / generation 漂移),Lead 锁来自 pre-receipt 时代存量。**plan 的 S1a exact UUID join 正是对这个根因的修法,但其收编条件写窄了(见 C2)。**

## C2 对已批 plan 的修正点(逐条,与 plan 节号对齐)

1. **§1.1 收编条件放宽(覆盖第④类)**:原文要求「title 与 roster expected-title / cmux-<窗名> 逐字相等」才收编——第④类永远不满足。改为:**title 匹配不再是必要条件;UUID join + 现时 processTitle 严格解析(target 精确匹配 roster socket / 窗名)是首要归属证据**。title 变成**输出**:
   - 若该 target 无其他 managed workspace → 收编 + **一次 guarded rename 到正名**(计入预算 G 的 1 单位;此收编不再是零 mutation,healthy-stock 零 mutation 收编仅适用于 title 已正确的原 S1a 类)。
   - 若同 target 已有另一个 workspace → 进入 C3 的 duplicate 状态机。
2. **§1.1/§2 新增 duplicate 收敛不变量(Cass 红线)**:终态 = **一个 tmux session 对应且仅对应一个 alive、正名、有收据的 workspace**。收敛规则:
   - **先判活,两边都判**(0-client/screen/receipt 全套,与 respawn-dead-view 同源信号);**标题形态永远不是死活信号**(实测反例:ws:8 正名但 [server exited] 死、ws:105 命令标题但活的 Honey Lemon)。
   - **只回收「同一 session 已有另一个正名 workspace 正常显示」的重复份**;死的先修活(或迁移)。
   - 活死反转形态(正名死 + 丑名活):**保活弃死**——先关死的(死壳 close 安全)、guarded rename 活者到正名、收据 CAS 到活者。顺序必须先腾出 title 再 rename(title 唯一性),全程在既有事务机制内,每步计预算。
   - 歧义(两边都活 / 判活 inconclusive)→ 不动只报(fail-closed 一致)。
3. **§4.2 判官新增规则**:`source-unique` 族扩展为 Cass 验收 #2 的机器判定——普查每个 workspace 解析到其 session,**一对多 = RED**;另加 birth-title 断言(create 事务完成后 title 不得为命令串 / `~` / Terminal NN 形态)。
4. **§10 验收总表增行**:
   - A9(第④类):任一 runner/Lead workspace 建成后标题即正名;存量命令标题 workspace 被收编改名或按 duplicate 状态机收敛。验收 = Cass 评论「建议验收」4 条逐条机器判定。
5. **回收红线全局化**:S2/S3 及一切 close/reclaim 路径显式继承「liveness-first、title 形态不作依据」——S3 只删死 socket 文件不受影响;S2 helper 回收的判据本就是进程/target 证据,不变;唯一受影响的是 workspace 级 duplicate 回收(上条 2)。

## C3 「账亡窗存」类(patrol 指令 e87b1336,%499 标本)

- 形状:引擎收尾级联已清 comm 注册行(账亡),但 tmux 壳(Codex 壳拒绝 teardown 的已知形态)活着(窗存)→ 巡检判 ORPHANED、cmux 侧栏仍把它镜像成一个像活 runner 的 tab。
- **标本灭失记录(诚实)**:23:53Z 指令要求保留 %499 取证;我 ~00:2xZ 只读检查时 default socket 已无 %499(pane id 最大 700+)、runner-flywheel 无 1944 主段窗、comm 0 行——标本在指令与取证之间已被清掉。分类按 patrol 描述的形状 + comm 0 行佐证成立。
- **设计处置(并入分类表)**:镜像/占位层对「窗存但账亡」(tmux 窗在 + Bridge sessions/comm 均无非终态行)workspace:**打显式状态标签(如 已结束·账面无此体),不当活 runner 呈现;不自动杀 tmux 窗**——杀窗归 runner lifecycle(引擎/#911 域),cmux 接线员只管「不骗 founder」。连续两轮证据 + fail-closed(账面查询失败=inconclusive 不标)。
- 该类与 C1 合并进同一张断口分类表:①重启波空白 ②app 存活期空洞 ③新生空壳 ④present-but-wrong(命令标题/重复份)⑤账亡窗存。

## C4 过期更正(标记已流出的误导读数)

- 我(design 节点)research.md「会过期的结论表」中三行已过期:ws:93/94/103 raw 存量「仍在生产」——**Cass 15:48 PT 已手工清理**(修活 ws:8、关 105/103/94/93/71/70/30);当前干净的 ~31 行 census **归属 = 人工兜底,不是任何自愈生效**(Cass 归属声明原文在 Linear 评论)。任何拿「现在看起来很干净」当基线的读数都必须记这个归属。
- helper 孤儿数字随时间漂移(12 → 21 总量/组成变化),以 implement 时点重新 census 为准;孤儿清扫的设计不受影响。

## C5 对 QA 的影响

- QA 判据增加:第④类 RED→GREEN(命令标题 workspace 被正确收敛)、活死反转难例(保活弃死,绝不按标题回收)、1:1 census 判官规则、账亡窗存标签(账面 mock 即可)。
- Cass 评论「建议验收」4 条作为机器判定逐条进 QA 清单。
