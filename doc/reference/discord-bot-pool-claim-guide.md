# Discord Bot Token 池 — 认领手册 (FLY-882)

一页版：从本地池里领一个空白 Discord bot 身份，替代"每次都现建 Discord Application"。

## 什么时候用池子，什么时候现建

- **池子里有 `unclaimed` 槽位** → 用池子，跳过 Developer Portal 建 App 这一步，直接从下面 Step 1 开始。
- **池子空了，或这次需要非标准权限/单独账号** → 走 `/setup-discord-lead` 原本的 Step 1（现建 App），认领手册剩下的步骤照样适用。

查池子状态：

```bash
scripts/discord-bot-pool.sh list
```

## 认领步骤

1. **挑一个空位**：`scripts/discord-bot-pool.sh list`，找一个 `status=unclaimed` 的 slot（如 `flywheel-pool-03`）。

2. **改名（bot username）**：

   ```bash
   scripts/discord-bot-pool.sh rename flywheel-pool-03 "Flynn - Finance Lead"
   ```

   这改的是 bot 的 Discord 用户名（服务器里显示的名字）。Developer Portal 里的 "Application 名字" 是独立字段，需要走完整 OAuth2 登录态才能改，不在这条命令的范围内——留作 Portal 里手动可选的一步（对最终使用者不太重要，跳过也没问题）。

3. **（可选）设头像**：沿用 `/setup-discord-lead` 现成的 avatar 片段（`.claude/commands/setup-discord-lead.md` Step 1.5）——下载 Disney 角色 clip art → PIL 转 1024x1024 透明底 PNG → `curl -X PATCH /users/@me` 上传。头像不是必须的，bot 用默认头像也能正常工作。

4. **生成邀请链接**：

   ```bash
   scripts/discord-bot-pool.sh invite-url flywheel-pool-03
   ```

   默认权限位 `277025459264`（VIEW_CHANNEL + SEND_MESSAGES + SEND_IN_THREADS + READ_HISTORY + ADD_REACTIONS + USE_SLASH，**不含 Administrator**），guild 默认是 "claude's server"（`1485787271192907816`）。需要不同权限/服务器时传 `[permissions] [guild_id]` 覆盖参数。

5. **Annie 点一次邀请**：把上一步的链接给 Annie，她点一次邀进 server。**这一步的授权点击必须是 Annie 本人**（或 Claude-in-Chrome 代她操作、她在场确认）——不能替她点。

6. **走 `/setup-discord-lead` 剩余步骤**（跳过它的 Step 1/2，池子已经把这两步覆盖了；从它的 **Step 3** 开始）：建 `DISCORD_STATE_DIR` + `access.json` + `approved/` → 写 `~/.flywheel/.env` 里的 `{NAME}_BOT_TOKEN` → 更新 `projects.json` → 建 `agent.md` → 起进程验证。

7. **登记认领**：

   ```bash
   scripts/discord-bot-pool.sh claim flywheel-pool-03 finance-lead
   ```

   注意：`claim` 只登记"这个身份归谁了"，**不会**帮你做第 5/6 步（邀进 server、起 Lead 进程）。如果只想先"预留身份、以后再上线"（比如新 agent 还没设计完、暂不邀进 server），可以只做 Step 1/2/7，跳过 4/5/6——`pool.json` 里的 `invited_at` 会一直是 `null`，直到真的邀进 server 那天才需要回来处理。

## 故障排查

| 症状 | 原因 | 处理 |
|------|------|------|
| `verify` 报 `FAIL (http 401)` | token 已在 Portal 里被人手动 Reset 过，本地存的是旧 token | 去 Portal 该 App 的 Bot 页 Reset Token，重新走一次 Copy → `pbpaste` 落盘（见下）,再跑一次 `verify` |
| `verify` 报 `FAIL (no token on file)` | `<pool-dir>/<slot>/token` 不存在或是空文件 | 确认对应 slot 目录下 `token` 文件确实写了内容 |
| `add-slot` 报 slot 已注册 | 池子里已经有这个 slot 名字 | 换一个还没用过的 slot 名，或先确认是不是重复操作 |
| `claim` 报 slot 不是 unclaimed | 这个 slot 已经被别人认领过 | `list` 看一下 `claimed_by` 是谁，换一个 `unclaimed` 的 slot |

## Token 怎么从 Portal 落到本地池（Implement 阶段，建池子时用一次）

Discord 的 "Reset Token" 弹窗自带一个 **Copy** 按钮。推荐流程：

1. Chrome 里点 Reset Token 弹窗的 **Copy** 按钮（不读取按钮旁边显示的文本）。
2. `pbpaste > ~/.flywheel/discord-bot-pool/<slot>/token && chmod 600 ~/.flywheel/discord-bot-pool/<slot>/token`——token 从系统剪贴板直接落盘，不经过任何对话上下文/日志。
3. 立刻清剪贴板：`printf '' | pbcopy`。
4. `scripts/discord-bot-pool.sh add-slot <slot> <app_id> <bot_user_id>` 把这个 slot 登记进 `pool.json`。

如果 Copy 按钮在某次 Chrome 自动化环境下不可靠（点击没有真正写入系统剪贴板），退回到读 Portal 页面文本这条路径，一样能用，只是 token 会经过一次对话上下文——用了这条 fallback 要如实说明，不要默认当作等同于 Copy 路径。

## 参考

- 权限位掩码、guild id 常量、bot username vs Application 名字的区别：见 `engineering/doc/FLY-882-discord-bot-token-pool/research.md`。
- 池子脚本源码 + 测试：`scripts/discord-bot-pool.sh`、`scripts/lib/discord-bot-pool-lib.sh`、`scripts/__tests__/discord-bot-pool.test.sh`。
