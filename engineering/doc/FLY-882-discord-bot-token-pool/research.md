# FLY-882 Discord bot token 池 — 调研/Research

Issue: FLY-882
日期: 2026-07-05
基于: exploration.md

## 1. 本地状态存放的既有惯例

仓库里所有"机器级、不进 git 的运行时状态"都放在 `~/.flywheel/`：

| 文件 | 内容 | 权限现状 |
|------|------|---------|
| `~/.flywheel/.env` | 所有 Lead 的真实 bot token（`{NAME}_BOT_TOKEN=`） | `644`（历史遗留，非本 issue 修复范围） |
| `~/.flywheel/projects.json` | `ProjectEntry[]`，每个 Lead 的 `agentId/chatChannel/match/botTokenEnv/canSpawnRunners/model` | — |
| `$HOME/.claude/channels/discord-<lead-id>/{.env,access.json,approved/}` | 该 Lead 的 Discord 运行时状态 | `.env`/`access.json` 应为 `600`（`/setup-discord-lead` 文档写明，非强制校验） |

池子 `~/.flywheel/discord-bot-pool/` 完全符合"机器级状态、不进 git"这个既有位置惯例，跟 `projects.json`/`.env` 同级。**新建的池目录/文件从第一天就按文档要求的权限来，不参照 `.env` 现有 644 的历史包袱。**

## 2. Bash 脚本 + hermetic 测试的既有范式

`scripts/provision-fleet-host.sh` + `scripts/__tests__/provision-fleet-host.test.sh`、`scripts/lib/fleet-sanitize.sh` 是最贴近的先例，值得照抄的模式：

- **纯函数拆到 `scripts/lib/*.sh`**，用 `[ -n "${XXX_SOURCED:-}" ] && return 0` 做 source 幂等 guard，脚本本体和测试都 `source` 这个 lib。
- **测试用 stub PATH**：`STUB_BIN="$SANDBOX/stubbin"`，把 `curl`/`git`/`launchctl` 等外部二进制替换成"记录调用到 log 文件 + 返回预设输出"的 stub，测试环境完全 hermetic（不打真实网络请求）。`discord-bot-pool.test.sh` 应该照抄这个模式：stub `curl` 返回预设的 Discord API JSON（`{"id":"...","username":"..."}` 表示验活成功；4xx body 表示 token 失效)。
- **`--apply` / dry-run 默认**：`provision-fleet-host.sh` 默认 dry-run，显式 `--apply` 才动真格。池子脚本的"读/验活"类子命令（`list`/`verify`）天然只读，无需这个开关；但 `add-slot`/`claim`/`rename` 这类会写盘或打 Discord 写 API 的子命令，可以不需要这个开关（这些操作本来就是显式、单次调用，不是"扫一遍全部"那种批量风险动作）。
- **`scan_for_secrets`（`scripts/lib/fleet-sanitize.sh`）**：现成的"递归扫路径找疑似密钥"函数，三层探测（vendor token 特征、`key=value` 键名探测、高熵裸串）。可以直接复用它作为**测试里的一个断言**：对 repo 内任何会被 commit 的产物（`doc/reference/discord-bot-pool-claim-guide.md`、脚本本身、测试 fixture）跑 `scan_for_secrets`，确保没有真实 token 混进去。**不需要新写一遍扫描逻辑**，`source` 这个 lib 即可。

## 3. Discord API 细节（供 rename / verify / invite-url 子命令用）

- **验活（只读）**：`GET https://discord.com/api/v10/users/@me`，header `Authorization: Bot <token>`。200 = token 有效，返回 `{id, username, ...}`；401 = token 失效/被 reset。`/setup-discord-lead` 现有 avatar 设置片段已经用了同样的认证头风格（`PATCH /users/@me`），保持一致。
- **改名（bot username）**：`PATCH https://discord.com/api/v10/users/@me`，body `{"username": "<new-name>"}`，同样 `Authorization: Bot <token>`。这改的是**bot 的 Discord 用户名**（在 server 里显示的名字），跟 Developer Portal 里"Application 名字"是两个独立字段——Application 名字要改需要 OAuth2 Bearer token（走完整登录态），不是 Bot token 能改的。**结论：池子的 rename 子命令只改 bot username（够用，这是实际显示给人看的名字），Application 名字留作 Portal 里的手动可选步骤，不做自动化**（本来 Application 名字对最终使用者也不太重要，只在 Portal 后台列表和 OAuth 授权页标题里看得到）。
- **邀请链接权限位**：沿用 `/setup-discord-lead` 已经算好的非-Administrator 组合位掩码 `277025459264`（VIEW_CHANNEL + SEND_MESSAGES + SEND_IN_THREADS + READ_HISTORY + ADD_REACTIONS + USE_SLASH）。guild id 硬编码为现有 `1485787271192907816`（"claude's server"）。`invite-url` 子命令直接拼这个常量 URL 模板，不需要重新计算位运算（除非未来某个认领者需要不同权限集，可以留一个 `--permissions` 覆盖参数，默认用这个常量）。
- **Application 创建本身没有 API**：Discord 官方没有开放"以程序化方式创建全新 Application/Bot"的 REST 端点——这一步天生只能通过已登录的 Developer Portal 网页完成（无论是 Annie 手点还是 Claude-in-Chrome 代她点）。这是为什么池子的"建 6 个空白 bot"这一步无法写成脚本、必须是 Implement 阶段的一次 Chrome 操作 session。

## 4. Token 落盘的安全手法（比现有 setup-discord-lead 更紧的一版）

现状：`/setup-discord-lead` Step 1 里，agent 是"读 Portal 页面拿到 token 文本"（Claude-in-Chrome 的 `read_page`/`get_page_text` 类工具），token 因此会流经 agent 自己的对话上下文/transcript，再由 agent 敲命令写进 `.env`。这是现有 13 个 Lead token 一直以来的实际路径，不算全新风险，但也不是最优。

**FLY-882 提议的改进**：Discord 的"Reset Token"弹窗本身自带一个 **Copy** 按钮（把 token 复制到系统剪贴板）。流程改成：

1. Claude-in-Chrome 点击 Reset Token 弹窗里的 **Copy** 按钮（`computer` 工具点击，不读取按钮旁边显示的文本）。
2. 本地 Bash 直接 `pbpaste > ~/.flywheel/discord-bot-pool/<slot>/token && chmod 600 ...`——token 从系统剪贴板直接落盘，**全程不经过我自己的对话上下文**。
3. 立刻清空剪贴板（`printf '' | pbcopy` 或等价），避免留在剪贴板历史/剪贴板管理器里。

这比"读 DOM 文本"更干净，因为 token 字面量不会出现在任何 transcript / 日志里。**代价**：依赖 Copy 按钮真实存在且点击可靠触发系统剪贴板写入——如果 Chrome 自动化环境下 `computer` 点击 Copy 按钮不可靠（例如按钮是纯 JS 无障碍属性不明显、或者剪贴板权限在无头/远程场景受限），退回到读 DOM 文本这条现有路径作为 fallback，不阻塞整体流程。两条路径都要在 claim-guide 文档里写清楚，Implement 阶段视实际 Chrome 行为选择。

## 5. pool.json schema 草案

```json
{
  "slots": [
    {
      "slot": "flywheel-pool-01",
      "app_id": "1234567890123456",
      "bot_user_id": "1234567890123457",
      "display_name": "flywheel-pool-01",
      "status": "unclaimed",
      "created_at": "2026-07-05T13:00:00Z",
      "claimed_by": null,
      "claimed_at": null,
      "invited_at": null
    }
  ]
}
```

- `status` ∈ `unclaimed | claimed-by-<agentId>`（跟 issue 原文的两态一致；`claimed_by` 字段冗余存一份方便脚本查询，不解析 status 字符串）。
- `invited_at`：独立于 `status` 的字段，为 null 表示"已认领但还没真邀进 server"——覆盖 Anna（等 879 设计）和 Honey Lemon（等 #103 cutover）这两个"认领了但暂不上线"的场景，不需要为此发明第三个 status 值。
- token 本体不进这个文件，只在 `<slot>/token`。

## 6. 风险 / 未知项（写进 plan 的风险章节）

- **Discord 账号级 App 数量上限**：不确定 Annie 当前 Developer 账号一次性建 6 个新 Application 会不会撞到 Discord 的账号级限流/上限（历史上 Discord 对"未验证"应用数量有软上限，具体阈值不公开、可能已变化）。这个只能在 Implement 阶段真跑的时候才知道；如果撞限，fallback 是分批建（比如先 3 个）或换 Annie 的另一个邮箱账号（类比现有 codex/gog 多账号模式）。不阻塞设计，只是执行期风险。
- **`.env` 644 历史遗留**：不在本 issue 修复范围（scope discipline），但新池子严格按 700/600 来，不复制这个历史错误。
