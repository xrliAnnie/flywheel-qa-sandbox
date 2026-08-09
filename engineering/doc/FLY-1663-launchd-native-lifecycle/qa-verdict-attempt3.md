# FLY-1663 独立 QA 判决 · 第 3 轮 — FAIL（F3 已修好；新抓到一条会让全舰 Lead 静默失能的阻断项）

Issue: FLY-1663
日期: 2026-08-09
被验代码 head: `9520bccb17cd098dff1c39efe7dd366bc9e0a01b`（= `origin/flywheel-FLY-1663`）
前序: qa-verdict.md（第 1 轮 FAIL 三条）、qa-verdict-attempt3 的上一轮 qa-verdict-attempt2.md（FAIL 一条）

## 判决

**FAIL。** 上一轮的 F3 两个子项都修好了、复验通过，529 房也第一次跑通了完整 deploy。
但正因为跑通了，我第一次能做 plan §15.8 的**能力正向门**——然后它挂了：

> **v2 载体的受限 env 少了一个 `USER`，导致 Claude 认证失败。
> Lead 会正常起来、MCP 全加载、Discord 消息也能收到，然后回一句 `Not logged in · Please run /login`。**

这正是 plan §15.8 写明要防的那件事:「防安全测试全绿、Lead 却失能的静默回归」。
按现在这个 head 迁移，15 个 Lead 会一个一个变成「活着但不会说话」。

---

## F3 已修复 ✅

### F3-a 登录 shell 已从 Lead 启动关键路径上摘掉

conf 里加了 `set -g default-shell /bin/bash`。**前后对照实测**（隔离沙箱 label，3 次冷启动）:

| | 修前（attempt 2） | 修后（本轮） |
|---|---|---|
| 发布延迟 | ~20s（3/3） | **2s / 3s / 3s** |
| pane 的 shell | `zsh`（用户登录 shell） | **`bash`** |
| 启动期是否出现 brew/rc 子进程 | 是（`brew.sh shellenv`） | **否** |

本机 `~/.zshenv:2` 就是 `eval "$(/opt/homebrew/bin/brew shellenv)"`，用户默认 shell 是 `/bin/zsh` ——
这两个条件都没变，变的只是 conf。10/10 全过。

### F3-b 验证预算已调到实测量级以上

`QA_LAUNCHD_LEAD_VERIFY_POLLS_DEFAULT=600`（原 100）。

### F3-c 529 房完整 deploy 第一次成功（用产品默认值，没有任何 override）

`test-deploy.sh 2 --from-branch flywheel-FLY-1663` → **rc=0**，我盯着进程树看的:

```
t=15s  pane: /bin/bash …/flywheel-lead-wrapper-v2.sh --publish-and-start …
t=30s  manifest.pid=22567  ← 发布
       pane: /bin/bash …/packages/teamlead/scripts/lead-body.sh …
         └── claude --agent flywheel-test-2 …
              ├── context7-mcp / playwright-mcp / serena
              ├── discord plugin server.ts
              ├── terminal-mcp / inbox-mcp
              └── gbrain serve
```
落地状态: launchd job pid 22567 **==** manifest.pid，runs=1，slot Bridge `/health` ok，
`.inbox-ready-flywheel-test-2` 租约在。

### 载体无回归 ✅

Stage E **15/15**：拓扑反例矩阵 6/6（含两种多 session 变体）、hook 隔离（额外 pane+session 都活着时
SIGKILL body，`%0` hook 仍收口）、无孤儿、KeepAlive 23–25s、manifest.pid 跨代跟随活 server。

---

## 🔴 F4 新阻断项：v2 受限 env 缺 `USER`，Claude 认证失败 → Lead 静默失能

### 现场（真 Discord，founder 真会话）

我用 Claude-in-Chrome 在隔离 QA 频道 `#product-lead-test` 以 founder 身份发了一句话。
**入站这一段是通的**——Lead pane 里逐字出现:

```
← discord · xrliannie_96634: FLY-1663 QA ping (v2 launchd carrier). 请回一句话确认你在线…
  ⎿  Not logged in · Please run /login
```

也就是说：v2 载体 → 真 Lead → Discord 入站，全链路第一次验通；**但 Lead 答不了，因为它没登录。**
状态栏同屏显示 `Not logged in · Run /login`。

### 定因：受控 A/B + 单变量 bisect（同一台机、同一份 `~/.claude`、同一时刻）

先排除「账号本身没登录」:

```
普通 shell:  claude -p 'reply with exactly: AUTHOK'   →  AUTHOK
```

再用 v2 那个 claude 子进程**实际持有的变量集合**（我从活进程 `ps eww` 抓下来的）复现:

```
Arm A  完整 env                                  →  AUTHOK
Arm B  env -i + v2 allowlist（逐字同构）          →  Not logged in · Please run /login   (rc=1)
```

然后逐个变量 bisect:

| 在 `HOME/PATH/TERM/TMPDIR` 基线上加 | 结果 |
|---|---|
| （基线，什么都不加） | Not logged in |
| **`+ USER`** | **AUTHOK** |
| `+ LOGNAME` | Not logged in |
| `+ SHELL` | Not logged in |
| `+ LANG` | Not logged in |
| `+ USER+LOGNAME+SHELL+LANG` | AUTHOK |

**唯一的自变量是 `USER`。**

### 代码位置

`scripts/flywheel-lead-wrapper-v2.sh` 的 `SERVER_ENV` 白名单是
`HOME / PATH / TERM / FLYWHEEL_DIR / FLYWHEEL_STATE_DIR / FLYWHEEL_PROJECTS_FILE / FLYWHEEL_LEAD_ID /
FLYWHEEL_LEAD_CARRIER` + 可选 `TMPDIR / LANG / LC_ALL / LC_CTYPE / CLAUDE_CONFIG_DIR` + `DISCORD_*`。
`USER` 与 `LOGNAME` **全文件不出现**（`grep` 零命中）。活 Lead 的 claude 子进程 env 里也确实没有 `USER`。

### 影响

迁移后**每一个** Claude Lead 都会:launchd 显示健康 → tmux server 在 → body 在 → claude 在 →
MCP 全加载 → Discord 消息收得到 → **一句都答不出来**。而且 KeepAlive 救不了（进程没死），
watchdog 也不会报（pane 有内容、不是 frozen）。这就是 plan §12.6 说「新形态无先例、Phase 0 硬门不可跳」
要挡的东西。

### 修法

把 `USER`（建议连 `LOGNAME`）加进 `SERVER_ENV` 白名单。
另外 plan §3.3 原本就要求「**先对现有 v1 启动环境做 characterization 再收缩**」——
这次漏掉 `USER` 说明那一步没真做全。建议按 v1 活进程的 env 做一次完整差集，别再逐个试。

---

## 🟡 LOW：每次 v2 启动都打一句假警报

Lead pane 每次启动都会出现:

```
[lead] WARNING: jq not found. Manifest not written — auto-restart will skip this Lead.
```

两句都不成立:`jq` 在 `/usr/bin/jq`、也在 server PATH 里（wrapper 自己就用 jq 发布成功的）；
manifest 也确实写了（wrapper 写的）。根因是 `claude-lead.sh:603` 那个 else 分支——
条件被改成 `[ "$FLYWHEEL_LEAD_BODY_V2" != "1" ] && command -v jq …` 之后，v2 下条件恒假就掉进 else。
不影响功能，但会在迁移窗口误导运维（"auto-restart will skip this Lead" 是很吓人的一句）。

---

## 尚未验证 / 诚实边界

- **Discord 出站回复没验成** —— 被 F4 挡住。入站已验通（上面有逐字证据），出站要等 F4 修完再跑。
- **`--resume` 记忆延续、cmux 同 ref 重连** 两项仍未验（都要一个能说话的 Lead）。
- **529 房 deploy 稳定性样本仍小**：本轮产品默认值下 1 次失败（05:42）+ 1 次成功（05:47，rc=0）。
  比上一轮的 1/5 好很多，但不足以称"稳定"。建议修完 F4 后连跑 3 次确认。
- 我没有对生产 label 做过任何 v1/v2 切换或回滚实跑。

## 生产隔离

载体 QA 只用隔离 label `com.flywheel.qa1663.a` + 沙箱 `/tmp/f1663qa`；529 QA 用 slot 2 的独立 label。
所有 `launchctl` 走 FLY-913 受审计 bypass。Discord 操作只在隔离 QA 频道 `#product-lead-test`，
未碰任何生产频道。`test-teardown.sh 2` 已跑完（slot label 已消失），沙箱 plist 已删，Chrome tab 已关。
**生产 `~/.flywheel/projects.json` 自第 1 轮 02:18 恢复后再未变动**（16 Lead / 8102B / mtime 02:18:35）。

## 建议

1. 加 `USER`（+`LOGNAME`）进 v2 白名单 —— 一行，但它是现在唯一挡着全舰迁移的东西。
2. 按 plan §3.3 的原话，对 v1 活 Lead 的 env 做一次完整 characterization 差集，确认没有第二个 `USER`。
3. 顺手修掉那句假 `jq not found` 警报。
4. 修完后跑一次完整 529 slot：真 Discord **往返**（入站已通，补出站）+ `--resume` 记忆延续 + cmux 同 ref 重连，
   并连跑 3 次 deploy 确认稳定性。
5. 回归脚本都在 `/tmp/f1663qa/`：`verify-f1.sh`、`verify-f2.sh`、`stage-e.sh`、`verify-f3-shell.sh`、
   `verify-auth-env.sh`、`bisect-auth.sh`。
