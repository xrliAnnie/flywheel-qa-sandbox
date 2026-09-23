# FLY-2783 Google Scion 产品研究 — 调研

Issue: FLY-2783 (https://linear.app/geoforge3d/issue/FLY-2783/产品研究-google-scion每个-agent-一个容器-一个-git-worktree它是给谁用的什么场景哪些值得-flywheel)
日期: 2026-09-22
基于: 无（本 issue 是 FLY-2780 的衍生调研；FLY-2780 的文档未合入本工作树，本文不依赖它）

## 0. 取证方式与边界（先说清楚哪些是一手的）

| 结论来源 | 做了什么 | 强度 |
|---|---|---|
| 仓库一手 | `git clone --depth 200 GoogleCloudPlatform/scion`，读 README / docs-site 全量 / `harnesses/*` 的 `config.yaml`、`README.md`、`capture_auth.py` | 一手 |
| GitHub API 一手 | `gh api repos/GoogleCloudPlatform/scion`（star / license / release / contributors / commit 活动） | 一手 |
| 本机实测 | 下载官方 `scion-darwin-arm64` v0.3.0-preview.3 二进制到 scratchpad，隔离 `HOME` 跑 `version` / `doctor` / `init --machine` / `init` / `start --help` | 一手实测 |
| AX 对照 | `gh api repos/google/ax` + README | 一手 |
| **未验证** | **没有真正启动过一个 agent 容器**（原因见 §6），所以关于「跑起来之后好不好用」的一切都只是文档转述 | **文档级** |

红线：本机试跑全程在 scratchpad 目录、`HOME` 指向假家目录，没有装 Homebrew 包（宿主工具链护栏 FLY-1944 正确拦下了 `brew install`），没有启动任何容器运行时，没有改生产。

---

## 1. 一手核实：Scion 是什么

**一句话**：Scion 是一个挂在 Google Cloud 名下、主要由一个人维护的开源项目，把「一群 AI coding agent 协作干活」这件事做成了一个平台——每个 agent 一个容器、一套自己的凭据、一个自己的工作目录，agent 之间能互相发消息、派活、汇报。

### 硬事实（2026-09-22 取）

| 项 | 值 |
|---|---|
| 仓库 | `GoogleCloudPlatform/scion` |
| License | Apache-2.0 |
| 语言 | Go（Web UI 用前端框架，编译进单一二进制） |
| 仓库创建 | 2026-03-10 |
| Star / Fork | 1718 / 269 |
| 最新 release | `v0.3.0-preview.3`（2026-09-22），**全部 release 都是 prerelease**，另有每日 `nightly-*` |
| 提交活动 | 近 52 周 4387 次提交；近 7 天 200 次提交；PR 编号已到 #1846 |
| 贡献者 | GitHub 记 32 人，但最近 200 个提交里 **191 个来自同一位维护者** |
| 官方定位 | README 明写 **"This is not an officially supported Google product."**，且不在 Google 开源漏洞奖励计划范围内 |
| 项目自述 | "actively developed, pre-1.0"；"APIs and configuration may change between releases" |

### 成熟度判读（我的判断，不是它的自述）

1. **它不是 Google 的产品，是一个挂在 Google 组织下的实验性项目。** 挂在 `GoogleCloudPlatform` 组织下容易被误读成官方产品，README 第一句免责声明否掉了这个读法。
2. **单人维护 / bus factor = 1。** 近期提交 95% 出自同一位维护者。这不是「不能用」，但它意味着路线图和维护节奏取决于一个人。
3. **速度快到有代价。** 一周 200 个提交、每天 nightly、无稳定版。我在一手取证中直接撞到三处文档/实现漂移：
   - release tag 写 `v0.3.0-preview.3`，二进制自报 `v0.3.0-preview.1`（版本戳没对齐）；
   - `harnesses/README.md` 说默认只装 `{claude, gemini}`，而实测 `scion init --machine` 一次性铺了 9 个 harness-config，全局默认 harness 是 `antigravity`；
   - README 说「macOS 默认用 Apple Container 运行时」，实测在 macOS 26.6.2 上生成的默认 profile 是 `runtime: docker`。
   单条都不致命，三条叠在一起说明：**文档不能当契约读，必须以实测为准。**

### 它的核心概念（一手读 `concepts.md` / `GLOSSARY.md`）

- **Agent**：一个有独立身份的 worker，通常是一个容器里跑一个 harness（Claude Code / Gemini CLI / Codex / OpenCode / Copilot / Hermes / Antigravity / grok-build / muse-code）。
- **Project**：一个 agent 命名空间，通常 1:1 对应一个 git repo。
- **Template**：agent 蓝图 = system prompt + 一组 skill。
- **Runtime**：容器技术，可选 Docker / Podman / Apple Container / Kubernetes / Cloud Run。
- **Hub**：控制面（可选）。没有 Hub 也能用——那是「Local 模式」。
- **四种运行模式**：Local（纯 CLI，无服务端）→ Workstation（本机跑一个 Hub+Broker+Web 的合体服务）→ 单节点托管 → HA 托管（Postgres + 对象存储 + 多副本）。

**关键：它不要求 Kubernetes。** K8s 只是四种 runtime 之一，Local 模式一台笔记本就能跑。这一点和 AX 完全相反（见 §3）。

---

## 2. 使用场景和适用人群（founder 的核心问题）

### Scion 是给谁用的

我按「什么人会在什么情况下真的去装它」排：

| 人群 | 场景 | 合不合适 |
|---|---|---|
| **想同时跑多个 coding agent 的个人开发者** | 一台机器上让 3–5 个 agent 并行改同一个 repo，互不踩脚；能随时 attach 进去看某个 agent 在干嘛 | ✅ 最贴合。Local / Workstation 模式，一条 `brew install` + 一条 `scion server start` |
| **小团队（2–10 人）想共用一批 agent** | 起一个便宜的单节点 Hub（一台 VM 或一个 Cloud Run 实例），大家从各自机器派活、在 Web 面板看进度、在 Slack/Discord 里跟 agent 对话 | ✅ 合适，但要有人当运维 |
| **平台工程 / 内部工具团队** | 给公司做「agent 工作台」底座：身份、权限、密钥、审计、多租户，自己在上面长业务 | ✅ 它 HA 模式就是为这个设计的（Postgres + GCS + 多副本 + OAuth 身份提供方 + Groups 访问策略） |
| **研究 agent 协作模式的人** | 它自称是「emerging agent collaboration patterns 的实践试验台」——Google 内部拿它做过软件移植、市场调研、产品测试；公开案例有 Scion Films（agent 剧组拍片）和 Relics of Athenaeum（纯 markdown 定义的多 agent 解谜游戏） | ✅ 这是它最本真的定位 |
| **只想要一个稳定工具、不想当小白鼠的人** | 要 SLA、要向后兼容、要出事有人兜 | ❌ pre-1.0、无稳定 release、非官方产品、单人维护 |

**一句话概括适用人群**：**已经在同时跑多个 coding agent、并且开始被「它们互相踩脚 / 凭据混在一起 / 不知道谁在干嘛」这三件事折磨的人。** 如果还只跑一个 agent，Scion 提供的一切都是纯成本。

### 它具体解决什么问题

Scion 的 README 把问题说得很准：agent 接的活越长越复杂，难点就从「模型行不行」变成了 **「谁负责哪块活、它们共享什么上下文、什么时候该来问人、你怎么看得见进度」**。它提供四样东西对应这四问：运行环境（容器）、通信（消息 / 广播 / 通知 / IM 桥）、身份（每 agent 独立凭据 + 角色）、可见性（Web 面板 / 日志 / `scion look` / `scion attach`）。

### AX 是给谁用的（对照用，一段话）

`google/ax`（7766 star，Apache-2.0，Go，2026-03-30 建仓）自述是 "Google's open agentic orchestration runtime"，目标是 **「在一个集群里跑数十亿个自主 agent 任务」**。它是声明式的、长得像 kubectl：你写 `Task` / `Workspace` / `Gateway` / `Model` 四种 YAML manifest，`ax apply -f task.yaml`，它负责沙箱隔离、预挂 git 仓库和 MCP、把出网流量锁到白名单、配置平台自己用哪个 LLM。它的部署前置是 **一整套集群设施**：一个 Kubernetes 集群 + `ko` + 一个集群能拉取的镜像仓库 + 一个可达的 Agent Substrate 控制面。笔记本上不是「装不了」，而是**得先把这一整套自己搭起来**——这个前置本身就把它挡在了单机场景之外。所以 AX 的人群是 **平台工程团队 / 基础设施团队**——那种「我要给全公司几百个工程师提供 agent 算力，要配额、要网络围栏、要成本控制」的角色。

成熟度也别读错：它确实有一个 **v0.3.0 发布**（2026-09-20，非预览标记），但仍是 0.x，API 版本是 `ax.io/v1alpha1`，README 首屏的警告框明写「稳定版之前很可能引入重大不兼容改动」。**它比 Scion 规整，但同样不是可以押生产的稳定件。**

**一句话对照**：**AX 是 agent 的 Kubernetes（集群级、声明式、给平台团队）；Scion 是 agent 的 docker-compose + 团队协作层（单机也能跑、命令式、给真正在用 agent 干活的人）。** 对 Flywheel 来说，Scion 是同类可比对象，AX 不是。

---

## 3. Scion vs AX 速查

| | Scion | AX |
|---|---|---|
| 定位 | agent 协作平台 | agent 工作负载编排运行时 |
| 最小部署 | 一台笔记本，`scion` CLI，无服务端 | 一个 K8s 集群 + 控制面部署 |
| 交互形态 | 命令式 CLI（`start` / `message` / `attach`）+ Web + IM | 声明式 YAML manifest + `ax apply` |
| 规模目标 | 一个人到一个小团队的 agent「班组」 | 每集群数十亿任务 |
| 成熟度 | 全 prerelease，非官方产品 | 有 v0.3.0 发布（9/20，非预览标记），但仍是 0.x、API 为 `v1alpha1`，README 首屏明写稳定版前会有重大不兼容改动 |
| Star | 1718 | 7766 |
| 对 Flywheel 的可比性 | **高**（形状几乎同构） | 低（我们没有集群，也不需要） |

---

## 4. 能不能在 Mac 上跑？对订阅登录的 Claude Code / Codex 能不能用？

### Mac：能，但有前提

**实测结论（本机 macOS 26.6.2 / arm64）**：

- 官方 `scion-darwin-arm64` 二进制（211MB，Web UI 编译在内）直接能跑，`scion version`、`scion doctor`、`scion init` 全部成功。
- `scion doctor` 的宿主前置只要 **git + tmux**——两者本机都有（tmux 3.7c）。这点很有意思：**Scion 和 Flywheel 一样把 tmux 当 agent 会话的载体**（`scion attach` 就是 attach 到容器内的 tmux session，它的凭据捕获脚本甚至是 `tmux capture-pane` 抓 scrollback 里的 token）。
- macOS 上支持的容器运行时是 **Apple Container**（macOS 原生）或 Docker/Podman。实测在本机它默认写的是 `runtime: docker`（本机没装 Apple Container），与 README 所说「macOS 默认 Container」不符。
- 用 Apple Container 的话有一个 **每次 macOS 重启后要 `sudo` 重跑的 DNS 规则**（PF 包过滤规则不跨重启），官方文档给的自动化方案是装一个 system-level LaunchDaemon。这是真实摩擦。
- **卡点（实测）**：从 GitHub release 直接拿的二进制 **没有预配镜像仓库**——`scion init --machine` 明确提示 `image_registry is not configured. Agents cannot start without it.`，要么自己 build 镜像，要么走 Homebrew tap（tap 版预配了 `ghcr.io/homebrew-scion` 的多架构预构建镜像）。所以 **Mac 上的实际安装路径是 Homebrew tap，不是下 release 包**。

### 订阅登录（非 API key）：能，而且是一等公民

这是我原本最担心会踩空的一点，结果 Scion 设计得相当完整。它有一套 **「无凭据启动 → 进容器交互式登录 → 捕获凭据存成项目 secret」** 的三段式流程：

| Harness | 容器内登录命令 | 捕获成什么 |
|---|---|---|
| Claude Code | `claude setup-token` | `CLAUDE_CODE_OAUTH_TOKEN`（从 tmux scrollback 里正则抓 `sk-ant-oat...`）；或文件 `~/.claude/.credentials.json` → secret `CLAUDE_AUTH` |
| Codex | `codex login --device-auth` | 文件 `~/.codex/auth.json` → secret `CODEX_AUTH` |
| Gemini CLI | 原生 OAuth 登录 | `~/.gemini/oauth_creds.json` |

找不到凭据时它 **不报错退出**，而是让 agent 起来掉到一个交互 shell，并提示你该跑哪条登录命令——这个设计比「启动失败」友好得多，值得抄。

**但这里有两个它没替你解决的真问题**（我的判断，非文档所述）：

1. **本机 Claude Code 的凭据在 macOS Keychain 里，不是文件。** 实测本机 `~/.claude/.credentials.json` **不存在**（`~/.codex/auth.json` 存在）。所以 Scion 的 `auth-file` 路径对 Mac 上 Keychain 形态的 Claude 安装是落空的，实际只能走 `claude setup-token` 生成的 OAuth token。这条路能走通，但要知道它是唯一的那条。
2. **一份订阅凭据喂给 N 个容器 = N 个并发身份。** Codex 的 `auth.json` 带 refresh token 轮换，多个容器同时刷会互相作废（我们自己的历史记录里就有 `refresh_token_reused` 这类事故）。Claude 的 OAuth token 多容器并发则直接撞订阅的速率上限。**Scion 提供的是「每 agent 独立凭据」的机制，但没有、也不可能提供「每 agent 独立订阅」。** 谁用谁都得自己面对这件事——Flywheel 现在的账号池/切号逻辑解决的正是这一层，那部分能力 Scion 里没有对应物。

---

## 5. 和 Flywheel 逐项对照

Flywheel 现状（一手核实）：Runner = 宿主机上的 tmux 会话（`packages/claude-runner/src/TmuxAdapter.ts`），每个 issue 一个 git worktree（本机当前 `git worktree list` 共 50 个），凭据是全宿主共享的 `~/.claude` / `~/.codex` + 账号池，共享工作树靠 `flywheel-comm turn` 的 TURN 锁串行化。

| 维度 | Scion | Flywheel 现状 | 判读 |
|---|---|---|---|
| **隔离单位** | 容器（Docker/Podman/Apple Container/K8s/Cloud Run） | 宿主进程（tmux 会话） | Scion 强；但容器化对我们是一次伤筋动骨的改造，见 §7 |
| **工作区隔离** | 三档明确命名的模式：`shared-plain`（全共享）/ `worktree-per-agent`（各自工作树、共享 history）/ `clone-per-agent`（各自完整 clone）；并把当前档位以 `SCION_WORKSPACE_MODE` 环境变量喂给 agent，让 agent 自己按档位调整行为 | 事实上就是 `worktree-per-agent`，但**没有名字、没有档位、没有告诉 Runner 它处在哪一档**；共享工作树的场合靠 TURN 锁临时救火 | **这是最值得学的一条**，见 §6 |
| **凭据隔离** | 每 agent 独立凭据 + 项目级 secret + 显式 `--harness-auth` 覆盖 + Hub 模式下 agent 无法直接读 Hub secret | 全宿主共享 `~/.claude` / `~/.codex`，加一个账号池 | Scion 强。但如 §4 所述，它解决的是「分发与作用域」，不是「订阅并发」 |
| **agent 生命周期** | `created→provisioning→cloning→starting→running→stopping→stopped`，外加 `suspended` / `error` 两个分支；正交的第二维 activity（`working`/`thinking`/`blocked`/`completed`/`limits_exceeded`/`stalled`/`offline`）；第三维 detail 自由文本 | 有 stage / phase，但把「基础设施生命周期」和「agent 认知状态」混在同一维度上 | **三维分层是好设计**，见 §6 |
| **空闲怎么处理** | ① agent 可自报 `blocked "<原因>"`，被排除出 stalled 检测；② 心跳还在但 5 分钟无活动 → 标 `stalled`；③ 再过 5 分钟宽限 → Hub **自动 suspend**（拆容器、保会话）；④ 下一条消息到达时 **自动 resume**，Claude Code 收 `--continue` 续上原对话 | 停驻（parked）体一直占着 tmux 会话和内存，靠人/Lead 判断何时收 | **这是第二值得学的一条**，见 §6 |
| **崩溃识别** | tmux 会话结束时由 `sciontool` 回收真实退出码并分类：0=正常停、限额=`limits_exceeded`、非 0=`error` 相（如 `exit code 137` OOM）；Hub 另从容器退出码旁证 | 有 CI/gate 判据，但「Runner 是正常收工还是崩了」没有这么干净的分类 | 值得学，成本低 |
| **人机通道** | 原生 Web chat + Telegram / Discord / Slack / Google Chat / Teams 桥 + `scion attach` 直接进 tmux | Discord（Bridge）+ cmux 看 pane | 同构，我们不缺这块 |
| **权限收口** | `--role none|readonly|baseline|full`，且被项目的 `max_agent_role` 天花板压住；容器内预置 Claude Code 的 permissions deny list 和一组硬化开关（`disableWorkflows` / `disableRemoteControl` / `disableArtifacts` 等） | 有 permissionMode 和各类护栏，但没有「项目级能力天花板」这一层 | **第三值得学**，且改造成本低 |
| **删除纪律** | 文档里写死了一张「谁有权删 agent」表（worker 可由创建者删；investigator 必须等人回答完所有问题；project initiator 只能人类点头）＋ 自底向上拆解顺序 ＋ 三条安全规则（完成≠删除、有未答问题不许删、**commit 不等于 push，有未推送的活不许删**） | 我们有 ship 门、TURN、force-push 护栏，同族纪律 | 我们不弱，但它把纪律写进了文档而不是只写进代码 |
| **不要求 K8s** | ✅ Local 模式零服务端 | ✅ 同 | 这就是它比 AX 更像我们的原因 |

---

## 6. 结论：哪些值得学

按「价值 ÷ 改造成本」排序。**推荐的执行顺序：先做 ①（最便宜，而且正对着我们刚踩过的坑），再做 ③；② 归 FLY-2782。**

### ⭐ 值得学 1：把工作区隔离档位显式化，并告诉 Runner 它在哪一档（低成本、高收益）

Scion 的做法：三个有名字的档位（`shared-plain` / `worktree-per-agent` / `clone-per-agent`），通过 `SCION_WORKSPACE_MODE` 环境变量注入容器，并在文档里写死「每档下 agent 必须遵守什么」——共享档要求「不得假设文件在你读和写之间没变过」、worktree 档提醒「history 和分支名是共享命名空间」。

对 Flywheel 的价值：我们事实上跑的就是 worktree-per-agent，但 **Runner 并不知道自己处在哪一档**。最近一次教训正是这个形状——持 QA-PASS 的体在共享工作树上合 main，移走了被绑定的头。如果 Runner 启动时就拿到「你在共享档 / 独占档、共享档里哪些操作是禁止的」，这类事故是可以在源头拦住的，而不是靠事后写记忆条目。

代价：一个环境变量 + Blueprint 里一段固定文本。几乎零成本。

### ⭐ 值得学 2：闲置 agent 的状态机 —— **并入 FLY-2782**

这块（founder 要的「跑完退下、打回再拉起」）已经是 FLY-2782 的范围，且已有 Runner 在做原型，本文不再展开。只保留 Scion 这套里最值钱的一句，供 FLY-2782 取用：

> **用 agent 主动自报「我在等某件事」来区分「故意在等」和「意外卡死」。** Scion 的做法是 agent 自己声明 `blocked "<原因>"`，声明过的被排除出「疑似卡住」检测；没声明又长时间没动静的，才走超时回收。这个歧义我们现在是靠猜的。

（Scion 的其余实现细节——5 分钟判定 + 5 分钟宽限、拆容器留会话、下条消息自动 resume、以及「自动回收只在有中枢服务器的形态下才有、阈值写死」这两条限制——都记在 §5 对照表里，FLY-2782 需要时可直接引。）

### ⭐ 值得学 3：phase / activity / detail 三维分层的状态模型（低成本、中收益）

把「容器生命周期」（provisioning / running / stopping）和「agent 认知状态」（thinking / blocked / waiting_for_input / completed）拆成正交的两维，加一维自由文本 detail。好处是 UI 和 API 消费者不用再从一个混合枚举里猜语义；`completed` / `blocked` / `limits_exceeded` 这几个是「粘性」的，不会被下一个心跳冲掉。

对 Flywheel：我们的 founder 面板和 Lead 判据经常要回答「这个 Runner 是没在动还是在等人」，现在这个区分是靠推断的。分层之后是读出来的。

### 可以学但不急

- **崩溃识别**：tmux 会话结束时回收真实退出码并分类（0 / 限额 / 非 0）。低成本。
- **项目级能力天花板**：`max_agent_role` 压住单次 `--role`。我们的护栏是分散的规则，收成一个天花板更好审计。
- **无凭据也能启动**：找不到凭据时不报错退出，而是起来掉到 shell 并提示该跑哪条登录命令。我们现在是硬失败。
- **删除/拆解纪律写进文档**：尤其「commit 不等于 push，有未推送的活不许删」这一条，我们踩过。

### 不适合单机 Mac 的

- **每 agent 一个容器**。这是 Scion 的地基，但对我们是伤筋动骨：50 个工作树意味着 50 个容器，在一台 Mac 上光镜像和内存就顶不住；而且我们的 Runner 要用宿主的 tmux、cmux 窗口、Chrome、Keychain 凭据、launchd 服务——这些全都在容器外。**用容器换来的隔离，我们目前用 worktree + TURN + 护栏已经买到了大半，剩下的那部分不值这个价。**
- **Hub / Workstation 控制面**。我们已经有 Bridge + Lead + Discord，再叠一个控制面是纯重复。
- **Apple Container 路线**。每次 macOS 重启要 `sudo` 重建 PF DNS 规则、要装 system LaunchDaemon——在一台跑生产舰队的机器上加这个是负债。
- **整体迁移到 Scion**。非官方产品、无稳定版、单人维护、一周 200 个提交、文档与实现已有多处漂移。把生产押上去不划算。**它的价值对我们是「设计参考」，不是「替换方案」。**

---

## 7. 本机试跑：做到哪、为什么停在那

做到了（全部在 scratchpad，隔离 `HOME`，零生产改动）：
1. 下载官方 `scion-darwin-arm64` v0.3.0-preview.3 → 解出 211MB 二进制，`file` 确认 Mach-O arm64；
2. `scion version` → 成功（自报 `v0.3.0-preview.1`，与 tag 不符）；
3. `scion doctor`（空环境）→ git ✓ / tmux ✓；
4. `scion init --machine` + `scion init`（scratch git 仓）→ 成功，铺出全局配置和 9 个 harness-config；
5. `scion doctor`（项目内）→ 运行时探测为 docker，docker daemon 未运行故判 ✗；
6. `scion start --help` → 拿到全部启动参数（含 `--harness-auth`、`--role`、`--workspace`）。

**没做到：没有真正启动一个 agent 容器。** 原因，按阻断顺序：
- `brew install` 被宿主工具链护栏（FLY-1944）硬拦——这是对的，Homebrew 是全舰单点；
- 不走 brew 就没有预配镜像仓库，得自己 build `scion-base` + `scion-claude` 镜像（GB 级、耗时）；
- 还得先起容器运行时（colima VM 或装 Apple Container），而这台机器正在跑生产 Bridge + Lead 舰队。

**所以「跑起来之后好不好用」这一格我留空，不是因为难，是因为把它填上要动生产机的宿主环境。** 如果要填，正确做法是：由 founder/Lead 在宿主终端跑 `brew install homebrew-scion/scion/scion`（tap 版自带预构建镜像），起 colima 或 Apple Container，然后我在一个隔离项目里跑一次 `scion start` + `claude setup-token`，专门验两件事：① 订阅登录在容器里到底顺不顺；② 一个 agent 容器在这台 Mac 上的真实内存/磁盘开销。这是一张单独的单，不在本次范围。

---

## 8. 一句话回答 founder 的问题

> Scion 是一个挂在 Google Cloud 名下、主要由一个人维护的开源实验项目（不是 Google 产品），给「已经在同时跑好几个 coding agent、开始被互相踩脚和凭据混乱折磨」的人用——个人开发者到小团队都行，不要求 K8s，Mac 上能跑，订阅登录的 Claude Code / Codex 也支持。AX 是完全另一类东西：它的部署前置是一整套集群设施（K8s 集群 + ko + 镜像仓库 + Agent Substrate 控制面），目标是给平台团队在集群里跑几十亿个 agent 任务，跟我们不相干。Scion 和 Flywheel 形状几乎同构，**但我不建议迁过去**（非官方、无稳定版、单人主导、一周 200 个提交）；建议抄它两件事：**先**把工作区隔离档位显式告诉 Runner（最便宜、正对着刚踩过的坑），**再**把「容器生命周期」和「agent 在想什么」拆成两个正交维度；闲置回收那件已经是 FLY-2782 的范围，不在这里展开。
