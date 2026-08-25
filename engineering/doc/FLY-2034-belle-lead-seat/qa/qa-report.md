# FLY-2034 Belle 完整 Lead 席位 — QA 报告(DAG qa 节点)
Issue: FLY-2034 (https://linear.app/geoforge3d/issue/FLY-2034/belle接入-belle-完整-lead-席位自有代码仓产出归档-flywheel-派工席位定时任务-skill-化随后)
日期: 2026-08-25
基于: plan.md、onboarding.md

## 0. 判定

**PASS —— 但只对本单实际交付的范围。**

本 PR 交付的是「让 Belle 能成为完整 Lead」的**工程件**(自有仓 + 席位接入清单 + 一行
运行时 roster 文案 + 两个 fail-closed verifier)。它**没有、也按批准的计划不该**让 Belle
现在就能派工:live cutover 是 founder 维护窗的动作,尚未发生。

⚠️ 任何人都不要把这个 PASS 读成「Belle 现在可以派 runner 了」。截至 2026-08-25 01:0x UTC,
生产 `~/.flywheel/projects.json` 里 Belle 仍是 `companion: true` / `canSpawnRunners: false`,
mtime 停在 2026-08-13,`~/Dev/personal-assistant` 仍不是 git 仓。

## 1. 被测头

| 项 | 值 |
|---|---|
| worktree HEAD(verdict 绑定) | `0f353b628`(= `fcef5079f` + 3 个只改 progress.md 的台账 commit) |
| 实质 diff | `git diff --stat fcef5079f..HEAD` = 仅 `progress.md` 5 insertions/5 deletions |
| PR | #946,OPEN、非 draft |
| 生产运行时 diff 面 | 只有 `packages/teamlead/lead-rules-base/cross-dept-channel-rules.md` 两行文案;其余为 docs / 测试 / CI 接线 / QA verifier(不进生产执行路径) |

## 2. 逐项验收

### ① 仓建好且结构齐 —— PASS

- `gh repo view xrliAnnie/belle-workspace`:存在、**private**、default branch `main`、
  创建于 2026-08-24T23:15:21Z。
- 远端 `main` = `726c5204afc9dca22a8989c01ad0a10b93accd69`,与 CLAUDE.md/onboarding.md 的
  声称**逐字一致**。
- `git ls-files -s` 恰为计划 D1 列出的 16 个路径;`skills` 是 mode `120000`、target
  `.claude/skills`(**相对**),`skills/meal-menu/SKILL.md` 经 symlink 可读。
- 独立 clone 上跑 verifier(正路径)通过:
  `{"ok":true,"mode":"scaffold","conflicts":[".gitignore","CLAUDE.md","README.md"],
  "scaffoldDigest":"c4057974…","snapshotDigest":"30618afc…","agentDigest":"d38725ec…"}`
  —— 冲突面恰为计划断言的三个 root-relative 路径。
- `--runtime-only` 模式同样通过,digest 与 scaffold 模式一致。

### ② 从 Belle 席位真派 generic 工人跑通菜单并归档 —— **未执行(诚实边界,非缺陷)**

结构性阻塞,不是实现瑕疵:该验收按批准的 plan §D4 / onboarding §9 定义为
**cutover 之后**才可能。cutover 是 founder/Belle 侧维护窗动作,本单实现节点被明令
禁止代做。只读取证:

- `~/.flywheel/projects.json` Belle lead 行仍是 `"canSpawnRunners": false, "companion": true,
  "match": {"labels": ["life"]}`,无 `projectRepo`、无 `memoryAllowedUsers`;文件 mtime
  `Aug 13 16:34:42 2026`、mode 600。
- `~/Dev/personal-assistant` 无 `.git`;`.lead/belle-lead/identity.md` mtime `Jun 7 23:02`。

⇒ 席位未翻转 ⇒ Belle 物理上无法派工 ⇒ ② 现在**无法被任何手段验证**。这一格必须由
cutover 后的独立 QA 补,不能靠本单的任何证据推断。

### ③ 接入文档含她侧配置步骤清单 —— PASS(并已实跑其中可实跑的部分)

`onboarding.md` 11 节:admission 门 / 连接目录 / 逐路径 disposition 矩阵 / identity 合并 /
projects.json 候选与三道硬门 / 重启前 live 终验 / manifest+Bridge 收敛 / cutover 验证 /
后续 DAG QA / 对称回滚 / **会过期的结论表**(带 as-of + 重核命令)。

实跑核验(全部只读或在副本上,零 live mutation):

| 清单声称 | 我的独立核验 | 结果 |
|---|---|---|
| §1 LEARN 恰一条 `personal-assistant` label,id=`eb1437bf-…b348d71d8` | 跑了清单里那段 Linear 只读脚本 | ✅ 恰 1 条、id 逐字一致;顺带实测 `life` label 数量 = **0**(印证 founder 改判的前提) |
| §5.1 基线门两条 jq | 对 live 副本逐字跑 | ✅ 双绿 |
| §5.2 candidate 构造 jq | 对 live 副本逐字跑 | ✅ 生成成功 |
| §5.3 门 1 built validator | `node packages/teamlead/dist/bin/validate-projects.js` | ✅ `OK (v1)` |
| §5.3 门 2 delta verifier | 见 §3 | ✅ 且 5 项 delta 与 `diff -u` 完全吻合 |
| §4 identity 的「两处 exact replacement」 | 把 addendum 的 before 文本与 **live** `identity.md` 逐字比对 | ✅ 两处都精确命中 —— 这步 cutover 当天可执行,不会因文案漂移卡住 |
| §7 `flywheel-daemon.sh install personal-assistant-belle-lead` 的 label 形态 | `ls ~/Library/LaunchAgents` | ✅ 存在 `com.flywheel.lead.personal-assistant-belle-lead.plist` |
| §5/§7 引用的四个脚本/产物存在 | `test -f` | ✅ 四个全在 |

## 3. verifier 不是空过绿 —— 我自己出的一轮突变(不复用它内置的负向对照)

**workspace verifier —— 8/8 全按预期变红,且红在**指定的**那一条断言上**:

| 突变 | 期望红点 | 实测 |
|---|---|---|
| 删 `skills` symlink | missing top-level skills | ✅ 逐字命中 |
| `skills` 改成绝对 symlink | must be relative | ✅ |
| README 注入 `ghp_…` | contains GitHub token | ✅ |
| MEMORY 注入 `/Users/xiaorongli/…` | machine-specific user path | ✅ |
| config labels 改回 `life` | personal-assistant label | ✅ |
| ic-roster 指向不存在的 executor | roster/executor 解析失败 | ✅ `ic-roster.generic file does not exist` |
| CLAUDE.md 破坏折入前缀 | complete live baseline prefix | ✅ |
| adoption 加一个 menu | belle-lead 只能 adopt generic | ✅ |

**projects cutover verifier —— 7/7 全拒**,含计划专门设防的两条:

- `department` 被 label 改名带漂成 `personal-assistant` → 拒(这正是 plan 要钉的联合不变量);
- candidate mode 0644 → 拒(`must be 0600 before rename`);
- 另 4 项(动别的项目、留 companion、改错 repo slug、零 delta)全拒;
- 给别的 Lead 开 `canSpawnRunners` 时**由上游真实 validator** 先拒(比本 verifier 更早)。

**flywheel 侧两个新守卫**:

- `lead-rules-bundle.test.ts` 21/21 通过;把 roster 两行改回旧文案 → **1 failed**,红在
  `advertises Belle as a runner-owning life department Lead`。非空过绿。
- `fly2034-onboarding-credential-gate.test.sh` 通过;把 gate 里的 `git grep --cached` 改成
  扫工作区 → **FAIL: must reject a secret present only in the Git index**。非空过绿。
- `ci-structure.test.sh` 通过(新 CI step 已登记进 script-tests-2 shard 的 exact inventory)。

## 4. 529 QA Room 真机 N-to-N(Discord-capable → 强制项,已执行)

本 PR 改的 `cross-dept-channel-rules.md` 就是 **#leads-roundtable 参与者名册**本身,属
Discord-capable,故按标准跑真机。

**拓扑**:单 Bridge + **两个真 Lead**(slot 1 `flywheel-test-1` + `--extra-lead 4:life`
`flywheel-test-4`),隔离槽 `/tmp/flywheel-test-slot-1`,生产零触碰。

**被测头证明**:slot Bridge `/health` 的 `buildSha`/`artifactBuildSha` =
`0f353b628c064f184af914945ea917e72899eee7` = 我的 worktree HEAD;
`bridge.log` 的 `[bridge-boot] running HEAD=0f353b628…`。两个 Lead 的 launchd plist
`ProgramArguments[0]` 都指向 `/Users/xiaorongli/Dev/flywheel-FLY-2034/scripts/flywheel-lead-wrapper-v2.sh`。

**面 A —— 真 Lead 实际物化的 rules bundle(不是「文件在仓里」)**:

| bundle | 来源 | 新 Belle dept-Lead 行 | 旧 companion 句 |
|---|---|---|---|
| `test-slot-1-flywheel-test-1.…md`(109 KiB) | 本 PR head | ✅ 在 | ✅ 已消失 |
| `test-slot-1-flywheel-test-4.…md`(217 KiB) | 本 PR head | ✅ 在 | ✅ 已消失 |
| `test-slot-1-flywheel-test-2.…md`(189 KiB) | **并发的另一 QA 会话**(FLY-2017 worktree,不含本改动) | ❌ 不在 | ❌ 仍在 |
| `test-slot-1-flywheel-test-3.…md`(221 KiB) | 同上 | ❌ 不在 | ❌ 仍在 |

后两行是**天然的野生对照组**:同一台机器、同一时刻、同一套 bundle 机制,只有代码版本
不同 —— 排除了「bundle 里本来就有这句」的解释。(我只**读**了它们的 receipt,没碰那两个进程。)

**面 B —— 真 Discord 往返,founder 本人会话(Claude-in-Chrome)**:

在两个隔离频道各发一次同题 probe,要求 Lead **逐字引用**它当前加载的规则。

- Lead 1(`#cos-test`,qa-lead-A,21:05):
  > (1) `| **Belle** | Life Assistant (life dept Lead) | personal-assistant | …`
  > (2) 「按当前规则只有 **Mufasa** 一个」+ 逐字引用
  > `**Mufasa** (FLY-231) is a **companion** Lead — a warm personal agent, not an engineering Lead.`
- Lead 2(`#finance-lead-test`,21:06):同样两条逐字引用,并明确收口
  > 「roster 中只有 Mufasa 被标为 companion Lead;Belle 在 roster 里列为 life dept Lead
  > (personal-assistant 项目),不是 companion。」

⇒ 改动确实到达了真 Lead 的 prompt 并改变了它的实际回答,不只是仓里的字节。

**收尾**:`test-teardown.sh 1` 干净退出;slot 2/3(另一会话的 campaign)与其 Bridge PID
34930 完好;`launchctl` 中 `com.flywheel.qa.lead.slot-1.*` 归零;生产 Bridge
`/health ok, buildSha 399edd8e…, sessions_count 16` 正常。

## 5. 发现(均不改判 PASS)

**F1 [MEDIUM,非本 PR 所有 —— 建议单开] 529 房 `--alerts` 与 launchd-v2 Lead 载体不兼容。**
`test-deploy.sh 1 --extra-lead 4:life --alerts` 必失败:
`[wrapper-v2] ERROR: identity_launch_env_conflict: FLYWHEEL_PROJECTS_FILE expected
'/tmp/flywheel-test-slot-1/q/1/projects.json', got '/tmp/flywheel-test-slot-1/flywheel-projects.json'`
→ `[qa-launchd] ERROR: topology verification failed` → deploy 中止。
**机制**:`test-deploy.sh:899` 在 alerts 分支无条件往 `LEAD_EXTRA_ENV` 塞
`FLYWHEEL_PROJECTS_FILE=${SLOT_DIR}/flywheel-projects.json`,而 launchd-v2 路径
(`test-deploy.sh:1382`)自己写 canonical 的 `q/<slot>/projects.json`;两者相撞被
FLY-1726 的 identity fence 挡下。
**控制变量已做**:同参数去掉 `--alerts` 立即成功(deploy3 21:02 Lead ready)。
**归因**:本 PR 对 `FLYWHEEL_PROJECTS_FILE` / qa-launchd / wrapper-v2 的改动量 = **0 处**
(grep 计数 0);且我落后 main 的 2 个 commit 也不碰这条链。属既有缺陷,与 FLY-1608 同类。

**F2 [LOW] `fly2034-onboarding-credential-gate.test.sh` 证不到它自己 PASS 行里的「binary」那半。**
把 gate 的 `git grep --cached -a` 去掉 `-a` 后,该测试**仍然通过** —— 因为 `git grep`
对二进制 blob 命中时本来就以 rc=0 报 "Binary file matches"。所以 `-a` 在这里不是
load-bearing,测试无法区分有无。**没有防护缺口**(去掉 `-a` 后 binary 密钥照样被拦住,
我实测过);只是那句 PASS 文案 `scans staged text/binary blobs` 比测试能证明的强一点。

**F3 [chore,merge 前必处理] PR #946 `mergeable=CONFLICTING`。**唯一冲突文件是
`CLAUDE.md`,且是里程碑表最上面一行的例行「两边各加一行」冲突(main 侧新增
FLY-2014/FLY-2018)。加性冲突,两边都保即可。

**F4 [流程,已在清单里写明,此处只做提醒] `onboarding.md` §1 admission 门要求本 PR 的
**merge SHA** 先随班车部署到生产**才能开维护窗**,并给了
`merge-base --is-ancestor` + 在 deployed blob 里 grep roster 两行的核验命令。
merge ≠ 可以开窗,中间还隔一趟 updater。

**F5 [MEDIUM,基础设施,非本 PR 所有 —— 建议单开] 两个并发 QA runner 会互相覆盖 ship report,
且覆盖后 `publish-report` 会把**别人的报告**发布到**你的**链接下。**

发生经过(有账本):
- 我的报告写在角色说明书给的规范路径 `/tmp/ship-report.html`(432,016 bytes,`<title>FLY-2034 …`)。
- 同一时刻另一个 QA runner(FLY-2017)也按同一份说明书写同一个路径,把我的文件覆盖成它的
  (163,208 bytes,`<title>FLY-2017 …`)。
- 我随后 `publish-report --html /tmp/ship-report.html` → 返回我自己的
  `reportId=d04806d2…`,但那个 URL 打开是 **FLY-2017 的报告**。
- 铁证在 `~/.flywheel/reports/registry.json`:我的 token 记的 `bytes` = **163435**,
  与 FLY-2017 那条(04:16:18Z)**逐字节相同**,而我的本地文件是 432,016 bytes;两次发布
  相隔 53 秒。

**为什么这条危险**:founder 点开 FLY-2034 的 ship 链接,看到的是 FLY-2017 的证据,
却以为在审 FLY-2034 —— 这会导致**照着错的证据批准**。它不报错、不告警,两边的
`publish-report` 都返回成功。

**根因**:角色说明书把 `/tmp/ship-report.html` 定成规范路径,而它是全机共享可写路径,
多 QA runner 并发时必然互撞。**修法建议**:路径加 exec-id 或 issue 前缀(我这次的绕法是
`/tmp/fly2034qa/ship-report-FLY-2034-520fbc15.html`),并在 publish 后回读 hosted title
做自证。

**本单的处置**:我提交进仓的副本(`qa/ship-report.html`)是被覆盖前的正确版本,已用它
从唯一路径重新发布并**回读 hosted `<title>` 确认为 FLY-2034**、432,243 bytes。
**作废链接**:`https://fw-reports-a53de2.vercel.app/r/d04806d24b20d4f0897229cc759a9bf8/`
(实际内容是 FLY-2017,任何人都不要拿它当 FLY-2034 的证据)。
**有效链接**:`https://fw-reports-a53de2.vercel.app/r/381dbe9aebcd83dc7283d806790abcf5/`

## 6. 我没测的(honest boundary)

| 没测的 | 为什么 | 风险 | 什么时候能测 |
|---|---|---|---|
| 验收② 全链(Belle 真派工 → generic runner → 菜单 → archive → PR → merge 后 `git show` 验档) | cutover 未发生,席位仍 companion/spawn=false;实现节点被明令禁止代做 | **中**:D4 那 7 条证据链(派工归属、snapshot 形态、幂等重放、worktree 落点、skill 真调用、双归档、台账可 grep)整条未经真机;`life-executor` 只被静态 materialize 过,没被真 runner 跑过 | cutover 维护窗后的独立 QA 节点 |
| cutover 步骤本身(§2 连接目录 / §3 落格 / §5 原子 mv / §6 live 终验 / §7 重启 / §10 回滚) | 全是 live mutation,founder-gated | 中:清单的**命令**我逐条跑过(在副本上)且 identity 锚点逐字对得上,但**整条序列**没连着走过一遍 | 维护窗当场 |
| roundtable 共享频道本身的 N-to-N | `--mode roundtable` 拒绝 `--extra-lead`;而 roundtable 配置的 memberSlot=2 当时被并发 QA 会话占用。我改用「单 Bridge + 2 真 Lead」(角色定义认可的 N-to-N 拓扑),但**没有**在真 `#test-leads-roundtable` 里做双 Lead 交叉发言 | **低**:本改动不碰 mention-gate / 路由 / channel id / 任何代码路径,只改 Lead 读到的名册文字;而「名册文字是否到达并改变真 Lead 回答」已由面 A+面 B 双证 | 需要时:等 slot 2 空出来,`--mode roundtable` 起 slot 1+2 |
| 完整 `pnpm test:packages:run` 全包 | 本单 diff 的可执行面极窄(1 个测试文件 + 1 个 shell 测试 + 1 个 CI step) | 低 | PR CI 为准 |

另:全仓 `pnpm lint` = **0 error / 8 warning**(CLAUDE.md 里程碑写的是 7 —— 差的那条在
本 PR 未触碰的文件里,属 main 基线漂移,不是本单引入);`pnpm -r build` rc=0、零 TS error。

## 7. 结论

PASS。工程件本身经得起推敲:两个 verifier 都不是空过绿(我自己出的 15 条突变全按指定
断言变红),接入清单的关键命令实跑可用、identity 锚点逐字对得上,唯一的生产运行时改动
经真机 529 双 Lead + 真 Discord 往返证明确实生效、且有并发会话提供的天然对照组。

剩下的真正风险不在代码里,在**还没发生的那次 cutover** —— 验收②整条证据链一格未验。
merge 这个 PR 只是把维护窗的前置条件补齐,不等于 Belle 能派工了。

---

# Attempt 2(rebase 后重验)—— 2026-08-25

## A2.0 判定

**PASS。** attempt 1 的 PASS 因缺 CI 硬门被 Lead 判定覆盖不全并打回;那一格现在补上了,
且是**真绿**,不是「测不了」。

限定不变:**这个 PASS 仍不等于 Belle 现在能派活。** 生产席位逐字未动(见 A2.5)。

## A2.1 被测头与 CI(本次新增的那一格)

| 项 | 值 |
|---|---|
| head | `02594dcc3b1a66cd72e841b60513df71d4003da2`(worktree = PR #946 head,工作区干净) |
| PR 状态 | **CLEAN**(attempt 1 时是 DIRTY) |
| CLAUDE.md 冲突 | **加性**解决:FLY-2034 / FLY-2014 / FLY-2018 三行都在,无取舍 |
| 分支对 main 贡献面 | 仍是原来那 6 个文件,未多未少 |

**CI:run 32812985891,`completed/success`。** 我按逐 job 三件套判,不看整体状态:

- 11 个 job **全部 success**,`skipped` 0 个(重格子没被 classifier 跳过);
- **starved(steps==0 且 runner_name=="")= 0**;
- 每个 job 都有真执行器名(1000054262–271、1000054295),步数正常(5/19/64/21/34/15×5);
- 聚合门 `CI OK` = **3 steps / runner="GitHub Actions 1000054295" / success**,
  与已知健康阳性对照(03:25 那场的 3 steps + 真 runner + success)形态一致。

⇒ 落在三分法的**第一类(真绿)**。第三类(拿不到执行器)的判据本次未被触发,仍保留。

## A2.2 rebase 是否动了我验过的东西 —— 逐文件字节核对

对 7 个文件取 **commit 内容**(不是工作区,教训见 A2.7)做 sha256:
`cross-dept-channel-rules.md`、`lead-rules-bundle.test.ts`、
`fly2034-onboarding-credential-gate.test.sh`、`ci-structure.test.sh`、
`verify-belle-workspace.ts`、`verify-belle-projects-cutover.ts`、`onboarding.md`
—— **7/7 与 attempt 1 的 head 逐字节 IDENTICAL**。

`department=life` 联合不变量在新 head 上**完好**(4 处引用:baseline 断言 / expected /
错误文案 / receipt),即 attempt 1 我 P-3 突变验过的那条没有在 rebase 中丢失。

## A2.3 重跑(不是沿用)—— 因为 rebase 带进了 main 的 59 个文件,verifier 的真实 import 变了

| 项 | 结果 |
|---|---|
| workspace verifier 正路径(scaffold + runtime-only) | 绿,且 **三个 digest 与 attempt 1 逐字节相同**(`c4057974…` / `30618afc…` / `d38725ec…`)—— 真实 `tpl_generic_menu` snapshot 物化未被 main 变更扰动 |
| 我自出的 8 条 workspace 突变 | **8/8 变红且红在指定断言**(删 symlink / 绝对 symlink / GitHub token / 机器路径 / label 改回 life / roster 指向不存在 executor / 破坏折入前缀 / adoption 多 menu) |
| 我自出的 6 条 projects 突变 | **6/6 全拒**(改别的项目 / 留 companion / department 漂成 personal-assistant / 错 repo slug / mode 0644 / 零 delta) |
| built `validate-projects.js` | `OK (v1)` |
| delta verifier 正路径 | 绿,5 项 delta 精确 |
| `lead-rules-bundle.test.ts` | **21/21**;把名册两行改回旧文案 → **精确 1 failed**,红在 `advertises Belle as a runner-owning life department Lead` |
| `fly2034-onboarding-credential-gate.test.sh` | PASS;把 gate 改成扫工作区 → 立即 **FAIL** |
| `ci-structure.test.sh` | PASS |
| `pnpm lint` | **0 error** / 8 warning(均在本 PR 未触碰文件) |
| `pnpm -r build` | rc=0,零 TS error |

## A2.4 529 真机证据:**沿用**,并说明为何仍成立(不冒充重跑)

我**没有**在新 head 上重开 529 房。理由逐条可证伪:

1. 产品面唯一改动文件 `cross-dept-channel-rules.md` 在新旧 head **逐字节相同**(A2.2);
2. rules 组装链路 **未被 rebase 触碰** ——
   `git diff --name-only <old>..<new> -- packages/teamlead/scripts/lead-rules-bundle.sh
   packages/teamlead/scripts/claude-lead.sh packages/teamlead/lead-rules-base/` **为空**;
3. 我在新 head 上**真跑了**组装器本身(`compute_lead_rule_bundle`,dept/cos/companion
   三个角色):新 Belle dept-Lead 行 **3/3 存在**,旧 companion 句 **3/3 已消失**。

⇒ 529 那一跑测的是「这段文字会不会到达真 Lead 并改变它的回答」;而该行为的**输入**
(组装后的 bundle 文本)已被证明逐字节不变,重开房只会重测同一件事。

**沿用的具体内容**(attempt 1,head `0f353b628`):单 Bridge + 两个真 Lead(slot 1 +
`--extra-lead 4:life`);两 Lead 落盘 bundle 均含新行;经 founder 本人浏览器会话在两个
隔离频道各发同题 probe,两 Lead 都逐字引用新名册行并答「只剩 Mufasa 是 companion」;
同机同刻跑旧代码的另两个 Lead bundle 仍是旧行(野生对照组)。

## A2.5 生产侧仍逐字未动(重新核对,不是沿用旧观测)

- `projects.json`:belle-lead 仍 `companion=True / canSpawnRunners=False /
  labels=['life'] / department=life / projectRepo=None`;mtime **Aug 13 16:34:42**、mode 600;
- `~/Dev/personal-assistant` **仍不是 git 仓**;`identity.md` mtime 仍 **Jun 7 23:02**;
- cutover 清单 §4 的两处 exact replacement 锚点**仍与线上 identity.md 逐字命中**;
- LEARN:`personal-assistant` 恰 1 条、id 仍 `eb1437bf-…b348d71d8`;`life` label 仍 **0 条**;
- `belle-workspace` 远端 main 仍 `726c5204afc9dca22a8989c01ad0a10b93accd69`。

## A2.6 未测的(与 attempt 1 相同,PASS 不覆盖)

**验收②整条链**(Belle 本人真派 generic 工人 → 菜单 → `archive/meal-menu/` +
`archive/weekly/` → PR → merge commit 上验档)仍**一格未验**,且在 founder cutover 之前
无法验 —— 席位没翻转,她物理上发不出派工。`life-executor` 至今只被静态 materialize 过,
没被真 runner 执行过。这条必须由 cutover 后的独立 QA 补,不能拿本单任何证据推断。

接入清单的**完整执行序列**仍未连着走过一遍(全是 founder-gated live mutation)。
共享 `#leads-roundtable` 的双 Lead 交叉发言仍未做(理由同 attempt 1)。

## A2.7 attempt 1 的两条错误,在此归档

1. **漏了 CI 硬门**:我把 `mergeable=CONFLICTING` 记成 merge 前杂事(F3),没往下问
   「那 CI 跑没跑」。实况是整条分支 `total_count=0`,因为 PR 为 DIRTY 时 GitHub 算不出
   merge commit、`pull_request` 工作流根本不排队。**零 CI 证据的 head 不该判 PASS。**
2. **把饿死的聚合 job 误报成真实测试失败**:03:55 那场 11 个 job 里 10 个全绿,
   唯一 failure 是拿不到执行器的 `CI OK`;我却报成「真实测试失败」。根因是我用
   **run 级总步数**去判**单 job** 的饿死 —— 聚合指标掩盖单元信号。
   正确判据是逐 job `steps` + `runner_name`。

另有一次**险些**误报:rebase 中途我在共享 worktree 里看到 verifier「丢了 department
不变量」,差点报回归。真相是 rebase 停在 step 17/29,而停的那一步恰好就是引入该不变量的
commit。我的探针 `ls -d .git/rebase-merge` 在 worktree 里恒假(worktree 的 `.git` 是文件),
所以「文件变了 + 没在 rebase」被读成回归。**共享 worktree 下判内容必须
`git show <sha>:<path>`,不能读工作区。**

## A2.8 结论

CI 硬门已补齐且为真绿;rebase 未扰动任何已验内容(7/7 字节相同、digest 相同、
14 条突变全部重新变红);两个新守卫的非空过绿性在新 head 上重新证过。
剩余风险仍集中在**还没发生的那次 cutover**,验收②整条证据链一格未验。

---

# Attempt 3(第二次 rebase 后重验）—— 2026-08-25

## A3.0 判定

**PASS。**

限定不变，而且必须写在第一行：**这个 PASS 不等于 Belle 现在能派活。**
本 PR 交付的是「让 Belle 能成为完整 Lead」的工程件；席位翻转（cutover）是 founder
维护窗的动作，**至今未发生**（A3.8 有当刻只读取证）。验收②整条链仍**一格未验**。

与 attempt 2 的差别：分支被**第二次 rebase**（并进了 main 的 355 个文件、50,826 行），
所以 attempt 2 的证据不能直接沿用 —— 本轮**全部重跑**，包含**重开 529 真机房**
（attempt 2 是沿用 attempt 1 的 529 证据，本轮没有沿用）。

## A3.1 被测头（按 `git ls-remote` 申报，不用 `rev-parse HEAD`）

| 项 | 值 |
|---|---|
| PR | #946，OPEN、**非 draft** |
| `git ls-remote origin refs/heads/flywheel-FLY-2034` | `2b70b4fdabd08798fdbbd7df7bb5205f884d486c` |
| `gh pr view 946 --json headRefOid` | 同上，逐字一致 |
| mergeable / mergeStateStatus | **MERGEABLE / CLEAN**（attempt 1 曾是 CONFLICTING） |
| merge-base(origin/main, HEAD) | `6978e2ee9806c2649d57e5c088b09c1216eb178e` |
| 分支自有 diff | **26 个文件 / +2,656 / −6** |
| 生产运行时面 | 只有 `packages/teamlead/lead-rules-base/cross-dept-channel-rules.md`（10 行）；其余是 docs / QA verifier / 1 个 vitest / 1 个 shell test / 1 个 CI step |

> 边界披露：529 真机跑在 worktree HEAD `617bd72041c524e95d0973643a33fc6b4ebd455b`
> （= `2b70b4fda` + 1 个只改 `progress.md` 的台账 commit）。两者对本 PR 的**产品面
> 零差异**（`git diff 2b70b4fda..617bd7204 --stat` 只有 `progress.md`）。最终 verdict
> 绑定的是 push 后的 head（见 A3.10）。

## A3.2 exact-head CI —— 逐 job 三件套判，不看整体状态

run **32872815431**（`pull_request`，`completed/success`），head_sha 精确等于 `2b70b4fda`；
该 head 的 run 总数 = 1，没有旧轮混淆。

| 判据 | 结果 |
|---|---|
| job 数 | 11，**全部 `completed/success`** |
| `skipped` | **0**（重格子没被 classifier 跳掉） |
| starved（`steps==0` 且 `runner_name==""`） | **0** |
| 每 job 真执行器 | 全部有名（`GitHub Actions 1000054575–584`、`…605`） |
| 步数 | 19 / 5 / 34 / 65 / 15×5 / 21 / 3 |
| 聚合门 `CI OK` | **3 steps / runner `GitHub Actions 1000054605` / success** |

**并且我没有停在「job 绿」这一层** —— 本 PR 新增的那一步在 CI 里**真的跑了**：
`Script Tests 2/2` 的 **step 13 `Test — FLY-2034 Belle staged credential gate`
= `completed/success`**。

## A3.3 rebase 有没有动我验过的东西 —— 逐文件字节核对（取 commit 内容，不读工作区）

对 attempt 2 已验头 `02594dcc3` 与本头逐文件 `git show <sha>:<path> | sha256`：

| 文件 | 结果 |
|---|---|
| `lead-rules-base/cross-dept-channel-rules.md` | IDENTICAL |
| `src/__tests__/lead-rules-bundle.test.ts` | IDENTICAL |
| `scripts/__tests__/fly2034-onboarding-credential-gate.test.sh` | IDENTICAL |
| `qa/verify-belle-workspace.ts` | IDENTICAL |
| `qa/verify-belle-projects-cutover.ts` | IDENTICAL |
| `onboarding.md` | IDENTICAL |
| `scripts/__tests__/ci-structure.test.sh` | **DIFFERENT** |

第 7 个的 DIFFERENT 我追到底了，不是回归：main 在这期间往 `script-tests-2` 加了
FLY-2026 / FLY-2022 两步，所以那个文件的 main 基线变了。**FLY-2034 自己对它的 delta
仍精确是 +1 行**（`"Test — FLY-2034 Belle staged credential gate"` 插进 exact
inventory），`ci.yml` 也仍是「注释里加 `2034=1` + 新增一步」的纯加性。

## A3.4 两个 verifier 的正路径 —— 重跑，不沿用

- `belle-workspace` 远端 `main` 仍是 `726c5204afc9dca22a8989c01ad0a10b93accd69`；
  `git ls-files -s` 恰 16 个路径，`skills` 是 mode `120000`、target `.claude/skills`（相对）。
- **scaffold 模式**：绿，冲突面恰为 `.gitignore` / `CLAUDE.md` / `README.md` 三个。
- **runtime-only 模式**：绿。
- 三个 digest 与 attempt 1、attempt 2 **逐字节相同**：
  `scaffoldDigest=c4057974…c69c`、`snapshotDigest=30618afc…1f69`、`agentDigest=d38725ec…e3a4`。
  ⇒ main 的 355 文件 rebase **没有**扰动真实 `tpl_generic_menu` v2 snapshot 的物化结果。
- 生产 `projects.json` 副本上跑 runbook §5.1 两条基线 jq：**双 true**；
  §5.2 candidate 构造 jq：成功；built `validate-projects.js`：**`OK (v1)`**；
  delta verifier 正路径：绿，5 项 delta 与 `diff -u` 逐项吻合
  （`+projectRepo` / `+memoryAllowedUsers` / `−companion` / `canSpawnRunners false→true` /
  `match.labels life→personal-assistant`，`department` 保持 `life`）。

## A3.5 它们不是空过绿 —— 我自己出的 15 条突变（不复用 verifier 内置的负向对照）

**workspace verifier 8/8 变红，且红在我指定的那一条断言上：**

| 突变 | 实测红点（逐字） |
|---|---|
| 删 `skills` symlink | `missing top-level skills browse path` |
| `skills` 改绝对 symlink | `top-level skills symlink must be relative` |
| README 注入 `ghp_…` | `README.md contains GitHub token` |
| MEMORY 注入 `/Users/xiaorongli/…` | `MEMORY.md contains machine-specific user path` |
| config labels 改回 `life` | `life agent must match the Founder-approved personal-assistant label` |
| ic-roster 指不存在的 executor | `ic-roster.generic file does not exist` |
| 破坏 CLAUDE.md 折入前缀 | `CLAUDE.md does not preserve the complete live baseline as a prefix` |
| adoption 多 adopt 一个**合法** menu（`code`） | `belle-lead must adopt only the generic menu` |

（另有一条对照：adopt 一个**非法** menu 名会被更上游的真实 validator 先拒
—— `adoption.belle-lead[1] must be one of: code, simple_code, prd, design, prototype, generic`。）

**projects cutover verifier 7/7 全拒：**

| 突变 | 结果 |
|---|---|
| 动别的项目（`memoryAllowedUsers`） | 拒 |
| 保留 `companion: true` | 拒 |
| `department` 随 label 漂成 `personal-assistant` | 拒（这正是 plan 要钉的联合不变量） |
| 错 repo slug（`belle-workspace-2`） | 拒 |
| 零 delta | 拒 |
| candidate mode 0644 | 拒，且是**另一条**消息：`candidate projects.json mode must be 0600 before rename` |
| 给别的 companion Lead（`mufasa-lead`）开 `canSpawnRunners` | 由**上游真实 validator**先拒（`backend "codex-app-server" requires canSpawnRunners: false …`），built `validate-projects.js` 同样 `INVALID` |

**flywheel 侧两个新守卫：**

- `lead-rules-bundle.test.ts` **21/21 通过**；把名册两行改回旧文案 → **精确 1 failed**，
  红在 `advertises Belle as a runner-owning life department Lead`。
- `fly2034-onboarding-credential-gate.test.sh` 通过。它从 `onboarding.md` 里**抽取**
  runbook 的真函数来测，所以突变必须打在 runbook 上：
  - `git grep --cached` → `git grep`（index 改成工作区）：**FAIL**（`must reject a secret present only in the Git index`）；
  - 删掉正则里的 `gh[pousr]_` 分支：**FAIL**；
  - 删掉 `-a`：**仍然 PASS** ⇒ 见 F2。
- `ci-structure.test.sh` 通过。

## A3.6 真实 bundle 组装器（不是「文件在仓里」）

在本头上真跑 `compute_lead_rule_bundle`，三个角色：

| role | 组装文件数 | 新 Belle dept-Lead 行 | 旧 companion 句 | 新 Mufasa-only 句 |
|---|---|---|---|---|
| dept | 13 | 1 | **0** | 1 |
| cos | 5 | 1 | **0** | 1 |
| companion | 3 | 1 | **0** | 1 |

这一步这轮**必须做**：main 在 `02594dcc3..HEAD` 之间改了 `cos-lead-rules.md`、
`department-lead-rules.md`、`runner-messaging-rules.md`、`runner-patrol-rules.md`
四个同目录文件 —— 即**组装出来的 bundle 文本已经变了**。attempt 2 沿用 529 的理由
（「组装链未被触碰」）在本轮**不再成立**，所以我重开了房（A3.7）。

## A3.7 529 QA Room 真机 N-to-N —— **本轮重跑，未沿用**

改的就是 #leads-roundtable 名册本身 ⇒ Discord-capable ⇒ 强制项。

**拓扑**：单 Bridge + **两个真 Lead**（slot 1 `flywheel-test-1` + `--extra-lead 4:life`
`flywheel-test-4`），隔离槽 `/tmp/flywheel-test-slot-1`，port 19871。
开跑前确认 4 个 slot 全空（无并发 QA 会话）。

**被测头证明**：slot Bridge `/health` 的 `buildSha` = `artifactBuildSha` =
`617bd72041c524e95d0973643a33fc6b4ebd455b` = 我的 worktree HEAD；
`bridge.log` 首行 `[bridge-boot] running HEAD=617bd7204…`。
两个 Lead 的 launchd plist `ProgramArguments[0]` 都是
`/Users/xiaorongli/Dev/flywheel-FLY-2034/scripts/flywheel-lead-wrapper-v2.sh`。

**面 A —— 真 Lead 实际物化的 bundle**（`~/.flywheel/lead-rules-bundles/`，读的是本轮新写的文件）：

| bundle | 字节 | 新 roster 行 | 旧 roster 行 | 旧 companion 句 | 新 Mufasa-only 句 |
|---|---|---|---|---|---|
| `test-slot-1-flywheel-test-1.1545-lstart-10c0042580e943b2.md` | 110,223 | 1 | 0 | 0 | 1 |
| `test-slot-1-flywheel-test-4.15718-lstart-70727dcd8319d868.md` | 219,370 | 1 | 0 | 0 | 1 |

**野生对照组**（同一台机、同一目录、同一套 bundle 机制，只有代码版本不同 —— 生产 Lead 跑的是 main）：

| 生产 bundle | 新 roster 行 | 旧 roster 行 |
|---|---|---|
| `tidal-echo-tidal-echo-content-lead.…md` | **0** | **1** |
| `tidal-echo-sub-lead.…md` | **0** | **1** |
| `joycon-typeless-joycon-lead.…md` | **0** | **1** |

⇒ 排除了「bundle 里本来就有这句」的解释。（这三个只**读**，没碰那些进程。）

**面 B —— 真 Discord 往返，founder 本人登录会话（Claude-in-Chrome）**：
在两个隔离频道各发一次同题 probe，要求 Lead 逐字引用它**当前加载**的规则。

- Lead 1（`#cos-test`，`qa-lead-A`，2026-08-25 10:09 PT）：
  > (1) `| **Belle** | Life Assistant (life dept Lead) | personal-assistant | 1509701064935477318 | @Belle |`
  > (2)「只有 **Mufasa** 一个」+ 逐字引用 `**Mufasa** (FLY-231) is a **companion** Lead — a warm personal agent, not an engineering Lead. …`
  > 并自己收口：「(Belle 登记为 life dept Lead，规则里未标 companion。)」
- Lead 2（`#finance-lead-test`，`HoneyLemon-QA`，10:10 PT）：同样两条逐字引用，
  并收口「cross-dept channel rules 里只有 Mufasa 被这样标注为 companion Lead」。

截图存档：`qa/evidence/a3-529-lead1-cos-test.jpg`、`qa/evidence/a3-529-lead2-finance-lead-test.jpg`。

**收尾（生产零污染，逐项核过）**：`test-teardown.sh 1` 干净退出；
`launchctl` 中 `com.flywheel.qa.lead*` **归零**；`/tmp/flywheel-test-slot-*` **不存在**；
生产 Bridge teardown 前后都是 `ok=true, buildSha=5a8fe51bf…, sessions_count=6`；
生产 `~/.flywheel/projects.json` mtime 仍 `Aug 13 16:34:42 2026`、9157 bytes、mode 600。
teardown 日志显示它**主动跳过**了 9 个 foreign owner 的 cmux session（含另外几个在跑的 runner）。

## A3.8 生产侧仍逐字未动（当刻重新观测，不是沿用）

- `projects.json` 的 belle-lead 行：`companion=true` / `canSpawnRunners=false` /
  `department=life` / `match.labels=["life"]`；project 的 `projectRepo=null`、
  `memoryAllowedUsers=null`；文件 mtime **Aug 13 16:34:42 2026**、mode 600。
- `~/Dev/personal-assistant` **仍不是 git 仓**；`identity.md` mtime 仍 **Jun 7 23:02**。
- runbook §4 的两处 exact replacement 锚点：把 addendum 的 4 个 fenced block 与 **live**
  `identity.md` 逐字比对 —— **两个 "before" 块 present=True，两个 "after" 块 present=False**。
  这既证明 cutover 当天那步不会因文案漂移卡住，也证明它**确实还没做**。
- `belle-workspace` 远端 main 仍 `726c5204afc9…`。

## A3.9 发现

**F6 [LOW，本轮新发现]｜cutover 规定使用的 `--runtime-only` 模式**不**执行密钥/机器路径扫描。**
读代码 `verify-belle-workspace.ts:305-310`：`verifyNoSecretOrMachinePath()` 被包在
`if (!runtimeOnly)` 里。实测：我把 `ghp_…` 和 `/Users/xiaorongli/…` 注进仓再跑
`--runtime-only`，**两次都通过**；同样的两个突变在 scaffold 模式下立刻变红。
而 README.md 明确规定 cutover 用 `--runtime-only`（理由正当：不去读 Annie 的私人文件）。
**不是防护缺口**，因为 runbook 另有两道：
①（硬门）§3 的 `fly2034_scan_staged_credentials` 扫 Git index，覆盖
`BEGIN .*PRIVATE KEY|gh[pousr]_|sk-|AKIA`；② `/Users/` 那半只有 §3 的
`rg -l '/Users/' … || true`，**`|| true` 意味着它永远不会让那步失败**，是给人看的、不是门。
⇒ 读者不要把「cutover 跑了 verifier」读成「机器路径断言在 cutover 被强制执行了」。

**F2 [LOW，attempt 1 提出，本头复现]** 凭据门 PASS 文案里的「binary」那半，测试证不到。
去掉 `git grep --cached` 的 `-a` 后测试**仍通过** —— 因为 `git grep` 命中二进制 blob 时
本来就 rc=0。没有防护缺口（去掉 `-a` 二进制密钥照样被拦），只是那句 PASS 文案比测试能
证明的强一点。

**F1 [MEDIUM，非本 PR 所有，attempt 1 提出]｜本轮未复测。** 529 房 `--alerts` 与
launchd-v2 Lead 载体不兼容（`identity_launch_env_conflict`）。本轮我按无 `--alerts` 的
拓扑跑，没有触发也没有重验这条；它仍应单开。**不要把本轮的 529 全绿读成 F1 已修。**

**F5 [MEDIUM，基础设施，attempt 2 提出]｜本轮已规避。** 两个并发 QA runner 共用规范路径
`/tmp/ship-report.html` 会互相覆盖并交叉发布。本轮我用了带 issue+exec 前缀的唯一路径，
并在发布后回读 hosted `<title>` 自证。作废链接
`https://fw-reports-a53de2.vercel.app/r/d04806d24b20d4f0897229cc759a9bf8/`
（内容是 FLY-2017）仍然作废。

**F3（PR CONFLICTING）已消失** —— 本头 MERGEABLE/CLEAN，CLAUDE.md 冲突按加性解决。
**F4（merge ≠ 可开维护窗，中间隔一趟 updater 班车）**仍然成立，见 `onboarding.md` §1。

## A3.10 全仓门

| 门 | 结果 |
|---|---|
| `pnpm lint` | **0 error / 8 warning**（8 条全在本 PR 未触碰的文件里，是 main 基线） |
| `pnpm -r build` | **rc=0**，零 TS error，22 个 workspace 全出 |
| exact-head CI | 见 A3.2，11/11 真绿 |

我**没有**在本机跑完整 `pnpm test:packages:run`：本 PR 的可执行面窄到 1 个 vitest 文件
+ 1 个 shell test + 1 个 CI step，三样我都单独跑过且做了突变检验；全包结论以 PR CI 为准
（CI 的 5 个 Unit shard 本轮全绿）。这是**我的选择**，不是「跑不了」。

## A3.11 我没测的（honest boundary —— PASS 不覆盖这些）

| 没测的 | 为什么 | 风险 | 什么时候能测 |
|---|---|---|---|
| **验收② 全链**：Belle 本人真派 generic 工人 → 菜单 → `archive/meal-menu/` + `archive/weekly/` → PR → merge 后 `git show` 验档 | cutover 未发生，席位仍 `companion/spawn=false`，她**物理上发不出派工**；实现节点被明令禁止代做 | **中**：plan §D4 那 7 条证据链（派工归属 / snapshot 形态 / 幂等重放 / worktree 落点 / skill 真调用 / 双归档 / 台账可 grep）整条未经真机；`life-executor.md` 至今只被静态 materialize 过，**没被任何真 runner 执行过** | cutover 维护窗之后的独立 QA 节点 |
| cutover 序列本身（§2 连接目录 / §3 落格 / §4 identity / §5 原子 mv / §6 live 终验 / §7 重启 / §10 回滚） | 全是 live mutation，founder-gated | 中：单条**命令**我逐条跑过（在副本上）且 identity 锚点逐字对得上，但**整条序列没连着走过一遍** | 维护窗当场 |
| 共享 `#test-leads-roundtable` 里的双 Lead 交叉发言 | `--mode roundtable` 拒绝 `--extra-lead`；我改用「单 Bridge + 2 真 Lead」（角色定义认可的 N-to-N 拓扑） | **低**：本改动不碰 mention-gate / 路由 / channel id / 任何代码路径，只改 Lead 读到的名册文字；而「文字是否到达并改变真 Lead 的回答」已由面 A + 面 B 双证 | 需要时用 `--mode roundtable` 起 slot 1+2 |
| F1（`--alerts` × launchd-v2） | 本轮拓扑没用 `--alerts` | 低（非本 PR 所有） | 单开 |
| 本机全包 `pnpm test:packages:run` | 见 A3.10 | 低 | PR CI（已全绿） |

## A3.12 结论

三格硬门（exact-head CI 真绿 / 两个 verifier 非空过绿 / 529 真机 N-to-N 本轮重跑）都过；
rebase 带进的 main 变更经逐文件字节核对 + digest 重算 + 组装器实跑，确认没有扰动已验内容。

剩余的真正风险**不在代码里，在还没发生的那次 cutover**。merge 这个 PR 只是把维护窗的
前置条件补齐 —— 它**不**等于 Belle 能派工了。

---

## A3.13 判定推翻 —— **最终 verdict = FAIL**（2026-08-25 10:2x PT）

A3.0 到 A3.12 是我在 10:20 PT 之前写的，那时的判断是 PASS。**那个判断已经作废**，
理由不是我改了主意，是**世界在我跑 QA 的过程中变了**，而新事实是一个硬门。
留着上文不删，是为了让下一个人看得见「哪些证据仍然有效、哪些结论已经不能用」。

### 发生了什么

`origin/main` 在 **09:56:49 PT** 合入了 `e17cbe061`（PR #947 / FLY-2045）：
**把里程碑账本整张表从 `CLAUDE.md` 搬走了**，改成 `engineering/doc/milestones/<ID>.md`
一 issue 一文件，并在 `CLAUDE.md` 原位留下一句指针 + 一句禁令。

而本分支对 `CLAUDE.md` 的唯一改动，恰恰是**往那张已被删除的表里插一行**。

FLY-2045 的存在理由，就写在它自己搬走的那句话里：

> ⚠️ **不要把里程碑写回本文件的表格。** 那张表是一个共享写点：两个并行 PR 必然在同一个
> hunk 冲突，合一个就让其余在飞分支全部 DIRTY 并**失去 CI 能力**（FLY-2045，实测 100%，
> 不是偶尔）。

**本分支现在就是它描述的那个受害者。**

### 两条独立证据（不是一条的两种说法）

**证据 1 —— 分支已失去 CI 能力（不是「CI 还没跑」）**

| 判据 | 值 |
|---|---|
| `gh pr view 946` | `mergeable=CONFLICTING`、`mergeStateStatus=DIRTY`（间隔重查两次，稳定） |
| `git merge-tree --write-tree origin/main HEAD` | rc=1，`CONFLICT (content): Merge conflict in CLAUDE.md`（唯一冲突文件） |
| head `5fa450a15` 的 workflow runs | **`total_count=0`** |
| head `d722ad381` 的 workflow runs | **`total_count=0`** |

时间线证明**不是我的 push 造成的**：`2b70b4fda` 的绿 CI 创建于 **09:34:53 PT**，
#947 合入于 **09:56:49 PT**，我的第一次 push 在 **10:20 PT**。
⇒ 分支从 09:56 起就已经 DIRTY，此后无论推什么都排不出 `pull_request` CI。

**证据 2 —— 就算把冲突「两边都保」地解掉，新的 always-on CI 门也会红**

#947 同时往 **Quick Gate**（`pnpm install` 之前、永不被 classifier 跳过的那条道）
加了一步 `Enforce FLY-2045 milestone layout`。我在受控沙箱里用 **main 的那份 guard**
去量**本分支的 `CLAUDE.md`**：

```
FAIL: [G2] expected exactly 1 pointer anchor line, got 0
FAIL: [G2] the milestone table header is back in CLAUDE.md
FAIL: [G2] 180 milestone data row(s) found in CLAUDE.md; the ledger must not flow back
```

**阳性对照**（同一个沙箱、同一份 guard，只把 `CLAUDE.md` 换成 `origin/main` 的）：
G1/G2 十项**全 PASS**。⇒ 红的是本分支的内容，不是我的沙箱坏了。

> 沙箱边界如实说明：我只把 `CLAUDE.md` 与 `engineering/doc/milestones/` 放进沙箱，
> 所以输出里另有 12 条 **G4** 失败是我沙箱缺文件的假阳性，**不算数**。
> G1/G2/G3/G5/G6 只读这两处，所以它们的结论有效。

### 为什么这不是我能顺手修的

修法是明确的，但它是**实现动作**，不是 QA 动作：要把 FLY-2034 的里程碑正文从
`CLAUDE.md` 的表里摘出来，按 `engineering/doc/milestones/README.md` 的单写者合同
新建 `engineering/doc/milestones/FLY-2034.md`，并把 `CLAUDE.md` 恢复成 main 的指针形态。
这涉及改共享配置文件和搬运实现者写的正文 —— 我的角色明确禁止改 source/config。
所以我把它原样交回，不自己动手。

### 这次 FAIL **不是**说实现有问题

上文 A3.1–A3.12 的每一格证据仍然有效，且都是绿的：

- 代码本身在 `2b70b4fda` 上拿到过**逐 job 核过的真绿 CI**（11/11、0 skipped、0 饿死、
  真执行器，且本 PR 新增的那一步 `Test — FLY-2034 Belle staged credential gate` 自身 success）；
- 从那个绿 head 到当前 head 的全部差异，**逐文件确认只在
  `engineering/doc/FLY-2034-belle-lead-seat/` 里**（我自己的 QA 报告 + 台账 + 两张截图），
  **零代码、零 CI 输入文件**；
- 两个 verifier 正路径绿、digest 与前两轮逐字节相同、15 条自出突变全部按指定断言变红；
- 529 真机双 Lead 本轮**重跑**通过，并有三个生产 Lead 作野生对照；
- 生产席位逐字未动，收尾零残留。

**要返工的是「这个分支怎么记里程碑」这一件事，不是 Belle 席位的工程件。**
预计改动面：删 `CLAUDE.md` 的 1 行插入 + 恢复指针段 + 新增 1 个 `milestones/FLY-2034.md`。
修完重推、拿到该 head 的 exact-head CI 真绿之后，QA 复验成本很低 —— 名册文件、两个
verifier、digest 都是字节稳定的，本轮已全部验过。

### 为什么不判 PASS 再让 land 机器去处理冲突

因为 PASS 的语义是「**把这个 head 绑定成可以 ship 的那一版**」。当前 head
既合不进 main，也拿不到任何 CI 证据，还会被一条 always-on 门拦下 —— 它不是可 ship 的那一版。
而且 attempt 1 被打回的原因正是「零 CI 证据的 head 不该判 PASS」；
在同一张单上第二次犯同一个错，比冲突本身糟糕得多。

**按角色合同，FAIL 不发 founder ship report。** 仓里的 `qa/ship-report.html`
已同步改成 FAIL 版本，**未发布**、也没有对外链接。

---

# Attempt 4（FLY-2045 迁移后复核）—— 2026-08-25

## A4.0 判定

**PASS。**

限定不变，写在第一行：**这个 PASS 不等于 Belle 现在能派活。** 席位翻转（cutover）
是 founder 维护窗的动作，至今未发生（A4.8 有当刻只读取证）。验收②整条链仍**一格未验**。

attempt 3 的 FAIL 是「分支还在往 FLY-2045 已删除的 CLAUDE.md 里程碑表插一行 ⇒ 冲突 ⇒
失去 CI 能力」。**这一格现在补上了，而且是在两条独立通道上各证一遍**（A4.3）。

## A4.1 被测头

| 项 | 值 |
|---|---|
| `git ls-remote origin refs/heads/flywheel-FLY-2034` | `bdd9d0ded41442fd5e9c0ffe008e8df0a7296e76` |
| 本地 HEAD / PR `headRefOid` / rework `baseRevision` | **三者逐字一致** |
| PR #946 | OPEN、非 draft、**MERGEABLE / CLEAN** |
| `git merge-base origin/main HEAD` | `e17cbe061`（= `origin/main` 本身）⇒ **确已 rebase 到新 main** |
| 分支自有 diff | 28 个文件；生产运行时面仍只有 `cross-dept-channel-rules.md` |

## A4.2 迁移本身做对了没有

| 判据 | 结果 |
|---|---|
| `git diff origin/main..HEAD -- CLAUDE.md` | **空** —— 表行已删、指针段与 main 逐字一致，`CLAUDE.md` 完全不再被本分支触碰 |
| 新文件 | `engineering/doc/milestones/FLY-2034.md`（+7 行） |
| 文件名 | 合 `^(FLY|GEO)-[0-9]+\.md$` |
| 内容格式 | 与 `milestones/README.md` 合同逐项对上：`# FLY-2034 — <短标题>` / `**Status**: ⏳ Pending ship` / `**PR**: #946` / `**Date**: 2026-08-25` / 正文 |
| `ci-structure.test.sh` 的分支自有 delta | 仍精确 **+1 行** |

## A4.3 attempt 3 的阻断项已解 —— 两条独立通道

**通道 1：真 CI（不是本机跑）。** exact-head run **32878386311**，head 精确等于
`bdd9d0ded`，该 head 的 run 总数 = 1。逐 job 三件套：

- 11 个 job **全部 `completed/success`**；`skipped` = **0**；
  starved（`steps==0` 且 `runner_name==""`）= **0**；每 job 都有真执行器名
  （`1000054640–649`、`…651`）；步数 20/5/34/65/15×5/21/3；
  聚合门 `CI OK` = **3 steps / runner `GitHub Actions 1000054651` / success**。
- **两个必须真跑的步骤逐个点名确认，不停在「job 绿」这一层：**
  - `Quick Gate` **step 6 `Enforce FLY-2045 milestone layout` = completed/success`**
    —— 这正是 attempt 3 判死本分支的那道门，现在在真 CI 里绿了；
  - `Script Tests 2/2` **step 13 `Test — FLY-2034 Belle staged credential gate` = completed/success**。
- Quick Gate 从 19 步变 20 步，多出来的正是 FLY-2045 那一步。

**通道 2：本机原生跑同一道 guard（这次不需要沙箱了 —— rebase 后它就在 worktree 里）。**
`bash scripts/__tests__/fly2045-milestone-layout.test.sh` → **PASSED=32 FAILED=0**。

**这道 guard 不是空过绿 —— 我出了两条突变：**

| 突变 | 期望 | 实测 |
|---|---|---|
| 往 `CLAUDE.md` 塞回一行里程碑表 | 变红 | ✅ 精确 2 条 G2 失败：`the milestone table header is back in CLAUDE.md` / `1 milestone data row(s) found in CLAUDE.md` |
| 删掉 `engineering/doc/milestones/FLY-2034.md` | 变红？ | ❌ **仍 32/32 全绿** —— 见 A4.9 F7 |

另跑了 main 自带的 guard 突变套件 `fly2045-milestone-layout-mutations.test.sh`：
**27/27 fixtures held**。

两条突变做完后 `git status --porcelain` 为空，guard 复跑 32/32，worktree 逐字复原。

## A4.4 逐文件字节核对 —— rebase 有没有动我验过的东西

对 attempt 3 已全量验过的头 `2b70b4fda`（那个头拿到过 11/11 真绿 CI）取 **commit 内容**
比对：

`cross-dept-channel-rules.md` / `lead-rules-bundle.test.ts` /
`fly2034-onboarding-credential-gate.test.sh` / `verify-belle-workspace.ts` /
`verify-belle-projects-cutover.ts` / `onboarding.md` / `plan.md`
—— **7/7 IDENTICAL**。

新 main commit `e17cbe061` 的完整文件表我逐个看过：**零 TypeScript**，且
`git diff 6978e2ee9..origin/main -- packages/teamlead/lead-rules-base/
packages/teamlead/scripts/{lead-rules-bundle,claude-lead,codex-lead}.sh` **为空**
—— 组装链一个字节没动。

## A4.5 两个 verifier —— 重跑，不沿用

| 项 | 结果 |
|---|---|
| workspace verifier **scaffold** | 绿，冲突面恰 `.gitignore` / `CLAUDE.md` / `README.md` |
| workspace verifier **runtime-only** | 绿 |
| 三个 digest | `c4057974…` / `30618afc…` / `d38725ec…` —— **与 attempt 1/2/3 逐字节相同** |
| projects cutover verifier 正路径 | 绿，5 项 delta 精确 |
| built `validate-projects.js`（本 head 构建产物，`dist/build-identity.json` = `bdd9d0ded`） | `OK (v1)` |
| runbook §5.1 两条基线 jq | 双 `true` |

**突变抽样重跑**（全套 15 条在 attempt 3 已跑过且被测文件字节相同，故本轮抽样）：

| 突变 | 实测红点 |
|---|---|
| 删 `skills` symlink | `missing top-level skills browse path` |
| config labels 改回 `life` | `life agent must match the Founder-approved personal-assistant label` |
| adoption 多 adopt 一个合法 menu | `belle-lead must adopt only the generic menu` |
| `department` 漂成 `personal-assistant` | 拒 |
| candidate mode 0644 | `candidate projects.json mode must be 0600 before rename` |

## A4.6 真实 bundle 组装器 + 名册行为测试

| role | files | 新 Belle 行 | 旧 roster 行 | 旧 companion 句 | Mufasa-only 句 |
|---|---|---|---|---|---|
| dept | 13 | 1 | 0 | 0 | 1 |
| cos | 5 | 1 | 0 | 0 | 1 |
| companion | 3 | 1 | 0 | 0 | 1 |

`lead-rules-bundle.test.ts` **21/21**。
`ci-structure.test.sh`、`fly2034-onboarding-credential-gate.test.sh` 均 PASS。
`pnpm lint` **0 error / 8 warning**（8 条全在本 PR 未触碰文件，是 main 基线）。

> build 本轮**没有**在本机重跑：分支 TS 与已构建并验过的头逐字节相同、新 main commit 零 TS
> 改动，而 exact-head CI 的 Quick Gate（build + typecheck + lint）在干净 runner 上已 success。
> 这是我的选择，不是跑不了。

## A4.7 529 QA Room 真机 N-to-N —— **本轮再次重开房，未沿用**

我本可以沿用 attempt 3 的 529 证据（roster 文件字节相同、组装链 diff 为空），
但角色合同里这条是我自己owns 的强制项，不是可以用推理换掉的，所以重跑。
**而且这次比 attempt 3 更干净：slot Bridge 跑的就是 verdict 头本身，没有台账 commit 漂移。**

- **被测头证明**：slot Bridge `/health` 的 `buildSha` = `artifactBuildSha` =
  **`bdd9d0ded41442fd5e9c0ffe008e8df0a7296e76`** = worktree HEAD = 申报 head。
- **拓扑**：单 Bridge（port 19871）+ **两个真 Lead**（slot 1 `flywheel-test-1` +
  `--extra-lead 4:life` `flywheel-test-4`）。

**面 A —— 真 Lead 实际物化的 bundle**（本轮新写的文件，10:54 / 10:55）：

| bundle | 字节 | 新 roster 行 | 旧 roster 行 | 旧 companion 句 | Mufasa-only 句 |
|---|---|---|---|---|---|
| `test-slot-1-flywheel-test-1.65404-lstart-8d28471ca2ac4ee8.md` | 110,223 | 1 | 0 | 0 | 1 |
| `test-slot-1-flywheel-test-4.85691-lstart-f2ccf058f8dbf262.md` | 219,370 | 1 | 0 | 0 | 1 |

**野生对照组**（同机、同刻、同机制，生产 Lead 跑的是 main，只读）：
`tidal-echo-content-lead` / `sub-lead` / `joycon-lead` —— 新行 **0**、旧行 **1**（3/3）。

**面 B —— 真 Discord 往返，founder 本人登录会话（Claude-in-Chrome）**：

- Lead 1（`#cos-test`，`qa-lead-A`，**10:59 PT**）：
  > (1) `| **Belle** | Life Assistant (life dept Lead) | personal-assistant | …`
  > (2) `> **Mufasa** (FLY-231) is a **companion** Lead — a warm personal agent, not an engineering Lead.`
  > 并收口「该规则文件中明确标为 companion Lead 的只有 Mufasa」
- Lead 2（`#finance-lead-test`，`HoneyLemon-QA`，**10:59 PT**）：同样两条逐字引用，
  并注明出处 `base/cross-dept-channel-rules.md`，收口「即该文件中只有 Mufasa 被标为 companion Lead」

截图：`qa/evidence/a4-529-lead1-cos-test.jpg`、`qa/evidence/a4-529-lead2-finance-lead-test.jpg`。

> 过程如实记录：第一次发 probe 时浏览器窗口在两次动作之间被 resize（1512×793 → 840×1425），
> 点击落空、文字留在输入框没发出去。我是**看截图发现的**，不是靠工具返回值 —— `type` 和
> `key` 都返回成功。重新定位输入框后两条都真发出去了。

**收尾（生产零污染，逐项核过）**：teardown 干净退出；`launchctl` 中 `com.flywheel.qa.lead*`
**归零**；`/tmp/flywheel-test-slot-*` **不存在**；生产 Bridge teardown 前后都是
`ok=true, buildSha=5a8fe51bf…, sessions_count=6`；生产 `projects.json` 仍
`mtime=Aug 13 16:34:42`、9157 bytes、mode 600。

## A4.8 生产侧仍逐字未动（当刻重新观测）

- `projects.json` belle-lead 行：`companion=true` / `canSpawnRunners=false` /
  `department=life` / `match.labels=["life"]`；project 的 `projectRepo=null`、
  `memoryAllowedUsers=null`；mtime **Aug 13 16:34:42 2026**、mode 600。
- `~/Dev/personal-assistant` **仍不是 git 仓**；`identity.md` mtime 仍 **Jun 7 23:02**。
- addendum 4 个 fenced block 与 live `identity.md` 逐字比对：两个 "before"
  **present=True**、两个 "after" **present=False** ⇒ cutover 那步不会因文案漂移卡住，
  同时证明它确实还没做。
- `belle-workspace` 远端 main 仍 `726c5204afc9…`。

## A4.9 发现

**F7 [LOW，本轮新发现，属 FLY-2045 不属本 PR]｜guard 不保证「每次 ship 都建了自己的里程碑文件」。**
我删掉 `engineering/doc/milestones/FLY-2034.md` 再跑 guard，**仍然 32/32 全绿**。
原因是 G5 的断言是「**至少存在一个** per-issue 文件」，不是「本 PR 新增了一个」。
所以 guard 守的是「账本不许流回 `CLAUDE.md`」+ 文件名/格式，**不守「这一单有没有记账」**；
后者靠 `orchestrator.md` 的 A0 流程闸（guard 的 G4 只检查那些文本锚点在不在，
不检查它真的被执行过）。**对 FLY-2034 无影响** —— 文件在、格式对、CI 绿；
但我不能声称「guard 覆盖了里程碑文件的存在性」，因为我的突变没能让它变红。

**F6 [LOW，attempt 3 提出，本轮未复测]** cutover 规定使用的 `--runtime-only` 模式
不执行密钥/机器路径扫描。被测文件 `verify-belle-workspace.ts` 与 attempt 3 逐字节相同，
结论照旧成立；本轮没有重跑那两条注入突变。

**F2 [LOW，attempt 3 提出，本轮未复测]** 凭据门 PASS 文案里的「binary」那半测不到
（删 `-a` 后测试仍过）。同样字节相同，结论照旧。

**F1 [MEDIUM，非本 PR 所有，本轮未复测]** 529 房 `--alerts` 与 launchd-v2 载体不兼容。
本轮拓扑仍未用 `--alerts`。**不要把本轮 529 全绿读成 F1 已修。**

**attempt 3 的 F3（分支失去 CI 能力）已解**，见 A4.3。

## A4.10 我没测的（honest boundary —— PASS 不覆盖这些）

| 没测的 | 为什么 | 风险 | 什么时候能测 |
|---|---|---|---|
| **验收② 全链**：Belle 本人真派 generic 工人 → 菜单 → `archive/meal-menu/` + `archive/weekly/` → PR → merge 后 `git show` 验档 | cutover 未发生，席位仍 `companion/spawn=false`，她**物理上发不出派工**；实现节点被明令禁止代做 | **中**：plan §D4 那 7 条证据链整条未经真机；`life-executor.md` 至今只被静态 materialize 过，**没被任何真 runner 执行过** | cutover 维护窗之后的独立 QA 节点 |
| cutover 完整执行序列 | 全是 live mutation，founder-gated | 中：单条命令逐条跑过（副本上），identity 锚点逐字命中，但整条序列没连着走过一遍 | 维护窗当场 |
| 共享 `#test-leads-roundtable` 双 Lead 交叉发言 | `--mode roundtable` 拒绝 `--extra-lead` | 低：本改动不碰路由/mention-gate/channel id，面 A+面 B 已双证 | 需要时用 `--mode roundtable` 起 slot 1+2 |
| 本机全包 `pnpm test:packages:run` 与 `pnpm -r build` | 见 A4.6 | 低 | exact-head CI（已全绿） |
| F1 / F2 / F6 复测 | 见 A4.9 | 低 | 各自单子 |

## A4.11 结论

三格硬门全过：**exact-head CI 逐 job 真绿（含 FLY-2045 与 FLY-2034 两个关键步骤各自 success）**、
**两个 verifier 非空过绿且 digest 与前三轮逐字节相同**、**529 真机 N-to-N 在 verdict 头本身上重跑通过**。
attempt 3 的阻断项已按 FLY-2045 的机制正确迁移，并在真 CI 与本机 guard 两条通道上各证一遍。

剩余的真正风险仍**不在代码里，在还没发生的那次 cutover**。merge 这个 PR 只是把维护窗的
前置条件补齐 —— 它**不**等于 Belle 能派工了。
