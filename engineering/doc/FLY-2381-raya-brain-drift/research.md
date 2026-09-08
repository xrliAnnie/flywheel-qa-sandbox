# FLY-2381 Raya 大脑:读各仓 + goal 两阶段 + 偏离探测 — 调研
Issue: FLY-2381 (https://linear.app/geoforge3d/issue/FLY-2381/raya大脑-自己去各仓读状态-goal-两阶段-偏离探测prd-1846-51-7-102030-声明过从未交付的那一半)
日期: 2026-09-06
基于: exploration.md

> 每条【实核】附复核命令;代码路径以 raya 仓 `origin/main`(`b1b5a64`)为准;FLY-2379 的接口以其 plan.md(已 R4 approved,implement 进行中)为准,实核见 §4;规范合同只在本单 plan.md。⛔ 本单不碰 `~/.flywheel/raya/code`。

## 1. 注册表:`RAYA_PROJECTS_FILE` + Raya 自己的最小 schema

【实核】`~/.flywheel/projects.json` 顶层键集:`generalChannel · leads · linear · memoryAllowedUsers · projectName · projectRepo · projectRoot · summaryAggregatorLeadId`;六项目全有 `projectName/projectRoot/projectRepo`,`linear` 只有 flywheel 非 null(`{team:"FLY", project:"Flywheel", label:"Flywheel"}`)。

复核:`python3 -c "import json;d=json.load(open('$HOME/.flywheel/projects.json'));print(sorted({k for p in d for k in p}))"`

Raya 侧合同(`packages/contracts/src/projects-registry.ts`,新):

```ts
interface RegisteredProject {
  projectName: string;          // 非空,唯一;规范 = plan §2.1(^[A-Za-z0-9_-]{1,64}$,无点)
  projectRoot: string;          // 绝对路径;不存在不算错(采样时记「读不到:目录不存在」)
  projectRepo?: string;         // "owner/name",段不以 -/. 开头(plan §2.1);缺 ⇒ GitHub 读数「未配置」
  linear?: { team: string; project: string } | null;  // 缺/null ⇒ Linear 读数「未配置」
}
```

- `loadProjectsRegistry(path)`:JSON 顶层必须是数组;每项按上表校验,**多余字段忽略**(flywheel 的 `leads/memoryAllowedUsers/...` 直接被丢);重名 fail-loud;空数组 fail-loud(注册表为空 = 配置错,不是「没有项目」)。
- `config.ts`:`RAYA_PROJECTS_FILE` 必填绝对路径(`canonicalFile`),并加入 `sensitive` 重叠检查?—— **不加**:它是只读输入,不是密钥;但 workspace roots 不得覆盖它(防模型改注册表)⇒ 加入 `sensitive` 列表,标签 `projects registry`。
- §8.5 判据:换一台没有 flywheel 的机器,operator 手写同 schema 的 JSON 即可 —— 成立。

## 2. 采样命令(全部 `execFile`,每条超时 10 s,整份快照 90 s deadline,输出按最小形状解析)

【实核 2026-09-06】在 `~/Dev/GeoForge3D` 逐条实跑(耗时见括号;R1-5/R1-7 后的形状):

| 读数 | 命令 | 解析 | 实测 |
|---|---|---|---|
| checkout 分支 | `git -C <root> rev-parse --abbrev-ref HEAD` | 非零 ⇒ `not_a_git_repo`;输出 `HEAD` ⇒ detached,再取 `rev-parse --short HEAD` | `main`(joycon:`chore/enable-doc-flow`) |
| checkout 最近提交 | `git -C <root> log -1 --format=%H%x1f%cI%x1f%aI%x1f%an%x1f%s` | `\x1f` 分五段;**committer 时间 `%cI` 为主**,author 时间另存 | `c2f40de4 … 2026-08-29T22:53:57-07:00 … chore(config): retire project flag keys (#283)` |
| checkout 最近**非 chore** 提交(启发式) | 同上 + `--extended-regexp --regexp-ignore-case --invert-grep --grep=^chore(\(|:|!)` | 空输出 ⇒ `null`;⚠️ git `--grep` 默认 BRE,**必须 `-E`**,否则 `parentheses not balanced`(实核) | `2026-07-11 feat(GEO-446)`;joycon:`2026-07-04 docs(LEARN-203)` |
| 30 天提交数 / 非 chore 数 | `git -C <root> rev-list --count --since=30.days HEAD`;再加同上 grep 参数 | 整数 | `2` / `0` |
| 未提交改动数 | `git -C <root> status --porcelain` 行数 | 整数,不给文件名 | `7` |
| worktree 数 | `git -C <root> worktree list --porcelain` 中 `^worktree ` 行数 | 整数 | `34` |
| canonical 默认分支 | `gh repo view <repo> --json defaultBranchRef -q .defaultBranchRef.name` | 合 `^[\w./-]{1,128}$` 才进下一条 argv | `main`,0.40 s |
| canonical 最近提交 | `gh api repos/<repo>/commits?sha=<default>&per_page=1` | `[0].sha[0:7]`、`.commit.committer.date`、`.commit.message` 首行 | `c2f40de 2026-08-30T05:53:57Z chore(config)…`,0.53 s |
| PR 活动(有排序保证) | `gh pr list -R <repo> --state all --search "sort:updated-desc" --limit 1 --json number,state,updatedAt,mergedAt` | 全仓最近被更新的 PR(任一状态);**唯一进入 activity 的 GitHub 字段**(§5) | flywheel `#1102 OPEN 23:43Z`,0.46 s |
| open PR(有界样本) | `gh pr list -R <repo> --state open --search "sort:updated-desc" --limit 50 --json number,title,updatedAt,isDraft` | `returnedCount`、`truncated = (count === 50)`、`newestUpdatedAt`(页首)、`oldestUpdatedAt`(truncated ⇒ unavailable)、前 5 条;不进 activity | 26 条,0.54 s |
| 部署 checkout 的 summary 文件 | `readdir(<RAYA_CODEX_CWD>/summaries/<projectName>)` 匹配 `^\d{4}-\d{2}-\d{2}--` + `git -C <RAYA_CODEX_CWD> rev-parse --short HEAD` | `count`、`latestDate`、`checkoutSha`;**非未读/已读状态**(那是 2131 merge-receipt 合同) | 全部 0 @ `b1b5a64` |
| Linear | `POST https://api.linear.app/graphql`(见 §2.2) | ⬜ implement 真机核 | 未配置 |

复核(任一仓):`git -C ~/Dev/GeoForge3D log -1 --format='%cI%x1f%s' -E -i --invert-grep --grep='^chore(\(|:|!)'; gh repo view xrliAnnie/geoforge3d --json defaultBranchRef -q .defaultBranchRef.name; gh api 'repos/xrliAnnie/geoforge3d/commits?sha=main&per_page=1' -q '.[0].commit.committer.date'`

每仓最多 9 条命令 × 10 s 上限,但实测单条 < 1 s;六仓 bounded concurrency 2 ⇒ 正常 < 10 s,最坏受 90 s 全局 deadline 封顶(到期字段落 `deadline`)。

### 2.1 「chore」判定是启发式,不是裁定

`--grep=^chore` 只看 subject 前缀(conventional commits)。它把 08-29 那条 fleet 级 `chore(config): retire project flag keys` 正确归为「机器整理」,但也会把某个 Lead 真正的整理工作算成「非推进」。处置:**两个读数都进快照、都渲染给模型和她**(`最近提交` 与 `最近非 chore 提交` 并列),提示段写明「以非 chore 为主判『真实推进』,但两条都要引用」。代码不再做第三层判断。

### 2.2 Linear(可选,默认读不到)

【实核】Raya env 键名清单无 LINEAR;projects.json 只 flywheel 有绑定(`{team:"FLY", project:"Flywheel", label:"Flywheel"}`,`label` 被投影丢弃);本会话 Linear MCP 401。⇒ 今天六个项目的 Linear 读数全是 `unavailable: not_configured`。

留口子(⬜ 形状按 Linear GraphQL 公开文档:list 一律 cursor 分页、默认按 createdAt 排序、`orderBy: updatedAt` 才取最近更新;implement 时真机核):`RAYA_LINEAR_API_KEY` 可选;有 key 且项目有 `linear {team, project}` 时,一次 GraphQL,**variables 传值不拼字符串**:

```graphql
query($team: String!, $project: String!) {
  teams(filter: { key: { eq: $team } }) { nodes {
    projects(filter: { name: { eq: $project } }) { nodes {
      id name state updatedAt
      issues(first: 50, orderBy: updatedAt,
             filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
        pageInfo { hasNextPage }
        nodes { identifier updatedAt state { name } }
      } } } } }
}
```

恰一 team × 恰一 project 才命中(0 ⇒ `linear_not_found`,>1 ⇒ `linear_ambiguous`);`activeIssues = {returnedCount, truncated: hasNextPage, latestUpdatedAt}`(**不是精确总数**);HTTP 非 2xx ⇒ `linear_http:<status>`;200 但 `errors` ⇒ `linear_graphql_error`;形状不符 ⇒ `parse_error`;超时 ⇒ `timeout`。阶段一**不分页**。

### 2.3 launchd 下 `gh` 不在 PATH(部署前提)

【实核】`~/Library/LaunchAgents/com.xrli.raya.brain.plist` 的 `EnvironmentVariables` 只有 `RAYA_ENV_FILE`,无 `PATH` ⇒ brain 进程 PATH 是 launchd 默认(`/usr/bin:/bin:/usr/sbin:/sbin`);`which gh` = `/opt/homebrew/bin/gh`,`git` = `/usr/bin/git`。

复核:`plutil -p ~/Library/LaunchAgents/com.xrli.raya.brain.plist | grep -A3 EnvironmentVariables; which gh git`

⇒ 沿 `RAYA_GOG_BIN`(默认 `/usr/local/bin/gog`,`absolutePath` 校验)的先例:`RAYA_GH_BIN` 默认 `/opt/homebrew/bin/gh`,`RAYA_GIT_BIN` 默认 `/usr/bin/git`;采样时可执行性检查失败 ⇒ 该来源全部 `unavailable: gh_missing`,**不是**进程崩。`gh` 的凭据走 keyring(【实核】`gh auth status`:xrliAnnie,keyring,scope 含 repo);launchd 下 keyring 可用性 ⬜ implement 用 preflight 真机核(`preflight` 输出 `portfolio.github: ok|unavailable:<reason>`)。

## 3. goal 文件:memory 仓的实核事实(合同见 plan §3)

【实核】`~/.flywheel/raya/memory`:仓 `xrliAnnie/raya-memory`,clean,`user.name=xrliAnnie`,`user.email` 已配;`MEMORY.md` 合同段写明「Preserve provenance: every durable entry names its date and source」「Amend an outdated entry explicitly; do not silently rewrite」。goals.md 沿同一纪律;**格式、字段、事务与幂等规则以 plan §2.4 / §3 为唯一规范**。

【实核 2026-09-06】`git commit --only -- goals.md -m msg` 会把 `-m` 当 pathspec 失败(Codex R2-2 dry-run);正确 argv `git commit --only -m <msg> -- goals.md` 在临时仓实跑成功;但 plan rev4 起提交改走 plumbing(hash-object → 临时 index → commit-tree → update-ref CAS),不再依赖 `git commit` 读工作树(R3-2)。memory 目录 = `dirname(RAYA_MEMORY_FILE)`;不新增 env。

复核:`git -C ~/.flywheel/raya/memory status --short; git -C ~/.flywheel/raya/memory config user.name; d=$(mktemp -d) && git -C $d init -q && echo a > $d/goals.md && git -C $d add goals.md && git -C $d commit -q --only -m t -- goals.md && git -C $d log --oneline -1`

## 4. 与 FLY-2379 的接口面(实核;合同见 plan §2.5)

【实核 2026-09-06 晚】2379 已 R4 approved 并进入 implement:`~/.flywheel/raya/worktrees/raya-FLY-2379` 有 commit `5fe215e fix(brain): acknowledge text while chat is pending`(止血)与**未提交**的 `apps/brain/src/text-chat/{controller,codex-client,secret-isolation}.ts`、`config.ts` 改动、`packages/contracts/src/index.ts` 改动。⇒ 本单 implement 必须等这些落分支后再起分支;2379 plan 稳定身份:`TextChatController` · `runTurn({input, clientUserMessageId, replyToMessageId})` · `parseLeadAskLines → {asks, invalid, rest}` · `sendPlain` · 私有串行队列 · `baseInstructions = IDENTITY + MEMORY + 文字聊天段` · attestation 失败 = 文字聊天降级、语音/会议继续(其 §2.4b)。

复核:`git -C ~/.flywheel/raya/worktrees/raya-FLY-2379 status --short; git -C ~/.flywheel/raya/worktrees/raya-FLY-2379 log --oneline -3; grep -n "runTurn\|parseLeadAskLines\|sendPlain\|attestation_failed" ~/Dev/flywheel-FLY-2379/engineering/doc/FLY-2379-raya-text-chat/plan.md`

本单需要的三处扩展点(E1 系统 turn / E2 标记授权管线 / E3 执行时注入)**精确合同只在 plan §2.5**;本文不再复述。

## 5. GitHub 排序实核(R2-4)

【实核 2026-09-06】`gh pr list -R xrliAnnie/flywheel --state merged --limit 3 --json number,mergedAt` 返回 `#1100 18:04Z, #1099, #1098`,而 `--state all --search "sort:updated-desc" --limit 3` 返回 `#1102 OPEN 23:43Z, #1101 OPEN 22:19Z, #1063 MERGED 21:58Z(mergedAt 21:58:06Z)` ⇒ **默认顺序不是按 mergedAt/updatedAt;只有 `--search "sort:updated-desc"` 有排序保证**(GitHub search 限定符),耗时 0.46 s。采样器凡取「最新」一律带该参数;「最新 merge」无法证明,已从读数中删除。

复核:`gh pr list -R xrliAnnie/flywheel --state merged --limit 3 --json number,mergedAt -q '.[]|[.number,.mergedAt]|@tsv'; gh pr list -R xrliAnnie/flywheel --state all --search "sort:updated-desc" --limit 3 --json number,state,updatedAt -q '.[]|[.number,.state,.updatedAt]|@tsv'`

## 6. 触发与节奏(规范见 plan §2.6)

事实:brain `runtime.ts` 的 `runBrain` 是 60 s 资源采样循环(`do { runSamplerTick; wait(60s) } while(!aborted)`),与 Codex 无关;巡视计时器不塞进它,独立为 `PortfolioPatrol`(同进程、无新 daemon)。默认 6 h 来自 PRD §8.7.2(她圈 a)。启动探针 / fresh 规则 / 证据门 / 信封 / at-most-once 全部以 plan §2.6 为准。

## 7. 会过期的结论

| 结论 | as-of | 复核 |
|---|---|---|
| 五仓最近提交 08-29 同一条 chore;非 chore 停在 7 月 | 2026-09-06 | exploration §3 命令 |
| personal-assistant 已是 git 仓(belle-workspace) | 2026-09-06 | `git -C ~/Dev/personal-assistant remote -v` |
| brain plist 无 PATH;gh 在 /opt/homebrew/bin | 2026-09-06 | §2.3 复核 |
| projects.json 只 flywheel 有 linear 绑定;Raya 无 Linear key | 2026-09-06 | §1 复核;`grep -c LINEAR ~/.flywheel/raya/raya.env` |
| summaries/ 只有 README | 2026-09-06 | `ls ~/.flywheel/raya/code/summaries` |
| 2379 已 R4 approved、implement 进行中(controller.ts 未提交) | 2026-09-06 晚 | §4 复核命令 |
| `gh pr list` 默认 merged 顺序非 mergedAt | 2026-09-06 | §5 复核命令 |
| memory 仓 clean、author 已配 | 2026-09-06 | `git -C ~/.flywheel/raya/memory status --short; git -C ~/.flywheel/raya/memory config user.name` |
