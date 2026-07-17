# FLY-1319 founder 本地时区 — QA 报告

Issue: FLY-1319
日期: 2026-07-16
基于: plan.md
PR: #625 @ `bda84f93a2c2577a4c5ea550d93e51e89eaa5594`
判定: **FAIL**(核心功能通过;2 个缺陷需 implement 阶段修,均为机械修复)

---

## 一句话

核心承诺**真的成立** —— `founder-time` 在真机上给出的时间和 Annie 的 Mac **逐分钟一致**(`2026-07-16 21:52 PDT`),travel 覆盖也真的会动。但这一版**打红了 2 个原本绿的测试**(CI 看不见),另有一条规则里给所有 Lead 的「权威命令」对 Mufasa 是**静默空转**。

## 验收对照(plan §5)

| 验收项 | 结果 | 证据 |
|---|---|---|
| `founder-time` == host date 同分钟 + PDT 标注 | ✅ PASS | host `2026-07-16 21:52 PDT` vs CLI `2026-07-16 21:52 PDT — America/Los_Angeles (UTC-07:00)` |
| 注入 `Asia/Tokyo` 对照翻转(阳性对照) | ✅ PASS | `tz:Asia/Tokyo offsetMinutes:540`;Kolkata `+330`(半小时时区 + 东正西负都对) |
| 非法 env → 告警 + 降级不崩 | ✅ PASS | 打印 `Ignoring invalid FLYWHEEL_FOUNDER_TZ="Not/AZone"` 后仍输出 PDT,exit 0 |
| 规则装载进生产 Mufasa(fullaccess) | ✅ PASS | `run-codex-lead-mufasa-tui-fullaccess.test.sh` 15/0,含「baseInstructions contain founder-local rule body」(测正文非文件名) |
| PR-B(fork `founder_local` 属性) | ✅ 存在 | fork PR #14 OPEN `2c10497d`,MERGEABLE/CLEAN,含真断言测试;`ts=` 值未 mutate(只改 instructions 文案) |
| CI | ✅ PASS | run 29554856733 @ **PR head 逐字一致** `bda84f93a`,`pnpm test:packages:run` 绿 |

## 我跑的测试

| 套件 | 结果 |
|---|---|
| flywheel-config 全量 | 459/459 ✅ |
| flywheel-comm founder-time + cli | 45/45 ✅ |
| edge-worker PromptBuilder.founder-time | 3/3 ✅ |
| teamlead 消费者 9 套(digest/standup/MetaAlert/deferred-approval/CodexDiscordGateway/RestPoll/lead-rules-bundle/tui-window) | 266/266 ✅ |
| `lead-alert-founder-timezone.test.sh` | 10/10 ✅(含 copy 式 `/etc/localtime` + 非法 link 降级) |
| `codex-lead-runtime.test.ts` | 114/114 ✅(见下「环境性假失败」) |
| biome lint(4 个改动文件) | clean ✅ |

**环境性假失败(非 PR 缺陷,已证)**:`codex-lead-runtime.test.ts` 在我的会话里 22 个失败,根因是 QA 会话的 `TMPDIR` 落在 `~/.flywheel` 下,触发测试自带的 overlap 守卫。换干净 `TMPDIR=/tmp/qa1319-tmp` 后 **114/114 全绿**。本仓 `packages/teamlead` 本地 `tsc` 的 `src/index.ts(77,35)` TS7006 同样是既存/worktree 现象:**FLY-1319 根本没碰这个文件**(`git diff --stat` 空),且 CI 在同一 head 上构建通过。

---

## 缺陷 1(应修)· FLY-1319 打红了 2 个原本绿的测试,CI 看不见

`packages/teamlead/scripts/__tests__/run-codex-lead-mufasa-tui.test.sh`

**基线对照(铁证)**:
- pre-FLY-1319 `4f8f8a710`(独立 worktree 实跑):**20 passed, 0 failed**
- FLY-1319 head `bda84f93a`:**20 passed, 2 failed**

**根因**:两处断言是 glob 尾匹配,要求契约列表**以** `companion-safety-contract.md` **结尾**:
```bash
:151  case "$spf" in *companion-safety-contract.md) pass "default → companion contract (byte-compat)" ;;
:174  case "$spf" in *companion-safety-contract.md) pass "hostile ambient still loads companion contract" ;;
```
本 PR 在 `run-codex-lead-mufasa-tui.sh:129-130` 往列表**尾部追加**了 `founder-local-time.md` → 尾匹配不再命中 → 两条 byte-compat 断言红。

**launcher 行为本身是对的**(规则就该装载,同 PR 新增的正文断言也确实绿了);**是断言陈旧没跟着更新** —— 同一批别的测试更新了,这两条漏了。

**为什么 CI 绿**:`ci.yml` 在 `packages/teamlead/scripts/__tests__/` 下**只跑 `adapter-reap.test.sh`**,不跑这个套件。所以这条红线不会被 CI 拦住,只会在有人本地跑时炸——正是 Mufasa 回滚路径的 byte-compat 守卫失去意义的方式。

**修**:把这两条断言更新成与新契约列表一致(同 PR 对其它断言已做的那样)。

---

## 缺陷 2(应修,MEDIUM)· 规则给 Mufasa 的「权威命令」是静默空转

`packages/teamlead/lead-rules-base/founder-local-time.md` 第 3 条要求**所有** Lead:
> run `node "$FLYWHEEL_COMM_CLI" founder-time` … **Treat that command as the authority.**

规则经 `compute_lead_rule_bundle()` 装进 **companion**(含 Mufasa,plan §A3 自己写明「Belle/Mufasa 最常聊作息」才特意装的)。

**真机核实**:Mufasa 活进程(pid 771, `codex-lead-tui-runtime.js`)env 里**没有** `FLYWHEEL_COMM_CLI`。
- **阳性对照(证明尺子没坏)**:同一条 `ps eww` 对 771 能读出 **106 个** env 变量 —— 不是读不到,是真没有。
- **对照组**:Claude Lead pane **有**(`claude-lead.sh:1413` 注入;实测 sub-lead pane = `FLYWHEEL_COMM_CLI=/Users/…/flywheel-comm/dist/index.js`)。
- 三个 Mufasa launcher 都不设它;`~/.flywheel/.env` 也没有。`codex-lead-runtime.ts:388` 的 allowlist 只放行**已存在**的变量,不会凭空造。

**失败形态最坏的那种 —— 静默**:变量未设时 `node "" founder-time` → **exit 0、stdout 空、stderr 空**。Mufasa 照规则跑「权威命令」,拿到**什么都没有**,然后只能退回凭 UTC 猜 —— 正是本单要根除的那个 bug。

**范围诚实**:Mufasa 不是全瞎 —— F6 给它每条入站消息加了 `[sent … PDT — founder 当前时区渲染]` 前缀,所以它仍有一个 founder-local 信号源。Claude Lead(HL 今天犯 3 次错的那条路径)完全不受影响。故列 MEDIUM 而非 blocker。

**修(任一)**:① 三个 Mufasa launcher 导出 `FLYWHEEL_COMM_CLI`(runtime allowlist 已放行,是最小改动);或 ② 规则文本按角色分叉,companion 段不给这条 CLI 命令、改指 `[sent …]` 前缀。

---

## 未做 / 边界(诚实声明)

- **没有真改机器时区**验证「travel ≤60s 自动跟随」—— 那是对 Annie 生产 Mac 的破坏性动作。已覆盖的替代证据:CLI 每次新进程必现读 `/etc/localtime`(A1 实测);TTL/翻转由 resolver 注入式单测覆盖;`lead-alert.sh` 的 10/10 覆盖 mac/linux/relative/copy 四种 localtime 形态。**长驻进程(Bridge)的 60s TTL 真机翻转仍未经真机证明**,留给重启窗后的部署验收。
- **行为级(plan §5.3「晚间发消息不再劝睡」)未验** —— 需 Bridge/Lead 重启后才生效,属部署后验收,不在本 PR 的 pre-ship 范围。
- 本地全量 teamlead suite 有 142 file / 26 test 失败,但 **CI 在同一 head 跑 `pnpm test:packages:run` 全绿** —— 判为本地高负载 + worktree 未完整 build 的噪声,以 CI 为准。

## 复现

```bash
pnpm --filter flywheel-config --filter flywheel-comm build
bash engineering/doc/FLY-1319-founder-local-timezone/qa/qa-fly-1319-verify.sh
# 期望:A1-A4 PASS(核心功能);B1/B2 FAIL(即上面两个缺陷)
```
两把尺子都做过突变验证:A1 喂「说谎的 resolver」(强制 Tokyo)能正确报红;B2 在 pre-FLY-1319 基线上是绿的 —— 证明它量的是本 PR 的改动,不是一把坏尺子。

---

# 附录 · Lead scope 指令补测(round 2)

Tadashi 点名的 ①②③④ 四项。②(founder-time 输出 current local)round 1 已覆盖;③④ 是 round 1 的**真实缺口**,现补。
复现:`node engineering/doc/FLY-1319-founder-local-timezone/qa/qa-fly-1319-scope-checks.mjs`(9/9 PASS)

## ① resolveFounderTimezone() 解析顺序 —— 逐层证明(5/5)

| 层 | 断言 | 结果 |
|---|---|---|
| env 显式 IANA | `FLYWHEEL_FOUNDER_TZ=Asia/Tokyo` 赢过 host | ✅ |
| auto=host readlink | 无 env → `/usr/share/zoneinfo/Europe/Berlin` → Berlin | ✅ |
| **Intl 兜底(round 1 漏测)** | readlink 抛错 → 取 Intl=Tokyo,**不是**直接掉 LA | ✅ |
| 最终兜底 | readlink 抛错 + Intl undefined → LA | ✅ |
| **阳性对照** | 设错值 `Not/AZone` → 被拒 + warn **恰一次** → 降级 host | ✅ |

## ③ 字节兼容(2 面,各带阳性对照)

- **founderMsgClock**:显式 LA 仍输出老形态 `HH:MM`(实测 `09:58`);阳性对照换 Tokyo → `01:58` 会变 → 尺子是活的,不是常量。
- **FLYWHEEL_DIGEST_TZ 显式 env 仍赢**:同一 instant `2026-07-17T05:30Z`,显式 `tz:"Asia/Tokyo"`(常量字符串形态)→ `defaultDay=2026-07-16`;auto provider(LA)→ `2026-07-15`。**两者给出不同 civil day**,证明显式 env 确实压过 auto 且永不跟随 host。

## ④ 两个 R3 MEDIUM 的回归证据

**④a lead-alert.sh 拒 zoneinfo 目录** —— 实现是 `[ -f "${root%/}/${candidate}" ]`(文件而非 `-e`):

| 输入 | 期望 | 结果 |
|---|---|---|
| `America/Los_Angeles`(真 zone **文件**) | 接受(阳性对照) | ✅ |
| `America`(真 zoneinfo **目录** = R3 那个坑) | 拒 | ✅ |
| `../etc/passwd` / `/etc/passwd` | 拒 | ✅ |
| `Not/AZone` | 拒 | ✅ |

**突变验证**:把 `-f` 换成 `-e` → `America` 目录**立刻被误接受** → 证明 `-f` 正是那道闸,断言非空过。

> ⚠️ **过程教训(值得记):** 这条我第一次跑时**阳性对照就挂了** —— 真 zone 文件也被拒。原因有二,都是我的尺子坏了不是代码坏了:(1) `sed` 抽函数时范围 `/^}/` 撞上 `${root%/}` 里的 `}`,函数被截断;(2) 我在 **zsh** 里 source 一个 **bash** 函数,zsh 默认不对未加引号的参数展开做分词,`for root in ${VAR:-a:b}` 的 IFS 分割行为不同。**改用真 bash 后阳性对照才命中**。若当时只看「America 被拒 = PASS」不看阳性对照,就会拿一把坏尺子发 PASS。

**④b full-access Codex env 保留 `FLYWHEEL_FOUNDER_TZ`** —— `codex-lead-runtime.ts:389` 在 allowlist 内;测试「keeps the allowlisted Claude-pane vars + gh auth, drops everything else」实跑 **12 passed**,同一断言里 `FLYWHEEL_FOUNDER_TZ` 保留、而 `FLYWHEEL_API_TOKEN`/`VERCEL_TOKEN`/`AWS_SECRET_ACCESS_KEY` 全被 drop(不是只测名字在列表里)。

## ⚠️ restart-gated(明确标注:**没有**真机验过)

按 Lead 要求不假装:**Bridge 把 founder TZ 注入 Lead 上下文这一段是 restart-gated,本轮只做了代码级验证(resolver/CLI/parity/字节兼容)。live injection 未经真机证明**,要等重启窗后验收。同样未验的还有长驻 Bridge 的 60s TTL 真机翻转、以及行为级验收(晚间不再劝睡)。

## head 漂移提示(给 Lead)

R3 跨家族审是在 `bda84f93a` 上做的;我的 QA 文档 commit 已把 PR head 推到 `424a75c46` → 再到本次附录 commit。**codex review record 绑的是旧 head**。因为现在是 FAIL 状态、implement 还要在同一分支推修复 commit,最终仍需在**修复后的最终 head** 上跑一次增量 Codex re-review 再开 ship gate,否则 verify-approval 会绑到一个不存在的 head(FLY-921/945 那个坑)。
