# FLY-2145 Lead 记忆私有仓 — 调研
Issue: FLY-2145 (https://linear.app/geoforge3d/issue/FLY-2145/2132a1-lead-记忆建私有仓一仓十二夹-全读只写自家-首搬-真密钥扫描)
日期: 2026-09-03
基于: exploration.md

> 本文只记「实测过 / 查过」的事实与由此定下的技术形状;每一节末尾写出处命令。数字测于 2026-09-03。
> ⚠️ 本文早于两轮 Codex 评审;凡与 plan.md(rev 4)不一致处以 plan 为准,已被取代的段落用「【已被 plan rev 4 取代】」逐段标出,实施者不要照做。

## 1. 仓的形状(定稿)

```
~/.claude/agent-memory/            ← git 工作树 = 仓根(原地 git init,文件一个不动)
├── .git/
├── .githooks/                     ← 顶层,admin 专属
│   ├── pre-commit  prepare-commit-msg  pre-push   (薄包装,exec lib/guard.sh)
│   └── lib/guard.sh                                (唯一一份规则源,hook 与 CI 共用)
├── .github/workflows/guard.yml    ← 服务端审计:owner 规则 + gitleaks
├── .gitleaks.toml                 ← extend 默认规则 + discord-bot-token 自定义规则
├── .gitleaksignore                ← 假阳性指纹(每行后跟 # 理由)
├── .gitignore                     ← 只写 .DS_Store
├── README.md                      ← 一页:形状 / 合同 / 另一台机器怎么拉
├── SCAN-LEDGER.md                 ← 首搬扫描台账(不写值;scan.sh 生成的运行时产物,模板同步永不覆盖)
├── bootstrap.sh                   ← 本机原地初始化 或 新机器 clone,装 hooksPath(由 sync-template.sh 从 flywheel 仓拷入)
├── flywheel-eng-lead/ … 12 个 Lead 夹(原样)
```

- 顶层文件与 `.githooks/` 的**源码与测试住在 flywheel 仓** `scripts/lead-memory/`,记忆仓里是拷贝;
  这样规则脚本有 CI 跑测试,记忆仓自己不需要 Node/pnpm。拷贝更新只能以 admin 提交进记忆仓。
- `~/.claude/.gitignore` 追加一行 `agent-memory/`。实测该文件不在 chezmoi 管辖(`chezmoi managed | grep '^.claude/.gitignore'` = 0),
  改它不会被 02:00 的 dotfiles 同步覆盖。目的:外层 `claude-config` 仓不会把嵌套仓当 gitlink 意外 add。
- 全局 git 配置无 `core.hooksPath`、无 `core.excludesfile`;`~/.claude` 仓也无 `core.hooksPath`
  ⇒ 记忆仓设 `git config core.hooksPath .githooks`(相对仓根)不会被上层覆盖,也不会被 flywheel 的 push-guard 安装逻辑碰到(那只装到 runner worktree)。

出处:`git config --global core.hooksPath` · `git -C ~/.claude config core.hooksPath` · `chezmoi managed`。

## 2. 写权护栏的精确规则(`guard.sh`)

### 2.1 身份与模式(稳定标识)

| 名称 | 值 | 来源 |
|---|---|---|
| Lead 身份 | `FLYWHEEL_LEAD_ID`(= 文件夹名 = agent 名) | Lead 进程已有,实测 `flywheel-eng-lead` |
| 提交归属 trailer | `Memory-Owner: <lead-id>` 或 `Memory-Owner: admin` | `prepare-commit-msg` 自动写,`git interpret-trailers --parse` 读 |
| 动作者模式 | `FLYWHEEL_MEMORY_ACTOR` ∈ {unset(=lead), `sync`, `admin`} | 显式环境变量 |
| 审计日志 | `${FLYWHEEL_STATE_DIR:-~/.flywheel}/state/lead-memory/audit.log`,TSV:时间·模式·身份·动作·结果·提交/路径 | 与 FLY-1718 push-guard 同形 |
| 文件夹名合法形状 | `^[a-z0-9][a-z0-9-]*$` | 12 个现有夹全部匹配 |

### 2.2 三条规则

- **R1 单夹**:一个提交触到的所有路径(含删除、改名的旧名;用 `--no-renames` 列两边)必须都在**同一个**顶层夹里。顶层文件(没有 `/`)只有 admin 能动。
- **R2 归属**:提交的 `Memory-Owner` trailer 必须等于 R1 那个夹;顶层/多夹提交必须是 `admin`。
- **R3 自家**:lead 模式下(`FLYWHEEL_MEMORY_ACTOR` 未设),`FLYWHEEL_LEAD_ID` 必须已设,且 R1 那个夹必须等于它。未设 ⇒ 拒绝(fail-closed,提示设 actor)。
  `sync` 模式(A2 用):不查 R3,但每个提交仍要过 R1/R2,且不许碰顶层。
  `admin` 模式:跳过 R1/R3,R2 要求 trailer 为 `admin`。

### 2.3 三个钩子 + CI 各查什么

| 位置 | 输入 | 查 |
|---|---|---|
| `pre-commit` | `git diff --cached --name-only --no-renames` | R1 + R3(此时还没 trailer);再跑 `gitleaks git --pre-commit --staged -c .gitleaks.toml`(实测暂存种毒文件 rc=9 可拦) |
| `prepare-commit-msg` | 提交信息文件 | 用 `git interpret-trailers --in-place --if-exists replace --trailer "Memory-Owner: <id或admin>"` 写归属 |
| `pre-push` | stdin 的 ref 行;远端为零 sha 时 `git rev-list <local> --not --remotes=origin`,否则 `<remote>..<local>` | 每个提交 R1+R2(+lead 模式 R3);非快进与删分支一律拒,**不设 ACK 变量**(plan §2 定稿,比 FLY-1718 少一个口子) |
| CI `guard.yml`(push 到 main) | `${before}..${after}`(before 为零时 `--root` 全量) | 每个提交 R1+R2;`gitleaks git --log-opts=<range>`;任一失败 ⇒ 红 + job summary 列出违规提交;admin 提交在 summary 单独列出让 founder 看得见 |

实测出处(scratch 仓):`git commit --trailer "Memory-Owner: lead-a"` 后 `git log -1 --format=%B | git interpret-trailers --parse` 输出 `Memory-Owner: lead-a`;
`git diff-tree --no-commit-id --name-only -r HEAD` 列路径;`git rev-list HEAD --not --remotes` 在无远端时返回全部提交(所以零 sha 情形要用 `--not --remotes=origin` 并在无 origin 时视为全量)。

### 2.4 失败信息(显示标签)

统一前缀 `lead-memory-guard:`,一行一因,末行给修法。例:
```
lead-memory-guard: refusing commit — path sub-lead/x.md is outside your folder flywheel-eng-lead/
lead-memory-guard: a Lead may only write its own folder; set FLYWHEEL_MEMORY_ACTOR=admin only for repo-level maintenance
```

### 2.5 明确不是安全边界(诚实边界)

- `git commit --no-verify` / `git push --no-verify` 能绕过本地钩子;runner/Lead 合同已禁止(FORCE-PUSH GUARD 条款同源)。CI 会把绕过的提交标红,但那时提交已在远端历史里。
- `FLYWHEEL_MEMORY_ACTOR=admin` 任何进程都能设;它是「显式声明 + 留痕」,不是权限。
- GitHub 只认得一个账号(xrliAnnie),服务端无法按 Lead 拒写;这与 issue 写明的「git 本身不做目录级写权」一致。
- runner 继承其 Lead 的 `FLYWHEEL_LEAD_ID`(实测):runner 若在仓里提交会被当成它的 Lead。runner 的记忆路径不在本仓,正常不会发生。

## 3. 密钥扫描(定稿)

### 3.1 工具与版本

【已被 plan rev 4 取代】下表「首搬命令」扫的是活目录;plan C4 定稿为扫 index 树的物化快照,并显式传 `.gitleaksignore` 路径。版本与钩子命令仍有效。

| 工具 | 版本 | 命令(首搬) | 命令(持续) |
|---|---|---|---|
| gitleaks | 8.30.1 | `gitleaks dir <仓根> -c .gitleaks.toml --report-format json --report-path <本机报告目录>/gitleaks.json --exit-code 0` | pre-commit `gitleaks git --pre-commit --staged`;CI `gitleaks git --log-opts=<range>` |
| trufflehog | 3.97.2 | `trufflehog filesystem <仓根> --json --no-update --no-verification --fail-on-scan-errors > <本机报告目录>/trufflehog.jsonl`(`--no-verification`:不把候选值发往厂商 API) | 不挂钩子(首搬交叉验证用) |

- `.gitleaks.toml`:`[extend] useDefault = true` + 自定义规则 `discord-bot-token`,正则 `[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}`。
  实测:带此规则对阳性样本命中 8 条含 `discord-bot-token`;对真实目录仍 0 条。
- 两把工具对同一目录实测:gitleaks 扫 20.93MB **0 条**;trufflehog 扫 11.88MB(它跳过更多二进制)**0 条**。
- 阳性对照必须用合规样本:`AKIA…EXAMPLE` 与错长度 `ghp_` 在两家白名单里,都 0 命中;换随机合规样本后 gitleaks 8 条 / trufflehog 4 detector。
  ⇒ `scan.sh` 内置阳性对照。【已被 plan rev 4 取代】聚合阈值(命中数 < 预期)改为逐条「样本 → 规则/detector」映射断言。

### 3.2 处理口径与台账(Lead 已回 ask `2be69119`:按此口径,且不加任何开关;终扫判据见 plan C4)

`SCAN-LEDGER.md` 每行:`文件 | 规则/detector | 行 | 处置(轮换+脱敏 / 假阳性 / 非密钥保留) | 处置人 | 日期`,**不写命中值**。
0 条时台账正文写:两工具版本与扫描字节、阳性对照命中清单、抽样复核清单(12 夹各抽 ≥3 个含 token/key/secret 字样的文件,人工看过,记文件名与结论)。
原始 JSON 报告(可能含值)只留 `~/.flywheel/state/lead-memory/scan/<日期>/`,进 `.gitignore`?——不需要,它本来就不在仓内路径。

### 3.3 顺序硬约束

扫描 → 逐条处置 → **再**做第一个提交。先提交再脱敏会把值留在历史里,历史清洗要 filter-repo + 强推,本单不做。

## 4. 私有性与「另一台机器」

- GitHub 私有仓匿名访问实测:`curl https://github.com/xrliAnnie/raya-memory` → **404**(同账号现有私有仓;公开仓会 200)。验收用同一条命令打新仓。
- 推送凭据:git 用 `gh auth git-credential`(scope 含 `repo`),ssh 地址被 `insteadOf` 改写成 https;`SSH_AUTH_SOCK` 在 Lead/runner 进程里未设。
  ⇒ 远端 URL 用 https 形式,别写 `git@github.com:`。
- 另一台机器:`bootstrap.sh --clone`。【已被 plan rev 4 取代】「先改名再 clone」改为「先 clone 到临时同级目录,成功后再改名换位,换位失败复原」(plan C3)。需要那台机器 `gh auth login` 过同一账号。
- 本单「另一台机器」的验收证据:【已被 plan rev 4 取代】不再是活目录 `diff -r`;改为 clone 后 checkout `IMPORT_SHA`,两边 `git ls-tree -r` 逐字节一致(plan C6)。真第二台机器由 founder 拉,README 写步骤;设计里写明这一格是「等价验证」不是「真机」。

## 5. 与 A2 的合同(本单只留接口,不做)

A2 的定时器若要过本仓护栏,必须:每个 Lead 夹单独 `git add <夹>/ && git commit`(一提交一夹),`FLYWHEEL_MEMORY_ACTOR=sync`,不碰顶层;
push 前 `git pull --rebase`;「到没到」看 `git ls-remote` 与 CI 结论,不看本地日志。这些写进 README「合同」一节,A2 设计时直接引用。

## 6. 回滚边界

| 阶段 | 回滚动作 | 影响 |
|---|---|---|
| 建仓后、推送前 | `rm -rf ~/.claude/agent-memory/.git` + 撤掉 `~/.claude/.gitignore` 那一行 | 记忆文件零变化(原地 init 从不移动文件) |
| 推送后 | founder 在 GitHub 删仓(或转私有归档);本机同上 | 远端副本消失,回到零副本状态 |
| 钩子出问题 | `git -C ~/.claude/agent-memory config --unset core.hooksPath` | 仓还在,只是没护栏;CI 仍审计 |

首搬期间 Lead 照常写文件(Write 工具写盘不经过 git),不需要停机;首搬提交只是把当刻快照收进去,之后的变更等 A2。

## 7. 测试基础设施

- shell 套件放 `scripts/__tests__/test-lead-memory-*.test.sh`,风格照 `test-push-guard.test.sh`(TAP 风格 pass/fail 计数,临时目录,`git_quiet`)。
- **必须登记进 `.github/workflows/ci.yml` 的 script-tests job**,否则 `ci-shell-suite-enumeration.test.sh`(FLY-1764)会红。
- 扫描套件里的阳性对照可在 Linux CI 跑(gitleaks 有 Linux 二进制,CI 步骤按版本下载);trufflehog 交叉验证只在本机 runbook 跑,不进 CI(避免 CI 装两把)。
