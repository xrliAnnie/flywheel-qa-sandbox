# FLY-2780 谷歌 AX / Agent Substrate 增量研究 — 调研

Issue: FLY-2780 (https://linear.app/geoforge3d/issue/FLY-2780/产品研究小红书-谷歌开源-agent-编排器-ax920-只做-7-月之后的增量哪些值得-flywheel-学founder-2026-09)
日期: 2026-09-22
基于: exploration.md

---

## 0. 一手来源清单（全部实读，非转述）

| 来源 | 取法 | 取证时间 |
|---|---|---|
| `github.com/google/ax` 仓库元数据（license / 创建时间 / star / 最后 push） | `gh api repos/google/ax` | 2026-09-22 |
| AX `README.md` | `gh api .../contents/README.md` 解码全文 | 2026-09-22 |
| AX `DESIGN.md`、`docs/concepts.md`、`docs/sandbox.md`、`docs/manifests.md`、`docs/runner.md` | 同上 | 2026-09-22 |
| AX `pkg/apis/v1alpha1/ax.proto`（387 行，全文） | 同上 | 2026-09-22 |
| AX `internal/controller/reconciler.go` | 同上 | 2026-09-22 |
| `github.com/agent-substrate/substrate` 仓库元数据 + `README.md` | `gh api` | 2026-09-22 |
| Substrate `docs/architecture.md`（27,951 字节，全文）、`docs/roadmap.md`（全文） | 同上 | 2026-09-22 |
| Substrate `demos/claude-code-multiplex/`（README + workload/run.sh + actor template + ui/server.go） | 同上 | 2026-09-22 |
| Google Cloud 官方博客 *Agent Executor, Google's distributed Agent Runtime* | WebFetch | 2026-09-22 |
| HN 原帖 49780797（657 分 / 297 评论，2026-09-20 22:32 UTC） | Algolia HN API，读原始评论文本 | 2026-09-22 |
| 本机 runner 内存实测 | `ps -eo rss,etime,comm` + `sysctl hw.memsize` | 2026-09-23 02:45 UTC |

**未使用**：小红书帖正文本身（只作为线索），以及 DEV.to / InfoQ / explainx / saascity 等二手聚合（只用于找一手链接，结论不引用）。

---

## 1. AX 确认开源了吗？什么 license？—— 结清 7 月挂账

**是，确认开源。7 月那条「未核实」现在可以销账。**

| 项目 | 仓库 | License | 创建 | star | 最后 push |
|---|---|---|---|---|---|
| AX（Agent Executor） | `github.com/google/ax` | **Apache-2.0** | 2026-03-30 | 7,725 | 2026-09-20 |
| Agent Substrate | `github.com/agent-substrate/substrate` | **Apache-2.0** | 2026-05-13 | 3,018 | 2026-09-22 |

Google Cloud 官方博客原句：

> "Today, we're introducing **Agent Executor**, Google's open-source runtime standard for agent execution, resumption, and distributed deployment."

### 但两个都不是可以依赖的东西 —— 这一点媒体没说

AX README 第一屏就是一条警告框：

> "We are still actively refining our core concepts, protocols, and specifications.
> We will likely to introduce major breaking changes prior to a stable release."

API 版本是 `ax.io/v1alpha1`。

Substrate README 更狠，两处：

> "NOTE: This is not an officially supported Google product. This project is not eligible for the
> Google Open Source Software Vulnerability Rewards Program."

> "Agent Substrate is currently in early development. It is not ready for production use, and the
> APIs are almost guaranteed to change."

**结论**：开源属实、许可证干净（Apache-2.0，可商用可改）。但两个项目都在 alpha，Substrate 连官方支持都没有。
作为**读设计**的对象完全合格；作为**依赖**，今天不合格。

---

## 2. 四个原语，对得上我们哪几块

AX 只有四个原语，全部是 `ax.io/v1alpha1` manifest，`ax apply -f task.yaml` 提交。

| AX 原语 | 它在管什么（AX 自己的说法） | Flywheel 今天的对应物 | 判断 |
|---|---|---|---|
| **Task** | 隔离沙箱里跑一段不可信 agent 代码，带 CPU/内存上下限 | tmux pane + git worktree 里的一个 Claude Code 进程 | **概念一一对应**，但我们缺「资源上限」和「沙箱」这两层 |
| **Workspace** | 预先接好 Git 仓库、MCP server、skill 包，让 agent 一上来就是热的 | worktree + CLAUDE.md + skill 注入 + `onboard` skill | **我们已经有等价物**，只是散在脚本和约定里，不是声明式资源 |
| **Gateway** | 出站流量锁进一份显式 host 白名单 | 无 —— runner 能访问全网 | 我们没有；单机 Mac 上做网络围栏成本高收益低 |
| **Model** | 命名的模型配置：provider、model id、温度等参数、指向 K8s secret 的密钥引用 | dispatch label > `roles.<role>.model` > env 三级解析 | **我们已经有，而且更贴合**；AX 多一个「密钥集中轮换」的好处 |

外加两个动词：`ax suspend` / `ax resume`（挂起与恢复）、`ax ssh`（钻进正在跑的 agent 里看它在干嘛）。

### 一条值得 Annie 知道的设计分歧

AX `docs/concepts.md` 里对 Task 的自述：

> "An agent is not one process that runs to completion; over its lifetime it plans, delegates, retries,
> and fans work out. **AX does not try to model that shape.** It gives you one primitive that is cheap to
> create, isolate, suspend, and throw away, and lets the agent compose as many of them as its work demands."

这跟 Flywheel 是**对立的设计选择**：AX 把「工作怎么展开」留给 agent 自己决定，只提供廉价的执行单元；
我们把形状建进了 DAG pipeline（design → implement → qa），由编排器决定。

**我不建议我们改。** 原因是我们的形状不是 agent 自决的，是**founder 门驱动**的 —— 每一个 stage 边界上都有一个
人要看、要点头的动作。AX 那套「agent 自己扇出一棵树」的假设里没有这个人。但这条差异值得记在账上：
如果哪天我们想让 runner 自己开子 runner（FLY-1022 那一族），AX 的 Task 原语就是现成的参考形状。

---

## 3. ⭐ 挂起 / 恢复：机制拆到底，以及那句小红书文案哪半句是假的

这是本单最值钱的一节。

### 3.1 机制（一手，Substrate `docs/architecture.md`）

- **谁在做快照**：默认 gVisor（`ateom-gvisor` 进内部 pod 执行 `runsc checkpoint / restore`）；
  另一条路是 microVM（Kata + Cloud Hypervisor，用 `userfaultfd` 做内存需求分页）。
- **快照包含什么**：内存 RAM 状态 + 容器可写层（"working memory"）。两者目前绑在同一个版本化快照里。
- **快照存哪**：GCS 之类的对象存储。快照上传完，物理 worker 被擦干净、还回 `WorkerPool`。
- **恢复怎么触发**：请求打到 Gateway → Gateway **把请求挂住**、问控制面这个 actor 在哪 →
  控制面从 pool 认领一个热 worker → `atelet` 让 `ateom` 把快照恢复进沙箱 → Gateway 开隧道把原始请求转过去。
- **指标口径（Substrate README 自述）**：`sub-500ms resume`、`>500 次 suspend/resume 激活/秒`、
  比标准容器运行时高 `10x` 密度。demo 视频：**250 个有状态 actor 挤在 8 个物理 pod 上**（30x+ 超订）。

### 3.2 关键发现：恢复是自动的，挂起不是

这是我读源码读出来的、任何一篇二手报道都没写的一条。

Actor 的状态机（`docs/architecture.md` 的 UML 图，逐字）：

```
[*]       --> SUSPENDED : CreateActor
SUSPENDED --> RESUMING  : ResumeActor
RESUMING  --> RUNNING   : restore / boot complete
RUNNING   --> SUSPENDING: SuspendActor
SUSPENDING--> SUSPENDED : checkpoint complete
RUNNING   --> PAUSING   : PauseActor
PAUSING   --> PAUSED    : node-local checkpoint complete
PAUSED    --> RESUMING  : ResumeActor (pinned to the snapshot's node)
PAUSED    --> SUSPENDING: SuspendActor (uploads the node-local snapshot)
SUSPENDED --> [*]       : DeleteActor
```

**每一根箭头都是一个显式 API 调用。** Phase 3 那节的第一句就是：

> "### Phase 3: Hibernation (`SuspendActor`) — Triggered by an explicit `SuspendActor` call."

唯一的例外是恢复：Phase 2 写 "Triggered by an inbound request at the Gateway **or** an explicit API call" ——
流量能自动唤醒，但**没有任何东西会自动让它睡**。

复核过的反证（都是零结果，且范围写明）：
- `search/code repo:agent-substrate/substrate autosuspend OR auto_suspend` → **0 命中**。
- `idleTimeout` 在全仓只命中 `cmd/atenet/internal/router/xds.go` 及其测试 —— 那是 Envoy 的 HTTP 空闲超时，不是 actor 生命周期。
- `cmd/ateapi`（控制面）里的 `idle` 只出现在 worker 状态枚举（`IDLE` / `BUSY`），不是计时器。
- `preempt` 在控制面 **0 命中**；`evict` 只命中连接池（`dialer.go`）。**没有抢占式挂起。**
- `docs/roadmap.md` 里「**Automated Garbage Collection: Background cleanup of idle actors based on
  configurable TTL**」躺在 *"Additional ideas we are thinking about"*（还在想的点子）那一节 —— **还没做**。

**唯一的矛盾证据，如实记下**：`demos/claude-code-multiplex/README.md` 里有一句
"Substrate notices the inactivity and suspends the agent after a short idle window."。
我在控制面、demo 的 UI server（`ui/server.go`）、demo 的 workload 入口（`workload/run.sh`）、
以及安装器的 demo 包（`cmd/ate-setup/internal/demos/claudemultiplex/`）里**都没找到**发起这次挂起的代码。
→ 我的判断：这是 demo README 的宣传句，**超出了代码能支持的范围**；权威以 `architecture.md` 的 Phase 3 为准。
但这条我标**不完全确定**（我没有 K8s 集群去实跑 demo 验证）。

### 3.3 HITL（等人工审批）这一格比上面还空

Google 官方博客把「等人确认」列成头号场景：

> "Long-running execution requires the ability to resume after outages or agentic interruptions such as
> **human-in-the-loop (HITL) confirmations**. Agent Executor provides this backend resilience automatically
> for any actor ... through its event log and snapshotting."

但 AX 今天的 proto 里（`pkg/apis/v1alpha1/ax.proto`）：

```proto
// TaskStatus
  PendingApproval pending_approval = 5;

message PendingApproval {
  string id = 1;
  string action = 2;
  google.protobuf.Timestamp requested_at = 3;
}
```

紧挨着的 `TaskSpec` 里：

```proto
  // Field 9 was `policies` (budget and approval config), removed for now.
  reserved 9;
  reserved "policies";
```

即：**状态面留了「有一个待审批」这个格子，配置面（谁需要审批、审批什么）被拿掉了。**
全仓代码搜索 `PendingApproval`，只命中 `ax.proto` 和它生成的 `ax.pb.go` —— **没有任何一行业务代码写入或读出过它**。
reconciler 里的挂起逻辑只有一条路径：`if task.Spec != nil && task.Spec.Suspend { ... SuspendActor ... }`，
也就是人（或上层系统）把 `spec.suspend` 翻成 true。

### 3.4 所以那句小红书文案

> 「空闲 agent 被 checkpoint 挂起，等模型响应、工具调用或人工审批时释放算力，亚秒级恢复」

- 「checkpoint 挂起」「亚秒级恢复」——**属实**，机制真实存在，指标是官方自述口径。
- 「空闲 agent 被挂起」「等人工审批时释放算力」——**今天不属实**。平台提供的是**能力**，不是**策略**。
  谁来判断「它空闲了」「它在等人」并按下挂起按钮，AX / Substrate 都没做，留给上层。

**这恰恰是对我们最有用的一条信息**：连 Google 都把「何时挂起」判给了上层框架。在我们这里，上层框架就是我们自己。

### 3.5 我们这边的数量级（本机实测，按身份拆开）

> ⚠️ **本节的第一版把收益说大了约 20 倍，已整节重写。** 第一版把整机所有 `claude` 进程算成了
> 「推荐方案能拿回来的内存」，其中一半是 Lead —— Lead 本来就要常驻在线等消息，推荐方案根本碰不到它们。
> 下面是按身份拆开重量的结果。

采样：2026-09-23 02:55–02:58 UTC，Annie 的 Mac（48 GB）。
口径：`ps -eo pid,rss,etime,comm` 只取 `comm == claude`；用 `lsof -a -p <pid> -d cwd` 拿每个进程的工作目录做分类；
用 `ps eww` 读 `FLYWHEEL_RUNNER_STATE_DIR` 拿 exec-id，才能把进程和 issue 对上。
**不含** 每个 runner 旁边的 `bun`（60–90 MB）和 `node`（约 38 MB）辅助进程。

#### 按身份拆

| 身份 | 进程数 | RSS 合计 | 推荐方案碰得到吗 |
|---|---|---|---|
| **Lead**（`~/.flywheel/lead-workspace/*`，含一个测试 slot lead） | 14 | **4.65 GB** | ❌ **碰不到** —— Lead 的职责就是常驻等消息 |
| **runner**（`~/Dev/flywheel-FLY-*` worktree） | 9 | **4.48 GB** | 只碰得到其中停在卡上的那几个 |
| 其他（主仓 checkout、personal-assistant） | 2 | 0.68 GB | ❌ |
| 合计 | 25 | **9.81 GB** / 48 GB |  |

（Lead 在同一台机器上独立量过一次，形状一致；绝对数因进程进出略有差异 —— 这是快照，不是稳态。）

#### 真正的上限：此刻有几个 runner 停在 founder 卡上

取法：从 CommDB（`~/.flywheel/comm/flywheel/comm.db` 的 `mailbox`）取
`checkpoint='founder_review' AND resolved_at IS NULL AND superseded_at IS NULL` 的卡，
按 `from_agent`（= exec-id）跟上面那张活进程表求交集。

结果：**4 张未解决的 founder_review 卡，持卡的 runner 全部还活着。**

| issue | pid | RSS | 卡开了多久 | 123 秒窗口内 CPU | 判定 |
|---|---|---|---|---|---|
| **FLY-2769** | 20615 | **380 MB** | **19.7 小时** | 1.02 s（**0.8%**） | **真的停着等** —— 只剩轮询心跳 |
| FLY-2777 | 49755 | 466 MB | 0.5 小时 | 4.00 s（3.3%） | 还在动 |
| FLY-2779 | 41605 | 489 MB | 0.1 小时 | 5.28 s（4.3%） | 还在动 |
| FLY-2780（本单，我自己） | 49430 | 523 MB | 0.2 小时 | 6.32 s（5.1%） | 正在改这份文档，**不算停着等** |
| 合计 | | **1.86 GB** | | | |

CPU 口径：`ps -o time=` 在 02:56:01 和 02:58:04 两次取值求差（123 秒窗口）。
**注意：停着等 ≠ 0 CPU** —— 停在卡上的 runner 仍在轮询，只是 CPU 占用掉到约 0.8%，
跟正在干活的 4–5% 差了约 6 倍。这个比值才是「停着」的判据，不是「CPU 归零」。

#### 所以推荐方案的真实收益是多少

- **瞬时上限**：此刻真正停在卡上等 founder 的只有 **1 个 runner，约 0.38 GB**。
  不是第一版说的 8.2 GB —— 那个数错了约 20 倍。
- **4 张卡全部的持卡内存**是 1.86 GB，但其中 3 个 runner 此刻仍在干活，不该记进收益。
- **真正的成本口径是时间积分，不是瞬时 GB。** FLY-2769 已经用 0.38 GB 钉了 19.7 小时 ≈ **7.5 GB·小时**。
  另外 3 张卡刚开；如果它们也像 FLY-2769 那样等一整夜，这一批就是约 1.9 GB × N 小时。

  → 所以推荐方案的价值不该说成「立刻腾出多少 GB」，而是
  **「把一张卡的等待时长整个从内存账单里摘掉」**。等得越久，省得越多；卡答得快，本来就没什么可省。

#### 一条顺带核实、意外干净的事实

另外还有 **15 张未解决的 `approve_to_ship`（ship 审批）卡**。我逐个跟活进程求交集，
**全部属于已经退出的 runner —— 一个都不占内存**。
也就是说「停着等 founder 占内存」这个病，今天**只发生在 `founder_review` 这一种卡上**，
ship 审批那条线已经不留活进程了。这缩小了问题面，也说明这条路走得通。

### 3.6 我们能借什么 —— 三档，从便宜到贵

> 这是**效果清单**，不是迁移方案。是否立工程单由 founder 定（本单不做）。

**档 1 —— 门一发出就不留活进程（推荐）**
把「等 founder」从「**进程**在等」改成「**记录**在等」：卡发出去后 runner 直接退出、内存全部归还系统；
回复到达时再按 issue / attempt 把它拉起来。

- **为什么推荐**：这是唯一**不用换操作系统**就能把「停在卡上」这部分内存还回去的做法。
- **收益说清楚（第一版在这里说大了约 20 倍）**：它释放的只是「已经交出卡、正停着等 founder」的那些 runner
  —— 见 §3.5，此刻 **1 个、约 0.38 GB**。**既不是** runner 那 4.48 GB，**更不是**整机的 9.81 GB；
  Lead 那 4.65 GB 它根本碰不到。真正的口径是**时间积分**：FLY-2769 一个就已经是 0.38 GB × 19.7 h ≈ **7.5 GB·小时**。
- **「拉起来」有两条路，取舍不同**（第一版只写了 ①，漏了 ②；② 由 founder 2026-09-23 指出）：
  - ① **照 `progress.md` ledger 重来** —— 上下文是新的（顺带治了「等一夜醒来上下文早凉」这个病），但要重读一批文档。
  - ② **按 session ID 直接续** —— Claude Code 与 Codex 的**会话本身持久化在磁盘上**，
    `claude --resume` / Codex 的 resume 能直接接上，不必重读一遍；便宜得多，代价是把旧上下文原样接回来。
    **这条在 macOS 上就能走，不需要 Linux 容器**，因而绕开了档 3 的整机改造。
  - 两条都**不是亚秒恢复**。选哪条、或按等待时长分档，**留给 FLY-2782**。
- **我们已经有的地基**：`progress.md` 进度账本、resume dispatch（`$FLYWHEEL_PROGRESS_PATH`）、
  以 `questionId` 为锚的 gate/check 机制。三块都在。
- **它治不了什么**：卡答得快的时候本来就没什么可省（§3.5 那 4 张卡里 3 张才开了几分钟）。
  收益完全来自**长等待** —— 值不值得做取决于「卡平均要等多久」，不取决于一个瞬时 GB 数。
- **我没查的**：「重新拉起」在今天的 DAG 里多贵（attempt 计数、TURN、门绑定会不会被打断），
  以及 `claude --resume` 的恢复完整度。两条都属于 **FLY-2782** 的范围，本单不展开。

**档 2 —— 只冻结、不销毁**
macOS 上没有 `runsc checkpoint`，但有 `SIGSTOP`：进程冻住、CPU 归零、可被系统换页出去。
- 拿到：省 CPU、省掉空转轮询。
- 拿不到：**不省 RSS**（页还挂在进程上，只是可能被换出）。也就是说 §3.5 那笔「停在卡上的内存」它一点也拿不回来。
- 定位：如果档 1 太贵，这是一个便宜的半步。

**档 3 —— 真 checkpoint / restore（不建议）**
要拿到 AX 那种亚秒恢复，得让 runner 跑在能被 checkpoint 的沙箱里。CRIU 不支持 macOS；
gVisor / Kata 都是 Linux。这意味着把 runner 从「Annie Mac 上的 tmux 进程」搬进 Linux 容器或 VM ——
那是整机架构改造，不是「借一个点」。7 月那条「我们不能直接采用」的结论在这里再次成立，原因没变。

**明确不建议借的**：AX 的 Task 树、Gateway 网络围栏、以及整个 K8s 层。对单机 Mac 是纯负担。

---

## 4. generative workspace 对我们有没有用

**先确认它真的存在**（`docs/concepts.md`，一手）：

> "A binding can also carry a `goal`, a plain-language description of the environment the task needs.
> On first boot the runner hands that goal to an agent that finishes the setup, for example installing a
> toolchain or dependencies, so the task's own command starts in a ready environment."

README 的例子：

```yaml
  workspaces:
    - name: golang
      goal: "Ensure that Go tool chain is available and is built from source"
```

AX 自己的组件会去读 `Model` 资源来「从一个 goal 规划出 workspace」。

**对我们：用处很小。**

它解决的问题是「一个**干净沙箱**要从零变成能干活的环境」。我们没有这个问题 ——
我们的 runner 跑在 Annie 的 Mac 上，工具链是宿主现成的；我们的等价物是
worktree + CLAUDE.md + skill 注入 + `onboard` skill，而且**是确定性的**（不用让一个 agent 去猜装什么）。
拿一个不确定的自然语言步骤换掉一个确定的脚本步骤，是往下走不是往上走。

**唯一值得记的一点**：AX 把「环境从哪来」写成了**声明式资源**，可以声明一次、被很多 Task 绑定；
我们是散在 launcher 脚本 + CLAUDE.md + onboard skill 里的隐性约定。
如果哪天要跑多机 / 多宿主（FLY-1005 那一族），「声明式 workspace」是对的抽象。**今天不是。**

---

## 5. HN 的质疑成不成立

**成立，而且可以用 AX 自己的文档复核。** 但要分层看 —— 两边吵的其实是两层东西。

### 5.1 「不低侵入」——成立，原文自证

AX README 的 quickstart 自己写着：

> "You need a Kubernetes cluster, `ko` (`brew install ko`), a container registry your cluster can pull from,
> and a reachable Agent Substrate Control API (in-cluster default: `api.ate-system.svc.cluster.local:443`)."
> "This deploys Redis, then builds and deploys the control plane images with `ko`."

HN 上 `pama` 的反驳就是把这几行原样贴出来。这条不用辩，官方 README 就是证据。

### 5.2 「一整个栈」—— 成立，但只对 AX 成立，不对 Substrate 成立

HN 上信息量最高的一条（`jauntywundrkind`，比较 AX 与 Google 自家的 Scion）：

> "With Ax/Agent Substrate, you are opting in to a pretty huge stack that is just Agent Substrate,
> that is their runners, their harness, their substrate."
> "'low opinion' means build something new, from scratch, atop this brand new platform."

反方（`solarkraft`）引官网的 "low-opinion / 跑的东西不必是 AI agent" 反驳。

**我的判断：两边说的是不同层。**
- **Substrate 那层确实 low-opinion** —— 它管的是标准 OCI 容器，README 明说 framework / harness 无关，
  而且**真的有一个跑 Claude Code 的 demo**（见 5.4）。
- **AX 那层不是** —— AX 有自己的 runner 契约（`docs/runner.md` 专门讲「怎么造你自己的 runner 镜像」）、
  自己的 manifest 形状、自己的 CLI。要用 AX，就得按 AX 的样子重建 harness。

我们如果真要借，**借的是 Substrate 的思路，不是 AX 的形状**。这跟 7 月的结论一致。

### 5.3 「几十亿 agent」—— 那个数字是被放大的

三个口径，三个数：

| 出处 | 原话 | 单位 |
|---|---|---|
| Google 官方博客 | "hundreds of millions of registered agents" | **数亿**，注册量 |
| AX README | "run billions of autonomous agent **workloads**... billions of **tasks** per cluster" | 数十亿，**任务**量 |
| 小红书帖标题 | 「可跑几十亿 Agent」 | 数十亿，**agent** |

HN 上有人问 "who is running BILLIONS of agents?"，并指出现实是「几十、几百、顶多几千个同时」。
这个质疑打的是被媒体拉平的口径 —— **task ≠ 并发 agent**。AX README 自己没说错，是传播链把它拧成了「几十亿 agent」。

### 5.4 一条顺带的发现（我认为比 AX 本身对我们更有价值）

Substrate 的 demo 里有一个 **`demos/claude-code-multiplex`**：三个 Claude Code agent（luna / mars / orion）
共享**两个** pod，第三个挂起等 pod 空出来。它的 workload 就是一个 while 循环跑 `claude --print "$TASK"` 然后 sleep。
这是我们这个形状（Claude Code runner 被复用到有限硬件上）在 Google 那边最接近的对照实验。

另外，HN 讨论里带出了 Google 的**另一个**项目 **Scion**（`GoogleCloudPlatform/scion`，2026-04-07 开源）：
「agent 的 hypervisor」，**每个 agent 一个容器 + 一个 git worktree + 自己的凭据**，
支持 Docker / Podman / Apple container / Kubernetes，已经能跑 Claude Code / OpenCode / Codex / Gemini。

> **「每个 agent 一个 worktree + 自己的凭据」—— 那就是 Flywheel 今天的形状。**
> Scion 的形状比 AX 离我们近得多，而且它不要求 K8s。

→ **已单开 FLY-2783**（founder 2026-09-23 同意），研究在那张单里做，本单不展开。
本节对 Scion 的描述来自 HN 评论 + 搜索结果摘要，**我没有读过它的仓库**，所以这条标**未一手核实**，
留给 FLY-2783 去一手核。

---

## 6. 增量结论汇总

| # | 问题 | 结论 | 确定度 |
|---|---|---|---|
| 1 | AX 开源了吗 | **是**，Apache-2.0，`github.com/google/ax`。但 `v1alpha1`，README 预告会破坏性变更；Substrate 非官方支持、明说未就绪生产 | 一手确认 |
| 2 | 原语对不对得上 | Task ≈ 我们的 runner（我们缺资源上限/沙箱）；Workspace 我们已有等价物；Model 我们已有且更贴合；Gateway 我们没有也不需要 | 一手确认 |
| 3 ⭐ | 等审批挂起怎么做的 | 机制真实（gVisor runsc checkpoint，sub-500ms resume）；**但自动化不存在** —— 恢复自动、挂起必须显式调用；HITL 的配置面被从 proto 里移除了 | 一手确认（demo README 有一句矛盾宣传语，已标注） |
| 3b | 我们能借什么 | 推荐**档 1：门一发出就不留活进程**，靠 `claude --resume` / Codex resume 按 session ID 续（macOS 上可行）→ **已单开 FLY-2782**。**收益只限停在卡上的 runner** —— 此刻 1 个、约 0.38 GB（Lead 的 4.65 GB 碰不到）；真正的口径是时间积分（FLY-2769 已 ≈ 7.5 GB·小时） | 建议 + 本机实测 |
| 4 | generative workspace | **用处很小** —— 它解决「干净沙箱从零起」，我们没这个问题，且我们的确定性方案更好 | 一手确认 |
| 5 | HN 质疑 | **成立**，README 自证需要 K8s+ko+registry+Redis。但「庞大栈」只对 AX 成立，不对 Substrate 成立；「几十亿 agent」是传播链拧出来的口径 | 一手确认 |
| 6 | 顺带 | Google 的 **Scion**（每 agent 一容器 + 一 worktree，不要 K8s）形状比 AX 离我们近得多 → **已单开 FLY-2783** | **未一手核实**，留给 FLY-2783 |

## 7. 我没有做到的（边界，如实写）

- **没有实跑。** 我没有 K8s 集群，没有部署过 AX 或 Substrate，所有机制结论来自读 proto / 源码 / 架构文档，
  不是运行观察。指标（sub-500ms、500/s、30x 超订）是**项目自述口径**，我没有独立复现。
- **demo README 那句矛盾没有被证伪到底。** 我只能证明「控制面里找不到自动挂起的代码路径」，
  不能证明「实跑时不会发生」—— 也许在我没读到的地方。
- **Scion 没读仓库**，只有二手描述。
- **本机内存是快照，不是稳态。** §3.5 的进程表取自 2026-09-23 02:55–02:58 UTC 两次采样；
  进程进出会让绝对数变化（Lead 在几分钟前独立量的那次就多 5 个进程、多约 1.2 GB）。辅助进程（bun / node）未计入。
- **「停着等」的判据是 CPU 占用比值，不是绝对静止。** 停在卡上的 runner 仍在轮询（约 0.8%），
  与干活中的（4–5%）差约 6 倍；我用这个比值判定，没有别的更硬的信号。单个 runner 是否「只剩等卡」我不能 100% 确证。
- **收益是时间积分，我只量到一个时刻。** 「卡平均要等多久」需要跨多天的统计，本单没做 —— 没有它，
  就不能把推荐方案的收益说成一个年化/日化的 GB 数。
- **档 1 的代价没估。** 「重新拉起一个 runner」在今天的 DAG 里多贵（attempt 计数、TURN、门绑定），我没查 —— 留给 **FLY-2782**。
- **`claude --resume` 这条路我没验过。** 它是 founder 指出的方向，本单只把它写进结论，没有实跑确认会话恢复的完整度与代价；这属于 FLY-2782 的范围。
