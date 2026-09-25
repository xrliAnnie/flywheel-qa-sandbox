# FLY-2695 宿主 shim + converge 收敛 — 调研

Issue: FLY-2695 (https://linear.app/geoforge3d/issue/FLY-2695/raya-并仓s2-宿主-shim-converge-收敛raya-cosshl1-加载路径实机验证-codex-full-access)
日期: 2026-09-24
基于: exploration.md

> 本页只记**带 file:line 的现状证据**与**设计阶段在 scratchpad 里做的可复现 spike 结果**。
> 结论与施工步骤在 `plan.md`。所有 spike 都在隔离目录(`FLYWHEEL_STATE_DIR` 指向 scratchpad、
> 临时工作区 cwd)里跑,**没有写过生产 `~/.flywheel`、Raya 工作区或任何仓库文件**;
> 唯一碰过生产的只读动作是 `node ~/Dev/flywheel/packages/raya-cos/dist/cli.js status`
> 在临时空目录里执行(cos 是 cwd-scoped,空目录下 `status` 不落盘 —— S1 的
> `scripts/__tests__/raya-cos-cli-dist.test.mjs:43-58` 已证明这一点)。

## 1. 收敛器 `scripts/converge-flywheel-bin.sh`(734 行)—— 本单要改的唯一运行时脚本

| 位置 | 事实 | 对本单的约束 |
|---|---|---|
| `:28-36` | `REPO_ROOT` 自派生自脚本位置(不信 env);`STATE_DIR="${FLYWHEEL_STATE_DIR:-$HOME/.flywheel}"`,`BIN_DIR="$STATE_DIR/bin"` | 隔离夹具 = 把收敛器**复制**进假 repo 再执行(测试 `converge-flywheel-bin.test.sh:21-25` 就是这么做的) |
| `:81` | monorepo `FILES="… lib/codex-quota-summary.mjs"`(20 项) | `raya-cos.sh` **追加到这一行末尾** |
| `:90-93` | 根有 `.flywheel-prebuilt` ⇒ 整行重赋值 packaged `FILES`(19 项,少 `restart-services.sh`) | **不加** `raya-cos.sh`(plan §6.2 🔴);packaged 分支要把它视为 **retired** |
| `:128-133` | `strict_discard <path>`:`rm -f` 成功 **且** lstat 确证消失才返回 0;任一不成立返回 1(FLY-1577 原语,注释明言「A measurement that did not happen must never read as a match」) | retired 段直接复用,不再造第二个删除原语 |
| `:134-139` | `strict_residue_alert <name> <path> <what>`:删除不可证时的 alert 措辞(带 alert-chain 字样,`strict_alert` 会按 name 翻译) | retired 段用普通 `alert()`,措辞自写,避免被 `strict_alert` 的 cmux 词表改写 |
| `:140-146` | `alert <title> <body> <signature>`:走 `lead-alert.sh --kind bin_integrity_drift --severity severe`,签名去重 | retired 删除成功也 alert 一次(签名含 name,幂等) |
| `:152-181` | 首次采纳:`ADOPTION_DIR="$STATE_DIR/state/converge-adoptions"`;`is_first_adoption_name` 白名单(`:153-158`);marker 文件名 = name 里 `/`→`__`,内容 `managed=<name>\nsourceSha=<sha>`,mode 600 | `raya-cos.sh` 加进白名单 ⇒ 生产第一次收敛**静默**(不拉 severe 告警),之后漂移才告警;retired 删除时要连 marker 一起删 |
| `:191-200` | FLY-1389 写时守卫:全局 bin + temp/worktree 根 ⇒ 零写、一告警、rc=1;`FLYWHEEL_CONVERGE_ALLOW_TEMP_ROOT=1` 可覆盖 | 夹具 STATE_DIR 非全局 ⇒ 不触发;QA 在本机 worktree 上跑收敛器打**真** bin 会被拒 —— 这是对的,别绕 |
| `:202-283` | 主循环:源缺失→`srcmissing` alert + rc=1(`:206-213`);sha 相等→只收 mode(`:215-236`);漂移且源 insane→alert only 不修(`:242-247`);否则 `install_script_atomic`(`:249`)+ 首次采纳静默 / 否则 repaired alert | 循环**只遍历 `FILES`,从不扫目录删东西**(plan §10.2 注的前提,本次复核属实) |
| `:388-616` | symlink 严格 lane,仅在 `! is_temp_or_worktree_root "$REPO_ROOT"` 时运行 | 与本单无关;retired 段**不要**放进这个 if 里(retired 删除不依赖信任根,只依赖清单) |
| `:718-732` | hygiene 只读扫描(rc OR) | retired 段放在主循环之后、symlink lane 之前(`:284` 附近),与 FILES 循环共享 `rc` |
| `:734` | `exit "$rc"` | 删不掉 ⇒ rc=1 ⇒ restart-services pre-kickstart 会拒绝 kickstart(`restart-services.sh:3297-3303`)—— 这是期望行为:残留不可证时不该静默放行 |

## 2. 写入门槛 `scripts/lib/script-sanity.sh`

- `:24` `FLYWHEEL_SCRIPT_MIN_BYTES=1024`,注释 `:17-23` 明言**不可 env 调**(Codex R1#4);
- `:26-41` `assert_sane_script_source`:`wc -c` < 1024 → 拒;无实质行 → 拒;
- `:43-58` `install_script_atomic`:先 assert,再 tmp+mv+555。

⇒ plan §6.2 示例 shim(约 350 B)落在 `converge-flywheel-bin.sh:242-247` 的「源 insane、不修、告警」分支。
**shim 必须 ≥1024 B**。设计原型 2429 B(spike B1 实测被正常安装)。

## 3. shim 依赖的宿主合同

| 合同 | 证据 |
|---|---|
| `FLYWHEEL_DIR` 解析:ENV > `host.json.flywheelDir` > `$HOME/Dev/flywheel` | `scripts/lib/host-config.sh:104-106`,导出 `:147`;`host_config_load` 需要 `jq`(`:58`),`host.json` 缺失 = 默认(`:63-71`),畸形 JSON fail-closed 返回 1(`:66-69`) |
| `host-config.sh` 在宿主 bin 里的位置 | `~/.flywheel/bin/lib/host-config.sh` 实存(644,09-15);安装者是 `scripts/provision-fleet-host.sh:373`,**不在**收敛器 `FILES` 里 ⇒ shim 要有回退:`<shim 所在目录>/lib/host-config.sh` → `${FLYWHEEL_DIR:-$HOME/Dev/flywheel}/scripts/lib/host-config.sh` → fail 78 |
| flywheel-lead.sh 的同款定位法 | `scripts/flywheel-lead.sh:42-56` `load_common`:先 `<state>/bin/lib/host-config.sh`,再脚本旁 `lib/`,再 `$FLYWHEEL_DIR/scripts/lib/`,缺则 `fail … 78` |
| Lead 子进程 PATH | `scripts/flywheel-lead.sh:8`:`~/.local/bin:~/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin:$PATH`,**不含** `~/.flywheel/bin` ⇒ 人设必须用绝对路径 `~/.flywheel/bin/raya-cos.sh`;`node` 解析到 `/opt/homebrew/bin/node`(v25.6.1),`jq` 到 `/usr/bin/jq`(spike A6 在沙箱内实测) |
| cos CLI 的 cwd 语义 | `packages/raya-cos/src/cli.ts:79-83` `runCoSCommand(argv, io, workspace = process.cwd())`;`--input` 相对 workspace 且拒绝越界/symlink(`:48-77`);`status` 返回 `{schemaVersion:2, operations:[…]}`(`src/business-round.ts:132-145`) ⇒ shim **不能 `cd`**,只能 `exec node … "$@"` |
| 包的 bin 名 | `packages/raya-cos/package.json` `bin.raya-cos=./dist/cli.js`;README `:33-38` 已预告「stable entry point … is the host shim `raya-cos.sh` delivered by S2」 |

## 4. 被 `FILES` 字面耦合的测试(改 `FILES` 前必须知道)

| 测试 | 耦合点 | 影响 |
|---|---|---|
| `scripts/__tests__/flywheel-lead-packaging.test.sh:50-63` | 对每一行 `^[[:space:]]*FILES=` 断言含 `flywheel-lead.sh` **且**匹配 `*lib/lead-host-tmux-gate.sh*lib/raya-standard-migration.sh*lib/codex-quota-summary.mjs*`;**且 `FILES=` 恰好 2 行** | 追加到 `:81` 行末**通过**(spike C2 实测两条模式均 ok);**禁止**新增第三行 `FILES=`;retired 清单用 `RETIRED_FILES=` 命名(不匹配 `^[[:space:]]*FILES=`) |
| `scripts/__tests__/converge-flywheel-bin.test.sh:36-41,58` | 夹具生成 20 个 80 行 stub 源 + `COPY_FILES` 稳态种子 | 加 `raya-cos.sh` 进两个列表;新增用例 C13–C16 |
| `scripts/__tests__/packaged-seams.test.sh:355-410` S7/S8 | packaged 树稳态:预置 16 个文件后收敛应 **零告警**;S8 monorepo 缺 `restart-services.sh` 仍 `srcmissing` | packaged `FILES` 不变 ⇒ S7 不受影响;retired 段在 S7 夹具里 `raya-cos.sh` 不存在 ⇒ 无动作、无告警(要保住「零告警」) |
| `scripts/__tests__/converge-fly1389.test.sh:47,97`、`fly1577-cmux-bin-closure.test.sh:70,113`、`fly1577-alert-arrival.test.sh:64,209` | 各自夹具枚举 `FILES` 里的名字造 stub | **未加 `raya-cos.sh` 时**这些夹具会让收敛器对它报 `srcmissing`(rc=1)—— 凡断言 rc=0 / 精确告警条数的用例都会红。实施必须把 `raya-cos.sh` 同步加进这 3 个文件的枚举(与 FLY-1577 加 `restart-storm-gate.py` 时同样的扩散) |
| `scripts/__tests__/ci-shell-suite-enumeration.test.sh:16-24,48-56` | 每个 `scripts/__tests__/*.test.sh` 必须字面出现在 `ci.yml` 或 manual-only 清单 | 新建 `raya-cos-shim.test.sh` 必须登记到 `.github/workflows/ci.yml`(建议 `:360` FLY-1389 批次紧随 `converge-flywheel-bin.test.sh`) |
| `.github/workflows/ci.yml:191` | `node --test scripts/__tests__/raya-cos-cli-dist.test.mjs`(S1),运行在 `pnpm build` 之后 ⇒ CI 有 dist | shim 测试若想跑真 dist 可放同一 job;但 ② 的判据用 stub cli.js 更 hermetic,不依赖 build 顺序 |

## 5. ④ Codex full-access 沙箱能否执行 shim —— 设计阶段复演(spike A)

### 5.1 沙箱形态的代码依据

- `packages/teamlead/scripts/codex-lead-tui-home.sh:576-580`:full-access 写入 `sandbox_mode="workspace-write"`、`network_access=true`、`writable_roots=[<cwd>]`;`:683-695` 启动前复验这三项;
- `packages/teamlead/src/lead-backends/codex/codex-lead-runtime.ts:411-413`:同一组值以 `-c` 传给 Codex;
- `codex-lead-runtime.ts:512-560` `resolveFullAccessProjectRoot`:只约束 **projectRoot**(不能是 `$HOME`、其祖先、`~/.flywheel`、state dir、`CODEX_HOME`),**不约束可读范围** —— plan §6.2 的判断正确;
- 活 Raya 的 projectRoot = `/Users/xiaorongli/Dev/raya-lead-workspace`(manifest),Codex = 0.156.1(`ps` 看到的 `~/.codex-raya/packages/standalone/releases/0.156.1-aarch64-apple-darwin/bin/codex`)。

### 5.2 策略来源

`codex debug` 在 0.156.1 没有 `seatbelt` 子命令(实测 `unrecognized subcommand`),所以不能让 Codex 自己替我们跑沙箱。
改为从**同一个二进制**里按字节切出内嵌的 `seatbelt_base_policy.sbpl`
(起点 `; inspired by Chrome's sandbox policy`,终点 `(allow file-read* (subpath "/Applications"))`,
11591 B / 311 行;`strings -n 8` 会丢 `)))` 这类短行,必须用 python 字节切片),
再按 Codex 源码的 workspace-write 组合方式拼接(`strings` 里能看到它用的片段与参数名
`WRITABLE_ROOT`、`READABLE_ROOT`、`(allow file-read*)`、`(allow file-write* (regex #"^/"))` 等):

```
<base 311 行>
(allow file-read*)                                   ; 读不受限(Codex 默认)
(allow file-write* (subpath (param "WRITABLE_ROOT_0")))
(deny  file-write* (subpath (string-append (param "WRITABLE_ROOT_0") "/.git")))
(deny  file-write* (subpath (string-append (param "WRITABLE_ROOT_0") "/.codex")))
(allow file-write* (subpath (param "TMPDIR_ROOT")))
(allow file-write* (subpath "/private/tmp"))
(allow network-outbound) (allow network-inbound) …   ; network ON
```

执行:`cd <临时工作区> && /usr/bin/sandbox-exec -f policy.sb -D WRITABLE_ROOT_0=<工作区> -D TMPDIR_ROOT=$TMPDIR -- /bin/bash -c '…'`,
PATH 设为 `flywheel-lead.sh:8` 的那一串。脚本:`scratchpad/spike-a-seatbelt.sh`(实施节点复跑用,plan §7 附全文要点)。

### 5.3 结果(2026-09-24,本机)

| 用例 | 命令(沙箱内,cwd=临时工作区) | 结果 |
|---|---|---|
| A1 直接跑生产 dist | `node ~/Dev/flywheel/packages/raya-cos/dist/cli.js status` | `{"schemaVersion":2,"operations":[]}`,rc=0 |
| A2 经 shim(scratch `FLYWHEEL_STATE_DIR`,无 host.json) | `<state>/bin/raya-cos.sh status` | 同上,rc=0 —— **exec 工作区外的 555 脚本 + source bin/lib/host-config.sh + node 读 ~/Dev/flywheel 全通** |
| A3 只读命令 | `raya-cos.sh daily-report-migration-plan` | 正常 JSON,rc=0 |
| A3b 写路径 | `raya-cos.sh prepare --input prepare-input.json`(故意给无效 patrol 身份) | cos 按合同报 `invalid patrol identity`,**但 `state/cos/operations/` 目录已在 cwd 下创建** ⇒ 沙箱允许写 writable root |
| A7 argv/`--input` 透传 | `raya-cos.sh resume --input resume-input.json`(不存在的 operationId) | cos 报 `unknown operation` rc=1 —— 说明参数与相对路径原样到达 CLI |
| **A4c 负对照** | `touch $HOME/.fly2695-sandbox-probe-*` | `Operation not permitted`,rc=1,文件不存在 |
| **A4d 负对照** | `touch ~/Dev/flywheel/.fly2695-probe-*` | `Operation not permitted`,rc=1 —— shim 读的那个 checkout **只读** |
| A4e 正对照 | `touch <工作区>/inside-probe` | rc=0,文件存在 |
| A6 工具解析 | `command -v node; command -v jq` | `/opt/homebrew/bin/node`(v25.6.1)、`/usr/bin/jq` |

⚠️ 第一版负对照把探针放在 `/private/tmp` 下,`touch` 成功 —— 那不是策略失效,是策略本来就允许写 `/private/tmp` 与 `$TMPDIR`
(Codex 的 workspace-write 也这样)。**对照组落在被允许的目录里就不是对照组**;改到 `$HOME` 与 `~/Dev/flywheel` 后对照成立。
实施/QA 复跑时探针必须放在这两处。

### 5.4 这层证据的边界(诚实写明)

- 证明的是 **0.156.1 的文件系统策略**允许这条路;Codex 进程在策略之外做的事(`shell_environment_policy` 对 env 的裁剪、approval)不在其中。
  PATH 由 `flywheel-lead.sh:8` 给定并被 Codex 以 `core` 策略继承(Raya 今天已在同一沙箱里跑 `node business/current/...`,
  `state/cos/` 自 09-22 起持续写入,是这条环境链路的生产旁证);
- 不是 Raya 本体的 `CODEX_HOME`/MCP;
- 复演脚本用了 `-D WRITABLE_ROOT_0`,Codex 真实拼法可能是内联绝对路径而非 param —— 语义等价,但**不是字节一致**。
  这就是 plan §12 ④ 仍要在施工阶段补一次真 `codex exec`(隔离 `CODEX_HOME`)的理由。

## 6. shim 原型 + 收敛器夹具复演(spike B/C)

夹具 = 假 repo(`.git` 文件标 worktree 形态,`scripts/lib/{script-sanity,path-hygiene}.sh` 真件,
收敛器真件复制后仅把 `:81` 行末追加 ` raya-cos.sh`,其余 20 个源用 80 行 stub)+ 隔离 `FLYWHEEL_STATE_DIR` + alert 桩。
脚本:`scratchpad/spike-b-converge.sh`。

| 用例 | 结果 |
|---|---|
| B1 空 bin 首次收敛 | `repaired: raya-cos.sh (bin was 0B …)`;bin 内 2429 B、mode **555**、sha **与源相同**;因原型收敛器**未**把它加进 `is_first_adoption_name`,本次拉了一条 repaired alert —— 实施加白名单后应变成「first managed adoption recorded … alert suppressed once」 |
| B2 二次收敛 | rc=0、0 告警、0 `mode tightened`(幂等) |
| B3 假 HOME,无 host.json | stub cli.js 回显 `target=<fakehome>/Dev/flywheel/packages/raya-cos/dist/cli.js`,`argv=["status","--x","y"]`,`cwd=<工作区>` ⇒ 默认解析 + argv 透传 + cwd 不变 |
| B4 `FLYWHEEL_DIR` env | 解析到 env 指定目录(ENV 最高优先) |
| B4b `host.json.flywheelDir` | 解析到 host.json 指定目录 |
| B5 dist 缺失 | `[raya-cos.sh] ERROR: Raya CoS CLI is not built at …`,**rc=78** |
| B5b 畸形 host.json | host-config fail-closed,`rc=78` |
| B6 真 HOME(本机无 host.json) | 走生产 dist,`{"schemaVersion":2,"operations":[]}` |
| **C1 今天的 packaged 分支** | 预置 555 旧 shim + adoption marker + 无关文件,根带 `.flywheel-prebuilt`:rc=0、0 `srcmissing`、**旧 shim 仍在、marker 仍在** ⇒ 证实 plan §10.2 注「不列 = 不管 ≠ 删除」;这正是 ⑤ 要求「预置-再断言删除」的原因 |
| C2 `flywheel-lead-packaging.test.sh` 模式 | 追加后两条 `FILES=` 均 `pattern1=ok pattern2=ok`,行数仍 2 |

## 7. 部署与回滚链路(A2 怎么自动到位)

- 合入后 shim 到宿主的路径只有两条,都是既有班车:`scripts/update-flywheel.sh:779` `updater_converge_bin` 在 `:1567` 被调用(非致命);
  `scripts/restart-services.sh:3296-3310` pre-kickstart 调收敛器,rc≠0 则拒绝 kickstart。**不需要任何人手复制**;
- 生产第一次收敛因首次采纳白名单而静默;`~/.flywheel/state/converge-adoptions/raya-cos.sh` marker 落盘 600;
- forward rollback(plan §10.2 注):保留 retired 框架,另开提交把 `raya-cos.sh` 从 `:81` 挪进 monorepo `RETIRED_FILES`,部署后收敛器删 bin 副本 + marker 并验证消失;再之后才能删那条 retired 条目。

## 8. 现场事实(不属于代码,但施工/QA 要知道)

- 活 Raya 仍在跑,PID 26815,`codex app-server` 载体;`state/cos/status-latest.json` 09-24 11:03 更新 ⇒ 人设在按 `business/current` 路径调 cos。S2 合入与部署对它零影响(人设未改)。
- `~/.flywheel/bin/` 共 68 项,含 16 个 `restart-services.sh.tmp.*`、多个 `.bak-*`、`__pycache__`、`discord-reply-enforcer.py` 等非收敛器所有物 ⇒ 任何「泛删未知文件」都是事故;retired 只按精确名单删。
- `~/.flywheel/bin/flywheel-codex-lead-wrapper-raya-tui-fullaccess.sh`(555)与其 adoption marker 仍在;它引用的 `packages/teamlead/scripts/run-codex-lead-raya-tui-fullaccess.sh` 在 main 已不存在(`raya-standard-migration.test.sh:96-100` 守着不得复活)。这是 retired 机制的天然第二个候选,归属 T6 / Lead 裁定(exploration §5.1)。
- 本 worktree 没有 `packages/raya-cos/dist`;实施节点跑 `raya-cos-cli-dist.test.mjs` 或真 dist 验证前先 `pnpm --filter flywheel-raya-cos build`。
- 老壳 plist 两个文件仍在 `~/Library/LaunchAgents`,`launchctl list` 无其 label —— 与工单「bootout+disable,plist 未动」一致。
