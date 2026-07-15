# FLY-1117 2026-07-09 全天故障链深挖 — 实施计划

Issue: FLY-1117 (https://linear.app/geoforge3d/issue/FLY-1117/forensics-2026-07-09-全天故障链深挖-1427-fleet-全灭-夜间-bridge-双杀攻击-or-系统性)
日期: 2026-07-10
基于: research.md（同文件夹；exploration.md 为其上游）
修订: R4（并入 Codex design review R1×9 + R2×5 + R3×4 全部意见；research.md 同步修正；R4 = APPROVED）

---

## 0. 范围与铁律

- **零生产代码改动**。交付物 = 取证结论文档 + founder 可读报告（**形态按 Step 9 授权分支**：获授权 = HTML 文件；未获授权 = 结构化素材包交 Lead 产投）+ 防复发建议（建单素材粒度）。防复发的落地实现归各自新单。
- **边界（精确版）**：取证**采集**命令一律只读（不重启服务、不杀进程、不写生产 DB——SQLite 拷贝后读或只读打开）。两类**明确允许的、事后可审计的 side effect**：① 报告/证据 commit 到本分支；② 经 `flywheel-comm ask` 与 Lead 的协调消息（会写 CommDB/inbox——这是设计内通信，不算破坏只读取证）。禁止：任何 kill/restart/launchctl 变更/生产配置写入/权限提升。命令因权限失败 = 记录 gap，不换提权姿势重试。
- **每个结论必须可从 `evidence/` 复推**；新取证一律先落 `evidence/` + 记入 `INDEX.md`（见 Step 0）+ 更新 `SHA256SUMS.txt` 再引用。
- 无 sudo/root；盲区（signal 发送者、历史网络连接、已滚掉的 launchd 日志、无 EDR/auditd）在报告中如实声明。
- design 阶段已完成：证据保全 + E1（中高置信）/E2（高置信）初判 + 攻击面初判（research.md）。**Implement = 收尾验证 + 收敛终判 + 产出报告**，不是从零调查；但初判若被新证据反驳必须推翻，不许护旧结论。

## Step 0 — 采集补全与 chain-of-custody（开工第一件事，易失性最高优先）

0a. **快照 Implement 还要读的全部原始输入**进 `evidence/`：7/9 全部 user 域 `.ips`（OrcaSlicer×17、BambuStudio、biome、node、chrome-headless-shell、Chrome）+ system 域可读的 node `.diag`；还需要的 bridge.log / cmux-watcher.log 片段；`/usr/local/bin/tmux` symlink 指向 + brew receipt + 二进制 SHA256；两个事故窗口如仍需 `log show` 的新导出（今天之内可得性最高，越拖越滚）。
0b. **建 `evidence/INDEX.md`**（机器可读表）：每件证据一行——source（原路径/命令）、exact command 或 predicate、collected_at（ISO+时区）、host/OS/tool version、raw/derived、derived-from、redaction 说明、SHA256。已有 13 件补录时 **fail-closed**：只有 design 阶段逐字留存的命令才可填 exact command;事后凭记忆/文档重构的一律标 `not contemporaneously recorded`（禁止补造 provenance）。
0c. **每项新查询保存完整 transcript**（stdout+stderr+exit code）到 `evidence/transcripts/`，QA 按 transcript 复核而不是信报告转述。
0d. **敏感数据最小化**：SSH key 只存 fingerprint；Discord/Linear/GitHub 导出只存与判定相关的最小字段（actor/time/action），不进原文私密内容；如必须保留敏感 raw → 本地 0600 固定路径 + evidence 里只记路径与 SHA256。
0e. 验收命令口径统一：`cd evidence/ && shasum -a 256 -c SHA256SUMS.txt`。

## Step 1 — E2 收尾（Bridge 六杀全景定案）

1a. **第 5 杀（21:35:23）触发者**：读 bridge.log 行 2256195–2264765 段尾 + health-log 21:30–21:36 top-RSS 逐分钟变化。**候选必须包含 21:34 health-log 已直接出现的 vitest 进程**（`node (vitest 9)` / `node (vitest 17)` 等——查它们属于谁：FLY-1082 QA 的窄范围测试? 其他 runner?），其次才是 OrcaSlicer/Chrome 残留。产出：`evidence/bridge-seg-211245-213524-tail.log.gz` + transcript + 结论段。允许「无法唯一指认」——不许硬编故事。
1b. **三组非看门狗重启定因**（13:09×2、14:40×2、21:03）：读各边界前 ~100 行找退出上下文。**双起（间隔 ~30s）的工作假设 = 首进程快速退出后由 launchd plist `ThrottleInterval=30` 节流 respawn**（不是 wrapper 自身重试——wrapper 无重试环）；须同时查首进程退出原因，不许只验证节流机制就结案。
1c. **六杀对齐表（机制/触发分列）**：watchdog forensic 行 ↔ wrapper 重启 ↔ launchd 记录（仅 23:29:59 有 launchd 存证，原因 = launchd 类目保留窗）。表分两列置信度：**self-kill 机制 = 高置信（有 forensic 行 + 同秒重启）**；**stall 触发者 = 逐刀独立标注**。两条源码级事实必须写对：① `scripts/flywheel-bridge-wrapper.sh` 用 `exec` 把 bash PID 替换为 Bridge 进程——launchd 观察到的 exit(137) 就是 Bridge 进程本体（不存在「wrapper 传播子进程退出码」）；② watchdog 的 forensic append 是 best-effort（异常被吞）——**「有行」是强正证据，「无行」不构成单独的绝对排除**（非看门狗重启的定因不得只靠 forensic log 缺行）。固定事故时刻的 deployed source SHA（`~/.flywheel/deployed-sha` + 生产 checkout git log）进证据。
1d. **FLY-1082 记录更正**：把 research.md §3 的两处更正（sql.js OOM 属 6 月底 / QA 报告 pid 与「内核 OOM」推测有误）经 `flywheel-comm ask` 报 Tadashi，由他决定是否回写 FLY-1082 文档（不越权改别人分支）。

## Step 2 — E1 收尾（tmux 死亡机制：从「候选机制」到「最佳解释」）

> 措辞红线：catchall 的 CAS appDeath 只证明「进程退出」，不含退出码/signal/发送者。若最终拿不到 tmux 的直接遗言，报告写**「与 OOM fatal 退出相容的最佳解释（无直接观测）」**，置信度不得因「源码存在该路径」而上调。

2a. **tmux 二进制取证**：`tmux -V`、`/usr/local/bin/tmux` symlink 实际指向、Homebrew receipt（含 Intel/ARM 架构）、二进制 SHA256、对应 3.5a tag 的 `xmalloc`/`fatal("out of memory")` 路径源码引用。全部进 evidence。
2b. **swap「16384MB 用 14815MB」出处考证**：grep 各 Lead/runner 会话记录、Discord、FLY-1082 文档链，找一手测量（谁、何时、`sysctl vm.swapusage`）。找不到 → 报告降级为「二手转述，无时间戳」。
2c. **代表性进程生命周期与退出语义复建**（从「身份抽样」升级）：滴漏侧与雪崩侧各抽 ≥5 个 LSASN → 切片内 CHECKIN 记录反查 pid → 进程/父进程/所属 runner 身份 → 首末记录时间 → 可得的 termination namespace/reason。目的：区分「长命 runner 进程死亡」vs「正常短命 worker 恰好退出」，说明抽样覆盖率与不可反查比例。同时在切片与新导出里搜 tmux server/socket 邻近的 exit/corpse/fd/allocation/shell 记录。
2d. **cmux-autostart 行为核对**：读 `~/.flywheel/bin/flywheel-cmux-autostart` 确认只建不杀 + 记录 14:27:44 重建的日志证据。脚本本体（或其 SHA + 关键行摘录）进 evidence。

## Step 3 — 嫌疑人矩阵（Linear 原单的硬要求，强制完成）

对 exploration §4.3 全清单逐个出具 alibi 行（**一项不许省**）：cmux-watcher/cmux-autostart、cmux-sync、com.flywheel.updater、bridge wrapper、skills-update、daily-standup、token-usage-daily、growth-* 定时任务、sub-* 定时任务、belle keepawake/daymode/nightmode、CleanMyMac scheduledScan + trashWatcher、cron daily-permission-learn、repo 内 restart-services.sh / test-deploy.sh（QA Room）/ crash-reaper / close-tmux/close-runner actions / FLY-887 keep-alive / FLY-873 watcher、FLY-1082 QA harness、xiaohongshu-deep-learning.qa528、chezmoi auto-sync、system-health-log（只读白名单也要列）。

每行五列：
1. **当时活跃证据**（两个事故窗口各答一次：自身日志/launchctl 状态/进程记录；拿不到运行时证据 → 标 **unknown**，不许用「label 已认领」顶替）；
2. **实际执行体**（脚本路径 + 当时部署 SHA/mtime——审当时的版本，不是今天的）;
3. **kill 命令清单与目标推导**（grep 全部 kill/pkill/kill-server/kill-session/kill-window/launchctl bootout 调用，静态推导目标集）；
4. **能否误中 default tmux server / Bridge**（socket/PID/pattern 匹配边界分析）；
5. **结论 + 置信度**。

产出：`forensics-report.md` 附录 A 完整矩阵 + evidence/transcripts 里的逐项 grep 记录。

## Step 4 — E3 分类（OrcaSlicer ~17 崩 + 伴随崩溃）

分类维度（替代粗三桶）：app/version/arch、exception type + termination namespace/reason、符号化 faulting-frame 签名、abort message、loaded images 与 code-signing provenance、同签名重复率、同分钟系统水位（health-log 对齐）。判定规则：
- **应用自身 bug**：同签名高重复（已知晚间簇多为近空地址 `EXC_BAD_ACCESS 0x0/0x4/0x8` 重复签名——预期主桶）。
- **资源压力**：必须有 allocation failure / `EXC_RESOURCE` / jetsam per-process 记录 / 同分钟水位互证——`vmSummary` 的 `MALLOC 3.0G` 是虚拟区域大小，**不是** malloc failure 证据。
- **注入/攻击旁证**：必须有未知 image、签名异常或其他独立 provenance 证据——「随机地址」不算。
时间相关性只作共现描述，不承担因果结论。产出：分类表 + 每桶代表性 .ips 指针。

## Step 5 — memorystatus/jetsam 语义分类与 macOS 行为查证

5a. **reason-code 分类表**（先于一切解读）：把全天导出里的每条 memorystatus/jetsam 记录按 {pressure kill / per-process-limit kill / idle exit（`MEMORY_IDLE_EXIT`）/ snapshot-only / not-memory-managed 声明} 分类 + 目标进程。已知实例必须正确归类：21:41 `ecosystemanalyticsd killed by jetsam reason per-process-limit`（**进程私限,不是全机压力**）、23:29 `MEMORY_IDLE_EXIT`、新 Bridge 的 `not memory-managed`。**21:41–23:59 簇只有 reason/目标/同分钟水位共同支持时才可作全机压力旁证**。
5b. **谓词覆盖范围验证**：负证据（「14:2x 无记录」）先验证导出 predicate 能覆盖 kernel kill 行的真实形态（用晚间已知记录做阳性对照；必要时补一次窄窗重导）。措辞红线：只可写「该窗口内本谓词无 memorystatus kill/快照记录」，不可写「内核没有杀任何东西」。
5c. **JetsamEvent 报告落盘条件**（web 查证 + 本机 7/6 样本对照）。**ReportCrash 行为查证是条件分支**：仅当 Step 2c 证明滴漏中的代表性进程属于 crash-eligible 异常退出（理应触发 crash reporting）时,才需要解释「~120 死亡仅个位数 .ips」;若 2c 显示多为 clean exit/正常短命进程,则记「不适用」——clean exit 本就不产生 .ips,缺报告不构成异常。
5d. **launchd 类目保留窗**：只读查询（`log config --status`，sandbox 拒绝则记 gap）+ 文档佐证；报告措辞为「本次观测到 ~1 小时级可得窗口」，**不写成已证明的固定保留策略**。

## Step 6 — 结论收敛 → `forensics-report.md`

- 完整时间线（research.md §2 骨架 + Step 0–5 增量修正）。
- 逐事件结论：凶手/机制/置信度/证据指针；E2 六杀表机制/触发分列（Step 1c）。
- **终判措辞**：攻击维度只可写「**未发现与这三起事件相关的外部入侵迹象**（置信度 + 依据 + 盲区）」——在无 EDR/auditd/历史连接记录的机器上不存在「证明无入侵」。资源/系统性维度按证据走向（design 阶段预期：资源容量危机主因 + by-design 看门狗自愈开火 + 无入侵迹象的复合结论），**出现反证必须推翻重写**。
- 直接回答 Annie 的三个原话问题（谁关了 runner / 是不是攻击 / 为什么感觉不像内存）。

## Step 7 — 攻击面收口（回答她最担心的，按「攻击路径 → 预期痕迹」矩阵）

矩阵行 = 攻击路径；列 = 预期痕迹 / 实际数据源 / 数据源保留窗与权限 preflight 结果 / 检查结果 / 负证据强度。至少覆盖：
- **本地/远程登录**：`last`——raw 全量输出落本地 0600 固定路径（不 commit）,evidence 只提交**脱敏最小表**（actor/时间/会话类型/来源类别）+ raw 路径与 SHA256 + redaction 记录进 INDEX;unified log sshd/screensharingd（design 已查全天 0 条,复核）+ **Remote Apple Events**、loginwindow 本地会话。
- **SSH 文件取证（必做,不许再漏）**：`~/.ssh/authorized_keys` 内容逐 key fingerprint + 文件 mtime + 每个 key 的来源认领;`~/.ssh/config` 内容 + mtime;key 文件清单与 mtime。`known_hosts` 只作**出站**历史辅证（不当入站证明）。原文不进 evidence,只进 fingerprint/mtime/认领表（Step 0d 脱敏规则）。
- **远程/覆盖网络入口**：SSH（`launchctl print-disabled system` 判 enabled 态 + passive listener 甄别——`state = not running` 不等于关闭）、Screen Sharing、**Tailscale、ExpressVPN、Chrome Remote Desktop broker、booster**——不只认领 job,要查 7/9 是否有会话/连接活动记录（各自日志,拿不到 → blind spot）。`systemsetup` 需管理员,直接标 gap 不试提权。
- **持久化**：launchd 双域逐 job 认领（含 plist mtime）、**cron、login items**、chezmoi `chezmoi diff` + git log 近 3 天、shell rc 文件 mtime。
- **两个事故窗口的新进程/二进制来源**：catchall 切片 + 新导出里 exec/CHECKIN 的二进制路径清单,非白名单路径单列。
- **账号面（token compromise 视角,不是 activity 视角）**：GitHub——**personal security log**（`gh api /user/audit-log` 不存在;安全日志主要在 Web UI,preflight 后拿得到多少记多少,拿不到 = blind spot;activity events 只作辅证并注明「actor 伪装局限」）;Linear——issue/comment actor 清单 + 异常 token 使用迹象（API 可得范围内）;Discord——bot 消息 author/时间清单（滥用 = 非预期频道/时段动作）。**明确写出这些数据源无法排除「同账号 token 被盗用且行为拟态」**。
- **3dcb1b94 scratchpad 深挖**：全盘找（`~/.claude/projects/*/`、`/private/tmp/claude-501/*/`、Bridge session 记录）;复核「runner 幻觉注入」证伪逻辑;找不到 → 如实记缺失 + 从 Linear/Discord 重建该事件结论。
- **现状基线**：`lsof -nP -iTCP -sTCP:LISTEN` 与当前连接分列快照（历史盲区声明）。

## Step 8 — 防复发建议（建单素材粒度）

**先固定 FLY-1082 四态**（commit / PR / merge / deploy），每格标 `as_of` 时间戳：截至本次 design review（2026-07-10 凌晨），FLY-1082 分支 HEAD=`f4bcd0bf`（author time 已晚于 23:29 事故）**尚未进入 origin/main、未部署激活**——QA PASS ≠ 已 ship ≠ 已激活；**事故时刻的生产 deployed SHA 是独立字段**，必须从当时记录取证（`~/.flywheel/deployed-sha` 历史 / 生产 checkout reflog），不得用任何分支当前 HEAD 代替。映射表按四态诚实分列：
- **已实现未部署（planned coverage）**：tmux_server_lost、bridge_abnormal_exit（wrapper 腿 + 外部心跳）、swap_pressure_high + pressure-hold——写「部署激活后理应覆盖本次三事件的检测」，**并核实 watchdog self-SIGKILL 是否会留 dirty-marker 触发 bridge_abnormal_exit 腿**（核实后才可写「已覆盖」）。
- **需新做（候选,Implement 定稿）**：① 看门狗开火 → fleet 告警/工单（当日 6 杀无人知晓;若上条核实已覆盖则并入左列）；② `system-health-log.sh` 增采 `sysctl vm.swapusage` + 修 `claude_agents=0` 计数 bug；③ **生产 host 禁跑全量测试套件**（Tadashi 已定,落协议文本 + 可能的护栏）；④ 关键 fleet 事件触发时同步抓 `log show` 窗口切片（launchd ~1h 可得窗教训）。
每条：问题 → 建议 → 归属（并入哪单/新单）→ 建单素材文本。**只产素材,不自建 issue**（founder 面建单一律经 Lead）。

## Step 9 — founder 可读报告（授权分支决定形态）

- **分支 A（获授权）**：`founder-report.html` committed 进分支;Apple 风浅色（html-report-style）、mobile-first、纯静态自包含（无外链/托管 CSP 兼容）。
- **分支 B（未获授权/被拒/无答复）**：`founder-report-materials.md` committed 进分支——结构化素材包（人话时间线、三问答案、结论卡文案、防复发一览,按可直接排版的粒度组织）,HTML 由 Lead 生成并投递;本分支下不产 HTML、Step 10 的 HTML 验收项自动替换为素材包完整性验收。
- 内容（两分支同源）= Step 6 人话版：一页时间线 + 三个问题的直接回答 + 「攻击?」结论卡 + 防复发一览。不带上游票号、不带工程黑话。
- **Ownership 例外必须在生产 HTML 之前拿到（前置授权,不是交付时补认）**：终裁规则默认 founder artifact 由 Lead 产+投;brainstorm gate 原文只确认了「素材经 ask 交 Tadashi 投递」,**没有**确认 Runner 可生产最终 founder artifact。因此 Step 9 的第一步 = `flywheel-comm ask` 显式请求「Runner 产 HTML 文件 / Lead 投递」的例外授权,**拿到明确肯定后才开始生成**;未获答复或被拒 → 默认 materials-only（Runner 只交结构化素材包,HTML 由 Lead 生成投递）。投递时可再确认,但不得把交付时确认当首次授权。本 Runner 任何情况下不 publish、不直发 founder。

## Step 10 — 验收口径（QA 阶段用）

1. `cd evidence/ && shasum -a 256 -c SHA256SUMS.txt` 全通过;INDEX.md 每行可对上实物。
2. 抽查复推：QA 独立从 watchdog log + restart-history 重建六杀对齐表;从 catchall 切片重建死亡曲线（123 滴漏 + 142 雪崩）——数字须与报告一致。
3. 嫌疑人矩阵：QA 抽 ≥3 行复跑其 grep/静态推导,结论一致。
4. 攻击面：QA 复跑矩阵中全部只读命令（按 evidence/transcripts 的原命令）,结果一致。
5. founder 交付物按 Step 9 实际分支验收：分支 A = HTML 真机渲染（Claude-in-Chrome,无外链请求、移动宽度可读）;分支 B = 素材包完整性（时间线/三问/结论卡/防复发四要素齐全、粒度可直接排版）。
6. 范围核验：`git merge-base origin/main HEAD` 起的 diff 只含 `engineering/doc/**` + `git status --porcelain` 干净;**再对照 acquisition transcripts 确认采集命令均为只读**（docs-only diff 不单独构成零触碰证明）。

## 11. 里程碑、时间盒与降级门

- 顺序：**Step 0（P0,先跑,尤其 .ips 快照与任何还要碰 log show 的导出）** → Step 1–5 + 7 并行 → Step 6 收敛 → Step 8/9 并行 → PR + Codex code review（文档单照常）→ approve gate。
- **时间盒**：P0 = Step 0 + 三起事件 verdict（Step 1/2/4/5 核心路径）+ 嫌疑人矩阵（Step 3）+ **Step 7 的本机攻击面核心**（本地/远程登录、SSH 文件取证、持久化、远程服务使用痕迹、事故窗口进程/二进制来源——攻击 verdict 在这些完成前不得收敛）;P1 = GitHub/Linear/Discord 账号面外部审计的权限受限深度、macOS 行为的网页考证深度、HTML 视觉打磨。超时降级规则：P1 项输出明确 **unknown/blind spot**,不许为赶工把「没查到」写成「不存在」,也不许压缩 P0 取证深度。
- 风险：unified log 继续滚动 → Step 0 开工即执行。
