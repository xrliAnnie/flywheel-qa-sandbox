# FLY-1338 CI 分层 + 并行 — 实施计划

Issue: FLY-1338 (https://linear.app/geoforge3d/issue/FLY-1338/cycle-time-ci-分层-并行-单轮-ci-墙钟砍半)
日期: 2026-07-18
基于: research.md(全部机制已本机实测;方案 A 已过 brainstorm gate)

## 0. 目标 / 非目标

**目标**:ci.yml 的单轮墙钟从 ~18min 降到 ≤9.5min(预期 ~5.5-6min),覆盖逐条不变(同一批 vitest 文件 + 同一批 bash 套件 + build/typecheck/lint 全保留)。

**非目标(明确不动)**:
- ship-on-comment.yml(已弃用尸体,另单)
- payload-distribution job mapping(字节不动;其上方注释按 §1 更新)
- 产品/行为测试与 vitest 配置、各包 package.json、根 package.json scripts(**唯一例外**:FLY-889 CI 结构守卫测试按 §3b 迁移——它测的是 ci.yml 本身,不是产品行为)
- flaky 测试治理(正交,另有 task)

**改动面 = 3 个文件**:`.github/workflows/ci.yml`(重排)+ 新增 `scripts/__tests__/ci-structure.test.sh`(守卫)+ 更新 `packages/teamlead/src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts`(该测试解析真实 ci.yml 并硬读 `jobs["build-and-test"]`,job 拆分后会把 missing job 当 sparse checkout **静默绿跳**,FLY-889 的 timeout/apt 合同悄悄失守——Codex R1 抓出,必须同步迁移断言)。回滚 = revert 单 commit。

## 1. 目标形态(ci.yml 骨架)

`permissions`(contents: read)、`concurrency`(ci-ref + cancel-in-progress)保持原样(workflow 级,拆 job 后行为不变)。所有 job 并行启动于 t=0,互不 needs(early feedback 靠 quick-gate 先红——不停止其他 jobs;与 matrix 的正式术语 fail-fast 区分,避免同词异义)。

```yaml
jobs:
  quick-gate:            # ~3.2min:最常见快败类(编译/类型/lint)3 分钟内报红
    name: Quick Gate (build + typecheck + lint)
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - checkout / pnpm/action-setup / setup-node(cache: pnpm)   # 照抄现状
      - pnpm install --frozen-lockfile
      - pnpm build
      - pnpm typecheck
      - pnpm lint

  unit-tests:            # 5 路并行,矩阵见 §2;每路 ~3.5-5.5min
    name: Unit (${{ matrix.name }})
    runs-on: ubuntu-latest
    timeout-minutes: 15          # 最长片 ~5min,3 倍余量(FLY-889 教训:余量不足会把超时误报成测试失败)
    strategy:
      fail-fast: false           # 一片红不掐其他片:一次重跑拿到全部失败面
      matrix:
        include: [...见 §2...]
    steps:
      - checkout / pnpm/action-setup / setup-node(cache: pnpm)
      - Configure git for tests            # 照抄现状(部分测试做真 git 操作)
      - pnpm install --frozen-lockfile
      - Install better-sqlite3 prebuilt    # 照抄现状
      - pnpm build                         # 硬前置:types/main 指向 dist/,跨包测试走 dist
      - run: ${{ matrix.cmd }}

  script-tests:          # ~5min:原 job 里 Test 步之后的全部 shell 套件步骤,整体平移
    name: Script Tests (shell suites)   # 不称 hermetic:FLY-1062 real-install smoke 是 SLOW+NETWORK(真 registry npm install),名称不许撒谎
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - checkout / pnpm/action-setup / setup-node(cache: pnpm)
      - Configure git for tests
      - pnpm install --frozen-lockfile
      - Install better-sqlite3 prebuilt
      - pnpm build
      - Install tmux/lsof/sqlite3(apt)   # 只有这个 job 需要
      - Test — FLY-1327 cycle-time report  # sqlite3 preflight + pnpm test:cycle-time
      - ...原 ci.yml 从「Integration test — cmux-sync hooks」到「Test — FLY-1081 notify-path migration」
        的每一个步骤,连同注释逐字搬运,顺序不变...
      - Test — FLY-1338 ci structure guard # 新增,见 §3
        run: bash scripts/__tests__/ci-structure.test.sh

  payload-distribution:  # job mapping 本体(payload-distribution: 起的整个 job 定义)字节不动
    ...                  # 但 job 前的 FLY-1062 注释块现在写着「the build-and-test job above is byte-untouched」,
                         # build-and-test 消失后即成事实错误 → 必须更新该注释(说明 FLY-1338 重构了原 Build & Test,
                         # payload job 本身未改);job 内 FLY-1323 两个 preflight 步骤保持串行顺序

  ci-ok:                 # 稳定聚合 check:给人 / 工具一个单一结论名
    name: CI OK
    runs-on: ubuntu-latest
    needs: [quick-gate, unit-tests, script-tests, payload-distribution]
    # always():依赖失败/被跳过时本 job 不许被 skip,必须显式判红。
    # && !cancelled():堵取消竞态——GitHub 取消 workflow 时会重算运行中 job 的 if,
    # 裸 always() 会让已启动的 ci-ok 免于取消;若取消恰落在四个 needs 全 success 而
    # ci-ok 仍在跑的窗口,聚合 check 会在被取消的一轮上留下绿灯(Codex R1 抓出)。
    if: ${{ always() && !cancelled() }}
    steps:
      - name: Verify all jobs passed
        env:
          NEEDS_JSON: ${{ toJSON(needs) }}   # 经 env 传递,不内插进脚本体(输出含引号时 shell 不破)
        run: |
          # needs 里任何 result != success(failure/cancelled/skipped)→ exit 1
          printf '%s\n' "$NEEDS_JSON" | jq -e 'all(.[]; .result == "success")'
```

取消路径核对(Codex R2 精确化):① 依赖 failure/skipped 且 workflow 未被取消 → ci-ok 照常运行,jq 判红;② 整轮 workflow cancellation(superseded push)→ `!cancelled()` 使 ci-ok 被跳过/终止,聚合 check 为 skipped/cancelled——通常走不到 jq;③ 防御性兜底:若 jq 真收到 cancelled result(非全局取消上下文),同样判红。三条路径都非绿;精确说法:flywheel-comm ship-ci-guard 对「gh pr checks --json」的 bucket 校验保持 fail-closed(原生 CLI 把 cancel/skipping 单列 bucket,是仓库 wrapper 对一切非 pass bucket 的显式拒绝闭的环——Codex R3 校注)。

## 2. unit-tests 矩阵(逐字,含 §research 1.1 的传参契约)

⚠️ **契约:一律「无 `--`」形式**。`test:run -- --shard=1/3` 会被 pnpm 静默吞 flag → 假拆分全量跑(实测确认)。守卫见 §3。

```yaml
matrix:
  include:
    - name: teamlead 1/3
      cmd: pnpm --filter flywheel-teamlead test:run --shard=1/3
    - name: teamlead 2/3
      cmd: pnpm --filter flywheel-teamlead test:run --shard=2/3
    - name: teamlead 3/3
      cmd: pnpm --filter flywheel-teamlead test:run --shard=3/3
    - name: heavy
      cmd: pnpm --filter flywheel-claude-runner --filter flywheel-comm --filter flywheel-edge-worker test:run
    - name: light
      cmd: pnpm --filter './packages/*' --filter '!flywheel-teamlead' --filter '!flywheel-claude-runner' --filter '!flywheel-comm' --filter '!flywheel-edge-worker' test:run
```

- light 桶负向 filter 实测匹配 18 包(含无 test:run 的包,脚本运行形式自动跳过——现状 test:packages:run 同款行为,生产已验证)。**新包默认落 light 桶,结构上不可能漏**。
- 调节阀(3→4 片)是**联动清单**,不是只改分母——精确合同会拦半吊子调整:① §2 矩阵加 teamlead 4/4 行且各行分母全改 4;② 守卫断言 3 的期望 matrix name/cmd 集合、断言 4 的分母、相关突变期望同步改;③ §5 验收文字「5 个 unit job / 三片之和」改 6/四片;④ 峰值并发与预期时间文字更新;⑤ 全部守卫 + 突变验证 + 覆盖对账重跑。触发条件:实现后最长 teamlead 片 >250s(shard 按文件数切、非按时长,可能不均)。

## 3. 新增守卫:scripts/__tests__/ci-structure.test.sh(TDD:先写红再改 ci.yml)

**解析真实 YAML 断言,不做纯文本 grep**——release-workflows-structure.test.sh 自己的注释就记录过 substring grep 被 quoted key / 注释掉的 gate 骗过的历史(Codex R1 指出),照它的 parsed-YAML 先例走(python3 + PyYAML,ubuntu-latest 与本机均自带)。唯一保留 raw grep 的是禁令类断言:

1. **传参形式(raw grep)**:ci.yml 全文零出现 ` -- --shard`(双横杠吞 flag 形态;禁令用 grep 恰当——出现在注释里也该红)。
2. **job 集合精确**(parsed):jobs 恰为 {quick-gate, unit-tests, script-tests, payload-distribution, ci-ok};quick-gate / unit-tests / script-tests 三者无 `needs`(并行合同)。
3. **矩阵合同**(parsed):unit-tests 的 `strategy.fail-fast == false`;matrix include 的 name/cmd 为精确集合(逐字比对 §2 五行)。
4. **shard 完备性**(parsed,从 matrix cmd 提取):`--shard=k/N` 分母 N 全一致,分子恰好 1..N 各一次。
5. **排除即覆盖**(parsed):light 行每个负向 `--filter '!X'` 的 X,必须由**其他** matrix 行的正向 filter 覆盖(同一 light 行内的正 filter 不算自证)。
6. **ci-ok 合同**(parsed):needs 精确等于其余四 job;`if` 归一化(strip `${{ }}` wrapper + 空白全删)后 == `always()&&!cancelled()`;步骤含对 NEEDS_JSON 的 jq all-success 判定。
7. **FLY-889 合同接管**(parsed,与 §3b 的测试迁移互为冗余):unit-tests 与 script-tests 的 `timeout-minutes ≥ 15`;script-tests 恰好一个 `apt-get update` 步骤且同步安装 tmux/lsof/sqlite3。
8. **执行路径合同**(parsed;Codex R2 抓出——只验 matrix 数据不验执行 = decorative gate):unit-tests.steps 恰有一个 run 步骤,归一化后精确等于 `${{ matrix.cmd }}`(matrix 数据齐但没人执行它 = 五个 job 光 setup/build 就全绿)。两个 seam 断言(本条 + §3b 挂载合同)都须同时确认该步骤**无 `if` / `continue-on-error`** 之类使其跳过或吞错的配置——验的是 gating execution,不是 step 存在性(Codex R3 附注)。

测试自身跑法:本地 `bash scripts/__tests__/ci-structure.test.sh`;CI 里挂 script-tests job 末尾。
**守卫自身的在轨保证(防「拆掉守卫调用」的自指盲区)**:守卫脚本无法自证仍被 CI 调用——这条合同放进 §3b 的 FLY-889 vitest 测试(独立入口,跑在 unit-tests shard 里,不会与 bash 守卫一同被删):断言 script-tests.steps 恰有一个 run 调用 `bash scripts/__tests__/ci-structure.test.sh`。两个守卫互相防守对方的执行 seam(bash 守卫防 job 结构,vitest 守卫防 bash 守卫的挂载 + timeout/apt 合同)。
**突变验证**(实现阶段必做、不 commit,输出证据贴 PR):① 一片改 `-- --shard` → 断言 1 红;② 删 2/3 片 → 断言 4 红;③ light 排除一个别处没跑的包 → 断言 5 红;④ 把正向 filter 挪进 light 行自证 → 断言 5 仍红;⑤ 把合同 token 只留在注释里、真 key 删掉 → parsed 断言红(证明不是 substring 假绿);⑥ 删掉/替换 unit-tests 的 `${{ matrix.cmd }}` 执行步 → 断言 8 红;⑦ 删掉 script-tests 里对守卫脚本的调用步 → FLY-889 vitest 测试红;⑧ 给执行步加 `if: false` 或 `continue-on-error: true` → 对应 seam 断言红(Codex R3 附加突变)。

## 3b. 更新 FLY-889 守卫测试(第三个改动文件)

`packages/teamlead/src/__tests__/fly-889-ci-workflow-timeout-guard.test.ts` 现硬读 `jobs["build-and-test"]`,missing 时按 sparse checkout 静默通过。迁移:
- 改读 `jobs["unit-tests"]` 与 `jobs["script-tests"]`,两者 `timeout-minutes ≥ 15` (quick-gate 的 10min 单列豁免,不在长测试合同内);
- apt 合同移到 script-tests:恰一个 `apt-get update`,同一步骤含 tmux/lsof/sqlite3;
- **新增守卫挂载合同**(§3 的自指盲区补位):script-tests.steps 恰有一个 run 步骤调用 `bash scripts/__tests__/ci-structure.test.sh`——bash 守卫被人从 CI 卸载时,本测试红;
- **sparse-checkout 绿跳分支保留但收窄**:仅当整个 .github/workflows/ci.yml 不存在才跳;ci.yml 存在而目标 job 缺失 = 硬红(根治本次暴露的静默失守模式)。

## 4. 实施步骤(TDD 顺序)

1. `scripts/__tests__/ci-structure.test.sh` 先行:对现状 ci.yml 跑 → 断言 2(job 集合)红 = RED。
2. 更新 FLY-889 守卫测试(§3b):对现状 ci.yml,新断言(unit-tests/script-tests)红 = RED(硬红分支生效)。
3. 重写 ci.yml 至 §1 形态。搬运纪律与**机械对账**(不用 yq——本机与 runner 均未装;用仓库既有 python3+PyYAML 先例):
   - 基线取 `git show 'HEAD:.github/workflows/ci.yml'`(重写前),新文件从工作区读;
   - PyYAML 解析两侧,断言:旧 build-and-test 中 Test 步之后的每个 {name, run} **有序序列** == 新 script-tests 对应序列(仅允许末尾新增 FLY-1338 guard 步);quick-gate 的 build/typecheck/lint 三条 run 与旧步骤逐字相等;matrix 五条 cmd 与 §2 逐字相等;**两个执行 seam 显式核对**——unit-tests 存在恰一个 run == matrix.cmd 引用的执行步、script-tests 末尾存在守卫调用步(与 §3 断言 8 / §3b 挂载合同同口径);
   - **注释不经 YAML parser 保留** → 注释搬运用 scoped `git diff -- .github/workflows/ci.yml` 人工对账(FLY-889 timeout 教训、FLY-110/FLY-1323 等注释随步骤走,payload job 前注释按 §1 更新),对账结论写进 PR;
   - 对账脚本一次性(scratch,不 commit),其输出贴 PR。
4. 守卫 + FLY-889 测试全绿 = GREEN;做 §3 突变验证并截留证据(输出贴 PR)。
5. push 分支 → 首轮真机 CI 验证(见 §5)。
6. 若 teamlead 片间不均(最长 >250s)→ 按 §2 调节阀联动清单整体调 4 片并全量重验(严禁只改分母)。

## 5. 验收(承接 issue「同一 PR 典型重跑墙钟对比,不牺牲覆盖」)

**墙钟对比**(写进 PR 描述):
- before:run 29646776775 = 18m06s(2026-07-18 main,success);FLY-1327 样本 17-17.5min/轮。
- after:实现 PR 自身连续 ≥2 次 push 的 ci-ok 墙钟(gh run view 的 created→updated),目标 ≤9.5min,预期 ~6min。

**覆盖对账**(写进 PR 描述):
- vitest:5 个 unit job 的「Test Files」数逐包求和 == 同 head 上 `pnpm test:packages:run` 单机全量的数(teamlead 三片之和 == 615±当时实际);每片 < 全量(否定 flag 被吞)。
- shell 套件:§4.3 的 PyYAML 有序 {name, run} 序列对账 == 相等(仅末尾多 guard 步);注释搬运经 scoped git diff 对账。
- build/typecheck/lint:quick-gate 三条 run 与旧步骤逐字相等(同为 §4.3 对账断言)。

**平台证据**(PR 附带,Lead gate 已要求):`gh api repos/xrliAnnie/flywheel/branches/main/protection` 403「Upgrade to GitHub Pro」原文 = Free 计划无 branch protection,不存在按名 required check,无需任何配置迁移。

## 6. 风险与回滚

| 风险 | 缓解 |
|---|---|
| shard 假拆分(flag 被吞) | 传参契约 + 守卫断言 1 + 验收「每片 < 全量」+ 突变验证 |
| teamlead 片间不均 | §2 调节阀(3→4 片) |
| 某 shell 套件对前置步骤有未注释的隐性依赖(如恰好吃了 Test 步的副产物) | script-tests 保持原相对顺序逐字搬运;首轮真机红了按失败面单独补前置,不猜 |
| FLY-1062 real-install smoke 本就 SLOW+NETWORK(真 registry install),受网络波动影响 | 既有风险原样保留(非本次引入);保留原注释,job 名不称 hermetic;红了按现状同款处置 |
| FLY-889 守卫测试静默绿跳(job 名变更) | §3b 迁移 + 硬红分支 + §3 守卫断言 7 双保险 |
| 计费 +~75%(私仓) | Lead 在 ship gate 呈 Annie(brainstorm gate 已裁定,非本 PR blocker);降级阀 = teamlead 2 片 |
| 并发 job 顶限 | 峰值 ~8 << Free 计划 20,两 PR 并行也安全 |
| 回滚 | 单 commit revert(ci.yml + 守卫脚本 + FLY-889 测试同一 commit),即回现状 |

## 7. 实现阶段给 Codex code review 的重点提示

- diff 大头是 ci.yml 步骤搬运——review 重点不在 YAML 语法,在**对账完整性**(§4.3 的 PyYAML 对账输出 + 注释 diff 对账结论请一并给 Codex)。
- 守卫脚本 = bash 入口 + python3/PyYAML 解析断言(照 release-workflows-structure.test.sh 先例);raw grep 只用于 ` -- --shard` 禁令。注意 macOS(本地 bash 3.2)/Linux(CI)双端可跑(仓库既有 __tests__ 脚本同款约束)。
