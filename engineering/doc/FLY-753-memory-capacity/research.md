# FLY-753 Swap/内存容量测算 — 调研

Issue: FLY-753 (https://linear.app/geoforge3d/issue/FLY-753/infraresearch-swap内存容量测算-现在能并发几个-session100-session-需多大内存什么机器配置)
日期: 2026-07-01
基于: exploration.md

> 所有数字均在 Annie 本机(48GB / 18 核 Apple Silicon)对**真实运行中的 20 个 claude session** 用 `footprint -p <pid>` 逐进程实测,非估算。测量时刻机器有 ~20 个 Lead/Runner session 在跑。

---

## 1. 测量方法

- 对每个 session 的**完整进程树**(claude 主进程 + 所有 MCP 子进程后代)逐个取 `phys_footprint`(= Activity Monitor 的 Memory 列,含压缩/swap 逻辑页,排除共享库)。
- 取样两个代表性 session:一个 Runner 形态(小 context),一个 Lead 形态(flywheel-eng-lead)。
- 交叉核对 20 个 claude 主进程 footprint 总和 + 系统级 `top` / `vm_stat` / `sysctl vm.swapusage`。

---

## 2. 核心发现:每 session 拆开算

一个 session = **1 个 claude 主进程 + ~15 个 MCP 子进程**(很多 MCP 经 npx 启动,一个 server = npm wrapper + node server 两进程)。

### 2.1 claude 主进程(可变部分,取决于 context)

| context 档 | phys_footprint |
|-----------|----------------|
| 小 context(默认) | **284 MB** |
| 1M-context | **606–632 MB** |
| 20-session 实测均值 | 421 MB(区间 284–632) |

### 2.2 MCP 子进程套件(基本恒定,与 context 无关)

一个 Lead session(flywheel-eng-lead)的 MCP 套件逐项实测:

| MCP 服务器 | 进程数 | footprint | 用途 | dev 必需? |
|-----------|-------|-----------|------|-----------|
| **chrome-devtools** | 3 | **272 MB** | Chrome DevTools 自动化 | ❌ 仅 QA |
| **serena** | 2 | **197 MB** | 语义代码检索 / LSP | ⚠️ 有用但重 |
| **playwright** | 2 | **150 MB** | 浏览器自动化 | ❌ 仅 QA |
| **context7** | 2 | **126 MB** | 第三方库文档查询 | ⚠️ 偶尔 |
| **discord** | 2 | **476 MB**(Lead)/ ~120(Runner) | Discord 收发 | ⚠️ 仅 Lead |
| **gbrain** | 1 | **76 MB** | bun 写作/记忆引擎(`gbrain serve`) | ❌ 内容侧 |
| **audible** | 1 | **62 MB** | 有声书 MCP | ❌ 完全无关 |
| **inbox-mcp** | 1 | **41 MB** | Lead↔Runner 收件箱(Flywheel 核心) | ✅ 核心 |
| **terminal-mcp** | 1 | **34 MB** | Lead 读写 Runner tmux(Flywheel 核心) | ✅ 核心 |
| **pencil** | 1 | **7 MB** | 设计工具 MCP | ❌ 设计用 |
| linear-api | 0(http) | ~0 | Linear issue | ✅ 保留(http 远程,零本地 spawn) |
| xiaohongshu-mcp | 0(http) | ~0 | 小红书 | ❌ 但 http 型不占内存 |

> **注**:`linear-api` 和 `xiaohongshu-mcp` 是 `type: http`(连远程/本地 HTTP 端点),**不 spawn 每-session 子进程**,内存开销≈0。删它们省不了内存;要删只为清爽。

**MCP 套件合计 footprint:**
- Runner 形态 ≈ **1.0 GB**
- Lead 形态 ≈ **1.4 GB**(多 audible + 更大的 discord gateway)

### 2.3 每 session 总账

| session 形态 | claude 主进程 | MCP 套件 | **合计 footprint** |
|-------------|-------------|---------|-------------------|
| 小 context Runner | 284 MB | ~1.0 GB | **≈ 1.3 GB** |
| 1M-context Lead | ~0.63 GB | ~1.4 GB | **≈ 1.6–2.0 GB** |
| **fleet 均值** | 421 MB | ~1.05 GB | **≈ 1.4 GB / session** |

### 2.4 ⭐ 最反直觉的结论

**内存大头不是 Claude 的 context,是 MCP 套件。**

- 小 context session 里,MCP 套件(~1.0 GB)是 claude 主进程(0.28 GB)的 **3.6 倍**。
- 每个 session **各自复制一整套** MCP 子进程 —— 20 个 session 就有 20 份 chrome-devtools、20 份 serena、20 份 context7…… 这才是 48GB 被 20 个 session 吃满的真因。
- 换 1M→小 context 每 session 只省 ~0.35 GB;砍 MCP 套件每 session 能省 ~0.6–1.0 GB。**优化 MCP 的杠杆远大于 context。**

---

## 3. 哪些 MCP 可以删 / 降级(回答 Annie 的追加问题)

按"对 Flywheel 工程 Runner 是否必需"分三档:

### ⛔ 直接删 / 移出默认(与工程开发无关)
| MCP | 省/session | 理由 |
|-----|-----------|------|
| **audible** | 62 MB | 有声书,纯个人用,session 里零用途 |
| **pencil** | 7 MB | 设计工具,eng 不用 |
| **bambu-h2d** | (未 spawn) | 3D 打印机,ops/GeoForge 专用 |

### 🔄 改"仅 QA 按需"(只有验收才用浏览器)
| MCP | 省/session | 理由 |
|-----|-----------|------|
| **chrome-devtools** | **272 MB** | 最重单项;绝大多数 Runner 从不开浏览器 |
| **playwright** | **150 MB** | 同上;浏览器自动化只有 QA session 需要 |

> 两项浏览器 MCP 合计 **422 MB/session**。改成"只有 QA 角色的 session 才加载"即可。

### 🔀 改"共享单例 / 按需"(有用但每 session 复制太浪费)
| MCP | 省/session | 理由 |
|-----|-----------|------|
| **serena** | 197 MB | 语义代码检索有用,但可做机器级共享单例,而非每 session 一份 |
| **context7** | 126 MB | 文档查询,可共享或首次调用时才起 |
| **discord** | ~120 MB(Runner) | **Runner 根本不直接发 Discord**(靠 Lead relay + flywheel-comm),Runner 挂 discord 插件纯浪费;仅 Lead 保留 |
| **gbrain** | 76 MB | 写作/记忆引擎,eng Runner 不需要;确认后移出 |

### ✅ 必须保留(Flywheel 核心,且都很轻)
| MCP | footprint | 理由 |
|-----|-----------|------|
| **terminal-mcp** | 34 MB | Lead 读写 Runner tmux |
| **inbox-mcp** | 41 MB | Lead↔Runner 收件箱 |
| **linear-api** | ~0(http) | issue 读写,零本地内存 |

### 一个 dev Runner 立即可省
```
chrome-devtools 272 + playwright 150 + audible 62 + pencil 7 + discord 120 = ~611 MB/session
```
= MCP 套件的 ~55%,整个 session footprint 的 ~45%。**再共享 serena+context7 又省 ~320 MB。**

---

## 4. 容量数学

**基线(非-session 占用)**:OS + Chrome + cmux + Discord app + codex companion + Typeless + Spotlight 等 ≈ **10 GB**(footprint 口径)。

### Q2 — 当前 48GB 安全并发上限

```
可用于 session(留 15% headroom,轻度 swap)≈ 48 × 0.85 − 10 = ~31 GB
每 session 1.4 GB → 31 / 1.4 ≈ 22 个(swap 饱和边缘)
```

| 状态 | 并发数 |
|------|-------|
| **安全(不抖 / 几乎不 swap)** | **~15–18 个** |
| **swap 饱和边缘**(开始抖) | **~20–22 个** ← 印证 Annie 观察的"20 吃满 swap" |

> **CPU 警告**:18 核。若多个 session **同时 active**(一起 build/test),瓶颈变成 CPU load(历史上 load 冲到 170–450 导致 WindowServer panic 死机),不只是内存。Flywheel session 多数时间 **idle**(等 gate / CI / review)→ 内存是主约束 → ~20。但 active-burst 要限并发。

### Q3 — 跑 100 个 session

| 方案 | 每 session | 100 session 内存需求 | 需要的机器内存 |
|------|-----------|---------------------|--------------|
| **优化前**(现状) | 1.4 GB | 100×1.4 + 10 = **150 GB** | **≥ 192 GB**(留 headroom) |
| **优化后**(FLY-751/752) | ~0.4 GB marginal + ~1 GB 共享池 | 100×0.4 + 1 + 10 = **~51 GB** | **64–96 GB** |

优化后每 session 构成:小 context claude(0.28)+ 核心 MCP(terminal+inbox+linear-http ≈ 0.08)+ 共享 serena/context7/浏览器(机器级单例,marginal≈0)= **~0.36 GB marginal**。

### Q4 — 机器配置建议

| 目标 | 优化前 | 优化后(推荐) |
|------|-------|--------------|
| **跑 100 session** | Mac Studio **256 GB** RAM(M3 Ultra),24–32 核,~$7–8k | Mac Studio **96 GB** RAM(M2/M3 Max),舒适;64 GB 也能勉强 |
| **现有 48GB 机器** | ~18 个 session 就抖 | 优化后可提到 **~40–50 个**(不换机器!) |

> **省钱结论**:先砍 footprint,再决定要不要换机器。光在当前 48GB 机器上删掉用不到的 MCP,并发上限就能从 ~18 **翻倍到 ~40**,当下 swap 抖动问题直接缓解。

---

## 5. 数据可信度与注意

- ✅ 全部 `phys_footprint` 实测,20 个真实 session,非估算。
- ⚠️ 系统级总量随 active/idle **波动大**:测量窗口内 swap 从 14GB 掉到 ~0(session idle 时 MCP 页被压缩/释放,active 时膨胀)。→ per-session footprint(稳定)是可靠交付;系统级 20-session→swap-full 是 active-burst 峰值,也与 Annie 观察一致。
- ⚠️ 100 truly-concurrent-**active** session 是 CPU-bound,与内存无关;本研究假设 Flywheel 典型的"多数 idle、少数 active"模型。
- MCP 套件在不同 session 略有差异(Lead 有 audible + 大 discord;Runner 较小)。取 fleet 均值 ~1.05 GB。
