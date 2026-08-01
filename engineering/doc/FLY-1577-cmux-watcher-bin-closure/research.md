# FLY-1577 cmux watcher 的 bin 硬依赖闭包 — 调研

Issue: FLY-1577 (https://linear.app/geoforge3d/issue/FLY-1577/运维修复-cmux-watcher-的硬依赖不在-bin-收敛清单里-补进-files)
日期: 2026-07-31
基于: exploration.md

## 1. SELF_DIR 到底解析到哪(实测)

launchd plist(`~/Library/LaunchAgents/com.flywheel.cmux-watcher.plist`)实测内容:

```xml
<string>/bin/bash</string>
<string>/Users/xiaorongli/.flywheel/bin/flywheel-cmux-autostart</string>
```

而 `~/.flywheel/bin/flywheel-cmux-autostart` 是指向 repo 的**符号链接**。
`flywheel-cmux-autostart.sh:11` 是:

```bash
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
```

`dirname` 拿的是**调用路径**,`cd`+`pwd` 只规范化目录、不解析文件符号链接。

**实测**(沙箱里造 `bin/thing -> repo/scripts/thing.sh` 再经链接调用):

```
A) invoked through the bin symlink:
  SELF_DIR=/…/shape/bin
   (repo source lives in /…/shape/repo/scripts)
```

⇒ **SELF_DIR = `~/.flywheel/bin`,不是 repo。** 所以 autostart 要的三个文件全部
必须在 bin 里存在:

| 行 | 依赖 | 生产 bin 里在吗 |
|---|---|---|
| `:77` | `$SELF_DIR/restart-storm-gate.py` | ❌ 事故当天不存在(现为 Lead 手工补,mode **700**) |
| `:91` | `$SELF_DIR/lib/bounded-run.sh` | ❌ 不存在(连 `lib/` 目录都没有) |
| `:93` | `$SELF_DIR/meta-alert.sh` | ❌ 不存在 |

对照:`flywheel-lead-wrapper.sh:149` / `flywheel-bridge-wrapper.sh:169` /
`flywheel-voice-bridge-wrapper.sh:89` / `flywheel-quota-monitor-wrapper.sh:75`
用的都是 `${FLYWHEEL_DIR}/scripts/restart-storm-gate.py`(FLYWHEEL_DIR 默认
`~/Dev/flywheel`,即 **repo**)。**只有 cmux-autostart 走 `$SELF_DIR`** —— 这就是
为什么只有它挂了,Lead/Bridge 都没事。

env 覆盖不成立:plist 只设 `FLYWHEEL_CMUX_SUPERVISED=1`,且 autostart 明确**不整个
source `.env`**(只提取声明过的 cmux bool flag),所以
`FLYWHEEL_RESTART_STORM_GATE_BIN` / `FLYWHEEL_META_ALERT_BIN` 在 launchd 下都是未设,
一律走 `$SELF_DIR` 默认值。

## 2. 告警链静音 —— 实测复刻

按 `flywheel-cmux-autostart.sh:91-97` 逐字复刻该分支,bin 目录留空(= 生产形态):

```
fixture bin entries: 0  (production shape: no lib/, no meta-alert.sh)
--- exact production branch (masked) ---
branch completed, rc=0  (nothing printed, nothing delivered)
--- same call unmasked, to show what the shell would have said ---
…/probe-bin/lib/bounded-run.sh: No such file or directory
raw rc=127
```

**结论:零投递、零输出、退出 0。** 缺 `lib/bounded-run.sh` 一环就足以让整条报告链断掉;
即使补了它,再缺 `meta-alert.sh` 一样断。**报告链必须整条闭包。**

## 3. converge 的两条 lane,以及为什么不能混

`converge-flywheel-bin.sh` 有两套机制:

- **copy lane**(`FILES` 循环):`src=$REPO_ROOT/scripts/$f` → `dst=$BIN_DIR/$f`,
  checksum 比对 + `install_script_atomic`(tmp + 原子 mv + **chmod 555**)
- **symlink lane**(FLY-1389/FLY-1446):4 个名字的链接健康度 —— 断链/指向 temp
  worktree 就原子重指;注释明确写「**Absent links are not installed here**
  (sync-bin / installers own creation)」

**关键实测:符号链接落进 copy lane 会出事。**

```
B) converge mode_of()/chmod behaviour on a symlink dst:
   src sha == dst sha ? YES
   mode_of(symlink dst) = 700
   repo source mode BEFORE chmod = 755
   repo source mode AFTER  chmod 555 <symlink> = 555
   link's own mode after = lrwx------
```

两个后果:
1. `mode_of` 用的是 `stat -f '%Lp'`(lstat 语义)→ 读到**链接自身**的 mode,永远不是
   555 → 每次 converge 都判定「mode 未收敛」,**永不收敛**
2. `chmod 555 "$dst"` 在 macOS 上**穿透符号链接**,把 **repo 源文件本体**改成 555

而 `flywheel-cmux-install.sh:42-46` 正是把这些装成符号链接的:

```bash
ln -sf "$REPO_DIR/scripts/flywheel-cmux-sync.sh"     "$INSTALL_DIR/flywheel-cmux-sync"
ln -sf "$REPO_DIR/scripts/flywheel-cmux-autostart.sh" "$INSTALL_DIR/flywheel-cmux-autostart"
ln -sf "$REPO_DIR/scripts/lib/flywheel-alert-lib.sh"  "$INSTALL_DIR/flywheel-alert-lib.sh"
ln -sf "$REPO_DIR/scripts/lead-alert.sh"              "$INSTALL_DIR/lead-alert.sh"
ln -sf "$REPO_DIR/scripts/meta-alert.sh"              "$INSTALL_DIR/meta-alert.sh"
```

⇒ **按 shape 分 lane 是硬约束,不是风格选择。** 且 FLY-1446 刚刚才把 cmux 条目从
「部署副本」收敛回「符号链接」,把它们塞回 copy lane 等于反向撞合同。

**注意 installer 的另一个洞**:它压根**没装** `restart-storm-gate.py` 和
`lib/bounded-run.sh` —— 这两个没有任何 installer 负责,只能靠 converge。

## 4. sanity 检查对 Python 成立吗

`scripts/lib/script-sanity.sh` 的 `assert_sane_script_source` 是**语言无关**的:

1. 文件存在
2. `size >= 1024`(`FLYWHEEL_SCRIPT_MIN_BYTES`)
3. `grep -qE '^[[:space:]]*[^#[:space:]]'` —— 至少一行非空非注释

对 `restart-storm-gate.py`:25822 B ✓;`import argparse` 等行首非 `#` 非空白 ✓。
(Python 注释同样是 `#`,规则天然通用。)`install_script_atomic` 的 `chmod 555` 对
`.py` 也正确 —— `python3` 读它需要 r,launchd/wrapper 直接执行需要 x,555 都给了。

**⇒ 无需修改 sanity 检查。**

## 5. packaged(`.flywheel-prebuilt`)分支怎么办

converge 对 packaged 树会缩短 FILES(packaged 不 ship `restart-services.sh`)。
但 packaged 树**确实 ship** 本单要加的文件 —— `scripts/package-onboard.sh`
`PO_SCRIPT_FILES` 白名单里逐字包含 `restart-storm-gate.py`、`meta-alert.sh`、
`lead-alert.sh`、`lib/bounded-run.sh`;`scripts/__tests__/packaged-seams.test.sh`
S0 已经断言这四个在装配产物里可执行:

```bash
for f in restart-storm-gate.py lib/bounded-run.sh meta-alert.sh lead-alert.sh; do
  [ -x "$PACKAGED_ASSEMBLY/scripts/$f" ] || closure_ok=0
done
```

⇒ **两个分支都要加**,不需要为 packaged 开特例。

## 6. 全量扫描结果:bin 里被绝对路径引用的可执行文件

| 文件 | 谁引用 | 失效后果 | 生产在吗 | 处置 |
|---|---|---|---|---|
| `restart-storm-gate.py` | cmux-autostart `$SELF_DIR` | **拒绝启动 watcher** | 手工补(700) | ✅ **进 copy lane** |
| `lib/bounded-run.sh` | cmux-autostart `$SELF_DIR`(告警传输) | 告警**静音** | ❌ | ✅ **进 copy lane** |
| `meta-alert.sh` | cmux-autostart `$SELF_DIR`(告警投递) | 告警**静音** | ❌ | ✅ **进 symlink lane** |
| `lead-alert.sh` | cmux-sync `$_CMUX_SYNC_SCRIPT_DIR` | watcher 告警降级 | ❌ | ⏸ 见下 |
| `lib/flywheel-alert-lib.sh` | cmux-sync(同上) | watcher 告警降级 | ❌ | ⏸ 见下 |
| `lib/host-config.sh` | lead/bridge wrapper `$SELF_DIR` | 有 `[ -f ]` 守卫 + fallback,非硬依赖 | ❌ | ❌ 不进(软依赖) |
| `agent-team-transport` / `tmux-server-rescue` / `flywheel-cmux-sync` / `flywheel-cmux-autostart` | 多处 | — | ✅ 符号链接 | 已在 symlink lane |
| `flywheel-restart-guard.py` / `discord-reply-enforcer.py` / `post-compact-bootstrap.sh` | Claude Code hooks | hook 降级 | ✅ | ❌ 不进:源不在 `scripts/`(在 `scripts/hooks/`、`packages/teamlead/scripts/`),converge 的 `$REPO_ROOT/scripts/$f` 寻址够不着;各有自己的 installer(`scripts/hooks/install-*.sh`) |
| `update-discord-plugin.sh` / `check-discord-plugin.sh` / `skills-sync.sh` / `sync-gbrain-docs.sh` | restart-services / daily-standup | 全部 `[[ -x ]]` 守卫,非致命 | ✅ | ❌ 不进:前三个**repo 里根本没有源文件**,converge 会当成「repo source missing」每次 fail-loud 告警,反成噪声 |

### `lead-alert.sh` + `lib/flywheel-alert-lib.sh` 为什么本单暂缓

`flywheel-cmux-sync.sh:124-132` 找不到 alert-lib 时会:

```
log "WARN: optional alert library unavailable; alerts disabled"
flywheel_alert() { return 0; }
```

即 watcher 的 cmux cleanup 告警**当前是禁用状态**。补上等于把一条从未开过的告警
通道直接打开,量未知。考虑 FLY-218 / FLY-220 两次刷屏史,先估量再开更稳妥。
Tadashi 已批准这个分档(本 PR 只补 `meta-alert.sh` —— 启动失败告警,低频、有 latch)。
→ **follow-up issue**。

## 7. 测试基建现状

| 文件 | 用途 | CI |
|---|---|---|
| `scripts/__tests__/converge-flywheel-bin.test.sh` | copy lane(C1-C8),假 repo 在 `mktemp`(= temp root,symlink lane 自动关闭) | ✅ ci.yml:299 |
| `scripts/__tests__/converge-fly1389.test.sh` | symlink lane,**可信**假 repo 建在 `scripts/__tests__/.tmp-*` 且带 `.git` **目录** | ✅ ci.yml:300 |
| `scripts/__tests__/test-cmux-autostart-flags.test.sh` | autostart flag 解析,`env -i` + fixture HOME | ✅ ci.yml:178 |
| `scripts/__tests__/packaged-seams.test.sh` | packaged 形态 sentinel | ✅ ci.yml:317 |

**实测确认**:本工作树 `.git` 是文件(worktree 形态),`is_temp_or_worktree_root`
判 true ⇒ 直接拿本 checkout 当 REPO_ROOT 跑 converge,symlink lane 会自动跳过。
所以 symlink lane 的新测试必须沿用 FLY-1389 的「可信假 repo」配方。

## 8. 已确认的既有断言约束

`converge-flywheel-bin.test.sh` 的假 repo 只造 3 个源文件。FILES 一旦加两个新名字,
所有既有用例都会撞 C8 那条「repo source missing → rc=1 + 告警」——
**fixture 必须同步扩**。这是好事:fixture 从此跟着 FILES 走。
