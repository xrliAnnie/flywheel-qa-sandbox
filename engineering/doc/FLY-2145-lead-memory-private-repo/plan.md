# FLY-2145 Lead 记忆私有仓 — 实施计划
Issue: FLY-2145 (https://linear.app/geoforge3d/issue/FLY-2145/2132a1-lead-记忆建私有仓一仓十二夹-全读只写自家-首搬-真密钥扫描)
日期: 2026-09-03
基于: research.md · codex-review-round1.md · codex-review-round2.md(R1/R2 意见已全部并入,见 §10;research.md 中被本 plan 取代的段落已逐段标注)

## 0. 一句话

在 `~/.claude/agent-memory/` 原地建私有仓 `xrliAnnie/lead-memory`,用「一提交一夹 + `Memory-Owner` trailer + 本地钩子 + CI 审计」实现「全读 / 只写自家」,
首搬前用 gitleaks + trufflehog(含阳性对照)扫一遍并逐条落台账;定时同步留给 A2,本单只定合同。

## 1. 范围

**硬约束(Lead 2026-09-03 转达 founder 直令,ask `2be69119` 回复):不加任何开关 / 旋钮。**
扫描与 pre-commit 都是写死必跑:`scan.sh` 没有 `--skip` 类参数,`pre-commit` 里的 gitleaks 没有跳过用的环境变量,
`bootstrap.sh` 没有「不装钩子」选项。`FLYWHEEL_MEMORY_ACTOR` 只是声明「我是谁」(lead / sync / admin),
任何取值都不会关掉扫描或审计;这是身份声明,不是开关。

**做**:护栏脚本与测试(flywheel 仓)· bootstrap · 扫描 runbook 与台账 · 建私有仓 · 首搬 · 验收证据 · README 合同。
**不做**:定时器 / 远端到达巡检(A2)· Codex Lead 记忆(C1 未勾)· runner 记忆(B 系列)· 历史清洗 · 每 Lead 独立 GitHub 账号。

## 2. 稳定标识与显示标签(一处源:`scripts/lead-memory/lib/guard.sh` 顶部常量)

| 类别 | 值 |
|---|---|
| 远端仓 | `https://github.com/xrliAnnie/lead-memory.git`(私有,user 账号;founder 若改名只改这一处常量 + README) |
| 工作树 | `~/.claude/agent-memory`(不变) |
| 身份环境变量 | `FLYWHEEL_LEAD_ID` |
| 模式环境变量 | `FLYWHEEL_MEMORY_ACTOR` ∈ unset / `sync` / `admin` |
| trailer | `Memory-Owner: <lead-id>` / `Memory-Owner: admin` |
| 审计日志 | `${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/lead-memory/audit.log` |
| 扫描报告目录 | `${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}/state/lead-memory/scan/<UTC日期>/<run-id>/`(`umask 077`,报告先写临时文件再原子改名;扫描快照也物化在这里,扫完即删) |
| 扫描对象 | **不是活目录**,是「Lead 夹合成根树」的物化副本(定义见 C4 的 `lead_tree` 算法);提交前断言用同一算法从暂存树重建的合成根树 OID == `scanned_tree` |
| 台账指纹 | `工具:规则或detector:相对路径:sha256(命中值)前12位`,不写值;trufflehog 命中靠它对应处置行,gitleaks 命中靠 `.gitleaksignore`(显式传路径) |
| 台账 | 仓根 `SCAN-LEDGER.md` |
| 用户可见前缀 | `lead-memory-guard:`(钩子)· `lead-memory-scan:`(扫描)· `lead-memory-bootstrap:` |
| 夹名合法形状 | `^[a-z0-9][a-z0-9-]*$` |
| 非快进 / 删远端分支 | 一律拒绝,**没有 ACK 变量**(比 FLY-1718 少一个口子;记忆仓只有 main,永远 `pull --rebase` 后快进推) |
| 工具版本 | gitleaks 精确 `8.30.1`:scan.sh / bootstrap / pre-commit 都校验;trufflehog 精确 `3.97.2`:**只有 scan.sh** 校验(钩子与 bootstrap 不用它) |

## 3. 文件清单(flywheel 仓,本单新增)

```
scripts/lead-memory/
├── lib/guard.sh              规则 R1/R2/R3 + 审计;子命令 check-staged | trailer <msgfile> | check-range <a>..<b> | check-push(读 stdin)
├── hooks/pre-commit          exec lib/guard.sh check-staged && gitleaks git --pre-commit --staged
├── hooks/prepare-commit-msg  exec lib/guard.sh trailer "$1"
├── hooks/pre-push            exec lib/guard.sh check-push(内含 FLY-1718 的删分支/非快进逻辑)
├── bootstrap.sh              --init(本机原地)| --clone(新机器);装 hooksPath;写 ~/.claude/.gitignore
├── scan.sh                   阳性对照 → 两工具真扫 → 生成 SCAN-LEDGER.md 骨架(每条一行待处置)
├── sync-template.sh          把 hooks/ lib/ 与 repo-template/ 拷进记忆仓(admin 提交用)
└── repo-template/
    ├── README.md  .gitleaks.toml  .gitleaksignore  .gitignore   (没有 SCAN-LEDGER.md:台账是运行时产物)
    └── .github/workflows/guard.yml
记忆仓顶层由 sync-template.sh 放置:上述模板 + `.githooks/`(hooks/ + lib/)+ `bootstrap.sh` 的拷贝(新机器 `gh repo clone` 后直接跑仓内的 bootstrap.sh)
scripts/__tests__/
├── test-lead-memory-guard.test.sh          C1/C2:规则库 + 钩子真触发(CI)
├── test-lead-memory-bootstrap.test.sh      C3(CI)
├── test-lead-memory-scan.test.sh           C4:PATH 假件验流程与台账形状 + 真 gitleaks 8.30.1 阳性对照(CI 步骤按版本与校验和下载)
├── test-lead-memory-scan-real.test.sh      C4:双真工具阳性对照,只在本机跑 → 登记进 ci-shell-suite-manual-only.txt
└── test-lead-memory-workflow.test.sh       guard.yml 合同:push→main、contents: read、fetch-depth 0、零 before 处理、调用同一 guard.sh、gitleaks 固定版本+校验和、admin 提交进 job summary
.github/workflows/ci.yml       登记上面四个 CI 套件(FLY-1764 枚举检查)
scripts/__tests__/ci-structure.test.sh      同步更新它钉住的步骤清单/顺序(否则 Quick Gate 必红)
scripts/__tests__/ci-shell-suite-manual-only.txt  登记 scan-real 套件
engineering/doc/FLY-2145-lead-memory-private-repo/  本文件夹 + founder HTML + 验收证据 acceptance.md
```

## 4. Chunks(每个 chunk:先写测试 RED → 实现 GREEN → 提交)

### C1 护栏规则库 `lib/guard.sh` + 测试
测试(`test-lead-memory-guard.test.sh`,临时仓 + 假 origin):
- R1:两夹一提交 ⇒ 拒;顶层文件 lead 模式 ⇒ 拒;删除/改名旧路径跨夹 ⇒ 拒。
- R2:trailer 与夹不符 ⇒ `check-range` 拒;缺 trailer ⇒ 拒。
- R3:`FLYWHEEL_LEAD_ID=a` 改 `b/` ⇒ 拒;`FLYWHEEL_LEAD_ID` 未设且 actor 未设 ⇒ 拒并提示;`FLYWHEEL_LEAD_ID=a` 改 `a/`(含新夹首次出现)⇒ 过。
- sync 模式:跨夹多提交每个单夹 ⇒ 过;碰顶层 ⇒ 拒。admin 模式:多夹 + 顶层 ⇒ 过,trailer 必须 `admin`。
- 提交枚举语义:每个提交用 `git diff-tree --root --no-renames --no-commit-id --name-only -r <sha>`(根提交没有 `--root` 会列空 ⇒ 假绿,测试覆盖);**merge 提交一律拒**(A2 合同要求 rebase);空提交拒;`Memory-Owner` trailer 必须**恰好一条**(0 条或 2 条都拒)。
- `check-push`:零 sha 新分支 ⇒ 用 `--not --remotes=origin` 枚举(无 origin 时视为全量);删分支 ⇒ 拒;非快进 ⇒ 拒,没有 ACK 路径(FLY-1718 的 wrong-branch / 一次性 ACK 测试不再适用,改为「任何非快进都拒」的断言)。
- `check-range` 与 actor 无关:只做「提交自证」(R1+R2),CI 与本地 pre-push 共用;R3 只在 lead 模式的 `check-staged` / `check-push` 里加。
- 模式合同:未知 `FLYWHEEL_MEMORY_ACTOR` 取值 ⇒ 拒;`sync` 模式 owner **从唯一暂存夹推导**(R1 已保证只有一个夹),不需要另一个 ID 来源;`admin` 模式提交 trailer 恒为 `admin`。`sync` 与 `admin` 都是绕过 R3 的例外路径,**放行审计行写不进 ⇒ 都拒**(与 FLY-1718 同:放行必须留痕)。
- 每次拒绝与每次 admin / sync 放行审计日志各多一行,格式字段数 = 6;测试同时断言拒绝行与放行行。
- 阴性对照:`--no-verify` 造出的违规提交被 `check-range` 抓到(证明 CI 路径与钩子同源)。
实现:POSIX sh(与现有 push-guard 同),不依赖 Node。

### C2 钩子薄包装 + `sync-template.sh`
测试:安装到临时仓后 `git commit` 实际触发(不是直接调库),lead / sync / admin 三种模式各走一次真钩子提交;`prepare-commit-msg` 写出的 trailer 可被 `interpret-trailers --parse` 读回;二次提交不重复 trailer(`--if-exists replace`);admin 提交仍调用 PATH 上的 gitleaks 桩(断言桩被调用)。
`sync-template.sh` 只同步 `hooks/ lib/`(→ `.githooks/`)、`bootstrap.sh` 与模板里的 `README.md .gitleaks.toml .gitleaksignore .gitignore .github/`,**永不碰 `SCAN-LEDGER.md`**(台账是 scan.sh 生成的运行时产物,模板目录里不放它);测试:先在目标写一份非模板内容的台账,同步两次,台账字节不变、其余文件 diff 为空。

### C3 `bootstrap.sh` + 测试
不变量:**仓根必须恰好等于目标路径**。三种情形:(i) 目标是外层 `~/.claude` 仓的普通子目录、自己没有 `.git` —— 这是**预期的初始态**,走 init;(ii) 目标自有 `.git` 目录且 `git -C <target> rev-parse --show-toplevel` 的物理路径 == 目标物理路径 —— 已是记忆仓,只补配置;(iii) 目标是符号链接、或自有的 `.git` 是 gitfile / 指向别的仓 —— **拒**。`--show-toplevel` 返回外层仓根时绝不往外层写任何配置。
顺序:所有预检(git / gh / gitleaks 精确版本、路径不变量、远端 URL)先跑完,任一失败 ⇒ 退出且**零改动**;然后才 `git init -b main`、`git remote add origin https://github.com/xrliAnnie/lead-memory.git`(已存在且 URL 不同 ⇒ 拒)、`core.hooksPath=.githooks`、写 `~/.claude/.gitignore`。
测试(HOME 指向临时目录,fixture 里目标目录**嵌在一个外层 git 仓内**):
- `--init`:目录已有文件 ⇒ 原地 init,文件 sha256 清单前后一致,`HEAD` 指向 `main`、`origin` 为上面 URL、`core.hooksPath=.githooks` 且**外层仓的 config 未被改动**,`$HOME/.claude/.gitignore` 恰好多一行 `agent-memory/`(重复运行不再追加);已是仓(满足不变量)⇒ 只补配置;预检失败 ⇒ 目标与外层仓均零改动。
- `--clone`:先 clone 到临时同级目录 `agent-memory.clone-<run-id>`,成功后才把已有目录改名 `agent-memory.pre-clone-<UTC>` 并把临时目录换到位;clone 失败 ⇒ 临时目录清理、原目录原封不动;**换位失败注入测试**:已改名的原目录必须被复原、临时目录清理、退出非 0;目录不存在 ⇒ 直接换到位;远端 URL 为 https 形式。
- gitleaks 不在 PATH 或版本 ≠ 8.30.1 ⇒ 明确报错退出(fail-closed),不静默装成无扫描钩子。bootstrap 不检查 trufflehog(它只属于 scan.sh)。

### C4 `scan.sh` + 测试 + runbook
`scan.sh` 合同:
- 配置相对自身源码解析(`scripts/lead-memory/repo-template/.gitleaks.toml`),不依赖目标目录里有没有拷贝 ⇒ Discord 规则首扫就生效。
- 预检精确版本(gitleaks 8.30.1 / trufflehog 3.97.2),不等 ⇒ 拒。
- 阳性对照:8 条随机合规样本,**逐条断言「样本 → 预期规则/detector」映射**(不是聚合阈值);任一条未按预期命中 ⇒ exit 1 且不写台账。
- 扫描对象是**不可变快照**,不是活目录。唯一的一段算法 `lead_tree <tree-ish>`(放在 `lib/guard.sh`,scan.sh / C5 断言 / 突变测试 / C6 验收全部调它):
  `git ls-tree -z <tree-ish>` → 只取 `040000 tree` 且名字符合夹名形状的顶层条目 → 按名字排序得到「名字 → 子树 OID」映射 → `git mktree -z` 出一棵**合成根树**,输出它的 OID 与那份映射。
  `scan.sh`:`git add -- <12 夹>` 后 `git write-tree`,对它跑 `lead_tree` 得到 `scanned_tree`(合成根树 OID)与 12 条映射;`git archive <scanned_tree> | tar -x` 物化到报告目录下的私有临时目录,两把工具都扫这份副本;扫完把 `scanned_tree` 与 12 条映射写进台账终扫段,删除副本。Lead 在此期间的新写不进这棵树。
  说明:`scanned_tree` 是合成对象,不一定能从 `IMPORT_SHA` 直接到达;比对永远是「重建后比 OID」,不是「找那个对象」。
- 真扫:`gitleaks dir <snapshot> -c <源码里的 .gitleaks.toml> --gitleaks-ignore-path <记忆仓/.gitleaksignore>`(显式传 ignore 路径,不靠 cwd)+ `trufflehog filesystem <snapshot> --json --no-update --fail-on-scan-errors --no-verification`(不把候选值发往厂商 API;founder 说过内容本身敏感)。
- 终扫判据(每把工具各自定义,不含糊):gitleaks **原始 0 条**(处置过的假阳性靠 `.gitleaksignore`);trufflehog **每条命中都在台账里有处置行**(按指纹 `工具:detector:路径:值哈希前12位` 对应;有命中无处置行 ⇒ 未通过)。真密钥两把都必须脱敏后消失,不允许用处置行「保留」一条真密钥。
- 台账 `SCAN-LEDGER.md`:每条命中一行(指纹 · 处置 · 处置人 · 日期),**不含命中值**(测试断言值字符串不出现);记「首扫」与「终扫」两段,终扫段写树 OID、两工具版本、字节数、阳性对照映射结果。
闭环(README「首搬扫描」节):扫快照 → 人工逐条处置(轮换+脱敏 / gitleaks 假阳性写 `.gitleaksignore` / trufflehog 假阳性与非密钥写台账处置行)→ **重新 add、重新取树、全量重扫** → 直到终扫判据成立 → 抽样复核(12 夹各 ≥3 文件)→ 台账定稿(台账本身是顶层文件,不在被扫的树里,靠 pre-commit 的 gitleaks staged 扫描兜底)。
测试:PATH 假件驱动上述流程(映射断言、fail-on-scan-errors 透传、台账形状、快照物化与清理、`scanned_tree` 记录);**突变测试**:在扫描器遍历之后、提交之前改一个源文件,证明改后的内容不在终扫树里、C5 用 `lead_tree` 重建后的 OID 断言拒绝提交(测的就是生产那段算法,不是代理);**处置测试**(Lead 要求①,变异体阳性对照):每把工具各放一条已处置的假阳性 + 一条**新种的真命中**(随机合规样本,与已处置条目同一文件相邻行),断言:去掉新种那条 ⇒ 终扫判据成立(绿);种上 ⇒ 判据不成立(红)且退出非 0——绿/红两态都要跑到,只跑一态不算判据存在;真 gitleaks 8.30.1 阳性对照在 CI 跑(步骤按版本 + 校验和下载);双真工具的 `scan-real` 套件只在本机跑,登记 manual-only。
⚠️ 工具/口径以 founder 对 ask `2be69119` 的裁定为准(Lead 已回:按此口径,且不加任何开关);若 founder 另裁,只改本 chunk 与台账模板。

### C5 建仓 + 首搬(实施节点执行,按顺序,每步留证据到 `acceptance.md`)
不停 Lead(停 Lead 需要 founder 许可且不在本单范围);用 **git 的不可变树快照**代替停机来保证「扫过的就是提交的」:
1. `gh repo create xrliAnnie/lead-memory --private --description "Lead memory: one repo, one folder per Lead"`(只建远端)。
2. `bootstrap.sh --init`(预检 → init -b main → remote add origin → hooksPath → gitignore)→ `sync-template.sh`(顶层文件与钩子,不含台账)。
3. `scan.sh ~/.claude/agent-memory` → 处置 → 重新取树全量重扫直到终扫判据成立 → 台账定稿(处置人 = 实施 runner,记在台账);记下 `scanned_tree`。
4. 在**一个显式 admin 作用域**里完成 add / commit / push(`env FLYWHEEL_MEMORY_ACTOR=admin sh -c '…'` 或逐条前缀,三条命令都带;变量只挂在 `git add` 上会让后面的 commit/push 落回 lead 模式被拒):`git add -- <12 夹> <顶层文件>`;对 `git write-tree` 的完整暂存树跑 `lead_tree`,断言重建出的合成根树 OID == `scanned_tree` 且 12 条映射逐条相同(不等 ⇒ `git reset`,回第 3 步);`git commit -m "chore: first import of 12 Lead memory folders (FLY-2145)"`(trailer 自动 admin);记 `IMPORT_SHA=$(git rev-parse HEAD)`;`git push -u origin main`。扫描之后到达的 Lead 写入保持未暂存,留给 A2;提交后记录 `git status --porcelain` 原样写进 acceptance.md。
5. GitHub Actions `guard.yml` 对 `IMPORT_SHA` 的结论必须绿(admin 提交出现在 job summary)。
6. **先做 C6 的快照验收**(clone 后 checkout `IMPORT_SHA` 比对),再做 lead 模式冒烟:`env FLYWHEEL_LEAD_ID=flywheel-eng-lead`(commit 与 push 两条都带)在自家夹新建一个哨兵文件 `flywheel-eng-lead/_fly2145-smoke.md` → 提交 → 推 → 记 `SMOKE_SHA` → CI 绿;随后用同一身份删除哨兵再提交推送(清理也是一次合法的自家写)。
7. 首搬提交之后 Lead 新写的内容不在远端,交 A2;acceptance.md 写明。

### C6 验收矩阵(实施节点跑,QA 节点复核;证据文件 `acceptance.md`)

| PRD 验收 | 检查命令 / 证据 | 判据 |
|---|---|---|
| 另一台机器拉下来见 12 夹同内容 | `git clone https://github.com/xrliAnnie/lead-memory.git <tmp>` 后 `git -C <tmp> checkout $IMPORT_SHA`;源仓与 clone 各跑 `git ls-tree -r -z --full-tree $IMPORT_SHA`(路径 + blob OID)逐字节一致;两边各对 `$IMPORT_SHA^{tree}` 跑 `lead_tree`,重建出的合成根树 OID == 台账里的 `scanned_tree`,12 条映射逐条相同;clone 里 12 个夹目录存在且 `git ls-files` 计数与源一致 | 树清单一致、12 夹齐、重建合成根树 == `scanned_tree`。比的是 **`IMPORT_SHA` 那个提交**,不是比较时刻的活树(Lead 不停机,差异按 C5 第 4 步如实列出);真第二台机器由 founder 按 README 步骤拉,本单写明未做 |
| 任一 Lead 读得到别家 | 在 clone 与工作树里 `cat sub-lead/MEMORY.md` 各一次;记忆仓无任何读限制机制 | 能读 |
| 写别家写不进 | **全部在一次性 fresh clone 里做**(`core.hooksPath=.githooks` 指向 clone 自带的钩子,`FLYWHEEL_STATE_DIR` 指向临时目录,做完整个目录删除),不碰活仓:(a) `FLYWHEEL_LEAD_ID=flywheel-eng-lead` 改 `sub-lead/` 一文件后 `git commit` ⇒ rc≠0,stderr 首行 `lead-memory-guard: refusing commit`,临时审计日志 +1;(b) 用 `--no-verify` 造出该违规提交后 `git push` ⇒ pre-push 拒(远端 main 的 sha 前后不变);(c) 对同一提交直接跑 `guard.sh check-range`(与 actor 无关,即 CI 跑的那段)⇒ 拒。另附一行(Lead 要求②,写明比对来源):活仓 `~/.claude/agent-memory` 的 `core.hooksPath` == `.githooks`,且活仓 `.githooks/**` 每个文件的 sha256 == (i) 做否定验收的那个 fresh clone 在 `IMPORT_SHA` 下的 `.githooks/**`,== (ii) flywheel 仓本 PR 头提交里 `scripts/lead-memory/hooks/*` 与 `lib/guard.sh`(测试套件跑的就是这份源码);三份哈希表并排写进 acceptance.md | (a)(b) 是本地阻止;(c) 是 CI 会做的**检测**——CI 只能在推上去之后标红,不能阻止,证据里照实标;活仓零改动 |
| 无权限者打不开 | 两条:带凭据 `gh api repos/xrliAnnie/lead-memory --jq .private` ⇒ `true`;无凭据 `curl -s -o /dev/null -w '%{http_code}' https://github.com/xrliAnnie/lead-memory`(`gh` 会自动带 keyring 凭据,所以匿名测试只能用 curl)⇒ 404 | `true` + 404 |
| 扫描结果逐条有处理记录 | `SCAN-LEDGER.md` 在仓根;每条命中一行有处置人与日期;0 条时有对照与抽样复核清单 | 台账存在且无「待处置」行 |

### C7 文档与收尾
README(合同 + 另一台机器步骤 + A2 合同)· `acceptance.md` · milestone 文件 `engineering/doc/milestones/FLY-2145.md`(ship 时)· 不改 CLAUDE.md 表格。

## 5. 负向护栏清单(设计里显式列出,测试覆盖)

1. `FLYWHEEL_LEAD_ID` 未设 + actor 未设 ⇒ 拒(不猜身份)。
0. 任何模式下扫描与审计都不可关。测的是 CLI 面与行为,不是 grep 子串(trufflehog 本身就要 `--no-update`/`--no-verification`):`scan.sh` / `bootstrap.sh` 的 usage 只列支持的位置参数与模式;传 `--skip` / `--no-scan` 类 argv ⇒ 报「未知参数」退出;设 `SKIP_SCAN=1` 之类环境变量 ⇒ **行为与不设时完全一致**(两把扫描桩的调用参数与结果逐字相同,不是报错——代码里不认识这些名字);bootstrap 永远装钩子;admin 模式提交仍调用 gitleaks 桩(断言桩被调用)。静态检查只限精确的禁用标识符清单。
2. gitleaks 缺失 ⇒ bootstrap 与 pre-commit 都拒(不降级成「无扫描」)。
3. 阳性对照不达标 ⇒ scan.sh 不产出台账。
4. 台账里出现命中值 ⇒ 测试失败。
5. 顶层文件被 lead/sync 模式改动 ⇒ 拒。
6. 删远端分支 / 非快进 ⇒ 一律拒,无 ACK。
8. 根提交无 `--root`、merge 提交、空提交、0 或 2 条 trailer ⇒ 拒(假绿路径逐个有测试)。
9. 未知 `FLYWHEEL_MEMORY_ACTOR` 取值 ⇒ 拒;admin / sync 放行审计行写不进 ⇒ 拒。
11. 从暂存树用 `lead_tree` 重建的合成根树 OID ≠ `scanned_tree`(或 12 条映射任一不同)⇒ 拒绝提交(扫描后被改过的内容进不了首搬)。
12. 验收的否定用例不在活仓里做;活仓在整个验收过程中零改动(除 C5 第 6 步自家哨兵)。
10. bootstrap 任一预检失败 ⇒ 目标与外层 `~/.claude` 仓零改动;把外层仓根当成记忆仓 ⇒ 拒。
7. `sync-template.sh` 非幂等 ⇒ 测试失败。

## 6. 回滚边界

| 时点 | 动作 | 记忆文件 |
|---|---|---|
| 推送前 | 删 `~/.claude/agent-memory/.git`;撤 `~/.claude/.gitignore` 那行 | 零变化 |
| 推送后 | founder 删/归档 GitHub 仓;本机同上 | 零变化 |
| 钩子故障 | `git config --unset core.hooksPath` | 零变化;CI 仍审计 |
flywheel 仓侧:本单只新增文件与 ci.yml 登记,revert 一个 PR 即回滚。

## 7. 诚实边界(照抄进 founder HTML)

- 写权护栏是**事故护栏 + 审计**,不是安全边界:`--no-verify` 与 `FLYWHEEL_MEMORY_ACTOR=admin` 都能绕,绕过会留痕、CI 会标红,但拦不住故意。GitHub 只认一个账号,服务端做不到按 Lead 拒写。
- runner 继承其 Lead 的 `FLYWHEEL_LEAD_ID`,护栏分不出 Lead 与它的 runner。
- 「另一台机器」本单用本机 fresh clone 做等价验证;真机由 founder 拉。
- 扫描只能证明「两把工具当前规则集下 0 条 + 抽样人工看过」,不能证明「里面没有任何敏感内容」(founder 说过内容本身就敏感,所以仓是私有的)。
- 首搬之后到 A2 上线之前,新写的记忆仍只在本机;本单不解决「每天都到远端」。

## 8. 风险

| 风险 | 处理 |
|---|---|
| founder 对扫描工具/口径裁定与提议不同 | 只动 C4;C1–C3 不受影响 |
| 首搬期间某 Lead 正在写文件 | 不停机;扫的是 index 树快照,提交前断言暂存子树 OID == 终扫树 OID,不等就重扫;之后到达的写留给 A2;提交后 `git status` 如实记录 |
| GitHub Actions 对私有仓的免费分钟 | 每次 push 一个几秒的 job,远低于 2000 分钟/月 |
| `gitleaks` 默认规则更新导致 CI 突然红 | CI(校验和下载)与本机(精确版本预检)都 pin 8.30.1;升级走 admin 提交 |
| `ci-structure.test.sh` 钉住的步骤清单没同步 ⇒ Quick Gate 红 | 文件清单已含它;C1 第一个提交就一起改 |
| A2 未按合同提交(多夹一提交) | CI 红 + README 合同;A2 设计引用本文 §5 |

## 9. 完成定义

C1–C4 测试全绿并登记进 ci.yml;C5 首搬推送成功且 CI 绿;C6 五格证据齐;PR 关联 FLY-2145;founder HTML 已发布;A2 合同写在 README。

## 10. 评审记录

- R1(2026-09-03,codex-review-round1.md):CHANGES REQUESTED,9 条。全部接受:B1 bootstrap 仓根不变量 + 显式 init/remote;B2 台账退出模板同步;B3 用清单对账代替停机、验收改比提交快照;H4 `--root`/拒 merge/恰一条 trailer;H5 sync owner 从暂存夹推导、check-range 与 actor 无关、admin 审计 fail-closed、删除 ACK 路径;H6 补 ci-structure 与 guard.yml 合同测试、扫描套件拆 CI/manual-only;H7 scan.sh 闭环协议 + `--no-verification`;M8 验收命令改 `git ls-files` 与 curl/gh 两条;M9 无跳过路径改测 CLI 面。
- R2(2026-09-03,codex-review-round2.md):CHANGES REQUESTED,6 条。全部接受:B1 用 index 树快照替换 manifest.tsv(扫描对象不可变,提交前断言子树 OID);B2 admin/lead 作用域覆盖 add/commit/push 三条命令、记 IMPORT_SHA/SMOKE_SHA、验收用 `git ls-tree` 在 IMPORT_SHA 上比;H3 终扫判据按工具各自定义(gitleaks 原始 0 + 显式 ignore 路径;trufflehog 命中逐条对应台账处置行);H4 否定验收全在一次性 clone + 隔离 STATE_DIR 里做,活冒烟只碰自家哨兵;H5 模板清单删台账、bootstrap.sh 进同步清单、trufflehog 版本只在 scan.sh、仓根不变量三情形措辞、research 旧段标「已取代」;M6 环境变量测行为不变、sync 审计也 fail-closed、换位失败注入测试。
- Lead 对 R2 处置的裁定(ask `98a64e8d`):全部接受;附三条:① H3 处置测试必须是变异体阳性对照(已写入 C4);② H4 活仓钩子哈希要写明比对来源(已写入 C6);③ 若 R3 条数不降或出现新 BLOCKER,先报 Lead,不自行第 4 轮。
- R3(2026-09-03,codex-review-round3.md):CHANGES REQUESTED,1 条 HIGH(无 BLOCKER,9→6→1 收敛):`scanned_tree` 是合成根树,不能与 12 个子树各自相等。接受:定义唯一算法 `lead_tree`(ls-tree 取 12 个夹条目 → mktree 合成根树),scan / C5 断言 / 突变测试 / C6 验收全部用它重建后比 OID 与映射;台账记 12 条映射。
