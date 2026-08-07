# FLY-1649 r4 重迁窗口 — 实施计划

Issue: FLY-1649 (https://linear.app/geoforge3d/issue/FLY-1649/1572-r4-preflight批1-重迁前加固包geoforge3d-完整性误判修复-growth-残表清理-回滚脚本撞锁重试)
日期: 2026-08-06
基于: plan.md

## 0. 使用边界

这是 r4 的 canonical runbook。**本单的 founder 授权只授权开 issue/做修理,不等于授权执行 r4 重迁**。窗口开始前必须拿到 Annie 对「这个 target SHA、这个时间窗、6 分片 reset」的单独明确授权,并把原文、时间、消息 id 写进 `~/.flywheel/r4/authorization.txt`。

窗口只允许通过 `~/.flywheel/r4/window-r4.sh` 执行。禁止临场改命令、禁止 detached `restart-services.sh`、禁止 `|| true`、禁止 code-only rollback。所有 rollback 必须用 Phase S 生成的 `rollback-r4.sh`,把代码、dist、7 分片 DB/sidecar/refs、`deployed-sha` 成对回置。

生命周期固定为:

```text
Q quiesce → S snapshot → M mutate → B Bridge-only → C commit/activate → R restore
```

- 自动整态 rollback 的合法区间:Phase S 已验证之后的第一笔持久 mutation,到 Phase C Lead 激活开始之前。
- Phase C 一开始即越过 commit boundary。此后失败不得直接跑 rollback;若 Annie 决定整态回滚,必须先重新完整执行 Phase Q,再运行已经渲染好的 `rollback-r4.sh`。
- 任意错误先保留 `~/.flywheel/r4/`,不得删除 r2/r3/r4 物证。

## 1. 现场状态快照(有保质期,窗口前必须重验)

2026-08-06 15:53 MDT 的只读检查:

| 项目 | 观察值 | 结论 |
|---|---|---|
| `com.flywheel.updater` | `launchctl print gui/501/com.flywheel.updater` = not found | 当前 unloaded;只能当快照,不是未来保证 |
| self-ship queue | `~/.flywheel/self-ship-pending.d/` 空 | 当前无 QueueDirectories 触发物 |
| deployed/main | `4857d999e353c7f3c0ed043208402943f4a0e9b8` | 旧栈仍是 deployed truth |
| `origin/main` | `d3cd8a63ee0b60ab1e0adc4bbd34dc91d7462a38` | 已从早先 `84df9168` 继续前进;**不得把本文数字当 r4 target** |
| updater plist | repo SHA-256 `19ae7c…`;installed `68a804…` | 仍漂移:installed=06:00/no queue,repo=00:00+12:00/QueueDirectories |
| growth generation | 只有 legacy `messages`/`lead_inbox` tables | 当前 clean legacy,不是 mixed |
| growth canonical modes | main/wal/shm 都是 `0600` | 当前权限正常 |

核实结论:updater 当前不会在稳态窗口内自动动 checkout,因为 job unloaded 且队列为空。但任何人 bootstrap/kickstart、任何新 marker、任何 plist 替换都会使该结论失效。Phase Q 到 Phase C 期间 controller 持续要求 updater unloaded;Phase R 才允许恢复。

## 2. 八个硬前置(有一项不绿就不开窗)

1. **独立 r4 授权**:记录 Annie 对 exact target/window/reset6 的授权。旧的「开 issue」授权不能代替。
2. **FLY-1648 热循环检查绿**:把 sibling issue 的 merge SHA、测试证据、stormwatch 判据写进 `preflight-evidence.md`。
3. **FLY-1649 已 merge 且 dist 来自该 target**:target 必须同时包含 FLY-1648、FLY-1649;全仓 `lint/build/package tests` 与 FLY-1649 三个 shell suite 全绿。
4. **未读语义逐条对账就绪**:沿用 FLY-1646 Cass 口径 `7,036 / 1,102 / 389`;迁移前保存每条 identity 集,迁移后逐条相等。特别断言 legacy `delivered_at IS NOT NULL` 的行不进入新 pending 集。只比总数不算通过。
5. **7 分片 generation 与权限**:growth 必须 `legacy`;任一 `mixed/unknown` 停。只扫精确 canonical `comm.db`、`comm.db-wal`、`comm.db-shm`,存在即 owner-writable。禁止 `comm.db*` glob,禁止改动 `*.migrated-r2-failed*` 等后缀物证。
6. **updater 双闸**:job unloaded;queue 空。两项在窗口开始与 Phase R bootstrap 前各查一次。
7. **整态 rollback 工件合同**:7 分片 DB/sidecar/refs manifest、known-good SHA、known-good dist tar、渲染后的 rollback 脚本都存在且人工核对。不得只有 code rollback。
8. **残留物证冻结**:`*.migrated-r2-failed*`、`retired-r3-*`、`.fly1572-*`、r3/r4 logs 在 r4 成功验收前只盘点、不归档、不 chmod。

## 3. 窗口前生成不可变工件

在 FLY-1648/FLY-1649 都 merge 后,先选 exact target。下面命令只准备工件,不执行迁移:

```bash
export REPO="$HOME/Dev/flywheel"
export R4="$HOME/.flywheel/r4"
export TARGET_SHA="$(git -C "$REPO" rev-parse origin/main)"

mkdir -p "$R4"
cp "$REPO/scripts/r4/r4-window.sh" "$R4/window-r4.sh.stage"
cp "$REPO/scripts/r4/snapshot-r4.sh" "$R4/snapshot-r4.sh.stage"
cp "$REPO/scripts/r4/rollback-r4.sh" "$R4/rollback-r4.template.sh.stage"
cp "$REPO/scripts/lib/bridge-process-tree.sh" "$R4/bridge-process-tree.sh.stage"

python3 - "$R4/window-r4.sh.stage" "$REPO" "$TARGET_SHA" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
text = text.replace("__FLY1649_REPO__", sys.argv[2])
text = text.replace("__FLY1649_TARGET_SHA__", sys.argv[3])
path.write_text(text)
PY

bash -n "$R4/window-r4.sh.stage" "$R4/snapshot-r4.sh.stage" \
  "$R4/rollback-r4.template.sh.stage" "$R4/bridge-process-tree.sh.stage"
! grep -R '__FLY1649_REPO__\|__FLY1649_TARGET_SHA__' \
  "$R4/window-r4.sh.stage"

chmod 0500 "$R4/window-r4.sh.stage" "$R4/snapshot-r4.sh.stage" \
  "$R4/rollback-r4.template.sh.stage" "$R4/bridge-process-tree.sh.stage"
mv "$R4/window-r4.sh.stage" "$R4/window-r4.sh"
mv "$R4/snapshot-r4.sh.stage" "$R4/snapshot-r4.sh"
mv "$R4/rollback-r4.template.sh.stage" "$R4/rollback-r4.template.sh"
mv "$R4/bridge-process-tree.sh.stage" "$R4/bridge-process-tree.sh"

shasum -a 256 "$R4/window-r4.sh" "$R4/snapshot-r4.sh" \
  "$R4/rollback-r4.template.sh" "$R4/bridge-process-tree.sh" \
  > "$R4/artifacts.sha256"
printf '%s\n' "$TARGET_SHA" > "$R4/target.sha"
```

再把本文复制为窗口副本,窗口中只读:

```bash
cp "$REPO/engineering/doc/FLY-1649-r4-preflight-hardening/r4-runbook.md" \
  "$R4/runbook.md.stage"
chmod 0400 "$R4/runbook.md.stage"
mv "$R4/runbook.md.stage" "$R4/runbook.md"
```

执行前人工核对:

```bash
shasum -a 256 -c "$R4/artifacts.sha256"
test "$(cat "$R4/target.sha")" = "$(git -C "$REPO" rev-parse origin/main)"
git -C "$REPO" merge-base --is-ancestor \
  "<FLY-1648 merge SHA>" "$(cat "$R4/target.sha")"
git -C "$REPO" merge-base --is-ancestor \
  "<FLY-1649 merge SHA>" "$(cat "$R4/target.sha")"
```

若 `origin/main` 又前进,不要临场接受新 SHA;重新评审、重新生成整套工件。

## 4. growth mixed 应急程序(仅在 G1 重验红时)

controller 会在 Phase Q quiesce 后用 `sqlite3` 对 7 个精确 canonical 路径独立 classify,写入 `~/.flywheel/r4/inventory-before.json`;它不依赖窗口前旧 checkout 里的 migration CLI。growth 不是 `legacy`,或任何分片是 `mixed/unknown`,都会在快照/持久 mutation 前 fail-loud。

如果 mixed 复现:

1. 不 cutover,不 drop 表,不按 `mailbox*`/`receipt*` 前缀清理。
2. 有 `<db>.migration-swap-intent.json`:在保持全量 quiesce 下,走既有 `--rollback --db <exact-path>`,再跑 inventory。
3. 无 intent:只用已验证的 `backupCommDb` 产物。它的真实形态是 standalone DB + `<backup>.refs/` + `<backup>.refs-manifest.json`,**没有 wal/shm 可复制**。
4. 对 backup DB 跑 `PRAGMA quick_check`,确认 classify=`legacy`,按 refs manifest 验 hash/size/mode。任一失败,该分片退出本次 r4并报 Annie。
5. 把 live canonical main/wal/shm 全部移动到同一时间戳 quarantine;复制 standalone backup DB 为 canonical main;refs 按 manifest staged 恢复。不要从 backup 猜造 wal/shm。
6. 复跑 inventory=`legacy`,并用 `scripts/__tests__/fixtures/fly1649-legacy-mailbox-digest.ts` 的独立 canonical digest 比较 legacy 两表 schema+逐行内容。摘要不等即失败。

## 5. 正式执行

开始前再次确认 updater 与队列,并保存输出:

```bash
launchctl print "gui/$(id -u)/com.flywheel.updater" \
  > "$R4/updater-before.txt" 2>&1 || true
find "$HOME/.flywheel/self-ship-pending.d" -mindepth 1 -maxdepth 1 -print \
  > "$R4/updater-queue-before.txt"
test ! -s "$R4/updater-queue-before.txt"
grep -q 'Could not find service\|service not found' "$R4/updater-before.txt"
```

确认 `authorization.txt` 里的授权覆盖 exact target 后,只执行:

```bash
R4_FOUNDER_AUTHORIZED=1 "$R4/window-r4.sh"
```

执行中看:

```bash
tail -f "$R4/progress.log"
cat "$R4/state"
```

不要同时运行 updater、另一个 restart、Bridge/Lead 手工启动命令或第二份 window script。

## 6. 六 phase 的机器合同

### Phase Q — quiesce

controller 顺序:

1. 对 `~/.flywheel/manifests/*.json` 中所有非 `flywheel-test-*` Lead 建立 production set。只要有 manifest 对应 job unloaded,就在快照前失败,由 Annie 决定移走 manifest 或恢复 job后重开窗口。
2. 要求 updater 已 unloaded且队列空;记录 Bridge 原始 loaded/unloaded 状态。
3. 记录所有 installed `com.flywheel.lead.*.plist` 的 loaded 集并全部 bootout(含测试/辅助 carrier);Bridge 原始 loaded 才 bootout Bridge。production manifest 集另作硬前置与终局健康判定。
4. 用共享 `bridge-process-tree.sh` 按 :9876 listener→ancestor tree 收掉 nohup Bridge,确认端口解绑。
5. 确认 Bridge/updater/全部 Lead launch authority 都 unloaded,7 个 canonical DB 零 holder。
6. 精确扫描 canonical main/wal/shm owner-write bit;重跑 7 分片 inventory。growth 必须 legacy,无 mixed/unknown。

任何失败都在 Phase S 前停止,并恢复窗口前 authority;零 DB/code mutation。

### Phase S — snapshot

1. 再查 launch authority 与 DB holder。
2. `snapshot-r4.sh` 拷 7 分片 canonical main/在场 sidecar/完整 refs tree。
3. 单一 `manifest.tsv` 记录相对路径、bytes、mode、SHA-256;每个 snapshot DB `PRAGMA quick_check=ok`。
4. 保存 known-good SHA 和所有现有 package dist 到 tar。
5. 从 immutable template 渲染 `rollback-r4.sh`,写死 repo/known-good/dist/snapshot 四值,chmod 0500。

从下一步第一笔 mutation 起,rollback 被 armed。

### Phase M — mutation

1. 6 个 non-flywheel 分片的 canonical main/wal/shm 精确移动进 `retired-r4-<timestamp>/`;不碰后缀物证。
2. main `--ff-only` 到 rendered target,要求 HEAD exact 相等;`pnpm install --frozen-lockfile && pnpm build`。
3. `unset FLYWHEEL_COMM_DB`;迁移 flywheel legacy shard。CLI 对全部发现的 canonical 路径执行权限检查与真实 CommDB verify-open。
4. `preflight-r4.ts` 用与 Bridge boot 相同的 `CommDB` 打开 7 分片:`flywheel` 必须已存在(`createIfMissing=false`),缺失即 fail-closed;6 个刚 reset 的 non-flywheel 分片允许 `createIfMissing=true`,在此创建 virgin mailbox DB。全部使用 `archiveOnOpen=false`,随后复查 canonical 权限。
5. 运行 FLY-1646 迁移前后未读 identity 对账。`7,036 / 1,102 / 389` 是已知口径,但通过条件是**集合逐条相等**,不是硬凑总数。

Phase M 任意失败自动走整态 rollback。

### Phase B — Bridge-only

启动命令固定为:

```bash
cd "$REPO" || exit 1
nohup npx tsx scripts/run-bridge.ts >> /tmp/flywheel-bridge.log 2>&1 < /dev/null &
BRIDGE_TRIAL_PID=$!
```

不经 `restart-services.sh`,不 bootstrap Bridge plist,不启动 Lead。controller 等 `/health`,再跑至少 5 个 60 秒 stormwatch sample;每轮断言:

- Bridge health true;
- production Lead launch authority 仍为空;
- 7 分片 DB holder 全属于 trial Bridge process tree;
- 无新 `Fatal`;
- pending 计数查询成功。

启动早夭、health 红、stormwatch 红都会先收割整个 wrapper→tsx→node tree,逐 PID 验死且 :9876 解绑;只有清理证明全绿才允许整态 rollback。单独 kill `$!` 不算清理。

### Phase C — commit + activate

stormwatch 全绿就是 commit boundary。先恢复所有 production Lead launch authority;Bridge 若窗口前原本 loaded,先收 trial/清端口再 bootstrap Bridge,否则维持 nohup authority。唯一合法 fleet activation:

```bash
FLYWHEEL_RESTART_FOREGROUND=1 \
FLYWHEEL_RESTART_DISABLE_CODE_ROLLBACK=1 \
  bash "$REPO/scripts/restart-services.sh" --reason fly1572-r4-activate
```

禁止 `|| true`。输出出现 `[restart] detached` 即失败。返回 0 之后仍须 Bridge health + 每个 production Lead loaded 全绿,才可进 Phase R。

Phase C 起失败不自动 rollback。要整态回退,必须重新 Q 全量 quiesce后再运行 `rollback-r4.sh`。

### Phase R — updater + final census

updater canonical 取 repo 版。恢复是 staged 原子安装:

1. `plutil -lint` repo source;
2. copy 到安装目录内 temp;chmod 0644,核 uid/mode;
3. staged 文件再次 lint,并解析确认 QueueDirectories 精确指向 self-ship queue、calendar 精确为 00:00/12:00;
4. atomic `mv` 换入;
5. **bootstrap 前最后一刻**重查 queue 仍空;
6. bootstrap,`launchctl print` 必须 loaded。

最终机器判据::9876 恰好一个 listener、`/health.ok=true`、所有 production Lead loaded、updater loaded。

## 7. Authority 终态矩阵

| Authority | 窗口前要求/记录 | r4 成功终态 | pre-commit rollback 终态 |
|---|---|---|---|
| Bridge | loaded 或 unloaded,精确记录 | 保持原 authority 形态;loaded 走 launchd,unloaded 走 nohup | rollback 的前台旧栈 restart 恢复健康;原 unloaded 不 bootstrap |
| production Leads | 所有 manifest Lead 必须 loaded | 原集合全部 loaded | rollback 时保持 booted-out,由旧栈前台 restart 拉起 |
| manifest 存在但 unloaded Lead | 不允许进窗口 | — | — |
| updater | 必须 unloaded且 queue 空 | repo canonical plist,loaded | rollback 后仍 unloaded;是否恢复由复盘决定 |

## 8. rollback 使用与失败升级

pre-commit 自动 rollback 会:

1. 在任何 mutation 前 bounded 等待并独占 `restart.lock.d`;
2. 断言 Bridge/updater/所有 Lead authority empty,7 DB 零 holder;
3. checkout known-good + 恢复 verified dist;
4. staged 恢复 7 分片 DB/sidecar/refs,全量 manifest/hash/quick_check 复验;失败时从 quarantine 复位 canonical;
5. 原子写回 `deployed-sha=KNOWN_GOOD`;
6. ownership-safe 释放锁;
7. 前台运行旧栈 restart并等 Bridge health。

以下情况 fail-close,不得手工跳过:

- 锁 10 分钟未取得;
- launch authority 或 DB holder 未排空;
- snapshot/manifest/dist 任一校验失败;
- 释放锁失败;
- restart 非零或 health 超时。

报告时附 `state`、`progress.log`、`artifacts.sha256`、`inventory-before.json`、snapshot manifest、restart/Bridge log。不要删除 quarantine。

## 9. r4 成功后的验收与清账

全部满足才宣布完成:

```bash
cat "$R4/state"                       # DONE target=<exact SHA>
curl -sf localhost:9876/health | jq -e '.ok == true'
lsof -nP -iTCP:9876 -sTCP:LISTEN -t | awk 'NF {n++} END {exit n == 1 ? 0 : 1}'
launchctl print "gui/$(id -u)/com.flywheel.updater" >/dev/null
shasum -a 256 -c "$R4/artifacts.sha256"
```

再完成:

- 迁移后未读 identity 与迁移前逐条相等;`delivered_at IS NOT NULL` 旧行零误入 pending;
- 7 分片 `PRAGMA quick_check=ok`,generation 全部 mailbox_v1,canonical 权限正常;
- FLY-1648 热循环 stormwatch 继续绿;
- updater queue 仍空,installed plist 与 repo canonical digest 相等;
- 保存 A1-A8 证据。

只有这些都完成后,才可另开清账动作归档 r2/r3 后缀物证与 staging/retired 目录。归档不是本窗口脚本的一部分,不得在成功判定前执行。
