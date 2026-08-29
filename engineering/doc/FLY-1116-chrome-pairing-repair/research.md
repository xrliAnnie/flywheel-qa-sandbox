# FLY-1116 Claude-in-Chrome 全机断连 — 调研

Issue: FLY-1116 (https://linear.app/geoforge3d/issue/FLY-1116/fix-claude-in-chrome-全机断连-修复配对-产出-chrome-repair-skillp1阻塞所有-founder)
日期: 2026-07-10
基于: exploration.md

## 1. 调研问题（承接 exploration §7 + Lead 指令「自动化恢复优先、founder 兜底」）

1. CLI↔扩展连接生命周期的机制细节（决定哪些恢复动作有效）
2. Flywheel 侧各会话类型的 chrome 接线现状（issue 问题 #2）
3. 恢复路径清单：哪些**无需 founder** 可自动化？各自证明程度？
4. 防复发：QA 期间如何不再断？
5. 账号错配（L2）的机器可查检测法
6. skill 落点与形态

## 2. 连接机制细节（CLI 2.1.206 二进制取证）

### 2.1 CLI 侧生命周期

`connect()` → wss://bridge.claudeusercontent.com → handshake（超时告警 "Bridge connect stuck after Nms (ws_state=…)"）→ `authenticated`。遥测全集（= 故障态枚举，skill 判读用）：

`chrome_bridge_connection_started/succeeded/failed`、`chrome_bridge_handshake_timeout`、**`chrome_bridge_account_mismatch`**、`chrome_bridge_peer_connected/peer_disconnected`（peer = 扩展端点）、**`chrome_bridge_reconnect_exhausted`**（重连有退避上限，耗尽即放弃——与「worker B 在 shopping 频道 40+ 分钟无注册」的观察**相容**（该观察不能定位 worker B 的具体状态）；机制上两侧都存在"放弃后不再自愈"态）、`chrome_bridge_tool_call_*`。

### 2.2 启用门（CLI 侧注入层，本次全部无恙）

chrome MCP 注入条件链：`--chrome` flag / `/chrome` 启用 / `claudeInChromeDefaultEnabled`（本机 = **true**，全会话默认注入）/ GrowthBook `tengu_chrome_auto_enable` / env `CLAUDE_CODE_ENABLE_CFC`。注入时 CLI 顺带安装 native host（`oKu("<execPath> --chrome-native-host")` → 写 wrapper + manifest）。**推论：每次 CLI 版本更新后首个会话会重写 wrapper**（解释 wrapper mtime 16:41 ≈ 2.1.206 落地后）。

### 2.3 /chrome 菜单语义

- 选项：**"Reconnect extension"** / **"Disconnect this session"**。
- 0 浏览器分支文案："No browsers are connected. Open Chrome with the Claude extension and make sure you're signed in to the same claude.ai account."（Tadashi 今晚实测命中此分支）
- Reconnect 的机器可见效果 = 重装 native host 配置 + 重置连接状态；二进制原文："(Reconnect extension), and **the next Claude Code session will detect the extension automatically**" ⇒ 它修的是**机器级**状态，非仅本会话。
- v2.1.199 起：仅**首次安装**会自动开一个「连接扩展」引导 tab；之后重写配置不再开 tab ⇒ **CLI 无法主动唤起扩展**（manifest 无 `supports_native_initiated_connections`，native messaging 只能扩展侧发起）。这是「CLI 侧无自愈手段、必须扩展侧动」的机制根源。

### 2.4 配对记录

扩展配对成功回调 `onExtensionPaired(deviceId, name)` → 写 `~/.claude.json` `chromeExtension{pairedDeviceId, pairedDeviceName}`。实测单浏览器时旧记录（fd627eee ≠ 当前 7d4ee494）不阻断操作 ⇒ 配对是**路由偏好**；`switch_browser` 确认流用于多浏览器重配。deviceId 是否随每次 worker 重生轮换 → implement 阶段观察（O1）。

### 2.5 扩展侧机制（v4，本地扩展 1.0.80 源码解剖 — assets/mcpPermissions + service-worker，最终版根因）

1. **bridge URL 按账号开频道**：`wss://bridge.claudeusercontent.com/chrome/{account_uuid}` —— 任意多个 CLI 会话共用一个账号频道；「唯一连接绑死某会话」的单绑定理论**不成立**（rebind 概念不适用）。
2. **扩展有每 30 秒的重连 alarm**（`alarms.create(…,{periodInMinutes:.5})` + isConnected 检查）——它其实一直在重试；worker/native host 因 alarm 持续存活（解释 51988/92248 长寿）。
3. **静默放弃分支 = 半死态的代码路径**：连接函数开头做 auth 前提检查——扩展持有**自己独立的 OAuth token**（chrome.storage：ACCESS_TOKEN / REFRESH_TOKEN / ACCOUNT_UUID / LAST_AUTH_FAILURE_REASON，与浏览器 cookie 登录态是**两套体系**）；token 失效或 token↔accountUuid 不一致 → `return false`，**无任何 UI 提示**。⇒「面板显示已登录（cookie 态）+ worker 活着 + 永远 0 browsers（token 态坏）」完整闭环。
4. **侧边栏是触发器的机制解释**：panel 打开走 cookie→token 刷新路径；token 刷新成功后 30 秒内 alarm 自动接通（23:16:40 host spawn 与注册同秒的成因）。若 refresh token 深度失效，panel-open 不够，需**在侧边栏内登出重登**（重写扩展 token 存储）。
5. 连接报文：`{type:"connect", client_type:"chrome-extension", device_id, os_platform, extension_version…}`；device_id 为扩展存储的持久标识（每 profile 一份 ⇒ pairedDeviceId 与今晚注册 id 不同可能是**不同 profile 的扩展实例**——O1 实验时验证）。
6. 取证边界：扩展 storage 落 LevelDB（值层 snappy 压缩），文件级 strings 读不出 lastAuthFailureReason 值；skill 里不含读 LevelDB 步骤。

## 3. Flywheel 接线现状（issue 问题 #2 收口：接线层无问题）

| 会话类型 | chrome MCP 来源 | 现状 |
|---|---|---|
| Runner | FLY-812 默认开；`no-chrome` **issue label** 才关（`runner-mcp-profile.ts` `disableChrome`→`--no-chrome`）；FLY-751 slim profile 只裁其它 MCP | ✅ 默认带 |
| Lead | `claude-lead.sh` manifest `chromeEnabled` | ✅ 可带 |
| 交互式 | `claudeInChromeDefaultEnabled=true`（本机全局） | ✅ 默认带 |

各会话工具都能返回 `[]`（injection 活着）⇒ 无需在启动脚本加 `--chrome`。

## 4. 恢复路径矩阵（自动化优先排序；证明状态标注诚实）

| # | 动作 | founder? | 证明状态 | 说明 |
|---|---|---|---|---|
| R0 | 打开一个普通 tab 触发 content-script 唤醒 worker：`open -a "Google Chrome" <url>` | ❌ 全自动 | ◐ 机制推导不修 token；00:41 观察经 v5 修正为**不可归因**（旧会话查错频道） | 机制 v4 下可解释：唤醒 worker 不等于修 token；进负知识（机制级） |
| R1 | 脚本化 /chrome → Reconnect：tmux 起一次性交互式 claude 会话，capture-pane 校验后走菜单 | ❌ 全自动（脚本） | ◐ 机制推导不触 token；00:4x 观察经 v5 修正为**不可归因**；断连态下是否有辅助价值 = E2（SKIPPED/UNKNOWN） | 机制 v4 下它修的是机器级 native host 配置，不触 token |
| R2 | 程序化重启 Chrome：`osascript quit` + `open -a`（标签会恢复，issue 约束允许） | ❌ 全自动 | ⚠ 00:33「T+8min 无注册」经 v5 修正为**假阴性**（实际当秒注册在新账号频道）；token 健康+账号一致前提下 R2 可当秒重建注册，对 token 类故障单独仍无效（机制推导） | 修正：23:16 成功的真触发应是**扩展 UI 手势**（panel open，与注册同秒），非启动本身 ⇒ R2 只作"清坏 worker 态"前置，须跟 R5 |
| R5 | 打开扩展侧边栏一次（点工具栏 Claude 图标，签入 claude.ai 的 profile 内） | ✅ 一次（或找到程序化等价物） | 🧪 验证中（机制 v4：panel→token 刷新→30s alarm 自动接通；23:16:40 同秒证据） | token 浅度过期时的轻档修复 |
| R6 | 侧边栏内登出 claude.ai → 重新登录（重写扩展自有 token 存储） | ✅ 一次 | ◐ 机制推导（源码级：连接前提 = 扩展 token 健康） | refresh token 深度失效时的治本步；完成后 ≤60 秒 alarm 自动接通 |
| R3 | 扩展 OFF→ON（chrome://extensions）+ 开一次侧边栏 | ✅ 一次 | ◐ 机制推导 toggle 不修 token；00:21 后的「bridge 始终未连」观察经 v5 修正为**不可归因**（只证明 shopping 频道空，northwestern 频道无观察者） | 机制 v4 解释：toggle 重启 worker 但**不修 token**，30s alarm 每次仍在 auth 前提处静默弃连 ⇒ **从修复序移除**，负知识进 skill（机制级） |
| R4 | 账号对齐：CLI 重新 /login 到扩展同账号（或反向） | ✅ 一次 | ✅ 机制实证（账号作用域） | 仅 L2 检测阳性时走 |

**修复算法的唯一真相 = plan.md §2.1（分支结构：先 L2 判定——env 路径修 env/换会话、Keychain 路径 R4 /login——重新 list 仍 0 再进 L1 ladder：R5 → R6 → R2+R5 → 升级；R4 是 L2 分支、不是 ladder 的一步）**，每步后统一验证：`list_connected_browsers ≥ 1` → `tabs_context` → `navigate` 真机往返。本表为历史探索记录；与 §2.1 冲突处以 §2.1 为准（**注意：本表 R0/R1/R2/R3 行的「实测无效」证明状态，经 implement 阶段修正——00:21 起观察会话持旧账号 token 查错频道，判定为假阴性/不可归因；「不修 token」结论降级为机制推导；修正定稿见 plan §2.1 修正注记**）。E2/E3/O1 回填见 §10。

## 10. Implement 阶段实验回填（M2，2026-07-10 01:19–05:50）

- **E2 脚本化 /chrome Reconnect（断连态归因）**：**SKIPPED（结果状态 = UNKNOWN）**（原因：修复已闭环，无自然同型故障可归因；协议禁止为凑实验破坏已修复的 founder profile；隔离 disposable profile 需 founder 在其中安装扩展并登录 claude.ai，成本超出收益）。Reconnect 的定位据此调整：「不修扩展 token」保留为**机制推导**（源码级：它重写的是机器级 native host 配置）；00:4x 的「实测无效」观察经 v5 修正为不可归因，不再作实证引用。
- **E3 存活窗测量**：**NOT_OBSERVED_WITHIN=4h24m**（观察窗 01:26–05:50，期间零浏览器操作，list 轮询 01:32 / 01:41 / 05:50 均 =1，connectedAt 始终 =00:33:45 即同一条连接未断）。与「30s alarm 持续唤醒」模型一致：**未观察到 idle 断连** ⇒ skill preflight 段不写 idle 时长阈值，只保「每次 founder-path QA 开跑前 preflight」。
- **O1 deviceId 稳定性**：**UNKNOWN（样本同源未确认）**。观察到三个不同 deviceId：pairedDeviceId fd627eee（历史配对）、7d4ee494（07-09 23:16 注册）、248223e5（07-10 00:33 注册）——无法确认三者来自同一 profile，不下轮换结论。**已确认的次要事实**：pairedDeviceId(fd627eee) ≠ 当前注册 id(248223e5) 时单浏览器操作完全正常 ⇒ L3「配对记录陈旧无害（单浏览器）」再次实证；skill 措辞只写「pairedDeviceId 是路由偏好、单浏览器陈旧无害」，**不写 deviceId 轮换结论**（样本同源未确认）。
- **附加发现（进 skill §7 陷阱清单）**：`pgrep -f chrome-native-host` 裸模式会把 prompt 文本含该词的 agent 会话进程也算进去（本 issue 的 runner 自身就中招）——必须用锚定模式 `pgrep -f -- '--chrome-native-host$'`（实测：裸模式 2+ 命中，锚定 = 恰 1）。

## 5. 防复发（QA 期间保活）

机制（v4 修正版）：扩展自带 30s alarm 持续重试并借此给 worker 续命——**本次事故的最佳解释是 auth 前提失败而非缺流量（L1 假说级，未被现场证实——见 §9 v5 注）**；「idle 必死」是待 E3 实测的假说，不是已证结论。因此：

- **QA preflight**（进 skill）：founder-path QA 开跑前先跑验证三连（list/tabs_context/navigate），不过就走 plan §2.1 修复算法——把「测试中途才发现断连」变成「开跑前 30 秒发现」。
- **QA 期间**：中途复测策略按 E3 结果合同分支（OBSERVED=<duration> 才写时长阈值；否则只保「每次开跑前 preflight」，不写伪精确阈值）。
- **常驻 keepalive**：**假说与测量项**——至多缓解 idle 类断连，**不能修 token**（L1 假说下的主嫌路径）；成本/复杂度超出本 issue，冻结解除后再立单（plan §4）。

## 6. 账号错配（L2）检测配方（skill 检查命令，全部只读）

1. `python3 -c "...oauthAccount..."` 读 `~/.claude.json` → CLI 侧账号 email
2. `security find-generic-password -s "Claude Code-credentials"`（**不带 -w**，只看 mdat）→ 凭据最近被动过 = 怀疑切换窗
3. 扩展侧账号：修好后由会话 navigate claude.ai 读页面身份/Organization ID（实锤）；founder 目检侧边栏登录名仅**弱证据**（显示名可能滞后于活跃登录，v5 实证）
4. 判定：两侧 email 不一致 → R4；一致 → 继续 L1 修复序
5. 多账号历史提示：`ls ~/.claude.json.backup*` + 逐个读 oauthAccount（本机实证换过 northwestern → xrliannie@gmail → shopping）

注意：`CLAUDE_CODE_OAUTH_TOKEN` env 会覆盖 keychain（二进制有专门报错分支），检测时 `env | grep -c CLAUDE_CODE_OAUTH_TOKEN` 必查。macOS 上 **ps -E 读不到其它进程 env**（本轮实证），跨会话排查要靠各会话自查上报，不能中心化扫。

## 7. skill 落点决策

| 选项 | 优点 | 缺点 |
|---|---|---|
| **flywheel-skills repo `skills/generic/chrome-repair/`**（推荐） | 全机分发（skills-sync launchd 日更 + 热加载）、CI 五道门、与 notion(FLY-510)/video-watch 同体系、跨项目可用 | 生效要过分发流程（见 plan §3 C5） |
| ~/.claude/skills 本机直放 | 看似立即生效 | **违反分发合同**（canonical = ~/.agents/skills + 逐 skill symlink，手工 cp 会造真目录绕过 lockfile/fanout）；无管理/无 CI/不跨机 |

**结论：canonical 放 flywheel-skills（generic 层，整机半径）；预合并验证用隔离加载、merge 后走 canonical skills-sync（plan §3 C5 为准），禁止手工 cp。** 本仓只留设计文档 + 里程碑（同 FLY-510 两仓模式）。

## 8. 边界与风险

- 不动生产 Bridge/Lead 进程；Chrome 可重启（R2 作为 L1 ladder 辅助步已获授权并于 00:33 实测过）。
- founder 动作全部攒批（plan §5 维护窗：R5 → 等待 → R6 → 等待 → 必要时 R2 且重启后再接一次 R5 → 仍无效才重装，一次预告逐步确认）。
- headless runner 无法自跑 /chrome TUI —— skill 执行者矩阵：R2/诊断脚本任意会话可跑；E2 需辅助 tmux pane；**R5/R6/R4/重装 = founder**。
- 高 load 是复发温床（load 14-17 / 49 会话）：skill 无法治本，preflight + §2.1 修复算法是「与狼共舞」策略；机器减负是独立课题。

## 9. 结论（→ plan.md 输入）

> **v5 修正（implement 阶段，2026-07-10）**：现场闭环已完成——但闭环方式出乎设计预期：23:40 机器凭据切号（shopping→northwestern）+ profile 活跃 claude.ai 登录本就是 northwestern（07-09 12:42 PM 起）+ 扩展 token 在 00:21–00:33 间某点变为 northwestern（机制上最可能由 00:21 的 panel-open 刷新触发，但 token 存储在 LevelDB 不可观测，**动作归因 = UNKNOWN**）→ 00:33 R2 重启后扩展**当秒**（00:33:45）注册在 northwestern 频道（与 R2 的同秒时间相关性是唯一可判的动作关联）。00:21 之后所有来自旧 token 会话的「仍 0」观察 = 查 shopping 频道的假阴性。**L1 的定位保持「最佳解释假说」不变（不升级、也不推翻）**：23:39–00:21 窗口存在一段干净观察——「worker 活着（native host 存活）而 shopping 频道无注册」，且该窗口观察会话查询的正是事发账号（shopping）频道；但 worker B 实际持有的 token 及具体失败路径（token/auth vs 网络 vs 其它连接失败）**不可观测、未作区分**——「扩展 token 失效」是源码级机制里能产生该症状的路径中最佳解释，不是已证事实。新增铁律：**验收会话必须与扩展同账号，修复后验证一律用新会话**。定稿见 plan §2.1 修正注记。

1. 根因模型三层：L1 扩展自有 token 失效 → 30s alarm 每次静默弃连（**最佳解释假说**——静默弃连分支与 token 前提是源码级事实（机制实证），但作为本次事故的实际状态未被现场证实：worker B 的 token 与具体失败路径不可观测，见 §9 v5 注）；L2 账号错配（结构陷阱，Keychain 与 env override 两路径分开处置）；L3 配对记录陈旧（次要）。
2. 修复 = 分层诊断 + **plan.md §2.1 分支算法**（L2 分支：env 修复/R4 对齐 → 重新 list；仍 0 进 L1 ladder：R5→R6→R2+R5→升级）+ 三连验证；负知识证明级别经 v5 修正：R2 单独的 00:33「实证」= 假阴性观察；R3/R0/R1 单独的当晚观察 = 不可归因，其「不修 token」结论降级为机制推导（源码级，仍成立）。
3. skill = flywheel-skills/generic/chrome-repair，含：诊断树（§6 + exploration §6）、修复序（逐字引用 plan §2.1）、preflight（§5）、执行者矩阵（§8）、负知识与证据卫生。
4. implement 阶段实验项（可归因协议，允许 SKIPPED）：E2（断连态下脚本化 Reconnect 归因）、E3（存活窗测量）、O1（deviceId 稳定性）；结论回填本文件。
