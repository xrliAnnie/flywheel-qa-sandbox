# FLY-865 账号切换身份同步 — 实施计划

Issue: FLY-865 (https://linear.app/geoforge3d/issue/FLY-865/bug-账号切换只换-token-不换显示身份-新-claude-status-仍显示旧账号阻塞-696-enable)
日期: 2026-07-04
基于: research.md

> 方向经 Lead brainstorm gate 确认:走 Path 1(capture 补存身份 + use 原子写回 `.claude.json`),排除 Path 2。采纳 Lead 4 项收紧 + **Codex design review R1 全 7 项**(HIGH×3 / MED×3 / LOW×1):①共享 `~/.claude.json.lock` ②capture 防 stale identity ③JSON schema 校验 ④byte-compat 措辞订正 ⑤clobber 结论降级 + post-write 复验 ⑥bash 3.2 测试 ⑦identity 文件 0600/symlink 严校。

---

## 1. 目标 & 范围

`flywheel-claude-profile use <name>` 在切 Keychain token 的**同时**,原子把 `~/.claude.json` 的 `oauthAccount`(/status 显示身份的唯一来源)换成目标账号 → 新开 claude `/status` 真显示切过去的账号。

**In scope**:bash `flywheel-claude-profile`(`capture` 采集身份 / `use` 写回身份 / `FLYWHEEL_CLAUDE_JSON` override / 共享 claude-json 锁 / 校验 + post-write 复验)+ 测试扩展 + 采集清单。
**Out of scope**:无 TS 逻辑改动(executor 经 `applyProfile` 透明继承);非破坏式 iso 采集(见 §6,可选 follow-up)。

## 2. 实测结论(Lead 承重点①:live-session 是否 clobber `.claude.json` oauthAccount)

**方法**:往真 `~/.claude.json` 注入两个惰性探针(顶层 `_fly865Probe` + oauthAccount 内 `_fly865` 子字段,**不动**真身份),监控忙碌 fleet 的写。
**观测**:~2min 内 **6 次独立 fleet 写**,每次两探针都存活,identity 从不变。探针实测后已清理,真身份=shopping 无损。
**结论(Codex R1#5 降级措辞)**:观测窗口内 live session 对 `.claude.json` 是 read-merge-write、**未见 clobber**;这是 **observed low risk, not reproduced**,**不作为正确性依据**(不能证明所有 writer 都在写前立即重读、也不能证明持旧内存快照的 writer 不会在 last-writer-wins 里赢)。→ 正确性靠 §3 的**共享锁 + post-write 复验**,clobber 归**已接受限制**(§7)+ Lead-run `/status` 终验。

## 3. 设计

### 3.1 新 env override
```
CLAUDE_JSON="${FLYWHEEL_CLAUDE_JSON:-$HOME/.claude.json}"
CLAUDE_JSON_LOCK="${FLYWHEEL_CLAUDE_JSON_LOCK:-${CLAUDE_JSON}.lock}"   # 真文件→~/.claude.json.lock;scratch→<scratch>.lock
```
默认真 lock 路径与 `scripts/inject-linear-issue.sh` / `scripts/test-teardown.sh` **完全一致**(`~/.claude.json.lock`)。沿用同名 stale/wait 旋钮 `CLAUDE_LOCK_STALE_S`(60)/`CLAUDE_LOCK_WAIT_S`(30)。

### 3.2 池内身份文件
`$POOL_DIR/<name>/oauthAccount.json`(0600,dir 0700),与 `.credentials.json` 同保护级。新 `require_identity_entry`(Codex R1#7):可选存在;若存在则 **refuse symlink + 必须 regular file + 必须 0600/0400 + 必须解析为 JSON object**;不满足 → 当作「无有效身份」loud-warn + return 0(绝不 fail token 切换)。

### 3.3 共享 claude-json 锁(Codex R1#1 HIGH)
新增 `acquire_claude_json_lock` / `release_claude_json_lock`,**mkdir 互斥 + mtime stale-steal + timeout**,语义**逐字对齐**现有两脚本(见 inject-linear-issue.sh:129-166)。**只有 `use` 的写** `.claude.json` 需要它;`capture` 只**读** `.claude.json`(rename 原子,无 torn read,不需锁)。
- 锁嵌套:`use_profile` 先持 accounts 锁(`FLYWHEEL_CLAUDE_ACCOUNTS_LOCK`,可能是 FLY-852 delegated),再在 `sync_identity` 里取 claude-json 锁 → 顺序恒为 **accounts→claude-json**;inject/teardown **只取 claude-json 锁**,无反序 → **无死锁环**。
- 取锁失败(timeout)→ loud-warn + return 0(token 切换已成功)。

### 3.4 `capture <name>` —— 采集 token 的同时采集身份(matched pair)+ 防 stale(Codex R1#2 HIGH)
现有:抓 Keychain → `.credentials.json`。**新增** `capture_identity`(在 accounts 锁内):
- 读 `$CLAUDE_JSON` 的 `.oauthAccount`,**校验为含 `accountUuid`/`emailAddress`/`organizationUuid`/`organizationName` 字符串字段的 object**;有效 → tmp(`wx` 独占)+chmod 600 + rename 写 `oauthAccount.json`,**回显 emailAddress** 供肉眼核对。
- **无效 / 缺 oauthAccount / `$CLAUDE_JSON` 缺失** → **删除该 profile 任何既有 `oauthAccount.json`**(关键:绝不让新 token 配旧身份文件 = 假「已修」)+ warn 到 stderr「'<name>' 无显示身份,login 后重新 capture」→ return 0(token 已抓)。

### 3.5 `use <name>` —— verify-before-commit + `.active` 落地之后,写回身份
在 `mv "$ACTIVE_FILE.tmp" "$ACTIVE_FILE"` 之后、最终 "Switched…" echo 之前,调 `sync_identity <name>`:
1. src=`oauthAccount.json`;跑 `require_identity_entry`。不存在/不合规 → **loud warn**(token 已切,`.claude.json` 显示身份**未**更新,新开 claude /status 可能显示旧账号;修复:login `<name>` 后 `capture <name>`)→ return 0。
2. `$CLAUDE_JSON` 不存在 / 是 symlink → warn + return 0。
3. 取 claude-json 锁(§3.3);失败 → warn + return 0。
4. **node 原子 patch**(见 §3.6):校验 src 是合规 identity object + target 解析为 object;把 target 的 `.oauthAccount` 换成 src,保留其余全部 key。写 tmp(`wx` 独占,同目录)+chmod 到 target 现有 mode + rename。
5. **post-write 复验(Codex R1#5)**:rename 后**在锁内重读** target 的 `.oauthAccount.emailAddress`,与 src 不一致 → warn(疑似并发 clobber)。
6. 释放锁。成功 → echo(**stdout**?见 §3.7)。任何 4/5 失败 → 清 tmp + **loud warn**(token 切了 OK,显示身份未更新)→ return 0。

**契约(Lead④/Codex R1 keep)**:`sync_identity` **永远 return 0**,绝不因身份步骤让 `use` exit 非零(executor 把非零当 token 切换失败,但此刻 Keychain 已 verify-commit)。**绝不 clear oauthAccount**。

### 3.6 JSON 读写机制(Codex R1#3 HIGH)
**node**(本仓保证在 PATH;脚本由 Node Bridge / vitest `execFileSync bash` 触发)。经 **quoted heredoc(`<<'NODE'`)+ argv 传路径** = 零转义;JSON 内容经文件读、不进 argv。**校验优先于写**:
- source identity:`JSON.parse` 成功 + 是 plain object(非 null/array/string)+ `accountUuid`/`emailAddress`/`organizationUuid`/`organizationName` 均为非空 string;否则非零退出、**不碰 target**。
- target `.claude.json`:`JSON.parse` 成功 + object;失败 → **拒绝覆盖**(对齐 inject 脚本「exists but not valid JSON → refuse」)、非零退出。
- 写:同目录 `openSync(tmp,"wx")` 独占(EEXIST 换随机名重试)→ `writeFileSync` → `chmodSync(tmp, targetMode)` → `renameSync`。**任何 throw**:`unlinkSync(tmp)`(若已建)+ 非零退出。node 非零 → bash `if email=$(...)` 分支捕获(实测 `/bin/bash` 3.2.57 与 5.3 下都不触发 set -e 退出)→ 走 warn 分支。
- **内联 heredoc(非独立 .mjs)**:单文件可分发、无 PATH-locate/symlink 脆弱性,行为由 integration 测试全覆盖。

### 3.7 stdout/stderr 契约(Codex R1#4 MED)
`use` 的 **stdout 只保留原有单行** "Switched machine Claude account to profile '<name>' (…)";**所有身份 成功/warn 信息走 stderr**。→ 现有断言(stdout toContain "Switched…")不回归;executor 只看 exit code。**放弃「byte-diff 整文件只 oauthAccount 变」的措辞**,改为「**所有非-oauthAccount 数据语义保留**」(测试用 parse 前后对比,非整文件 byte-diff —— parse/stringify 不保留空白/格式)。

### 3.8 字节兼容(措辞订正)
所有 profile 在 re-capture 前均无 `oauthAccount.json` → `use` 走 §3.5 step1 warn 分支、**不碰 `.claude.json`**,exit code 与 stdout 与现状一致(仅多 stderr warning)。→ **不改运行时默认行为(语义等价)**,无需新 flag。(不再声称整文件字节相同 —— 仅 stdout/exit-code/`.claude.json` 内容不变。)

## 4. 改动清单

| 文件 | 改动 |
|------|------|
| `packages/claude-runner/bin/flywheel-claude-profile` | `CLAUDE_JSON`/`CLAUDE_JSON_LOCK` override + `acquire/release_claude_json_lock` + `require_identity_entry` + `capture_identity`(含 stale-delete)+ `sync_identity`(含锁 + post-write 复验)+ 两个内联 node heredoc(extract / patch,含 schema 校验)+ `use_profile`/`capture_profile` 各挂一行 |
| `packages/claude-runner/test/claude-profile.test.ts` | 新增身份用例(§5.1)+ **bash 3.2 分支**(§5.3) |
| `packages/teamlead/src/__tests__/claude-profile-cli.integration.test.ts` | 补:REAL 脚本切换后 scratch `.claude.json` 身份被写 |

## 5. 测试计划(TDD,RED→GREEN)

### 5.1 单元(claude-profile.test.ts,`FLYWHEEL_CLAUDE_JSON`+`FLYWHEEL_CLAUDE_JSON_LOCK` → scratch)
1. `capture` 把 scratch `.claude.json` 合规 oauthAccount → `oauthAccount.json`(0600),回显 email。
2. `capture` 遇 scratch 无/非法 oauthAccount → warn + **删除既有 `oauthAccount.json`(stale 防护)** + exit 0 + token 仍被抓。
3. `use` 有合规身份 → scratch `.claude.json` oauthAccount 换成目标账号,**其余顶层 key 语义原样**,mode 不变,stdout 仍单行 "Switched…"。
4. `use` 无身份文件 → loud warn(stderr 含 "capture")+ `.claude.json` 不变 + exit 0 + token 已切(RED LINE 不回归)。
5. `use` 大 `.claude.json`(多顶层 key + 嵌套)patch 后 parse 对比:只有 oauthAccount 变。
6. **schema 校验**:src identity = `null` / string / 缺 emailAddress → warn + target **字节不变** + exit 0;target `.claude.json` 非法 JSON → **拒绝覆盖** + 字节不变 + exit 0。
7. symlink 的 `oauthAccount.json` / symlink 的 `$CLAUDE_JSON` / group-world-readable(非 0600/0400)`oauthAccount.json` → refuse(warn)+ 不写 + exit 0。
8. **原子/清理**:patch 后无残留 `*.fly865*` tmp(成功与强制失败两路);强制 node 失败 → target 字节不变 + exit 0。
9. **claude-json 锁**:锁被占(预建 lockdir + 未过 stale)→ `use` 身份步 timeout → warn + `.claude.json` 不变 + **token/.active 仍切** + exit 0。
10. **post-write 复验**:注入「rename 后 target 被外部改 email」→ warn mismatch(用可控 hook / 或跳过,视可测性;至少断言正常路径复验通过)。

### 5.2 Integration seam(claude-profile-cli.integration.test.ts)
11. REAL `switchAccount` 持 REAL accounts 锁 → REAL bash `use` → 除 fake keychain 切 token 外,scratch `.claude.json`(经 `FLYWHEEL_CLAUDE_JSON`)oauthAccount 被写成目标账号。

### 5.3 bash 3.2 覆盖(Codex R1#6 MED)
- 验证阶段跑 `/bin/bash -n packages/claude-runner/bin/flywheel-claude-profile`(语法)。
- 至少一条身份用例用 **`/bin/bash`**(macOS 系统 3.2.57)跑真脚本(test helper 加可配 bash 路径,存在则跑)。
- **禁用 bash4-only**:`mapfile`/`readarray`/关联数组(`declare -A`)/`local -n`/`declare -g`/`BASHPID`。

### 5.4 两级验收(Lead②,别混)
- **(a) Fixture QA(runner 做,零真状态/零额度)**:`FLYWHEEL_CLAUDE_JSON`/`_LOCK` 指 scratch,drill `use business` → scratch `.claude.json` oauthAccount=business + 其余 key 语义原样 + tmp+rename 原子 + 锁隔离;`use shopping` → 回。**runner 自证到此为止。**
- **(b) 真·显示验收(Lead-run,非 runner 自证)**:真 `~/.claude.json` + 真身份(一次性采集后)+ 开真 claude → `/status` 显示 business(xrliAnnie.b@gmail.com)→ restore → 回 shopping。**/status only,零 completion 零额度**,Lead 亲验。

## 6. 一次性身份采集清单(696 enable 前运维步;Lead 协调 Annie,勿自己拉她)

前提:本 PR merge+部署。当前 `~/.claude.json` 只含 shopping 身份;4 profile 都要有 `oauthAccount.json` 才双向切换显示对。

| 账号 | 步骤 |
|------|------|
| shopping(当前 active) | `flywheel-claude-profile capture shopping`(身份已在 `.claude.json`,无需 login),核对回显 email=…shopping |
| business | claude `/login` → business → `capture business`,核对 email=xrliAnnie.b@gmail.com |
| personal | `/login` → personal → `capture personal`,核对 email |
| school | `/login` → school → `capture school`,核对 email |
| 收尾 | `flywheel-claude-profile use shopping`(现在**同时**恢复 shopping 显示身份)→ Annie 回日常账号 |

> **iso-login 免打扰?** capture 是 matched pair(同账号 Keychain token + `.claude.json` 身份一起抓,保证一致)。iso-login 把身份写 iso `.claude.json`、token 写 iso `.credentials.json`(不进 Keychain),而 capture 读**生产 Keychain** token → iso 身份 + 生产 token **错配**。免打扰采集需 **identity-only capture** 模式(token 已在池、只补身份)——**本 PR 不建**;若「逐个 login 临时切走 active」不可接受,再作小 follow-up。默认=上表生产 login 序列。

## 7. 已知限制
- **live-session clobber**:§2 observed low risk, **not reproduced**;§3 共享锁只序列化**遵守锁的** writer(inject/teardown/本脚本),**live claude session 不取锁** → 极窄 rename↔claude-write 竞窗仍在,由 post-write 复验(检测)+ Lead `/status` 终验兜底,归**已接受限制**。
- token↔身份一致靠采集纪律(login 后立即 capture)+ capture 回显 email 肉眼核对;token opaque 无法程序化校验。

## 8. 回滚
纯增量:revert 本 PR。无身份文件时行为语义等于现状(§3.8);启用显示切换=采集身份文件(§6),随时删 `oauthAccount.json` 退回旧行为。

## 9. Codex design review
R1 CHANGES REQUESTED(7 项)→ 本版全采纳/订正。重跑 R2 求 APPROVED 后再 TDD 实现。
