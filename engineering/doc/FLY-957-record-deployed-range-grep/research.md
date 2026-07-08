# FLY-957 record_deployed_range 收尾 grep 杀死部署 — 调研

Issue: FLY-957 (https://linear.app/geoforge3d/issue/FLY-957/infradeploy-record-deployed-range-一行-grep-杀死部署收尾-无-pr-号-commit)
日期: 2026-07-07
基于: exploration.md

## 1. bash 语义确认(方案 A 的正确性依据)

方案 A 依赖两条 bash 手册明文语义,均已真机验证:

**(a) `set -e` 继承进管道子 shell。** `git log … | while …` 的 while 端跑在子 shell 里,继承 `-e`。循环体内 `pr=$(printf … | grep … | head …)` 这类赋值语句的 exit status = 命令替换的 status;`pipefail` 下 grep 无匹配(exit 1)使整条内层管道 = 1 → 赋值语句失败 → `-e` 杀死子 shell → 外层管道非零 → 函数所在语句失败 → `-e` 杀死整个脚本。这是 bug 的完整杀伤链。

**(b) `||` 列表触发 "-e 被忽略的上下文",且抑制**传染进复合命令/子 shell 内部**。** bash 手册(SHELL BUILTIN COMMANDS → set → -e):"If a compound command or shell function executes in a context where -e is being ignored, none of the commands executed within the compound command or function body will be affected by the -e setting…"。因此 `… | while …; done || true` 让整条管道处于 -e 忽略上下文:循环体里 grep 失败只让变量拿空串,**循环继续处理后续 commit**;同时 `git log` 自身失败(old SHA 不存在等)也被 `|| true` 吞掉——函数注释宣称的 "Fully best-effort / NEVER affects the deploy outcome" 契约由此结构性成立。

### 验证矩阵(全部真机跑过)

| 场景 | bash 3.2.57 (macOS /bin/bash) | bash 5.3.9 (homebrew) |
|---|---|---|
| 未修:subject 有 issue 无 PR | 脚本死,exit 1,后续语句不执行 | 同左 |
| 方案 A:三种形态混合(issue+PR / issue 无 PR / 全无) | 3 个 commit 全部继续处理,exit 0 | 同左 |
| 方案 B(grep 各加 `\|\| true`):同上混合 | 同上通过 | 同左 |
| `set -u` 对照(bug ②,已移出 scope) | n/a | n/a |

生产脚本 shebang 是 `#!/usr/bin/env bash`(解析到哪个 bash 取决于 PATH),两个大小版本都验证过 → 语义无版本风险。

## 2. 杀点与调用点普查

- 杀点:`restart-services.sh:46`(issue grep)与 `:47`(pr grep)。两者同类;近史里两种触发都真实存在(`49271b65 chore(ci): …` 无 issue 号;30+ 个 `chore(progress)`/direct commit 无 PR 号)。
- 调用点 3 处,全部裸调用(死 = 收尾死):
  - `:488` no-change 路径(范围内无文件变化,只推 sha);
  - `:503` no-restart 路径(docs-only 等,只推 sha);
  - `:1183` 完整 restart 路径(推 sha → `update_project_shas` → ✅ 播报)。
- wedge 动力学:sha 不推进 → 下次范围 = 同一杀手 commit ∪ 更多 commit → 再死。**自愈不可能**,只能人工推 sha 或修根因。

## 3. 方案对比结论(维持 exploration 推荐,gate 已批 A)

| | A:`done \|\| true` | B:两个 grep 各 `\|\| true` | C:A+B |
|---|---|---|---|
| 修观察到的 crash | ✅ | ✅ | ✅ |
| 逐 commit 继续处理 | ✅(-e 抑制传染) | ✅ | ✅ |
| git log 失败等其它失败模式 | ✅ 全挡 | ❌ 契约仍破 | ✅ |
| 改动量 | 1 行 + 注释 | 2 行 | 3 行 |
| 语义显性 | 隐晦(需注释+单测钉) | 局部自解释 | 冗余 |

**已定:A**(brainstorm gate 批复原文:"理解对、方案 A 批准…去实现")。隐晦性由代码注释 + CI 单测双重钉住:未来任何重构(如把管道改成 process substitution)破坏该语义,单测立刻红。

## 4. 测试基建调研

### 4.1 函数提取(防 drift)

`sed -n '/^record_deployed_range()/,/^}/p' scripts/restart-services.sh` 已验证:恰好取出完整 25 行函数(函数名与闭括号都在列 0,中间无列 0 的 `}`)。测试里 `eval` 该源码,**不**复制粘贴函数体——脚本改了测试跟着测新代码。提取结果为空时测试硬失败(防御 sed 锚点失效)。

注意:函数体用 `local`,必须在函数上下文里执行——提取的是完整函数定义再调用,满足。

### 4.2 沙箱设计(hermetic,对齐仓内既有测试风格)

仓内 shell 测试的既定风格(`scripts/__tests__/*.test.sh`,如 provision-fleet-host.test.sh / codex-log-guard.test.sh):`set -uo pipefail` 的 harness + pass()/fail() 计数器 + `mktemp -d` 沙箱 + `trap cleanup EXIT` + PATH shim 假外部命令 + 不碰真实 `~/.flywheel`/网络。新测试完全照此:

- **假 FLYWHEEL_DIR**:沙箱内 `git init` 一个真 repo(函数跑真 `git log`,不 shim git),并 `mkdir -p packages/flywheel-comm/dist && touch …/index.js` 满足函数的 `[[ -f "$comm" ]]` 前置。git 身份用 `-c user.name/user.email` 内联配置,不碰全局。
- **假 node**:PATH shim,把 `"$*"` 追加进捕获文件后 exit 0。函数以 `FLYWHEEL_BRIDGE_URL=… node "$comm" report-deployed …` 调用——env 前缀不影响 shim。
- **commit 形态与顺序**(git log 新→旧输出,继续性断言要求杀手 commit 比可上报 commit **新**):
  1. base(init,作 old 端,`old..new` 不含 old);
  2. `bump version (#99)` — 有 PR 无 issue(line 46 杀点回归);
  3. `feat(FLY-901): with pr (#465)` — issue+PR(完整上报形态);
  4. `docs: no markers at all` — 全无(应跳过,且是 line 46 杀点);
  5. `chore(progress): FLY-913 implement 1/5` — 有 issue 无 PR(**本次事故主形态**,line 47 杀点;最新,最先被读)。
- **断言**:
  - 主回归:`bash -c 'set -euo pipefail; …; record_deployed_range OLD NEW; echo FINALIZED'` exit 0 且输出含 FINALIZED(修复前:死、无 FINALIZED → RED);
  - 继续性:捕获文件里 FLY-913 之后(读取顺序)的 FLY-901、#99 都有上报记录;
  - 跳过:全无标记 commit 无记录;
  - 参数形态:FLY-901 行同时带 `--issue FLY-901` 和 `--pr 465`;FLY-913 行只带 issue;#99 行只带 pr;
  - 契约:old 传一个 40-hex 但不存在的对象(如 40 个 f)→ git log 失败 → 函数仍 exit 0(修复前同样死——`-e` 下管道失败即死)。
- harness 自身**不开 `-e`**(要断言子进程退出码),但被测函数在子进程里以生产同款 `set -euo pipefail` 跑——严格性等同生产。

### 4.3 CI 接线

ci.yml 的风格是每个关注点一个带注释的命名 step(FLY-519/882/697/880/913 皆如此)。新增独立 step(hermetic 声明照惯例写),不塞进 FLY-519 的 fleet block:

```yaml
      # FLY-957: record_deployed_range must never kill deploy finalization.
      # Hermetic — extracts the function from restart-services.sh, runs it under
      # set -euo pipefail against a throwaway git repo + a PATH-shim node; no
      # real ~/.flywheel, no network.
      - name: Test — FLY-957 record_deployed_range best-effort
        run: bash scripts/__tests__/restart-deployed-range.test.sh
```

既有 `scripts/test-restart-services.sh`(FLY-20,不在 CI)不受影响;实现阶段顺手跑一遍确认无回归即可,不改它。

## 5. 风险与边界

- 行为变化仅"不再杀死收尾":上报内容、dedup 键(merge_sha)、best-effort swallow(`node … || true`)全部不变。
- 上报丢失面:修复后即使某 commit 两个 grep 都失败,也只是跳过该 commit 的 fallback 上报(line 48 本来的设计),不影响 self-ship marker/ack 主路径。
- 不碰 `provision-fleet-host.sh` / `linux-preflight.sh`(bug ② 已归 FLY-648 PR #477,lead-instruction a23bf30e)。
