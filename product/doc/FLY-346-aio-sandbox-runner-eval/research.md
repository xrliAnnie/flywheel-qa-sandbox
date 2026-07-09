# FLY-346 AIO Sandbox 对 Runner 沙箱化 — 调研

Issue: FLY-346 (https://linear.app/geoforge3d/issue/FLY-346/xhsclaude-字节开源-aio-sandbox浏览器终端vscodejupytermcp-一体-docker)
日期: 2026-07-08
基于: exploration.md

> 本文档经 Codex design review(Round 1 → 修订)。技术论断已对着 Flywheel 源码 + homerail clone + AIO release 页逐条核实。

---

## 0. TL;DR

- **Thread A(AIO Sandbox 本身)**:作为**整套 runner 运行时替换** —— 当前单机 Mac / tmux / cmux 模型下**不值得**。它一容器 = 一 workspace、每容器 ~2GB、macOS 上仍需 Docker Desktop Linux VM,直接撞碎 FLY-398「founder 可见 pane」硬规则,并把 mailbox+tmux comm 逼成网络协议。**值得抄的只有"点子层"**:一条命令可复现环境、bundled MCP(我们已大部分有)、多界面可观测(VNC/VSCode 作为 headless 场景下的 pane 替代)。
- **隔离这块要诚实(Codex R1 blocker)**:homerail 的 mount 白名单**之所以是隔离,靠的是 Docker namespace 做 enforcement**。Flywheel 默认 `claude-tmux`(及 `agy`/`kimi`)runner 以 host-user 起、`bypassPermissions`,**纯路径白名单不构成安全边界**。所以"抄隔离"必须降格成"**单开一条 enforceable filesystem isolation 的研究**",不能当"低成本安全隔离"卖。
- **Thread C(homerail)**:homerail 用 **Docker Worker + Node provisioner + mount 白名单**做真隔离,是比 AIO 更贴切的参考;其 provider 双后端(docker-api / docker-cli)是干净的 seam。但 homerail 自己声明**不为 SWE 设计**、worker 是 **headless**,不能照搬。
- **Thread B(多机 × 沙箱)**:**容器化与多机是两根正交的轴**。多机**不需要**先做沙箱(仓内已有 `008-multi-machine-consensus.md` 佐证:多机的问题域是 task 认领/状态同步/互斥/故障转移,与容器无关)。沙箱在"多机 + Linux 远端"最容易转正,但**单机也可能因 threat model 单独转正**。多机 PRD 归 **FLY-1005**。

---

## 1. 三个参照物 · 事实卡

### 1.1 AIO Sandbox(`agent-infra/sandbox`,字节系,Apache 2.0,~5.4k★,v1.11.0)

| 项 | 事实 |
|----|------|
| 形态 | **一个 Docker 容器 = 一个 unified sandbox**(非容器内多租户) |
| 起法 | `docker run --security-opt seccomp=unconfined --rm -it -e SANDBOX_API_KEY=... -p 127.0.0.1:8080:8080 ghcr.io/agent-infra/sandbox:latest` |
| 端口 | 单一 `8080` 收口所有服务 |
| 组件 | Browser(VNC + Chrome DevTools Protocol)、VSCode Server、Terminal(WebSocket shell)、Jupyter、File Manager、MCP Hub;**共享同一 fs** |
| MCP | 预置 `browser`/`file`/`shell`/`markitdown` MCP server,agent 连 `http://localhost:8080/mcp` |
| SDK | Python `agent-sandbox` / TS `@agent-infra/sandbox` / Go;REST `/v1/{shell/exec,file/*,browser/screenshot,jupyter/execute}` |
| 资源 | ~**2GB RAM + 1 core / 容器**;browser 需 `shm_size 2gb` |
| 平台 | **Linux container runtime**;**最新 release(v1.11.0)已恢复 native arm64 镜像 build**;但仍**非 native macOS 进程** —— 在 Mac 上跑 = Docker Desktop Linux VM,吃 VM + 每容器内存/CPU + `seccomp`/Linux-runtime 税 |
| 隔离 | Docker namespace **only** —— 官方 quickstart 用 `seccomp=unconfined`(即**关掉** seccomp syscall 过滤),隔离比默认 Docker 还弱一档,无内核级沙箱 |
| 扩展 | 水平扩:K8s replicas / 多容器,**每容器 = 1 个** |

**定位判断**:AIO Sandbox 是"给一个 agent 配一个啥都有的 Linux 工作台"—— **单 agent、单 session、一个胖容器**。它优化"agent 需要浏览器+终端+notebook 都在一处且共享 fs",不是"一台机器上同时跑很多个被隔离的 runner"。

### 1.2 homerail(`xiaotianfotos/homerail`)· 源码级(Codex 已复核准确)

- **整体**:分布式多-agent **DAG 编排器**,包结构 `homerail_manager` / `homerail_node` / `homerail_worker` / `homerail_protocol` / `homerail_cli` / `agent-ui`。
- **Docker Worker 模型**:Manager 和 Node 作为本地服务跑;**Node 用 Docker 给每个 DAG 节点拉一个 Worker 容器**,一次 run 的 workers 共享一个 workspace。
- **Worker 镜像**(`homerail_worker/Dockerfile:2-35`):`node:22-slim` + bash/ca-certificates/curl/git + 打包 `kimi` CLI;`USER node`(**非 root**);`WORKDIR /workspace`;`ENTRYPOINT node /app/dist/index.js` —— **headless**,不是 TUI。
- **Node provisioner**(`homerail_node/src/providers/`):**两个 provider**
  - `docker-api-provider.ts:78-87` —— 走 Docker daemon socket(dockerode 风格 `createContainer`,结构化 `HostConfig.Mounts`)
  - `docker-cli-provider.ts:162-165` —— shell 出 `docker` CLI(`--mount source=..,target=..`、`--network`)
  - `lifecycle/create.ts:55-82` 暴露 `createWorkerContainer`,**拒绝 caller-supplied mounts,只用 `workerAllowedMounts(workspaceId)` 挂 `/workspace`**
- **隔离边界 = mount 白名单**(`storage/mount-policy.ts`,**最值得看**):
  - `DENIED_PATHS = ["/etc","/proc","/sys","/dev"]` 一律拒挂
  - `/var/run/docker.sock` 必须显式 `allowDockerSocket:true` 才允许(默认拒 —— 防容器逃逸)
  - 其余 mount 必须落在 `.homerail` home 树内 **或** 显式 `allowedHostRoots` 白名单内,否则 `MountPolicyError`
  - Worker 实际只拿到自己 workspace 挂 `/workspace:rw` —— **worker 容器只能看见自己的 workspace**
  - **关键**:这套白名单能成为"隔离",是因为 **Docker 只把允许的 host path bind-mount 进容器 namespace**;白名单本身是"给 Docker 的挂载清单",不是脱离容器的安全机制(见 §3.3 对 Flywheel 的含义)。
- **comm**:Worker 通过 **WebSocket**(`ws-client.ts`)回连 Manager —— comm **跨容器边界走网络协议**。
- **可观测**:`audit/`(transcript-writer / tool-event-writer / checksum)+ 生成式 UI + replay / scorecard —— 靠**可回放的证据**,不是 live 可见 pane。
- **harness-agnostic**:`agent/` 下 claude-sdk / codex / codex-appserver / kimi-code / deterministic + factory —— 和 Flywheel 多 backend 一个哲学。
- **定位声明(ROADMAP:23-28, 89-92)**:homerail **明确不为 software engineering / 开发自动化设计**,针对"结果易判断"的产出(视频/报告/资产)。多机是 **long-term roadmap**,未 ship。

### 1.3 Flywheel runner — 现状(基线,已核源码)

| 维度 | 现状 |
|------|------|
| 启动 | `tmux new-window -c ctx.cwd`(`TmuxAdapter.ts:520-535`)+ git worktree(`WorktreeManager.ts:190-203` 只建目录/分支);多 backend adapter |
| 默认 backend | `roles.runner.backend: claude-tmux`(`.flywheel/config.yaml:43-46`) |
| **隔离(按 backend 精确)** | **`claude-tmux`(+ `agy`/`kimi` 继承路径)= 目录分离,非安全隔离**:以同一 macOS 用户起 `claude`、`permissionMode: bypassPermissions`(`Blueprint.ts:1676-1683`),runner 内进程可读写 `~/.flywheel`/`~/.ssh`/别的 repo。**`codex-tmux` 例外**:`CodexTmuxAdapter.ts:631-653` 用 macOS Seatbelt `sandbox: "workspace-write"` + `writableRoots`(含 `~/.flywheel`)+ `networkAccess: true`(FLY-209)—— 真 enforcement,但非容器、且为 comm 放开,不等价 homerail mount 隔离 |
| 可观测 | **FLY-398 硬规则:windowed founder 可见 cmux pane,绝不 headless**;FLY-116 viewer hook |
| comm | mailbox 文件 + tmux 注入;watchdog / heartbeat / verify-approval / cmux-sync 全假设 host tmux |
| 平台 | 原生跑在 Annie 的 Apple Silicon Mac(无容器层) |
| 并发 | `max_parallel` schema 注释 default 3(`types.ts:63-68`);当前 checkout 未见 runtime consumer |
| MCP | terminal MCP + Claude-in-Chrome 默认可用;FLY-751/812 主要 slim heavy plugins(默认关 serena),Chrome 仅 `no-chrome` opt-out |

---

## 2. 对比矩阵

| 维度 | Flywheel 现状 | AIO Sandbox | homerail Docker Worker |
|------|--------------|-------------|----------------------|
| **隔离粒度** | 目录(worktree);`codex-tmux` 另有 Seatbelt workspace-write | 容器 namespace(quickstart `seccomp=unconfined`,seccomp 关闭) | 容器 + **mount 白名单**(最严) |
| **runner : 容器** | N runner 共享 host | 1 agent : 1 胖容器 | 1 DAG 节点 : 1 瘦容器 |
| **安全隔离** | ⚠️ claude/agy/kimi 无(host fs 全开);codex-tmux 有 Seatbelt(非容器,为 comm 放开) | ✅ Docker 默认 | ✅✅ mount 白名单 + 拒 docker.sock + 非 root |
| **可复现环境** | ❌ 依赖 host 状态 | ✅ 镜像固定 | ✅ 镜像固定 + slim base |
| **可观测** | ✅ live founder pane(cmux) | VNC/VSCode/Jupyter 多界面(非 live pane) | audit transcript + 生成式 UI + replay(非 live pane) |
| **comm 模型** | mailbox 文件 + tmux(host 内) | REST/MCP over 8080 | **WebSocket 跨容器** |
| **平台/成本** | 原生 arm64,零容器开销 | Linux 容器(最新有 arm64 镜像);macOS 上仍 Docker Desktop VM,~2GB/容器 | 同 Docker;macOS 需 Docker Desktop |
| **headless?** | ❌ 必须 windowed(FLY-398) | headless(有 VNC 兜底) | **headless** |
| **多 backend** | claude/codex/antigravity/kimi-tmux | N/A(不含 agent harness) | claude-sdk/codex/kimi factory |
| **定位契合** | SWE 自动化(ship PR) | 通用 agent 工作台 | **明确非 SWE** |

---

## 3. Thread A 结论 — AIO Sandbox 值不值 + 抄哪块

### 3.1 沙箱化能给我们现在没有的什么?
1. **真安全隔离** —— 默认 `claude-tmux`(及 agy/kimi)runner 以 host-user 身份、对整机 fs 全开,一个 runner(或它跑的不可信代码/依赖/被 prompt-injection 操控的 shell)理论上能读到 host 上的密钥、别的 project、`~/.flywheel` 状态。容器 + mount 白名单能把它关进只有自己 workspace 的笼子。**这是现状最真实的缺口(codex-tmux 已用 Seatbelt 部分缓解,但主路径没有)。**
2. **一条命令可复现环境** —— 镜像固定 toolchain,消除"我机器上能跑"的漂移;新机/CI/多机上拉起一致。

### 3.2 代价(为什么整体替换不值)
1. **撞碎 FLY-398 founder-visible pane 硬规则** —— AIO/homerail 都 headless;要保留"Annie 在 cmux 里实时看 runner",得另造 VNC/VSCode/transcript 的可观测面,等于重写观测层。
2. **comm 被迫走网络** —— 现在 mailbox 文件 + tmux 注入(host 内、零网络)。runner 进容器后 Lead↔Runner、wake、verify-approval、heartbeat 全得改跨容器协议(homerail 用 WS)。**动整个 comm/lifecycle 层。**
3. **Apple Silicon 上的 Docker 税** —— 最新 AIO 镜像有 arm64(不再是 x86 emulation),但**仍非 native macOS 进程**:Annie 的 Mac 上跑 = Docker Desktop Linux VM + ~2GB/容器 × N + seccomp/Linux-runtime 税。R5 已记录 macOS Docker 性能坑。
4. **重铺 launch 层** —— `tmux new-window`→容器 provision;`TmuxAdapter` 家族(4 个 backend)全部要有容器版;`LeadWatchdog`/`HeartbeatService`/cmux-sync 全部改。

> 一句话:**代价 = 动 launch + 观测 + comm 三层;收益 = 安全隔离 + 可复现。在单机 Mac 上,收益够不着代价。**

### 3.3 抄哪块(诚实版 —— Codex R1 blocker 已修)
- ⚠️ **"隔离"不能当低成本 cherry-pick 卖**:homerail mount 白名单是"给 Docker 的挂载清单",enforcement 靠 Docker namespace。**Flywheel 默认 claude-tmux runner 以 host-user 起,一个 TypeScript 路径白名单只能校验 Flywheel 自己传的参,挡不住 runner 内 Bash/npm/test/script 主动读任意 host path** —— 没有容器/namespace/Seatbelt/独立 Unix 用户/ACL/chroot/FUSE 这类执行边界,白名单不是安全隔离。所以正确做法是**单开一条"enforceable filesystem isolation"研究**(候选 enforcement surface:① 容器/VM ② **macOS Seatbelt profile —— codex-tmux 已在用,可评估推广到 claude/agy/kimi** ③ 独立 Unix 用户 + ACL ④ chroot/FUSE/overlay ⑤ 只做非安全 soft-guard:路径 lint/配置校验)。**若推荐它,必须诚实写清成本与限制:默认 Claude/agy/kimi 不能靠纯路径白名单实现安全隔离。**
- ✅ **可复现镜像**:真上容器时,homerail 的 slim-base + 非 root + 单 workspace volume 是好模板。
- ✅ **provisioner + provider seam**:homerail 独立 `homerail_node` + docker-api/docker-cli 双 provider,是"若容器化"时取代 `tmux new-window` 的干净抽象。
- 🟡 **bundled MCP**:AIO 的 browser/file/shell MCP,我们已有 terminal MCP + Claude-in-Chrome 默认开,**增量不大**。
- ❌ **整套 AIO 运行时替换 runner**:不值(见 3.2)。

### 3.4 诚实结论(Thread A)
> **不建议**把 AIO Sandbox 当作 runner 运行时来采用。**建议**把它降格为"当我们真要容器化 runner 时的一个候选镜像/参考"。至于"补现状的隔离缺口",它是一个**独立的安全设计问题(enforceable isolation),不是一条脱离容器的低成本改动** —— 是否立项、按什么 threat model 立项,交 Annie(见 plan.md §6)。

---

## 4. Thread C — homerail 沙箱机制细读(源码级,喂进对比)

**Annie 说 homerail 里应该已有沙箱概念 —— 证实了,而且比 AIO 更工程化。** 要点:

1. **provisioner 是一个独立服务(`homerail_node`)**,拥有容器生命周期 + 两个 provider(daemon socket / docker CLI)。**启示**:Flywheel 若容器化,需要一个对等的 "RunnerProvisioner" 取代 `tmux new-window`,而不是把 docker run 塞进现有 Blueprint。
2. **隔离的真身是 `mount-policy` + Docker namespace**(§1.2):拒系统目录、默认拒 docker.sock、host 路径白名单、worker 只见自己 workspace。**但它的 enforcement 来自容器,不是白名单本身** —— 这正是 §3.3 对 Flywheel 的关键含义。
3. **comm 跨容器 = WebSocket**:证明"容器化 runner"的必然代价是 comm 上网络。
4. **headless + 证据式可观测**:homerail 用 audit transcript + replay + 生成式 UI 替代 live pane。**与 FLY-398 直接冲突** —— 若 Flywheel 走容器,要么放弃"live 可见"改证据式(产品决策,必须 Annie 拍),要么加 VNC/VSCode 面板。
5. **定位差异要划清**:homerail **自己声明不为 SWE 设计**。可以抄它的隔离/provisioner 机制,但不能把它的整体架构当 Flywheel 的目标形态。

> 注:1004 runner 也在读 homerail 并会出 eng-idea 清单。本 doc 只取**沙箱/隔离**切面喂进 346 对比;其余 homerail 点子以 1004 的清单为准,避免重复。

---

## 5. Thread B — 多机部署要不要 / 怎么用沙箱(开放问题,不预设答案)

**先拆清两根轴(本线最重要的结论):**

- **轴 1 = 隔离/容器化**:单机上"一个 runner 关进一个笼子"。**单机就能做**(homerail 单机 Docker Worker 已证明)。
- **轴 2 = 多机分发**:把 runner 调度到不同物理机。**这是 Manager/Node 协调 + 网络 + workspace 一致性问题,和容器与否无关**。

**仓内 prior art 佐证正交性**:`doc/engineer/research/new/008-multi-machine-consensus.md`(R6,2026-03,Low/Phase 5+)把多机的问题域框成 **task 认领(claim-and-lock)/ 状态同步 / 互斥 / 故障转移(heartbeat+timeout)**,方案对比是**中心化 coordinator / Raft / 分布式锁 / MQ**(倾向 2-5 台用中心化 coordinator,~200 LOC)。**全程不涉及容器/沙箱** —— 直接印证"多机 ≠ 必须先上容器"。

**多机是否*需要*沙箱?—— 技术上不需要。** 多机可有多种形态,沙箱只是其中一维:

| 多机方案 | 要不要容器 | 隔离 | 备注 |
|---------|-----------|------|------|
| **SSH + tmux attach 到 remote Mac** | ❌ 不要 | 目录级(同现状) | R5 评过,最简单;保留 windowed pane 语义;远端也是 Mac 时 arm64 原生 |
| **Tailscale + tmux** | ❌ 不要 | 目录级 | 零配置 VPN + 现状 runner 模型平移 |
| **每机跑 Node,Docker Worker(homerail 式)** | ✅ 要 | 容器 + mount 白名单 | 远端是 **Linux** 时容器原生(无 macOS Docker 税;egress 控制也能用);但撞 FLY-398 + comm 上网络 |
| **VM per runner** | 半 | 强 | 更重,一般不值 |

**关键洞察(已按 Codex R1 软化)**:容器化 runner 的**成本/收益在"多机 + Linux 远端"最容易转正**(Linux 远端消掉 macOS Docker 税 + egress-Linux-only 限制)。但**单机也可能转正** —— 若 runner 会跑不可信依赖 / 外部 repo / browser 下载物 / 被 prompt-injection 操控的 shell,隔离本身可能值得单独买单。这是**安全优先级决策**,不是 AIO runtime adoption 的默认结论。即便多机,**是否上容器仍是独立选择**(可先 SSH+tmux 平移、隔离另算)。

**多机是不是一个大的独立设计?——是。** 牵扯调度、workspace 一致性、跨机 comm、密钥分发、故障恢复。**已单独立项 = `FLY-1005`**(High)。

### 5.1 与 FLY-1005 的对齐(别各说各 —— Lead 明确要求)

**FLY-1005**(https://linear.app/geoforge3d/issue/FLY-1005 · High · Backlog · 2026-07-08)是"多机部署 — runner 分散到多台机器跑(research → PRD)"。其 open-Q 与本 doc 对称,原文摘录:

- **Q3(逐字)**:"和沙箱化 (FLY-346) 的关系 = 开放问题,别预设。Annie:『多机 technically 不一定用 346 的沙箱』。research 回答『多机要不要 / 怎么用沙箱化』但不预设答案。"
- **Q4**:多机与 `FLY-353`(session/记忆事件日志解耦)/ `FLY-916`(fleet 规模瓶颈)的关系;353 的解耦会不会是多机前提。

**346 与 1005 共持的 framing(双方落同一结论):**

| 共识 |
|---|
| **沙箱化 与 多机 是两根正交的轴**,不捆绑 |
| **多机不需要"先做/一定用"346 的沙箱**(Annie 原话) |
| 多机可先 **SSH+tmux / Tailscale+tmux** 平移现状 runner(保留 windowed pane),隔离另算 |
| **容器化收益在"多机 + Linux 远端"最易转正;单机可因 threat model 单独转正** |
| 多机 PRD 归 **FLY-1005**;沙箱值不值归 **FLY-346**;互相引用,不重复产出 |

**邻居只做指针,不展开(归 1005)**:`FLY-353`(session/记忆解耦)可能是多机**和**容器化的共同前提 —— runner 一旦进容器/跨机,session 状态不能再假设"活在 host tmux + 本地文件",与 §3.2 comm-上网络 同根;`FLY-916`(fleet 规模)是多机动机侧。二者的展开归 FLY-353 / FLY-1005,本 doc 不越界。

---

## 6. 诚实总结(喂进 plan.md)

1. **346 AIO Sandbox 整套采用:不值得**(单机 Mac/tmux/cmux + FLY-398 + comm 重铺 + Docker 税)。
2. **补隔离缺口 ≠ 低成本 cherry-pick**:纯路径白名单在 host-user tmux 模型下不是安全边界;它是一个**独立的 enforceable-isolation 安全设计问题**(候选:容器/VM / macOS Seatbelt〔codex-tmux 已用〕/ 独立用户+ACL / soft-guard)。是否立项 + 按什么 threat model,交 Annie。
3. **homerail 是比 AIO 更好的容器化参考**:provisioner 服务 + mount 白名单 + provider 抽象;但 headless + 非-SWE 定位,不可照搬。
4. **多机 ≠ 沙箱,两根正交轴**(仓内 008-multi-machine-consensus 佐证);容器化收益在"多机 + Linux 远端"最易转正,单机可因 threat model 转正;**多机已单独立项 = FLY-1005**,346 与 1005 共持 §5.1 framing。
5. 全程 research,不写 build code。
