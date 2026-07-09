# FLY-954 provision 测试沙箱逃逸 — QA 报告

Issue: FLY-954 (https://linear.app/geoforge3d/issue/FLY-954/infraprovisioning-provision-测试沙箱逃逸)
日期: 2026-07-07
基于: plan.md / research.md / exploration.md
PR: #491 (flywheel-FLY-954)
QA 阶段 exec: 0a90c7df（三段式流水线 QA phase，独立于 implement 阶段）

## 结论:PASS

四层防线全部按 plan.md 实现并经验证;实现已 fold Codex design R1/R2 + code-review R1 的全部结论。FLY-954 自身改动 lint-clean / shellcheck 零新增 warning / TS 编译通过;新增与既有 shell 测试套件全绿;真实行为烟测(真 converge 脚本对沙箱 state 制造事故原形漂移)修复行为完全符合设计。**GitHub CI「Build & Test」在 PR head `8449df59` 上 = success**(本地 HEAD `6081abfd` 与之仅差一个 progress.md commit,代码零差异)。

---

## 1. 实现对照 plan.md(逐文件核实)

| plan File Map | 实现状态 |
|---|---|
| `scripts/lib/script-sanity.sh`(新) | ✅ 与 plan 代码块一致;`FLYWHEEL_SCRIPT_MIN_BYTES=1024` 常量(非 env-tunable,Codex R1#4);`assert_sane_script_source` + `install_script_atomic`(tmp+555+mv) |
| `scripts/converge-flywheel-bin.sh`(新) | ✅ content+mode 双不变量;insane 源 fail-safe;**missing 源 rc=1+alert**(Codex code R1 HIGH);size 读取 `[ -f ]` 先判;🧪 演习标记(lead-instr 4d224848) |
| `scripts/provision-fleet-host.sh` | ✅ unset 继承 `FLYWHEEL_STATE_DIR`/`FLYWHEEL_DIR`(warn);`--state-dir` flag;安装循环走 `install_script_atomic`+die;unset 块正确置于 warn/die 定义之后 |
| `scripts/flywheel-setup.sh` | ✅ `_fs_provision` 追加 `--state-dir`;注释改写为 FLY-954 语义 |
| `scripts/flywheel-daemon.sh` | ✅ `install_wrapper` 收敛到共享 `install_script_atomic`(555) |
| `scripts/lead-alert.sh` | ✅ kind allowlist + usage + 注释加 `bin_integrity_drift` |
| `packages/teamlead/src/LeadAlertNotifier.ts` | ✅ `AlertEventType` union 加成员(parity) |
| `packages/teamlead/src/LeadWatchdog.ts` | ✅ `titleFor`/`bodyFor` 两个 exhaustive switch 补 case(noImplicitReturns 必改,Codex R1#3) |
| `packages/teamlead/scripts/claude-lead.sh` | ✅ 挂点 a:`converge_flywheel_bin()` + 每启调用(DRY_RUN skip + 非致命 WARN) |
| `scripts/update-flywheel.sh` | ✅ 挂点 b:`update_main` 头非致命收敛 |
| `scripts/restart-services.sh` | ✅ 挂点 c:`do_restart_all_leads` 头 fail-loud;**refusal 走 stdout 契约 `skipped:0 failed:1` + `return 0`**(Codex code R1 MEDIUM:三处调用点 `$()` 捕获 + `set -e`,非零 return 会在赋值处杀脚本、跳过既有 failed>0 处理) |
| 测试套件(script-sanity/converge/provision×2/lead-alert/fleet/update-queue) | ✅ 见 §2 |

## 2. 测试执行结果(全部本机 hermetic 沙箱)

| 套件 | 结果 |
|---|---|
| `script-sanity.test.sh` | **9/9 PASS**(S1 事故 stub 拒装 / S5 555 落地 / S6 裸 cp EACCES / S8 stub 源拒装 dst 不动 / S9 env 不可弱化 floor) |
| `converge-flywheel-bin.test.sh` | **8/8 PASS**(C1 stub 漂移修复+恰一告警 / C2 一致静默 / C3 缺文件重装 / C5 mode-only 收 555 不告警 / C4 insane 源只告警不修复 / C6 非默认 root 带🧪 / C7 生产 shape 无🧪 / C8 missing 源 rc≠0+告警) |
| `provision-fleet-host.test.sh` | **18/18 PASS**(含 **P8 事故回归**:继承 `FLYWHEEL_STATE_DIR` 被忽略、写入落 --home、污染目标零写、warn 记录;P9 --state-dir;P10 stub 源 die;P11 555 写保护) |
| `provision-linux.test.sh` | **7/7 PASS** |
| `lead-alert-strict-delivery.test.sh` | **17/17 PASS**(含 `bin_integrity_drift accepted → sent` 真实端到端 + allowlist/TS-union parity grep) |
| `flywheel-fleet.test.sh` | **27/27 PASS**(fixture 升级为 sane 尺寸) |
| `flywheel-daemon-install-verify.test.sh` | **9/9 PASS** |
| `flywheel-daemon-plist-env.test.sh` | **8/8 PASS** |
| `update-flywheel-queue.test.sh` | **PASS**(挂点 b 沙箱 `FLYWHEEL_STATE_DIR` 加固,防分支版写真 bin) |
| **全量 `scripts/__tests__/*.test.sh`(52 套件)** | **52/52 ALL PASSED,零 FAILED**(host 上跑;跑前+跑中+跑后三次核验生产 `~/.flywheel/bin` 三件套始终 = MAIN 内容 + 555 未污染;审计确认仅 3 个套件触及 converge/update_main 且全部沙箱 STATE_DIR,`do_restart_all_leads` 无测试直接执行、claude-lead 系全 DRY_RUN) |

## 3. 静态检查

- **shellcheck**(所有改动脚本):新文件 `script-sanity.sh`/`converge-flywheel-bin.sh` 仅剩 cosmetic 的 SC1091(跨 cwd 无法跟随 source,全仓 source 通病);`restart-services.sh` HEAD=main=3(**零新增**);其余改动脚本零新增 warning/error。
- **TS build** `pnpm -C packages/teamlead build`:exit 0(union + 两个 switch case)。

## 4. CI / lint 澄清(重要)

本地 `pnpm lint`(=`biome check` 全仓)exit 1,但经核查**与 FLY-954 无关、不影响 CI**:
- 2 个 biome **format error** 落在 `.flywheel/runs/865df61c-.../*.json`——这是**未跟踪的本地运行时产物**(implement 阶段的 run 目录,`.flywheel/` 未进 .gitignore 故被 biome 扫到)。**CI 是 fresh clone,这些文件根本不存在**。
- 15 个 `useTemplate` **warning** 落在 `login-smoke.mjs`(FLY-960)/`headless-brain.test.ts`(voice-core)等——均在 origin/main 上、**FLY-954 一个没碰**(与 main 字节一致);且 `biome check` 只扫这些 tracked 文件时 **exit 0**(warning 不致 fail)。
- **ground truth**:`gh pr checks 491` → 「Build & Test」**pass**(run 28895909793,head `8449df59`)。
- (旁注:`.flywheel/` 未 gitignore 是仅影响本地 dev 的小卫生问题,非本 issue scope;可作 follow-up。)

## 5. 真实行为烟测(超出单测,真 converge 脚本)

沙箱 STATE_DIR 播种「1 个事故 12B stub 漂移 + 2 个 644 mode 漂移」→ 跑真 `converge-flywheel-bin.sh`:
- stub → 修复成 repo 源(内容 == `scripts/flywheel-lead-wrapper.sh`,sha `d2f0356f` = exploration §1.1 记录的生产恢复版);
- 三件套全部收紧到 **555**(`! -w`);
- **恰一条**内容漂移告警(仅 stub),两个 mode-only 静默(符合 Codex R1#1);
- 告警带 **🧪[sandbox test]** 前缀(非默认 STATE_DIR);
- exit 0。

## 6. Issue 四条要求覆盖

1. **找真凶** → exploration §1 取证:两次事故均 FLY-648 runner 跑 provision 套件、runner 自带生产 `FLYWHEEL_STATE_DIR` 盖过 --home 沙箱;env -i jail 已由 #477 落地,本 PR 补结构性根治(防线 ①)。✅
2. **测试硬隔离** → provision 两套件 `_assert_sandboxed_home` 硬断言 HOME≠真 HOME + `_iso_prov` 显式 `--state-dir`;P8 不用 env -i 也证明安全。✅
3. **provisioner 侧防御** → sanity(尺寸+非 shebang-only)+ 原子 + 555;stub 源 die-loud(P10)。✅
4. **持续收敛校验(升必做)** → `converge-flywheel-bin.sh` 三挂点(Lead 启动非致命 / updater 非致命自愈 / 部署 kickstart 前 fail-loud)。✅

founder 追问的运行时状态完整性三层(写保护 555 / 持续收敛 / 根治写入源)+ 架构不动 plist(gate 已拍,follow-up)均落地。✅

---

**QA verdict: PASS** — 实现忠于 plan、测试与真实行为均验证、CI 绿。建议按 APPROVE GATE 流程 founder-gated ship。
