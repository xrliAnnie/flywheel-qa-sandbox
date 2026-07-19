# FLY-1338 CI 分层 + 并行 — QA 验证报告

Issue: FLY-1338 (https://linear.app/geoforge3d/issue/FLY-1338/cycle-time-ci-分层-并行-单轮-ci-墙钟砍半)
日期: 2026-07-18
基于: plan.md（实施计划）+ 分支 head `ed30d163b` 的真实 CI 运行

**结论：PASS。** 两条验收线都拿到真机数据 —— 墙钟 18m09s → 5m17s（-71%，目标是"砍半"），
覆盖 1000 → 1000 个测试文件（逐包逐字相等）。下面每条都写明"用什么证据、怎么反证的"。

---

## 1. 墙钟对比（issue 的第一条验收线）

| | before | after |
|---|---|---|
| run | 29646776775（main `db5e8923`） | 29657646468（head `ed30d163b`） |
| 墙钟 | **18m09s** | **5m17s** |
| 关键路径 | Build & Test 单 job 18m06s | Unit (heavy) 5m08s |
| 计费分钟合计 | 18m59s（2 jobs） | 30m38s（9 jobs） |

- 目标 ≤9m30s、计划预期 ~6min → **实测 5m17s，超额达成**。
- 同 head 的前一轮（29657072789）5m24s，两轮一致，不是一次侥幸。
- 所有 job 同一秒（19:21:45）启动，`ci-ok` 19:26:56 才起 → **并行合同真的生效**，不是纸面配置。

## 2. 覆盖对账（第二条验收线 "不牺牲覆盖"）

从两轮真实 CI 日志里抽 `Test Files` / `Tests` 汇总，**不是**看代码推断：

- **测试文件数：1000 → 1000。** 逐包比对，非-teamlead 的 15 个包**每一个**文件数完全相同
  （26/29/18/2/98/76/12/4/1/6/3/11/60/33/6），teamlead 615 → 205+205+205 = **615**。
- **测试用例数：** 非-teamlead 逐包完全相同；teamlead 8688 → 2912+3262+2516 = 8690，
  **+2 = 本 PR 新增的两个测试**（SqliteOutboundDedupStore fresh-host + FLY-889 守卫挂载），账对得上。
- **shard 没有假拆分：** 每片 205 < 全量 615 —— 这正是"flag 被 pnpm 吞掉"的否证。
- **包集合层面：** `./packages/*` = 22 个包；matrix 三行解析后 = 1(teamlead) + 3(heavy) + 18(light) = **22，且两两不重叠**。

> 过程中的一个自我纠错：我先用 `vitest list --filesOnly --shard=k/3` 想本地验分片，三片都返回 615。
> 这不是"分片坏了"，是 **`list` 忽略 `--shard`**（尺子坏了，不是被测物坏了）。真机 CI 的 205/205/205 才是 ground truth。
> 同理，我第一版用例数脚本报 +3592，排查后是**脚本把 script-tests 里 shell 套件的 `✓ … (2989)` 也算进去了** —— 解析器的锅，已修正后重算。

## 3. 守卫是不是"装饰性绿灯" —— 突变验证

只跑一遍看它变绿等于什么都没验。我另建 harness（假 repo root + 变异 ci.yml），
对 `ci-structure.test.sh` 跑 **17 个变异，全部按预期红，且 CONTROL 保持绿**：

| 变异 | 结果 |
|---|---|
| CONTROL 未变异 | ✅ GREEN（证明尺子不是恒红） |
| `-- --shard` 吞 flag 形式 | RED |
| 删掉 shard 2/3 行 | RED（`shards must cover 1..3 exactly once`） |
| 分母不一致 1/3,2/3,3/4 | RED |
| light 排除了别处没跑的包 | RED |
| light 自证覆盖（正 filter 挪进自己行） | RED |
| `fail-fast: false` 只留在注释里 | RED（证明不是 substring 假绿） |
| 删/替换 `${{ matrix.cmd }}` 执行步 | RED |
| 执行步加 `if: false` / `continue-on-error` | RED ×2 |
| ci-ok 去掉 `!cancelled()` | RED |
| ci-ok 少依赖一个 job | RED |
| ci-ok 的 jq 判定换成 no-op | RED |
| script-tests 被串行化（加 needs） | RED |
| timeout 退回 FLY-889 阈值以下 | RED |
| apt-get 重新拆成两步 | RED |
| `$HOME/.flywheel` 预建步骤回归 | RED |

FLY-889 vitest 守卫另跑 3 个变异：**改名 unit-tests job → 硬红**（正是它以前会"静默绿跳"的那个洞，
现在报 `ci.yml exists but jobs.unit-tests is missing`）；**删掉 ci-structure 挂载步 → 红**；
**script-tests timeout 调回 10 → 红**。两个守卫互防对方的执行 seam，成立。

## 4. 搬运保真度（步骤有没有在重排中丢掉）

用 PyYAML 解析 `main` 的旧 ci.yml 与新文件做机械对账：

- 旧 `build-and-test` 中 `Test` 步之后的 **22 个 shell 步骤，(name, run) 有序序列逐字相等**，
  末尾仅追加新守卫步 —— 无丢失、无重排。
- `quick-gate` 的 Build / Typecheck / Lint / Install 四条 run **与旧步骤逐字相等**。
- `payload-distribution` job **与 main 结构完全相同**（未被本次重构触碰，符合 plan §0）。

## 5. 计划外的产品代码改动 —— 是真 bug，不是为了让 CI 变绿

`SqliteOutboundDedupStore` 加了 `mkdirSync(dirname(dbPath), { recursive: true })`。
这超出 plan §0 的"不动包源码"，但**方向是对的**：分片把测试放进隔离 runner 后，
暴露出它一直依赖 `$HOME/.flywheel` 被别的测试**顺带**创建。

- 生产构造点 `plugin.ts:2075` 用的正是 `join(homedir(), ".flywheel", "codex-lead-outbound-dedup.db")`，
  即**全新机器上首次启动 Bridge（配了 apiToken）会炸**。
- 直接复现该失败形态：`TypeError: Cannot open database because the directory does not exist`。
- 突变验证：把 `mkdirSync` 删掉 → 新测试立刻红；恢复 → 9/9 绿。

值得表扬的是**中间那版走了回头路又改对了**：先在 ci.yml 里 `mkdir -p $HOME/.flywheel`（把 bug 藏起来），
后来撤掉、改成源码修复，并**加了一条守卫断言禁止那个遮蔽步骤回归**（我的变异 #17 验证了它有效）。

## 6. 本次 QA 新增的覆盖

`scripts/__tests__/ci-matrix-coverage.test.sh`（已挂进 script-tests job）。

**为什么需要它：** 现有守卫对 matrix 的最强断言是"逐字 pin 住 name/cmd"，
而这个 pin **天然由改 matrix 的人同步更新**（改行→改 pin→又绿了），所以它能发现意外漂移，
但**无法判断新的 filter 是否仍然覆盖整个 workspace**。绿色 CI 也证明不了 —— 跑得更少一样会全绿。
而"不牺牲覆盖"恰恰是本 issue 的验收线。

**它做什么：** 直接问 pnpm 在真实 workspace 上的解析结果，断言
① 所有 matrix 行的并集 == `./packages/*`（拆分前的测试目标）；② 各行两两不重叠。
它还能抓到 ci.yml 里根本看不见的漂移 —— **包被新增/改名/移动而 workflow 没动**。

**对它自己也做了突变验证**（否则我就是在提交一个空过的绿测）：
CONTROL 绿；light 的 glob 收窄成 `./packages/voice-*` → 红（报出漏掉的包）；
去掉 `!flywheel-comm` → 红（报重复计费的包）；heavy 指向不存在的包 → 红（报该行跑了零个包）。

跨端可跑性：macOS `/bin/bash` 3.2.57 与 CI 的 Linux bash 均实测通过（plan §7 的约束）；
CI 上的实跑输出也确认它真的执行了、不是挂着好看：`PASS: ... (22/22 packages, no overlap)`。

### 6b. 我这个守卫自己被 Codex 抓出两个假绿路径（已修）

我的守卫也过了一遍 Codex code review，**第一轮 CHANGES REQUESTED，两个 MEDIUM 都是真的**，
而且都是我本该防的那类「空过绿测」——它是用故障注入证出来的，不是嘴上说的：

1. **三处 `comm ... || true` 把比较失败吞掉了。** `comm` 在两个集合**有差异**时本来就返回 0，
   所以非零只可能意味着比较本身坏了（输入没排序 / 文件缺失 / 二进制坏）——恰恰是唯一必须 fail-closed 的情况。
   注入一个 `exit 42` 的 `comm` 后，脚本照样打印 `PASS` 退出 0。
   已改成每次比较写文件 + `if ! comm ...` 显式判状态，坏掉的 `comm` 现在直接判红。
2. **shard 去重键用在了每一行上，而不只是 shard 兄弟。** 于是一条重复的非-shard 行会被折叠进它的孪生行，
   pairwise-disjoint 检查根本看不到它——正是这个守卫存在的意义所在。
   已改成只折叠真正带 `--shard=k/N` 的行。

修完 Codex **第二轮 APPROVED**，并且它自己复验了两个注入现在都判红。我也重跑了全套：
坏 `comm` → 红；重复 `heavy` 行 → 报 overlap；shard 兄弟仍正确折叠（不误报）；
原来三个变异仍全红；bash 3.2 与 5.x control 均绿。

记在这里是因为它值得记：**一个“用来防假绿的守卫”自己带着假绿路径上线，是最不该发生的那种失败**，
而抓住它的是独立评审 + 故障注入，不是又一次「跑一遍看它绿」。

## 7. 需要 Lead / Annie 知道的（不阻塞发布）

1. **计费分钟 +61%**（18m59s → 30m38s / 轮），仓库是 **private**，所以这些分钟是要算钱的。
   这是并行换墙钟的必然代价，plan §6 已预估（估 +75%，实测 +61%，比预估好）。
   我**没能核实**当前 Actions 配额余量（`gh` token 缺 `user` scope，不猜）。
   如果余量紧张，plan §2 留了降级阀：teamlead 由 3 片降到 2 片。
2. **`Build & Test` 这个 check 名消失了**，取而代之是 5 个新 check + 聚合的 `CI OK`。
   已核实无影响：`ship-ci-guard.ts` 是按 bucket 判定、**不认名字**（任何非 pass bucket 都拒），
   仓库里出现的 "Build & Test" 字样全部只在测试 fixture 里；Free 计划无 branch protection，
   不存在按名配置的 required check 需要迁移。

## 8. 我没有验的

- 没有跑 flaky 治理（plan §0 明确为非目标，正交另有 task）。
- 没有验 `ship-on-comment.yml`（plan §0 非目标）。
- 计费配额余量（见 §7.1，token 权限不足，如实标为未验证而非估个数字）。

---

**验证者：** 独立 QA session（非实现者），全部结论基于真实 CI 运行日志 + 本机可复现的突变实验。
