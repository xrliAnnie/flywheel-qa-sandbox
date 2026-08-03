# FLY-1608 529房既有缺陷×2:Lead 秒死 + boot drain 吞生产 marker — 实施计划

Issue: FLY-1608 (https://linear.app/geoforge3d/issue/FLY-1608/529房既有缺陷2-test-deploy-从仓库根起-lead-秒死729-起全坏-complete-marker-boot-drain)
日期: 2026-08-02
基于: research.md

## 0. 一句话

两刀独立小修:① `claude-lead.sh` 的 FLY-1502 守卫自锚定到脚本所在 package(任何调用者 cwd 都能解析)+ `test-deploy.sh` 把 Lead 子进程 cwd 钉到 `packages/teamlead` 复刻生产 wrapper;② 新 env `FLYWHEEL_COMPLETE_MARKER_DIR` 给 complete-failed marker 目录开隔离缝(写入侧 + 读取侧 + Runner 透传 + 529 房设 slot 路径),unset 时字节兼容现状。

## 1. 改动清单(Change A/B 相互独立,可独立 revert)

### Change A — 缺陷 ①:守卫 cwd 自锚定 + 房间 cwd 对齐生产

#### A1. `packages/teamlead/scripts/claude-lead.sh`(守卫块,现 `:72-80`)

```bash
# FLY-1502: ...(既有注释保留)
# FLY-1608: the bare `import("flywheel-v2-kernel")` resolves from the node
# process cwd. Only packages/teamlead/node_modules has the workspace link, so
# the guard MUST run from the script's own package dir — callers (production
# wrapper, test-deploy, ad-hoc operators) must not need to know that.
if [ "${FLYWHEEL_LEAD_DRY_RUN:-0}" != "1" ]; then
  _v2_guard_pkg_dir="$(cd "$(dirname "$0")/.." && pwd)"
  if ! (cd "$_v2_guard_pkg_dir" && node --input-type=module -e \
      'import("flywheel-v2-kernel").then(({requireLegacyWriterAllowedFromEnvironment}) => requireLegacyWriterAllowedFromEnvironment(process.env))'); then
    echo "[lead] ERROR: FLY-1502 v2 legacy-writer guard failed (see error above)." >&2
    echo "[lead]   If it is ERR_MODULE_NOT_FOUND: flywheel-v2-kernel is not installed/built in ${_v2_guard_pkg_dir} — run 'pnpm install && pnpm -r build' at the repo root." >&2
    echo "[lead]   Otherwise: the armed v2 cutover authority denied legacy Lead startup — this fail-closed stop is intentional (FLY-1502)." >&2
    exit 1
  fi
fi
```

要点:
- **fail-closed 不变**:守卫任何失败仍 `exit 1`;只是把两种失败(解析环境坏 vs authority 拒绝)在 stderr 分流指引,满足验收"明确报错指引"。
- 子 shell `cd`,不改 supervisor 本体 cwd(生产 wrapper 下行为逐字不变 —— 它本来就在 `packages/teamlead`)。
- 用 `$(dirname "$0")`,与脚本既有 `SCRIPT_DIR` 推导(`:209`)同款;守卫在 SCRIPT_DIR 计算之前,故就地取。
- `if ! (...)` 形态在 `set -e` 下安全(条件上下文不触发 errexit),显式 `exit 1` 收口。

#### A2. `scripts/test-deploy.sh`(两个 Lead 启动位点 `:1158` / `:1450`)

把 Lead 启动包进子 shell:先 cd 到 `packages/teamlead`,再 **`exec`** 掉子 shell 本体,精确复刻生产 wrapper `flywheel-lead-wrapper.sh:222/231` 的语义(它也是 cd + exec):

```bash
# FLY-1608: production wrapper runs claude-lead.sh with cwd=packages/teamlead
# then execs (flywheel-lead-wrapper.sh:222/231). Mirror it EXACTLY — the exec
# is load-bearing: without it $! is the intermediate subshell PID, not the
# supervisor, and every early-failure kill path targets the wrong process
# (Codex design R1 HIGH-1).
( cd "${REPO_ROOT}/packages/teamlead" || exit 1; exec env ... bash "${REPO_ROOT}/packages/teamlead/scripts/claude-lead.sh" ... ) > "${LEAD_LOG}" 2>&1 &
```

要点:
- A1 已治本,A2 是生产等价性加固(FLY-1389 教训:房间必须复刻生产语义,防未来 cwd 敏感代码再分叉)。
- **`exec` 必须有**(Codex R1 HIGH-1):macOS bash 3.2 下 `( cd && env ... bash ... ) &` 的 `$!` 是中间 subshell 的 PID,不是 Lead supervisor。test-deploy 的启动失败路径直接 `kill "$LEAD_BG_PID"`(`:1244-1248,1301-1310,1587-1601`),而 supervisor 的 PID file 很晚才写(claude-lead.sh `:3128` 附近)—— 杀错中间壳会留 orphan Lead。`cd || exit 1; exec env ...` 让 `$!` 恰为 supervisor PID,`LEAD_BG_PID`/`EXTRA_LEAD_BG_PIDS` 语义保持真值。
- 配套 hermetic 回归(见 T1b):stub supervisor 记录 `$$` 与 cwd,断言日志 PID == stub `$$` 且 cwd = `${REPO_ROOT}/packages/teamlead`;进程消失由 **test-deploy 自己的 failure-path kill 触发**,外层用有界 `kill -0` 轮询验证(外层不能跨 shell `wait`)。main 与 extra-lead 两个位点都断言。
- 传给脚本的参数全是绝对路径(`REPO_ROOT`/`HOST_REPO`),cd 不影响参数解析。

### Change B — 缺陷 ②:`FLYWHEEL_COMPLETE_MARKER_DIR` 隔离缝

单旋钮:`FLYWHEEL_COMPLETE_MARKER_DIR`(命名对齐既有 `FLYWHEEL_GATE_MARKER_DIR`)。quarantine **不另设 env**,恒派生 `<markerDir>-quarantine`,消灭半隔离脚枪。

#### B1. 读取侧 `packages/teamlead/src/bridge/complete-marker-reconciler.ts:72-89`

```ts
/** Default marker directory — mirrors `flywheel-comm/complete.ts` writeMarker().
 * FLY-1608: FLYWHEEL_COMPLETE_MARKER_DIR overrides for slot isolation (529 QA
 * room). Unset → byte-identical legacy path. */
export function defaultMarkerDir(): string {
  const fromEnv = process.env.FLYWHEEL_COMPLETE_MARKER_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(process.env.HOME ?? homedir(), ".flywheel", "state", "complete-failed");
}

/** Default quarantine directory — ALWAYS `<markerDir>-quarantine` so one env
 * knob isolates both (a half-isolated quarantine would still pollute prod). */
export function defaultQuarantineDir(): string {
  return `${defaultMarkerDir()}-quarantine`;
}
```

- unset 时 `defaultQuarantineDir()` = `~/.flywheel/state/complete-failed` + `-quarantine` = 现状逐字节相等(research §2.2 已核)。
- research §2.2 已核:boot drain(`plugin.ts:8841`)、heartbeat 三处重放(`HeartbeatService.ts:938/1060/1129`)、done-running sweep(`done-running-reconciler.ts:94/182`)全部经这两个 default 函数收口 → 单点生效。
- **resolver 层派生(Codex R1 MED-3)**:只改 `defaultQuarantineDir()` 不够 —— `tryReconcileComplete()`(`:397-403`)与 boot drain 是**各自独立**解析 `deps.markerDir ?? defaultMarkerDir()` 和 `deps.quarantineDir ?? defaultQuarantineDir()` 的,调用者只传 `deps.markerDir` 时 quarantine 仍会落回 env/HOME 默认 → 半隔离脚枪原样复活。改为:在同一处先求实际 `markerDir`,再 `const quarantineDir = deps.quarantineDir ?? \`${markerDir}-quarantine\``(**从 resolved markerDir 派生**,显式 `deps.quarantineDir` 覆盖能力保留);boot drain 与单 marker 重放共用同一对 resolved dirs,不各自重推。配套测试:传 `deps.markerDir`、不传 quarantine,制造不可重放 marker,断言它只落 `<deps.markerDir>-quarantine`,默认/生产目录 inventory 不变。既有测试若依赖"只传 markerDir 时 quarantine=HOME 默认"需同步修正(那正是要消灭的语义)。

#### B2. 写入侧 `packages/flywheel-comm/src/commands/complete.ts:700-707`(`writeMarker()`)

```ts
// FLY-1608: mirror teamlead complete-marker-reconciler defaultMarkerDir() —
// FLYWHEEL_COMPLETE_MARKER_DIR overrides for slot isolation; unset → legacy.
const fromEnv = process.env.FLYWHEEL_COMPLETE_MARKER_DIR?.trim();
const dir = fromEnv || join(process.env.HOME ?? homedir(), ".flywheel", "state", "complete-failed");
```

两包各自解析、mirror 注释互指(沿用现状的 mirror-comment 契约;两侧各有 sentinel 测试钉住,见 §2)。

#### B3. Runner 透传(marker 由 Runner 进程写,tmux 窗口 env 不继承 Bridge 进程 env — research §2.4)

照抄 `FLYWHEEL_GATE_MARKER_DIR` / `FLYWHEEL_STATE_DB_PATH` 的既有轨道:

1. `packages/claude-runner/src/TmuxAdapter.ts`(`createSession` envArgs 块,`:444-470` 附近):
   ```ts
   // FLY-1608: slot-isolated complete-failed marker dir must reach the runner
   // (it is the writer). Absent → runner falls back to the legacy HOME path.
   const completeMarkerDir = process.env.FLYWHEEL_COMPLETE_MARKER_DIR?.trim();
   if (completeMarkerDir) {
     envArgs.push("-e", `FLYWHEEL_COMPLETE_MARKER_DIR=${completeMarkerDir}`);
   }
   ```
   基类注入,claude/antigravity/kimi 子类共用。
2. Codex 侧(Codex R1 MED-4,**无条件做,不留"若需要再补"**):`CodexTmuxAdapter` **不是** TmuxAdapter 子类(`CodexTmuxAdapter.ts:200` 独立实现),其 daemon env 来自 `stripInheritedSecretEnv(process.env)`,该 sanitizer 只放行 `codex-home.ts:133-152` 的精确 allowlist → `FLYWHEEL_COMPLETE_MARKER_DIR` **必须**加进 allowlist,否则 Codex runner 永远拿不到隔离值。测试断言到**实际 captured daemon env**(set/unset 两态,扩展 `CodexTmuxAdapter.test.ts:675-695`),只测 sanitizer 不够。
3. 直接进程型 `ClaudeCodeAdapter` 复制 Bridge `process.env` → 零改动即继承,不动。

#### B4. 529 房接线 `scripts/test-deploy.sh`(env 数组初始化区 `:608-741`)

```bash
# FLY-1608: slot-isolate the complete-failed marker dir (writer=runner via
# adapter passthrough, reader=Bridge boot drain / heartbeat replay). Without
# this the slot Bridge drains PRODUCTION markers into prod quarantine
# (FLY-1606 incident) and slot crash-test markers land in the prod dir.
BRIDGE_EXTRA_ENV+=("FLYWHEEL_COMPLETE_MARKER_DIR=${SLOT_DIR}/state/complete-failed")
LEAD_EXTRA_ENV+=("FLYWHEEL_COMPLETE_MARKER_DIR=${SLOT_DIR}/state/complete-failed")
```

- 两个 Bridge 启动分支(reply-by-issue ON/OFF)与两个 Lead 位点都展开 EXTRA_ENV 数组 → 单点追加零双写(research §2.5)。
- 目录不需预建:写入侧 `mkdirSync(dir, {recursive:true})`,读取侧 `existsSync` 缺目录即静默返回(`:1013`)。
- **hermetic 断言(Codex R1 MED-4)**:扩展既有 `scripts/__tests__/test-deploy-fly1389.test.sh`(stub 已落 `lead-env.txt`/`bridge-env.txt`,断言入口 `:225-247`):断言两份 env 快照都含同一 slot-local `FLYWHEEL_COMPLETE_MARKER_DIR=${SLOT_DIR}/state/complete-failed`,覆盖 reply-by-issue ON/OFF 两分支与 main/extra Lead 两位点。同步修正 `test-deploy-qa-room.test.sh:2-5,28-35` 的"EXTRA_ENV 数组保持为空"描述/镜像断言 —— 本单新增无条件注入后,旧断言若不更新会 false-green 或误红。

#### B5. 操作提示同步 `.claude/commands/spin.md:419,434`(Codex R1 MED-5 附带)

spin.md 里硬编码的 `$HOME/.flywheel/state/complete-failed` 操作提示改为显示实际解析结果(`${FLYWHEEL_COMPLETE_MARKER_DIR:-$HOME/.flywheel/state/complete-failed}`)—— 否则 slot runner 正确写进隔离目录后,操作员仍被指向生产目录找 marker。

## 2. TDD(先红后绿)

| # | 测试 | 红断言 | 位置 |
|---|---|---|---|
| T1 | 守卫 cwd 回归(bash harness,hermetic — Codex R1 HIGH-2 重写) | 用**绝对脚本路径** `bash "${REPO_ROOT}/packages/teamlead/scripts/claude-lead.sh"`(无参),分别在 cwd=仓库根 与 cwd=`mktemp -d` 各跑一次;env 用 `env -i PATH=... HOME=<临时HOME> FLYWHEEL_LEAD_DRY_RUN=0` 隔离宿主污染(宿主可能有 `FLYWHEEL_LEAD_DRY_RUN=1` 或已 armed 的真 `~/.flywheel` authority — `packages/v2-kernel/src/paths.ts:10-20` 按 HOME 派生,临时 HOME = unarmed = allowed)。断言:stderr 出现 `Usage:`(守卫已通过、死在参数校验)且**不含** `ERR_MODULE_NOT_FOUND`。修前从仓库根跑 = 含 ERR_MODULE_NOT_FOUND、无 Usage → 红。**CI 注册**:shell suites 在 `.github/workflows/ci.yml:118-125,287-307` 显式枚举,新 harness 必须加进去(`pnpm test:packages:run` 不会发现它) | `scripts/__tests__/test-fly1608-lead-guard-cwd.test.sh`(新)+ ci.yml 注册 |
| T1b | A2 PID/cwd 真值回归(真实失败路径 E2E — Codex R2 HIGH-1 重写) | 外层 harness **不能**对 test-deploy 内部的 Lead 做 `wait`(不是外层 shell 的直接 child,bash 3.2 下 `wait <pid>` rc=127)→ 改为触发 test-deploy **自己的**失败 kill 路径,外层只观察:**main case** = Bridge stub 起后立即退出 → test-deploy 走 `:1587-1591` 亲手 kill 它拥有的 `LEAD_BG_PID`;外层从日志解析 `Lead background PID`(`:1161-1162`),与 stub claude-lead.sh 记录的 `$$` 比较(证 exec 生效、`$!`=supervisor 本尊)、断言 stub cwd=`${REPO_ROOT}/packages/teamlead`,再用**有界 `kill -0` 轮询**证进程消失。**extra case** = 新建 hermetic campaign fixture:一个 extra stub 不产生 readiness lease → 短 timeout 触发 `campaign_abort()`;同样比较 main/extra 的 logged PID 与各自 `$$`、轮询两者均不存在(现有 `test-deploy-multilead.test.sh` 只跑 helper/teardown fixture + source sentinel,不起 extra-Lead 分支,故需新 fixture)。T8 的 extra-Lead env 断言复用该 campaign fixture | `scripts/__tests__/test-deploy-fly1389.test.sh` 扩展(main)+ 新 hermetic campaign fixture(extra;注册进 ci.yml) |
| T2 | reader env 覆盖 | `FLYWHEEL_COMPLETE_MARKER_DIR=/tmp/x` 时 `defaultMarkerDir()==="/tmp/x"` 且 `defaultQuarantineDir()==="/tmp/x-quarantine"` | `packages/teamlead/src/__tests__/complete-marker-reconciler.test.ts` 追加 |
| T3 | reader 字节兼容 sentinel | env unset 时两函数逐字节等于 `$HOME/.flywheel/state/complete-failed{,-quarantine}`(钉死 legacy 形态,防未来漂移) | 同上 |
| T4 | writer env 覆盖 + sentinel | `writeMarker` 在 env 设/未设两态下的落盘路径断言(经既有 complete 测试的 HOME 沙箱形态) | `packages/flywheel-comm/src/__tests__/complete.test.ts` 追加 |
| T5 | adapter 透传 | Bridge 进程 env 设 `FLYWHEEL_COMPLETE_MARKER_DIR` → tmux `-e` args 含之;未设 → 不含(照抄 `FLYWHEEL_GATE_MARKER_DIR` 测试形态)。Codex 侧断言到**实际 captured daemon env**(set/unset 两态,`CodexTmuxAdapter.test.ts:675-695` 扩展),不只测 codex-home sanitizer | `packages/claude-runner/test/`(TmuxAdapter + CodexTmuxAdapter + codex-home) |
| T6 | boot drain 隔离(integration) | `reconcileCompleteFailedMarkers` 不传 deps.markerDir、仅设 env → 只扫 env 目录;植入的"生产"目录 decoy 文件前后 inventory 逐字节不变 | `complete-marker-reconciler.integration.test.ts` 追加 |
| T7 | resolver 层 quarantine 派生 | 只传 `deps.markerDir`(不传 quarantine)+ 制造不可重放 marker → 断言它落 `<deps.markerDir>-quarantine`,env/HOME 默认目录 inventory 不变 | `complete-marker-reconciler.test.ts` 追加 |
| T8 | test-deploy env 落地(hermetic E2E) | `lead-env.txt`/`bridge-env.txt` 都含 `FLYWHEEL_COMPLETE_MARKER_DIR=${SLOT_DIR}/state/complete-failed`,覆盖 reply-by-issue ON/OFF + main/extra Lead;`test-deploy-qa-room.test.sh` 的 byte-compat 镜像描述同步修正 | `test-deploy-fly1389.test.sh` 扩展(main)+ T1b 的新 hermetic campaign fixture(extra-Lead env 断言) |

全仓门(FLY-224/248 教训):`pnpm lint` + `pnpm -r build` + `pnpm test:packages:run` + 新 shell harness。

## 3. 529 真机验收(镜像 issue 验收标准;implement/QA 节点执行)

1. **①**:仓库根 `bash scripts/test-deploy.sh <slot> ...` → Lead ready(inbox lease 出现);再从 `packages/teamlead` cwd 跑一遍 → 同样 ready。**变异判据**:revert A1+A2 → 仓库根跑回到秒死。
2. **②**:生产 `~/.flywheel/state/complete-failed{,-quarantine}/` 先 `ls -la` 快照 + 植入 decoy marker;slot Bridge 启动完成后再快照 → **逐字节 0 触碰**(decoy 仍在、quarantine 无新增);slot 目录内植入的 slot marker 被正常 drain(证明房间还能测 drain 本身)。**变异判据**:去掉 `FLYWHEEL_COMPLETE_MARKER_DIR` 注入 → bridge.log 出现对生产目录的 `boot drain: scanned>=1` → 证明尺子有效。
   **decoy 生命周期契约(Codex R1 MED-5,防 QA 自己污染生产)**:decoy 用唯一 issue-scoped 文件名(如 `fly1608-qa-decoy-<ts>.json`,内容为不可重放的哑负载);植入前先快照 marker + quarantine **两个**目录并记录 decoy hash;整个验收段挂 `trap`,退出时只清理该 decoy 在两目录中的副本;最终核对"除 decoy 外 inventory 前后一致";**绝不移动/恢复 FLY-1606 或任何真实 marker**(那是 FLY-1607 的活)。变异步骤(故意让未隔离 Bridge 扫生产)必须在 decoy trap 挂好之后进行 —— decoy 被扫进生产 quarantine 也能被 trap 按名清掉。
3. 部署效果由独立 QA 验(feedback_independent_qa_before_destructive_deploy),不由实现者自报。

## 4. 字节兼容 / 生产影响

- **生产零行为变化**:`FLYWHEEL_COMPLETE_MARKER_DIR` 生产不设 → 读写两侧路径逐字节现状(T3/T4 sentinel 钉住);守卫在生产 wrapper cwd 下逐字同行为(它本就在 packages/teamlead);adapter 未设 env 不注入任何新 `-e`。
- **不需要重启生产 Bridge**:改动生效面 = 529 房部署脚本 + 下次任何 Bridge/Lead 启动时的路径解析。生产按正常 ship 节奏随下次重启吸收,无专门运维动作。

## 5. 明确不做(honest boundary)

- **不恢复被吞的 1606 marker** —— 归 FLY-1607 收敛步骤(本单验收明确排除)。
- **不做广义 state root 隔离**(`FLYWHEEL_STATE_DIR` 类) —— 只隔离 complete-failed{,-quarantine} 一对目录;其他 HOME 派生路径各有各的 env(claims/alert/bin/hooks)或不在本单 scope。
- **不碰 codex-lead.sh** —— 它没有 FLY-1502 守卫(research §1.5)。
- **不弱化 fail-closed** —— 守卫任何失败仍拒启;不加 skip flag、不给 drain 加开关。
- **`deps.markerDir/quarantineDir` 注入字段与显式 quarantine 覆盖能力保持兼容**;但 markerDir-only 调用的 quarantine 落点按新 invariant(`<resolved markerDir>-quarantine`)改变 —— 依赖旧"markerDir-only 时 quarantine=HOME 默认"语义的既有测试按新 invariant 更新(Codex R2 LOW-2:这正是要消灭的半隔离语义,不保留)。

## 6. 交付物

- Change A + B 代码与测试,一个 PR(base=main),分支 `flywheel-FLY-1608`。
- 本 doc 文件夹随分支进 PR;CLAUDE.md 里程碑行 = PR 最后一个 commit(feedback_archive_docs_in_main_pr)。
