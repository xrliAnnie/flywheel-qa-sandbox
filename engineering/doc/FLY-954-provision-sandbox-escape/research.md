# FLY-954 provision 测试沙箱逃逸 — 调研

Issue: FLY-954 (https://linear.app/geoforge3d/issue/FLY-954/infraprovisioning-provision-测试沙箱逃逸-12-字节-stub-覆盖真-flywheelbin-三脚本2026)
日期: 2026-07-07
基于: exploration.md(brainstorm gate 已批:方案 A + 不动 plist + lead-alert.sh 管道)

## 1. 改动位点清单(逐个核实过源码)

### 1.1 provision-fleet-host.sh(防线 ①②③)

- **env 污染入口**:`main():499-509` — `host_config_load` 后 `FW="${FLYWHEEL_STATE_DIR:-$HOME_DIR/.flywheel}"`;`host-config.sh:108` 优先级 `ENV > host.json > default`(共享 lib,wrapper 运行时也用,**不能改它**)。
- **方案 A 落点**:脚本参数解析后立即 `unset FLYWHEEL_STATE_DIR FLYWHEEL_DIR`(曾设置则 warn 一行);新增 `--state-dir DIR` flag,非空时 `export FLYWHEEL_STATE_DIR="$STATE_DIR_FLAG"` 再走原 resolve 链(flag 成为该 env 的唯一合法来源,host.json stateDir 语义不变)。
- **安装点**:`phase_flywheel_home():299-303` — 裸 `run cp` 三件套。改为 install helper(见 §1.3);注意 chmod 555 落地后**裸 cp 会被自己挡住(EACCES)**,必须同步改 tmp+mv 形态。
- **`FLYWHEEL_PLATFORM` 不 unset**:它只影响平台分派(darwin/linux),不指向写入目标;测试靠它钉平台。

### 1.2 调用方交互(方案 A 的连带修改,必改)

- **flywheel-setup.sh:955-962**:FLY-648 用 env PIN 传 state dir(`FLYWHEEL_STATE_DIR="$FLYWHEEL_SETUP_STATE_DIR" bash …/provision-fleet-host.sh`),注释自证就是在防「stray env」——unset 后该 PIN 失效,**改为追加 `--state-dir "$FLYWHEEL_SETUP_STATE_DIR"`**(env PIN 可保留,无害)。
- **provision-fleet-host.test.sh(darwin)**:`_iso_prov` 经 env -i 传 `FLYWHEEL_STATE_DIR="$_home/.flywheel"`;unset 后该值被丢、FW 落回 `--home` 推导 = 同值,**行为不破**;implement 时显式改传 `--state-dir`(意图清晰 + 覆盖新 flag)。
- **provision-linux.test.sh:69/129**:env -i 且不传 STATE_DIR,零影响。
- 全仓 grep 其他 provisioner 调用方:仅以上三处 + runbook 文档。

### 1.3 新共享函数 assert_sane_script_source(防线 ②)

- 落点:`scripts/lib/`(与 host-config.sh 等同目录,source 方式一致:guarded、无副作用)。
- 校验:① 文件存在且尺寸 ≥ 下限(三件套实际 6811/9208/57967 B;下限取 1024B,给未来瘦身留余量);② 去掉 shebang/注释/空行后仍有实体行(shebang-only stub 的直接指纹)。任一不满足 → 返回非零,调用方 die/fail-loud。
- 接入方:provisioner 安装循环、`flywheel-daemon.sh::install_wrapper():184-200`(现有 tmp+cp+chmod+x+mv 原子形态保留,前面加 assert + 末尾 chmod 555)、converge 脚本(修复前验源,见 §1.5)。

### 1.4 写保护 chmod 555(防线 ③)

- 444 → **555**:三件套均可执行文件(restart-services.sh 有 operator 直跑场景;wrapper 经 `/bin/bash <path>` 调用只需读,但保留 x 位与现状 `chmod +x` 语义一致)。
- 合法写入流程 = tmp 写(同目录)→ `mv` 原子替换 → `chmod 555`。**mv/rename 不受目标文件权限位影响**(受目录权限影响),合法安装方无需解锁步骤;意外 `cp` / `>` 截断当场 EACCES——事故路径(provisioner cp)正是此形态。
- 已核实无就地编辑者:全仓仅 provisioner `:301` 与 daemon `install_wrapper` 写 bin 三件套(`sync-gbrain-docs.sh`/`flywheel-cmux-install.sh` 写的是别的文件)。

### 1.5 converge-flywheel-bin.sh(防线 ④,新文件)

- 单一真相脚本,幂等:对三件套逐个 `shasum -a 256` 对比 `<repo>/scripts/<f>` ↔ `<state>/bin/<f>`。
  - 一致 → 静默 no-op;
  - 不一致/缺失 → **先 assert_sane_script_source 验 repo 源**(repo mid-pull/被污染时**只告警不修复**——绝不把坏源收敛进生产 bin,fail-safe)→ 源健康则 tmp+mv+555 修复 + 告警一条(修复成功也要响:漂移本身就是异常信号)。
- repo root:`SCRIPT_DIR/..` 自推(脚本总是从 repo checkout 被调);state dir:`FLYWHEEL_STATE_DIR` env > `~/.flywheel`(converge 是读取者+修复者,env 语义与 wrapper 运行时一致;QA slot 带自己的 STATE_DIR/CLAIMS_DB → 天然隔离,529 Room 兼容)。
- **⚠️ 实测修正(2026-07-07,实现期反例,推翻本节初稿的「即使被污染指错也无害」论断)**:「无害」隐含假设 repo 源 = main。实测反例——既有 `update-flywheel-queue.test.sh` 沙箱了 HOME 但继承了 runner 自带的生产 `FLYWHEEL_STATE_DIR`,跑 `update_main` 命中挂点 b,converge 以**分支 worktree** 为 repo 源把分支版 `restart-services.sh` 写进了真 `~/.flywheel/bin`(555、内容 sane,该拷贝无 launchd 消费者,未影响生产;已按 runbook 恢复 main 版)。结论:converge 的 env seam 对**生产挂点**与 QA slot 是正确语义,但对「带生产 env 的测试进程」不设防——这是「writer 不得信任继承 env」原则(防线 ①)的又一实证,修复落在测试侧:执行 `update_main` 的套件必须沙箱 `FLYWHEEL_STATE_DIR`(与 Task 8 硬断言同族)。
- 告警:`scripts/lead-alert.sh --kind bin_integrity_drift --severity severe`。**kind 是硬 enum(lead-alert.sh:90-103),需加词**;注释明确的 parity convention:TS 侧 `LeadAlertNotifier.ts` 的 AlertEventType union 同步加(纯类型面,Bridge 无行为分支)。signature 用「文件名|repo checksum 前 12」→ 同一漂移事件每日至多一响(claims.db 既有去重)。

### 1.6 三个收敛挂载点(防线 ④)

| 挂点 | 位置 | 形态 | 备注 |
|---|---|---|---|
| a. Lead 启动 | `claude-lead.sh` 照抄 FLY-913 `install_restart_guard_hook():842-868` 形态:DRY_RUN skip + 缺脚本 WARN + 失败非致命 WARN;every role(全局机器不变量) | 非致命 | 修 bridge-wrapper/restart-services 拷贝 + 活着的 Lead 日常漂移收敛;**救不了已坏的 lead-wrapper 本体**(启动依赖 wrapper) |
| b. updater | `update-flywheel.sh:208` 非 sourced 入口处、marker/sweep 分派**之前** | 非致命(告警即可,不 wedge 部署) | **wrapper 全灭时唯一自愈路径**(updater plist 指 repo 直跑);每日 00:00/12:00 + 每次 self-ship 触发 |
| c. 部署 kickstart 前 | `restart-services.sh::do_restart_all_leads():948` 函数开头(单点覆盖 `:1087` rollback / `:1159` 全量 / `:1202` Lead-only 三条调用路径) | 修复失败 → fail-loud(kickstart 一个坏 wrapper = 必然全灭,宁可部署中止) | 22:37 爆炸形态从此结构性不可能 |

### 1.7 测试入口硬断言(防线 ① 补强)

- 两套件(darwin/linux)开头:断言 helper 产出的子进程 `$HOME` ≠ 外层真 `$HOME`(fixture 沙箱自检);grep 自查测试文件内除 helper 外无裸 `bash "$PROVISION"`(事故 2 session 07:56 UTC 的人工自查固化成断言)。

## 2. 既有模式复用(不发明新轮子)

- **FLY-913 install-restart-guard**:单一安装脚本 + claude-lead.sh 每启收敛 + 非致命 WARN —— converge 挂点 a 逐字照此形态。
- **daemon install_wrapper 原子安装(code-review H6)**:tmp+mv 已是既有共识,推广到 provisioner 与 converge。
- **lead-alert.sh claims.db 去重(FLY-83/913)**:告警管道零新建;Bridge down 时 shell 通道仍可用+队列 spill。
- **updater fail-safe 哲学(FLY-739「deploy availability wins」)**:converge 在 updater 挂点非致命,与既有原则一致。

## 3. 风险与对策

| 风险 | 对策 |
|---|---|
| chmod 555 挡住 provisioner 自己的裸 cp | §1.1 同步改 tmp+mv(同一 PR 内原子落地,有测试钉住) |
| repo 源本身坏(mid-pull/被污染)被收敛进 bin | converge 修复前 assert 源;不健康只告警不修复 |
| unset env 破坏 flywheel-setup.sh 自定义 state dir | §1.2 改传 --state-dir(同 PR) |
| 新 kind 不进 enum 导致告警 config_error 静默 | lead-alert.sh enum + TS union 同 PR 加词;converge 测试断言 strict-delivery 结果行 |
| converge 在挂点 c 失败导致部署 wedge | 只有「修复失败」才 fail-loud(源坏/写失败);checksum 一致的正常路径零开销 |
| 字节兼容 | 不传 --state-dir 且环境无污染时,provisioner resolve 结果与现状逐字一致;wrapper/host-config 运行时读取路径零改动 |

## 4. 测试面(plan 里展开)

- provisioner:带污染 env(FLYWHEEL_STATE_DIR 指假生产)+ --home 沙箱跑 --apply → 断言假生产目录零写入(**事故形态回归测试**,不用 env -i 跑——就是要证明不靠 env -i 也安全);--state-dir 显式覆盖生效;12B stub 源 → die 非零 + 无安装;安装后权限 555;二次 apply 幂等(mv 过 555 成功)。
- converge:漂移 → 修复+告警(strict-delivery 结果行);一致 → 静默;repo 源坏 → 告警不修复;缺文件 → 修复。
- 挂点:claude-lead.sh DRY_RUN 跳过;restart-services do_restart_all_leads 前置调用存在(grep 锚点)+ 修复失败中止;updater 入口调用存在。
- 既有套件全绿:provision-fleet-host.test.sh(P0-P7)、provision-linux.test.sh、daemon/fleet 相关套件。
