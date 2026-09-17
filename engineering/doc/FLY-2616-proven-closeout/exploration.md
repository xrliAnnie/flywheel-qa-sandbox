# FLY-2616 证明消失再收尾 — 探索
Issue: FLY-2616 (https://linear.app/geoforge3d/issue/FLY-2616/land收尾-合入后收尾必须能证明每个体已消失session-行缺失窗口不存在心跳超时goneworktree)
日期: 2026-09-15
基于: 无

## 决定和范围
Founder 2026-09-16 03:34Z：每个执行体已关闭后才归档 issue thread。修正证明失败，不能取消耦合。包含追加的 land 车道持有者死亡后及时回收；本次只设计，不实现、不改生产、不 dispatch、不请求 ship。
Lead 在问题 `a1f11bf9-4519-4d5c-80a5-03740e7b0c63` 的回复批准：一个 execution-bound 活性结论复用于收尾、parked 探活、cleanup 投递；负证据 + 没有活体否决 + 探针覆盖完整，UNKNOWN 不算不存在；租约回收必须隔离旧 worker。

## 问题分解
1. 会话行被清掉不应让既有执行身份从待收尾集合中消失，也不应永远等它签收。
2. 行缺失、窗口不存在、进程消失、心跳超时任一是候选负证据；任何当前活体证据否决 gone。权限失败、探针超时、不知道 adapter 都不是死亡。
3. parked 是声明，不是活性证明；陈旧声明不应否决完整死亡证据。活着但不工作的体应发有时限的清理请求，之后进入既有授权 teardown 并重新探测。
4. 目录确实不存在是清理完成；权限错误、错分支、现存但未注册的目录不是。
5. 到重试上限允许显式 held，但必须有持久、可投递且 Lead 可操作的升级报告。
6. land 车道不能因持有进程死亡空占一小时；回收必须阻断旧 worker 复活后的写入和重复外部副作用。

## 选项
| 方案 | 好处 | 拒绝/采用理由 |
|---|---|---|
| 先归档、后台慢慢清 | 表面快速完成 | 拒绝，违反 founder 的证明消失门 |
| 只加重试/延长 cleanup ACK 等待 | 改动少 | 拒绝，死体永远不会签收，缺行/缺目录仍永久卡住 |
| 一份带身份和时间的证据结论 + 沿用现有收尾/恢复入口 | 能解释每个体为何 gone、保留活体否决 | 采用；补齐 inventory、原子复核、租约 fencing 和验收 |

## 已验证源码 vs 事故事实
基线 `b51fec422`。源码事实见 research.md。事故事实来自 Lead 回复，不冒充本节点亲测生产：
- 2391 run `4545e991-5f7f-478c-ab9f-013d40bb9e36`，PR #1209 合入 02:36:04Z；03:49:51Z partial/retry=5；implement `538b06e0` completed、CommDB 行和窗口无，close-runner alreadyGone，但收尾未收敛。
- 2588 run 前缀 `627d7544`，held/retry=9；land@1 `da4def17` 两库均无 session，QA `dd06029c` completed/无 CommDB 行；Linear 已 Done。
- 2413 run 前缀 `23f4da11`，held/retry=9/commdb_finalize_failed；parked 未探活；land@1 `2cdaff27` 无 session，QA `e1c312a9` completed。
- 2602 run `54eb7a77-65fc-4251-bb9a-56885764a455`，#1217 合入 02:46:18Z；缺 worktree 后 branch mismatch，03:50:09Z 已自行 completed。回归重放失败前形状，同时证明已完成重放幂等。
- 车道 owner PID 36302 于 02:49:51Z 获得租约，死后直到 03:49:51Z 才过期；79556 于 03:50:09Z 接手。
- 新补充 2244 archive_failed 只有单例；覆盖归档失败后的同一收尾重试/升级，不扩大为 Discord 平台排障。

## 边界与未完成证据
设计阶段未运行实现红绿测试、四实例隔离回放、精确头 CI 或 ship report 验收。这些是 plan 的后续硬性验收，不以文档代替。当前 worktree snapshot helper 缺 dist；主 checkout helper 可加载，不能据此称已有快照。Lead 确认未提供事故快照 manifest。实施方必须通过受管 snapshot helper 建立隔离输入，补全身份，禁止把上述短前缀当写入身份。
本任务不改变通用调度的 quiescence admission（其历史 founder 决策不在本单），不清任意进程，不删除不明目录，不把新 head 自动当旧 merge 授权。
