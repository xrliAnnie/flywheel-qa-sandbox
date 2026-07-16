# FLY-1272 cmux tab 名↔pane 内容串台 — QA 报告

Issue: FLY-1272 (https://linear.app/geoforge3d/issue/FLY-1272/fix-cmux-tab-名pane-内容串台-一个-tab-显示错的会话codex-单显示成-claude-husk今晚坑-founder)
日期: 2026-07-16
基于: plan.md (v28)、research.md (v24)、PR #622 @ `04e5669af`

**结论：PASS**（独立 QA，三段式 QA 阶段；实现由 implement 阶段完成，本阶段只验证、不重写）

---

## 1. 一句话

Annie 2026-07-14 的事故（tab 名 `FLY-1259-implement`，点进去是 FLY-1225 的 Claude husk）在真 tmux 上**被同一把尺子复现了**，而修复后的 linked view 对**同一次操作**结构性免疫 —— 不是"测试绿了"，是"能抓到 bug 的尺子在修复后读数干净"。

## 2. 我为什么不直接采信实现方的绿

实现方的 `test-cmux-sync-hooks-integration.sh` Scenario F 已断言「linked view 只持有目标 @id」。但它**从没证明这把尺子能看见事故本身** —— 一个从未打中过已知阳性的尺子，读数干净既可能是"修好了"，也可能是"这个 harness 根本没复现事故"（[[feedback_tool_success_line_is_not_evidence]] 的阳性对照规矩）。所以本阶段新增的核心物料是**带阳性对照的事故重放**。

## 3. 新增物料

`qa/qa-fly1272-incident-replay.sh`（真 tmux，隔离 socket `tmux -L`，不碰生产 server；10/10 PASS）

一把尺子 = `display-message -p -t "=<view>:" '#{window_name}'`（tab 实际渲染的窗口），量两个拓扑：

| 段 | 构造 | 结果 |
|---|---|---|
| **CONTROL**（A=0 legacy grouped，`new-session -t <source>`，即 `flywheel-cmux-sync.sh:2871/3142` 的原样路径） | 一个 runner session 两个窗：`FLY-1259-implement`（真 Codex）+ `FLY-1225-qa`（husk） | ✅ **事故复现**：tab `cmux-FLY-1259-implement` 渲染出 `FLY-1225-qa`；grouped view 成员集 = 两个窗，husk 可达 |
| **SUBJECT**（A=1 linked，调真 `create_or_replace_view_session`） | 同一 fixture | ✅ 成员集恰 = Codex 窗；`grouped=0`；**打垮 CONTROL 的那次 `select-window` 被 tmux 直接拒绝（rc=1）**，tab 纹丝不动 |

7/7 PASS。

## 4. 突变验证（每条断言都必须能红）

| 突变 | 预期 | 实测 |
|---|---|---|
| 删 `TmuxAdapter` 的 `type === "claude-tmux"` 门 | agy/kimi 断言转红 | ✅ 1 failed |
| 停掉 `TmuxAdapter` 的 `set-option` 调用 | 时序 + 失败合同断言转红 | ✅ 2 failed |
| 反转 `tmux-lookup.ts` 的 A flag 跳杀守卫 | 4 条 linked-view 断言转红 | ✅ 4 failed |
| **本 QA harness 自身** 跑在 A=0 下 | 5 条 SUBJECT 断言全红、CONTROL 仍绿 | ✅ 5 failed / 2 passed |

**过程中抓到并修掉的两个自身缺陷**（记在这里防后人重犯）：

1. **假红**：第一次把 harness 复制到 `/tmp` 跑突变，`SCRIPT_DIR` 相对路径失效 → 根本没 source 到生产脚本 → rc=127「函数不存在」。红了，但红的理由是错的。改为**原地**突变后才拿到真守卫 rc=1。
2. **空过的绿**：`SUBJECT after its window dies` 这条负向断言（"不渲染 husk"）在**view 压根没建起来**时也会绿 —— 突变跑里它是唯一还绿着的 SUBJECT 断言。已加前置条件（kill 前必须确证 view 正在渲染自己的窗），现在同一突变下它转红并显式报 `UNTESTABLE`。这正是 [[feedback_vacuous_green_fixture_disables_the_thing_asserted]] 的形态。

## 5. §2.8 remain-on-exit 事实核验（真 tmux，不采信文档断言；**已落进提交的 harness**）

plan §2.8 的全部理由建立在「旧的 pre-spawn `set-option -t "=<session>:"` 打在错的窗口上」这条平台事实上（FLY-1285 教训：平台谓词必须真机验）。harness 末段实测（3 条断言，随脚本可复跑）：

```
§2.8 premise TRUE : 旧形式把 on 打在既有窗口，新建 runner 窗口 = <unset>  ← 前提成立
§2.8 fix form     : window-scoped set-option 命中确切 @id = on
§2.8 husk semantics: 设了该选项的窗口进程退出后 pane_dead=1，窗口留存（E3 语义成立）
```

事实成立，修复前提为真。（首版只在一次性 probe 里验过、没进提交物 —— Codex R1 判定「报告宣称真机验证但 harness 里没有」，成立，已把 probe 收编进 harness。）

## 5b. Codex 对本 QA 物料的 code review（R1 → 3 MEDIUM 全采纳）

QA 阶段推 QA 证据会移动 head → FLY-827 硬门按 `(exec, sha)` fail-closed，旧批准（exec 4bb72151 @ 04e5669af）不再覆盖新 head，故按纪律对新 head 重跑 Codex code review（xhigh）。R1 = **CHANGES REQUESTED**，三条全部为真、全部已修：

| # | Codex findings | 性质 | 修法 |
|---|---|---|---|
| 1 | `kill-window` 未检查返回码 → kill 失败时窗口没死、tab 仍显示 Codex，"死亡后未串台"仍记 PASS（实证 `kill_rc=1 → PASS`） | **空过的绿** | 捕获 `kill_rc`，非 0 → 显式报 `UNTESTABLE` 转红 |
| 2 | `FLYWHEEL_CMUX_STATE_DIR` **生产脚本根本不读**（真知识是 `VIEW_WAL_DIR`，`flywheel-cmux-sync.sh:64`）→ QA 实际把 WAL 写进**生产 watcher 的持久化权威目录** | **拿名字冒充事实 + 真隔离缺陷** | 改用真 knob `VIEW_WAL_DIR`；并加**证明式**守卫：source 后反问生产脚本 `_view_wal_path` 会写哪、不在 QA 临时目录内 → **FATAL 拒跑** |
| 3 | 报告宣称 §2.8 已真机验证，但 harness 从不设/读 `remain-on-exit`、不驱动 TmuxAdapter、不检查 `pane_dead` | **报告强于证据** | 把 probe 收编进 harness（见 §5），claim 现由提交物支撑 |

第 2 条是我自己犯了本报告 §2 在审别人的同一个错：**设了一个名字像隔离的变量，就当隔离成立**。已核实生产 WAL 目录 `~/.flywheel/state/cmux-view-wal/` 当前**零文件**（成功路径 `claimed_complete` 后 `rm -f` 自清），无残留、未伤及任何生产 runner；但崩在中途就会留记录给生产 watcher 读 —— 属真实隐患，Codex 抓得对。

三条修完后 harness **10/10 PASS**；两条新守卫各自做了突变验证：
- 把 `VIEW_WAL_DIR` 指回生产路径 → 守卫 FATAL 拒跑（且报错文本指名它拒写的确切生产路径 = 红得有理由）；
- 强制 `kill_rc=1` → husk 断言转 `UNTESTABLE` 红。

（过程教训：第一次跑突变时把 harness 复制到 `/tmp`，相对 `SCRIPT_DIR` 失效 → 根本没 source 生产脚本 → rc=127「函数不存在」。**红了，但红的理由是错的**；改为原地突变才拿到真守卫 rc=1。红/绿都要问「是不是因为我以为的那个原因」。）

## 6. 既有套件独立复跑（PR head `04e5669af`）

| 套件 | 结果 |
|---|---|
| `scripts/test-cmux-sync.sh`（/bin/bash 3.2） | 385 passed, 0 failed |
| `scripts/test-cmux-sync-hooks-integration.sh`（真 tmux） | 12 passed, 0 failed |
| `scripts/__tests__/fly1272-doc-contract.test.sh`（P8 文档硬门） | 4 passed |
| `scripts/__tests__/test-cmux-autostart-flags.test.sh` | 5 passed |
| `scripts/__tests__/test-teardown-cmux-ownership.test.sh` | 3 passed |
| `flywheel-claude-runner` | 616 passed |
| `flywheel-config`（flag registry） | 440 passed |
| `tmux-lookup.attach.test.ts` | 17 passed |
| CI（Build & Test + FLY-1062） | 两项 pass |

**bash 版本门是 fail-closed 的**（用 Homebrew bash 5 跑 `test-cmux-sync.sh` → 打印提示并 **exit 1**，不是假绿退 0）—— FLY-694/1285 的教训在这个套件里是落实的。

## 7. 如实声明的边界（不吹）

- **验收场景 1「Codex 单 + weekly-limit Claude husk 共存」我验的是结构层，不是 cmux GUI 层**。理由：A=1 的保证是**拓扑性**的 —— view session 物理上只含一个窗，tmux 自己拒绝把它指向别的窗（rc=1 实测）。cmux tab 渲染的就是它 attach 的 view session，没有第二条通路能让它显示别人。GUI 点击复验属于 Annie 的 founder 验收，不是本阶段能替代的。
- **未验**：§2.4 人工迁移 runbook（QA 场景 5）—— 它按设计就是**操作员在场手动**流程（touch marker → bootout → 手关 ~20 个 tab → 核对清零），不含可自动化的代码装置；排演需要真动生产 watcher + 生产 tab，不该由 QA runner 单方面执行（[[feedback_independent_qa_before_destructive_deploy]]）。**这是部署时的人工环节，ship 前请 Tadashi 与 Annie 确认由谁执行。**
- **未验**：`attachment_unverified` 分支的告警终态（QA 场景 3 的孤儿 client 角落）—— 计划已显式声明该分支**不承诺收敛**、只承诺不假绿 + 发告警；单测已覆盖三条具名突变回归，本阶段未再真机造孤儿 client。
- **本地 `pnpm lint` 有 6 个文件报 `suppressions/unused`**，全部在本 PR 改动范围**之外**（DirectEventSink.test.ts / StateStore.fly1185 / heartbeat-quiet-suppression 等），与 FLY-1272 改动文件交集为**空**（对照实验证明该比对本身有效），CI 亦为绿 → 判定为本地 biome 版本噪声，非本 PR 引入。
- **§2.8 无 backfill**：只有 Bridge 重启后**新建**的 claude 窗口拿到 window-scoped 选项，存量活窗保持旧死亡形态直到自然重建 —— 计划已声明，QA 认可，属预期。

## 8. 部署提示（给 ship 环节）

- watcher 侧（A/B flag）换 watcher 立即生效；`TmuxAdapter` 是 TS 侧，**随下一次 Bridge 重启生效**。
- 计划 §2.3 的部署次序是硬的：**先重启 A-aware Bridge，后开 A=1 watcher**（旧 Bridge 的无条件按名杀不得与新 linked 拓扑共存）；回滚反序。
