# FLY-2897 Claude 扣费日读收据 — 调研
Issue: FLY-2897 (https://linear.app/geoforge3d/issue/FLY-2897/额度页claude-扣费日-定时读各号-gmail-里-anthropic-的-stripe-收据-额度页显示下次扣费日取消邮件则显示已取消)
日期: 2026-09-25
基于: exploration.md

实测时间 2026-09-25 约 16:20–16:45 PDT（founder 16:17–16:21 PDT 重新授权 gog 之后）。
全部只读：只调 `gog gmail messages search`，没有任何修改类调用。
本文只记字段（日期、金额、周期、发件人与主题的形状），不含正文、收据号、卡号、链接。

## 1. gog（gogcli v0.10.0，commit a92bd63）

### 1.1 授权现状

`gog auth list --check --json`（16:40 PDT）：

| 邮箱 | 号 | valid | 授权时间 (UTC) |
|---|---|---|---|
| xrliannie@gmail.com | personal | true | 2026-09-25 23:17 |
| xrliannie.b@gmail.com | business | true | 2026-09-25 23:20 |
| xrliannie.shopping@gmail.com | shopping | true | 2026-09-25 23:20 |
| xiaorongli2011@u.northwestern.edu | school | true | 2026-09-25 23:21 |
| xrliannie.1@gmail.com | personal1 | 没有这个号的授权 | — |

授权的 scope 是 `gmail.modify` 等全量 scope（不是只读）。Lead 告知 founder 还在决定授权范围，可能改成 `--readonly`。
本单代码只调用 `messages search`，两种 scope 都能用；**代码侧只读**（不调用任何 modify / send / label 命令）。

### 1.2 命令与输出

```
gog --account=<email> --no-input --json gmail messages search '<query>' --max N [--include-body] --timezone UTC
```

- 输出（源码 `internal/cmd/gmail_messages.go` `messageItem`）：
  `{"messages":[{"id","threadId","date":"YYYY-MM-DD HH:MM","from","subject","labels":[…],"body"?}],"nextPageToken"}`
- `date` 是邮件 `Date` 头换算到 `--timezone` 的分钟精度字符串；用 `--timezone UTC` 就能无歧义还原成 ISO。
- `--include-body`：`body` 是解码后的 `text/plain`（没有才退回 `text/html`）。只在我们进程内存里，**不落盘**。
- 结果按时间倒序（Gmail 默认），空结果是 `{"messages":[]}`，退出码 0。

### 1.3 失败的区分（源码 `internal/cmd/exit_codes.go` + 实测）

| 情况 | 退出码 | stderr | 本单归类 |
|---|---|---|---|
| 这个邮箱在 gog 里没有授权（实测 personal1 / 随便一个邮箱）| 4 | `No auth for gmail <email>. …gog auth add…` | `auth_missing` 未授权 |
| refresh token 失效（FLY-2894 实测 4 号都是）| 非 4（token 刷新错误不是 googleapi.Error，走通用 1）| 含 `invalid_grant` | `auth_invalid` 授权失效 |
| Gmail API 401 | 4 | — | `auth_invalid` |
| Gmail API 403（scope 不够）| 6 | — | `read_failed:permission_denied` |
| 限流 | 7 | — | `read_failed:rate_limited` |
| 客户端凭据缺失 | 10 | — | `read_failed:gog_config` |
| 找不到 gog 可执行文件 | spawn ENOENT | — | `read_failed:gog_missing` |
| 超时（我们 kill）| — | — | `read_failed:timeout` |
| stdout 不是期望的 JSON | 0 | — | `read_failed:malformed` |

判定顺序：先看 stderr 是否含 `invalid_grant`，再看退出码。stderr 含邮箱地址，**只用于分类，不进日志**。

### 1.4 可执行文件位置与运行环境

- 本机 `/usr/local/bin/gog`。Bridge 的 LaunchAgent PATH 是 `/opt/homebrew/bin:/usr/local/bin:/usr/bin:…`。
- token 存在 macOS keychain（`keyring_backend: keychain`），Bridge 作为用户 LaunchAgent 运行在同一登录会话里，可访问。
- 仓库里已有按候选路径找 CLI 的先例（`bin/restart-request.ts` 找 `gh`：`/opt/homebrew/bin/gh`、`/usr/local/bin/gh`）。

## 2. 邮件形状（实测 4 个付费号）

### 2.1 发件人与主题

| 种类 | 发件人（From 地址）| 主题 |
|---|---|---|
| 收据 | `invoice+statements@mail.anthropic.com`（显示名 `Anthropic, PBC`）| `Your receipt from Anthropic, PBC #9999-9999-9999` |
| 取消 | `no-reply-<随机>@mail.anthropic.com`（显示名 `Anthropic`）| `Your Claude Max subscription was canceled` |
| 确认 | 同上 | `Your Max subscription is confirmed` |
| 开通 | 同上 | `Welcome to the Max plan` |
| 重订 | 同上 | `Welcome back to Claude Max` |

检索式（Gmail 语法，`{}` 为 OR）：
- 收据：`from:invoice+statements@mail.anthropic.com subject:"Your receipt from Anthropic" newer_than:400d`
- 事件：`from:mail.anthropic.com {subject:"subscription was canceled" subject:"subscription is confirmed" subject:"Welcome to the" subject:"Welcome back to Claude"} newer_than:400d`（只要元数据，不要正文）

Gmail 的 `from:` / `subject:` 是模糊匹配，所以程序拿到结果后还要**再按精确发件人地址 + 主题正则过滤**一遍，对不上的直接丢弃。

### 2.2 收据正文（纯文本，约 900–1000 字符，5 个非空长行）

关键片段（数字按实测保留，收据号与链接已去掉）：

```
Receipt from Anthropic, PBC $100.01 Paid September 16, 2026 (invoice illustration [<url> Download invoice (<url> Download receipt (<url> …
Receipt #<num> Sep 16–Oct 16, 2026 Max plan - 20x Qty 1 $200.00 Unused time on Max plan - 5x after 17 Sep 2026 Qty 1 -$99.99 Total $100.01 Amount paid $100.01 …
```

| 字段 | 写法 | 注意 |
|---|---|---|
| 付款日 | `Paid <Month> <D>, <YYYY>`（英文全月名）| |
| 本期起止 | `<Mon> <D>–<Mon> <D>, <YYYY>`（en dash，无空格）| 同一行里还有 `after 17 Sep 2026`（日-月-年），不能被误认成周期 |
| 金额 | `Amount paid $100.01` | 同段还有单价 `$200.00`、抵扣 `-$99.99`，只认 `Amount paid` |

4 个号近 4 封收据全部是纯文本，`Paid` / 周期 / `Amount paid` 三个字段 **16/16 都能认出**。
跨年周期（如 `Dec 20, 2026–Jan 20, 2027`）实测数据里没有，按 FLY-2894 的推断格式兼容，用构造数据测。

### 2.3 逐号结果（只列字段）

| 号 | 最新收据 (UTC) | 本期起止 | 本期已付（同周期收据求和）| 最新收据之后的事件 | 推出的下次扣费日 |
|---|---|---|---|---|---|
| business | 09-17 00:05 + 00:02（两封）| Sep 16–Oct 16, 2026 | $100.00 + $100.01 = $200.01 | 无（09-08 取消在收据之前，09-16 确认）| **10/16** |
| personal | 09-05 00:06 | Sep 4–Oct 4, 2026 | $200.00 | 无 | **10/04**（= claude.ai `next_charge_date`，FLY-2894 已对照）|
| shopping | 09-20 21:56 | Sep 20–Oct 20, 2026 | $200.00 | 无 | **10/20** |
| school | 09-17 19:39 | Sep 17–Oct 17, 2026 | $200.00 | 400 天内无取消 / 确认邮件 | **10/17**（FLY-2894 未测到，本次补上）|
| personal1 | — | — | — | — | 免费号（明细 `tier.subscriptionType = free`），不读邮件 |

与 FLY-2894 实测一致（business 10/16、personal 10/04、shopping 10/20）。

### 2.4 事件序列里值得测的形状（取自真实时间线）

| 形状 | 真实例子 | 期望 |
|---|---|---|
| 取消后在本期内重订，周期不变 | personal 07-31 取消 → 08-03 Welcome back → 08-04 收据 | ok |
| 取消后本期结束才重新开通，锚点换了 | business 07-21 取消 → 08-14 确认 + 收据 | ok（新锚点）|
| 同一天两封收据（5x 首付 + 升级补差）| business 09-16、shopping 08-20 | 同周期金额求和 |
| 确认邮件与收据同分钟 | business 09-16 17:02 | 不影响 |
| 最新收据之后有取消、之后无确认 | 当前没有真实例子 | canceled（构造数据）|

## 3. 放在哪里、怎么定时

- Claude 明细（卡、套餐）由 Bridge 进程读，存 `~/.flywheel/claude-quota/account-details.json`。收据也放在 Bridge，存同目录新文件，页面路由按需读取。
- FLY-2869 的 `createCodexReadingScheduler` 是「搭 GatePoller tick、到期才跑」的模式，不新开 timer。每天一次照这个做。
- FLY-2830 的 `createSwitchRefreshTrigger` 在切号后跑两条腿（quota-monitor 扫描、Bridge 重读），加第三条独立的腿「重读收据」即可，失败只写日志。
- 页面按需刷新（`?refresh=1` / `POST /api/codex-accounts/refresh`）走 `createAccountQuotaRefresh`，已有「失败不影响整轮」的 Vercel 腿，收据照它加一条。

## 4. 页面现状（FLY-2830 分支）

- `renderNextCharge`：`<span class="next-charge">` 单行 + 切号标记。
- 切号标记：`CLAUDE_CELL_SOURCE.nextCharge = "detail"`，即拿明细读取时间和切号时间比。
- 「读于」：`<span class="reading-time">`，`formatAccountQuotaPageClock`（当天只显示 HH:MM，跨天带 MM/DD）。
- 日历日显示：`formatAccountQuotaPageCalendarDate("2026-10-16")` → `10/16 周五`。
