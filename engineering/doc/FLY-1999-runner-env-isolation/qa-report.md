# FLY-1999 runner/Lead 环境继承污染收口 — 独立 QA 报告

Issue: FLY-1999 (https://linear.app/geoforge3d/issue/FLY-1999/envbug-runnerlead-环境继承污染codex-home-指向-infra-botflywheel-codex-binpath)
日期: 2026-08-23
基于: plan.md, research.md

## 0. 裁决

**FAIL** —— 一个 blocking finding:新增的 Bridge boot scrub 没有任何 socket 归属校验,
会把**生产**默认 tmux server 当成自己的清扫对象。不是理论推演:我在跑本 PR 自带的一个普通单测时
真的触发了它,生产 tmux server 的 global 与 `flywheel` session 环境已被实际改写。

被测 head:`1257a8056a43b7b8254a2c35ae981f6813429529`(PR #933,非 draft;本地 HEAD ==
`origin/flywheel-FLY-1999` == PR headRefOid,开跑前与发裁决前各核一次,两次都相等)。
注:mergeable 状态在我这轮 QA 期间由 `MERGEABLE` 变成 **`CONFLICTING`**(main 前进所致,不是代码问题);
FAIL 本来就要返工,返工时请一并 rebase。

## 1. 先说好的:pane 边界这一半是真的成立的

我没有只复跑实现者的 harness,另起了一套独立 E2E:**故意污染的真 tmux server**(镜像 research §1.2 的
事故名单,并给每个秘密塞了可 grep 的哨兵值)+ **built dist**(不是 src)+ 同 server 上的**裸窗阳性对照**。

| 观测面 | 阳性对照(同 server 裸窗) | 经本 PR 洗过的 pane |
|---|---|---|
| env 名字数 | 30 | 23 |
| `CODEX_HOME` | `/poison/infra-bot/.codex-infra-bot` | **absent** |
| `FLYWHEEL_CODEX_BIN` | `/poison/infra-bot/bin/codex` | **absent** |
| `SSH_AUTH_SOCK` | 继承 | **absent** |
| `LEAD_ID` | `flywheel-codex-infra-bot-lead` | `""`(显式置空) |
| `PROJECT_NAME` | `poisoned-project` | `flywheel`(正确重投) |
| **秘密值**泄漏 | 6 个(OPENAI/DISCORD/TEAMLEAD/LINEAR/SUPABASE/ELEVENLABS) | **0 个** |

尺子能变红(阳性对照 6/6 命中),所以「洗后 0 个」是有意义的 0,不是没看见坏消息。

**功能面**(风险表里排第一的「allowlist 漏真依赖 → runner 哑」):在同样污染出生的 server 上,
washed pane 内逐个真跑 —— `claude` / `codex` / `node` / `git` / `gh auth status` /
`git ls-remote origin`(真网络+真凭据) / `flywheel-comm` / `tmux` / `jq` / `pnpm` **全部 OK**;
`CODEX_HOME` unset 后 codex 正确回落机器级 `~/.codex`,解出的身份是 Annie 本人的机器级 profile,
不是 infra-bot。**验收 1 与 2 我独立复现成立**;验收 3(`codex-profile use` 切号跟随)由实现者
`runner-env-isolation.real-tmux.test.ts` 覆盖,我实跑通过(该测试用真 `flywheel-codex-profile`
在 personal↔school 之间真切,并做逐名相等断言,是一份质量很高的测试)。

命令形状也与 plan §2.2 钉死的一致:`${VAR+"VAR=$VAR"}` 落在 sh 脚本文本内,binary/args 仍只走位置参数。

## 2. BLOCKING —— boot scrub 没有归属校验,会清扫生产 tmux server

`scrubManagedTmuxEnvironments()` 在 `startBridge()` 里**无条件**执行,目标 socket 只由
`FLYWHEEL_TMUX_SOCKET_OVERRIDE` 决定;不设 = 默认 socket = **生产那台 server**。
没有任何一步校验「我要清扫的这台 server 是不是我自己这个 Bridge 的」。

**这不是推演,是实测发生了**:我跑 `packages/teamlead/src/__tests__/runs-route-registration.test.ts`
(本 PR 改动过的一个普通单测,会真起 `startBridge`)之后:

- 生产 tmux global 与 `flywheel` session 里 `CODEX_HOME` / `FLYWHEEL_CODEX_BIN` /
  `DISCORD_BOT_TOKEN` / `LEAD_ID` / `TEAMLEAD_API_TOKEN` 及全部
  `DISCORD_*` / `FLYWHEEL_LEAD_*` / `FLYWHEEL_CODEX_*` 前缀名 **已被删除**;
- 生产 global `PATH` 被改写为本 PR 的 canonical PATH(这串 PATH 是本 PR 独有的指纹,归因用它);
- 生产 Bridge 未重启(`buildSha` 仍 `67da67b0c`,uptime 连续),排除「是 Bridge 自己 boot 干的」。

**放大到 529 房**:`scripts/test-deploy.sh` 设了 `FLYWHEEL_DELIVERY_SECRET_PATH`,
但**没有**设 `FLYWHEEL_TMUX_SOCKET_OVERRIDE`。所以任何 529 隔离槽的 Bridge 一 boot 就会去清扫生产 server;
而且槽里 `FLYWHEEL_STATE_DIR` 指向槽 `.env`,`.env` 名解析这条腿会**生效**,删除范围远大于我这次
(我那次测试用了假 HOME/STATE_DIR,`.env` 腿没命中)。

`.env` 腿的杀伤力我在隔离 socket 上量过(未碰生产):8 个 `.env` 名 + 2 个 exact 名 = **10/10 全删**,
无关名 `KEEP_ME_UNRELATED` 保留,第二遍 removed=0(幂等)。也就是说 **scrub 自身写得是对的**,
逻辑、保留集、幂等、值零泄漏都符合设计 —— 缺的**只有归属/隔离这一道**。

这正是 FLY-529 当年 `FLYWHEEL_DELIVERY_SECRET_PATH` 那个教训的同类复发(隔离 Bridge 抹掉生产 delivery secret)。
`main` 上 Bridge boot 路径的 `set-environment` 写次数为 **0**,所以这是本 PR 新引入,不是既有项。

建议修法(方向,不替实现者定):boot 前把目标 socket 与本 Bridge 自身的 tmux 归属绑定并 fail-closed;
同时给 `test-deploy.sh` 补 `FLYWHEEL_TMUX_SOCKET_OVERRIDE`(与 `FLYWHEEL_DELIVERY_SECRET_PATH` 同姿态);
测试面则不该让一个单测有能力改宿主机共享 server。

## 3. 我造成的生产变更(如实登记)

上面第 2 节那次删除**是我触发的**,不是实现者、也不是部署。我如实登记:

- 影响面:已开 pane 不受影响(POSIX 改不了已开进程 env);Lead v2 在私有 socket 且 token 由
  wrapper 从 `.env` 自取,未被触及(我逐条核过 `flywheel-lead-wrapper-v2.sh`);runner 需要的身份名
  本来就走显式 `-e` 注入。**未观察到破坏** —— 这不等于零影响,我只说我观察到的。
- 被删的名字恰好正是本单要删的,所以净效果≈提前部分生效。
- 我**没有**也不应持有那些值,无法逐值还原;还原路径 = tmux server 自然换代,或运维重灌。
- 我**没有**动那 32 个残留 session,也没有为「再看一眼」重复触发 scrub。后续全仓门我一律加了
  `FLYWHEEL_TMUX_SOCKET_OVERRIDE` 护栏并在下面显式披露。

## 4. 次要 finding(非阻塞)

**4.1 `LEAD_ID`/`DISCORD_BOT_TOKEN`/`DISCORD_STATE_DIR`/`DISCORD_IDENTITY_MODE` 由 absent 变为空串。**
main 是 `env -u` → 子进程看不到;本 PR 是 `-e K=` + allowlist 保留 → 子进程看到空串。
我扫了 presence 型读法(`in process.env` / `!== undefined` / `${X+x}`),命中的
`authorizeLeadWrite`(`lead-lease.ts:2588`)与 `codex-lead-runtime.ts:555` 都是 **Lead-only 写授权**路径,
且同函数还要求 `FLYWHEEL_LEAD_KEY`/`DISCORD_STATE_DIR` 精确等于 canonical 身份 —— runner pane 在 main 上
同样过不了这道门,所以**不是回归**。但语义确实变了,值得在 plan 里写明而不是留给下一个人踩。

**4.2 `_tmux_rescue_clean_create` 掉了 `TMUX_TMPDIR`,TS 孪生 `buildTmuxServerBirthEnvironment` 保留了它。**
实测:pre-PR 的 `_tmux_rescue_bounded_exec` 子进程能看到 `TMUX_TMPDIR`,PR 的 `clean_create` 看不到。
但 `_tmux_rescue_validate_argv` 强制每条 create argv 必须带精确 `-S <socket>`(不带就 fail-closed),
所以 `TMUX_TMPDIR` 在 rescue 路径上**功能惰性** —— 判定为**外观不对称,非功能缺陷**。
只是 CLAUDE.md 里写的「保留 `TMUX_TMPDIR`」对 shell 这一侧并不成立,建议措辞对齐。

**4.3(既有项,不是本 PR 的伤)** 生产默认 tmux server 上堆了 **32 个** `runner-fly1674-*` 残留 session,
最早 2026-08-21 09:46,远早于本单第一个 commit。来源 `fly1674-opus46-real-tmux.test.ts` 每跑一次泄 2 个。
控制组:我在 `main`(`67da67b0c`)上跑同一文件,**同样泄漏一对**,且该文件在 main 上 **2/2 红**、
在本 PR 上 **1/2**(本 PR 严格改善了它)。建议单独开单;我没有清理这 32 个 session。

## 5. 门与证据

| 门 | 结果 |
|---|---|
| exact head 核对 | ✅ 本地 == origin == PR #933 headRefOid `1257a8056`;非 draft;MERGEABLE |
| `pnpm -r build`(22 workspace) | ✅ rc=0 |
| `pnpm lint` | ✅ 0 error / 7 条既有 warning(与里程碑自述一致) |
| claude-runner 定向 5 文件 | ✅ 231/231 |
| teamlead scrub + tui-window + runs-route | ✅ 20/20 |
| `scripts/__tests__/tmux-server-rescue.test.sh` | ✅ 47 passed / 0 failed |
| 独立真机 E2E(污染 server + 阳性对照 + built dist) | ✅ 见 §1 |
| 独立 scrub 半径实测(隔离 socket) | ✅ 10/10 删除 + 阴性对照 + 幂等 |
| `pnpm test:packages:run` 全仓 | ⚠️ 见下方(需加护栏才能安全跑,如实披露) |
| claude-runner 全包(clean harness) | ✅ **31/31 文件,863 pass / 2 skip,0 failed** —— 承载本单核心改动的包全绿 |
| teamlead 全包 vs **main 同 harness 对照** | PR **13 文件 / 30 test** 红,main **15 文件 / 37 test** 红 → PR 严格更少 |
| teamlead 上「只在 PR 红」的 3 个文件 | ✅ 隔离复跑 **43/43 全绿**(5.97s)→ 并发负载 flake,非回归 |
| flywheel-comm 2 个 5s 超时 | ✅ 隔离复跑 **9/9 全绿**(3.95s)→ 既有 `FLY-1686` 宿主类 |
| `fly1674-opus46-real-tmux.test.ts` | ❌ 1/2 —— **main 上 2/2 红**,既有项,非回归(§4.3) |

**诚实边界:**

- 全仓 `pnpm test:packages:run` 我**加了 `FLYWHEEL_TMUX_SOCKET_OVERRIDE` 护栏才敢跑** ——
  不加护栏,它每遇到一个 startBridge 测试就会再清扫一次生产 server。「必须加护栏才能安全跑全仓门」
  本身就是 §2 的佐证。
- **我第一版护栏把结论量错了,如实登记**:第一次跑 teamlead 我用了本 pane 的长 `TMPDIR`
  和一个**没有真 server 的** guard socket,得到 75 failed;换成短 `TMPDIR` + 真起一个隔离 tmux server 后
  变成 30 failed。也就是说其中约 45 个失败是**我的 harness 自己造的**(长路径撞 unix `sun_path` 上限 EINVAL)。
  上表用的是干净那一轮的数字。这条正是「隔离会悄悄改掉被测语义」的现场,故留证而不是抹掉。
- teamlead 的红我**没有**直接认到本 PR 头上:我在 `main`(`67da67b0c`)上用**逐字相同**的 harness 跑了对照组,
  main 比 PR 还多红 2 个文件 / 7 个 test;PR 独有的 3 个文件隔离后全绿。宿主本身在这台机器上就有一批
  既有红(Terminal.app / 并发 5s 固定超时 / Vitest worker `onTaskUpdate` timeout)。
- aggregate 跑到 flywheel-comm 就中断,故其后的 package **没有跑到** —— 我不把它报成全绿。
- 我**没有**开 529 房做 N-to-N。理由见 §6,是判定不是省略。
- 存量已开 pane 无法追溯修改(POSIX 限制)—— 与 plan §5 的诚实边界一致,ship 后只对**新 spawn** 断言。
- **我没有验的**:真实 Bridge 重启后 scrub 在生产上的首跑行为(那需要投重启票,plan §6 明确不投);
  以及 Codex runner TUI 路径(`codex-runner-tui-window.ts`)的真机跑 —— 我只核了它的单测与命令构造,
  没有真起一个 Codex runner TUI 窗口。

## 6. Discord-capable 判定:无 N-to-N surface

我按自己的标准逐条查过,判定**本 diff 不含 Discord surface**,依据是三条可证事实而不是「看起来不像」:

1. diff 里 **零** Discord send / relay / render / founder 交互 / roundtable 代码;
2. Lead 的 Discord 本体跑在**私有 tmux socket** 上(`flywheel-lead-wrapper-v2.sh` 用 `tmux -S <私有 socket>`,
   并自己 source `.env` 把 `DISCORD_BOT_TOKEN` 显式塞进 SERVER_ENV),而 scrub 只打默认 socket —— 够不着;
3. 默认 server 的 `flywheel` session 里那两个 Lead 窗(`growth-mufasa-lead`、`flywheel-codex-infra-bot-lead`)
   是 `codex resume --remote` 的**观察窗**,Discord 由 sidecar 另一个进程供给(源码注释亦明载)。

替代的真检查 = §1 的真机污染 E2E + §2/§4.2 的真 tmux 实测 + §5 的真 shell harness。

## 7. 复测时请一并回答

1. boot scrub 如何证明「我清扫的这台 server 是我自己的」?fail-closed 的形状是什么?
2. `test-deploy.sh` 是否补了 socket 隔离,且有一条会变红的回归钉住它?
3. 一个单测还能不能改到宿主机共享 tmux server?(即测试面本身的隔离)

---

# 复测(qa attempt 2 / epoch 5)—— 裁决:PASS

被测 head:`17ececff50214f397b5c9b25fee89b65ccac61a9`(PR #933,非 draft,**MERGEABLE**——rebase 已落;
本地 == origin == PR headRefOid == activation baseRevision,四者相等,开跑前核过)。

## R1. blocking finding 已修复,且我用会变红的判据验的

修法比我建议的那半更好:**归属证明**而非「外部 opt-in」。无 override 时先 `list-sessions`,
必须存在配置项目对应的 `runner-<project>` session 才认为「这台 server 是我的」,否则
`skipped: tmux server ownership unproven` fail-closed。529 房另走**原生每槽 socket**
(`TMUX_TMPDIR=${SLOT_DIR}` + 启动边界 `-u TMUX -u FLYWHEEL_TMUX_SOCKET_OVERRIDE`),
teardown 只 kill 本槽 server——这一手把**所有**未限定 tmux 调用一起收了,不只是 scrub。

| 用例 | 结果 |
|---|---|
| **T1 生产形态**(无 override,归属可证) | ✅ scopes=3, namesRemoved=5(CODEX_HOME/FLYWHEEL_CODEX_BIN/OPENAI_API_KEY/DISCORD_BOT_TOKEN/CASS_BOT_TOKEN)→ **第三层活着**,我先前的 descope 担忧解除 |
| **T2 突变对照**(同上但删掉归属 session) | ✅ 0/0 + `ownership unproven` → **判据能变红**,所以 T1 的绿是有意义的 |
| **T3 单测形态**(projectName=TestProject) | ✅ 0/0 skipped → 生产被保护 |
| 阴性对照 `KEEP_ME` | ✅ 未被删 |

**端到端铁证(最强的一条)**:我把**当初闯祸的那个测试**原样再跑一次,前后快照生产 tmux:
`runs-route-registration.test.ts` → 通过;生产 global env 名字数 **105 → 105**,`diff` 空,**PATH 逐字未变**。
更进一步:**整轮 teamlead 全包(725 文件)与 claude-runner 全包我故意不加任何护栏**跑完,
生产 tmux global env **零变化**——上一轮我必须加护栏才敢跑,这一轮不需要了。

## R2. 洗法(第一层)无回归

对**新 built dist** 重跑我自己的污染 E2E:阳性对照 30 名 + 6 个秘密值全见;
washed pane 23 名、`CODEX_HOME`/`FLYWHEEL_CODEX_BIN`/`SSH_AUTH_SOCK` 全 absent、秘密值 **0** 泄漏、
`PROJECT_NAME=flywheel` 正确重投。washed pane 内 claude/codex/node/git/`gh auth status`/
`git ls-remote`/flywheel-comm/tmux/jq/pnpm **全 OK**,codex 身份正确回落机器级 `~/.codex`。

## R3. 门

| 门 | 结果 |
|---|---|
| exact head | ✅ 本地==origin==PR head==activation baseRevision;非 draft;MERGEABLE |
| `pnpm -r build` | ✅ rc=0(22 workspace) |
| `pnpm lint` | ✅ 0 error / 7 条既有 warning |
| 5 个受影响 shell harness | ✅ 47 + 18 + 15 + 3 + 12 = **95 passed / 0 failed** |
| claude-runner 全包 | 31/32 文件;唯一红 `tmux-slot-routing.real-tmux.test.ts` **隔离复跑绿**(507ms)= 并发 flake |
| teamlead 全包 vs main 同 harness 对照 | **11 文件 / 27 test** 红 vs main **15 / 37** → 严格更少;其中 10 个 main 上同样红 |
| 唯一「只在本 head 红」的文件 | `runs-route.dag-entry.test.ts` → **隔离复跑 49/49 全绿** = 并发 flake |

## R4. 非阻塞 advisory(建议 follow-up,不挡 ship)

**A1. 新增 real-tmux 测试对 `TMPDIR` 长度敏感,且两种失效形态不一致。** 实测归因(不是猜):
`os.tmpdir()` 下建 socket,**短 TMPDIR(/tmp)路径 47 字符 → status 0**;
**Flywheel runner pane 的 TMPDIR 路径 132 字符 > macOS `sun_path` 上限 104 → status 1**。
后果:`tmux-slot-routing.real-tmux.test.ts` 的 `tmuxUsable()` 守卫把这个判成「tmux 不可用」→ **静默 skip**;
而 `tmux-environment-scrub.test.ts` 的 real-default-socket 用例没有守卫 → **直接红**。
CI(TMPDIR=/tmp)两者都会真跑且绿,所以不阻塞;但**静默 skip 那个更危险**——
它恰好在「Flywheel 自己的 runner pane」里消失,而那正是本仓实现/QA 跑测试的地方。
建议:守卫区分「tmux 不可用」与「此处路径放不下 unix socket」,或改用固定短根。

**A2. 529 的 shell 侧断言是文本 grep,不是行为验证。** `test-deploy-qa-room.test.sh` 用
`grep -qF 'BRIDGE_EXTRA_ENV+=("TMUX_TMPDIR=${SLOT_DIR}")'` 之类钉住源码文本——能变红,但证明的是
「这行字还在」,不是「路由真的落在槽 socket 上」。行为证明在 TS 侧 `tmux-slot-routing.real-tmux.test.ts`,
而它正是 A1 里会静默 skip 的那个。两条腿合起来在 CI 上是够的,但在长 TMPDIR 环境下只剩文本腿。

**A3. 归属证明依赖 `runner-<project>` session 存在。** 若 tmux server 刚出生、尚无任何 runner session
(正是 2026-08-20 事故的形态:server 由 Lead TUI 出生),该次 Bridge boot 的 scrub 会
`ownership unproven` 跳过。实际危害有限(第一层 pane 边界已兜住真正的伤害),但第三层在
「刚被污染出生的 server」这个场景下恰好不生效,与它的设计初衷有张力。留作 follow-up 判断。

**A4(既有项,非本 PR)**:32 个 `runner-fly1674-*` 残留 session,已由 Lead 收进批后账单独立单。

## R5. 诚实边界

- 我**没有**开 529 房做真 N-to-N(判定无 Discord surface,依据见 §6);529 的隔离我验的是
  代码路径 + shell harness + TS 行为测试,**不是**真起一个槽跑一遍。
- 生产 Bridge 重启后 scrub 在生产上的**首跑**我没验(需重启票,plan §6 明确不投);
  T1 是等价形态的隔离验证,不是生产现场。
- Codex runner TUI 真机路径仍未验(只核了单测与命令构造)。
- 全包 aggregate 的红我逐个隔离复跑并与 main 对照过,未把宿主既有红认到本 PR 头上;
  也未把「隔离后绿」说成「aggregate 全绿」。

## 附录:上一轮 fail-close marker 删除审计(Lead 指示)

- path: `~/.flywheel/state/qa-result-failed/38e1b48d-1da5-48b0-95aa-3d4f5123f674.json`
- sha256: `ac686638396c300f1661c05562e571ed5bb0c02bd333dfc346677eda8f157770`,10656 bytes,mtime 2026-08-23T14:34:03-0700
- 内容为**假失败**残留(verdict 实际已被引擎结清:`node_completed outcome=qa_fail` @21:33:33)
- 逐字副本留档,sha 与原件相同,可原样还原;同目录另外 38 个其它 exec 的 marker 未触碰
