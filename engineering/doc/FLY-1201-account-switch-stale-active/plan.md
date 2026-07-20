# FLY-1201 账号切换 stale .active 覆盖 live 凭据 — 实施计划

Issue: FLY-1201 (https://linear.app/geoforge3d/issue/FLY-1201/bug-account-switch-引擎带外登录留下-stale-active-时切号会覆盖-live-凭据跳过-capture-back)
日期: 2026-07-19
基于: research.md(Codex design review R1 反馈已折入,见 §8)

## 0. 一句话方案

在 `flywheel-claude-profile` 的 `use`/`next` 入口(拿锁之后、切换之前)加一步 **current-account 对账**:先走零网络快路径(`~/.claude.json` display identity vs `.active` 槽 anchor,一致即通过);不一致或 display 不可读时,以 **live Keychain token 的 OAuth probe 身份为最终权威**归槽 —— token 属当前 `.active` 槽 → marker 正确(display stale),保鲜池快照 + best-effort 修 display 后照常切;token 唯一属其他槽 → `.active` 真 stale,**手动路径**先 capture live 凭据 + strict 台账 sync + 最后原子改 marker,再以修正后 active 走完整切换(freshness / capture_back / 身份断言全不跳);**delegated(引擎)路径检出真 drift 一律 mutation 前 fail-closed**;归不了槽 / 修不动 → fail-closed(新 exit 46/47;状态承诺分三档,见 §1.3:46 零 mutation;普通 47 Keychain+marker 不动;marker-commit-uncertain 47 仅保证 Keychain 不动)。

## 1. 行为契约(修后)

### 1.1 incident 基底(机器=shopping live,`.active`=business stale,business 池内快照 Jul-4 已死;手动路径)

| 命令 | 修前 | 修后 |
|---|---|---|
| `use business` | name==active 短路 → 跳 capture_back + freshness → 死快照覆盖 live shopping → strand | 对账(probe 归槽 shopping):capture live→shopping 槽 + store sync + `.active`→shopping;business 此时 ≠ active → freshness 跑 → exit 30(`FLYWHEEL_TARGET_STALE`),**Keychain 不动,live 保住,池子已修好** |
| `use shopping`(还原) | 走完整切换,但 capture_back 拿 business anchor 断言 shopping token → mismatch → 不 capture;freshness 验 shopping 池内 Jul-4 快照 → 拒 → **卡在切不回** | 对账后 shopping == active → 合法短路;池内快照刚 capture 成 live 字节 → 重写无害,exit 0 |
| `use school`(第三账号) | capture_back 静默丢失 live shopping(drift 标记后继续) | 对账后 active=shopping → capture_back 正确保存 shopping → 正常切 school |
| `next` | 同 `use` | 候选循环用修正后 active,同上 |

### 1.2 display-stale 态(合法 `use` 成功后 `sync_identity` best-effort 失败:`.active`/Keychain 对、display 旧 —— Codex R1#1)

| 命令 | 契约 |
|---|---|
| 任意 `use`/`next` | 快路径不一致 → probe:token 属当前 active 槽 → **marker 判定正确**,capture live 字节回 active 槽(strict)+ best-effort `sync_identity` 修 display(恢复 TS 三见证)→ 以原 active 照常切换。**绝不因 display stale 拒绝切换** —— display 只是 witness,token probe 才是权威 |

### 1.3 fail-closed 矩阵(Codex R2#4 + R5#1:状态承诺**三档**写死,无歧义)

| 档 | 承诺 |
|---|---|
| **46** | 零 repair mutation(Keychain / `.active` / 池凭据 / 台账全不动,失败发生在任何写之前) |
| **普通 47** | Keychain 与 `.active` 保证不动;池凭据/台账可留**可收敛前缀**(只会更接近真相;重跑 `use` 完成修复,§4) |
| **47 · marker_commit_uncertain**(唯一来源:marker rename 跨进程确认窗口判定失败,R4#2/R5)| **仅保证 Keychain 不动;`.active` 状态 unknown**,stderr 文案如实声明并按 destination readback 分类给恢复指引(R5#2 + R6#2:absent 或指向**池内可用、非 symlink、带有效唯一 anchor** 的槽 → 重跑 `use` 可收敛;**仅语法合法但解析不到可信槽**(ghost label / 缺 anchor / identity 不唯一)→ 重跑会 fail-closed 46,转人工;unsafe 形态 → 人工 marker 修复,重跑被层1门 46 拒);审计落**独立** summary `stale_active_marker_commit_uncertain`(R6#3,与普通 47 的 `stale_active_repair_failed` 可事后区分;exit code 与 TS error 类共用不扩) |

| 态 | 结果 |
|---|---|
| `.active` marker 存在但不安全/不可读(symlink / 非 regular / 读失败)—— R2#3 | 46 `FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE`(**不折叠成"缺失"直通**) |
| `.active` 内容非法 label(畸形/多行) | 46 |
| active 槽目录为 symlink / anchor 缺失或无效(legacy 未迁移)且快路径无法证实 | 46(文案指路 `anchor --migrate`) |
| 快路径不一致且 Keychain 不可读 / 凭据不可表示 / probe 网络失败 | 46 |
| probe 身份在有效 anchor 中匹配 0 或 ≥2 槽 | 46 |
| **delegated 模式检出真 marker drift(token 属其他槽)** | 46,零 mutation(marker/store 修复只归手动路径 —— Codex R1#4;delegated 的 display-stale 分支见 §2.3) |
| 修复中途失败(capture 未落地 / store sync 未确认 / marker 写失败) | 47 `FLYWHEEL_STALE_ACTIVE_REPAIR_FAILED`(逐态:capture 失败 → 池可能已有 live 字节,store/marker 未动;store 失败 → marker 未动;marker not_committed → store 已 sync、旧 marker 保留 → 重跑收敛;marker **uncertain** → 走上表第三档) |
| 健康态(快路径一致) | **零网络、零输出/行为变化**(只多几次本地文件读 —— 层1结构门 + 层2 strict 读 + anchor/display 比对;读次数不是合同,零可见变化才是 —— R5#1) |
| `.active` **真缺失** + `kc_read` **rc 44**(security not-found = 唯一可证的空白 bootstrap,R8#1) | 直通,现行为不变 |
| `.active` **真缺失** + `kc_read` rc 0 有 live 凭据(含 uncertain-absent 残局 —— R7#1) | 走 token-probe 权威流程重建:probe → 唯一 anchor 归槽 → manual = strict capture + store sync + 重建 marker 后照常切换;delegated = 46 零 mutation;归不了槽/probe 不可用 = 46。**绝不进「空 active 跳 capture_back」的切换路径** |
| `.active` **真缺失** + `kc_read` rc 0 但空/不可表示、或非 44 非零(锁定/权限/工具故障) | 46 全不动(不可判即 fail-closed,R8#1) |
| `FLYWHEEL_PROFILE_IDENTITY_BYPASS=1`(仅手动;delegated 已被拒) | 跳过对账(逃生舱现语义) |

## 2. bash 改动(`packages/claude-runner/bin/flywheel-claude-profile`)

### 2.1 新函数 `reconcile_stale_active_locked`(核心)

**在父 shell 直接执行,不用 `$(...)` 包裹**(Codex R1#2:command substitution 会丢 `AUDIT_SUMMARY`、`ACTIVE_SECRET_TEMP`、EXIT trap 语义);结果经全局 out-param `RECONCILED_ACTIVE` 返回。所有预期失败走显式映射(非退出 predicate),终点统一 `fail_stale_active`(父 shell 内 `fail_code` 同款路径:稳定 marker + `AUDIT_SUMMARY` + audit 落盘 + finalize 清理照常)。

```bash
RECONCILED_ACTIVE=""
reconcile_stale_active_locked() { # <marker-read-rc> <active>; sets RECONCILED_ACTIVE; exits 46/47 on failure
  local marker_rc="$1" active="$2" display anchor d_uuid d_email a_uuid a_email
  RECONCILED_ACTIVE="$active"
  # —— 结构安全门先于一切,bypass 不可绕(Codex R3#1):
  case "$marker_rc" in                                 # 来自 read_active_marker_strict(R2#3;label 字节级校验在 reader 内完成)
    0) : ;;                                            # marker 存在、安全、内容为精确合法 label
    10)                                                # 真缺失(R7#1:不再无条件直通)
      # 只有「可证空白 bootstrap」(Keychain 无 live 凭据)才直通 —— 此时确实无登录可保护。
      # 有 live 凭据的 absent-marker(含 uncertain-absent 残局)走与慢路径同一套 token-probe
      # 权威流程:probe → 唯一 anchor 归槽 → (delegated → 46 零 mutation / manual →
      # strict capture + store sync + 重建 marker) → RECONCILED_ACTIVE=归属槽,继续正常切换;
      # 归不了槽 / probe 不可用 → 46。绝不把「有 live 登录但无 marker」交给会跳过
      # capture_back 的空-active 切换路径。
      reconcile_absent_marker_locked; return $? ;;
    *) fail_stale_active 46 "unreadable" "active marker exists but is unsafe/unreadable/malformed" ;;
  esac
  [[ -L "$POOL_DIR/$active" ]] && fail_stale_active 46 "$active" "active slot directory is a symlink"
  # —— 手动逃生舱:只跳过 OAuth/anchor 对账,不跳结构安全门(R3#1;delegated 已在 configure_identity_bypass 被拒)
  [[ "$IDENTITY_BYPASS" -eq 1 ]] && return 0
  anchor=$(read_identity_anchor "$active") || fail_stale_active 46 "$active" "active slot has no valid identity anchor (run: flywheel-claude-profile anchor $active --migrate)"
  IFS=$'\t' read -r a_uuid a_email <<<"$anchor"
  # —— 快路径(零网络):display 只是 witness,一致即通过
  if display=$(read_display_identity); then
    IFS=$'\t' read -r d_uuid d_email <<<"$display"
    [[ "$d_uuid" == "$a_uuid" && "$d_email" == "$a_email" ]] && return 0
  fi
  # —— 慢路径:live token probe 是最终权威(Codex R1#1)
  echo "FLYWHEEL_STALE_ACTIVE_MARKER $active" >&2
  local cur o_uuid o_email observed
  cur=$(kc_read 2>/dev/null) || fail_stale_active 46 "$active" "no readable Keychain credential to reconcile against"
  credential_value_ok "$cur" || fail_stale_active 46 "$active" "Keychain credential not representable"   # 非退出 predicate(见下)
  observed=$(identity_probe "$cur") || fail_stale_active 46 "$active" "identity probe unavailable — cannot verify the current account"
  IFS=$'\t' read -r o_uuid o_email <<<"$observed"
  if [[ "$o_uuid" == "$a_uuid" && "$o_email" == "$a_email" ]]; then
    # marker 正确、display stale:保鲜池快照(strict),best-effort 修 display,照常继续。
    # 两种模式都允许:池凭据/display sidecar 均不触 store/generation → Node CAS 事实不变(§2.3)
    capture_live_credential_strict "$active" "$cur" || fail_stale_active 47 "$active" "live-credential capture into '$active' did not land"
    sync_identity "$active" || true                    # best-effort;恒返 0,不可证"已修好"(R3#6)
    audit_append stale_active_reconcile null pool_freshened_display_resync_attempted \
      || echo "Warning: stale-active audit append failed" >&2   # post-commit best-effort,不改业务退出码(R3#6)
    return 0
  fi
  # —— 真 marker drift:token 不属 active 槽
  if [[ "$DELEGATED_LOCK_ACCEPTED" -eq 1 ]]; then      # Codex R1#4:delegated 不做 marker/store 修复
    fail_stale_active 46 "$active" "active marker is stale (delegated mode performs no repair; executor must re-enter on fresh authority)"
  fi
  local true_active
  true_active=$(find_anchor_slot_by_identity "$o_uuid" "$o_email") || fail_stale_active 46 "$active" "machine identity matches no unique pool slot"
  # —— 修复(仅手动路径),可收敛顺序:capture → strict store sync+readback → marker 最后(Codex R1#3)
  capture_live_credential_strict "$true_active" "$cur" || fail_stale_active 47 "$active" "live-credential capture into '$true_active' did not land"
  active_sync_store "$true_active" force || { [[ $? -eq 39 ]] && exit 39; fail_stale_active 47 "$active" "account store sync failed"; }
  read_store_generation_for_active "$true_active" >/dev/null || fail_stale_active 47 "$active" "account store sync was not committed"
  local marker_wrc=0
  write_active_from_reconcile "$true_active" "$active" || marker_wrc=$?   # 第2参=expected preimage(R5#3)
  case "$marker_wrc" in
    0) : ;;                                            # committed
    2) fail_stale_active 47 "$active" "active marker state UNCERTAIN after rewrite — Keychain untouched; see stderr guidance" ;;
    *) fail_stale_active 47 "$active" "active marker rewrite failed (old marker preserved)" ;;
  esac
  RECONCILED_ACTIVE="$true_active"                     # 先落结果,审计只能 best-effort 跟在后面(R3#6)
  echo "FLYWHEEL_STALE_ACTIVE_RECONCILED $active $true_active" >&2
  audit_append stale_active_reconcile null "reconciled_${active}_to_${true_active}" \
    || echo "Warning: stale-active audit append failed" >&2
}
```

配套(全部为**非退出** predicate / strict 原语;显式逐步返回值,不依赖 `set -e` 在 `||` 上下文的行为 —— Codex R1#2/R2#2):

- `read_active_marker_strict`(R2#3 + R3#1):`use`/`next` 入口专用 strict reader,**区分三态**——(10) `.active` 真不存在;(0) 安全且合法 → 输出**已验证的精确 label**;(其他) unsafe/unreadable/malformed。安全+合法 = lstat regular file、非 symlink、owner=当前 uid,且**整个文件字节**经 Node/Buffer 二进制安全校验 == 一个精确 ASCII 合法 label(**无尾随换行、无 NUL、无多余字节** —— command substitution 会剥尾部换行/NUL,`business\n` 会被洗成合法串,所以字节校验必须在 reader 内、输出前完成,R3#1);调用方拿到的输出保证 == 文件字节。**绝不把读失败折叠成"缺失"**(现 `get_active` 的 `[[ -f ]] && cat || echo ""` 会;`get_active` 本身与其 `list`/`status` 用途不动)。
- `credential_value_ok <v>`:`require_credential_value` 的非退出 predicate 版。(`valid_profile_label` 不再需要独立接线 —— label 字节校验统一收进 reader 与枚举器。)
- `reconcile_absent_marker_locked`(R7#1 + R8):absent-marker 分流。`IDENTITY_BYPASS=1`(手动逃生舱)→ 直通;`kc_read` 状态在父 shell 显式**三分**(R8#1:与 `restore_keychain_preimage`/`commit_profile_locked` 既有语义对齐,「不可判即 fail-closed」)—— **rc 44(security not-found)= 唯一允许的空白 bootstrap 直通**(`RECONCILED_ACTIVE=""`,现行为);rc 0 且非空且过 `credential_value_ok` → live 权威流程;**rc 0 但空/不可表示、或任何非 44 的非零(锁定/权限/工具故障)→ mutation 前 46**。live 权威流程(`identity_probe` → `find_anchor_slot_by_identity`):delegated → 46 零 mutation;manual → `capture_live_credential_strict` + strict store sync/readback + `write_active_from_reconcile "$slot" ""`(**显式声明 expected-absent:以 `$# -ge 2` 判「调用方声明了 preimage」,空串即 absent —— 不用 `$2` 非空判断,与「未传 preimage」严格可区分**,R8#2)重建 marker → `RECONCILED_ACTIVE=<slot>` 继续正常切换;归不了槽/probe 不可用 → 46。writer rc 映射:0 → **先设 `RECONCILED_ACTIVE=<slot>`,再发 `FLYWHEEL_STALE_ACTIVE_RECONCILED absent <slot>` stderr + post-commit best-effort `audit_append stale_active_reconcile`(`|| Warning`,绝不改业务结果 —— 与真-drift 路径同一成功合同,R9#2)**,继续正常切换;1(destination 仍 absent,安全的 not-committed)→ 普通 47;2 → uncertain 47。这同时把 uncertain-absent 残局的「重跑 `use` 可收敛」承诺变为真(§1.3 第三档)。
- `find_anchor_slot_by_identity <uuid> <email>`(R3#5a):遍历 `$POOL_DIR/*/`,**只计入 basename 为合法 label、目录非 symlink 的槽**;`read_identity_anchor` 逐槽比对 **probe 观测值**;恰好 1 个匹配才输出槽名(输出前再过一次 label 校验);anchor 无效槽跳过不计失败;0 或 ≥2 → 非零。
- `capture_live_credential_strict <slot> <value>`(R2#1 + R3#4/#5b,替代「裸 capture_back + 后置检查」):**写前 preflight** —— slot label 已经枚举器/调用方校验、`$POOL_DIR`/槽目录非 symlink 且为 owner 安全目录、目标 `.credentials.json` **缺失或(regular file + owner=uid + mode 600 或 400)**(0400 是 `require_pool_entry` 明确支持的合法形态,拒收会造成新硬锁 —— R3#5b;替换文件统一写成 0600),任何其他形态(目录/FIFO/设备/symlink)→ 直接失败,**secret temp 尚未创建、零残留**;→ `identity_verify_payload <slot> <value> capture_back pool_write`(纵深,沿用现防线)→ **`lease_fence_or_fail`**(R3#4:secret temp 创建前)→ mktemp 随机 0600 temp(登记 `ACTIVE_SECRET_TEMP`)→ printf 显式检查 → **`lease_fence_or_fail`**(rename 前;fence 失败透传 39,父 trap 清已登记 temp,目标字节不动)→ **exact rename(小型 Node helper 调 `fs.renameSync`,rename(2) 语义:目标为目录时失败而非移入 —— 消除 shell `mv` 的 TOCTOU 目录窗口,R3#4)** → 清登记 → **readback**(regular/owner/mode + 字节比对)。任一步失败:清理 temp、返回非零。`capture_back` 本身(commit 路径的 best-effort 语义)不动。
- **硬化共享原语 `write_active_from_reconcile`**(R2#2 + R3#2,journal reconcile / capture recovery 两个既有调用方同受益,行为语义不变):固定 `$ACTIVE_FILE.tmp` 改为 mktemp 随机 O_EXCL 0600 temp(登记 `ACTIVE_TEMP_FILE`);每步显式检查返回值,任何失败路径**函数内部自清 temp** 后返回非零;**commit point 写死**(R3#2):内容/owner/mode readback 与最后一次 lease fence 都在 **temp 上、rename 之前**完成;目标 `.active` 校验非 symlink/目录后,以 **exact rename(Node `fs.renameSync`)原子提交,其后没有任何可失败的必需步骤**。**跨进程确认窗口消歧 + 显式返回协议**(R4#2 + R5#3:helper 可能在 renameSync 成功后被 signal/崩溃而返回非零,父 shell 不能把非零直接当 not-committed;且 journal 调用方经 command substitution,全局变量不传播 —— 状态必须走 **rc 协议**):签名改为 `write_active_from_reconcile <target> [expected-preimage]`,返回 **rc 0 = committed / rc 1 = not_committed / rc 2 = uncertain**。helper 非零时函数内判定 —— **以 destination postcondition 为准,temp 存在只用于清理/诊断,不单独证明任何状态**(R6#1:destination 可在 preflight 后被换成目录,`renameSync` EISDIR 时 temp 仍在而 destination 已非 preimage):(a) destination 经安全 lstat/owner/mode/精确内容验证 == 目标 label → rc 0(**已提交,按成功处理**);(b) destination 安全验证 == expected-preimage(调用方在 rename 前就持有的旧 active 值),或 expected 为 absent 且可证明仍 absent → rc 1(旧 marker 保留成立);(c) 其余(其他内容/不安全形态/未传 preimage 且非目标)→ rc 2;未传 preimage 的调用方不得仅凭 temp 存在得 rc 1。**三个调用方的映射各自写死**(R5#3):stale-active 调用方 → rc 2 = 47 第三档专用文案、rc 1 = 普通 47、rc 0 = 继续;journal-reconcile 调用方(command substitution)→ rc 2 输出**专用** conflict `{"outcome":"conflict","reason":"active_marker_commit_uncertain"}`(保留 journal),rc 1 沿用现有 conflict 路径(保留 journal);capture-recovery 调用方 → rc 非 0 保留 journal + 对应人工指引(uncertain 时不声称旧 marker)。每个调用方各补一条 outcome 传播断言。residue 承诺分层:temp 内容只是 label(非 secret);`use`/`next` 父 shell 路径由 `ACTIVE_TEMP_FILE`+finalize 覆盖信号清理;journal-reconcile 经 command substitution 调用(L1350-1356)登记不传播,该路径 hard-kill 残留窗口 = 非 secret label temp,接受并文档化(旧固定 `.active.tmp` 同样存在此窗口,不劣化)。
- `fail_stale_active <code> <active> <msg>`:46 → `echo "FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE $active" >&2` + `AUDIT_SUMMARY="stale_active_unresolvable"`;普通 47 → `echo "FLYWHEEL_STALE_ACTIVE_REPAIR_FAILED $active" >&2` + `AUDIT_SUMMARY="stale_active_repair_failed"`;**uncertain 47**(stale-active 调用方对 writer rc 2)→ 同一 stderr marker + **独立** `AUDIT_SUMMARY="stale_active_marker_commit_uncertain"`(R6#3,审计可事后区分「marker 保证未动」与「marker unknown」;47 专用 marker 绝不复用检测 marker —— R1#5);+ 人工指路文案(`claude /login` 确认账号 → `capture <slot>` 收编 / `anchor --migrate` 补 anchor)+ `exit <code>`。在父 shell 执行且立即 exit → `AUDIT_SUMMARY` 不会被后续流程覆盖,audit_append 落盘、finalize 释放锁并清理 temp。
- **成功路径的审计**(R2#5):不占 `AUDIT_SUMMARY`(它随后会被 assertion C 的 `match` 合法覆盖,语义归属身份检查);成功证据 = stderr `_RECONCILED` + 独立 `audit_append stale_active_reconcile …` 行。
- **marker 写失败的测试注入**(R2#5):`.active` 目录只读打不中(入口 `chmod 700 $POOL_DIR` 会恢复)→ 加窄作用域测试专用 fault hook `FLYWHEEL_TEST_FAIL_ACTIVE_MARKER_WRITE=1`(仅 `write_active_from_reconcile` 内部、仿现有 `FLYWHEEL_TEST_PAUSE_AFTER_JOURNAL` 先例)。

### 2.2 接线点(仅两处,父 shell 直调;**两层 marker 门**,Codex R4#1)

`use`/`next` 的真实首个 marker 写入点是 `reconcile_after_acquire`(transition-journal 恢复的 target-digest 分支会先写 marker + sync store,L1339-1344)—— strict gate 必须**先于它**,否则 unsafe marker 会在 46 之前被覆盖、或落成 generic journal-conflict exit 1:

```bash
# use_profile / next_profile,acquire_lock 之后:
active_marker_structural_gate            # 层1(只读,journal 恢复前):marker 三态 + 完整字节 +
                                         #   owner/type + active 槽非 symlink;absent 放行;unsafe → 46
reconcile_after_acquire                  # journal 恢复照旧(可能合法改写 marker)
...
local marker_rc=0                        # 层2(journal 恢复后,原 get_active 位点):
active=$(read_active_marker_strict) || marker_rc=$?   # 重新 strict 读,取可能已被 journal 更新的 active
reconcile_stale_active_locked "$marker_rc" "$active"
active="$RECONCILED_ACTIVE"
switch_profile_locked "$name" "$active" || rc=$?
```

`active_marker_structural_gate` = `read_active_marker_strict` 的只读复用(rc 10 放行、rc 0 放行、其余 46);同时(R4#1 同源缺口)**`write_active_from_reconcile` 自身**加目标槽校验:pool root 与 `$POOL_DIR/<label>` 必须是合法 label、owner-safe、**非 symlink 目录**(现实现 `[[ -d ]]` 会跟随目录 symlink)—— journal 恢复路径经它写 marker 时同受保护。

**不改** `prepare_profile_locked`/`commit_profile_locked` 的短路条件本身:对账之后「name==active ⟺ 重选当前账号」重新成立,且池槽已是 live 字节 → 重写无害。现有场景单测的行为锚不动(fixture 迁移见 §5.0)。

### 2.3 明确不做

- 不改 TS `machine-account.ts` 三见证语义、不做引擎 conflict 自动放行(exploration 方案 C;引擎 fail-close + alert 保持,alert 后的人工 `use` 因本单变为安全 + 自愈)。
- **delegated 边界的精确表述**(Codex R1#4 + R2#4):delegated 模式**不做 marker/store 修复 mutation**(真 marker drift → mutation 前 exit 46;引擎侧要自动修复需扩展 Bash→Node 结构化结果 + 重做 authority/CAS,另一单 scope)。display-stale 分支(token 归属当前 active 槽,marker 本身正确)的池凭据保鲜 + display sidecar 修复在**两种模式都允许**:两者均不触 `claude-accounts.json` 的 activeAccount/generation,Node 侧 `working`/`observedAccount`/CAS 事实不变,`commitSwitch` 写回不会覆盖任何修复(CAS 安全论证,配 delegated+display-stale 测试)。该分支的**可达性如实标注**(R3#7b,R4#3 精化):TS 三见证权威只比较 **display email vs 池内 oauthAccount email**(`machine-account.ts:57-70,96-98`),而 bash `read_display_identity` 要求四字段齐并比较 **uuid+email** —— 所以**异邮箱**的稳定 display-stale 会被 TS 先拦(conflict),但 **email 正确而 UUID 错 / organization 字段缺失**的稳定态会被 TS 判 `resolved`、**真实到达 delegated bash 慢路径**;外加 authority 读取后 TOCTOU 窗口与 legacy/直连 delegated seam。稳定异邮箱态的恢复路径 = 一次人工 `use`(其 display-stale 分支修好 sidecar → 三见证复原 → 引擎恢复)。测试覆盖两类:直连 seam + **真 authority + delegated bash 的 UUID-only/字段缺失回归**(integration,断言 strict 保鲜/display 修复正常、apply 期间 store activeAccount/generation 不变)。
- 不给 `status`/`list` 加 drift 提示(读路径,另单)。
- 不动带外 login 与 kc_write 之间的固有竞窗(research §6 R4)。
- 不新增 `FLYWHEEL_APPLY_REPORT_FILE` checkpoint 枚举(白名单 byte-compat,research §2.3)。

## 3. TS 改动(映射层)

### 3.1 `switch-executor.ts`

- 新错误类 `ActiveMarkerDriftError`(带 detail)。
- 候选循环 catch:比照 `FreshnessUnavailableError`(environmental)—— 不 flag 目标、不轮转候选,`outcome:"failed"`,新 reasonCode `"active_marker_drift"`(入 SwitchOutcome 联合类型)。daemon 侧 reasonCode 字符串透传,零额外注册。

### 3.2 `claude-profile-cli.ts`

**失败判据只认**:numeric `code === 46 || code === 47`,或专用终止 marker `/FLYWHEEL_STALE_ACTIVE_UNRESOLVABLE/`、`/FLYWHEEL_STALE_ACTIVE_REPAIR_FAILED/`。**检测 marker(`FLYWHEEL_STALE_ACTIVE_MARKER`)与成功 marker(`_RECONCILED`)一律不作失败判据**(Codex R1#5)。

**映射顺序必须放在 catch 分类链的最前**(R3#3,不能追加在 39 之后):`capture_live_credential_strict` 内部复用的 `identity_verify_payload` 失败时会先向 stderr 输出 `FLYWHEEL_TARGET_IDENTITY_MISMATCH`/`_UNVERIFIABLE`,外层才包装成 exit 47 + `_REPAIR_FAILED`;若旧 identity-marker 分支先匹配,会构造 `TargetIdentityMismatchError` 让 executor 把 **active 侧修复失败**错记到目标账号头上(flag/轮转)。46/47 与两个终止 marker 判在最前即消歧;检测/成功 marker 不参与,故 `code=30 + _MARKER + _RECONCILED + FLYWHEEL_TARGET_STALE` 仍落 `TargetStaleError`。成功路径:`_MARKER`/`_RECONCILED` 行无 `Warning:` 前缀 → 不进 onWarn(现有过滤天然满足,加断言锁定)。

## 4. 崩溃安全 / 并发论证(实现前提,测试锁定)

- 全程在 accounts lock 临界区内,与所有 `use`/`next`/`capture`/delegated 子进程串行;lease fence 由复用原语自带;39 透传(store sync 阶段)。
- **可收敛顺序**(Codex R1#3 + R5#1):capture(幂等,同字节)→ strict store sync + `read_store_generation_for_active` readback(失败 → 普通 47,此时 **marker 未动**,重跑重新检出 drift)→ 最后原子写 marker(writer 三态:`not_committed` → 普通 47、旧 marker 保留、重跑收敛;`committed` → 成功;`uncertain` → 47 第三档,marker unknown,按 §1.3 分类指引恢复)。store=new/marker=old 的中间窗口内 TS 三见证 = conflict → 引擎 fail-close,不会静默错切;下一次手动 `use` 重跑修复。凭据/台账的已完成前缀只会「更新鲜/更接近真相」,不劣于修前。
- 对账不引入新锁、不引入新 journal。

## 5. 测试计划(TDD,先红后绿)

### 5.0 既有 fixture 迁移(Codex R1#6,先行)

- bash harness 默认 display=shopping 而槽多为 personal/school:为既有非空-active 用例把 display/`oauthAccount.json`/anchor 对齐成三见证一致(或显式构造成 §1.2 display-stale 态并按新契约断言),**保留原 assertion-B 行为覆盖**,逐用例过一遍不许静默改语义。
- `claude-profile-cli.integration.test.ts` 的 display fixture 只有两字段且值与 anchor 不一致(`read_display_identity` 要求四字段)→ 补齐四字段并对齐 anchor,delegated 快路径一致 → 现有断言不变。
- active-sync helper stub 现只记 argv + exit 0:strict readback(`read_store_generation_for_active`)需要真写 store 的 stub / 真 helper,否则修复路径假红;补一个写 store 的 stub 实现。

### 5.1 bash 新用例(`packages/claude-runner/test/claude-profile.test.ts`)

固定基底:池 {business, shopping, school} 各带 anchor;stub Keychain = shopping live 凭据;stub curl probe → shopping 身份;`.active`=business(stale)。

1. **incident 复现(突变对照,核心回归)**:`use business` → exit 30;Keychain 字节不变;shopping 槽 == live 字节;`.active` == "shopping";store activeAccount == "shopping";stderr 含 `_MARKER` + `_RECONCILED`。(修前跑一遍确认红:exit 0 + Keychain 被覆盖。)
2. **还原**:`use shopping` → exit 0,Keychain 仍 live 字节,`.active`=shopping。
3. **第三账号**:`use school` → exit 0,shopping 槽已保存 live 字节,`.active`=school。
4. **`next`**:同基底 → 用修正后 active,行为同 1/3。
5. **display-stale 态(R1#1 回归)**:`.active`=personal 正确、Keychain=personal live、display=旧账号或畸形 → `use`/`next` **不被拒**:probe 归 personal → capture 保鲜 + best-effort display sync → 正常完成;display sidecar 修复后二次运行走快路径。
6. **健康态 byte-compat**:三见证一致 → 输出与现有快照逐字一致(零新 stderr 行),既有用例全绿。
7. **fail-closed 矩阵**(46 断言零 mutation;47 按 §1.3 逐态断言;全部加:对应 code/marker + `AUDIT_SUMMARY` 落审计 + 锁已释放 + **递归扫描无任何 `*.tmp.*` secret 残留**;**两层门专项(R4#1)**:pending journal × malformed/foreign-owner/symlink/目录 marker → journal 恢复**前**以 46 拒(marker/store 零 mutation,非 generic exit 1);journal targetLabel 指向 symlink 槽 → writer 校验拒;**rename 确认窗口(R4#2 + R5#2 + R6#1/#2)**:注入「renameSync 成功后 helper 非零退出」→ 判 committed → writer 按成功处理、`_RECONCILED` 照发;**temp 在 + destination 精确 == preimage** → 普通 47 旧 marker 保留;**temp 在 + destination 被换成目录/symlink/第三方内容(EISDIR 类)→ uncertain**(destination postcondition 定状态,temp 存在不证明 preimage);temp 消失 + destination == 安全的**池内已锚定第三方槽 label**(如 school)→ uncertain 47、指引「重跑 `use`」且下一次 `use` 真收敛;destination == **语法合法但池内不存在/无 anchor 的 ghost label** → uncertain 47、指引转人工、下一次 `use` 按设计 46;destination 为 **unsafe 形态** → uncertain 47、人工修复指引、下一次 `use` 被层1门 46 拒 —— 各类 uncertain 都断言 exit/stderr 指引/Keychain 不动/audit summary == `stale_active_marker_commit_uncertain`):
   a. `.active` 内容畸形(多行/路径字符)→ 46;b. active 槽 anchor 缺失/权限位错 → 46;c. active 槽目录 symlink → 46;d. Keychain 不可读 → 46;e. 凭据不可表示 → 46;f. probe 网络失败(stub curl 非零)→ 46;g. probe 身份匹配 0 槽 → 46;h. 匹配 2 槽 → 46;i. capture preflight 拒绝:目标 `.credentials.json` 为**目录** / FIFO / symlink(R2#1)→ 47,且 **preflight 在 secret temp 创建前失败 —— 目录内无 secret temp 被移入、磁盘零 secret 残留**、marker/store 未动;j. store sync helper 失败 / readback 不过 → 47 且 **marker 未动**;k. marker 写失败(fault hook `FLYWHEEL_TEST_FAIL_ACTIVE_MARKER_WRITE=1`,R2#5)→ 47 且 store 已 sync + 旧 marker 保留(重跑收敛断言:再跑一次 `use` 完成修复)。
8. **入口 strict marker reader(R2#3 + R3#1)**:`.active` 为 symlink / 目录 / 不可读(权限)→ 46,Keychain/pool/store/marker 全不变、**不发生「空 marker 直通 + 漏 capture」**;**字节级畸形**:内容带尾随换行 / 多个尾随换行 / 嵌入 NUL / 多行 → 46(command substitution 剥尾字节洗白的路径被 reader 内字节校验堵死);**unsafe marker + `FLYWHEEL_PROFILE_IDENTITY_BYPASS=1` → 仍 46**(结构安全门不可 bypass);**absent-marker 分流(R7#1 + R8#1)**:`.active` 真缺失 × `kc_read` 三分 —— rc 44(not-found,空白 bootstrap)→ 直通(现行为);rc 63 等非 44 非零(unreadable stub)→ 46 全不动;rc 0 但空值 → 46 全不动;rc 0 + live 凭据(store=shopping、Keychain=shopping live 的 uncertain-absent 残局基底)→ **端到端回归,断言分两层**(R9#1:repair checkpoint 与 command final outcome 分开):**checkpoint 层**(所有变体共用)= `_RECONCILED absent shopping` stderr + 独立 audit 行证明 shopping marker/store 曾被安全重建、shopping 槽已收到 live 字节;**final 层**(逐命令)= 原命令 `use business`(stale target)→ exit 30、最终 active=shopping;`use shopping` → exit 0、最终 shopping;`use school` → exit 0、**最终 school**(正常 commit 语义,shopping 槽仍保有原 live 凭据);`next` → 按真实首个候选断言最终 active 与 exit;delegated + absent+live → 46 零 mutation。**writer preimage 协议(R8#2)**:显式 `""`(declared absent)+ destination 仍 absent → rc 1;**未传** preimage + destination absent → rc 2;destination == target → rc 0;destination 第三方/unsafe → rc 2。
9. **marker writer 硬化回归(R2#2 + R3#2/#7a,`/bin/bash` 3.2 下)**:预置旧固定名 `.active.tmp` 的 symlink → **修复照常成功**(随机 temp writer 不触碰它)、**symlink 指向的文件字节不动**、legacy temp 原样留下;`.active` 自身为 symlink/目录 → 拒;printf 首步失败(fault hook)→ rc 1、temp 自清;**post-rename 无必需的验证步骤**(commit point 断言:rename 成功后唯一剩余逻辑是消歧,消歧只可能产出 committed=成功或 uncertain,绝不产出「旧 marker 保留」的普通 47);**writer 三态 rc 的逐调用方传播断言(R5#3)**:stale-active 调用方 rc2 → 47 第三档文案;journal-reconcile 调用方 rc2 → `{"outcome":"conflict","reason":"active_marker_commit_uncertain"}` 且 journal 保留;capture-recovery 调用方 rc 非 0 → journal 保留 + 对应指引;journal-reconcile / capture-recovery 两个既有调用方行为锚不回归。
10. **strict capture 竞态/边界(R3#4/#5b)**:temp 已写后 lease proof 被替换 → 39 透传、temp 被清、目标字节不动;preflight 后目标被换成目录(受控注入)→ exact rename 失败、**无 secret 落入目录**、安全失败;目标为合法 **0400** 凭据(display-stale 与真 drift 两分支)→ 修复成功、替换后统一 0600。
11. **delegated 边界(R1#4 + R2#4 + R3#7b)**:delegated + 真 drift → exit 46,池/marker/store 三不动;delegated + display-stale(定位到真实可达 seam:直连 delegated 调用,模拟 authority 读取后窗口)→ capture 保鲜 + 照常切换,且 store 的 activeAccount/generation 在 apply 前后不被 bash 侧改动(CAS 安全);delegated + 快路径一致 → 照常切换(现行为)。
12. **逃生舱**:`FLYWHEEL_PROFILE_IDENTITY_BYPASS=1` 手动跳过 OAuth/anchor 对账(结构门仍在,见 #8);delegated 拒 bypass(现有用例确认不回归)。
13. **审计(R2#5 + R3#6 + R9#2)**:修复成功 → audit log 含独立 `stale_active_reconcile` 行,后续 `AUDIT_SUMMARY=match` 不影响它;**audit append 被注入失败 → 业务结果不变**(display-stale 分支照常切换、真 drift 与 **absent-repair** 分支照常完成且 `_RECONCILED` 已发),仅 stderr Warning;锁/temp 清理正常。
14. 核心用例(1 / 7k / **8(absent 分流,含 rc 捕获与 `$#` 协议)** / 9 / 10)在 `/bin/bash` 3.2 下跑(Codex R1#2 + R9#2;harness 现有 bash 调用方式沿用)。

### 5.2 TS 新用例

- `claude-profile-cli.test.ts`:code 46 → `ActiveMarkerDriftError`;code 47 → 同;marker-only fallback(`_UNRESOLVABLE`/`_REPAIR_FAILED`,code 为 signal 串)→ 同;**code=30 + stderr 含 `_MARKER`+`_RECONCILED`+`FLYWHEEL_TARGET_STALE` → 仍 `TargetStaleError`**(R1#5 核心);**嵌套 identity-marker 消歧(R3#3/R4#4,正式清单)**:`code=47 + _REPAIR_FAILED + FLYWHEEL_TARGET_IDENTITY_MISMATCH` → `ActiveMarkerDriftError`(非 `TargetIdentityMismatchError`);`code=47 + _REPAIR_FAILED + FLYWHEEL_TARGET_IDENTITY_UNVERIFIABLE` → 同;exit 0 + `_MARKER`/`_RECONCILED` → 正常返回、不进 onWarn。
- `switch-executor` 单测:`ActiveMarkerDriftError` → failed/`active_marker_drift`、目标未被 flag、无候选轮转;**其中至少一条贯穿嵌套 identity-marker 场景**(applyProfile 模拟 47+`_REPAIR_FAILED`+`_TARGET_IDENTITY_MISMATCH` stderr → 断言 `active_marker_drift`、目标无 identityMismatch flag、无第二次 apply)。
- `claude-profile-cli.integration.test.ts`(R4#3):真 authority + delegated bash 的 **UUID-only drift / organization 字段缺失** display-stale 回归 → strict 保鲜 + display 修复正常完成、apply 期间 store activeAccount/generation 不变。

### 5.3 验收口径

- `pnpm -r build` + 相关包测试绿 + `pnpm lint` 干净;CI 绿。
- 独立 QA(实现后实现者主动起,FLY-1211 硬门):隔离 pool/claude.json/stub SEC_BIN 全 scratch,重放 incident 基底修前/修后对照跑真脚本;**绝不碰生产 Keychain/池**。

## 6. 交付切分与部署(两个激活层,Codex R1#6)

单 PR(bash + TS 映射 + 测试 + docs 同车)。bash 与 TS 同 PR 是**归因/可观测性**要求而非安全依赖:旧 dist 遇 46/47 安全落 generic `apply_failed`(仍 fail-closed)。激活分两层:

- **bash 层**(clobber 根治本体):每次 spawn 现读 → merge + 生产 `git pull` 即生效,无需重启。
- **TS 层**(`active_marker_drift` 归因):进 dist → `pnpm -r build` 后、长驻 quota-monitor daemon(`packages/teamlead/bin/flywheel-quota-monitor` 加载 `dist/.../quota-monitor-cli.js`)与 Bridge 需**下次自然重启**收编;不催重启。

## 7. 风险与回滚

- 误伤健康路径的防线:快路径(display==anchor)零成本通过;不一致才 probe,probe 权威归槽;一切不可判都 fail-closed 46,绝不盲修。回滚 = revert 单 PR(无 schema/状态迁移)。
- 46 的可用性代价(anchor 未迁移的 legacy 槽做 active + 快路径无法证实时切换被拒)是**故意的**:该态「短路是否合法」无法证实,现状的「赌一把」正是本单要杀的行为;文案指路 `anchor --migrate`。
- 网络代价:仅在 display 与 anchor 分歧、或 absent-marker 且 Keychain 有 live 凭据时多一次 identity probe(10s timeout);健康路径零网络。

## 8. Codex design review 记录

**最终状态:R10(2026-07-19,xhigh,resume)= APPROVED — ready to implement,零阻塞项。** 10 轮全程无空转:每轮发现均为真缺陷/真契约洞,逐轮收敛(R1 6项 → R2 5 → R3 7 → R4 4 → R5 3 → R6 3 → R7 1 → R8 2 → R9 2 → R10 0),全部接受并折入本计划。

- R9(2026-07-19,xhigh,resume):CHANGES REQUESTED,2 项(MEDIUM),全部接受:
  1. absent-repair 测试把 checkpoint 与最终态混断言(`use school` 最终该是 school 非 shopping)→ 断言分两层:repair checkpoint(`_RECONCILED absent shopping` + audit + 槽收 live 字节)与逐命令 final outcome(business→30/shopping、shopping→0/shopping、school→0/school、next 按真实候选)。
  2. absent-repair 成功路径补齐既定成功合同(先设 out-param → `_RECONCILED` stderr → post-commit best-effort audit)+ 纳入 #13 audit-failure 与 #14 Bash 3.2 核心覆盖;§7 网络代价说明补 absent+live 慢路径。
- R8(2026-07-19,xhigh,resume):CHANGES REQUESTED,2 项(1 HIGH + 1 MEDIUM),全部接受:
  1. 「kc_read 失败/空 = 空白 bootstrap」fail-open(既有语义:仅 exit 44 是 not-found;63 等故障必须拒)→ absent 分流按 kc_read 三分:44 直通 / rc 0+live 走权威流程 / 其余(空值、非 44 非零)46 全不动;补 63/空值/44 三条回归。
  2. `expected-preimage=absent` 与「未传 preimage」不可区分 → 协议写死:`write_active_from_reconcile "$slot" ""` 以 `$# -ge 2` 判「显式声明」,空串即 declared-absent;补协议级四态测试(declared-absent+absent→1 / 未传+absent→2 / ==target→0 / 第三方或unsafe→2)。
- R7(2026-07-19,xhigh,resume):CHANGES REQUESTED,1 项(HIGH),接受:
  1. absent-marker rc=10 无条件直通与 uncertain-absent「重跑收敛」承诺矛盾,且 absent+live 凭据本身会走「空 active 跳 capture_back」的泄漏路径 → 新 `reconcile_absent_marker_locked` 分流:可证空白 bootstrap(Keychain 无凭据)才直通;有 live 凭据走同一 token-probe 权威流程(delegated → 46 零 mutation;manual → strict capture + store sync + 重建 marker 后照常切换);补 uncertain-absent 残局端到端回归(重跑原命令/第三账号/`next` 零漏 capture、marker 收敛)。
- R6(2026-07-19,xhigh,resume):CHANGES REQUESTED,3 项(1 HIGH + 2 MEDIUM),全部接受:
  1. 「temp 仍在 → rc 1」不成立(destination 可在 preflight 后被换成目录,EISDIR 时 temp 在而 preimage 已失)→ rc 判定改以 **destination postcondition** 为准(==target → 0;==preimage/可证 absent → 1;其余 → 2),temp 只用于清理/诊断;补 temp-present × dest-swapped 回归。
  2. 「safe 合法 label 重跑即收敛」误把语法安全当可解析 → 指引改为「absent 或解析到可用+已锚定唯一槽才收敛;ghost/无 anchor label 重跑 = 46 转人工」;补 ghost-label 回归。
  3. uncertain 与普通 47 在 audit 折叠 → 独立 `AUDIT_SUMMARY="stale_active_marker_commit_uncertain"`,审计可事后区分;exit code/TS error 不扩。
- R5(2026-07-19,xhigh,resume):CHANGES REQUESTED,3 项(2 HIGH + 1 MEDIUM),全部接受 —— 全部为 committed-uncertain 状态的契约一致性收口:
  1. 顶层 §0/§1.3/§4/测试#9 仍残留「47 双不动」旧承诺 → 状态承诺改**三档**无歧义表(46 零 mutation / 普通 47 Keychain+marker 不动 / uncertain 47 仅 Keychain 不动、marker unknown);健康态合同从「两次读」改为「零网络零可见变化」。
  2. 「uncertain 一律重跑 use 收敛」不成立(unsafe destination 会被层1门 46 拒)→ 恢复指引按 destination readback 分类(safe 合法 label/absent → 重跑收敛;unsafe → 人工修复),两类 uncertain 各补测试。
  3. writer 缺 commit-state 返回协议(journal 调用方在 command substitution 里,全局变量不传播;非零会被折成 malformed_journal)→ 签名 `<target> [expected-preimage]` + rc 0/1/2 = committed/not_committed/uncertain;三个调用方映射逐一写死(stale-active → 47 分档;journal → 专用 `active_marker_commit_uncertain` conflict 保留 journal;capture-recovery → 保留 journal + 指引),各补传播断言。
- R4(2026-07-19,xhigh,resume):CHANGES REQUESTED,4 项(2 HIGH + 2 MEDIUM),全部接受:
  1. strict marker gate 晚于 transition-journal 恢复(journal target-digest 分支会先写 marker)→ 两层门:journal 恢复前只读结构门 + 恢复后重新 strict 读;`write_active_from_reconcile` 自身加目标槽 label/owner/非 symlink 校验(journal 路径同保护)。
  2. `fs.renameSync` 在子进程,rename 成功后 helper 仍可非零 → 父侧 committed/not-committed 消歧(temp 在场 → 47;temp 消失且 destination 安全 == 新 label → 按成功;== 旧 label → 47;其余 → committed-uncertain 47 如实措辞),§1.3 注明唯一例外。
  3. TS authority 只比 email → 「稳定 display-stale 全被 TS 先拦」不成立:UUID-only/字段缺失稳定态真实到达 delegated;§2.3 修正 + integration 回归。
  4. 嵌套 identity-marker 回归从叙述折进 §5.2 正式测试清单(CLI 两条 + executor 贯穿一条)。
- R3(2026-07-19,xhigh,resume):CHANGES REQUESTED,7 项(4 HIGH + 3 MEDIUM),全部接受:
  1. command substitution 剥尾随换行/NUL 会把畸形 marker 洗成合法 label、bypass 又早于结构校验 → label **字节级**校验收进 reader(Node/Buffer,输出前完成),调用顺序改为 结构安全门 → bypass(bypass 只跳 OAuth/anchor 对账)。
  2. rename 后 readback 与「47 时旧 marker 保留」互斥 → commit point 写死:readback + 最后 lease fence 全在 temp 上、rename 前;exact rename 即成功,其后无必需步骤;journal-reconcile 子 shell 调用的登记不传播如实分层(temp 仅含非 secret label)。
  3. 47 内嵌的 `FLYWHEEL_TARGET_IDENTITY_*`(来自 strict capture 的 identity_verify_payload)会被 CLI 旧 marker 分支抢先 → 46/47 + 终止 marker 映射放 catch 链最前;补 `code=47 + _REPAIR_FAILED + _TARGET_IDENTITY_MISMATCH/_UNVERIFIABLE → ActiveMarkerDriftError` 回归。
  4. strict capture 缺 lease fence + shell `mv` 目录 TOCTOU → temp 创建前与 rename 前双 fence(39 透传),rename 改 Node `fs.renameSync`(rename(2) 对目录目标失败而非移入)。
  5. `true_active` label 校验未接线 + preflight 拒收合法 0400 凭据 → 枚举器只计合法非 symlink 槽 + 输出再校验;preimage 接受 owner regular 0400/0600,替换统一 0600。
  6. 成功审计行在 `set -e` 下可能把已提交修复变 generic exit 1、`display_resynced` 不可证 → 审计改 post-commit best-effort(`|| Warning`),事件名改可证事实(`pool_freshened_display_resync_attempted`);补 audit 失败业务不变回归。
  7. 预置 `.active.tmp` symlink 测试预期与随机 temp writer 不符(应为修复成功 + referent 不动);delegated display-stale 分支可达性如实标注(稳定态被 TS authority 先拦,分支只覆盖 TOCTOU/legacy seam,稳定态恢复靠一次人工 `use`)。
- R2(2026-07-19,xhigh,resume):CHANGES REQUESTED,5 项(3 HIGH + 2 MEDIUM),全部接受:
  1. 裸 `capture_back` + 后置检查会在目标为目录等异常形态时把 secret temp 移入目录落盘 → 新 strict 原语 `capture_live_credential_strict`:写前 preflight(目标只能缺失或 owner regular 600)+ mv 前再验非目录 + readback;temp 创建前失败零残留。
  2. `write_active_from_reconcile` 固定 temp 可被 symlink 预置劫持 + `||` 上下文 errexit 抑制吞错 → 本单硬化该共享原语(随机 O_EXCL temp + `ACTIVE_TEMP_FILE` 登记 + 逐步显式检查 + 目标形态校验 + content readback),既有调用方行为锚回归。
  3. `get_active` 把 unsafe/unreadable marker 折叠成空 → 入口改用 `read_active_marker_strict` 三态 reader(absent 直通 / 安全读出 / 其余 46),`get_active` 的 list/status 用途不动。
  4. delegated 边界与 47 契约内部矛盾 → §2.3 精确化(delegated 仅禁 marker/store 修复;display-stale 保鲜两模式允许 + CAS 论证);§1.3 改为 46=零 mutation、47=Keychain+marker 不动、pool/store 可留可收敛前缀,逐态写死。
  5. `.active` 目录只读注入会被入口 `chmod 700` 恢复 → 窄作用域 fault hook `FLYWHEEL_TEST_FAIL_ACTIVE_MARKER_WRITE`;成功审计不占 `AUDIT_SUMMARY`(会被 assertion C 合法覆盖),改独立 `audit_append stale_active_reconcile` 行。
- R1(2026-07-19,xhigh):CHANGES REQUESTED,6 项(5 HIGH + 1 MEDIUM),全部接受:
  1. display 不能当唯一权威(sync_identity best-effort → display-stale 是合法态)→ 改为「display 快路径 witness + token probe 最终权威」,新增 §1.2 契约 + 5.1#5 回归;`.active` 内容先验 label。
  2. `$(...)` subshell 丢审计/temp/trap + `require_*` 内部 exit → 父 shell 直跑 + `RECONCILED_ACTIVE` out-param + 非退出 predicate。
  3. `active_sync_store` 探测不到失败 + 顺序违约 → strict sync + `read_store_generation_for_active` readback,顺序改为 capture → store → marker 最后(47 时 marker 未动,可收敛)。
  4. delegated 自愈与 Node CAS 冲突 → delegated 检出真 drift 零 mutation 直接 46,修复只归手动路径。
  5. TS 映射可能吃掉 exit 30 → 失败判据只认 46/47 + 专用终止 marker(47 新增 `_REPAIR_FAILED`),补 code=30 混合 stderr 回归。
  6. fixture 迁移(display/anchor 对齐、integration 四字段、真写 store 的 active-sync stub)+ 部署两层(bash spawn 现读 / TS 需 build+daemon 自然重启)写清。
