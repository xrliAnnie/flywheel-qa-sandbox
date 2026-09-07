# FLY-2401 Raya 读侧激活 — 探索
Issue: FLY-2401 (https://linear.app/geoforge3d/issue/FLY-2401/raya读侧-按-fly-2131-激活清单把-raya-codex-leadagentidraya真正激活生产里-summary-6h)
日期: 2026-09-06
基于: 无

## 0. 目标与授权边界

这张单不再设计 summary 吸收机制。FLY-2131 已经交付
`summary-absorption-rider`、Raya TUI launcher、summary merge 安全栓和激活
preflight；FLY-2216/2259 又交付了常驻 carrier、plist、registry row、原子 registrar
和 801 行受审 cutover runbook。当前缺的是把这些已存在的机制按 FLY-2131
activation-checklist B/C 真正接入生产，以及让 Lead 能在动生产前看见完整 diff、停止线和
回滚。

本实现节点的授权边界：

- 可以读取生产状态并在 worktree 内准备文档、配置候选、只读校验器、受限 env transition
  helper 和测试；
- 不直接改 `~/.flywheel/projects.json`、`~/.flywheel/**`、`raya.env`、launchd、
  tmux、Discord 或运行中进程；
- 生产变更包准备好后，用 `flywheel-comm ask` 把每一处 diff、执行顺序、停止线和
  回滚报给 Lead；是否开窗、由谁执行由 Lead 决定；一旦 registry 写入，受控 Bridge reload
  与全 Lead fleet restart 是同事务硬条件；
- 不改 summary merge 授权契约，不给 Bridge 增加直发 `#raya` 的旁路。

## 1. 当前事实（2026-09-06 本机只读实核）

| 面 | 当前状态 | 影响 |
| --- | --- | --- |
| canonical registry | `projects.json` 共 6 个项目，`projectName=raya` 与 `agentId=raya` 都是 0 | `resolveRaya()` 返回 null，rider 每次 tick 都 no-op |
| `summary_absorption_round` | canonical `~/.flywheel/teamlead.db` 中 0 行 | 6h 读钟从未产生过真实 round |
| summary PR | `xrliAnnie/raya` #15–#24 共 10 张仍 OPEN；#15 已通过 installed `summary verify-pr`，head=`b8078338…` | 有真实 unread queue，可作为激活 preflight 与首轮验收样本 |
| Lead workspace | `~/Dev/raya-lead-workspace` 不存在；旧 canonical memory 在 `~/.flywheel/raya/memory` 且 clean | FLY-2131 C 尚未执行 |
| Codex home | `~/.codex-raya` 不存在 | founder 登录与同版 standalone 是硬前置 |
| carrier | installed wrapper 已存在并与 repo 一致；plist template lint 通过；正式 plist、manifest、launchd label 都不存在 | 代码已部署，生产出生步骤未执行 |
| Discord | `.env` 中 `RAYA_BOT_TOKEN` 键恰一条；row/launcher 钉 `channel=1542079099928059987`、`botUserId=1542068543645024257` | 静态坐标已齐，开窗前仍须做不泄 token 的 live identity/channel probe |
| identity | Raya repo `IDENTITY.md` 已含 summary absorption/visible reporting；0444 `~/.flywheel/raya/identity/IDENTITY.md` 与 repo source digest 不同 | 新 Lead launcher 只读 repo source；产品投影 drift 只审计、不写、不阻断 Lead ready |
| Raya product | `com.xrli.raya.brain` running；voice not running | 符合迁移前状态；搬 memory 时必须按 runbook 有界停/起 brain |
| `raya.env` | memory/root 仍指 `~/.flywheel/raya/memory`；没有 `RAYA_VOICE_OPTIONS_JSON` | FLY-2131 C.4 与 C.5 都未落 |

## 2. 要解决的实际问题

### 2.1 为什么现有 FLY-2259 runbook 没有自然闭环

它是安全、完整的生产 cutover 手册，但不是持续可运行的“当前差异报告”：

- 它要求 operator 手工收集大量前置证据，不能一条只读命令给出当前缺项；
- 其 `edit-raya-env.py` 有意只处理 memory 两键，没有覆盖 FLY-2131 C.5 的
  `RAYA_VOICE_OPTIONS_JSON.startInstructionsFile`；
- 它记录“常驻体出生”验收，但 FLY-2401 还需要把下一 6h boundary 的真实
  `summary_absorption_round` 与至少一张 summary PR 的 read-receipt merge 绑成最终验收；
- 当前 10 张真实 PR 是在 FLY-2259 完成后才形成的，旧文档无法冻结它们的实时状态。

### 2.2 这张单应补什么，而不应重做什么

补：一份当前 activation checklist、一条只读 readiness/audit 命令、一份可重生成的
production diff、首个 6h round 的验收命令。

不重做：registry row、launcher、wrapper、plist、常驻 patrol、summary merge 命令、
FLY-2259 的原子 registrar/回滚层级。

## 3. 方案比较

### 方案 A（推荐）：复用受审物料，新增只读审计与窄 env delta

- `projects.raya-row.json`、registrar、plist、wrapper、assignments 继续引用
  FLY-2259 的单一来源；
- 新校验器只读显式传入的 HOME/repo/registry/env/identity 路径，输出结构化状态与
  非零 pending，不做任何 rename/copy/launchctl mutation；
- 新 diff renderer 在内存中构造 proposed `projects.json` 与三键 `raya.env`，对 product
  identity projection 只输出 audit-only digest/diff，绝不写目标；
- 新三键 env transition helper 仅在 Lead/operator 显式调用时原子 apply/verify/rollback，
  不再让 FLY-2259 two-key verifier 把正确 C.5 新行判成无关漂移；
- 新 checklist 把 B/C、carrier、Discord、Codex home、Bridge + 全 Lead fleet restart、下一 6h round、
  PR read receipt 与逆序回滚串成一条线。

优点：最大复用、最小新代码，Lead 在批准前能审精确字节；fixture 测试能证明零生产写。
缺点：生产开窗仍是 operator 手工执行，这是本单明确的权限边界，不是遗漏。

### 方案 B：只引用 FLY-2259 runbook，不新增脚本

优点：零代码。缺点：C.5、当前身份投影漂移与 6h/merge 最终验收仍靠人工拼接，无法满足
“配置模板、校验脚本”和“每处 diff”的明确要求。

### 方案 C：新增通用 `flywheel-comm activate-lead` 写侧命令

优点：未来可一键激活。缺点：会新造生产 mutation API、授权/锁/恢复机制，并扩大到所有
Lead；既违背本单“按既有清单激活”，也会与 FLY-2259 已审 registrar/runbook 重叠。
否决。

## 4. 推荐设计轮廓

1. `verify-activation-state.py`：只读校验 pre/active 两态。pre 态允许
   registry/workspace/plist 尚未落，但把真正前置（row、旧 memory clean、Codex home、
   deployed wrapper、identity source/projection audit、env 旧值、token key）逐项输出；active
   态要求 `raya/raya` 唯一、workspace/env/deployed identity/plist/manifest 已收敛；product
   projection drift 不影响 ready。
2. `render-production-diff.py`：从当前 `projects.json` 与 `raya.env` 计算提案；只接受
   FLY-2131/2259 已钉目标，遇到重复 Raya、重复 env key、非法 JSON、非 regular file
   一律 fail-closed。identity 只展示 repo source → 0444 projection 的 diff。
3. `activation-checklist.md`：每一步均写“命令 / 期望输出 / 失败停止线 / 回滚”，并明确
   哪些命令只读、哪些只能由 Lead 批准后的 operator 执行。
4. 首轮验收：记录激活完成时间与 next epoch-aligned 6h slot；在 slot 后查询 canonical DB
   得到一条该 round，核其已投递给 `lead_id=raya`；再以 `summary merge` 回执、GitHub PR
   MERGED、`summaries/` 文件和 Raya memory provenance 证明至少一张被真正读收据 merge。

## 5. 已锁假设

- canonical production DB 是 `~/.flywheel/teamlead.db`；`~/.flywheel/state/teamlead.db`
  没有 `lead_events`，不可拿错库作验收。
- cadence 当前 effective default 是 `21600000` ms（6h），slot 按 Unix epoch 对齐；校验器
  必须从 DB/运行时读取，不把“每天本地 0/6/12/18 点”写死。
- registry 是 Bridge 启动时装载的 roster，新增 Raya 又会改变所有 Lead 的全表 summary/
  identity digest。生产窗口必须在 registry 写入前冻结旧 Lead 写流量，并立即由 Lead 批准的
  deployed transaction reload Bridge + restart 全 Lead fleet；新 digest 逐席验绿前不得解冻。
  本节点不执行生产重启。
- `restart-services.sh` 同时是 deploy transaction，会 fetch/fast-forward/build/converge。activation
  窗口只允许 fresh origin/main、checkout HEAD、deployed SHA 三者相等的 already-at 情形，并由
  Lead 冻结窗口内 main merge；有待部署 commit 时必须先单独部署，再重做全部 activation 基线。
- 10 张 PR 的状态会漂移，文档记录 as-of；最终脚本与验收重新读 GitHub current head/state。
