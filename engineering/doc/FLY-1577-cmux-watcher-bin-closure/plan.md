# FLY-1577 cmux watcher 的 bin 硬依赖闭包 — 实施计划

Issue: FLY-1577 (https://linear.app/geoforge3d/issue/FLY-1577/运维修复-cmux-watcher-的硬依赖不在-bin-收敛清单里-补进-files)
日期: 2026-07-31
基于: research.md

> 修订 R5:Codex design review 四轮,**全部 21 项 100% 采纳、零驳回**。
> R1(6 项 / 4 HIGH,打的是架构)→ R2(5 项 / 3 HIGH)→ R3(5 项 / 2 HIGH,Codex 明确
> 「剩余阻塞不在总体架构」)→ R4(4 项 / 0 HIGH,只剩取证精度与文字)。收敛,非空转。

## 0. 一句话

把 cmux watcher 启动路径上的**整条硬依赖闭包**(刹车本身 + 报告刹车不在的告警链)
纳入 converge 管理,并用回归测试同时证明两件事:文件补得回来,**告警真的落到人能看见的地方**。

## 1. 改动清单

| # | 文件 | 改动 | 类型 |
|---|---|---|---|
| 1 | `scripts/converge-flywheel-bin.sh` | copy lane `FILES` 两个分支各加 `restart-storm-gate.py` + `lib/bounded-run.sh` | 生产代码 |
| 2 | `scripts/converge-flywheel-bin.sh` | symlink lane 为 `meta-alert.sh` 定义**严格终态**(见 §3) | 生产代码 |
| 3 | `scripts/converge-flywheel-bin.sh` | `mode_of()` 改 GNU `-c` 优先、BSD `-f` fallback(修 Linux 非幂等) | 生产代码 |
| 4 | `scripts/__tests__/converge-flywheel-bin.test.sh` | fixture 补 source **和** steady-state destination;新增 C9-C12 | 测试 |
| 5 | `scripts/__tests__/converge-fly1389.test.sh` | 两个假 repo 补 3 个 source;`seed_wrappers()` → `seed_steady_state()`,补 2 个 copy-lane destination **+ 一个健康的 `meta-alert.sh` 链接** | 测试 |
| 6 | `scripts/__tests__/packaged-seams.test.sh` | S7 预置 gate + bounded-run,保持「第二次运行零 repair/告警」断言 | 测试 |
| 7 | `scripts/__tests__/fly1577-cmux-bin-closure.test.sh` | **新文件**:strict-meta 正反例 + **真实告警投递证明** + 并发 | 测试 |
| 8 | `.github/workflows/ci.yml` | 挂 #7 | CI |
| 9 | `engineering/doc/FLY-1577-*/` | 三件套 + progress.md | 文档 |

**不碰**:`flywheel-cmux-autostart.sh` 的 fail-closed 逻辑、watcher 本体、
`script-sanity.sh`、任何 feature flag、日志轮转。

**显式不修**:`meta-alert.sh:37` 的 `stat -f %m`。这是一个**独立的 portability defect,
当前方向未证明**(Codex R2#4 更正了我 R2 稿里「必然 fail-open」的错误定性):GNU `stat`
把 `-f` 解释为 **filesystem status**,语法是 `stat [option]... [file]...`,所以 `%m` 是
**多出来的一个 file operand 而不是 format** —— 对一个存在的 marker 它可能既吐多行文件系统
信息**又**返回非零,于是 `|| echo 0` 让 `mtime` 变成「多行 + 0」,再进算术展开报错,
**可能直接打断 notifier**,而不只是取消 debounce。

本单**不修**:本事故的 cmux / launchd / osascript 消费面是 macOS,扩改 notifier 会给
这个 fix 增加不必要的风险面。→ **独立 follow-up issue**,需带一个「Linux 上 marker 已存在
时的第二次调用」测试。注意 A2/A3 只覆盖**首次**写 marker,**不经过**该 debounce 分支,
**不能**拿来当这条风险的证据。

## 2. 改动 1 — copy lane

```bash
FILES="flywheel-lead-wrapper.sh flywheel-bridge-wrapper.sh restart-services.sh restart-storm-gate.py lib/bounded-run.sh"
…
if [ -f "$REPO_ROOT/.flywheel-prebuilt" ]; then
  FILES="flywheel-lead-wrapper.sh flywheel-bridge-wrapper.sh restart-storm-gate.py lib/bounded-run.sh"
fi
```

**为什么这两个进 copy lane**:没有任何 installer 往 bin 装它们(research §3),
形态就是普通文件,且都在 fail-closed 启动路径上(一个是刹车、一个是告警传输层)。

**嵌套路径 `lib/bounded-run.sh` 在既有循环里成立**(零改动,Codex 已复核):
`src=$REPO_ROOT/scripts/lib/bounded-run.sh` / `dst=$BIN_DIR/lib/bounded-run.sh` /
`install_script_atomic` 内部 `mkdir -p "$(dirname "$dst")"` 自动建 `$BIN_DIR/lib` /
路径无空格,`for f in $FILES` 词分割安全。

**packaged 分支同样加**:两者都在 `PO_SCRIPT_FILES` 与 `package-onboard-files.allow` 里,
`packaged-seams.test.sh` S0 已断言可执行。

## 3. 改动 2 — `meta-alert.sh` 的严格终态(R2 重写)

### 3.1 为什么不能进 copy lane

已实测(research §3):符号链接落进 copy lane 会 (a) 因 lstat 语义**永不收敛 mode**、
(b) `chmod` **穿透链接改 repo 源本体**。`flywheel-cmux-install.sh` 正是把 `meta-alert.sh`
装成符号链接的,FLY-1446 刚把 cmux 条目从副本收敛回链接。**按 shape 分 lane 是硬约束。**

### 3.2 为什么不能只处理「真缺失」(Codex R1#1)

只补缺失的话,`$BIN_DIR/meta-alert.sh` 是**普通文件**时 `[ ! -L ] && [ ! -e ]` 为假,
随后既有 `[ -L "$link" ] || continue`(`:284`)直接跳过;既有健康检查(`:290-296`)
只判断链/temp-worktree,**不校验 target 等于预期源,也不校验可执行**。
Codex 隔离 probe 证实:一个 **mode 000 的普通 `meta-alert.sh`** 会被原样保留、converge 返回 0
—— notifier 仍然静音,而防漂移机器报告健康。**这正是本单要消灭的故障类别**,不能留。

### 3.3 严格终态定义

`meta-alert.sh` 在 `$BIN_DIR` 的**唯一健康形态** = 指向 canonical 源
(`$REPO_ROOT/scripts/meta-alert.sh`)的符号链接,且该源过
`symlink_source_ready`(FLY-954 sanity + shebang + 可执行位,缺 x 位自动 `chmod 0755`)。

| # | 现状 | 动作 | rc |
|---|---|---|---|
| T1 | 已是指向 canonical 源的链接、**源 ready** | 静默 no-op | 0 |
| T2 | **真缺失**(`! -L` 且 `! -e`) | 创建链接 + 一条告警 | 0 |
| T3 | 链接**断**(`-L` 且 target 不存在) | 重指 + 告警 | 0 |
| T4 | 链接指向 **temp/worktree** | 重指 + 告警 | 0 |
| T5 | 链接**指向别处**(存在但 ≠ canonical 源) | 重指 + 告警 | 0 |
| T6 | **普通文件** | FLY-1446 形态:先留 forensic archive,再原子换成链接 + 告警 | 0 |
| T7 | **目录或其它不支持形态** | **不动** + fail-loud 告警 | **1** |
| T8 | 任何 T2-T6 修复所需的**源不 ready** | 不动 + 告警 | **1** |
| **T9** | **已是 canonical 链接,但源后来不 ready**(insane / 无 shebang / 无法 chmod) | **不动** + 告警 | **1** |
| T10 | 已是 canonical 链接,源 **0644** | `symlink_source_ready` 内部自动 `chmod 0755` 后 no-op(**不重建链接**) | 0 |

**T9 是 Codex R2#1 抓出的缺口**:R2 稿只把 wrong-target 加进 `unhealthy`,而真实循环在
target 不 broken、不在 temp/worktree 时会在 `:296` 直接 `continue` —— 于是「链接是
canonical 的,但源烂了」会被判健康。**告警链的源烂掉等于告警链坏掉**,必须 rc=1。

最后一行是对既有行为的**收紧**:现有 broken-link + source-unavailable 分支(`:320-325`)
只告警**不置 rc=1**。对 `meta-alert.sh` 必须置 —— 无法修复的告警链等于系统失声,
而 converge 的 rc 正是 kickstart 前置门。**收紧只对 `meta-alert.sh` 生效**,既有四个名字
的 rc 语义逐字不变。

### 3.4 实现形态(R3 重写:控制流与 §3.3 终态表逐行对应)

`symlink_source_for()` 增加 `meta-alert.sh) echo "$REPO_ROOT/scripts/meta-alert.sh" ;;`,
循环名单加 `meta-alert.sh`。**只有一个**白名单谓词(R2 稿正文说「两个」是笔误):

```bash
# FLY-1577: 进入「严格终态」制度的名字 —— 缺失自愈、错指纠正、普通文件替换、
# 不可修复一律 rc=1。cmux-autostart 的告警链缺一环 = 整条断,而 watcher 起不来
# 这件事本身就只能靠这条链喊出去,所以它不能只是「best-effort 修一修」。
# 既有四个名字不在白名单里 → absent 不创建、rc 语义逐字不变(创建归 installer)。
symlink_strict_name() { case "$1" in meta-alert.sh) return 0 ;; *) return 1 ;; esac; }
```

循环体四个插点(相对 `converge-flywheel-bin.sh` 真实结构):

**Block A — strict 非链接形态**(FLY-1446 的 `case` 之后、`[ -L "$link" ] || continue` 之前)。
**不受 `FLYWHEEL_CONVERGE_CMUX_SYMLINK` 控制** —— 那个 flag 管的是 cmux 副本形态转换,
不是告警闭包:

```bash
if symlink_strict_name "$name" && [ ! -L "$link" ]; then
  if [ ! -e "$link" ]; then           # T2 真缺失
    strict_install_link "$name" "$src" "$link" created   # 源不 ready → 告警 + rc=1 (T8)
  elif [ -f "$link" ]; then           # T6 普通文件
    strict_archive_then_link "$name" "$src" "$link"      # 复用 FLY-1446 archive 形态:
                                                         # ln 硬链接优先 → mktemp cp -p 兜底 →
                                                         # archive 失败保留 canonical + rc=1
  else                                # T7 目录/其它不支持形态
    … 不动 + fail-loud 告警 "$name|strict-shape-unsupported" …; rc=1
  fi
  continue
fi
```

**Block B — strict wrong-target**(在既有 `unhealthy` 判定链末尾追加一条 `elif`):

```bash
elif symlink_strict_name "$name"; then                                   # T5
  if ! canon_expected="$(path_hygiene_canonicalize "$src")"; then
    # §3.5-2 身份无法证明时绝不发布 —— 直接 fail-closed,不写 unhealthy
    # (写 unhealthy 会落进普通 repair = 证明不了身份就照发)
    … 告警 "$name|strict-identity-unprovable" …; rc=1; continue
  elif [ "$canon_target" != "$canon_expected" ]; then
    unhealthy="wrong target (${canon_target} != ${canon_expected})"
  fi
fi
```

**Block C — strict canonical-but-source-unready**(替换 strict 名字走到
`[ -n "$unhealthy" ] || continue` 时的行为,即 §3.3 的 **T9/T10/T1**):

```bash
if [ -z "$unhealthy" ]; then
  if symlink_strict_name "$name"; then
    if symlink_source_ready "$src"; then continue; fi   # T1 / T10(0644 在内部 auto-chmod)
    … 链接不动 + 告警 "$name|strict-source-unready" …; rc=1; continue    # T9
  fi
  continue                                             # 既有四名字:语义逐字不变
fi
```

**Block D — strict 修复失败置 rc**(既有「源不 ready → 只告警不置 rc」的 `else` 分支,
对 strict 名字追加 `rc=1`,即 **T8**)。

其余不变量:
- `[ ! -L ] && [ ! -e ]` 才是「真缺失」;**断链** `-e` 假但 `-L` 真 → 不进 Block A,
  落既有断链修复路径(T3,语义不变)
- 整段仍在 `if ! is_temp_or_worktree_root "$REPO_ROOT"` 内 ⇒ 只有可信主 checkout
  才会创建/替换,worktree/temp 永不写(FLY-1389 合同不动)
- **既有四个名字**不进 Block A/B,Block C/D 对它们短路 ⇒ **零行为变化**(既有 1389 套件守卫)

### 3.5 统一失败不变量(Codex R3#3)

§3.3 说的是「入口形态 → 动作」,这里补的是「**动作失败时**」的合同 —— 三条,对所有
strict 修复路径一致:

1. **发布失败**(源 ready,但 `ln -s` / `mv -f` 失败):删除**本进程精确的**
   `tmp="${link}.tmp.$$"`、canonical path **保持原状**(absent 就仍 absent)、
   **绝不报成功**、告警 + `rc=1`。
   **绝不用 glob 删 `.tmp.*`**(R4#2)—— 那会删掉**另一个并发 converger** 的 tmp。
   测试要断言「无残留」时,在**两个进程都结束之后**再断言。
2. **身份无法证明时绝不发布**:Block B 里 expected source 的 `path_hygiene_canonicalize`
   失败,**不能**写成 `unhealthy` 再落进普通 repair 路径(那等于「证明不了身份就照发」)——
   必须**直接** 告警 + `rc=1` + `continue`
3. **archive 失败**(T6 路径):保留 canonical 副本不动 + 告警 + `rc=1`

**关于第 3 条的守卫(R4#2 更正)**:我 R3 稿写的「由既有 C2 守卫」**不成立** ——
既有 C2(`converge-fly1389.test.sh:263-283`)只对 `flywheel-cmux-autostart` 的普通文件
制造 archive failure,走的是 FLY-1446 的 **inline** block;strict 的 T6 是 Block A 的**新路径**,
只「照同样形态抄一遍」的话 strict 写错了 C2 照样绿。
Codex 给了两个选项,**本计划取 (b)** —— 不做共享 helper 的重构(fleet blast radius 更小,
既有 FLY-1446 的 alert signature/text 行为一个字不动),而是**新增 strict 专属用例 M13**。

对应用例:**M12**(源 ready + bin 不可写 → link 仍 absent、无残留、告警、`rc=1`)、
**M13**(mode 000 普通文件 meta + bin 不可写 → **原字节/路径不动**、**无 tmp / 无新链接**、
`strict archive failed` 告警、`rc=1`)。

### 3.6 为什么本单不补 `lead-alert.sh` / `lib/flywheel-alert-lib.sh`

补了会把 watcher 的 cmux cleanup 告警从**当前禁用**变成真发,量未知;
FLY-218 / FLY-220 两次刷屏史。Tadashi 已批准分档,Codex 也认为合理。→ **follow-up issue**。

## 4. 改动 3 — `mode_of()` 平台顺序(Codex R1#5)

现状 `converge-flywheel-bin.sh:78` 是 BSD 优先:

```bash
mode_of() { stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1" 2>/dev/null; }
```

GNU `stat` 的 `-f` 是 **file system status**(完全不同的功能),在 Linux 上**成功**并吐出
多行文件系统信息 ⇒ `||` fallback **永不触发** ⇒ Linux 上 555 的文件每次都被判 mode drift、
反复 chmod + 刷 `mode tightened:` 日志。仓内两处已就此留下明确注释,其一注明
**「caught live: CI on ubuntu-latest — every 600/700 comparison broke」**:

- `scripts/lib/discord-bot-pool-lib.sh:58-67`(`_pool_file_mode`)
- `scripts/flywheel-setup.sh:49-53`(`_fs_perm`)

改成与两处先例同序:

```bash
mode_of() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
```

BSD `stat` 无 `-c`,干净失败(非零 + 只有 stderr)⇒ macOS 行为不变。
测试自己的 mode helper **必须同序**,不能写未指定平台的「用 stat」。

## 5. 改动 4/5/6 — 既有测试同步(Codex R1#2)

这三处不是可选项:`FILES` 一扩,不改就**直接打红 CI**。

**`converge-flywheel-bin.test.sh`**
- fixture(`:26-28`)补 `restart-storm-gate.py`(**真 Python 形态**:`#!/usr/bin/env python3`
  + 真 import/def 行 + 撑过 1024 B ⇒「sanity 对 .py 成立」是被**跑**出来的)与
  `lib/bounded-run.sh`
- C1(`:47-49`)只 seed 旧三个 destination,新 FILES 会让它同时修 gate 与 bounded-run、
  多出两条告警 ⇒ **非本单目标的用例必须预置这两个 destination**,保持「恰一条告警」成立
- 新增用例:

| 用例 | 断言 |
|---|---|
| C9 | `rm bin/restart-storm-gate.py` → 补回、内容 == repo 源、**mode 字面 555**、**恰一条** `bin_integrity_drift`、stdout 出现 `repaired:`(**不报 clean**) |
| C10 | 同上针对 `lib/bounded-run.sh`,额外断言 `bin/lib/` 被自动创建 |
| C11 | gate 置 **700**(= 生产手工补的形态)→ 变 **555**、**无告警**(沿用 C5 mode-only 语义) |
| C12 | C11 之后**再跑一次** → stdout **无** `mode tightened:`(mode 幂等,守 §4) |

mode 断言取**字面值**(不用 `[ ! -w ]` —— 700 与 555 都能满足某些 `-w` 判定,只有字面比对能证 700→555)。

**`converge-fly1389.test.sh`**:`make_fake_repo()`(`:26-44`)两个假 repo 都缺三个新 source,
`seed_wrappers()`(`:58-63`)只 seed 旧 copy lane ⇒ 几乎每个 trusted case 都会
source-missing / 多出 repair。补:

- 两个假 repo 各造 `restart-storm-gate.py`、`lib/bounded-run.sh`、`meta-alert.sh`
- `seed_wrappers()` → 更名/扩成 `seed_steady_state()`,除两个新 copy-lane destination 外,
  **还要建一个健康的 `bin/meta-alert.sh -> "$repo/scripts/meta-alert.sh"` 链接**

**最后一条是 Codex R2#2 抓出的**:strict 制度会在每个 trusted fixture 里发现
`bin/meta-alert.sh` absent → 创建 → 告警,而 **S3(`:139-147`)明确要求 alerts log 为空**、
**C5(`:326-335`)要求 feature-flag bypass 时 alerts log 为空**、S1 注释也声称只有一条目标
repair 告警。所有**非 FLY-1577-target** 的用例都必须用 `seed_steady_state()`;
只有新套件里**故意**制造缺失的用例(M1 / M10)才省略它。

copy suite 在 temp root、packaged S7 的 symlink lane 也因 temp root 自停 ⇒ 这两处按上面
所列即可,**无需**因此改 `check-global-path-hygiene` 套件。

**`packaged-seams.test.sh`**:S7(`:247-261`)只 seed 两个 wrapper 却要求 packaged
steady state **零告警** ⇒ 预置 gate + bounded-run destination,并继续断言第二次运行
无 repair / 无告警。

## 6. 改动 7 — 告警投递证明(Tadashi 硬要求 + Codex R1#3 重写)

新文件 `scripts/__tests__/fly1577-cmux-bin-closure.test.sh`。

> 光补文件不够,要证明「喊」这个动作真的能到人眼前。

### 6.1 为什么不能只断言「recorder 被调用了」

`meta-alert.sh:44-53` 对 marker 写入和 `osascript` **都挂 `|| true`,最终恒 exit 0**。
拿一个 recorder stub 当 `meta-alert.sh`,即使真实可见通道零产物,测试照样绿 ——
**空过绿测**。所以正例必须用**真实的** `meta-alert.sh` 和**真实的** `bounded-run.sh`,
断言**真实 marker 文件**存在且内容逐字正确。

### 6.2 驱动方式 = 生产形态

fixture bin 里放 `flywheel-cmux-autostart -> $FR/scripts/flywheel-cmux-autostart.sh` 的
**符号链接**并调用该链接 ⇒ SELF_DIR 落在 fixture bin(research §1 已实测)。
`env -i` + fixture HOME(照 `test-cmux-autostart-flags.test.sh` 配方)+
`FLYWHEEL_CMUX_AUTOSTART_EXEC=1` 进 supervised 分支;刹车缺失 ⇒ 必走 127 分支,
**永远走不到** `exec "$SYNC_SCRIPT"`。fixture `FLYWHEEL_STATE_DIR` + PATH 上放
**stub `osascript`**(记录 argv),桌面通道不打扰真人。

### 6.3 新套件自己的 baseline(Codex R3#2 —— 不预置就被无关 repair 污染)

新套件在**可信**假 repo 上跑的是**完整** converger,所以 copy loop 会先处理 monorepo 的
**五个** `FILES`。若某个 case 的 state 只表达「bin 无 meta」,converge 会为缺失的 copy
先产出**最多五条** repair 告警,再为 meta 创建产出一条 —— M1 的「恰一条告警」、
M2 的 strict 幂等、M3-M9 的隔离、R1 的「纯 meta race」**全部被污染**。
且 `converge-fly1389.test.sh` 里的 `seed_steady_state()` **不会自动被新脚本复用**。

所以新套件必须有**自己的** baseline helper:

- 假 repo 造齐**五个** copy source + `meta-alert.sh` / `flywheel-cmux-autostart.sh` /
  `flywheel-cmux-sync.sh` source + 两个 lib
- **除 A3**(它专门验证全量 converge)外,**M1-M13 与 R1 全部**从**五项 copy steady state**
  开始(内容 == source、mode 555),再按 case 只改变 `meta-alert.sh` 这一个变量。
  **M10(worktree)、M11(既有四名字)、M12/M13(publish/archive 失败)一个都不能漏**
- 每个 case **清空 alert log**。断言方式(**R4#1** —— 只数目标 signature 会放过 copy 噪声):
  - **expected-one** 的 case:同时断言 **(a)** 目标 signature **恰一条** **且**
    **(b)** alert log **总条数也恰一条**(等价于「不存在非目标 signature」)
  - **expected-zero** 的 case:断言**整个 log 为空**
  - **R1**(并发)不限制告警次数(去重属 `lead-alert.sh` claims 的另一层合同)
- **M12 与 M13 都把 bin 设成不可写** ⇒ **共用同一个 `trap` 恢复 bin 目录写位**,
  保证 hermetic、不产生执行顺序依赖(R5#2)
- **会改坏 canonical source 的 case 必须逐例复位**(R5#3):M7a/M7b 会把 repo 里的
  `meta-alert.sh` 改成 insane / 无 shebang,而 M8/M9 又要求它分别是 sane 的 0644 源。
  做法:**每个 M case 用独立假 repo**,或在 case setup 里**先把所有 canonical source
  复位到已知 sane baseline**,再只施加本 case 的 source/link 变体并**断言 precondition** ——
  否则测试会依赖执行顺序,误红或测到错误的 gate

### 6.4 隔离契约(Codex R2#3 + R3#1 —— 不写死就还能空过)

A1/A2/A3 用**同一个 reason**,因而**同一个 marker 路径**。若共享观测面:
A2 留下的 marker 直接满足 A3 的内容断言;`meta-alert.sh` 的 **debounce**(默认 10 分钟)
还会让 A3 根本不再调 `osascript`,而 A2 遗留的那一条记录照样满足「恰一次」。
A3 的 converge 阶段本身也会写 alert/log。所以:

1. **每个 A case 用独立的 HOME / `FLYWHEEL_STATE_DIR` / osascript log / sync sentinel**
2. 每次调用**之前**显式断言:marker **不存在**、osascript log **为空**、sync sentinel **不存在**
3. A3 在「converge 终态断言」之后**清空观测面**,再只删 fixture bin 里的 gate,然后断言
   marker **从 absent 变 present**、osascript **本次恰一条**
4. `flywheel-cmux-sync` 放一个**可执行且会写 sentinel 的正控制 stub** —— 否则「未执行」
   可能只是因为目标压根不存在(**阳性对照证明尺子没坏**)
5. A2/A3 都**显式断言 wrapper 的 rc**,不只断言 marker
6. **【R3#1】sync recorder 的安装时机是硬合同**:`flywheel-cmux-autostart.sh:12,104`
   固定执行 `$HOME/.flywheel/bin/flywheel-cmux-sync`,而 converger 对该路径的**普通文件**
   会在 `:213-280` 先 archive 再换成指向假 repo source 的链接 —— **尺子会被 converge 自己拿走**。
   之后即使 bug 让 autostart 真去跑 sync,假 repo 的 sync source 也可能正常 exit 0 而不写
   sentinel,于是 marker/rc/sentinel 组合**仍然假绿**。二选一,写死其一:
   **(i)** A3 在 converge 完成 + 终态断言 + 清空观测面**之后**再安装 recorder;或
   **(ii)** 让假 repo 的 canonical `scripts/flywheel-cmux-sync.sh` **本身就是 recorder**,
   并断言 bin link **精确指向它**。本计划取 **(ii)** —— 它对 A1/A2/A3 三例统一,不依赖时序。
7. **A1 的 bin 形态随之修正**:不是「只有 autostart 链接」,而是
   **「autostart 链接 + sync recorder,缺 gate / bounded / meta」** —— 否则 A1 的
   「sync 未执行」也没有真尺子。

### 6.5 用例

| 用例 | 场景 | 断言 |
|---|---|---|
| **A1**(阴性对照 = 事故形态) | bin 有 autostart 链接 **+ sync recorder**,缺 gate / bounded / meta | marker **不存在**、osascript log **为空**、sync sentinel **不存在**、rc=0、stderr 含 `restart brake missing` |
| **A2**(阳性,手摆闭包) | bin 另有**真** `lib/bounded-run.sh` + **真** `meta-alert.sh` | 调用前三项观测面全空;调用后 `$STATE/meta-alert/restart_storm_gate_unavailable_cmux-watcher.txt` **存在**且逐字含 `reason=restart_storm_gate_unavailable_cmux-watcher` / 标题 `Restart brake unavailable` / body 含 `exit 127`;osascript log **恰一条**,argv 含 `Flywheel: Restart brake unavailable`;**同步完成**(wrapper 返回时 marker 已在);sync sentinel **不存在**;**rc=0** |
| **A3**(阳性,闭包由 converge 自己产出) | 可信假 repo 上跑 converge → **逐项钉死终态**:gate/bounded 内容 == repo 且 **mode 555**,meta 是 **exact canonical link** 且源 ready → **清空观测面** → 只删 fixture bin 的 gate → 经 bin 链接调 autostart | 同 A2 全部断言 —— 证明**收敛结果本身**就足以让告警响,不是测试手摆出来的 |
| **M1** | bin 无 `meta-alert.sh` → converge | 链接被创建、指向 canonical 源、**一条**告警(T2) |
| **M2** | 再跑一次 | 静默 no-op、**零**告警(幂等,T1) |
| **M3** | `meta-alert.sh` 是 **mode 000 普通文件**(Codex R1 的原始反例) | 换成链接 + 告警;archive 逐字节等于原文件(**测量法见 §6.6**)(T6) |
| **M4** | `meta-alert.sh` 是**目录** | 不动 + fail-loud 告警 + **rc=1**(T7) |
| **M5** | 链接**指向别处**(存在但非 canonical 源) | 重指 canonical + 告警(T5) |
| **M6** | 断链 **且** 源不可用 | 不动 + 告警 + **rc=1**(T8) |
| **M7a** | **已是 canonical 链接** + 源 **insane**(< 1024 B / 只有注释) | 链接**不动**(inode 不变)+ 告警 + **rc=1**(**T9**) |
| **M7b** | **已是 canonical 链接** + 源**无 shebang**但**过 sanity**(> 1024 B 且有实质行) | 同上 —— 拆开才能确保真的测到 **shebang gate** 而不是先被 sanity gate 拦掉(R3#4) |
| **M8** | **已是 canonical 链接** + 源 **0644** | auto-chmod 0755 后 **rc=0**、**零告警**、**链接 inode 不变**(T10) |
| **M9** | 新建链接时源为 **0644** | 自动 `chmod 0755` 后建链(T2 + `symlink_source_ready`) |
| **M12** | 源 ready 但 **bin 不可写 / publish 失败** | link 保持 **absent**、**无 tmp 残留**、failure 告警、**rc=1**(§3.5-1) |
| **M13** | **mode 000 普通文件 meta + bin 不可写**(strict archive 失败) | 原**字节/路径不动**、**无 tmp / 无新链接**、`strict archive failed` 告警、**rc=1**(§3.5-3;既有 C2 **不**覆盖这条路径)。字节比对**沿用 M3 的 mode-000 测量法**(§6.6),不直接 `cmp` |
| **M10** | **worktree 形态**假 repo,bin 无 `meta-alert.sh` → converge | **不创建**(FLY-1389 合同不破) |
| **M11** | 既有四个名字在同样场景下 | 行为**逐字不变**(absent 不创建、rc 不变) |
| **R1** | 两个 converger **并发**看到 absent | 二者均 rc=0、canonical path 精确指向 trusted 源、**无 `.tmp.*` 残留**;**不**断言 sink 调用数为 1(用户可见去重属 `lead-alert.sh` claims 的另一层合同) |

**A1 的定位(Codex R1#3 更正)**:A1 是**修复前后都应该绿**的阴性对照 —— 它证明
「尺子在事故形态下确实读数为零」,不是 red→green 信号。真正的 red→green 是
**C9 / M1 / M3 / M4 / M6 / M7a / M7b / A3**。没有 A1,A2/A3 变绿也可能只是证明「某个东西被调用了」。

M1/M10 需要可信 / worktree 两种假 repo ⇒ 沿用 `converge-fly1389.test.sh` 的配方
(可信假 repo 建在 `scripts/__tests__/.tmp-*` + `.git` **目录**;worktree 版 `.git` 写成文件)。

### 6.6 测量法(Codex R3#4 —— 断言方式本身不能空过)

- **M3 的 archive 比对**:输入是 **mode 000** 的普通文件,普通用户直接 `cmp` archive 会因
  不可读返回 **2**(Codex 本机 probe 已复现)—— 「照 FLY-1446 C1 直接 cmp」**不可执行**。
  改法:fixture **另存一份 readable expected bytes**;先断言 archive 的 shape/mode,
  再**只在 fixture 内**给 archive 恢复读位,然后 `cmp`。
- **M7a/M7b 的「链接不动」与 M8 的「不重建链接」**:**不能只比 `readlink` 文本** ——
  「删掉再建成相同 target」也会通过。必须记录**符号链接自身的 lstat inode**
  (`stat -c %i` first、`stat -f %i` fallback —— 与 §4 的 `mode_of` **同序**)并比对前后相等。
- 所有 mode / inode helper **一律 GNU 优先、BSD fallback**,不写未指定平台的「用 stat」。
  (Codex 已实测:macOS `stat -f %i` 取到**符号链接自身**的 inode、加 `-L` 才是 target 的;
  GNU `stat` 默认同样**不解引用**符号链接 ⇒ 两平台语义一致。)

**防空过的 precondition(R4#3)**:
- inode helper 取值后**先断言非空且匹配 `^[0-9]+$`** 再比较 —— 否则两次工具失败得到
  `"" == ""` 照样绿
- canonical sync recorder 必须**带 shebang + 可执行位**,并做成 **> 1024 B + 有实质行**的
  sane source(否则它自己过不了 `symlink_source_ready`,用例会因为错误的原因红/绿)
- 每个 A case **显式传入自己的 `SYNC_SENTINEL`**;调用前断言 bin 里的 sync 是
  **exact symlink** 且 target **`-x`**

## 7. 改动 8 — CI

`.github/workflows/ci.yml` 在既有 converge 组(第 299-300 行)追加:

```yaml
          bash scripts/__tests__/fly1577-cmux-bin-closure.test.sh
```

## 8. 验收对照

| issue 验收项 | 怎么满足 |
|---|---|
| 1. 删 `restart-storm-gate.py` → converge 补回、`ls -l` 显示 555 | **C9(fixture 内,自动)** —— 生产不做破坏性验证,见 §10 |
| 2. 同场景不再报 clean,明确报 drifted/repaired | C9 断言 stdout `repaired:` + 恰一条 `bin_integrity_drift` |
| 3. 补回后 watcher 能正常启动 | §10 非破坏性真机验证 |
| 4. 回归测试进 CI,可重复跑 | 改动 4-8;M2/C12 专测幂等 |
| 5. 扫描结果写进 PR 描述 | research §6 全表搬进 PR |
| Tadashi 追加:证明告警真投递 | A1/A2/A3(真 marker,非 recorder) |

## 9. 风险

| 风险 | 处置 |
|---|---|
| 生产 `restart-storm-gate.py` 现为 **700**,落地后首次 converge 收敛成 **555** | **预期行为**。C11 覆盖。已在 brainstorm gate 向 Tadashi 明示 |
| 首次 converge 为三个新条目各发一条 `bin_integrity_drift` | 预期(drift 本就该被看见);`lead-alert.sh` claims.db 去重防重复 |
| strict 制度误伤既有四个链接 | 白名单 `symlink_strict_name` 只对 `meta-alert.sh` 返 0;**M11**(既有四名字行为逐字不变)+ **M10**(worktree 不创建)+ 既有 `converge-fly1389` 21 例守卫 |
| strict 的 rc=1 收紧让 kickstart 更容易被挡 | **这正是意图**(告警链坏掉时不该盲目 kickstart)。触发面是五种**真异常**:源不可用(T8)、不支持形态(T7)、canonical 链接但源烂掉(T9)、身份无法证明(§3.5-2)、publish/archive 失败(§3.5-1/3)。M4/M6/M7a/M7b/M12/M13 逐条固定合同 |
| copy lane 与 installer 抢 shape | 新加两个文件**没有** installer 碰(research §3),无竞争 |
| fixture 与 FILES 脱节导致空过绿测 | fixture 扩项是**必需**的(不扩既有用例就红),结构上强制同步 |
| `mode_of` 换序影响 macOS | BSD 无 `-c`,干净失败 → 行为不变;C11/C12 双平台断言 |

## 10. 真机验证(**非破坏性**,Codex R1#4 重写)

**绝不删除生产刹车文件。** 那等于主动重建本次事故根因,而 cmux 是 founder 观察 Runner
的唯一界面;shell 中断、converge 自身 bug/源 sanity 失败、或 watcher 在窗口内退出被
KeepAlive 重拉,都能把「立即复原」变成长期缺失。**缺失修复一律在 fixture 里验(C9/C10/M1/M3)。**

生产只做:

1. **取基线**:`ls -l ~/.flywheel/bin/{restart-storm-gate.py,meta-alert.sh}`、
   `ls ~/.flywheel/bin/lib/`、记录 `/tmp/flywheel-cmux-watcher.log` 的**当前字节 offset**
2. 从**主 checkout**(不是本 worktree —— FLY-1389 写时守卫会拒绝)跑一次
   `scripts/converge-flywheel-bin.sh`
3. **核终态**:gate = 555 普通文件;`lib/bounded-run.sh` = 555 普通文件;
   `meta-alert.sh` = 指向主 checkout `scripts/meta-alert.sh` 的链接
4. **启动证据**(防历史日志假阳性):从第 1 步记录的 offset **之后**读日志,要求出现
   **新的** `Creating workspace for:`;`launchctl print gui/$(id -u)/com.flywheel.cmux-watcher`
   断言 `state = running` **且 pid 非空**
5. 观察 KeepAlive 自然重启或显式安全重启,不做任何删除

## 11. 顺序(R3 重排:先测试后实现,red→green 才兑现得了)

R2 稿先改生产代码再加新用例 —— 那样新用例第一次出现时实现已经在了,**红从来不会出现**
(Codex R2#5)。正确顺序:

1. **改动 4/5/6/7(全部测试,fixture-only)** —— 此时生产代码**未动**。
   跑一遍并**记录预期的红**:C9 / M1 / M3 / M4 / M6 / M7a / M7b / M12 / M13 / A3 应当红;
   **A1 应当绿**(阴性对照:事故形态下确实零投递)。这一步的红就是 bug 存在的证据。
2. **改动 1/2/3(生产代码)** —— 上述用例转绿,A1 保持绿。
3. 改动 8(CI 挂新套件)。
4. 全仓 `pnpm lint`;跑 5 个相关 shell 套件(copy / 1389 / packaged-seams /
   cmux-autostart-flags / 新套件)。
5. §10 **非破坏性**真机验证。
6. codex code review → PR。
