# FLY-2146 记忆定时真同步 — 设计修正
Issue: FLY-2146 (https://linear.app/geoforge3d/issue/FLY-2146/2132a2-记忆定时真同步以远端上有没有为准-连续多日新鲜度验证)
日期: 2026-09-04
基于: plan.md(blob `83cbd495a7602a7d8dd1a29940961dcfb2fd1075`) · exact-blob R5 finding `shared-index-no-mutex-wedge` · Lead gate `c97bc230-bfb2-46f5-81a2-097698b31228`

## 1. 权威与适用范围

本文件是实施节点收到的 Lead 增量治理修正。`plan.md` 的已批准 blob 不改;实施与复审必须把两份文件一起读。本文件只替换下列条款:

1. C1/C2 的共享 Git index 并发、`foreign-staged`、`index-dirty` 与对应退出/恢复合同;
2. C1/C3 的 pending/structural 路径分类;
3. C4 `--freeze` 的 D 日树前置与专用标记文件;
4. C5 的 CI 分片预算、五套/六条笔误、converge 引用路径;
5. C6 的临时 label census 说明与睡眠补跑验收口径。

其余全部保留,特别是:到达只由终结器重新执行的 `ls-remote` 决定;每个 Lead 夹一提交;A1 guard/gitleaks/审计全跑;远端观察只认 `schedule/main/completed/success/attempt==1`;D1–D3 两次内容转换;两阶段验收;不碰 chezmoi 的 123 次积压。

## 2. 废止项

- **废止**「单纯使用私有 `GIT_INDEX_FILE`」方案。实施节点已在一次性 clone 证明:私有 index 提交移动 HEAD 后,普通/default index 会把刚提交路径显示为反向 staged;它只是把原竞态换成 HEAD/default-index 漂移。
- **废止** writer 预检要求 default index 全局为空。
- **废止**并发跨夹暂存触发 `foreign-staged` exit 8 且不 reset 的合同。
- **废止**因 default index 已有别人的合法暂存而每小时重复 `index-dirty` exit 6 的合同。
- **废止** `plan.md:273` 把所有 exit 8 都说成「下一轮预检自动接手」的恢复承诺。
- **废止**把五套新 bash 测试继续塞进已经按 660s 配平的 Script Tests 4/4。

## 3. 共享 writer 锁与显式路径提交

### 3.1 唯一锁

- 固定锁文件:`<lead-memory-repo>/.git/flywheel-writer.lock`。
- 固定实现:`/usr/bin/lockf -k -s -t 60`。`-k` 保留同一 inode,避免 unlink/recreate 破坏锁序;BSD advisory lock 随持有进程死亡由内核释放,磁盘上的锁文件不是「仍被占用」证据,不需要陈锁回收协议。
- `sync.sh` 和 A1 官方普通 Lead 写入口在任何 fetch/rebase/add/commit/push 前取得同一把锁,并持有到本次仓写序列全部结束。锁内仍保留原来的 sync state/receipt 证据逻辑。
- 60s 内取不到共享 writer 锁时不做任何 git mutation/远端 git 操作,记一次可重试的 lock-timeout 失败;下一小时自动重试。原 plan 里的其他预检失败码保持不变。manifest 必须把这个已定义结局列入允许集合,避免把正常有界竞争伪装成未知退出。
- `/usr/bin/lockf` 缺失、不是普通可执行文件或无法创建固定锁文件属于 fail-closed preflight,不是 `remote_unreachable`。

### 3.2 A1 普通 Lead 写入口

新增 repo-template 顶层 `write-memory.sh`(无参数/无 bypass 开关),由 `sync-template.sh` 安装,由 `first-import.sh` 的 staged/committed 精确集合与显式 add 清单纳入,由 hooks/bootstrap 测试钉住。README 的 Ordinary Lead write 只指向:

```sh
cd "$HOME/.claude/agent-memory"
./write-memory.sh
```

`write-memory.sh` 校验 `FLYWHEEL_LEAD_ID` 后,在同一把 `lockf` 内依次执行原来的 pull/rebase、显式 Lead 夹 add、`git commit --only -- "$FLYWHEEL_LEAD_ID"`、push。无变化时明确成功退出,任何 pull/hook/commit/push 失败仍失败。脚本不得设置 admin/sync actor,普通 Lead guard 继续从环境里的 `FLYWHEEL_LEAD_ID` 判权。

### 3.3 sync 的 index 合同

对每个候选夹,写者在共享锁内执行:

1. `git add -A -- "<夹>/"`;
2. 只检查「本夹当前可提交内容」是否存在,不要求 default index 里没有别人的暂存;
3. `FLYWHEEL_MEMORY_ACTOR=sync git commit --only -m ... -- "<夹>/"`;
4. 断言新提交只改该夹且 `Memory-Owner` 等于该夹;
5. 断言 writer 未改变进入锁时已经 staged 的其他路径的 path/blob/mode 三元组。

`commit --only` 是关键边界:sync 只提交显式 Lead 夹,不把其他 Lead 或 admin 已暂存内容带入,也不 reset/unstage 它。发现非当前夹 staged 时只在私有 receipt 中记 `preserved_staged_n` 的计数(info),不记路径、不返回 8。若 `git add`/`commit --only` 自身因 concurrent Git index lock 失败,本轮失败并留证,下一轮重试;不得清理不属于 writer 的 index 内容。

### 3.4 必须先红的并发测试

1. 夹 A 已 staged、工作树夹 B 有待送内容时运行 sync:只产生 B-owner 提交并到达远端;A 的 staged path/blob/mode 集合逐字保持;随后普通 A Lead 仍可通过 `write-memory.sh` 提交。
2. 一个 `lockf` 持有者被精确 `kill -9` 后,下一次 writer 立即取得同一路径的锁;保留的锁文件不能被误判为陈锁。
3. sync 持锁时普通 `write-memory.sh` 有界等待且不交错;普通 writer 持锁时 sync 同样有界等待,两者均无 staged 内容丢失。
4. mutation control:去掉 `commit --only` 后,夹 A staged 内容会搭便车进入 B 提交,测试必须变红。

## 4. pending 与 structural 分类

- `lm_pending_scan` 的 **delivery pending** 只包含物理位于 `MEMORY_PATH/<合法 Lead 夹>/...` 的 dirty/deleted 路径,以及只改合法 Lead 夹的未推提交;被 gitleaks/hook 拒绝的合法 Lead 内容仍在该集合,继续参与 `pending_age_h`/`stale`。
- repo-template 管理的非 Lead 顶层路径(`README.md`、`SCAN-LEDGER.md`、`bootstrap.sh`、`.gitignore`、`.gitleaks*`、`.githooks/**`、`.github/**`、`write-memory.sh`)及其他结构性不可由 sync 提交的顶层残留不参与 `stale`。
- 这些残留单列 `structural_count`;看者新增独立 `structural` episode:首次出现只发一次提示,持续期间不按 24h 重提;完全消失且远端可判时发一次恢复并清账。文案不含路径或记忆内容。
- `checks.tsv` 增加 `structural_count`;`freshness-report --local` 可显示计数,但不得把 structural 合并到 pending age。
- 测试同时钉住两边:模板顶层修改 30h 不得产生 stale;合法 Lead 文件被 hook 拒 30h 必须产生 stale;structural 一次提示不日更刷屏。

## 5. 冻结合同修正

`--freeze --day D --path <relative-path>` 只接受当日为验收创建、承诺在 D+1 检查前不再修改的专用标记文件(建议 `<lead>/_fly2146-acceptance-D.md`),不再从持续写入的活 MEMORY 文件里挑。

在原 `--freeze` 全部前置之外,必须先取合格 D 日 run 的 `headSha_D`,查询远端 `contents/<url-encoded-path>?ref=<headSha_D>`:

- D 树 404,或 D 树 blob 与当前 `expected_blob` 不同 ⇒ 可以原子 create-if-absent 冻结;
- D 树 blob 已等于 `expected_blob` ⇒ 当场拒绝并提示另建一个 D 日专用标记,不能烧到第二天才假红;
- 远端查询 undetermined ⇒ 拒绝冻结。

D+1 `--check-visible` 通过后,操作者删除该专用标记,让删除也经普通 sync 到达;远端历史与冻结 JSON 继续保留。新增 precheck mutation/反例:若跳过 D-tree 查询,早已可见的 blob 会错误冻结,测试必须红。

## 6. CI 第五分片与预算

- 新增 `script-tests-5`,命名 `Script Tests 5/5 — Lead memory remote sync`;原四片显示名同步为 `/5`,required-check 汇总与 structure inventory 纳入新 job。
- 五套新文件在第五片串行、各恰好一次;A1 hooks/bootstrap 仍留原片,manifest 套件仍留原片。CI 只新增 **五条** `test-lead-memory-*` 命令,不是六条。
- 第五片保留相同 shallow checkout、pnpm install/build、20min job cap、首步计时与末步 `FLY-1870` 85% tripwire;不得提高 cap/阈值,不得靠 skip/缩短等待过门。
- 设计墙钟目标(本机串行实测后写 acceptance):sync ≤120s,arrival ≤45s,freshness ≤45s,observe-workflow ≤10s,retire ≤30s;测试本体合计 ≤250s。加 FLY-2245 观测到的公共 setup 最大 149s,投影 ≤399s,低于 1020s 的 70% 门 714s。PR 首轮真 CI 若 >714s,按 FLY-2245 已评审 fallback 只移动完整 named step,不开大 tripwire。
- 正确引用为 `scripts/lib/converge-nonlead-daemons.sh:1082-1151`。

## 7. 临时 label 与阶段二补跑口径

- 阶段一临时 `com.flywheel.lead-memory-sync.fly2146-verify` 有意不进入生产 retire 白名单。安装期间 census 会把它列为 unmanaged;acceptance 必须预告该计数是隔离演练产生的临时信号。
- 临时单元仍由实施节点手工按 `disable → bootout → 确认 unloaded → identity-safe archive` 清理;`retire-units.sh` 继续只认两个生产精确 label,不为验收临时名放宽。
- 清理证据必须同时证明:临时 label 不在 launchd domain、active plist 已不在 LaunchAgents、归档件存在、后续 census 不再列 unmanaged/zombie。
- 阶段二两次无人手工触发的 writer 证据接受两种合法形状:① `started_at` 落在 :17–:18 的自然调度窗;②睡眠错过后由 launchd 唤醒补跑,`trigger=launchd`,并在验收记录睡眠/唤醒事实。不能只因补跑分钟不在 :17–:18 判失败。远端多日观察的 `attempt==1` 规则不变。

## 8. 复审与实现门

对原 plan blob `83cbd495a7602a7d8dd1a29940961dcfb2fd1075` 开新 exact-blob review,评审请求必须明确同时读取本文件。若复审只重复 `shared-index-no-mutex-wedge`,按 Lead 裁定视为已由本修正处置并继续;若出现新的 HIGH correctness/security/data-loss finding,实施仍停并交 Lead。通过后才进入 C1 RED。
