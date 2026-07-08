# FLY-346 AIO Sandbox 对 Runner 沙箱化 — 推荐与决策

Issue: FLY-346 (https://linear.app/geoforge3d/issue/FLY-346/xhsclaude-字节开源-aio-sandbox浏览器终端vscodejupytermcp-一体-docker)
日期: 2026-07-08
基于: exploration.md, research.md

> 本 issue 是**调研→决策**任务(不写 build code)。本文件是给 Annie 的**一页决策**:346 值不值得做、若值得抄啥、多机是否/如何用沙箱。经 Codex design review 修订,诚实结论优先。

## 1. 一句话结论

**把 AIO Sandbox 当作 runner 运行时来整套采用 —— 不值得,建议 close 346 的"直接落地"意图。** 调研过程澄清了一个常见误解:"抄 homerail 的 mount 白名单来给 runner 加安全隔离"**不是**一条脱离容器的低成本改动 —— 在 Flywheel 默认 host-user tmux runner 模型下,纯路径白名单形不成安全边界。补隔离缺口是一个**独立的安全设计问题**(见 §3 / §6),值不值得单独立项交 Annie。

## 2. 为什么整套采用不值得(3 条硬理由)

1. **撞碎 FLY-398 硬规则** —— AIO/homerail 都是 headless;要保留"Annie 在 cmux 里实时看 runner"就得重写整个观测层(VNC/VSCode/transcript 兜底)。
2. **comm 被迫上网络 + 重铺 lifecycle** —— 现在 mailbox 文件 + tmux 注入(host 内、零网络);runner 进容器后 Lead↔Runner / wake / verify-approval / heartbeat 全要改跨容器协议(homerail 用 WebSocket),`tmux new-window` → 容器 provision、4 个 tmux backend adapter 全要容器版。
3. **Apple Silicon 上的 Docker 税** —— 最新 AIO 镜像已有 native arm64(不再是 x86 emulation),但**仍非 native macOS 进程**:Annie 的 Mac 上跑 = Docker Desktop Linux VM + ~2GB/容器 × N + seccomp/Linux-runtime 税;先验 R5 已记录 macOS Docker 性能坑。

> 一句话:**代价 = 动 launch + 观测 + comm 三层;收益 = 安全隔离 + 可复现。在单机 Mac 上,收益够不着代价。**

## 3. 若要抄 —— 抄哪块(优先级排序,诚实版)

| 优先级 | 抄什么 | 依赖容器? | 诚实注解 |
|-------|-------|-----------|---------|
| 🟠 独立安全议题 | **enforceable filesystem isolation**(补 claude/agy/kimi runner 的 host-fs 全开缺口) | 视方案 | homerail 白名单靠 Docker namespace enforce;**纯路径白名单在 host-user 模型下不是安全边界**。候选 enforcement:容器/VM、**macOS Seatbelt(codex-tmux 已用,可评估推广)**、独立 Unix 用户+ACL、chroot/FUSE,或仅非安全 soft-guard(路径 lint)。**不是低成本安全隔离** |
| 🟡 中(留待真容器化时) | 可复现镜像(slim-base + 非 root + 单 workspace volume)、provisioner 服务抽象(取代 tmux new-window)、provider 双后端(docker-api / docker-cli) | ✅ 是 | homerail 的干净模板 |
| ⚪ 低 | bundled MCP(browser/file/shell) | ✅ 是 | 已有 terminal MCP + Claude-in-Chrome 默认开,增量小 |
| 🔴 不抄 | 整套 AIO 运行时替换 runner | — | 见 §2 |

## 4. homerail 一句话(Annie 点名要看)

homerail(`xiaotianfotos/homerail`)**确实已有沙箱概念,且比 AIO 更工程化**:独立 `homerail_node` provisioner + **mount 白名单**(拒系统目录/默认拒 docker.sock/host 路径 allowlist/worker 只见自己 workspace,**enforcement 靠 Docker namespace**)+ provider 双后端。**但**它 worker 是 **headless**、ROADMAP 明确**不为 SWE 设计** —— 可抄它的**隔离机制**,不可照搬它的**整体架构**。(其余非-沙箱点子归 1004 runner 的 eng-idea 清单,不重复。)

## 5. 多机 × 沙箱(开放问题,已与 FLY-1005 对齐)

- **多机 ≠ 沙箱,是两根正交的轴。多机不需要"先做/一定用"346 沙箱。**(Annie 原话;仓内 `008-multi-machine-consensus.md` 佐证:多机问题域是 task 认领/状态同步/互斥/故障转移,不涉容器。)
- 多机可先 **SSH+tmux / Tailscale+tmux** 平移现状 runner(保留 windowed pane),隔离另算。
- **容器化收益在"多机 + Linux 远端"最易转正;但单机也可能因 threat model 单独转正**(见 §6 accepted-risk)。
- **多机 PRD 归 `FLY-1005`(已立项,High)**;346 不产出多机 PRD。346 与 1005 共持 research.md §5.1 的同一 framing(引用 FLY-1005 open-Q #3/#4);邻居 FLY-353(session/记忆解耦)/ FLY-916(fleet 规模)只做指针,展开归 1005。

## 6. 给 Annie 的决策(keep / close)

**推荐:close 346 的"整套采用沙箱"意图**(诚实结论:单机 Mac 上不划算),同时请 Annie 选下面三选一:

| 选项 | 含义 | 我的推荐 |
|------|------|---------|
| **A. close 346 + 单开"runner enforceable filesystem isolation"研究 issue** | 整套采用作罢,但把"补 host-fs 全开缺口"作为独立**安全设计**议题立项(先定 threat model,再选 enforcement:容器/Seatbelt/独立用户/…)—— **不是**低成本白名单 | ⭐ **推荐**,若认为 runner 会跑不可信依赖/外部 repo/被 prompt-injection 的 shell |
| **B. close 346,隔离也暂不做** | 认为现状目录隔离够用、安全议题暂不优先 | 可接受 —— 但请显式接受下方 accepted-risk |
| **C. keep 346,当"未来容器化 runner"参考卡片 park** | 现在不做,保留为多机+Linux 远端场景的候选镜像参考,与 FLY-1005 挂钩 | 可接受,但注意别和 1005 重复 |

> **Accepted-risk note(选 B 必读)**:选 B = 接受默认 `claude-tmux`(及 agy/kimi)runner 以 host-user 身份、对 host secrets(`~/.flywheel`/`~/.ssh`)、本地 repos 的完整读写风险。风险主体不只是"人",还包括 npm/pnpm scripts、测试 fixture、browser 下载物、被 prompt 操控后的 tool-call shell。(`codex-tmux` 已有 Seatbelt workspace-write 部分缓解,但非默认主路径。)

> 无论 A/B/C,**346 都不再是一条"去搭 Docker"的 build 线**。真正的沙箱落地窗口是 FLY-1005 走到"多机 + Linux 远端"、或 A 的安全 threat model 成立时,由那条驱动。

## 7. 本 issue 产出与边界

- ✅ 产出:本三件套(exploration / research / plan)= 诚实推荐文档,让 Annie keep/close。
- ✅ 已扒 homerail 源码(mount-policy / node provisioner / worker Dockerfile / ws comm)喂进对比。
- ✅ 已与 FLY-1005 对齐 sandbox↔多机 framing(引用其 open-Q + 仓内 008 prior art)。
- ✅ Codex design review 修订:隔离可行性诚实降级、AIO arm64 事实更新、backend 精确化、单机 threat model 补齐。
- ❌ 不写任何 runner 架构生产代码。PR 只 ship 这三份 doc。
- 🔜 下一步:PR → 交 Annie 在 §6 选 A/B/C。

## 8. 与 Annie 的 co-eval 学习记录（2026-07-08 · founder 决定 keep + ship）

> **Founder 决定：346 keep + ship，核心结论「AIO 非必须」。** Annie 用一版可交互 HTML 跟本 issue 做了多轮 co-eval，收敛出的学习记录如下（补充/精化前文，作为 durable 记录）。

1. **「AIO 非必须」** —— 现状（单机 Mac / tmux / cmux）下，把 AIO Sandbox 当 runner 运行时整套采用不值得（FLY-398 headless 冲突 / comm 上网络 / macOS Docker 税 / egress 仅 Linux）。AIO 不是我们必须做的东西。

2. **分层模型（关键洞察：AIO 与 homerail 不是二选一，可分层用）**：
   - **Hub 层 = 一个普通 container**（Lead + Bridge）—— 不用 AIO 胖环境，普通容器就够，你在这层实时看。
   - **Worker 层 = 每 runner 一个 container**（homerail 式、互相隔离）—— 要浏览器就把浏览器装进该 worker 容器。
   - **AIO = 可选的「胖节点」方案** —— 只在某个 worker 节点要「自带浏览器 + 桌面一整套」时才考虑（多半精简版），**不是 hub 层**。
   - 分层正好落在 1005 的「共享 hub + 每 runner 一节点」上。

3. **与 FLY-1005 对齐（AIO 的真正定位）** —— 1005 v5 已写「节点 provisioning 可站在 346 AIO Sandbox 上」。所以 346 AIO Sandbox 的定位 = **1005 预热节点池的容器化基座候选**（云/Linux 上 Docker 税消失、它自带浏览器桌面正好放 profile），**不是 346 独立采用**。要不要 + 用哪个（AIO 精简 / 自搭瘦镜像 / homerail 式），归 1005 定。

4. **Sandbox vs Container** —— 容器 = 底层机制（Docker 隔离/打包），沙箱 = 用途（给 agent 安全跑活），沙箱通常用容器实现；二者非对立。AIO 与 homerail 都是「沙箱」、底下都用「容器」，区别在形状（AIO = 面向人用的胖工作台 / homerail = 面向 agent 执行的瘦单元）。

5. **砍层 trade-off** —— AIO 开源可 fork 砍层，但砍到只剩终端+浏览器 ≈ 自己拼瘦容器。**诚实结论：与其「用 AIO 再砍」，不如「拿它当参考（组件构成/镜像分层）自搭瘦镜像」**（每层可控、保留实时看）。注：官方 repo 未提交现成 Dockerfile。

6. **AIO base OS** —— 容器里永远是 Linux（Mac 上走 Docker Desktop Linux VM = 性能税根因）。具体发行版据外部资料为 **Ubuntu 系（约 25.10）**；官方 repo 无 Dockerfile → 确切 base image **UNKNOWN / 待核**（未编造）。

**交付物**：本三件套 doc + 可交互 co-eval HTML（`co-eval-review.html`，分层图标签已澄清 hub=普通容器 / worker=container / AIO=可选胖节点）。**Ship = docs only，零 runner 架构生产代码。**
