# FLY-2145 Lead 记忆私有仓 — 探索
Issue: FLY-2145 (https://linear.app/geoforge3d/issue/FLY-2145/2132a1-lead-记忆建私有仓一仓十二夹-全读只写自家-首搬-真密钥扫描)
日期: 2026-09-03
基于: 无(上游为 product/doc/FLY-1984-codex-home-identity/epic-prd.md §A,拆单以 PRD 原文为准)

## 1. 问题定义

12 个 Lead 一年攒下的记忆只存在这台机器的 `~/.claude/agent-memory/` 里,**零副本**
(FLY-2134 第 4 例)。本单只做 PRD §A 里「建仓 + 首搬 + 权限形状 + 真密钥扫描」四件事;
「定时自动进仓、判断到没到看远端」是 A2 的范围,本单只给 A2 留好提交合同,不做定时器。

她定的形状(PRD 原文,不改):
- 一个私有仓,不是十二个;仓内一个 Lead 一个文件夹,就是现在盘上的样子。
- 所有 Lead 都能读全部;每个 Lead 只能写自己那个文件夹。
- 能在另一台机器拉下来接着用。
- 上仓前用真正的密钥扫描工具跑一次,每条结果有人看过处理过。

Issue 补的边界:写权护栏 = push guard / CI 检查,**git 本身不做目录级写权**;
扫描工具与处理口径 founder 还要表态,不当已批(已用非阻塞 ask 送给 Lead,id `2be69119`)。

## 2. 现状审计(2026-09-03 08:30 前后实测,条数每天在长,当数量级看)

### 2.1 盘上的记忆

| Lead 文件夹 | 文件数 | 占地 |
|---|---|---|
| flywheel-eng-lead | 550 | 3.1M |
| flywheel-cos-lead | 162 | 2.7M |
| sub-lead | 124 | 17.9M(含 assets/ 下 6.8M mp4、6.8M jpg、4.0M mp3) |
| flywheel-product-lead | 102 | 3.4M |
| joycon-lead / ops-lead / cos-lead / tidal-echo-content-lead | 38 / 36 / 34 / 35 | <1M 各 |
| reflection-lead / product-lead / rafiki-lead / tidal-echo-cos-lead | 20 / 13 / 13 / 10 | <0.1M 各 |
| **合计 12 夹** | **1137** | **29M** |

- 最外层文件数 = 0(`find -maxdepth 1 -type f`),没有共用文件 ⇒ 两个 Lead 的写落不到同一文件上。
- 文件类型:1110 个 `.md`,其余是 `.bak*`(MEMORY.md 的手工备份)、1 个 `.sh`、1 个 `.tsv`、4 个媒体文件。无符号链接。
- 单文件最大 6.9MB,远低于 GitHub 100MB 硬限;仓总量 29MB,无需 LFS。
- Issue 写的「12 夹 / 1054 文件 / 28MB」是 8-28 的数,今天已 1137 文件,**首搬脚本不能写死清单,要按当刻目录列**。

### 2.2 这些文件夹是谁在写、怎么定位的

- `~/.claude/agents/*.md` 里 16 份 Lead 定义全带 `memory: user` ⇒ Claude Code 原生把该 agent 的记忆目录定到
  `~/.claude/agent-memory/<agent-name>/`。**这个路径是工具定的,不是我们代码定的**(出货代码 `packages/` `apps/` 对 `agent-memory` 零命中)。
  ⇒ 设计约束一:仓的工作树必须仍然是 `~/.claude/agent-memory/` 这个路径,否则要改 Claude Code 的行为。
- Lead 进程环境(实测 `ps eww` 读 flywheel-eng-lead 的 Lead 进程):`FLYWHEEL_LEAD_ID=flywheel-eng-lead`、`FLYWHEEL_LEAD_ROLE=dept`、`FLYWHEEL_LEAD_GENERATION=192` 等。
  ⇒ 写权护栏有一个现成的身份来源。
- ⚠️ runner(我自己)也继承了 `FLYWHEEL_LEAD_ID=flywheel-eng-lead`(但没有 `FLYWHEEL_LEAD_ROLE`)。
  runner 的记忆写在 `~/.claude/projects/<slug>/memory/`,不进这个仓;但若 runner 在仓里 `git commit`,护栏会把它当成它的 Lead。这是已知边界,写进「诚实边界」。

### 2.3 现有的仓与同步

- `~/.claude` 本身是 git 仓,远端 `xrliAnnie/claude-config`(私有),最后一次提交 2026-06-12,本地远端一致。
  `agent-memory/` 被跟踪文件数 **0**,`git check-ignore` 无命中 ⇒ 不是被 ignore,是从未 add。
- chezmoi 每天 02:00 有 launchd 自动同步(`com.chezmoi.auto-sync`),管的是 dotfiles 仓 `xrliAnnie/dotfiles`;
  `chezmoi managed | grep agent-memory` = 0 ⇒ 它不会碰这个目录。
  (PRD 里「本地比远端多 118 次提交」说的是这个 dotfiles 仓,今天是 123;那是 A2 的事。)
- 推送认证:`gh auth status` 是 xrliAnnie,scope 含 `repo`;git 凭据走 `gh auth git-credential`,并有 `url.https://github.com/.insteadOf git@github.com:`
  ⇒ 任何一个 Lead 进程(同一 OS 用户)都能用同一张票推到 xrliAnnie 名下的私有仓。**GitHub 那边分不出 12 个 Lead**,它只看到一个账号。

### 2.4 现有 push guard 的形状(FLY-1718,可直接借)

`~/.flywheel/state/push-guard/hooks/pre-push`:POSIX sh,读 stdin 的 ref 行,拒绝删远端分支与非快进,
`FLYWHEEL_FORCE_PUSH_ACK=<branch>` 单次放行并写 `audit.log`。文件头明写「不是安全边界,`--no-verify` 能绕;runner 合同禁止绕」。
本单的写权护栏沿用同一哲学:**事故护栏 + 审计,不是安全边界**。

### 2.5 密钥扫描试跑(只读,结果在 scratchpad,不进仓)

| 工具 | 版本 | 真实扫描 `~/.claude/agent-memory` | 阳性对照(种 8 种合规假密钥) |
|---|---|---|---|
| gitleaks | 8.30.1(brew) | 扫 20.93MB,**0 条** | 命中 8 条:github-pat / aws-access-token / anthropic-api-key / slack-bot-token / private-key / generic-api-key×3 |
| trufflehog | 3.97.2(brew) | 扫 11.88MB,**0 条**(verified 0 / unverified 0) | 命中 4 个 detector:AWS / Anthropic / Github / Slack |

- 第一次阳性对照我种的是 `AKIA…EXAMPLE` 和长度错误的 `ghp_`,两把工具都 0 命中 —— 那不是工具坏了,是样本在两家的白名单里。
  换合规样本后才命中。**这一步必须写进扫描 runbook:没有阳性对照的「0 条」不算证据。**
- trufflehog 没抓到我种的 OpenAI `sk-proj-`、Discord bot token、假 RSA 块(它的 PrivateKey detector 要能解析的真钥)。
  gitleaks 的 generic-api-key 兜住了其中两条。⇒ 两把并集比任一把强,但都不覆盖 Discord token 格式;
  Discord token 要靠 gitleaks 自定义规则补一条(research 里定正则)。
- PRD 说 282 个文件出现 token/key/secret 字样:字样命中 ≠ 有钥匙,这次真工具扫描证明绝大多数只是在讨论概念。
  但为了让 founder「每条有人看过」这句成立,0 条时也要做**抽样复核**(按 Lead 各抽若干字样命中文件人工看)并记台账。

## 3. 约束与假设

- 不改 Claude Code 的记忆路径;不改 Lead 启动方式;不新增 GitHub 账号。
- 12 个 Lead 共用一张 GitHub 票 ⇒ 服务端做不到「按 Lead 拒写」,只能做「按提交审计」。
- 本单不做定时器、不做「远端有没有」的巡检(A2)。但 A2 的自动提交必须能过本单的护栏,所以护栏合同要现在定好。
- Codex Lead(mufasa / raya / codex-infra-bot)的记忆在 `~/.codex-*/memories`,PRD C1 未勾,不在本单。
- 假设 founder 对扫描工具/口径的裁定与 ask `2be69119` 里的提议一致;若不一致,plan 的 C4 按裁定改,其余不受影响。

## 4. 方案对比

### 4.1 仓放在哪

| 选项 | 做法 | 判断 |
|---|---|---|
| **A1 原地 `git init`(推荐)** | 在 `~/.claude/agent-memory/` 里直接建仓,远端 `xrliAnnie/lead-memory`;`~/.claude/.gitignore` 加一行 `agent-memory/` 免得外层仓把它当嵌套仓 | 零路径变更、Claude Code 照常写;回滚 = 删 `.git` 目录,文件一个不动 |
| A2 clone 到 `~/.flywheel/lead-memory/` + 把 `agent-memory` 换成符号链接 | 仓不嵌在 `~/.claude` 里 | 换链接那一刻要停所有 Lead 写;多一层间接;没有换来实质好处 |
| A3 直接用 `~/.claude`(claude-config)那个仓 | 它已有远端 | 那是 dotfiles 混装仓,权限/CI/扫描都得连带整个 `~/.claude`;chezmoi 也在管它;founder 要的是「记忆一个仓」 |
| A4 十二个仓 | 每 Lead 一仓,GitHub 天然隔离 | founder 明确否决 |

### 4.2 「只写自家」怎么护

| 选项 | 做法 | 判断 |
|---|---|---|
| **B1 本地 hook + 提交 trailer + 服务端 CI 审计(推荐)** | `pre-commit`:暂存区所有路径必须都在一个顶层夹里,且等于 `FLYWHEEL_LEAD_ID`;`prepare-commit-msg` 自动写 `Memory-Owner: <id>`;`pre-push`:逐个提交复核 trailer 与路径;CI(GitHub Actions,push 到 main 触发):同样规则跑一遍,不过就红 + 开 issue | 沿用 FLY-1718 哲学;A2 的自动提交只要「一提交一夹 + trailer」就能过;hook 与 CI 是同一段脚本,一处源 |
| B2 每 Lead 一个 GitHub 账号 + CODEOWNERS + 分支保护 | 服务端真隔离 | 12 个账号要养;CODEOWNERS 只管 PR 评审,不管直推;Lead 就得走 PR 流,把「写记忆」变成「发 PR」 |
| B3 只做 CI 审计 | 简单 | 推上去才发现,错的已经在远端历史里 |
| B4 只靠文档约定 | 零代码 | founder 的验收是「写别家写不进」,约定不算写不进 |

### 4.3 扫描工具与口径

| 选项 | 判断 |
|---|---|
| **C1 gitleaks + trufflehog 并集 + 阳性对照 + 逐条台账 + 首搬后 pre-commit 挂 gitleaks(推荐)** | 两把都本地跑、免账号;并集覆盖比任一把广;pre-commit 拦新增,首搬那次的干净不会过期 |
| C2 只 gitleaks | 少一把交叉验证;trufflehog 的 verified 能力(真去打 API 验钥)是 gitleaks 没有的 |
| C3 ggshield(GitGuardian) | 要注册账号、把内容送到第三方 SaaS;founder 说过内容本身敏感 |

处理口径(每条命中三选一,落 `SCAN-LEDGER.md`,只写 `文件:规则:行:处置:处置人:日期`,不写值):
a. 真密钥 → 先轮换,再把文件里的值改成 `<REDACTED:类型>`;
b. 假阳性 → 指纹写 `.gitleaksignore` 并附一句理由;
c. 敏感但非密钥(Discord channel id、内部路径等)→ 保留并注明「非密钥」。
0 条时:台账记两工具版本、扫描字节数、阳性对照命中清单、抽样复核的文件清单。

### 4.4 二进制资产

| 选项 | 判断 |
|---|---|
| **D1 原样进仓(推荐)** | founder 说「就是现在盘上的样子」;17MB 三个文件,仓 29MB,远低于任何限制 |
| D2 git LFS | 多一套机制,另一台机器还得装 LFS |
| D3 排除媒体 | 违反「盘上原样」,sub-lead 那份就不完整 |

### 4.5 首搬提交的身份

首搬会一次触 12 个夹 + 顶层文件,按 B1 规则任何单个 Lead 都不能提。
⇒ 护栏留一个显式的 `FLYWHEEL_MEMORY_ACTOR=admin` 模式:允许多夹与顶层文件,但必须写 `Memory-Owner: admin` 且落审计日志。
这不是安全边界(任何进程都能设这个变量),CI 审计会把 admin 提交单独列出,founder 看得见每一次。

## 5. 待 founder / Lead 裁定的问题(已非阻塞送出,id `2be69119`)

1. 扫描工具 = gitleaks + trufflehog 并集?(试扫 0 条,阳性对照通过)
2. 处理口径 = 上面 4.3 的三选一 + 台账?
3. 仓名 `xrliAnnie/lead-memory`、sub-lead 媒体原样进仓?
4. 护栏身份来源 = `FLYWHEEL_LEAD_ID`,runner 继承是已知边界?

## 6. 决策(当前按推荐项推进;founder 裁定不同则在 plan 里改对应 chunk)

- A1 原地建仓 · B1 hook+trailer+CI 审计 · C1 两工具并集 · D1 媒体原样 · 首搬用 admin 模式。
- 源码与测试放在 flywheel 仓 `scripts/lead-memory/`,记忆仓顶层只放拷贝;这样护栏脚本有 CI 跑测试,记忆仓自己不需要 Node/pnpm。

## 7. 下一步

research.md:定 hook 的精确规则与失败信息、trailer 写法、CI 工作流、Discord token 自定义规则、另一台机器的 bootstrap 步骤、
验收矩阵(含阴性对照)、回滚边界、与 A2 的提交合同。
