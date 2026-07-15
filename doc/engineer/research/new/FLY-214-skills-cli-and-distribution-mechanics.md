# Research: skills CLI 与分发机制实测 — FLY-214

**Issue**: FLY-214(+ 即将开的 flywheel-skills 能力库 issue,结果两边共用)
**Date**: 2026-06-04
**Source**: `doc/engineer/exploration/new/FLY-214-global-skill-framework.md`
**Method**: 源码审读(vercel-labs skills CLI 1.5.10 npx 缓存包)+ 沙箱实测(`HOME=/tmp/fly214-sandbox`,本地 git repo 做源,零生产改动)+ Claude Code 官方文档核对(code.claude.com/docs/en/skills)。沙箱证据保留在 `/tmp/fly214-skill-repo` + `/tmp/fly214-sandbox`。

---

## 结论速览

| # | 检查点 | 结论 | 置信度 |
|---|--------|------|--------|
| ① | 私有 repo 支持 | **可用**。add=浅 git clone(吃本机 git 凭据);update=GitHub API tree fetch,token 链 `GITHUB_TOKEN`→`GH_TOKEN`→`gh auth token`(CLI 自己会 shell 出 gh)。Annie 各机 gh 已登录 | 高(源码级,update 私库全链待真仓 QA) |
| ② | update 对本地手改 | **本地路径安装根本不进 lockfile**(update 对其无感)→ 库必须以 GitHub 形态 add;fetch 失败路径实测**不碰本地文件**(fail-safe);"成功 update 是否覆盖本地手改"未能完整实测(需真私库),**按会覆盖设计**,留 QA 验证 | 中 |
| ③ | 嵌套分类目录 | **原生支持**。`findSkillDirs` 递归扫到深度 5;实测 `skills/generic/<a>` + `skills/flywheel/<b>` 一次 add 全发现。**但安装后扁平化**(`~/.agents/skills/<name>`,无 tier 子目录)→ 跨 tier 名字必须唯一;tier 只是源仓的组织轴 | 高(实测) |
| ④ | 同名优先级 | 官方文档明文:**enterprise > personal(user 级)> project**。即 `~/.claude/skills/<x>` **压过**项目 `.claude/skills/<x>`!plugin skill 带命名空间不冲突 | 高(官方文档) |
| ⑤ | Codex 扇出 | **坑**:skills CLI 把 Codex 列为 "universal"(= 假设 Codex 原生读 `~/.agents/skills/`),沙箱实测它**不写** `~/.codex/skills/`;而 Codex 已证实的技能路径是 `~/.codex/skills/`(本机 21 个)。"universal 假设"未验证 → **缓解:launchd 包装脚本里加 3 行显式 symlink 扇出** `~/.agents/skills/* → ~/.codex/skills/`;真 Codex 探针留实现期 QA | 中(缓解已定) |

## 重大新发现(修正 brainstorm R2-3 — 好消息)

官方文档(Live change detection):**Claude Code 监视 skill 目录的文件变化** —— 在 `~/.claude/skills/`、项目 `.claude/skills/` 下**新增/编辑/删除 skill,当前运行中的 session 内即生效,无需重启**。唯二例外:(a) session 启动时顶层 skills 目录不存在,后建的目录要重启才被监视;(b) 只有 SKILL.md 文本是 live 的(plugin 的 hooks/.mcp.json 等不算)。

**推翻我 R2-3 的保守说法**("新增 skill 要等 agent 下次重启")。修正后的真实语义:

> 定时拉取落盘 → **全机所有在跑的 session(包括长跑 Lead)立即看到新 skill** —— 加能力从此完全不需要重启任何东西。唯一一次性前置:确保各 agent 的顶层 skills 目录在 Lead 启动前已存在(本机已满足;新机 onboard 脚本里 mkdir 一行)。

这让方案比 brainstorm 阶段承诺的更好,不是更差。

## 各检查点细节

### ① 私有 repo 鉴权(源码级)

- `add` 路径:simple-git 浅 clone(`--depth`),凭据 = 本机 git(gh 配的 credential helper / osxkeychain / SSH 均可)
- `update` 路径:`api.github.com/repos/<o>/<r>/git/trees/<branch>?recursive=1`,鉴权链:`GITHUB_TOKEN` env → `GH_TOKEN` env → `execSync("gh auth token")`。触发 gh 回退时 stderr 有提示;`--full-depth` 可改走 clone 路径
- launchd 跑 update 时 env 干净 → 依赖 gh 回退即可(各机 gh 已登录);更稳妥可在包装脚本里 `export GITHUB_TOKEN=$(gh auth token)`

### ② update 与本地手改(沙箱实测)

- 实测 1:本地路径 add(`skills add /tmp/fly214-skill-repo`)成功装 2 skill,但 **lockfile 完全没写**(沙箱 `~/.agents/.skill-lock.json` 不存在)→ `update -g -y` 报 "No global skills tracked" 无操作。**设计后果:flywheel-skills 必须以 `xrliAnnie/flywheel-skills`(GitHub 形态)add,否则定时 update 是空转**
- 实测 2:伪造 github 型 lock 条目(stale hash)+ 源不可 fetch → CLI 报 `✗ Failed to fetch tree` 后**宣布 up to date、不碰本地文件**(本地手改 marker 完好)→ fetch 失败 = fail-safe 不破坏
- 未测到:成功 update 覆盖本地手改的确切行为(需真 GitHub 私库)。**设计假设:会覆盖**(canonical 目录归库管,"本地手改库管 skill"本来就该被禁止 —— 改动走 PR)。实现期 QA 用真库补测

### ③ 嵌套发现 + 扁平安装(沙箱实测)

- `findSkillDirs(dir, depth=0, maxDepth=5)` 递归收集所有含 SKILL.md 的目录 → `skills/generic/<name>/`、`skills/flywheel/<name>/` 两层结构无需任何 flag 即被发现(`--full-depth` 只在根有 SKILL.md 时才需要)
- **安装目标扁平**:`~/.agents/skills/test-skill-a`(不带 generic/)→ 各 agent symlink 也扁平。两个 tier 内不得重名;分类轴只活在源仓(和 README 准则里)

### ④ 同名优先级(官方文档)+ 命名纪律

> "When skills share the same name across levels, enterprise overrides personal, and personal overrides project."

user 级压过 project 级 = **库里的名字会遮蔽任何项目的同名 skill**。GeoForge3D 项目自有 skill 共 ~30 个(onboard、onboard-*、brainstorm、orchestrator、pm-triage、flywheel-land、flywheel-tdd …)。**命名纪律(写进库 README + CI):**
1. 库内 skill 禁止使用与任何受管项目 `.claude/skills/` 现存同名的名字(CI 可维护一张禁用名单)
2. **特别注意 flywheel-land**:v1 要从 SkillInjector 迁库 —— 但 SkillInjector 现在往 worktree(project 级)写 `flywheel-land`,GeoForge3D repo 还提交了一份。**迁库时序必须是:库版上线 → SkillInjector 删该模板 → 各项目 repo 删提交版**,期间 user 级库版会遮蔽 project 级旧版(行为一致所以无害,但要知道是遮蔽不是共存)
3. 另一面是特性:库版 skill 想全局统一行为时,user 级遮蔽 = 天然的"库压项目"升级路径

### ⑤ Codex 扇出(沙箱实测 + 二进制核对)

- 沙箱:即使预建 `~/.codex/`,add `--all -g` 也不写 `~/.codex/skills/`;CLI 把 Codex 归 "universal"(假设其原生读 `~/.agents/skills/`)
- Codex 0.137 二进制 strings:见到 `~/.agents/plugins/marketplace.json`(plugin 体系),**没找到** `~/.agents/skills` 的技能发现引用;已证实路径 = `~/.codex/skills/`(21 个原生 skill 实存)
- **缓解(进库 issue 的 installer 设计)**:launchd 包装脚本 update 后补一段显式扇出:`for d in ~/.agents/skills/*/; do ln -sfn "$d" ~/.codex/skills/$(basename "$d"); done`(幂等,3 行)。真 Codex session 能否发现+调用 = 实现期一次活体探针(费一次 codex 额度,值)

## 其他设计相关发现(官方文档)

- **description 预算**:skill 列表注入有字符预算(`skillListingBudgetFraction`,每条 name+description 上限 1536 字符)→ 库规模大了 description 会互相挤预算。README 准则:description 必须短而准(关键触发场景放最前);低频 skill 可用 `skillOverrides` 设成 name-only
- **`skillOverrides`(settings.local.json 级)**:不改 SKILL.md 就能 per-工作目录 关/折叠某 skill → **免费拿到 per-Lead 门控旋钮**(例:某 Lead 误触发某库 skill,在它的 lead-workspace settings.local.json 关掉即可,不用动库)
- **`disable-model-invocation: true`**:留给"只许人手动斜杠调用"的 skill(FLY-158 已踩过这个坑的反向)
- **安全**:skill 可携带 `allowed-tools` 限权;`disableSkillShellExecution` 设置可全局禁 skill 内联 shell —— 配合库的 PR+shellcheck 门,纵深三层

## 对两个 issue 的落地修正

**flywheel-skills 库 issue(team-lead 开)**:
1. add 必须用 GitHub 形态(本地路径不进 lockfile,update 空转)
2. launchd 包装脚本 = `skills update -g -y` + Codex 显式扇出 3 行 +(可选)`GITHUB_TOKEN=$(gh auth token)` 前置
3. README 准则增:命名禁用名单(不得与受管项目 project skill 重名)+ description 字数纪律(预算挤占)
4. CI 第四道门:命名冲突检查(对照各受管项目 `.claude/skills/` 清单)
5. QA 清单:真私库 add/update 全链、成功 update 覆盖本地手改行为、Codex 活体探针、运行中 Lead 热加载新 skill 实证

**FLY-214(本 issue)**:
1. R2-3 修正为好消息:加 skill 全程零重启(运行中 Lead 热加载);只有 lead-rules-base 瘦身那刀(prompt 文件变更)仍要等重启窗
2. flywheel-land 迁库时序(见 ④-2):库版上线 → SkillInjector 删模板 → 项目 repo 删提交版
3. 验收补一条:在跑的 Lead 不重启,库里新增 skill 后 Lead 能在同 session 内发现并调用(热加载实证)

## 下一步

- [ ] 把修正同步 team-lead(R2-3 好消息 + 命名遮蔽坑 + Codex 缓解)
- [ ] `/write-plan` → codex-design-review(FLY-214 侧:瘦身 + flywheel-land 迁移 + 首批住户端到端)
- [ ] 沙箱证据(/tmp/fly214-*)保留至实现期 QA 复用
