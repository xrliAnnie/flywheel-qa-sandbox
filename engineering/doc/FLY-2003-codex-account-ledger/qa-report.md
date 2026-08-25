# FLY-2003 账号台账 — 独立 QA 报告（DAG qa 节点，attempt 1）
Issue: FLY-2003 (https://linear.app/geoforge3d/issue/FLY-2003/账号台账-codex-接号器整理三号对齐身份自动记账杜绝错账)
日期: 2026-08-25
基于: plan.md、qa-evidence.md（实现侧证据，本报告独立复核而非引用）

## 裁定

**FAIL** — 两个同一缺陷类的 MEDIUM 问题：**派生的 ledger 层可以推翻 / 摧毁身份真相层**，两处都发生在 Founder 亲手用的 CLI 上，两处都与已批准 plan 的明文约束相反，而同一个缺陷类在本 PR 里已经为 `status` 和 `provision` 修过一次（`use` / `save` / `list` 漏了）。

被测 head：`e314e00ddbcade37724e325add20a0a1f539b34d`（`git ls-remote origin flywheel-FLY-2003` 与本地 HEAD 一致；PR #945 `headRefOid` 同值，OPEN / 非 draft / MERGEABLE）。
`2d7e6a8ee..HEAD` 只有两个 docs 文件变化，**零代码变化** —— 因此实现侧 529 证据的代码 SHA 与本轮被测 head 等价。

---

## 一、先说结论以外的好消息：核心需求已交付

以下九条全部由我**独立实跑**验证（真实 CLI / 真实 API / 真实生产凭据只读），不是复述实现侧证据。

| plan 验收 | 结论 | 证据 |
|---|---|---|
| 1. registry 只有 school/personal/business，personal 为 primary | ✅ | `list` 固定三行；`personal1` 被列为 `Untracked`；`discoverAccountPool` 返回 `[business, personal, school]` |
| 2. `status` 由 live JWT 得真身份，不含 token | ✅ | sidecar=school + auth=personal → 输出 `Actual profile: personal` + `Sidecar hint: school (DRIFT)`；human 输出 email 打码 `x***@gmail.com`；`--json` 无 `id_token/access_token/refresh_token` |
| 3. `use`/`save` 写前校验 label↔identity；home 显式绑定 | ✅ | pool/business 放 personal 凭据 → `use business` 拒绝，home auth.json SHA256 逐字节不变、`.active` 不变 |
| 4. runner birth 前 fail-closed | ✅ | 见下表 D1–D9 |
| 5. status/use/save/provision 成功后写 ledger snapshot | ✅ | 四种 `lastSource` 都实测落盘，文件 mode 0600 |
| 6. `next` 与两个 fallback 的自动轮换退役 | ✅ | 见下表 E0–E3 |
| 7. guard installer 原子收敛 | ✅ | `scripts/__tests__/codex-guard.test.sh` 独立复跑 **44/44 passed=44 failed=0** |
| 8. 不新增 quota warning/monitor/Bridge event | ✅ | diff 中无新增 Discord/Bridge/alert 代码（见第三节） |
| 9. Claude 侧不变 | ✅ | diff 未触碰 Claude quota daemon / registry |

### runner birth preflight（真实 `dist` API，非 mock）

| 用例 | 期望 | 实测 |
|---|---|---|
| D1 source=personal | 通过 | `profile=personal mode=primary` |
| D2 source=business | 通过并标 manual backup | `mode=manual_backup` + 日志 `manual_backup_active profile=business` |
| D3 source=personal1（未登记） | 抛错 | `unknown Codex account identity: x***@gmail.com` |
| D4 source=zombie（personal2 邮箱） | 抛错 | 同上 |
| D5 source 缺失 | 抛错 | `Codex source auth is unavailable at …` |
| D6 `discoverAccountPool` | 排除 personal1 | `[business, personal, school]` |
| D7 `provisionCodexHome`(unknown) | 抛错 + **零残留** | 抛错，`homes-bad/` 目录列表为 `[]` |
| D8 `provisionCodexHome`(business) | 完整 home + ledger | `[.active, AGENTS.md, auth.json, config.toml]`；`.active=business`；auth 与源逐字节相同；config.toml 含 gh token；ledger `lastSource=provision`，**snapshot 不含任何 token 串** |
| D9 预先存在 home + unknown source | 不覆盖 | 抛错，预置哨兵 `PRE_EXISTING_SENTINEL` 原样保留 |

### 生产就绪（**只读**，零生产写入）

用本分支 shipped core 只读解析真实生产路径：

```
~/.codex (live source): profile=personal  plan=pro      mode=primary       sidecar=personal
pool/school           : profile=school    plan=pro      mode=manual_backup
pool/personal         : profile=personal  plan=pro      mode=primary
pool/business         : profile=business  plan=prolite  mode=manual_backup
pool/personal1        : REJECTED -> unknown Codex account identity
pool/personal2        : REJECTED -> unknown Codex account identity
```

再用**真实生产 `~/.codex` 作为 source**（目的地与 ledger 全部隔离）跑一次真实 `provisionCodexHome`：preflight 通过，产出完整 home，auth 与生产源逐字节相同、mode 600、`.active=personal`、ledger `personal.json` 正确且无 token。

→ **这是实现侧证据里缺的那个阳性对照**：qa-evidence.md 的 529 A 段只证明了「坏 source 会 fail-closed」，没有人证明过「真 Codex runner 在新 preflight 下还能正常出生」。现在证明了：部署后不会全舰 fail-closed。

生产 `~/.codex/auth.json`、`.active`、五个 pool `auth.json` 的 mtime 在全部测试前后**逐个未变**；`~/.flywheel/codex-account-ledger` 至今**不存在**（未被我创建）。

### 自动轮换退役（真实脚本 + 插桩）

| 用例 | 实测 |
|---|---|
| E0 阳性对照（证明我的插桩尺子有效） | 直接调 stub → 日志记下 `PROFILE_CALLED next` |
| E1 真 429 | `scripts/codex-with-fallback.sh` 退出 1，打印 `RATE_LIMIT on the selected account…`，`codex-profile`/`flywheel-comm` 调用日志 **0 行** |
| E2 `refresh_token_reused` | 退出 3（原样透传），`AUTH_EXPIRED on the selected account…`，profile 调用 **0 行** |
| E3 model unsupported | codex 被调 2 次：`exec -m gpt-9 probe` → `-m gpt-5.5 exec probe`，**同账号**，profile 调用 **0 行** |
| `next` 子命令 | 退出 2 + `Automatic Codex account switching is retired.` |

---

## 二、FAIL 依据

### F1（MEDIUM）`use` / `save`：ledger 写失败会把**已经成功**的切号报成失败

**复现**（真实 CLI）：把 ledger root 设为不可写目录后执行 `use school`。

```
Error: EACCES: permission denied, mkdir '…/rostate/codex-account-ledger'
exit=2
# 但随后 status 显示：
Actual profile: school
sidecar=school
```

凭据**已经换成 school**（auth.json + `.active` 都变了），但操作者只看到一个 `Error:` 和退出码 2，**没有任何成功行**。

- 危害正是本 issue 要消灭的那件事：人脑里的账错了。Annie 敲 `codex-profile use business` 看到报错，合理地认为自己还在 personal，实际已在 business。
- 与已批准 plan 相悖：Task 3 GREEN 写的是「失败只输出无秘密诊断」；Task 3 RED 写的是「ledger 不覆盖 live identity authority」。
- **同一 PR 内已经为 `status` 修过这个类**（qa-evidence.md 自述修了「`status` 在 ledger 不可写时丢失身份输出」），`provision` 也有 try/catch —— 只有 `use` / `save` 漏了。
- 代码位置：`packages/claude-runner/bin/flywheel-codex-profile.mjs` 的 `use()` 与 `save()` 里，`recordCodexAccountObservation(...)` 在 `atomicWrite` **之后**且**无 try/catch**，且在 `console.log` 成功行**之前**。

### F2（MEDIUM）`list`：一个损坏的 ledger snapshot 会摧毁整个三号健康视图

**复现**（真实 CLI）：

```
# 阳性对照（健康时）
school: ready (manual_backup) / personal: ready (primary) / business: ready (manual_backup) / Untracked: personal1   exit=0

# 把 business.json 写成非法 JSON（或截断成半个 JSON）后：
Error: Codex account ledger snapshot is not valid JSON
exit=2
```

- 一个**派生缓存**坏掉，就让操作者拿不到「我这三个号现在哪个是好的」——这正是 Founder 问的那个问题。
- 错误消息既没说是哪个 profile 的 snapshot，也没给路径，恢复只能靠猜。
- `status` 在同样条件下正常（它的 ledger 调用在 try/catch 里且在输出之后），所以这是 `list` 单独的实现疏漏，不是设计取舍。
- 代码位置：`flywheel-codex-profile.mjs` 的 `list()`，`readCodexAccountSnapshot(...)` 被放在 per-profile `try { … } catch { … }` 的**外面**。

**建议修法**（两处都很小，且 plan 已规定该行为）：把 `use`/`save` 的 ledger 写、`list` 的 ledger 读都降级为 best-effort（同 `status` 的 `console.warn` 形态），并在 warn 里带上 profile 名与 ledger 路径；`list` 对读失败的 profile 把 `lastObservation` 记为 `null` 并在该行标注 `ledger unreadable`，而不是整条命令退出。补两个 RED 测试钉住：`use` 在 ledger 不可写时**必须**打印成功行且退出 0；`list` 在单个 snapshot 损坏时**必须**仍列出三号 live health。

---

## 三、529 / Discord 覆盖面 —— 明确说明，不是静默跳过

**本 diff 没有 N-to-N Discord surface。** 逐项核对：

- Discord **send / relay**（Runner↔Lead↔founder）：diff 内**零新增**。唯一 Discord 相关变化是**删除**了 per-runner fallback shim 里的 `notify_rotation` / `rotate_and_notify`（`account_rotation` 事件的自动 caller）。`flywheel-comm account-rotation-notify` 与 Bridge `account_rotation` route 本身**未改动**，保留为人工 incident surface。
- **render**（thread title / badge / pinned header / status line）：零触碰。
- **founder interaction**（approve / ship / gate Q&A）：零触碰。
- **roundtable / 跨 Lead 协调**：零触碰。

所以本轮 QA 没有在 529 房重放 N-to-N 拓扑。取而代之，我对**唯一真实变化的 Discord 语义**（「429 不再自动发轮转告警」）做了确定性验证，三条互相独立：

1. 源码层：`scripts/codex-with-fallback.sh` 与 `packages/claude-runner/bin/flywheel-codex-with-fallback` 中 `codex-profile next|use` / `account-rotation-notify` 的 caller 数为 0。
2. 静态门：`codex-guard.test.sh` 的 `Codex fallback sources contain no automatic profile or rotation notifier caller` 在我的复跑中通过（44/44）。
3. 行为层：真实 429 / auth-expired / model-unsupported 三条路径实跑，插桩日志 0 行，且插桩本身有阳性对照（E0）。

**诚实边界**：我没有在隔离 Discord 频道里观察「不出现轮转消息」。理由是该断言是「缺席」，而缺席的强证据是「代码里没有 caller」而不是「我看了一会儿没看到」；上面三条已经从三个独立角度证明了没有 caller。实现侧 qa-evidence.md 记录了同 SHA 下一次真实隔离 Discord 正向投递（message id `1541839185357307984`）——那是**他们的**证据，我未复核，也不把它计入本报告的裁定依据。

另：**尝试起 529 房前我已核对 slot 占用** —— slot 1 与 slot 4 当前被另一场 `fly1189-1787677490-slot1` campaign 持有（bridge.log 活跃），我没有触碰这两个 slot，也没有起新 slot。

## 四、自动化验证（我本机复跑）

- 定向 5 文件：`codex-account-identity` / `codex-account-ledger` / `codex-shim` / `codex-home` / `CodexTmuxAdapter` → **201/201 通过**。
- `bash scripts/__tests__/codex-guard.test.sh` → **44/44，failed=0**。
- **PR #945 GitHub CI 在精确 head `e314e00dd` 全绿**（run `32873366187`，conclusion=success，11/11 check 通过，含 Quick Gate / Unit heavy+light / teamlead 1–3 / Script Tests 1–2 / NPM payload）。这是 clean-machine 的权威全库证据。
- 本机 `claude-runner` 整包首轮有 8 个失败：**已逐个归因为宿主环境，不是本 diff 回归**。根因是本 runner pane 的 `TMPDIR` 为 89 字符，daemon socket 路径达 116 字节 > `SUN_LEN` 103。以 `TMPDIR=/tmp` 隔离复跑：`codex-daemon-runtime.test.ts` **55/55 通过**，`runner-env-isolation.real-tmux.test.ts` + `prompt-overflow.real-tmux.test.ts` **3/3 通过**。

## 五、非阻塞 advisory（PR 范围之外，但必须进部署清单）

`~/.claude/rules/codex-multi-account.md` 是**全局规则文件，注入每个 agent 的每次会话**，它现在仍然写着：

- **五个** profile（含 `personal1` / `personal2` 及其邮箱）；
- 「On rate limit … auto-switches to the next profile via `codex-profile next` and retries」；
- school / business 的 plan 标为 `Plus`，而 live JWT 实测是 `pro` / `prolite`。

`~/.claude/skills/codex-image/SKILL.md` 同样写着「`codex-with-fallback` auto-rotates across 5 ChatGPT profiles」「Do NOT retry … already tried all accounts」。

部署这个 PR 之后，这两处会变成 Founder 抱怨的那个「记的都是错的」本体：每个 agent 都会相信限速会自愈，因而**不会向 Founder 升级**；`codex-profile next` 也会直接报错。这两个文件在仓库外，本 PR 改不了，但 plan §回滚与部署说明里也**没有列出它们**。建议 Tadashi 把「更新全局规则文件 + codex-image skill 文案」写进本单的部署步骤（或立即开 follow-up）。

## 六、环境与副作用

- 全部沙箱在 `…/scratchpad/qa2003/`，未写入任何生产路径。
- 未起 529 slot、未起隔离 Bridge、未发任何 Discord 消息、未碰 slot 1 / slot 4。
- 生产 `~/.codex/auth.json`、`~/.codex/.active`、五个 pool `auth.json` mtime 前后逐个未变；`~/.flywheel/codex-account-ledger` 未被创建。
- 未运行 `install-codex-guard.sh` 到真实 `$HOME`，未 `request-restart.sh`，未 `restart-services.sh`，未 merge / 未请求 ship。
