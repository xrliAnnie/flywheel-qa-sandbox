# FLY-1944 宿主终端链收口(第二轮)— 独立 QA 报告

Issue: FLY-1944 (https://linear.app/geoforge3d/issue/FLY-1944/宿主终端链-tmux-统一升级-brew-护栏-cmux-守护看门狗并-19501951)
日期: 2026-08-22
基于: plan.md(第二轮)、design-correction-a2.md、PR #923

## 0. 结论

**FAIL** — 被测 head `1b82050f4` 的**自身 CI 是红的**,红因由本 PR 引入,且修复目前只以**未提交状态**存在于共享 worktree。
产品行为面我逐条独立复验,**全部通过**(细节见 §2–§5);返工面很窄,只有 §1。

被测 head:`1b82050f44888b69ec50dae3c869919cc14e6251`(= `origin/flywheel-FLY-1944`,QA 开始时为 `115139d98`;两者对 `scripts/` 的**产品代码**逐字相同,仅 `scripts/__tests__/ci-structure.test.sh` +4 行,故 §2–§5 的结论对当前 head 原样成立)。

## 1. 阻塞项(必须返工)

### F1 · [BLOCKER] 本 PR 引入的 `/private/tmp` 硬编码让 Linux CI 变红

- **外部铁证**:`gh run 32565128388`(head `1b82050f4`)→ `Script Tests 2/2 — fleet/setup/packaging` **fail**,失败步骤经 API 精确定位为 `Test — FLY-1330 log janitor`;`CI OK` 门同样 fail。该 job `runs-on: ubuntu-latest`。
- **根因**:`scripts/__tests__/flywheel-log-janitor.test.sh:783` 与 `:898` 用 `mktemp -d /private/tmp/f44sock.XXXXXX` / `f44unsafe.XXXXXX`。`/private/tmp` 是 macOS 专有路径,Linux 上不存在 → `mktemp` rc=1 → `SOCKET_ROOT` 为空 → 后续 fixture 全塌。
- **归属证明(不是既有伤)**:`git show origin/main:scripts/__tests__/flywheel-log-janitor.test.sh | grep -c /private/tmp` = **0**;`git diff origin/main...HEAD` 显示两处均为本 PR **新增行**。
- **本地复现**(把首选根换成不存在目录以模拟 Linux):committed head 下该套件 `24 passed, 4 failed`,其中 3 条正是本 PR 新增的 socket 用例:
  `tmux socket dry-run safety matrix` / `tmux socket apply safety/cap` / `unsafe tmux socket root was not fail-closed`。
  (第 4 条 `terminal-state parity` 是我沙箱缺 `packages/` 的 harness 假红,已排除。)
- **失败是响亮的,不是静默通过**——这一点是好的:红了就是红了,不会伪绿。
- **失败还会往工作树里拉屎(F1 的放大面,实测)**:`mktemp` 失败后 `SOCKET_ROOT` 为空,fixture 的 `os.path.join("", name)` 退化成**相对 cwd** 的路径 —— 我这次 Linux 模拟跑完,仓库根目录里凭空多出 `regular-file`、`socket-link`,以及 **9 个真 unix socket**(`dead-a.sock`…`recent.sock`)外加名为 `default` / `atlas` 的 socket。
  更棘手的是:**socket 文件 git 根本不跟踪**,`git status --untracked-files=all` 只看得见那 2 个普通文件,9 个 socket 完全隐形 ⇒ 靠 `git status` 把关的清洁度检查抓不到这类污染。我已全部清除并复核干净。

### F2 · [BLOCKER] 交接时共享 worktree 是脏的;修复未提交

`git status --porcelain` 在 QA 持棒期间显示 ` M scripts/__tests__/flywheel-log-janitor.test.sh`(mtime 02:40:33),内容正是 F1 的修法:
```
SOCKET_TMP_ROOT="/private/tmp"; [[ -d "$SOCKET_TMP_ROOT" ]] || SOCKET_TMP_ROOT="/tmp"
```
- 我**没有**提交、修改或推送这个文件(不是我的产出)。
- **我验证过这个修法是对的**:用忠实的 Linux 模型(首选根缺席 + fallback 指向**物理**目录,正如 Linux 上 `/tmp` 是真目录)重跑 → 3 条 socket 用例**全绿**(`27 passed`,仅剩上述 harness 假红)。
  - 更正一次自己的中间结论:我第一次把 fallback 直接设成 macOS 的 `/tmp` 时仍有 2 条红,一度要写成「修法不完整」;实因 macOS `/tmp` 是指向 `private/tmp` 的 **symlink**,触发 janitor 的 `socket-root-canonicalization-failed` fail-closed 分支 —— 是我的尺子不忠实,不是修法有问题。
- 结论:实现尚未收工。head 一旦补上这一提交并 CI 转绿,返工面即闭合。

### F3 · [MEDIUM] code review 的 exact-head 已漂移
gate `2c175499-a083-4617-8183-a2d56d02a947` 的 APPROVED 落在 `115139d98`;当前 head 是 `1b82050f4`,且还有一处未提交改动。两次改动都只碰测试文件,但 exact-head 不变量已破,复审归属请 Lead 裁。

### F4 · [MEDIUM] plan §8.6 要求的「PR-1b 三处登记」只落了 1 处
plan §8.6 明写 PR-1b(fork/cache 优化)**第二次顺延**必须登记在 **PR body + founder HTML + 里程碑**三处,理由是「不许静默消失」。实测:
- founder HTML `design-founder-r2.html`:有(1 处)✅
- PR body:**无** PR-1b / FLY-1929 字样 ❌ —— 且 PR body 里那句 "eliminate the review-found hot-path **fork** explosion" 极易被读成「fork 优化已交付」,恰好是该条款要防的误读
- `CLAUDE.md` 里程碑:**无**(`grep -n "PR-1b" CLAUDE.md` 零命中)❌;FLY-1944 行仍在描述第一轮、状态仍写 `PR #912`,未反映本轮 PR #923

## 2. 我独立复验通过的产品行为(逐条带证据)

### A2 · dead-view 只上报、零 mutation —— 真·成立,且有两道独立防线
- 出厂套件 `fly1944-dead-view-rebuild.test.sh` 5/5。
- **我给这把尺子做了阳性对照**:往 report-only 分支里注入一次绕过 guard 的真 mutation(`cmux_call_guarded true rename-workspace …`)→ 套件立刻 **2 passed / 3 failed**,断言 `ops=[rename-workspace …]`。⇒ 「零 mutation」断言不是空过绿。
- 另一次注入(走正常 `_attach_cmux_mutation`,action=close)套件仍绿 —— 查明是 `_attach_mutation_guard` 自己先拒了(载体重证不过)。即**守卫与断言是两层独立防线**,不是断言失效。

### A5 · close 后进程树归零 —— 出厂套件全是 mock,我补了真进程实测
出厂 `fly1944-helper-reap.test.sh` 13/13,但**全程零真实信号**(fixture 用假 PID)。plan §2.2 的 TDD 明确要求「真 helper + 真阻塞子进程 → 树归零」「抗 TERM 子进程实测计时」。我自建真进程探针补上:
| 场景 | 结果 |
|---|---|
| 真 2 进程树(sh → sleep),普通 TERM 可杀 | **1 个 tick / 783ms 归零** ✅ |
| 真 2 进程树,root+child 都 `trap "" TERM`(抗 TERM) | **2 个 tick / 2642ms 归零**(TERM→KILL 转换真发生)✅ |
| 同时在场的**无关 decoy 进程** | **两场都毫发无损** ✅ —— 归属严格锁在存档 tuple 上,没有外溢 |
生产每个 tick = 既有 15s 健康 tick ⇒ 抗 TERM 情形约 15–30s 收敛,守得住 A5 的 ≤60s。
harness 自带控制项(fixture 必须先通过 `_attach_reap_state_valid`),它当场抓出我自己的编码 bug(`sed | base64` 多了个换行 → 被 schema 拒),证明这个控制项有效。

### 信号投递上限(A5 fail-closed 边界)—— 行为对,但出厂无红得起来的测试
我自建探针 6/6:delivery 到顶 → 零信号 + `terminal-hold`;只剩一格 → 恰发 1 次再墓碑;预算健康 → 叶先根后完整 TERM 再进 `kill-pending`;墓碑后永远静默;12 轮累计投递 ≤ cap。
**负控**:把运行时那行 `if (( delivery >= max_deliveries ))` 改成 `if false` → 我的探针立刻红(2 failed)。
**但**出厂 `fly1944-helper-reap.test.sh` 在同一处突变下仍 **13/13 全绿** ⇒ 该运行时上限**没有红得起来的出厂测试**(出厂只测了 `attach_reap_limits` 的配置校验)。
缓解:`_attach_reap_state_valid` 的 schema 会拒 `delivery > max`,构成第二道独立防线(突变体第二轮即被冻结)。故列**建议**不列阻塞。

### adopt-cap 旋钮安全合同 —— 行为 13/13 全对,其中 symlink 那条出厂无覆盖
我自建探针逐条验:缺文件→1;3/10 接受;11、0、`abc`、多行、带空格 → 一律**禁用 adoption**;**symlink → 禁用**;路径是目录 → 禁用;cap=2 每 pass 恰 2 个槽;缺文件恰 1 个槽;不安全文件 0 个槽。
**但**把 `[[ -f … && ! -L … ]]` 改成 `[[ -f … ]]`(接受 symlink)后,出厂 `fly1944-birth-adoption.test.sh` 仍 **20/20 全绿** ⇒ plan §1.1 白纸黑字的 symlink 拒绝**无出厂覆盖**。同样列建议。

### S3′ janitor 死 socket 回收 —— 真机实测(真 socket + 真 tmux server)
在隔离物理路径造真 fixture:5 个真 AF_UNIX 死 socket(含 allowlist 名 `default`/`atlas`)+ **1 个真跑着的 tmux server** + 1 个 symlink + 1 个普通文件。
- `--dry-run`:3 个死 socket 报 `would-delete`,**目录前后逐字不变**(零 mutation)✅;allowlist / 活 server / symlink / 非 socket 全部精确 skip 且理由正确 ✅
- `--apply --force`(cap=2):**恰删 2 个**,第 3 个滚到下一轮;**活 tmux server 事后仍能 `list-sessions`**,allowlist 两个原封不动 ✅
- **阳性对照**:把 allowlist 与 live-probe 两道门同时拆掉 → `atlas`/`default` 立刻变成 `would-delete` ⇒ 我的 fixture 是有鉴别力的。顺带发现活 server 还有第二道独立防线(`lsof` 持有者判定),拆了 live-probe 也杀不掉它。

### perf 提交(`115139d98`)—— 收益属实,且**行为逐字未变**
- **差分**:自建 37 行语料(parse / variants / titlecand / shape / stock,含中文、空格、引号、坏 token、`bash -c` 包裹、legacy 单参、超长 argv),pre-perf 与 HEAD 输出 **byte-identical**(37/37,且非空过绿 —— 输出里有真实分类结果,零 unbound-variable)。
- **实测**(宿主真实 37 个 workspace 库存):`workspace_title_candidates` 平均 **3936ms → 83ms**(约 47×)。PR body 报的 3502→67.9ms 与我同量级。这对「新窗口 1 分钟内出镜像」的 SLA 是实打实的余量。

### 其余门(在被测 head 上我自己跑的)
| 门 | 结果 |
|---|---|
| `/bin/bash scripts/test-cmux-sync.sh`(macOS bash 3.2) | **575 passed, 0 failed**(PR body 写 574,我实测 575) |
| `fly1944-attach-protocol` / `birth-adoption` / `dead-view-rebuild` / `helper-reap` | 10 / 20 / 5 / 13,全 0 failed |
| `fly1663-cmux-v2` / `fly1884-attach-recovery` / `flywheel-log-janitor`(macOS) | 10 / 10 / 28,全 0 failed |
| `ci-structure` / `ci-shell-suite-enumeration` / `ci-matrix-coverage` | 全 rc=0 |
| `pnpm lint` | rc=0(7 条既有 warning) |
| `bash -n` × 5 个改动 shell 文件 + `shellcheck -S error` | 全过 |
| 4 个新套件是否真进 CI | **是**,`ci.yml` 已接线;`1b82050f4` 还把它们钉进 `ci-structure` 的精确顺序清单 —— **阳性对照**:从 ci.yml 删掉其中一条,该守卫立刻 rc=1 ✅ |

`pnpm -r build` / `pnpm test:packages:run` 我**没有全跑**,理由是可核的:本 PR `git diff --name-only origin/main...HEAD` 除 `scripts/` 与 `engineering/doc/` 外只动了 `.github/workflows/ci.yml`,**零 TS / 零 packages 改动**,包矩阵结果按定义继承自 main;而 CI 的 `Quick Gate (build + typecheck + lint)` 与 5 个 Unit job 在被测 head 上**全 pass**。

## 3. Discord surface(自持规则,不静默跳过)

diff **没有**碰 Discord 的 send / relay / render / founder 交互 / roundtable / 跨-Lead 协作代码;告警传输层 `scripts/lib/flywheel-alert-lib.sh` 与 `scripts/lead-alert.sh` **逐字未变**;`flywheel_alert` 在本仓 watcher 里只有 `cmux_cleanup` **一种** kind(无新增 kind,守住红线 1)。
本 PR 唯一的 Discord 侧效应是**新增告警内容**,真实风险是刷屏(FLY-218/220 那一类)。我按真机口径验了这一条:

**真 Discord N-to-N 段(隔离,零生产污染)**:用真 `_report_dead_attach_surface` → 真 `flywheel_alert` → 真 `lead-alert.sh`,路由到 **QA 测试 bot + QA 测试频道**(`product-lead-test`),claims.db / alert-queue / deadletter 全部指向隔离目录。
- 连发 4 次(3 次同 class `exited` + 1 次 `no-pty`)→ **真实只发出 2 条**(HTTP 200 ×2),同签名被进程内 latch 收敛 ⇒ **不刷屏**。
- **终点取证**:Discord API 回读 + Claude-in-Chrome 真实浏览器截图,两条消息渲染正确、可读、机器分类逐字保留(`class=exited` / `class=no-pty`)。
- **生产零污染**(前后快照):`~/.flywheel/alert-queue` 0→0、`alert-deadletter` 4359→4359、`alerts/claims.db` mtime 未变。

诚实边界:我**没有**往生产告警频道发过任何东西(会 page 到 founder),用的是 QA 隔离频道;FLY-529 的 `#test-flywheel-alerts` 镜像频道在本机确实存在,我选了 QA slot 频道,隔离性等价。

## 4. issue 三件事的整体状态(超出本 PR 的部分照实说)

| issue 条款 | 状态 |
|---|---|
| ① watcher 心跳/看门狗 + 新窗口 ≤1min 镜像 + fork 优化 | 心跳/看门狗第一轮(PR #912)已合;本轮把 surface 层收口 + 热路径提速 47×。**PR-1b(fork/cache 专项)仍未交付**,第二次顺延(见 F4) |
| ② tmux 全宿主统一 3.7c | **尚未执行**。实测宿主 `which -a tmux` 只有 `/usr/local/bin/tmux` = **3.5a**,`/opt/homebrew/bin/tmux` 不存在(第一轮 unlink 后的临时一致态)。工装已合入(`scripts/host-terminal-cutover.sh` 在 main),真变更按 plan §7 属 founder 授权的清空窗口运维段 —— 本 PR 不冒充已交付 |
| ③ 宿主工具链 brew 护栏 | **已交付并经我真机验证**。以真 Runner 身份(`FLYWHEEL_EXEC_ID` 在场)喂 hook:`brew install tmux` / `arch -x86_64 brew install tmux` / `env -S FOO=1 brew install tmux` / `brew link --overwrite` / `brew unlink` / `sh -c 'brew install tmux'` **全部 deny**;`brew list` / `brew --version` / `echo hello` 放行。并且核过**真正生效的那份字节**:`~/.flywheel/bin/flywheel-restart-guard.py` 与仓库副本 `diff` 一致,且已在 `~/.claude/settings.json` 的 hook 链上注册 |

## 5. 建议(不阻塞,交 Lead 判)

1. 给「运行时投递上限 → terminal-hold」补一条红得起来的用例(现有出厂用例改成 `if false` 仍全绿)。
2. 给 adopt-cap 的 **symlink 拒绝**补用例(plan §1.1 明写的合同,现无覆盖)。
3. 把真进程 reap 的最小实测(哪怕只留抗 TERM 那一例 + decoy 对照)沉淀进出厂套件,别只留 mock。
4. 补齐 F4 的两处登记(PR body + CLAUDE.md 里程碑),并顺手把里程碑行更新到 PR #923 / 第二轮口径。
5. `cmux_adoption_limit` 校验了 owner uid 与 symlink,但没查 cap 文件的 group/world-writable 位;plan 未要求,列为可选加固。

## 6. QA 自身的痕迹

- 全程**未修改任何被测源码**;所有突变实验都在 scratch 目录的副本上做,做完立即还原。
- 真机 fixture(隔离 tmux server、真 socket、真进程树、隔离告警目录)全部已清理;`pgrep` 复核无遗留;生产 `/private/tmp/tmux-501` 192 个 socket 数量未变,`default` / `atlas` 两个生产 server 事后仍可 `list-sessions`。
- Claude-in-Chrome 标签页已关闭释放。
- **未触碰** `progress.md`:更新它会产生一次 push 并再次推动 PR head,而本轮 head 已在漂移中 —— 这个取舍在此明记。
- 交接时 worktree 仍有一处**属于实现者的**未提交改动(F2),我刻意没有代为提交。
