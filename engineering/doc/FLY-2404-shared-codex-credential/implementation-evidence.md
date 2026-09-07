# FLY-2404 共享 Codex 凭据真身 — 实施证据
Issue: FLY-2404 (https://linear.app/geoforge3d/issue/FLY-2404/codex凭据-全机只用一份-codex-凭据runnerleadraya-的每个-codex-home-不再各存一份-authjson)
日期: 2026-09-06
基于: plan.md + design-correction.md

## 1. 交付结论

实现已把 Codex 凭据模型从「每个 home 一份可过期副本」改为「home 独立、`auth.json` 共享主机真身」：新 runner home 原子安装绝对 symlink；存量 runner / Lead home 只允许在排空、进程、launchd、lease 与 authority 栅栏全部通过后迁移；Raya 的潜在 home 进入统一探针，但在独立 Lead 批准前不进入 active managed set。

本节点没有做生产切换、没有重启 Bridge/Lead/Raya、没有触发真实凭据刷新，也没有读出、打印或提交 token。生产班车切换和「Lead/Raya 全绿一个班车周期」仍由后续 QA/运维节点执行。

## 2. 实现面

### 2.1 新 home 与存量迁移

- `codex-home.ts` 对主机真身执行 `lstat + O_NOFOLLOW + fstat`，要求绝对路径、普通文件、`0600`、可识别账号；新 home 用临时链接加 rename 原子安装 `auth.json`。
- 正确链接幂等通过；错误、悬空链接 fail closed；存量普通副本在 spawn 热路径维持既有复制行为但不改成链接，并写 `credential-copy-pending` 诊断。
- keyed home 迁移在同一 role 锁内复核 lease 与最终链接状态；legacy / Lead 迁移共享目录、进程、launchd 与真身身份栅栏；目录 fsync 落在不确定窗口时返回专用退出码 6。
- `link-missing` 依照设计修正进入 fenced repair：无活 lease/job/process 才恢复链接，锁内终验；活体场景保持零写入。
- `link-missing` 与显式 `--keep-backup` 组合时直接恢复链接且不伪造 backup；只有确实存在的普通凭据文件才进入 durable backup 路径。

### 2.2 班车切换与回滚

- `codex-credential-cutover.sh` 自持 admission pause lease，续租并等待 quiescence；切换前后各扫描一次 legacy 普通副本，逐个调用同一迁移原语，并在所有退出路径恢复自己持有的 pause。
- 崩溃恢复状态与 lease 绑定；损坏状态、未知 authority、排空超时、切换后残留均 fail closed。
- `resident-codex-lead-recover.sh --authority` 和三个生产 Lead launcher 均接入同一 helper；参数固定为 `--lead "$FLYWHEEL_PROJECT_NAME/$FLYWHEEL_LEAD_ID" "$CODEX_HOME"`，dry-run 分支无副作用。
- 依照 Lead 裁决，不提供无人值守 force-refresh。若 9 月 12 日前切换未落地，唯一受支持动作是 founder 在主机执行一次 `codex login`，再以真身元数据前进与有效期作为 gate。

### 2.3 健康、竞争与清理

- `codex-global-health` 增加共享凭据维度：真身结构/权限/JSON/JWT、新旧 home 链接状态、Lead authority、Raya 额外 home、keyed migration marker；探针 boot/tick 共用一个实例，瞬时不可解析要连续两 tick 才 severe，结构性错误立即 severe 并重置 debounce。
- 真身有效期以 Codex 实际刷新依据 `tokens.access_token.exp` 为准；旧格式缺失 access token 时才退回 `last_refresh + 10 天`，而格式错误的现存 access token 继续 fail closed。过期的短寿命 ID token 不再把仍然可用的共享凭据误报为 severe。
- `refresh_token_reused` 先由真身健康裁决：真身健康时只视为可能的良性竞争输家且最多重试一次，不轮换 profile；真身不健康才指向 founder 主机登录。usage/rate-limit 仍优先分类。
- `codex-home-credential-sweep.mjs` 默认仅 dry-run，以哈希化 chain 元数据盘点；apply 只删除 inactive legacy 普通副本与超过 7 天的有效 managed backup。删除前后复核全部 CommDB shard、Bridge session、进程、lease 与 authority，并以 fsync 后的 write-ahead receipt 记录 intent/applied/recovery。pause lease 的续租 POST 是 ownership proof；只读 `/health` 只需证明 pause active 与 Bridge uptime，不要求暴露私有 lease id。
- deploy 残留门把旧 `auth.json` 普通文件与 symlink 一并计入 slot residue，避免共享凭据 home 被误回收。

## 3. 验收证据

### 3.1 并发与真会话

设计阶段的可复核报告位于 `exploration.md` 第 4 节和 `exp-evidence/`：Codex CLI 0.153.2、N=6 个不同 `CODEX_HOME`、全部 `auth.json` 指向同一真身。wave B2 完成一次真实 refresh rotation，6 条链接保持、真身 inode/`0600` 保持，全部请求进入真会话且无 401；wave C 的严格假权威制造 1 个赢家与 5 个 `refresh_token_reused` 输家，6 个进程均从同一真身自愈，仍无 401。实验 driver 已标为 NON-PRODUCTION。

### 3.2 FLY-2404 定向测试

| 验证 | 结果 |
|---|---:|
| `codex-home.test.ts` | 157 passed |
| `CodexTmuxAdapter.test.ts` | 115 passed |
| `codex-global-health.test.ts` | 43 passed |
| account rotation notice | 6 passed |
| `codex-home-link-truth.test.sh` | 12 passed |
| `codex-credential-cutover.test.sh` | 5 passed |
| `codex-home-credential-sweep.test.sh` | 8 passed |
| Lead home / resident recovery / QA launchd / deploy residue focused suites | 190 passed, 1 environment skip |

新增 home 的链接形态、账号身份和真实 runtime 传递由 `codex-home.test.ts`、`CodexTmuxAdapter.test.ts` 及上述 N=6 真会话实验共同覆盖；迁移、回滚、活 lease/job/process 负例和 write-ahead 清理恢复均有可执行测试。

### 3.3 仓库门禁

- `pnpm lint`: 通过；仅报告仓库既有 14 条 warning。
- `pnpm -r build`: 通过，21/22 workspace projects 构建成功。
- CI shell-suite enumeration：285 支 root shell suites 全部显式分类；本单 3 支新增 suite 已加入 `Script Tests 3/5`，并同步固定在 `ci-structure` 的 shard inventory/order；本地 structure、enumeration 与三支 suite 均通过。
- 首轮 exact-head CI 让新 suite 真正在 Linux runner 上执行后暴露两处集成守卫：权限断言误用了 macOS `stat -f`，以及三个新 payload 脚本缺 packaged-path audit disposition。前者改为 Python `os.stat` 跨平台断言，后者补齐 operations-closure 审计行；`df76de120` 的 CI run `34084163431` 全绿。本轮评审修复后，本地 link-truth 12/12、package-onboard 28/28 通过；新精确 HEAD 的 CI 仍作为最终判定。
- `pnpm test:packages:run`: 按要求精确运行两次；本机 swap 压力下均在 `flywheel-comm` 提前停止，未调度到 `claude-runner`。Lead 已裁定本机全仓门今晚不可靠、不得扩张本单修改测试基础设施，最终全仓判定以 CI 为准；证据已写入 FLY-2406。

第一次精确运行：`FLY-1715: runner ask/check/gate/ack use ingest nudges without reading the disk master token` 的 5.0 秒门限在 5.85 秒触发；隔离运行 test body 1.22 秒通过。

第二次精确运行：

- 同一 FLY-1715 用例在 6.32 秒触发 5.0 秒门限；隔离 1.22 秒通过。
- `CLI > check > should output JSON with --json` 在 6.12 秒触发 5.0 秒门限；隔离筛选组通过。
- `qa-result.realgit` push rewrite 用例触发 5.0 秒门限；隔离 4.00 秒通过。
- mailbox terminal archive 用例在负载下返回 1 而非 2；隔离 31 ms 通过。
- runner-stop declaration race 在负载下返回 `stale/sent` 而非 `sent/sent`；隔离 638 ms 通过。

随后单独运行完整 `claude-runner` 包：1,098 passed / 2 skipped，另 5 个既有 shell/tmux 时间敏感用例因包内并发超时；这 5 个失败逐项隔离均通过（149 ms、17.13 s、32.69 s、3.43 s、1.37 s）。其中当时的本单关键矩阵 `codex-home` 155/155、`CodexTmuxAdapter` 115/115 均在完整包运行内通过；末轮 `link-missing + keepBackup` 修正后，`codex-home` 完整文件为 156/156。

### 3.4 代码评审修复

末轮跨家族评审在 `df76de120` 找到两项 HIGH：健康探针把短寿命 `id_token` 当成 Codex 凭据有效期，以及 sweep 要求 `/health` 暴露其契约中不存在的私有 lease id。两项均按真实协议修正并加回归测试：全伪造 JWT 交叉交换 ID/access 过期时间，证明只以 access token 判定；sweep fixture 使用真实 `/health` shape 成功，并让缺失 pause 契约明确报错、零写入且恢复 owned lease。四项 MEDIUM/LOW 建议也在同一批关闭：macOS Bash 3.2 空数组展开、迁移成功后报告落盘失败的独立退出语义、已链接 home 的幂等检查先于 `ps` 可执行检查、以及 fresh provision 链接失败时调用 `scrubOnFailure` 并隔离 `lstat` 的 ENOENT 分支。

随后 `1dc93f8c2` 的复审已 APPROVED，并留下一个由 access-token fallback 引入的 LOW：缺失/null/空 `tokens` 仍可能凭新鲜 `last_refresh` 报 healthy。Lead 将其升级为本轮必修；新参数化红测先证明四种损坏结构均误报，再收紧 fallback，要求存在结构可解析的 ID token。修复后首次 observation 为 `truth-unparseable` warning，连续第二次按既有 debounce 升为 severe，43/43 完整 health suite 通过。另一条部署顺序 advisory 作为 Lead 班车清单项处理：部署前设置 deadline，或在同一窗口内完成迁移。

## 4. 未在实现节点执行的生产验收

以下项目需要真实班车窗口和部署后观察，不能由 bounded implementation 节点冒充完成：

1. 用 owned-pause 切换批准的 runner / Lead homes，并在每个 home 运行真 `codex exec` smoke。
2. Raya 首次启用前取得独立 Lead 批准，再由同一 helper 建链接；不单独登录。
3. 观察 `codex-global-health` 至少一个完整班车周期，要求主机真身、已批准 Lead homes 与 Raya 均为绿；未批准 homes 保留 `copy-pending` 和 deadline 处置记录。
4. 先 dry-run 审阅 legacy chain 盘点，再另开 apply 窗口执行保守清理。

## 5. 安全复核

- 代码、测试输出与文档均未包含真实 token；盘点与报告只输出计数、状态、路径类别及不可逆摘要。
- 没有修改 Claude 侧账号轮换生产逻辑；仅把一个测试矩阵的 bounded timeout 从 45 秒调至 60 秒，为其两个串行切换分支保留 CI 余量。
- 没有修改 merge/authority，也没有部署、合并或推送 main。
