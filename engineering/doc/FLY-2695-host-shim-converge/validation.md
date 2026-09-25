# FLY-2695 宿主 shim + converge 收敛 — 验证记录

Issue: FLY-2695 (https://linear.app/geoforge3d/issue/FLY-2695/raya-并仓s2-宿主-shim-converge-收敛raya-cosshl1-加载路径实机验证-codex-full-access)
日期: 2026-09-24
基于: plan.md(v3,Codex R3 APPROVED)

> 本页是实施节点对 plan §6 / 上游 FLY-2680 plan §12 S2 行 QA 判据 ①–⑥ 的**本地证据**。
> 全部夹具都在隔离目录里跑:没有写过生产 `~/.flywheel`、Raya 工作区、共享 Codex 登录态。
> 判据用退出码 + `Results: N passed, 0 failed` 计数,不用 grep 结论。
> 本机当时负载很高(load average 68–189),只影响耗时,不影响结论。

## 0. 结论总表

| # | 判据(上游 §12 S2) | 结论 | 证据 |
|---|---|---|---|
| ① | 隔离 `FLYWHEEL_STATE_DIR` 跑收敛器:shim 出现、555、sha == repo 源 | ✅ | §1(C13 + 手工复现) |
| ② | 无 `host.json` 解析到 `$HOME/Dev/flywheel` | ✅ | §2(S1) |
| ③ | `raya-cos.sh status` 返回 `.schemaVersion==2 and .operations==[]` | ✅ | §3(S7);另见 §3 的精度更正 |
| ④ | Codex full-access 沙箱能执行它 | (A) ✅ /(B) ✅ | §4 |
| ⑤ | packaged 阴性对照:预置后收敛,shim 与 marker 消失、无关文件保留、0 `srcmissing` | ✅ | §5(C15/C15b) |
| ⑥ | retired/residue 合同落地 | ✅ | §6(C15–C17、C19、脚本注释里的 forward-rollback 四步) |

## 1. ① 收敛器装入 shim

**套件**:`bash scripts/__tests__/converge-flywheel-bin.test.sh` → `Results: 28 passed, 0 failed`。
C13 用的是**本 PR 的真 shim 字节**(不是 stub):rc=0、`cmp` 等于源、sha256 与仓库里的 `scripts/raya-cos.sh` 相同、mode 555、
`out.log` 含 `first managed adoption recorded: raya-cos.sh`、**0 条告警**、marker 600 且含 `managed=raya-cos.sh`。

**手工复现**(plan §6 ① 的手工形态;假 repo 里收敛器与 shim 是本 PR 真件,其余 FILES 为 80 行 stub):

```
converge rc=0
[converge-bin] repaired: raya-cos.sh (bin was 0B sha missing; now repo 7c490c55050e)
[converge-bin] first managed adoption recorded: raya-cos.sh (expected rollout; alert suppressed once)
-r-xr-xr-x  1 xiaorongli  wheel  3129 …/state/bin/raya-cos.sh
mode=555
7c490c55050efa4c4232790f4993f442bc6141af70cb0b77f540604742151cc4  …/state/bin/raya-cos.sh
7c490c55050efa4c4232790f4993f442bc6141af70cb0b77f540604742151cc4  …/scripts/raya-cos.sh
-rw-------  1 xiaorongli  wheel  95 …/state/state/converge-adoptions/raya-cos.sh
managed=raya-cos.sh
sourceSha=7c490c55050efa4c4232790f4993f442bc6141af70cb0b77f540604742151cc4
alerts mentioning raya-cos: 0
--- second run (steady state):
converge rc=0 alerts=0 raya-cos-lines=0
```

(第一行的 `repaired:` 是收敛器对「安装」的统一日志词;告警是否发出由首次采纳白名单决定,这里 0 条。)

## 2. ② 默认解析

`bash scripts/__tests__/raya-cos-shim.test.sh` → `Results: 9 passed, 0 failed`。
S1:`env -i HOME=<假 HOME> PATH=<只含 jq/uname/cat/dirname/node 的私有目录>`,无 `host.json`、无 `FLYWHEEL_DIR`,
假 HOME 里放了一个把 `FLYWHEEL_DIR` 指向别处的 `.flywheel/.env` ⇒ stub `cli.js` 回显的加载路径 =
`$HOME/Dev/flywheel/packages/raya-cos/dist/cli.js`,argv = `["status","--x","y z"]`,cwd 未变,`.env` 未被读。
S2/S3/S4/S5/S6 分别覆盖 ENV 优先、`host.json` 优先于默认、host-config 三级回退(缺三处 ⇒ 78)、
三种配置失败(dist 缺失 / `host.json` 畸形 / PATH 无 node)均 78;S5b(Codex 代码评审 R1 补):host-config.sh 存在但不可读或语法损坏也返回 78;S6:CLI 退出码原样透传。

## 3. ③ `status` 输出

S7:真 dist(`pnpm --filter flywheel-raya-cos build` 之后),`FLYWHEEL_DIR=<本 worktree>`,空临时工作区里经 shim 跑 `status`
⇒ `jq -e '.schemaVersion==2 and .operations==[]'` 为真。

🔴 **精度更正(research §5.3 / plan §5.2 S7 / §6.1 第 4 步写的「`status` 不落盘」不准确)**:
`status` 构造 `OperationStore`,其 `checkDirectories(true)`(`packages/raya-cos/src/operation-store.ts:66-89`)
会在 cwd 下 `mkdir` 出**空的** `state/cos/operations/`(0700)。它**不写任何文件**。
S7 的断言因此改为「工作区里没有任何非目录项,且新增的只有 `./state ./state/cos ./state/cos/operations` 三个目录」。
对 QA 的含义不变:仍然要在**空临时目录**里跑 `status`,不要在 Raya 工作区里跑(那里本来就有这棵树,但别去碰)。

## 4. ④ Codex full-access 沙箱

### 4.1 (A) 同版本策略复演 —— ✅

脚本:本节点 scratchpad `qa4a-seatbelt-replay.sh`(research §5 方法的施工版:目标换成**本 PR 的 shim**,夹具根放 `$HOME` 下)。
base policy 从 Raya 实际运行的二进制按字节切出:
`~/.codex-raya/packages/standalone/releases/0.156.1-aarch64-apple-darwin/bin/codex`
(`codex-cli 0.156.1`,sha256 `0196e89fe5a7598f816ee54232c3d7c26d75e502ab5cfe2c9240e81d90f7255a`),
起点是二进制里的 `(version 1)\n\n; inspired by Chrome's sandbox policy`,终点 `(allow file-read* (subpath "/Applications"))`,
11592 B;再拼上 workspace-write 组合段(读不限、`WRITABLE_ROOT_0` 可写且 `.git`/`.codex` 只读、`TMPDIR`、`/private/tmp`、网络开)。
PATH = `flywheel-lead.sh:8` 给 Lead 子进程的那一串。夹具:shim 以 555 装在 `$HOME/.fly2695-qa4a-*/state/bin/`,
**没有** `host.json` ⇒ 走默认 `~/Dev/flywheel`(生产 checkout,已有 dist)。

| 用例 | 结果 |
|---|---|
| P1 shim `status`(cwd = 工作区) | `{"schemaVersion":2,"operations":[]}`,rc=0;工作区只多出 `state/cos/operations` 空目录 |
| P2 shim `daily-report-migration-plan` | 正常 JSON,rc=0 |
| P3 shim `resume --input resume-input.json` | cos 自己的校验报错 `invalid resume input`,rc=1 —— 说明 argv 与工作区相对路径原样到达 CLI 且文件被读到 |
| P4 正对照:写工作区 | rc=0,文件存在 |
| **N1 负对照:写 `$HOME`** | `Operation not permitted`,rc=1,文件不存在 |
| **N2 负对照:写 `~/Dev/flywheel`(shim 执行的 checkout)** | `Operation not permitted`,rc=1 |
| **N3 负对照:写 shim 自己所在的 bin** | `Operation not permitted`,rc=1 |
| R1 沙箱内工具解析 | `/opt/homebrew/bin/node`(v25.6.1)、`/usr/bin/jq` |

边界(与 research §5.4 相同,诚实写明):证明的是 0.156.1 的**文件系统策略**允许这条路;
Codex 进程在策略之外做的事(env 策略、approval)不在其中;复演用 `-D` 传参,与 Codex 真实拼法语义等价但不保证字节一致。

### 4.2 (B) 真 `codex exec`(隔离 `CODEX_HOME`)

脚本:本节点 scratchpad `qa4b-codex-exec.sh`,完全按 plan §6.1:夹具根 `$HOME/.fly2695-qa-<ts>`(已断言不在 `$TMPDIR`、`/private/tmp`、
Raya 工作区之下),本 PR 的 shim 以 555 装入,`host.json = {"flywheelDir":"<本 worktree>"}`,工作区 `git init`,
二进制用与 Raya 相同的 0.156.1,`CODEX_HOME` 只含一份池快照 `auth.json`(不复制共享 config,不碰 `~/.codex/auth.json`),
`-s workspace-write -c sandbox_workspace_write.network_access=true -c sandbox_workspace_write.writable_roots=["<ws>"] -c approval_policy="never" --json`,
`< /dev/null`。回合后比对隔离 `auth.json` 与快照,**确认没有发生 token 轮换**。

**第一轮(17:5x PDT)**:所有非共享池快照都撞额度(`turn.failed` 事件原文):

| 池快照 | 结果 |
|---|---|
| personal | usage limit,至 Sep 29 16:51 |
| school | usage limit,至当日 20:06 |
| personal1 | usage limit,至 Sep 25 21:04 |
| personal2 | usage limit,至 Sep 27 14:25 |
| shopping | usage limit,至 Sep 25 15:06 |
| business | **未使用** —— 全队共享 `~/.codex` 与 `~/.codex-raya` 的在用账号;Lead 裁定(ask `4ee217ce`)不动它,等 school 重置 |

**第二轮(20:34 PDT,school 重置后)—— ✅ 通过;代码评审 R1 修复 shim 后于 20:55 PDT 在新字节上(HEAD `5f5e2182d`)原样重跑,结果相同,下面摘录取自重跑。**

夹具(`fixture.txt` 摘录):

```
T=/Users/xiaorongli/.fly2695-qa-1790308508 realpath=/Users/xiaorongli/.fly2695-qa-1790308508
TMPDIR=/Users/xiaorongli/.flywheel/runner-state/ad657cf3-…/browser-tmp
fixture root outside TMPDIR, /private/tmp and the Raya workspace: ok
shim sha256 repo=7c490c55050efa4c4232790f4993f442bc6141af70cb0b77f540604742151cc4 installed=7c490c55…51cc4 mode=555
host.json: {"flywheelDir":"/Users/xiaorongli/Dev/flywheel-FLY-2695"}
profile=school
codex binary=~/.codex-raya/packages/standalone/releases/0.156.1-aarch64-apple-darwin/bin/codex
codex --version: codex-cli 0.156.1
codex exec rc=0
isolated auth.json unchanged by the turn (no token rotation)
probe exists after turn: no
workspace files after turn (excluding .git): ./state ./state/cos ./state/cos/operations
workspace regular files (excluding .git): 0
```

生效参数(命令行显式传入;0.156.1 的 `--json` 流不回显配置事件):
`exec --skip-git-repo-check -C <T>/ws -s workspace-write -c sandbox_workspace_write.network_access=true -c sandbox_workspace_write.writable_roots=["<T>/ws"] -c approval_policy="never" --json`,stdin 为 `/dev/null`。

`exec.jsonl` 里的**工具执行事件**(原样,只截掉路径前缀;这是证据,不是模型的收尾回复):

```
item.completed command_execution
  command:   /bin/zsh -lc 'touch <T>/state/bin/probe'
  exit_code: 1   status: failed
  output:    touch: <T>/state/bin/probe: Operation not permitted
item.completed command_execution
  command:   /bin/zsh -lc 'env -u FLYWHEEL_DIR FLYWHEEL_STATE_DIR=<T>/state FLYWHEEL_HOST_CONFIG=<T>/state/host.json <T>/state/bin/raya-cos.sh status'
  exit_code: 0   status: completed
  output:    {"schemaVersion":2,"operations":[]}
turn.completed
```

断言:
- **负对照**:命令 (1) exit 1、`Operation not permitted`,回合后 `<T>/state/bin/probe` 不存在 ⇒ shim 所在目录在这个沙箱里不可写,它确实是沙箱外的只读入口;
- **正对照**:命令 (2) exit 0,stdout 经 `jq -e '.schemaVersion==2 and .operations==[]'` 为真;
- **cwd**:0.156.1 的 `command_execution` 事件没有 cwd 字段(键只有 `aggregated_output/command/exit_code/id/status/type`)。
  cwd = `<T>/ws` 的证据是 `-C <T>/ws`,加上回合后 `<T>/ws` 里出现了 `status` 才会建的 `state/cos/operations` 空骨架(§3);
  工作区里没有任何普通文件。

边界:这是隔离 `CODEX_HOME`(只含 school 快照的 `auth.json`,没有 Raya 本体的 config/MCP)下的一次 `codex exec` 回合,
与 Raya 生产载体(`codex app-server`)是同一版本二进制、同一沙箱合同,但不是同一进程形态;
宿主真路径 `~/.flywheel/bin/raya-cos.sh` 的检查仍在 A2-deploy(plan §7)。

## 5. ⑤ packaged 阴性对照

C15(预置-再断言,plan §6.2 🔴):`.flywheel-prebuilt` 哨兵 + 预置 555 旧 shim + 600 marker + `bin/unrelated-user-file.txt`
⇒ rc=0;shim 与 marker 均不存在(`-e`/`-L` 皆假);无关文件仍在;`out.log` 含 `retired removed: raya-cos.sh`;
告警恰好 1 条,签名 `raya-cos.sh|retired-removed`;告警与日志里 0 条 `srcmissing`。
C15b:再跑一次 ⇒ 0 告警、无 `retired removed`、无关文件仍在(幂等)。

设计阶段 research §6 C1 已证明「今天的 packaged 分支只是不管理、不会删除」,所以本条不是空转通过。

## 6. ⑥ retired/residue 合同

| 用例 | 证明了什么 |
|---|---|
| C16 | bin 只读 ⇒ 删除不可证 ⇒ rc=1 + `retired-unproven`,绝不报 `removed`;权限恢复后再跑 rc=0 且消失 |
| C16b | marker 的**父目录**不可遍历(`chmod 000 $ST/state`)⇒ `-e/-L` 双假不被当成「不存在」⇒ rc=1 + `retired-marker-unproven`;恢复后恰好 1 条 `retired-removed` |
| C17 | `FILES ∩ RETIRED_FILES` 非空 ⇒ 在任何写之前 exit 1(一个确实待修的 managed 文件仍缺失),0 告警 |
| C18 | 首次采纳并发:同步点让「对方」在本次检查之后、安装之前写好 marker ⇒ 仍走静默采纳;之后漂移照常告警 |
| C19 | retirement 并发:测试专用 `[` 函数在第一个为真的形态谓词之后删掉目标 ⇒ 修订后的顺序(file / link / absent)仍 rc=0、证明删除 |
| C19 变异对照 | **同一同步点**对**修订前**的谓词顺序(`-e && ! -f && ! -L`)跑 ⇒ rc=1 + `retired-shape-unsupported`。这把 plan §5.1 要求的「红/绿证据」固化进了套件,CI 每次都会复核同步点确实咬到了顺序 |

forward-rollback 四步写在 `scripts/converge-flywheel-bin.sh` 的 `RETIRED_FILES` 注释块里(含「旧版本收敛进程全部退出后才验证消失」的前提)。

### 6.1 先红后绿

- **C18 在 adopt_pending 修复之前是红的**(已加入 FILES 与白名单、但仍在安装后才查 marker):
  `[converge-bin] repaired: raya-cos.sh …` + 一条 severe `bin integrity drift repaired: raya-cos.sh`(签名 `raya-cos.sh|repaired|9b9eaa0ddd02`,当时的 shim 字节)。
  改为「检查前定资格」后转绿。
- C9d 计数 6 → 7:加入 shim 前的旧断言在新 FILES 下红,改后绿,并额外断言新增那条属于 `raya-cos.sh`。
- 三个兄弟夹具(plan §5.3)**未改枚举时**跑的结果:

| 套件 | 未改时 | 红因 |
|---|---|---|
| `converge-fly1389.test.sh` | rc=1,`9 passed, 13 failed` | 21 处 `repo source missing … raya-cos.sh`,0 处其他 srcmissing |
| `fly1577-cmux-bin-closure.test.sh` | rc=1,`7 passed, 25 failed` | 9 处 `repo source missing … raya-cos.sh`,0 处其他 |
| `fly1577-alert-arrival.test.sh` | rc=1,`4 passed, 10 failed` | 收敛 rc=1,线上多出第二个请求(真 `lead-alert.sh` 发出的 `raya-cos.sh` srcmissing 告警) |

改枚举后结果见 §7。

## 7. 本地目标化验证(实施节点规则:无本地全量套件)

构建:`pnpm install --frozen-lockfile`;`pnpm --filter flywheel-raya-cos build`;`pnpm --filter "flywheel-teamlead..." build`
(`flywheel-lead-packaging` 需要 TeamLead dist);`pnpm build`(`package-onboard-smoke` 需要全部 `PO_PACKAGES` 的 dist)。均 exit 0。
`pnpm lint` exit 0(`Found 27 warnings`,没有一条落在本次改动文件上);`shellcheck` 两个新文件 0 finding;
`converge-flywheel-bin.sh` 的 shellcheck 结果与改动前**逐条相同**(全部是 `strict_alert` 段的既有 SC1078/SC1079/SC1011/SC2016 与 SC1091)。
本 PR 不改 TypeScript,所以没有 `vitest related` 可跑。

| 套件 | 结果 |
|---|---|
| `converge-flywheel-bin.test.sh` | `28 passed, 0 failed` |
| `raya-cos-shim.test.sh`(新) | `9 passed, 0 failed` |
| `converge-fly1389.test.sh` | `22 passed, 0 failed`(改前 rc=1) |
| `fly1577-cmux-bin-closure.test.sh` | `31 passed, 0 failed`(改前 rc=1) |
| `fly1577-alert-arrival.test.sh` | `7 passed, 0 failed`(改前 rc=1) |
| `codex-quota-summary.test.sh` | 两条 PASS(改前 rc=1,见下) |
| `flywheel-lead-packaging.test.sh` | `PASSED=6 FAILED=0`(TeamLead dist 构建前有 2 条与本单无关的 dist 缺失红) |
| `packaged-seams.test.sh` | `PASSED=18 FAILED=0`(S7 packaged 稳态仍零告警) |
| `ci-shell-suite-enumeration.test.sh` | `346 shell suites are explicitly classified (293 CI, 54 manual-only)` |
| `lead-alert-strict-delivery.test.sh` | `31 passed, 0 failed` |
| `lead-backend-migration-wave.test.sh` | PASS |
| `resident-codex-lead-recover.test.sh` | `22 passed, 0 failed` |
| `restart-services-notify.test.sh` | `29 passed, 0 failed` |
| `provision-fleet-host.test.sh` | `20 passed, 0 failed` |
| `provision-prebuilt.test.sh` | `PASSED=6 FAILED=0` |
| `package-onboard-smoke.test.sh` | `PASSED=26 FAILED=0`(第一次跑时 `packages/inbox-mcp/dist missing`,是本地构建状态,`pnpm build` 后绿) |
| `scripts/test-restart-services.sh` | `175 passed, 0 failed` |
| `fly2102-flag-freeze.test.sh` | `PASSED=46 FAILED=0` |
| `node --test scripts/__tests__/raya-cos-cli-dist.test.mjs` | `pass 5, fail 0` |

**research §4 漏掉的第四个兄弟夹具**:`codex-quota-summary.test.sh` 用 package-onboard 的脚本白名单组装 payload,再手工补上 monorepo 专属的
`restart-services.sh`,然后分别跑 monorepo 与 packaged 两个分支。改动前,它在 `set -e` 下停在
`cp: …/payload/scripts/raya-cos.sh: No such file or directory`(rc=1)。修法与它处理 `restart-services.sh` 的方式对称:把 shim 补进 payload;
packaged 分支播种时跳过 shim(packaged 稳态本来就没有它,残留由 C15 覆盖)。

**消费者发现**(`git grep -lF`,排除 `engineering/doc`):

- `scripts/raya-cos.sh` / `raya-cos.sh`:README、四个收敛器测试、shim 测试、收敛器本身 —— 全部已跑或已改;
- `scripts/converge-flywheel-bin.sh` / 文件名:上表所有 `scripts/__tests__` 套件与 `scripts/test-restart-services.sh` **全部已跑**。以下未跑,原因如下:
  `packages/teamlead/scripts/claude-lead.sh`、`scripts/restart-services.sh`、`scripts/update-flywheel.sh` 是运行时调用方,只消费退出码,rc 语义没变;
  `packages/teamlead/src/LeadAlertNotifier.ts`、`bridge/alert-kind-copy.ts` 按告警 kind 出文案,kind 仍是 `bin_integrity_drift`,没有变;
  `scripts/lead-alert.sh`、`scripts/flywheel-node-dwell-control.mjs`、`scripts/verify-agent-visibility.sh`、`scripts/package-onboard.sh`、
  `scripts/package-onboard-files.allow` 只在注释里提到收敛器,或把它当作 payload 条目(shim 不进 payload);
  `doc/…`、`product/doc/FLY-1782-*` 是历史文档与快照;
- 新测试文件名:只有 `ci.yml`(已登记);`converge-fly1389.test.sh` 另被 `fly2102-flag-freeze.test.sh` 引用(已跑);
  `fly1577-cmux-bin-closure.test.sh` 另被 `scripts/lib/path-hygiene.sh` 注释引用(不执行);
- 父目录:`scripts/__tests__/`(99 个文件)、`scripts/lib/`(327 个)范围太宽,由上面按文件名的 grep 覆盖;`packages/raya-cos/` 的 4 个命中已全部覆盖。

exact-head 全量 CI 归 QA(frozen head);本节点没有请求 full CI。

## 8. plan 与现实的偏差(PR 描述「plan vs 现实」一节同步)

1. shim ≥1024 B(`scripts/lib/script-sanity.sh:24` 的不可调门槛),实为 3129 B,体积靠实质注释;S0 在 CI 拦「被删瘦」。
2. QA ③ 判据用 `.schemaVersion==2 and .operations==[]`(真实输出 `{"schemaVersion":2,"operations":[]}`)。
3. FLY-2657 已合入并切换过一次 ⇒ 上游 §9.4 第一行情形;S2 仍纯增量,部署后生产 Raya 行为零变化。
4. 沙箱验证分两层:(A) 同版本策略复演 ✅;(B) 隔离 `CODEX_HOME` 真 `codex exec` ✅(第一轮撞额度,school 重置后通过),见 §4.2。
5. **新发现**:`status` 会在 cwd 建空目录骨架 `state/cos/operations/`(不写文件),research/plan 写的「不落盘」不准确,见 §3。

## 9. 证据与最终字节的绑定

Codex 代码评审 R1 提出 1 条 MEDIUM:host-config.sh 存在但加载失败(不可读、语法错)时,shim 在 `set -e` 下以 `source` 自己的状态(1/2)退出,
而不是 78。先补 S5b 让它变红(实测 rc=1/2),再修。修的过程中又发现 **macOS `/bin/bash` 3.2 在 `set -e` 下,`source` 失败即使写成
`source … || fail` 也会直接退出**(bash 5 不会)——生产 shebang 恰好是 3.2,所以改成 source 前后临时关掉 errexit,再检查状态。S5b 转绿。

shim 字节因此从 `9b9eaa0d…`(2748 B)变为 `7c490c55…`(3129 B)。以下证据都已在**新字节**(HEAD `5f5e2182d`)上重跑,结果与首轮相同:
§1 的手工收敛复现、`converge-flywheel-bin.test.sh`(28/0)、§4.1 的 ④(A)(P1–P4 正对照通过,N1–N3 负对照均为 `Operation not permitted`)、§4.2 的 ④(B)。
本页引用的 sha 都是新字节的值。
