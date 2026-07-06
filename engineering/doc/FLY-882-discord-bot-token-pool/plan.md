# FLY-882 Discord bot token 池 — 实施计划/Plan

Issue: FLY-882
日期: 2026-07-05
基于: exploration.md, research.md

## 流程说明（本 issue 特例）

Tadashi（flywheel-eng-lead）在 brainstorm gate 确认理解全对后，明确下达**折叠单 session 指令**：因 Annie 现在在线、真操作 Discord Developer Portal 的窗口敏感，不按常规三段式停在 design review，本 session（design runner）直接把 Design + Implement 一次做完（建池 → 认领 Honey Lemon/Anna → 验活 → 报告），跳过阻塞式 codex-design-review 这一步。这份 plan.md 仍然按惯例写全，作为设计记录；后面对新写的 `discord-bot-pool.sh`（涉及真实 token 落盘的安全敏感代码）会做一次非阻塞的 Codex 快速检查，但不走完整多轮 design-review 循环。

## 目标

1. 建一个本地 token 池（6 个空白 Discord application + bot），让"给一个新 agent 配 Discord 身份"这件事从"现建 App"变成"从池里领一个"。
2. 交付可复用、可测试的管理脚本 + 一页认领手册。
3. 今天顺手认领 2 个槽位给 Honey Lemon（FLY-880）、Anna（FLY-879）——仅到"预留身份"这一步，不做完整 cutover。

## 交付物

### A. 本地状态（不进 git，机器级）

```
~/.flywheel/discord-bot-pool/
├── pool.json                 # 0600，登记表
├── flywheel-pool-01/
│   └── token                 # 0600，裸 token 文本
├── flywheel-pool-02/
│   └── token
...
└── flywheel-pool-06/
    └── token
```

目录本身 `chmod 700`；每个 slot 子目录也 `700`；`token` 文件与 `pool.json` 都 `600`。

`pool.json` schema（详见 research.md §5）：

```json
{
  "slots": [
    {
      "slot": "flywheel-pool-01",
      "app_id": "...",
      "bot_user_id": "...",
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

### B. `scripts/discord-bot-pool.sh` + `scripts/lib/discord-bot-pool-lib.sh`

仿 `provision-fleet-host.sh` / `fleet-sanitize.sh` 的拆分方式：纯函数（pool.json 读写、权限设置、token 掩码显示、Discord API 调用包装）放 lib，可被脚本和测试直接 `source`。

子命令：

| 子命令 | 作用 | 网络/写操作 |
|--------|------|------------|
| `init` | 创建 `~/.flywheel/discord-bot-pool/` 目录结构 + 空 `pool.json`（若已存在则跳过，幂等） | 无 |
| `add-slot <slot> <app_id> <bot_user_id>` | Chrome 建完一个空白 app+bot 之后，把它登记进 `pool.json`，status=unclaimed；token 由调用方已经通过 `pbpaste` 落到 `<slot>/token`（脚本负责校验该文件存在且非空、correct chmod） | 本地写 |
| `list` | 打印所有 slot 的 status 表（不打印 token 内容，`token` 列只显示是否存在 + 最后 4 位掩码） | 无 |
| `verify <slot\|--all>` | 对指定 slot（或全部）读 token 文件，打 `GET /users/@me`，报告 200/401 | 只读网络 |
| `rename <slot> <new-username>` | `PATCH /users/@me` 改 bot username | 写网络（仅改用户名，不涉及权限） |
| `invite-url <slot> [--permissions N]` | 用已登记的 `app_id` 拼邀请链接（默认权限位 `277025459264`，非 Administrator） | 无（纯字符串拼接） |
| `claim <slot> <claimed-by>` | 把 `pool.json` 里该 slot 的 `status` 改成 `claimed-by-<claimed-by>`，记 `claimed_at`；`invited_at` 保持 null（邀请进 server 是后续独立步骤，不在这条命令里做） | 本地写 |

**不做的子命令**：不提供"自动建 Discord Application"的命令——如 research.md §3 所述，Discord 没有对应 API，这一步永远是 Chrome/人工操作。

### C. `scripts/__tests__/discord-bot-pool.test.sh`

Hermetic，仿 `provision-fleet-host.test.sh`：

- 用临时 `HOME`/`FLYWHEEL_HOME`，stub `curl`（记录调用到 log 文件，返回预设 JSON：200 `{"id":"1","username":"x"}` 表示验活成功场景 / 401 表示失效场景）。
- 用例覆盖：
  - `init` 幂等（跑两次不出错，不覆盖已有 pool.json）
  - `add-slot` 写入正确的 `pool.json` 条目 + 拒绝重复 slot 名
  - 目录/文件权限断言：`700`/`600` 精确校验（不是"至少不是 777"这种弱断言）
  - `list` 输出里**不包含**任何长度 ≥ 16 的疑似 token 字符串（用 `fleet-sanitize.sh` 的 `_fleet_token_is_secret` 风格做断言，或直接 `source scripts/lib/fleet-sanitize.sh` 复用 `scan_for_secrets` 扫 `list` 的 stdout）
  - `verify` 对 stub curl 返回 200 / 401 两种场景的正确判定 + 正确 exit code
  - `claim` 更新 status + claimed_at，且不动 `invited_at`
  - `invite-url` 拼出的 URL 包含正确的 `client_id`/`permissions`/`guild_id`，且不含 Administrator 位
  - 缺 token 文件 / token 文件权限不对（比如意外是 644）时，`verify`/`add-slot` 显式报错而不是静默继续

### D. `doc/reference/discord-bot-pool-claim-guide.md`（一页认领手册）

内容大纲：

1. 何时用池子 vs 何时现建（池子空了、或需要非标准权限时现建）
2. 认领步骤：
   a. `scripts/discord-bot-pool.sh list` 挑一个 `unclaimed` slot
   b. `scripts/discord-bot-pool.sh rename <slot> <new-bot-username>`
   c. （可选）设置头像——沿用 `setup-discord-lead.md` 里现成的 curl PATCH avatar 片段
   d. `scripts/discord-bot-pool.sh invite-url <slot>` 拿邀请链接，Annie 点一次邀进 server
   e. 跑 `/setup-discord-lead` **从 Step 3 开始**（Step 1/2 已经被池子覆盖：不用现建 App，邀请链接池子已经给你了）——建 `DISCORD_STATE_DIR`/`access.json`/`projects.json`/launch
   f. `scripts/discord-bot-pool.sh claim <slot> <agentId>` 登记 claimed
3. 故障排查：token 验活失败怎么办（多半是 Portal 里被人手动 Reset 过，需要重新 Copy 一次）

### E. 对 `.claude/commands/setup-discord-lead.md` 的最小编辑

在 Step 1 开头加一句提示 + 链接到 claim-guide，指出"先检查池子里有没有空位，有就跳到 claim-guide 走认领流程，不必每次重新建 App"。不改动其余步骤。

## Token 落盘手法（Implement 阶段执行细节，非脚本代码）

按 research.md §4：Chrome 点击 Reset Token 弹窗的 **Copy** 按钮 → `pbpaste > <slot>/token && chmod 600 <slot>/token` → 立刻 `printf '' | pbcopy` 清剪贴板。DOM 读取（`read_page`/`get_page_text`）只作 fallback，且只有确认 Copy 按钮路径不可行时才用，用了也要在报告里如实说明（不能默认走一个比设计目标更弱的路径而不说明）。

## 认领 Honey Lemon / Anna 的具体动作

对两者都只做：`rename` → （可选）头像 → `claim`。**不做**：`invite-url` 生成后不一定要 Annie 真点邀请、也不跑 `/setup-discord-lead` 剩余步骤——因为：

- Honey Lemon：完整 cutover 是已排定的独立后续（task #103），今天只预留身份。
- Anna：issue 原文明确"等 879 设计过了再邀"，879 还没做隔离权限设计，现在邀进 server 属于抢跑。

如果 Annie 在对齐执行方式时表态想让 Honey Lemon 今天就直接上线，需要回来更新这条决策（已在 brainstorm gate 问过，Tadashi 确认了"只到预留"这个范围）。

## 测试计划

- `scripts/__tests__/discord-bot-pool.test.sh` 全绿（新增，hermetic，无真实网络）。
- 全仓 `pnpm lint` + 相关既有测试不回归（本次改动不碰任何 TypeScript 包，风险面很小，但仍跑一遍确认没有意外触碰）。
- 真机验证（Implement 阶段，Annie 在场时进行）：
  1. 池子建完 6 个 slot 后，`list` 显示 6 个 unclaimed。
  2. 对每个新建 slot 跑 `verify`，确认 6/6 返回 200（token 真实有效）。
  3. 认领 Honey Lemon + Anna 两个 slot 后，`list` 显示对应 status=claimed-by-honey-lemon / claimed-by-anna，`invited_at` 仍为 null。
  4. 抽查 `~/.flywheel/discord-bot-pool/` 全目录树权限（`find ... -perm` 或 `stat`），确认 700/600 精确匹配。
  5. `git status` 确认整个 `~/.flywheel/discord-bot-pool/` 目录不在任何 git 工作区内、没有被意外 `git add`。

## 风险 & 未决项

见 research.md §6（Discord 账号级 App 数量上限未知；`.env` 644 历史遗留不修）。另外：Copy 按钮的 Chrome 自动化可靠性，只能在 Implement 阶段真跑时验证，若不可靠会切换 fallback 并如实报告。

## 范围边界重申

不做：Anna/Honey Lemon 的完整 Discord 邀请 + Lead 运行时 cutover；不做通用可配置池大小；不修 `~/.flywheel/.env` 现有 644 权限；不碰 `access.json`/Discord plugin fork 内部逻辑；不新建 Linear issue 处理"顺便发现"的问题。
