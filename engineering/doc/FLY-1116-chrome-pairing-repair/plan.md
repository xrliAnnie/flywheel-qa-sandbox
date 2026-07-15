# FLY-1116 Claude-in-Chrome 全机断连 — 实施计划

Issue: FLY-1116 (https://linear.app/geoforge3d/issue/FLY-1116/fix-claude-in-chrome-全机断连-修复配对-产出-chrome-repair-skillp1阻塞所有-founder)
日期: 2026-07-10
基于: research.md

## 0. 状态与本计划的边界

- brainstorm gate：**已过**（Tadashi APPROVED，三点裁定：skill 落 flywheel-skills、keepalive 不开新单写 follow-ups、R2 当晚授权）。
- 设计阶段现场修复实测（详见 §2.1 决策表 + exploration 时间线）：当时判 R3 扩展 OFF/ON（00:21）与 R2 重启 Chrome（00:33 已执行）均无效，claude.ai/chrome 开页（00:41）、/chrome Reconnect（00:4x，Lead pane 实操）亦无效——**证明状态后经 implement v5 修正：R2 的判定 = 假阴性（实际当秒注册成功）；R3/开页/Reconnect 的观察 = 不可归因（观察会话查错账号频道），其「不修 token」结论降级为机制推导（见 §2.1 修正注记）**。待执行 = R5/R6（token 修复，需 founder）。修复闭环可能在设计阶段完成，本计划按「实现阶段接手时闭环已完成/未完成」两种起点都可执行（Phase A 幂等）。
- 本计划**不改 flywheel packages 生产代码**。交付 = 现场修复闭环 + flywheel-skills repo 新 skill + 本仓文档。生产 Bridge/Lead 进程不动。

## 1. 目标与验收

| 交付 | 验收标准（客观证据） |
|---|---|
| D1 修好 | **验收会话 + 目标 profile 均先钉死**（§3 A0），然后三连：list_connected_browsers ≥ 1 **且** tabs_context 正常 **且** navigate 打开页面并读回内容，且连上的浏览器被确认为 founder-path 所需实例（§3 A4）。证据 = 最小化摘录（判定行 + 时间戳），**非全文粘贴**（§6 证据卫生） |
| D2 chrome-repair skill | flywheel-skills repo PR（skills/generic/chrome-repair/），CI 五道门绿 **+ skill 自带 fixture 测试绿**（§3 C2b）；预合并用隔离加载路径验证可触发（§3 C5）；QA 阶段按 §3 D3 修订后的合同验证 |

## 2. 根因模型（v4 定稿，exploration/research 实证）

1. **L1 最佳解释假说（弃连机制 = 扩展 1.0.80 源码级实证；作为本次事故实际状态未被现场证实，见 §2.1 修正注记）**：扩展持有**自己独立的 OAuth token**（chrome.storage：ACCESS_TOKEN/REFRESH_TOKEN/ACCOUNT_UUID，与浏览器 cookie 登录态两套体系）；**每 30 秒 alarm** 重连 bridge（wss://bridge.claudeusercontent.com/chrome/{account_uuid}，账号频道、多会话共用），但连接函数在 token 失效 / token↔账号不一致时**静默 return、无 UI 提示** ⇒「面板看着已登录 + worker/native host 活着 + 永远 0 browsers」。23:16:40 短暂恢复的机制解释 = panel-open 触发 cookie→token 刷新后 alarm 自动接通（相关性证据，R5/R6 未完成前保持「机制推导」标签）。CLI 侧无任何唤醒/修复手段（manifest 无 native-initiated connections）。⇒ **修复的本质 = 恢复扩展 token 健康**，之后 ≤60 秒自动接通。
2. **L2 结构陷阱**：CLI 有效凭据账号 ≠ 扩展 claude.ai 账号 ⇒ 该会话永远 0 browsers（chrome_bridge_account_mismatch）。有效凭据有两条来源：Keychain（/login 可修）与 **CLAUDE_CODE_OAUTH_TOKEN env**（/login 改不动，须改 env/换会话）——两条路径在诊断树里分开处置。
3. **L3 次要**：pairedDeviceId 陈旧，单浏览器无害；多浏览器才需 switch_browser 重配。

### 2.1 修复算法与动作表（唯一真相 —— A3、C3、QA、上游报告一律逐字引用本节）

**算法是分支结构，不是线性编号**（覆盖 L2+L1 组合故障）：

```
A0/A1 诊断
 ├─ L2 阳性（凭据账号 ≠ 扩展账号）
 │    ├─ env override 路径 → 修 env / 换会话（/login 无效）
 │    └─ Keychain 路径 → R4 /login 对齐
 │    → 重新 list：≥1 → A4；仍 0 → 进入 L1 ladder（不跳升级！组合故障常态）
 └─ L2 一致 / UNKNOWN → 直接进入 L1 ladder

L1 ladder：R5 → R6 → R2+R5 → 升级（每步后轮询 list 60–90s）
```

| 动作 | 前置状态 | 证明级别（截至设计阶段） | 见效窗/轮询 | 成功去向 | 失败去向 |
|---|---|---|---|---|---|
| R4 账号对齐（Keychain 路径 /login；env 路径改 env/换会话） | L2 阳性 | 机制实证（账号频道 URL） | 对齐后重新 list | A4 验收 | **进入 L1 ladder（R5）** |
| R5 panel-open（founder：目标 profile 点 Claude 图标开侧边栏，置 60 秒）。机制：把扩展 token 刷成 profile **当时活跃的** claude.ai 登录——只在目标账号=该活跃登录时有意义 | L1 ladder 第一步；token 浅度过期嫌疑 | 机制推导；浅度过期态待验。00:53 实测（Annie 开侧边栏保持打开，Lead 01:08/01:19 两次 list []）**不构成深度失效证伪**——观察会话持旧账号 token（假阴性，见下方修正注记） | ≤60s（30s alarm） | A4 验收 | R6 |
| R6 面板内登出→重登 claude.ai（founder，重写扩展 token；**重登账号必须 = CLI 凭据账号**，登错账号会当场制造 L2） | R5 无效 | 机制推导（源码级：连接前提 = token 健康） | ≤60s | A4 验收 | R2+R5 |
| R2 重启 Chrome（自动化；osascript 优雅退出 + open -a）**后必接一次 R5** | 仅作 R5/R6 后的辅助（清 worker/浏览器残态） | 00:33「T+8min 0 注册」判定系**假阴性**（见修正注记）。修正结论：token 健康+账号一致前提下 R2 当秒重建注册；对 token 类故障单独仍无效 | 重启+R5 后 ≤60s | A4 验收 | 升级 |
| 升级：重装扩展（仅目标 profile，重走 pairing.html 首配流）+ 官方 bug 报告草稿 | L1 ladder 走完仍 0 | — | — | A4 验收 | ask 上报阻塞 |

**负知识（禁止单独作为修复手段；证明级别如实标注）**：R3 扩展 OFF/ON、claude.ai/chrome 开页、/chrome Reconnect 单独——三者「不修扩展 token」是**机制推导**（源码级）；其当晚（00:21/00:41/00:4x）的「实测无效」观察经 implement 修正为**不可归因**（00:21 起扩展 token 可能已刷向 northwestern，旧观察会话查的 shopping 频道注定为空）。R2 单独对 token 类故障无效（00:33 的原始「实证」经修正为假阴性观察，见注记）。历史上的 R0/R1 编号动作已废弃并入本清单/实验。

**Implement 阶段修正注记（2026-07-10 01:19–01:45 实测，根因模型 v5）**：

1. 23:40:10 PT 机器 Keychain 凭据条目被**重建**（cdat=mdat 同秒）并切至 northwestern 账号；该 profile 的 claude.ai 活跃登录自 07-09 12:42 PM 起即为 northwestern（Active sessions 页实证）——「侧边栏截图显示 Annie Shopping」与活跃登录并存，显示名不可作账号判据。
2. 00:33:45 扩展注册成功（connectedAt 与 R2 重启**同秒**），落在 northwestern 账号频道；23:40 前启动的所有观察会话（design 会话 23:27 生、Lead 长寿会话）持旧 shopping token、查 shopping 频道 → 它们的 list=[] 全部是**假阴性**。
3. implement 会话（01:19 生，northwestern 凭据）A4 三连全过；CLI organizationUuid 与浏览器 claude.ai Account 页 Org ID 逐字一致（864291bc-…）= 账号对齐铁证。
4. 新增全局前置（进 skill 铁律）：**验收会话必须与扩展同账号；刚切号后旧会话不可作验收会话；修复动作后的验证一律用新起会话。**
5. Annie 00:53 panel-open 后 Lead 旧会话 list=[] 的观察，既不构成「R5 对深度失效无效」的证据，也不构成任何正向归因——扩展彼时已在 northwestern 频道注册 20 分钟；该观察只表明旧账号（shopping）频道未被恢复。「panel-open 按 profile 活跃登录刷 token」是源码级机制事实，但本次事件中扩展 token 何时、被哪个动作刷新**不可观测**（token 存储在 LevelDB，动作归因 = UNKNOWN；与注册时刻唯一可判的动作关联是 R2 的同秒时间相关性）。
6. 运维警示：**晨间 R6 不再必要**（系统已闭环）；若在面板里登出重登到 shopping，会把扩展 token 写回 shopping 而 CLI 仍是 northwestern → 当场重新制造 L2 断连。将来若要把机器切回 shopping，必须 CLI /login 与浏览器登录**同窗一起切**。

## 3. 实施步骤（implement 阶段照此执行）

### Phase A — 修复闭环（幂等；若设计阶段已闭环则只做 A4 复核）

- **A0 钉死目标**：明确「验收会话」（哪个 agent 会话做三连）与「目标 Chrome profile」（founder-path QA 用的、登录 claude.ai=Annie Shopping·Max 的 shopping profile）。后续所有判定都以这两者为准。
- **A1 诊断快照（只读）**：
  - 验收会话自查：oauthAccount（~/.claude.json）+ `env | grep -c CLAUDE_CODE_OAUTH_TOKEN`（**逐会话自查**，macOS 读不到他进程 env）+ Keychain mdat（不带 -w）
  - 机器面：pgrep chrome-native-host（记 PID/lstart；**只证明某 profile 的 worker 活着，不证明目标 profile 健康**）+ list_connected_browsers + uptime
  - 扩展侧账号：founder 在目标 profile 窗口目检侧边栏登录名（与其它 founder 动作攒同一批；目检显示名=**弱证据**，账号判定以 org-ID/email 级证据为准，见 A4 实例确认）
  - 任何一项取不到 → 记 UNKNOWN 并继续，不猜。
- **A2 L2 判定分支**（严格按 §2.1 算法）：
  - 验收会话 env override 阳性 → /login 无效路径：改 env / 换无 override 的会话，或按来源修 env 注入方（不属本 issue 的注入方只记录上报）→ 重新 list；仍 0 → A3
  - Keychain 路径账号 ≠ 扩展账号 → R4（founder /login 对齐，攒批）→ 重新 list；仍 0 → **A3（组合故障，不跳升级）**
  - 一致或 UNKNOWN → A3
- **A3 L1 ladder**：逐行执行 §2.1（R5 → R6 → R2+R5 → 升级），每步后轮询 list 60–90 秒。founder 动作按 §5 维护窗一次性攒批预告。
- **A4 验收三连 + 实例确认**：list ≥1 → tabs_context → navigate https://example.com + read_page 读回内容，**趁存活窗连续完成**（勿拖）；随后确认连上的实例就是目标 profile：单浏览器时以 isLocal + founder 同窗目检为准；多浏览器时走 switch_browser 确认流选定目标。证据按 §6 最小化留档。
  - 术语：**LIVENESS-CHECK = 仅 list_connected_browsers ≥1**（轻量存活探测，用于实验收尾/QA 结尾）；凡实际触碰过 founder profile 的动作，收尾跑**完整 A4**，不是 LIVENESS-CHECK。
- **A5 全序失败** = flywheel-comm ask 上报 + 阻塞升级，不硬续。

### Phase B — 实验（回填 skill 用；失败/不可安全建态一律记 SKIPPED（原因），**绝不为凑实验主动破坏已修复的 founder profile**）

统一协议：**precondition（原始证据）→ 单一动作 → 0→1 成功标准 → cleanup → 末尾对 founder profile 跑 LIVENESS-CHECK（仅 list；若实验实际触碰过 founder profile 则跑完整 A4）**。故障态只允许两种来源：①自然出现的同型故障（等到才做）②隔离环境（disposable Chrome profile + 一次性会话）。

- E2 脚本化 /chrome Reconnect：一次性 tmux 交互式 claude 会话；**capture-pane 按可见文案定位菜单项、动作前后各校验一次**，禁止盲 send-keys 固定序号（误选 Disconnect 风险）；在「已知断连态」下执行才可归因；验证它到底修什么。可归因阳性 → 修订 §2.1 后才准进 skill。
- E3 存活窗测量（只观察不注入，观察窗有界，建议 ≤45 分钟）：A4 成功后记录「最后一次浏览器操作 → list 变空/native host 消失」时长。**结果合同：OBSERVED=<duration> | NOT_OBSERVED_WITHIN=<观察窗> | SKIPPED=<原因>**——preflight 段按此分支（见 C3-5），无可靠 duration 时不得写伪精确 idle 阈值。若与 30s alarm 持续唤醒模型冲突，如实记录冲突，不强行归纳。
- O1 deviceId 稳定性：**前置 = 两个样本确认来自同一目标 profile**，否则只记 UNKNOWN（现有 fd627eee vs 7d4ee494 尚未确认同源）。对比修复前后注册 deviceId 是否轮换 → 决定 skill 对 pairedDeviceId 的措辞。
- （E1 tab 唤醒已在设计阶段以 00:41 实测记负，写入负知识，不再重复。）

### Phase C — chrome-repair skill（canonical 交付物）

- **C1 工作区纪律**：flyview-skills 本地主 checkout（~/Dev/flyview-skills）当前有用户改动且落后 tracking ref —— **不得直接在其上开发**。步骤：fetch 权威 base → 从 origin/main 建 FLY-1116 专用 branch + **独立 worktree**（repo 惯例目录）→ clean-tree 检查过了才动工。
- **C2 结构（两级判定合同——shell 只能证明本机局部，绝不判总体健康）**：skills/generic/chrome-repair/SKILL.md（主体）+ scripts/chrome-diagnose.sh（只读，仅覆盖 A1 的**本机子集**：oauthAccount / env override 计数 / Keychain mdat / pgrep native host / uptime）。
  - 脚本合同：输出 `LOCAL_STATUS=READY|DEGRADED|UNKNOWN` + 每层证据行；退出码 READY=0 / DEGRADED=1 / UNKNOWN=2；shellcheck 过；绝不 security -w、绝不打印 token 值；set -e 下 0 计数不得早退；**禁止在脚本里嵌套启动 claude 会话**。
  - `OVERALL_STATUS=HEALTHY` **只能由 skill agent 判**：在会话内完成 MCP 三连（list/tabs_context/navigate）+ 目标实例确认之后。本次事故的铁证正是"本机全绿而 list=0"——LOCAL_READY ≠ HEALTHY 写进 skill 显著位置。
  - **不写修复脚本**——修复动作由 agent 按树逐步执行并逐步验证。
- **C2b 自带 fixture 测试**（随 PR 进 CI；五道门的 contract fixture 门只测 founder-html-delivery，不覆盖本 skill）：mock HOME/security/pgrep/ps，覆盖：无 ~/.claude.json / JSON 损坏 / Keychain item 缺失 / 多个 native host / env override 0 与 1 / 非 macOS 或命令缺失 → 断言 **LOCAL 合同**稳定（状态值+退出码）、无敏感值泄漏。agent 级组合判定（LOCAL+MCP 三连 → OVERALL）由 D3 真机 QA 证明，fixture 不冒充。
- **C3 SKILL.md 骨架（写作合同）**：
  1. 触发词：chrome 断连 / Browser extension is not connected / list_connected_browsers 空 / chrome-repair / 修 Claude-in-Chrome
  2. 架构速览（一段 + mermaid：CLI↔bridge↔extension、native host 角色、账号频道、扩展自有 token 两套体系）
  3. 分层诊断树（每层：命令原文/判定标准/UNKNOWN 分支/去向）：①CLI 注入层 ②账号层（Keychain 与 env override 两条路径分开处置；扩展侧账号=founder 目检）③注册层（list）④worker 层（pgrep + lstart，标注"只证明某 profile 有 worker"）⑤通路层（tabs_context/navigate）⑥配对层（多浏览器才管）
  4. 修复算法：**逐字引用 §2.1 算法与动作表**——先 L2 分支判定（env/R4），重新 list 仍 0 再进 L1 ladder（R5→R6→R2+R5→升级）；**R4 是 L2 分支、不是 ladder 的一步**；含维护窗攒批话术模板与每步轮询窗
  5. QA preflight 段：founder-path QA 开跑前三连验证；断了先修再测。中途复测策略按 E3 结果合同分支：OBSERVED=<duration> → 超过该时长无浏览器操作后重跑 LIVENESS-CHECK；NOT_OBSERVED_WITHIN / SKIPPED → **不写伪精确阈值**，只要求每次 founder-path QA 开跑前 preflight
  6. 执行者矩阵：任意会话可跑 / Lead pane / founder（攒批铁律）
  7. 多账号陷阱：本机多 Claude 账号历史 + macOS 读不到他进程 env + 逐会话自查法 + env override 的 /login 无效陷阱
  8. 负知识清单：§2.1 表底行 + named-pipe（Windows-only）+ --chrome flag（FLY-812 已默认开）+「面板显示已登录 ≠ token 健康」
  9. 证据卫生：只留最小摘录，redact email/deviceId/无关 tab 标题
- **C4 CI**：五道门绿 + C2b fixture 绿。
- **C5 生效路径（遵守 flyview-skills 分发合同：canonical = ~/.agents/skills/<name>，Claude/Codex 逐 skill symlink；禁止手工 cp 到 ~/.claude/skills 造真目录）**：预合并验证用**隔离加载**（临时 CLAUDE_CONFIG_DIR 或 repo 内 fixture 会话指向 worktree 路径）；merge 后由 canonical skills-sync.sh / launchd 日更接管；如需当天生效，跑一次 canonical sync 脚本（不是手工 cp），并验证三端 symlink。
- **C6 PR**：flywheel-skills 流程（founder-gated merge，同 FLY-510）。

### Phase D — 文档与收尾

- D1 exploration/research/plan/progress **原位更新**并随本仓 docs PR 进 main（doc-flow 无状态文件夹约定：**不做 git mv archive**，状态看 Linear）。
- D2 本仓 PR：docs only（本文件夹）。PR body 链 Linear issue。
- D3 QA 阶段合同（修订版——**toggle 不是等价故障注入**：token 健康时 toggle 后 30s alarm 会自愈，造不出断连）：
  1. D1 验收以**本次真实事故的原始证据**（设计阶段留档）+ implement 阶段 A4 复核为准；
  2. 诊断树/输出合同在**隔离 fixture**（disposable profile / mock）上验证；
  3. preflight 段在一次真实 founder-path QA 开跑前实测；
  4. 若期间自然出现同型故障，才做"照 skill 修通"实战验证（机会性，不注入）；
  5. QA 结束后对目标 founder profile 收尾：期间未触碰 founder profile → LIVENESS-CHECK（仅 list）；触碰过 → 完整 A4。

## 4. Follow-ups（冻结解除后再立单——gate 裁定 b；措辞=假说与测量项，不预设已推翻的模型）

1. **保活/断连监控（假说待测）**：已知扩展自带 30s 重连 alarm，本次故障的最佳解释是 auth 前提失败而非缺流量（L1 假说级）——keepalive 至多缓解 idle 类断连（E3 会给出存活窗数据），**不能修 token**。设计要点：谁持有会话、token 成本、断连告警接 #flywheel-alerts（watchdog 扫 list / native host 存活）。
2. 机器减负（49 会话 / load 14-17 是复发温床，独立课题）。
3. 上游报告（先草稿后授权提交，见 §5）：聚焦「30 秒 reconnect alarm 在 token 失效/账号不一致时**静默早退、无任何 UI 提示**」，区分 worker liveness / bridge registration / auth health 三个概念；附本文档时间线。

## 5. 风险与执行纪律

- **founder 维护窗（打扰攒批的执行形态）**：一次性向 Annie 预告完整可能序列「R5 开侧边栏 → 等 60s → 若无效 R6 登出重登 → 等 60s → 必要时 R2 重启 Chrome **且重启后再开一次侧边栏（R5）** → 仍无效才重装扩展」，逐步口头确认推进；R2 前提醒未存表单会丢；重装仅目标 profile，重装前记录 profile/扩展 ID/版本，**绝不备份或提交 token storage**。
- 官方 bug 报告 = 本次只产 sanitized 草稿；对外提交是外部写操作，另经 Lead/founder 授权。
- skill 纯文档+只读脚本：回滚 = revert PR / 重跑 sync，零生产影响。
- E2 的一次性 tmux 会话用完即关（一次性辅助 pane，非 Runner，不破 Lead 驱动 Runner 生命周期铁律）。
- 不确定项如实标注：R5/R6 见效窗 60s 是机制推导值，实测偏差就更新 §2.1 表。

## 6. 证据卫生（QA/progress 留档规则）

- 工具返回**不整段入 Git**：只留判定行 + 时间戳 + 最小摘录。
- redact：账号 email、deviceId、无关 tab 标题/URL；navigate 验证用自建干净 tab（example.com）。
- 任何含 token/凭据可能性的输出（keychain、storage dump）一律不落盘不入库。

## 7. 里程碑

| # | 内容 | 证据 |
|---|---|---|
| M1 | 修复闭环（Phase A） | A4 最小化证据摘录 |
| M2 | 实验结论（Phase B，允许 SKIPPED） | E2/E3/O1 各一段结论回填 research.md |
| M3 | skill PR（Phase C） | flywheel-skills PR + 五道门 + C2b fixture 绿 |
| M4 | 本仓 docs PR + QA handoff（Phase D） | PR + D3 合同 |
