# FLY-2029 Raya V1 地基 — 探索
Issue: FLY-2029 (https://linear.app/geoforge3d/issue/FLY-2029/rayav1-地基独立仓-codex-身份-raya-频道-v2-语音桥-试用期三指标自动记录)
日期: 2026-08-25
基于: 无

## 1. 任务的真实完成态

本单不是在 Flywheel 仓里放一份 Raya demo。完成态同时包含五件可独立核验的事实：

1. Raya 的运行代码在独立 Git 仓，离开 Flywheel 源码仍可安装、启动和维护。
2. 长期记忆另有独立 Git 仓与 `MEMORY.md`；Codex 自带的 `memories_1.sqlite` 只证明存储随 `CODEX_HOME` 隔离，不能代替这座仓。
3. Raya 使用独立 `CODEX_HOME`、`gpt-5.6-sol`、`xhigh`，1M 只作为该会话启动参数；不得写进共享 `config.toml` 顶层。
4. Discord 中存在 `#raya` 与 Raya 本人身份，头像使用 PRD 已选的真实电影渲染图；Raya 能加入语音房并出声。
5. 试用期持续产生可查询的三项时间序列：Raya 进程内存、相对启动基线的 swap 变化、实际 context 用量/峰值。

“脚本能运行一次”不证明以上完成态；验收需要仓、配置、Discord 状态、音频行为和落盘数据各有直接证据。

## 2. 已拍板且不再重问的输入

| 维度 | 决定 | 约束来源 |
|---|---|---|
| 名字 | Raya | FLY-1846 PRD §8.6.2 |
| 代码载体 | 独立仓 | §8.5、§8.6.3 |
| vendor / model | Codex / `gpt-5.6-sol` / `xhigh` | §8.6.1、FLY-1451 |
| context | 总管先行 1M；单会话参数 | §8.6.6、FLY-2029 |
| Discord | `#raya`；分区由 founder 后续自行处理 | §8.6.4–§8.6.5 |
| 头像 | PRD assets 中 `raya-avatar-square.png` | §8.6.2.3 |
| 语音载体 | realtime v2 | FLY-1451；FLY-1911 只作实证参考 |
| 能力姿态 | 默认全部能力，发现问题后再针对性限制 | §8.4 |
| 试用期指标 | RSS/进程内存、swap 变化、context 实际峰值 | §9.1b、§13.0a |

## 3. Ponytail 决策梯

### 3.1 跳过的东西

- 不实现 v3 fallback：本单明确指定 v2，v3 上游阻塞属 FLY-2021。
- 不复制 FLY-1911 的实验账本、浏览器 demo、测试 asker、录音耳朵或一次性排障脚本。
- 不建设指标 dashboard、数据库或遥测平台；试用期只要求三项有可查数据，结构化 append-only 文件即可满足。
- 不替 founder 决定 Discord 分区。
- 不把 1M 写成共享默认，也不为“未来所有人”提前造配置系统。

### 3.2 优先复用的能力

- Node 标准库负责 Codex 子进程、JSON-RPC、进程采样和 JSONL 落盘。
- Codex app-server 的 realtime v2 WebSocket 通道负责双向 PCM；不另引语音模型或 STT/TTS 服务。
- Discord 侧只引入已被 PoC 证明必要的 voice/Opus 组件；产品仓不依赖 Flywheel package。
- macOS 原生 `ps` / `sysctl`（以 research 实测为准）提供进程和 swap 数据，不造常驻监控 daemon。
- Codex 已有事件/状态字段能给 context 真值时直接记录；不从日志长度或文件大小猜 token。

## 4. 载体选项

### A. Raya 代码放 Flywheel

拒绝。它直接违反 §8.5 的“假设使用者没有 flywheel 仓”与 §8.6.3 的独立产品判据。

### B. Flywheel 只放模板，未来再建 Raya 仓

不足。它能交付审查材料，但不能证明独立仓、独立记忆、频道身份、语音和试用数据已经存在。

### C. 两个独立仓 + 最小机器接入

采用：

- `raya`：运行代码、身份说明、启动配置、测试和运维说明。
- `raya-memory`：`MEMORY.md` 与只追加/提炼规则；不混入运行代码。
- Flywheel 本单分支：仅保留 doc-flow、接入证据、必要的机器侧可复现变更说明和最终 milestone。
- 机器侧：独立 `CODEX_HOME`、凭据引用、项目注册/启动项与可查询的试用期数据目录。

这样既满足独立产品边界，也保留 Flywheel issue/PR 的审计链。具体仓名、落盘路径与 PR 编排在 research 后写死。

## 5. 语音桥最小闭环

FLY-2074 负责在 Raya 仓内把这条链重写为独立 voice package / 独立进程；本单负责仓骨架、Codex session 参数、`RAYA_*` / metrics 契约和最终 E2E，不平行写第二份桥。

必须保留的闭环只有：

```text
Discord 语音 PCM → realtime v2 appendAudio → Codex
Codex outputAudio/delta → Discord voice player → Annie 听见
```

还需暴露 founder 已要求的可见状态：连接、listening、转写、working/speaking、断开/错误。哪些状态放 `#raya`、哪些只进运行日志，由 B/C PRD 与现有 PoC 事件实测决定；不能把 PoC 当规格直接照搬。

## 6. 三指标的数据合同

每条样本至少带 `timestamp`、`sessionId`、`pid`，并分别记录：

- memory：当前 RSS 与运行期峰值；口径是 brain、voice 两个 root pid 加各自 Codex 后代的完整进程森林。
- swap：启动时 `usedBytes` 基线、当前 `usedBytes`、`deltaBytes`；PRD 的 79% 是历史背景，不冒充本次启动基线。
- context：当前实际用量、运行期峰值、配置 window 上限与占比；采不到真值必须 fail loud，不能写 `0` 冒充“没用”。

数据必须跨进程重启保留，并提供一个无需运行服务即可查询的命令。暂不设数字目标，符合 PRD §9.2。

## 7. 主要风险与验证点

1. Codex 0.148.0 的 PoC API 与当前 binary 可能漂移；先用当前 binary 做 JSON-RPC contract probe。
2. context 使用量未必直接出现在 realtime 事件；必须找到权威字段或明确的 Codex 状态 API，不能估算。
3. Discord bot token、应用身份、头像与频道是四类不同外部状态；不能用“频道已建”推断“Raya 身份已上岗”。
4. Discord voice 接收使用 Opus，发送使用 PCM→Opus；依赖与 native/JS codec 选择要以当前 Node/macOS 实测为准。
5. 本单是 DAG implement 节点；设计通过前只写文档和探针，不写产品实现。

## 8. 明确不缩掉的验收

- “全能力”不能被悄悄改成只读 demo；身份的 sandbox/approval 配置必须与现行 Codex Lead 能力边界一致。
- “能进语音房出声”必须用真实 Discord 房间与独立听者/录音或 founder 反馈证明，不能只看 `JOINED` 日志。
- 三指标必须在一次真实 Raya 会话中落盘并可查询；unit test 里的 fixture 不算试用期数据。
