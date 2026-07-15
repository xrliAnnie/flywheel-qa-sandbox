# FLY-346 AIO Sandbox 对 Runner 沙箱化 — 探索

Issue: FLY-346 (https://linear.app/geoforge3d/issue/FLY-346/xhsclaude-字节开源-aio-sandbox浏览器终端vscodejupytermcp-一体-docker)
日期: 2026-07-08
基于: 无

---

## 1. 触发与来源

- 本 issue 是**小红书学习自动草稿**(FLY-286 pilot),灵感来自字节开源的 AIO(All-in-One)Sandbox —— 把浏览器 + 终端 + 文件系统 + VSCode Server + Jupyter + MCP server 塞进**单个 Docker 容器**、所有组件共享同一 fs、一条命令起。仓库:GitHub `agent-infra/sandbox`(字节系 agent-infra 组织,Apache 2.0)。
- 草稿的核心猜想:这种"一体化 agent 沙箱"对 Flywheel runner 的**隔离 / 可观测 / 可复现**是值得评估的现成参考。

## 2. Scope(Annie 已纠正,三条**独立**分析线,不合并)

> Annie 明确:别把「346 沙箱」和「多机部署」预设成合成一条。

| # | 线 | 要回答的问题 | 不做的假设 |
|---|----|------------|-----------|
| A | **346 AIO Sandbox 本身** | 这套一体化沙箱对 runner 隔离/可观测/可复现到底有没有用、值得抄哪块、代价多大 | 不预设"值得抄" —— 诚实结论可能是"不值得",那就直说 |
| B | **多机部署 × 沙箱** | 多机部署要不要用沙箱化 / 怎么用 | **不预设多机一定用沙箱**(技术上多机不一定需要沙箱) |
| C | **homerail 沙箱做法** | 它怎么做 runner 隔离 → 喂进 A/B 的对比 | 读源码而非只看 README |

**本 issue 只做 research,不写 build code。** 产出 = 结论 + 若值得抄啥 + 多机是否/如何用沙箱 + homerail 做法。

## 3. 当前 Flywheel runner 模型(评估的基线)

要判断"沙箱化值不值",先钉死我们现在是什么样:

- **启动**:`tmux new-window` 在一个 git **worktree** 里起 runner;多 backend adapter(`claude-tmux` / `codex-tmux` / `antigravity-tmux` / `kimi-tmux`),全部 tmux-window based(`TmuxAdapter`)。
- **隔离(按 backend 精确)**:
  - **默认/主路径 `claude-tmux`(以及 `agy` / `kimi` 这类 TmuxAdapter 继承路径)= 目录分离,非安全隔离**。adapter 只把 `cwd` 设到 worktree,再以**同一个 macOS 用户**起 `claude`(且 `permissionMode: bypassPermissions`);worktree 只建目录/分支,**不限制**该进程读写 `~/.flywheel` 密钥、`~/.ssh`、别的 repo。
  - **`codex-tmux` 例外**:`CodexTmuxAdapter` 已用 **macOS Seatbelt `sandbox: "workspace-write"`**(FLY-209)—— 这是真 enforcement 边界,但**不是容器**,且为 Flywheel comm 明确放开 `writableRoots`(含 `~/.flywheel`)+ `networkAccess: true`,**不等价于** homerail 的 mount 隔离。
- **可观测**:FLY-398 **硬规则** —— 生产 Lead/runner 必须 **windowed**(founder 能在 cmux 里实时看的真 TUI pane),**绝不 headless**。FLY-116 per-runner terminal viewer hook 在 `tmux new-window` 返回时点亮 founder 可见 pane。
- **comm**:Lead↔Runner 走 mailbox 文件 + tmux 注入;`LeadWatchdog` / `HeartbeatService` / `core/tmux-viewer.ts` / `verify-approval` / cmux-sync **全部假设 host tmux**。
- **并发**:`max_parallel` config schema 注释声明 default 3(当前 checkout 未见 runtime consumer 读取点);多 runner 单机共享同一 host fs(靠 worktree)。
- **MCP**:runner 已有 terminal MCP + Claude-in-Chrome 默认可用;FLY-751/812 目前主要 slim heavy plugins(默认关 `serena`),Chrome 仅 `no-chrome` label 才 opt-out。
- **现状**:代码里**没有任何 runner 容器化**(`docker`/`container` 只出现在 cipher README 和 codex read-deny-profile,与 runner 沙箱无关)。

## 4. 关键先验(prior art,必须复用)

- `doc/engineer/plan/archive/R1-R6/R5-remote-execution-sandbox.md` —— **已经评估过**阿里 OpenSandbox(与 AIO Sandbox **同品类**的一体化 agent Docker 沙箱)+ Docker 做 runner 隔离 + remote-Mac 执行。关键结论:**macOS Docker 性能问题**、**egress 控制仅 Linux**、对比过 SSH+tmux / OpenSandbox+Docker / Tailscale+tmux / SDK-remote。AIO Sandbox = OpenSandbox 同类,R5 的 macOS-Docker 约束大量可复用。
- `homerail`(GitHub `xiaotianfotos/homerail`)—— 一个**分布式多-agent DAG 编排器**,已用 **Docker Worker 模型**(Node 服务给每个 DAG 节点拉一个 Worker 容器)。这是我们能拿到的最贴近的"容器化 runner"真实实现,C 线主要材料。
- 任务清单里另有 #8「多机部署 PRD」与 #9「Leader efficiency(>5 runners 变慢)」—— B 线要与它们对齐(但不越俎代庖出多机 PRD)。

## 5. 研究要回答的核心判断题(research.md 展开)

1. 沙箱化能给我们**现在没有**的什么?(预判:真安全隔离 + 一条命令可复现环境)
2. 代价是什么?(预判:破坏 founder-visible pane 硬规则 + comm 被迫走网络协议 + Apple Silicon 上 Docker Desktop Linux-VM 开销 + 重铺整个 launch/observability/comm 层)
3. 净值:值不值?若部分值,**抄哪一块**(可能是"隔离思路/mount 白名单/可复现镜像"而非"整套换掉")?
4. 多机:多机是否**需要**沙箱?容器化与多机是不是**两根正交的轴**?若多机是大的独立设计 → **flag 建议单拆一条**。

## 6. 初步倾向(诚实,待 research 证实/推翻)

- **整体把 runner 换进 AIO-style 容器,在当前单机 Mac / tmux / cmux 模型下大概率不划算**:每 runner 一容器 ×2GB + Apple Silicon 上跑 Docker Desktop Linux VM(注:AIO 最新 release 已恢复 native arm64 镜像,但仍非 native macOS 进程);直接撞碎 FLY-398 founder-visible pane 硬规则;把 mailbox+tmux comm 逼成网络协议;R5 已记录 macOS Docker 性能坑。
- **cherry-pick 要诚实**:homerail 的 mount 白名单**之所以是隔离,是因为 Docker namespace 承担了 enforcement**;在我们 host-user tmux 模型下,**纯路径白名单不是安全边界**(挡不住 runner 内 Bash/npm/script 主动读 host)。所以"抄隔离"= 单开一条**enforceable filesystem isolation** 的研究(候选:容器/VM、macOS Seatbelt profile — codex-tmux 已用、独立 Unix 用户+ACL、chroot/FUSE,或仅做非安全 soft-guard),**不能**当"低成本安全隔离"卖。
- **单机也可能需要隔离**:若 runner 会跑不可信依赖 / 外部 repo / browser 下载物 / 被 prompt-injection 操控的 shell,隔离收益在**单机**也可能单独转正 —— 这是安全优先级决策,不是 AIO 采用的默认结论。
- **多机与沙箱是两根轴**,不该捆绑;多机已单独立项 = **FLY-1005**。

> 下一步:research.md 用 AIO Sandbox 事实 + homerail 源码 + R5 先验,把上面每条判断题坐实。
