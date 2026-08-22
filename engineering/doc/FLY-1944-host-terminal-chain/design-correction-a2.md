# FLY-1944 第二轮 — A2 替换设计(停止门选项 b;design-correction 第二增量)

Issue: FLY-1944
日期: 2026-08-22(design 节点作者出稿,零 worktree 模式;由 TURN 持有者落入 design-correction.md 追加节或 design-correction-2.md)
基于: plan.md(R1-R7 APPROVED)+ design-correction.md(C1-C5)+ lead-instruction·A2 设计 lap(mailbox seq 99318)

## 0. 触发记录(停止门按设计生效,证据入档)

plan §1.3 的落地范围门由 implement 真机证明**双腿同时击穿**:
1. respawn-pane = **no-op**:rc=0 但 5s 后原 helper client 仍 attached、processTitle 与屏 hash 均未变(与 capabilities 无 *.respawn 的旁证吻合——CLI 收下命令但无实效)。
2. processTitle = **create 时快照**:另一活体 exec 换面后 persisted processTitle 仍钉在初始 create 命令 >12s——它不是「现时内容证据」。

两个推论:(a) 修复原语必须换成 workspace 级重建;(b) mutation 边界的「founder 活内容否决」不能再靠 processTitle,须换证据(见 D1)。
**语义澄清(不动其他段,仅澄清)**:processTitle 降级为**出生命令证据**(这个 workspace 是用什么命令建出来的)——它钉在 create 命令这个事实恰好使它对 C2 的**收编归属**(证明「是我们/合法载体建的」)依然成立;失效的只有「现在里面跑着什么」这一用法。C2 收编逻辑零改动。

## R3 生产证据更正(2026-08-22,覆盖上段“出生命令权威”)

round-3 reviewer 对宿主持久态与活 helper 做了交叉普查:19 个 managed workspace 中有 6 个当前 `processTitle=Terminal NN`,其中多项同时持 current-generation 五字段 receipt、活 helper 与活 source window。也就是说,`processTitle` 不只会陈旧,还会在活 workspace 上**缺失载体出生行**;“每个 workspace 都永久保存 create argv”的前提已被生产数据证伪。

Lead 裁决统一改为:**birth 证据只能佐证,不能当硬前提**。落地含义:

1. v2 Lead reconcile 在 birth 行缺失时回退到既有 title/variant transaction,继续命名与 heal;显式传入 workspace UUID 的路径仍须 exact birth join,不得伪造 UUID 权威。
2. `--verify-sidebar` 对活 workspace 缺 birth 行输出 `receipt-uuid-unattributable` WARN,不把它误报成身份不一致;有 birth 行时仍严格比较 receipt UUID。`unattributable` 永不授权 close/reap/promotion。
3. duplicate close/promotion 的单次屏幕采样不足以满足 #907。普通 view 与 private-v2 的该腿本 PR 统一 report-only,只保留命名/receipt convergence;不再自动关 keeper/loser。
4. orphan helper 的 target absence 只接受 bounded、message-anchored tmux verdict,并把 current workspace title/raw-command inventory 与 birth rows 合并计数。即便两轮均“target absent + workspace unclaimed”,自动 TERM→KILL 仍降级 report-only;post-close exact-ref/UUID/token 树闭包保留。
5. heal 优先复用 exact birth target/token,避免无条件轮换破坏后续 helper 归因;birth 不可得时仍 fail-safe heal,后续 destructive reap 不因缺证获得权限。
6. 收编加入跨 Lead/view 的 pass-level 文件阀 `~/.flywheel/state/cmux-adopt-cap`(1..10,缺省 1;malformed/symlink 禁用),避免一次 pass 全舰 rename。

因此本文 D2/D3 的 repair primitive 仍按停止门不实现;而所有把 immutable birth 当 close/reap 充分条件的旧表述,均由本节覆盖。安全方向是“少回收,不误杀”,不是从 title/processTitle 猜所有权。

## R5 热路径性能与收编公平性更正(2026-08-22)

round-5 reviewer 在 36-workspace 现场快照上量得 `workspace_title_candidates` 从 merge-base 约 56ms 退化到约 4.18s/次;原因是 Bash 外循环为每个 workspace/variant 启动 Python。该函数在 additive 与双快照 judge 中按实体重复调用,会把一分钟扫描拖到数分钟并制造 heartbeat 假卡死。

实现更正:

1. `_cmux_carrier_classify` 成为本脚本的批处理 grammar 入口;parse/equivalent/candidates/stock 四种模式都在一次 Python 中完成输入全集分类。`workspace_title_candidates` 与 `stock_workspace_records` 不再 base64→Bash→逐行 Python 往返,兼容 variants 也不再逐项 parse。
2. 37-row 回归夹具用 PATH 计数 shim 断言 candidates/equivalent/stock 各最多一个 Python process,直接锁定 fork 形态而非依赖机器时钟。
3. adopt-cap 文件补当前 uid ownership 校验;文件存在但 malformed/symlink/foreign-owned 时禁用 adoption。cap 用尽只跳过本轮 birth authority mutation,仍对 exact ref 运行 heal;adoption 中途失败归还共享 slot,避免一个坏 tuple 永久饿死后续 Lead。

剩余 parser 副本只在 process census 与 birth join 的独立证据域,列为 non-blocking differential-corpus follow-up;不再位于本轮发现的 per-workspace 热循环中。

## D1 dead-view 判定收窄:阳性死形态签名制(取代 processTitle 否决腿)

原 dead-view 定义(可读 ∧ 非 bare ∧ 非 no-pty)是**兜底集**,靠 processTitle 现时解析挡住「founder 编辑器」误伤;该腿失效后兜底集不再安全。改为**只修阳性识别的死形态**,枚举签名(字面匹配,fail-closed):
- S-a 退出残文:屏含精确签名之一——can't find session / [server exited] / no server running / [exited] / server exited(签名表进代码常量,tests 锚定;来自 Cass ws:8 与 ws:71 实测形态)。
- S-b 全空屏:read-screen 可读且**零非空白字符**。
- S-c not a terminal(既有 no-pty 类,不变)。
其余一切(编辑器 UI、TUI、无法识别内容)→ unclassified,**report-only 永不修**。
配合既有闸:0-client 重证 + 连续两轮 determinate + min-age + committed receipt + UUID join(去掉 processTitle 现时腿)。
**安全论证**:活编辑器/任何 founder 内容必然渲染出非空、非签名内容 → 永远进不了 S-a/S-b/S-c → 结构性不可能被修。代价 = 漏修面扩大(未知死形态不修),按 Cass 红线「宁可漏修不误杀」显式接受,进诚实边界。

## D2 修复原语替换 = create-before-close 重建事务(fail-safe:新未证活,旧一根手指不动)

对判定为 S-a/S-b/S-c 的 workspace(记 OLD,持 committed receipt):

1. **admission**(预算 1 单位,成本行见 D5):全套闸通过(D1 判定 + 0-client + 两轮 + receipt/UUID join + generation/lease + 预算)。
2. **create**:new-workspace --command <canonical 载体文法 v2:helper + target + 新铸 token>(与 plan §2.1 文法一致;deliberate-repair 路径豁免「同 target 已存在」dedup,fence 记录被替换的 OLD ref)。before/after refs diff 定位 NEW ref(既有模式),落 prepared 收据(staging 态,title 暂为 cmux 默认名,**不抢正名**)。
3. **verify-alive(跨轮推进,不内联等待)**:两条独立证据都要——
   (i) target 侧 client 数增量:NEW 的 helper attach 后,对该精确 socket/view session 的 list-clients 出现新 client;
   (ii) NEW ref 的 read-screen 渲染出非空、非签名内容(真 tmux 画面)。
   有界轮数(复用 _attach_retry_limit)内未证活 → **rollback:关 NEW**——候选复用 rollback_unreceipted_workspace(R2 评审记录其接受集 = unnamed/provisional/default 形态,staging 名相符;**implement 须核它对本事务 prepared 行的处置**,不符则先清 prepared 再走,或按同一 guard 纪律写一个 repair 专用回滚,禁止裸 close)。OLD 原样未动,episode attempts++,耗尽落既有 dead 显式状态(RED)。
4. **converge(NEW 证活后,即 C2 duplicate 收敛的标准形态,不造新机制)**:此刻同 target 恰好「一活(NEW,staging 名)+ 一死(OLD,正名)」= Cass 红线的合法回收形——「同一 session 已有另一个 workspace 正常显示」且 OLD 死判定在本事务内两轮重证过。顺序:guarded close OLD(腾出正名;close 前再验 OLD 屏 hash 仍为死签名,变了就中止保留)→ guarded rename NEW 到正名 → 收据 CAS 到 NEW(五字段,NEW 的 workspace UUID)。
5. **crash 恢复 = C2 收敛网,零新恢复代码**:任一步 crash 后留下的中间态(staging 名活 workspace / 双 workspace 同 target / 正名空缺)全部落在 design-correction C2 的第④类收敛机(join 收编 + duplicate 状态机)的既有处理面内——下一 pass 自然收敛。这是选 create-before-close 而非原位替换的核心理由之一。

**弃选**:close-surface + new-surface 原位替换(R2 已证 new-surface 无 --command,且先拆后建违反 fail-safe);修 OLD 的 surface 内注命令(send 只对 bare 类安全,死壳注入不可达)。

## D3 scratch positive control 改版(落地门仍在,验的对象换了)

实现第一门改为验**重建事务**:生产 cmux 自建 qa 前缀 scratch workspace(连一个自建的隔离 tmux session)→ 人为致死(杀 session 造 S-a 形)→ 跑重建事务 → 断言:NEW 证活、OLD 被关、title/receipt 收敛、全程 OLD-先-动为零。founder 可见足迹仍约一分钟,Lead 知会流程不变。**此门失败 → A2 再次停,不得带病落地**(停止门语义不变)。

### D3 实测结果(2026-08-22 implement)

D3 在只操作自建 `qa-fly1944-*` workspace/session 的 scratch 中再次触发停止门:

- 宿主为 `cmux 0.61.0 (73)`;顶层 help 虽列出 `new-workspace [--command <text>]`,但子命令自己的 `cmux new-workspace --help` 只有无参数用法。实测 `--command` 被静默忽略,NEW 只有空 shell,隔离 tmux client 数保持 0,故无法得到 D2 `verify-alive` 双证据。
- 上游历史也与此一致:`manaflow-ai/cmux#120` 把当时的两步 workaround 明写为 create 后 `cmux send`;当前 main 文档才把 `--command` 列为正式能力。也就是说这里是**已安装版本能力缺失**,不是把等待时间加长就能恢复的瞬态失败。
- `send` 不是本设计的等价替换:它会绕过 immutable birth `processTitle`,使 C2 的 birth-authority 收编/判官/helper 归属在后续 round 丢证。若要支持 0.61,须另加 durable repair provenance 并重评审;不能只补一条 send。

停止门 `4027acd2-ad8a-4bac-90dd-787278faefee` 的最终裁决是:**A2 在本 PR 显式定档 report-only,修复原语拆独立单**。不做 guarded `send` 注入,也不随本 PR 发货一个“升级 cmux 后会自动打开”的潜伏重建路径;原因正是 `send` 绕过 birth `processTitle`,会打断 C2 的出生权威校验/收割。

本 PR 对 A2 只保留三件可证事实:①阳性死形态严格分类(`exited|empty|no-pty`),首次只落 `observing-<class>`,相同 class 须跨独立 round 且满足 min-age 才确认为死;②`_attach_state_*` 持久落 `dead-<class>` 并把精确 class 写入 founder-visible status(class 漂移须重新观察,不能继承旧死态权威);③经既有 `cmux_cleanup` 通道按 generation/ref/title/class 去重告警。所有轮次、cmux 新旧版本一律零 create/close/respawn mutation。D2/D5 作为后续「带出生凭据的重建原语」输入留档,其实现已从本 PR 删除。

## D4 验收与诚实边界更新(只动 A2 相关行)

- §10 A2 行改为:app 存活期 surface 呈**阳性死形态(签名表)**→ durable `dead` + 精确标签 + 去重告警;**不自动自愈,不标覆盖**。未知死形态/编辑器形仍 preservation-only。
- 判官:`dead` 终态保持 RED/degraded,不能被 A1/A3/A4 的绿色证据冲掉。
- QA 难例更新:同一阳性死态跨轮只报一次且零 create/close/respawn;三类 class 均保留在 status/alert;活编辑器 surface(非签名内容)永不进入阳性死态。

## D5 后续修复原语的预算输入(本 PR 不实现)

- rebuild-create(步 1-3)= 1 逻辑单位;成本 ≈ 4 证明 RPC + 1 mutation = 4×(T_proof+grace) + (T_mut+grace) + overhead ≈ 31s?——**超默认 30s deadline,故拆半**:admission+create = 1 单位(2 证明 + 1 mutation ≈ 19s),verify-alive 只读跨轮推进(clamp,不占单位)。
- converge(步 4)= 1 单位(2 证明 + 2 mutation ≈ 25s ≤ 30s);与 create 天然分轮(verify 跨轮),无单轮超限。
- 关系校验公式与 min/default/max 三角 tests 随后续独立单实现;本 PR 的 report-only 路径不占 mutation 预算。

## 影响面清单(供 TURN 持有者核)

改:plan §1.2(D1 收窄)、§1.3(原语=重建事务,门=D3)、§5(成本行)、§6(真机段)、§8.1/8.2(边界改写)、§10 A2 行。
零改动:S1a/S1b 收编(processTitle 出生语义仍成立)、S2 回收、S3 janitor、S5 部署停闸、载体文法(token 正好被重建事务复用)、C1-C5。
