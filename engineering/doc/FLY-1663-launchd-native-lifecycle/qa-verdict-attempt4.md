# FLY-1663 独立 QA 判决 · 第 4 轮 — FAIL（只剩 529 房无人值守可靠性；载体与 Lead 侧全部验通）

Issue: FLY-1663
日期: 2026-08-09
被验代码 head: `93f72b2ae45dc537989b8ba3c508efb2810d1da2`
前序: qa-verdict.md（1 轮 FAIL×3）、qa-verdict-attempt2.md（2 轮 FAIL×1）、qa-verdict-attempt3.md（3 轮 FAIL×1）

## 判决

**FAIL** —— 但请先看清楚差距有多小：**上一轮的 F4 修好了，而且我这一轮把从第 1 轮就一直挂着的两个大缺口全部补上了**：

- **真 Discord 往返（进+出两条腿）** ✅ 第一次跑通
- **真 Lead 的 `--resume` 记忆延续** ✅ 第一次跑通

载体、Lead 能力、安全、回滚资格这些硬门现在全绿。**唯一还挡着的是 529 房自己**：
用产品默认值、无人值守地跑 `test-deploy.sh`，**0 成功 / 4 失败**。
plan 把 529 房定为 Phase 0 硬门，一个 0/4 的房间不能作为 15 个 Lead 迁移的起跑线。

---

## F4 已修复 ✅（在终点取证）

修法比我提的更稳妥：`USER`/`LOGNAME` 不是照抄调用方给的值，而是用 `/usr/bin/id -un` 从内核账户现取，
并且 **wrapper 与 `claude-lead.sh` 的 claude 子进程边界两处都补了**（后者顺带覆盖 v1 路径）。

**终点证据**（真 529 slot Lead，v2 载体）:

| 观测 | 第 3 轮 | 本轮 |
|---|---|---|
| claude 子进程 env | 无 `USER` | **`USER=xiaorongli` / `LOGNAME=xiaorongli`** |
| 状态栏 | `API Usage Billing` + **`Not logged in · Run /login`** | **`Claude Max`**，无 `Not logged in` |
| 收到 Discord 消息后 | 回 `Not logged in · Please run /login` | **正常回话**（见下） |

## 🎉 真 Discord 往返（进 + 出）—— 第 1 轮起就缺的那块，补上了

我用 Claude-in-Chrome 以 founder 身份在隔离 QA 频道 `#product-lead-test` 发消息。

**入站**（Lead pane 逐字）:
```
← discord · xrliannie_96634: FLY-1663 QA round-trip: 在线吗？请回一句话。
```
**出站**（Discord 频道内，`qa-lead-B APP` 06:36，带 reply 引用我的消息）:
> [FLY-1663] 在线 ✅ QA round-trip 收到，flywheel-test-2 正常在线。
> （注：Bridge `/api/chat-threads/send` 当前不可达 — localhost:19872 connection refused，
> 两次尝试均失败，故按规则 fallback 到频道顶层回复。）

不但通了，Lead 还正确判断出 Bridge 不可达（那是我故意单独起 Lead、没起 slot Bridge）并按规则降级到顶层回复
—— 说明它不是复读，是真的在按规则工作。

## 🎉 §15.2 记忆延续 —— 真 Lead 上验通

杀掉真 Lead 的 body → launchd KeepAlive 重拉 → 新一代:

```
session id（重启前）: 3a93fa10-095a-4a1f-b45c-59795d6b2b06
新一代 pane 日志    : Resuming session 3a93fa10-095a-4a1f-b45c-59795d6b2b06
runs 1 -> 2 ; manifest.pid 重新绑定到新 server (11952)
```
**同一个 session id，走的是 `--resume`**，不是 fresh。4/5 通过（第 5 项是我尺子的问题，见下）。

## 其余全部复验通过

| 项 | 结果 |
|---|---|
| F1 测试隔离（诱饵条件） | 5 套件全绿、诱饵 0 文件、生产三处 sha 未变 |
| F2 占用探针 + pid 落盘时机 | 10/10（两种误跑都 fail-loud、manifest.pid 未动、回滚资格保住） |
| 载体拓扑矩阵 Stage E | **15/15**（6 种拓扑 + hook 隔离 + 无孤儿 + manifest 跨代绑定） |
| F3 登录 shell 移出启动路径 | 保持（conf 仍带 `default-shell /bin/bash`） |
| 假 `jq not found` 告警 | **已消失**（pane grep 计数 0） |

---

## 🔴 仍未过：529 房无人值守跑不起来（0 成功 / 4 失败）

用**产品默认值**（零 override）跑 `scripts/test-deploy.sh 2 --from-branch flywheel-FLY-1663`：

| 运行 | 结果 |
|---|---|
| 06:20 单跑 | FAIL `topology verification failed … manifestPid= socket=` |
| 06:47 可靠性脚本 run 1 | FAIL（182s，同上） |
| 06:50 run 2 | FAIL（178s，同上） |
| 06:53 run 3 | FAIL（177s，同上） |

**0/4。** 三次耗时几乎相同（~180s），是 verify 预算走完。

**但同一份 plist 我手工 bootstrap 是稳的**（本轮 10s 发布；上一轮 3/3 约 20s），
而且我用带轮询的 watcher 跑 `test-deploy` 时，Lead 这一步**成功**了
（06:57 那次 `Lead flywheel-test-2 ready (lease alive)`，发布在 t=30s）。
也就是说：**无人值守跑必挂，我在旁边轮询 socket 反而会过。** 这个反差本身就是线索
（怀疑 `qa_launchd_lead_verify` 那个每 0.1s 一次、每轮 `launchctl print` + 2 次 `jq` 的紧循环
在和刚起的 body 抢 CPU；但我没证到，**所以只作为线索提出，不当结论**）。

对运维的实际含义：**operator 正常敲 `test-deploy.sh` 就是失败**，Phase 0 跑不动。

### 附带澄清（不算 PR 的账）

那次 06:57 的 deploy 最终仍 rc=1，死在 `ERROR: Bridge process died`，
根因是 `listen EINVAL` 落在我这个 Runner 过长 `TMPDIR` 下的 tsx pipe（macOS unix socket 路径上限）——
**已知环境坑，不是本 PR 的问题**。可靠性那 3 次我已把 `TMPDIR` 换短，它们挂在 Lead 这一步，与 Bridge 无关。

## 尚未验证

- **§15.3 cmux 同 ref 重连**：完全没验。
- 生产 label 的 v1↔v2 切换 / 回滚实跑：没做（本来也在 PR scope 之外）。
- 529 房在修好可靠性之后的连续 3 次绿：待复验。

## 我自己这一轮的一处尺子问题（更正）

`verify-resume.sh` 的 R1「server survived body death」是**假失败**：
我的探针是 `pgrep -f "tmux -D -S <socket>"`，老 server 和 KeepAlive 拉起的新 server **匹配同一个模式**，
所以它看不见中间那个空档。R2/R4 已证明新一代是**不同 pid**（`runs 1→2`）——
老的必须先退出 launchd 才会重拉，所以收口是正常的。Stage E 15/15 也反复证过。
**这不是产品缺陷，别去追。**

## 生产隔离

载体 QA 只用隔离 label `com.flywheel.qa1663.a` + 沙箱 `/tmp/f1663qa`；529 QA 用 slot 2 独立 label；
`launchctl` 全走 FLY-913 受审计 bypass；Discord 只碰隔离 QA 频道 `#product-lead-test`。
`test-teardown.sh 2` 已跑完（label 已消失），沙箱 plist 已删，Chrome tab 已关。
**生产 `~/.flywheel/projects.json` 自第 1 轮 02:18 恢复后再未变动**（16 Lead / 8102B），
Bridge `ok`，17 个 Lead label 全在。

## 建议

1. 把 529 无人值守这条修到能连绿 3 次 —— 这是现在唯一挡着的东西。
   线索：verify 紧循环与 body 启动抢资源；可考虑把轮询间隔放宽 / 用等待事件代替忙轮询 /
   把 `launchctl print` 的调用频率降下来。
2. 补 §15.3 cmux 同 ref 重连验收。
3. 修完后我这边复跑即可，脚本都在 `/tmp/f1663qa/`：
   `verify-f1.sh`(5 套件+诱饵) · `verify-f2.sh`(10/10) · `stage-e.sh`(15/15) ·
   `verify-f3-shell.sh`(10/10) · `verify-resume.sh`(真 Lead resume) ·
   `deploy-reliability.sh`(529 无人值守 3 连跑) · `verify-auth-env.sh` / `bisect-auth.sh`(USER)。
