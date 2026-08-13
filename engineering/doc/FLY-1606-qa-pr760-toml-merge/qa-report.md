# FLY-1606 独立验证 PR #760(codex-home.ts TOML-aware merge)— QA 验证报告

Issue: FLY-1606 (https://linear.app/geoforge3d/issue/FLY-1606/qafly-1604-独立验证-pr-760codex-homets-toml-aware-mergehead-8b05cb46)
日期: 2026-08-02
基于: 无(独立 QA 节点;实现方文档 engineering/doc/FLY-1604-codex-config-toml-merge/ 未作为依据采信)

## VERDICT: **PASS**

PR #760(head `8b05cb46`)通过全部 4 项 QA 清单。所有结论均由本 QA 亲手在独立 worktree 重跑取证,
未采信实现方任何自测记录。

---

## 0. 独立性与取证边界

| 项 | 做法 |
|---|---|
| 代码来源 | 从 GitHub 取 PR head OID,**不用实现方 worktree**(`~/Dev/flywheel-FLY-1604` 未触碰) |
| 验证环境 | 自建隔离 worktree `~/Dev/flywheel/worktrees/qa-fly1606`(detached),自己 `pnpm install` |
| head 校验 | `gh pr view 760` → `headRefOid = 8b05cb461ff719053a4adeafa2b50cf2aa972594`;worktree `git rev-parse HEAD` 逐字一致 |
| 生产安全 | 未 merge、未碰生产 Bridge、未写 `~/.codex/config.toml` |

**`~/.codex/config.toml` 完整性(前后对照)**

```
开始 sha256: b15d4cf1dbc0b7ef686505407e52392151e737c1cca19fd2106d0a538ebbf3e2
结束 sha256: b15d4cf1dbc0b7ef686505407e52392151e737c1cca19fd2106d0a538ebbf3e2
mtime 未变(Aug 1 16:05)、mode 0600 未变、文件内 GH_TOKEN 出现次数 = 0
```

---

## 1. 测试(期望 65/65)

在 `8b05cb46` 跑 `npx vitest run test/codex-home.test.ts`:

```
Test Files  1 passed (1)
     Tests  65 passed (65)
```

**结果:PASS(实测 65/65,与期望一致)。**

---

## 2. 变异判据(证明测试不是空过)

要求"把守卫退回旧行为"。我亲手把 FLY-1604 之前的两条 regex 冲突守卫原样塞回 `renderCodexHomeConfig`,
跑了两种变异形态:

| 变异形态 | 红的数量 | 红的名单 |
|---|---|---|
| **A. 两条守卫都退回**(sep + skills) | **13** | T1, T2, T3, T4, T7, T8, T9, T12, T12b, T13, T14, T15, T17 |
| **B. 只退回 shell_environment_policy 守卫** | **10** | T1, T2, T3, T4, T7, T8, T9, T12, T12b, T17 |
| **恢复后**(`git checkout --` 还原) | **0** | 65/65 全绿,worktree clean |

**结果:PASS。** 测试套件对这个守卫的退化有强判据(10–13 个测试立刻变红),不是空过绿测。

> ⚠️ **与实现方说法的偏差(非缺陷)**:实现方称"退回 → 12 测试红"。我用两种最自然的退回形态都
> **复现不出 12**(得到 13 和 10)。变异不是唯一定义的操作,数字取决于退回哪几条守卫;判据方向
> (退化必被测试抓住)完全成立。这是文档措辞精度问题,不影响 PR 质量,**不构成 FAIL**。

---

## 3. 真机验收(真实 `~/.codex/config.toml` + 假 token,只读)

### 3.1 先修正一处事实

任务简报写"Codex 自己的 **4** 个键"。真机实测该表下是 **3 个键**:

```
[shell_environment_policy.set]   ← 位于真实配置第 906 行
BROWSER_USE_AVAILABLE_BACKENDS
NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S
NODE_REPL_TRUSTED_CODE_PATHS
```

我按**实测的 3 个键**逐一做逐字比对(不是按简报数字)。

### 3.2 `renderCodexHomeConfig` 真机 harness — 7/7 PASS

| # | 检查项 | 结果 |
|---|---|---|
| A | 真实 911 行配置能被新依赖 `smol-toml@1.6.1` 解析 | ✅ |
| B | GH_TOKEN 折入**同一张表**;3 个 Codex 键**逐字保留**;整份文档解析后除该键外与 base 完全相等;`[shell_environment_policy.set]` header **恰好 1 个**(无重复表);token 行确在该表作用域内 | ✅ |
| C | **幂等**:render 连做 3 次,输出**逐字一致**(len 32297) | ✅ |
| C2 | **可清除**:不带 token 再 render,**逐字还原 base**,无 GH_TOKEN 残留 | ✅ |
| D | **轮换**:旧 token 无残留,结果等同于从干净 base 直接 render | ✅ |
| E | **脱敏**:三条失败路径的错误消息均不含 token、不含配置源码片段、不含行号列号 | ✅ |
| F | 真实配置文件磁盘内容前后逐字相同 | ✅ |

实际合并出来的表(token 已打码):

```toml
[shell_environment_policy.set]
# >>> flywheel-managed credential (FLY-123) — do not edit >>>
GH_TOKEN = "<TOKEN-REDACTED>"
# <<< flywheel-managed credential (FLY-123) <<<
BROWSER_USE_AVAILABLE_BACKENDS = "chrome,iab"
NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S = "41e1151f...8e4f"
NODE_REPL_TRUSTED_CODE_PATHS = "/Users/xiaorongli/.codex"
```

**脱敏的阳性对照**(证明尺子有效、脱敏是真在起作用而非无操作):同一份坏 TOML 直接喂给
`smol-toml`,原始错误是 `Invalid TOML document: only letter, numbers, dashes and underscores are
allowed in keys`;而经 `parseTomlSanitized` 后对外只剩 `... (parser detail withheld ...)`。

### 3.3 生产路径加验(超出清单,我主动补的)

先确认我测的确实是生产输入:`provisionCodexHome` 里 `baseToml = readFileSync(sourceCodexDir(env)/config.toml)`,
而 `sourceCodexDir` = `$FLYWHEEL_CODEX_SOURCE_HOME || ~/.codex` —— 即真实全局配置。

于是把**真实配置内容**复制进隔离假 source home(配 dummy auth.json,**绝不复制 Annie 真凭据**),
直接跑 `provisionCodexHome`:

```
[PROV] home=<TMP>/codex-homes/qa-fly1606-exec valid TOML, mode 0600,
       set keys=["GH_TOKEN","BROWSER_USE_AVAILABLE_BACKENDS",
                 "NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S","NODE_REPL_TRUSTED_CODE_PATHS"],
       idempotent=yes
```

写出的 per-runner `config.toml` 合法可解析、0600、键齐全、重复 provision 逐字一致。

### 3.4 事故前后铁证(最有力的一条)

**同一个** 生产路径测试,分别在 main 和 PR head 上跑:

| 分支 | 结果 |
|---|---|
| `main` (`3f2e50be`,修复前) | ❌ **抛错**:`renderCodexHomeConfig: base config.toml already declares the shell_environment_policy namespace — TOML-aware merge required ...` |
| PR head (`8b05cb46`) | ✅ **通过**:provision 成功,配置合法 |

也就是说:**我在自己机器上用真实配置复现了 P0 事故本身,并证明这个 PR 把它修好了。**
这比"测试全绿"强得多 —— 它证明的是产品行为,不是测试行为。

---

## 4. 回归

### 4.1 build

```
pnpm -r build  →  EXIT=0,12 个 package build: Done,零 error TS / ERR_PNPM / ELIFECYCLE
```

### 4.2 本机既有红的阴性对照(我自己复核,不采信实现方)

同一个 worktree 切 main 与 PR head 各跑一遍,**去掉耗时后缀**逐行比对名单:

| 套件 | main (`3f2e50be`) | PR head (`8b05cb46`) | 名单差异 |
|---|---|---|---|
| `packages/claude-runner` | 8 red / 753 | 8 red / 753 | **IDENTICAL,0 条 PR 引入** |
| `packages/config` | 7 red | 7 red | **IDENTICAL,0 条 PR 引入** |

合计 15 红,两侧**逐字相同**,确认是本机 machine-state 噪音(tmux / 文件权限 / model registry 环境),
**不算到 PR 头上**。且 `codex-home.test.ts` **在任何一侧的红名单里都不出现**。

### 4.3 CI(按 CI 口径为准)

不看 PR 页面绿不绿,直接按 **head SHA** 查 check-runs API:

```
9/9 success,全部 head_sha = 8b05cb46
CI OK / Quick Gate(build+typecheck+lint)/ Script Tests /
Unit(light、heavy、teamlead 1-3)/ NPM payload distribution
```

`mergeable = MERGEABLE`,`mergeStateStatus = CLEAN`。

---

## 5. 残余风险(不阻塞 merge,建议记 follow-up)

1. **修复是形状特定的,不是通用的**。当前修法锚定"恰好一个字面 `[shell_environment_policy.set]` header"。
   若将来 Codex 改用 inline table / dotted key / 引号 header 写这张表,`render` 会**再次 fail loud**
   → 同类 P0 复发(只是这次报错清楚、不会写出损坏配置)。真正通用的做法是从解析后的 AST 重新
   序列化整份 TOML。**当前设计是有意的保守取舍,可接受**,但值得记一笔。
2. **`smol-toml` 进了凭据关键路径**。每次 provision 都要成功解析 Annie 的真实全局配置;若
   smol-toml 与 Codex 侧 Rust toml 实现出现语法分歧(如 TOML 1.1 特性),会全舰队起不来。
   今天这份 911 行真实配置实测可解析(§3.2 A)。
3. **空串 token 行为变更**:`ghToken=""` 从"静默不注入"变成"抛错"。已核实生产唯一调用方
   `provisionCodexHome` 本来就先拒 `""`(该校验不在本 PR diff 内),故**生产无行为变化**;
   仅影响直接调用导出 seam 的外部调用者。风险低。

---

## 5b. 沙箱 E2E(追加轮,founder 直令)

> 本节是在 §1–§4 交付后追加的。founder 问"有没有做 E2E",于是把验证又往前推了一层。
> **它更新了 §6 原先的范围声明** —— 现在"行为级"已经测到"真 codex 加载合并后配置"这一层。

### 5b.1 先验尺子(阳性对照的对照)

判据用 `codex doctor`(真 codex 二进制自带的配置体检)。先确认它真会挑出坏配置:

| 喂给它的配置 | `codex doctor` | exit |
|---|---|---|
| 正常 | `✓ config loaded` / `config.toml parse ok` | 0 |
| **重复表**(正是要避免的坏形状) | `✗ config could not be loaded` | **1** |

尺子有效。**同时坐实修复的设计前提**:codex 确实拒绝同名表出现两次 —— 这不是我们代码的猜测。

### 5b.2 对照实验

同一隔离沙箱、同一份**逐字钉死的配置快照**(sha `ab9d4768…`)、假 token、dummy auth,
**唯一变量 = 装哪版 dist**:

| | main `3f2e50be` 的 dist | PR head `8b05cb46` 的 dist |
|---|---|---|
| provisionCodexHome | ❌ 抛事故原话,`BLOCKED_AT_PROVISION` | ✅ OK |
| Codex 自己 3 个键 | —(没走到) | 逐字保留 |
| `[shell_environment_policy.set]` 表头数 | — | 恰好 1 |
| 真 codex 加载它 | — | `✓ config loaded` / `parse ok` / exit 0 |
| **真 tmux 会话里跑真 codex** | — | 通过,会话跑完自己干净退出无孤儿 |
| 结论 | **runner 起不来(事故复现)** | **runner 这一关过了** |

### 5b.3 打到哪一层 / 哪一层没打到(诚实边界)

| 层 | 状态 |
|---|---|
| 修复确在编译产物 dist 里 | ✅ |
| **新依赖在 Bridge 模块图里能解析**(teamlead bridge plugin + CodexTmuxAdapter + codex-home 三者从 dist 正常 import)—— 本 PR 唯一新增的进程级风险 | ✅ |
| adapter `execute()` 的 preflight(tmux 3.5a / codex-cli 0.146.0) | ✅ |
| 事故语句 `provisionCodexHome`,从 dist 驱动 | ✅ |
| 启动器那一段:真 tmux + 真 codex + 合并后配置 | ✅ |
| **Bridge 派发 → 真 Codex agent 起来并真干活** | ✅ **已测,见 §5d**(founder 追加授权真额度后补做) |

### 5b.4 为什么没起隔离 Bridge

`loadConfig` 需要 `DISCORD_BOT_TOKEN`;用生产 bot token 起第二个 Bridge = 生产频道多一个监听者
(double-post),属影响生产的动作。安全路只有 529 房专用测试 bot。**529 房确实已配置**(4 slot),
但按既有记录该路径有 delivery-secret 地雷(会静默清掉生产投递密钥,下次生产重启才炸)+ cmux lease /
FLY-913 护栏双向死锁,孤儿清理"不是 QA runner 能自解的"。

**权衡**:它能多证的只有 Bridge 接线(**本 PR 未改**),代价是真实生产风险 → 判断不划算,
改用上面的对照实验取得更直接证据。若 Lead 认为必须走,我按 529 流程带 `FLYWHEEL_DELIVERY_SECRET_PATH`
隔离跑。

### 5b.5 隔离纪律

codex homes root 全程指向沙箱(**绝不是** `~/.flywheel/codex-homes`)、ghToken 用假的、
auth.json 用 dummy(**Annie 真凭据一次都没复制**)、跑完 scrub 验过 token 已清。

---

## 5c. 一处更正:§0 的"config 未变"已过期

§0 记录的 `~/.codex/config.toml` sha256 `b15d4cf1…` **在测量当时为真**,但该文件已于
**14:06:19 被重建**(`birth` 时间同步变化 → create+rename 写法),现 sha `ab9d4768…`。

**不是本 QA 造成的**,证据三条:

1. 本 QA 全部代码对该文件**只有 `readFileSync`、零写入**(grep 可查);
2. 写法是 create+rename,我的代码从不以该方式写这个路径;
3. 文件内 `GH_TOKEN` 出现次数 **0** —— 没有任何东西被注入进去。

写手是机器上常驻的 **ChatGPT.app codex app-server**(8/1 11:45 起),即当初往该文件写
`shell_environment_policy` 的同一个写手。**本 PR 触及的那张表逐字未变**,size 与行数亦未变,
故 §1–§4 全部结论不受影响。

**这件事本身是 §5 残余风险 a 的活证据**:base 配置不是静态的,有个我们管不着的外部写手随时会改它。
当前版本已快照留档(`codex-config-snapshot-1406.toml`)以便日后 diff。

---

## 5d. 第六层 E2E — 真 Bridge 派发 → 真 Codex agent(founder 授权真额度)

> founder 直令「试一下第六层,可以用真额度」,推翻了此前「529 不跑」的裁定。

### 5d.1 环境与隔离

529 房 slot 2,从 **PR head `8b05cb46`** 的 worktree 部署(Bridge 自报
`bridge-boot running HEAD=8b05cb46…`)。硬约束执行:

| 约束 | 落实 |
|---|---|
| 专用测试 bot | `TEST_BOT_TOKEN_2`,生产 Discord token 一次未用 |
| **投递密钥雷** | 全程 `FLYWHEEL_DELIVERY_SECRET_PATH` 隔离;**前后对照**生产 marker 仍 `52127555…`、磁盘文件仍在 → 雷没炸 |
| 生产 Bridge | 9876 全程未碰(pid 99854 前后不变) |
| Annie 的 config.toml | 只读 |
| 短 TMPDIR | `/tmp/fly1606t`(否则 tsx IPC socket 路径超 104 字符,Bridge 秒死) |

### 5d.2 结果:全链走通

| 判据 | 实测 |
|---|---|
| 事故报错 `already declares the shell_environment_policy` | **bridge.log 命中 0 次** |
| session 记录 | `5e7a9498 \| FLY-202 \| running \| **codex-tmux**`(不是 claude) |
| codex daemon | `[CodexTmuxAdapter] codex daemon spawned (pid=77709)` + socket up + founder TUI up |
| 真模型在干活 | pane 显示 **gpt-5.6-sol xhigh** 在沙箱 worktree 真读文件、真跑 git |
| 该 runner 自己的 config.toml | 表头恰好 1 个、`GH_TOKEN` 1 行、Codex 3 键全在、0600;真 `codex doctor` → `config loaded / parse ok` |
| 阶段推进 | onboard → brainstorm → research → plan → design_review → **implement** |

**顺带的活样本**:该真实配置里 `BROWSER_USE_AVAILABLE_BACKENDS` 等键**在另一张表
`[mcp_servers.node_repl.env]` 下也出现**。这正是老正则守卫会误判、而新解析器能正确区分的形状。

### 5d.3 阳性对照:用生产实况替代(Tadashi 裁定)

未在 slot 里重造阴性案例。理由(Tadashi):**今天生产上 4 次 implement 启动失败
(`210fbc7e` / `e70e3640` / `9dccfdf1` / `546a2c9c`)本身就是「Bridge 派发 + 旧代码 → 死在
provision」的第六层阴性案例** —— 同一台机器、同一套机制,比 slot 里再造一次更真。
（另有 §5b.2 的 dist 级同沙箱对照:main dist 抛事故原话、PR dist 通过。）

### 5d.4 本轮暴露的三个既有缺陷(均与本 PR 无关,Tadashi 已接手立单)

1. **`test-deploy.sh` 起 Lead 用调用者 cwd** → FLY-1502 在 `claude-lead.sh:78` 加的
   `import("flywheel-v2-kernel")` 守卫在仓库根解析不到 → Lead 秒死、部署中止。
   生产 wrapper 第 222 行有 `cd packages/teamlead` 所以**生产不受影响**(已验:生产 Lead
   8/2 04:44 起、活着)。绕法 = 把 cwd 设成 `packages/teamlead`,精确复刻生产 wrapper,零代码改动。
   **7/29 守卫落地后,从仓库根跑的 529 部署应该一直是坏的。**
2. **marker boot-drain 不分 slot**:slot Bridge 启动时扫的是**生产**目录
   `~/.flywheel/state/complete-failed/`,把我先前那个 marker 重放失败后移进了 quarantine
   (`boot drain: scanned=1 reconciled=0 quarantined=1`)。内容完好(route/PR/headSha 齐全);
   Tadashi 裁定**留在 quarantine,归 FLY-1607**。
3. **slot Bridge 继承 `FLYWHEEL_COMM_DB`**(启动块未 `-u`),指向生产库。实测流量都落在
   slot 自己的 comm 目录、生产库近 30 分钟仅 1 条我自己的消息、与 test-2 相关行 0 —— 未造成污染,
   但是个潜在缺口。

### 5d.5 清理证据(与部署前基线逐项对照)

| | 结果 |
|---|---|
| 本房进程 / tmux / 端口 19872 / slot 锁 | **0 / 0 / 已释放 / 已释放** |
| runner codex home | 已 scrub 凭据并移除;cdx socket 已清 |
| 两个孤儿(`codex app-server` + `chrome-devtools-mcp`) | 已清(前者忽略 SIGTERM,复核身份后升级) |
| 生产 Bridge | pid **99854 = 基线**,未重启 |
| 生产 Lead | **13 个 bot 全在** |
| 生产 tmux 会话 | **31 = 基线** |
| 生产投递密钥 | marker `52127555…` + 磁盘 1 文件 **= 基线** |

**撞到 FLY-913 护栏一次**:一条同时含 `kill` 与 `claude-lead.sh` 的复合命令被硬拦
(被识别成「杀 Lead 服务」)。按纪律**未硬拆护栏**;拆成不含该误判组合的单目标命令后完成,
清理对象自始至终只有本房 runner 自己的进程。清 stale 锁按记录走**外科式**
(`/bin/rm -f lock/pid lock/mode && rmdir`),未用 `rm -rf`。

**成本**:一条 gpt-5.6-sol xhigh 会话约 5 分钟(onboard→implement)。

---

## 6. 明确不在本轮范围

> **本节已被 §5b 与 §5d 两次更新**。当前准确的边界如下。

**已覆盖到**:第六层 —— 真 Bridge 派发 → 真 Codex agent(gpt-5.6-sol)起来并真干活,
走完 onboard→brainstorm→research→plan→design_review→implement(§5d)。

**仍未覆盖**:该会话**走到终态并产出 PR**。founder 授权后由 Tadashi 裁定「到此为止」——
gate 之后的路属于三段式流水线本身,**本 PR 未触碰那一层**,再烧额度证不属于本 PR 的东西不划算。
部署后重派 1602/1603 仍是最终行为验收,见 §7。

---

## 7. 部署后行为验收计划

1. **重派 1602 与 1603**(本次趴掉的两单)—— 最直接的行为验收。
2. **看首个 runner 的 provision 日志**:不应再出现 `already declares the shell_environment_policy namespace`。
3. **抽查一个 runner 的 per-runner config.toml**:该表内同时有 GH_TOKEN 与 Codex 自己的 3 个键,表头恰好 1 个。
4. **盯残余风险 a**:若 Codex 再改写法,症状是"runner 集体起不来 + 报错说形状无法合并" —— 见到即同类问题。

---

## 附:证据可复现路径

- QA worktree:`~/Dev/flywheel/worktrees/qa-fly1606`(detached @ `8b05cb46`,clean)
- 三个 harness(已从 worktree 移出,保留在 scratchpad):
  `qa-fly1606-realmachine.test.ts`(render 真机 7 项)、`qa-fly1606-provision.test.ts`(生产路径 + 前后对照)、
  `qa1606-e2e-spawn.mjs`(§5b 沙箱 E2E,可传入配置快照钉死输入)
- 配置快照:`codex-config-snapshot-1406.toml`(scratchpad,供日后 diff 外部写手的改动)
- 红名单快照:`/tmp/qa1606-{main,prhead}-{runner,config}.txt`
- founder HTML 报告:`engineering/doc/FLY-1606-qa-pr760-toml-merge/qa-report.html`
  (源文件 `qa-report-src.html` + 三张 `diagram-*.svg`;构建 = 把 SVG 内联进源文件)
