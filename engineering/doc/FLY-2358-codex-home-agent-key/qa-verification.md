# FLY-2358 角色级 Codex Home — 独立 QA 验证
Issue: FLY-2358 (https://linear.app/geoforge3d/issue/FLY-2358/2355b1-ic-层地基任务级-codex-home-改键-executionid-agent)
日期: 2026-09-05
基于: plan.md / implementation-evidence.md

## 被验版本

| 项 | 值 |
|---|---|
| PR | #1098 |
| 评审头(实现方最后一次 code review 的头) | `d1aebd50c` |
| 该头的 GitHub CI | 14/14 全部 success;PR `MERGEABLE` / `CLEAN` |
| QA 绑定头 | 本文件所在提交(= `d1aebd50c` + 本 QA 节点的 doc/ledger 提交,**仅 doc**) |
| `packages/` tree sha | `4a98a623647b5d468570f5c3dc8767493d4b83e5` —— QA 绑定头与评审头**逐字节相同** |

被测代码字节与评审头一致,已用 `git rev-parse <head>:packages` 对比证明,不是靠"只改了 doc"的口头断言。

## 一、四项验收逐条结论

### A1 键的唯一性与分离(PASS 12/12)

自写脚本 `a1-key-identity.mjs` 直接调用 `dist/codex-home.js` 的 `codexAgentHomeDir`:

- 同 `(flywheel, implement)` 连续两次 → 同一路径 `<root>/agents/flywheel/implement`。
- 四组对照:同项目异 role、异项目同 role、两者皆异 → 三条路径互不相同,四条合计 4 个不同值。
- 大小写单射:`(Flywheel, Implement)` 编码成 `flywheel--1/implement--1`,与小写形态**不同路径**(macOS APFS 大小写不敏感,这一条是必须的)。
- 6 个项目 × 6 个 role(含一个 Lead 形态 role `flywheel-eng-lead`)= 36 条路径,零碰撞。键的命名空间本身能表达 Lead。
- `FLYWHEEL_CODEX_HOMES_ROOT` 覆盖生效;旧式 `codexHomeDir(executionId)` 形状未变。
- 敌意身份(`..`、`a/b`、`../../etc`、空串)全部抛错拒绝。

### A2 第一次用到才建 + 不随任务删除(PASS,含在 18/18)

脚本 `a2-lifecycle.mjs` 用真实 `admit → provision → release` 走一遍两次 spawn:

- admit 之前目录不存在(不预建)。
- spawn#1 建家、写 marker(`{version,project,role,createdAt,assemblyArm,materializedArm}`)。
- 往家里写一份"记忆"文件,释放最后一条租约后 → **家和记忆都还在**;只有 config.toml 里的 GH_TOKEN 受管块被擦掉。
- spawn#2 用同一对身份 → 解析到**同一路径**,并且读得到 spawn#1 攒下的记忆。
- 两个 worktree 的 trust 在两次 provision 后**累加**(不是后者覆盖前者)。
- **同形先例核对**(`qa-evidence/a7-materialization.txt`):键式家里 `AGENTS.md` 带着
  `flywheel-managed (FLY-1188): materialized from <contract> at provisioning` 头、内容来自 contract 源;
  `skills/.system/{.codex-system-skills.marker,skill-installer}` 已递归物化;marker 的
  `materializedArm` 与 `assemblyArm` 一致。与既有一次性家的建法同形,不是另起一套。

### A3 删家保护(PASS,含在 18/18)

- 对键式 execution 调 `removeCodexHome` → `{removed:false, reason:"agent_home_protected"}`,并打出 `[codex-home] refuse_remove_agent_home exec=... kind=keyed`;家仍在盘上。
- 对 `unknown`(session 记录被篡改指向 `/etc`)→ 拒删。
- 对旧式 executionId 家 → **行为不变**,照常 `{removed:true}` 并真删掉。
- 空 `catch` 已改为 `remove_home_failed` / `remove_home_unresolved` 可见告警(读码确认)。
- 全仓复查:`removeCodexSessionState`(唯一包装入口)**今天仍是零生产调用点**,只有测试引用。"跑完清理"接上那天,键式家会被上面这层挡住。

### A4 并发裁定与实现一致(PASS 10/10)

裁定是 (a) 共享持久家。我独立复跑了裁定的载荷实验,并另测了裁定引出的新契约:

- **E1 复现**:`exp-two-appservers-one-home.sh` 在真二进制 `codex-cli 0.153.2` 上重跑(实现方 01:19,我 04:29)。两个 `codex app-server --remote-control` 同家同时起 → 双 socket 在、双进程活、stderr 无 lock 行;阴性对照(同 socket 起第二个)如期失败 `control socket is already in use`。**"那把 startup lock 不互斥 app-server"这条结论我自己看到了。**
- **换体 ↔ reown 契约**(`a4-arm-reown.mjs`,跨 claude-runner + teamlead 两个真 dist):
  - A 先入,家臂 = `matt`;B 同家请求 `superpowers` → **继承 matt**、`inherited=true`、同一 home、两条租约。
  - Bridge 重启后 B 带**生效臂** `matt` reown → 成功、复用原租约、不新建。
  - 尺子自检:若快照带的是**未继承的请求臂** `superpowers` → `keyed_home_reown_arm_mismatch` **fail-closed 抛错**,且不漏租约。这证明"Blueprint 必须持久化生效臂"这条是**有承重的**,不是巧合。读码确认 Blueprint 的 `env.skillFrameworkMode` 走的正是生效臂,`launchContext.skillFrameworkMode` 由它派生。
  - 无 `workflow_node_id` 的会话 reown 原样返回(旧路径未被波及)。
  - 全部租约排空后,新 execution 请求 `bare` → **被采纳**;家本身仍在(换体不丢记忆)。
- 仓内 8 子进程跨进程并发用例在我这台机上 666 ms 通过(不是单进程 Promise 调度)。

### A5/A6 裁定引出的两条红线(PASS 8/8 + 10/10)

exploration §4.2 列了 C1–C8 八个"共享家之后才出现"的冲突。我挑了两条**一旦回归就会静默烧生产**的独立验:

- **C1 引用计数**:A、B 同家都在跑,A 先退休 → B 还需要的 `GH_TOKEN` **没有**被剥掉,家没被删,只删掉 A 的租约;B 最后退休时才擦令牌。凭据残留不变式两头都成立。
- **C5 worktree trust**:两个 worktree 同时在受管信任块里,后 provision 不覆盖先 provision。
- **C2/C3 Bridge 启动清扫**:`running` 的活 runner 租约和令牌**在清扫后仍在**;`completed` 与"根本没有 session 行"的两条孤儿租约被回收;身份漂移的租约被**拒绝回收**并打 `keyed_home_janitor_identity_mismatch`;清扫**从不删家**。
- 旧式 `scrubOrphanedCodexHomes` 仍能擦旧家的令牌,且**没有**误伤键式家的令牌,也没删 `agents/` 下任何东西。

### A7 真机:键式家对真二进制是不是一个**能用**的家(PASS)

前面几条证的是路径 / 租约 / 保护的逻辑。A7(`qa-scripts/a7-real-binary.sh`)补上最后一环——
用生产 `admitCodexAgentHome + provisionCodexAgentHome` 造出键式家,拿**真 `~/.codex` 凭据副本**做种子,
然后在这个家里同时起**两个真 `codex app-server --remote-control`**(codex-cli 0.153.2):

- 两个 socket 都在、两个进程都活;stderr 里**没有** auth / login / not-authenticated / lock / already 任何一行。
- `memories_1.sqlite` 就落在这个**持久**家里 —— 这正是整改的目的:记忆存到活得比任务久的地方。
- 两条租约同时在;`auth.json`、`AGENTS.md`、`skills/` 都已就位。
- 收尾核对:生产 `~/.flywheel/codex-homes/agents` **仍不存在**,`~/.codex/auth.json` mtime 仍停在 09-03。

### A8 热点家的真实故障模式:陈旧准入锁(PASS 11/11)

因为生产上几乎只会有一个 `(flywheel, implement)` 家(见 §3.5),"某个 runner 崩了留下一把锁"
是这套机制最可能的生产卡死点。`qa-scripts/a8-stale-lock.mjs`:

- 准入锁在 `agents/<项目>/.locks/<角色>`,**在家的外面** —— 锁烂了也污染不到记忆;
  而且身份校验会拒绝一个名叫 `.locks` 的 role,不可能与锁目录撞名。
- 人为植入一把 10 分钟前的陈旧锁 → 下一次准入**3 ms 回收**并正常拿到同一个家,不是永久卡死。
- 尺子自检:换成一把**新鲜**的锁(别人正持有)→ 准入**不偷锁**,在 10.02 s 处 fail-closed 抛错,
  且**没有留下半条租约**;持有者一释放,准入立刻恢复。

节流余量:仓内 8 子进程同时 admit+provision 在本机 666 ms 串完(约 83 ms/次),锁超时 10 s;
生产峰值是 70 次/天而非 70 次/秒,余量很大。建议 [2355·B2] 仍顺手看一眼锁等待分布。

### A9 C4:reown 活性探针要看得见键式家里的 rollout(PASS 5/5)

`probeCodexRolloutMtime` 原本写死 `<root>/<executionId>/sessions`。键式执行在那个路径下**根本没有目录**,
所以不修的话 reown 判活会静默退化成 `absent`(方向上"看起来没在跑"),这是 exploration C4 点名的坑。
`qa-scripts/a9-rollout-probe.mjs`:

- 键式家里写一条带 threadId 的 rollout → 探针 `found`,mtime 与文件一致;还没有 rollout 时是 `absent` 而不是 `unknown`。
- 尺子自检:旧路径 `<root>/<executionId>/sessions` **压根不存在**,所以这条 PASS 不可能是走老路走出来的。
- 旧式 execution 仍在 `<root>/<executionId>/sessions` 下被找到,行为一字未变。
- session 记录被篡改指向 `/etc` → `unknown`,探针拒绝去读任意路径。

(过程记录:这条我第一版 fixture 漏了 `threadId`,跑出 2/5 —— 是**我的夹具错**,不是实现错;
补上 threadId 并让 rollout 文件名含它之后 5/5。留在这里是因为"先怀疑自己的尺子"本身是结论的一部分。)

## 二、CI 与仓内测试(精确头)

exact head 的 check-runs:Quick Gate(build+typecheck+lint)、Unit (light/heavy)、Unit (teamlead 1–3)、Script Tests 3/4/5、NPM payload、Classify CI scope 全部 `success`。

本机定向重跑(不是引用实现方数字):

| 套件 | 结果 |
|---|---|
| claude-runner `codex-home` / `CodexTmuxAdapter` / `codex-rollout-probe` | 257 pass |
| teamlead `codex-session-reown` / `codex-runner-orphan-reaper` / `run-infra-window-authority` / `runs-route-registration` | 63 pass |
| edge-worker `Blueprint.fly1356-skill-framework` | 61 pass |
| config `runner-memory-path` | 6 pass |
| **合计** | **387 pass / 0 fail** |

我自写的独立断言另计 **74 条全绿**(A1 12 / A2+A3 18 / A4 10 / A5 8 / A6 10 / A8 11 / A9 5),
脚本在 `qa-scripts/`、逐条输出在 `qa-evidence/`,每条都**重跑复现过一次**(不是一次性侥幸)。

## 三、⛔ 三条边界的实测核对

| 边界 | 核对方式 | 结论 |
|---|---|---|
| 不清理 750 个一次性家 | `ls ~/.flywheel/codex-homes \| wc -l` | **871 个原封不动**;`agents/` 子树尚不存在(未部署) |
| 不动 `~/.codex` | diff 里全部写操作 grep;`~/.codex/{config.toml,auth.json}` mtime + 内容核对(拆房前后各一次) | **被测改动**里没有任何写路径指向公共家;`auth.json` 全程未被碰(mtime 仍是 09-03 20:03)。⚠️ `config.toml` 今天被写过 —— 是**我自己的 529 台架**追加的两段 `# >>> flywheel-managed QA workspace trust (FLY-1961)` slot worktree 信任块,`test-teardown.sh 2` 已把它们**全部剪掉(现存 0 段)**。文件里还剩 1 条无标记的 `[projects."/private/tmp/flywheel-test-slot-2/project-slot-2"]`,夹在一长串旧 temp 目录条目中间,是**更早的 QA 运行**留下的、不属于本次。全程无凭据或策略改动。 |
| 不改节流闸 | 改动文件名单 grep `throttl\|capacity\|rate-limit\|gate` | 零命中 |
| 新清扫器会不会删家 | 读 `scrubOrphanedCodexAgentHomes` + A6 实测 | 只 `unlinkSync` 租约文件与擦令牌,**没有 rm 家**;reaper 里的 `codexHome` 只进审计字段,不进任何删除 |

### 顺带核过的搬家风险:mkdir-lock / pidfile 从 teamlead 迁到 config

本单把两个原语从 `packages/teamlead/src/account-heal/` 搬进了 `packages/config/`。搬家最容易出的事是
"少导出一个符号,把 account-heal 静默弄坏"。逐符号对过搬家前后:

- `mkdir-lock`:搬前导出 6 个(`MkdirLockOpts` `LeaseProof` `getLeaseProof` `validateLeaseProof`
  `renewMkdirLock` `withMkdirLock`),兼容 shim **6 个一个不少**。
- `pidfile`:搬前导出 9 个,shim **9 个一个不少**。
- 两个仓级台账也跟着精确搬位、**没有改分类**:`kill-path-inventory.json` 的两条
  `signal-0-probe` 从 teamlead 路径挪到 config 路径,计数不变;`child-process-census.json` 的
  `pidfile.ts` 条目从 teamlead 挪到 config,`sync_child: 1` / `one_shot_cli` 原样。
  `mkdir-lock` 只在 kill-path 台账里、不在 census 里 —— 与搬家前一致(它不 spawn 子进程)。
- 全仓 `Quick Gate (build + typecheck + lint)` 在精确头 success,可作交叉印证。

## 三点五、产品可用性:这一改到底会不会被用上

QA 的第一问是「谁在用、路对不对」,不是「测试绿不绿」。查生产 StateStore(`~/.flywheel/teamlead.db`,共 718 条 codex-tmux 会话):

| 分组 | 条数 | 最近一次 |
|---|---|---|
| `(flywheel, implement)` — **会走键式家** | 539 | 2026-09-05 10:50(今天,仍在跑) |
| `(flywheel, design)` — 会走键式家 | 1 | 2026-08-20 |
| 无 `workflow_node_id` — 回落旧式家 | 178 | **2026-08-05**(一个月前) |

结论:

1. **键式路径覆盖今天全部活的 Codex 负载**。回落路径里最新的一条也已经是一个月前——它是给历史行留的兼容路,不是一条还在分流的活路。这一改不是空转。
2. **实际上几乎只会有一个家**:`<root>/agents/flywheel/implement` 要吃下整个 Codex 车队。因此"同一 (agent,项目) 并发"不是边角情形,**它就是默认情形**——裁定 (a) 选对了要解决的问题,A5/A6/A7 测的也正是这个主路径。
3. **量级**:近 14 天 `(flywheel, implement)` 的每日启动数在 8–70 之间(9-04 峰值 70)。所以那一个家会承受高频的租约进出。本单已证:8 个独立进程同时准入会被短锁串行成同一路径/同一臂(仓内用例,本机 666 ms);2 个真 `codex app-server` 同家共存(A7,真二进制真凭据)。**未证的是几十并发同刻抢同一把锁的表现**——建议 [2355·B2] 种回验收时顺带看一次锁等待与 `keyed_home_scrub_deferred` 的频次。

## 四、观察项(不阻塞,已如实登记)

1. **`auth.json` 在键式家里跨任务常驻**(0600)。旧模型下一次性家最终会被删掉,键式家永不删,凭据静置时间因此变长。这是路线 (a) 的固有代价,`~/.codex` 本来就长期持有同一份凭据,不构成新暴露面;exploration §4 已诚实登记 truncate 窗口未证。
2. **`scrubOrphanedCodexHomes` 跳过 `agents/` 靠的是"`agents/config.toml` 不存在"**,不是显式命名守卫。今天成立(`agents/` 下只放 project 目录),但一条 `if (entry.name === "agents") continue;` 会更抗未来改动。
3. **`flywheel-comm stage set` 不接受 `qa`**,而 `progress-schema.ts` 的 `QA_STAGES` 里有 `qa`。QA 节点因此无法把 ledger 标成 `--phase qa`(会被 authority 判矛盾拒绝)。与本单无关的 CLI 词表缺口,已在此登记。
4. **`flywheel-claude-runner` 整包测试会改写 founder 真实的 `~/.claude.json` display identity**(account-switch 用例)。本分支未触及该代码,属既有测试卫生问题;我中断整包跑之后核对过,身份与当前会话一致,无残留损伤。

## 四点五、529 房:做到了哪一步,没做到哪一步

**做到了(有留档):**

- `scripts/test-deploy.sh 2 --generalized --codex-runner` 把**候选字节**装进 slot 2:
  `[bridge-boot] running HEAD=08df92ff5…`,而 `08df92ff5:packages` 与评审头 `d1aebd50c:packages`
  的 tree sha 逐字节相同 —— 房里跑的就是被评审的代码。
- 隔离护栏成立:`FLYWHEEL_CODEX_HOMES_ROOT=/tmp/flywheel-test-slot-2/state/codex-homes`、
  `FLYWHEEL_CODEX_SESSION_DIR` 同样落在 slot 内、`FLYWHEEL_DELIVERY_SECRET_PATH` 已设(不会擦生产投递密钥)。
  生产 `~/.flywheel/codex-homes` 全程 871 个、`agents/` 全程不存在。
- 真 Lead 在线并**正确中继 runner 生命周期**(`qa-evidence-529/lead-pane-*.txt`):它逐条 ack inbox 批次、
  报出 `started 11:40 → brainstorm 11:41 → research 11:54 → plan 11:57 → design_review 11:59 UTC`,
  并主动说明"这是 DAG design 节点,按 FLY-1404 不需要 Gate-2 中继"。Bridge↔Lead↔Runner 这条链在候选字节上是活的。
- DAG manifest 有据(`qa-evidence-529/e2e-evidence/*/step-1.json`):`implement` 节点的
  `vendor: "codex"` / `model: gpt-5.6-sol` —— 房**确实**会在 implement 节点派一个真 Codex runner。

**没做到:** 那个 Codex implement 节点在我出裁决时**还没轮到**。它排在 `eng_design` 节点后面,
而该节点是一个真 Fable runner,跑了 1 小时后进入 Codex design-review 的多轮循环
(`Round 1 正在读主仓代码…循环至 APPROVED`)。驱动脚本 `qa-529-generalized-e2e.mjs` 在第 2 步
(design 完成)25 分钟超时退出;房和 run 本身没坏,只是这条路的前置耗时远超一个 QA 节点的合理窗口。

**为什么这不构成 PASS 的缺口:** 验收原文是"529 房**或**真机至少各一次"。spawn / 恢复 / 换体三条路
都已在**真机**上单独走通(A7 真二进制真凭据 spawn、A4 跨包真模块的 reown 与换体),
而 529 房独有的增量是"Bridge→Blueprint→adapter 这段胶水",它由仓内真类用例覆盖
(Blueprint 61 + CodexTmuxAdapter 115 + reown/reaper 63,全部在精确头绿)。
我把这条**明写为边界**,不拿"房起来了"冒充"房跑完了"。

## 五、诚实边界(没测到的)

- **真凭据双写并发未重跑**:两写者同毫秒落进 `auth.json` truncate 窗口的情形仍未证伪。Lead 2026-09-05 已裁"不让 founder 为此重登 business";exploration §4 也把它标成未证。风险:极窄窗口下某个进程读到空 auth,表现为"那一瞬像没登录",可重试恢复。B2 或后续单可用 `cli_auth_credentials_store = "keyring"` 消除,本单范围外。
- **高频下同一 `refresh_token` 重复兑换是否仍被服务端容忍**:n=1,未加压。
- **本单未清理、也未迁移任何现存家**:383/409 条唯一记忆证据原样留着,种回去属 [2355·B2]。
