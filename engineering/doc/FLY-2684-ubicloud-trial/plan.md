# FLY-2684 Ubicloud 试跑与回退 — 实施计划
Issue: FLY-2684 (https://linear.app/geoforge3d/issue/FLY-2684/ci成本ubicloud-试切-确认三条未验证项-金丝雀-workflow-真跑-runs-on-可一键切换回退)
日期: 2026-09-17
基于: 无

状态：待设计评审。本文合并探索、官方调研和实施计划，遵循 plan_only。设计节点只交付本文、进度、图源及 founder HTML；下文代码与命令均是后续实施/QA/Lead 的任务，不表示已执行。

## 1. 决定与边界

先交付独立、手动触发的金丝雀（小范围真实测试），再在 FLY-2681 合入后交付仅替换 `ci.yml` 的 `runs-on`（执行机器选择字段）的第二个 PR。生产切换只由 Lead 在 founder 完成账号授权、金丝雀通过、FLY-2681 上线后执行，并先告知 founder。本设计不购买机器、不开户绑卡、不安装 App、不访问 Ubicloud 凭据、不实现或发起 workflow、不申请 ship 或合并。

来源：founder 2026-09-17 21:25Z / FLY-2651 / message `1550256371201474642`；FLY-2682 对比页及 [PR #1237](https://github.com/xrliAnnie/flywheel/pull/1237)。本地任务基线 `9241a9331517c6e59624cd4f50a70a0860429765`。FLY-2681 当前仍在设计评审（只读其 progress/plan，2026-09-17 21:32Z），不是已合入事实。

**验收语义澄清**：“变量缺省时逐字节一致”不能指修改前后的 YAML 文件本身完全相等。要求是将新增 runner 表达式恢复成原字面量后，`ci.yml` 全文件字节完全相等；变量缺省解析结果仍为 `ubuntu-latest`。任何其他字节、检查名、执行/跳过语义变化都不属于 PR B。比较基线必须是 FLY-2681 合入后的冻结版本，不是本计划的旧版本。

备选：直接全量换 label 最短但违反边界且撞 FLY-2681；抽成 reusable workflow 可避免复制，但需改现有 CI 图、检查上下文和消费者，不适合本单。选择有限复制三类 job + parity 测试（比较复制内容是否一致）；不建立第二套长期 CI。

## 2. 官方核实（访问日期均为 2026-09-17）

| 项目 | 结论与出处 | 仍需取得的账户级证据 |
|---|---|---|
| ① 并发上限 | **未验证**。已查 Quickstart、Runner Types、Pricing、GitHub Actions 产品页，未找到可引用的每账户硬额度；不能把 GitHub 的限制套成 Ubicloud 的额度，也不把开源默认值当托管承诺。 | founder 授权后 Lead 查看账户限制或通过官方支持取得书面答复（额度作用域、区域、提升方式）。若无答复，分级 1/8/33/54 job 实测并记录实际重叠并发；成功仅证明本账户当时支持此规模，不能宣称无上限。 |
| ② 私有仓 | **未验证明确的官方私有仓保证**。Quickstart 说明通过 GitHub App 接仓，但不是明确的私有仓兼容承诺。当前 GitHub API 已确认 `xrliAnnie/flywheel.private=true`。 | 授权后在这个私有仓实际 checkout、安装依赖、执行三类 job、注入专用测试 secret；成功作为本仓支持证据。不开公共镜像规避此项。 |
| ③ 每 job 全新 VM | **官方已确认**：[Security](https://www.ubicloud.com/docs/github-actions-integration/security) 说明每 job 新建临时 VM（独立虚拟电脑），结束后销毁 VM 和关联磁盘，JIT runner 至多跑一个 job。 | 两次独立 run 的哨兵检查 + 同 run 后继 job 检查。只能证明这些样本未观察到残留；不能证明供应商所有物理擦除，也不涵盖主动上传的 cache/artifact。 |
| ④ 规格与 label | [Runner Types](https://www.ubicloud.com/docs/github-actions-integration/runner-types)：`ubicloud-standard-2` = Ubuntu 24.04 / x64 / 2 vCPU / 8GB / 75GB；x64 还有 4/16/150、8/32/200、16/64/300、30/120/400（核/GB 内存/GB 磁盘）。支持显式后缀 `-ubuntu-2404`，另有 2204、2604。 | 本仓是私有仓，[GitHub runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners) 的 `ubuntu-latest` 为 2核/8GB/14GB。首轮用 `ubicloud-standard-2` 对标；记录实际 OS、CPU、镜像版本，不能称两者软件镜像逐字相同。ARM 和更大规格不在本次切换。 |
| ⑤ 缓存行为及费用 | [Ubicloud Cache](https://www.ubicloud.com/docs/github-actions-integration/ubicloud-cache)：透明缓存默认开启，兼容 `actions/cache` 和 `actions/setup-node`；标准缓存 30GB，7天未访问过期，容量超限淘汰旧项；默认限制当前/默认分支可读。 | 保留 `pnpm/action-setup@v4`、`actions/setup-node@v4 cache: pnpm`、frozen lockfile；不改为供应商专用 action，不关闭分支隔离。记录控制台 cache 模式/额度/收费选择；未核实扩容费，不启用付费扩容。切回 GitHub 时允许冷缓存，依赖安装必须能自行重建。 |

缓存存的是依赖文件，和 VM 文件残留是两个问题。[setup-node v4](https://github.com/actions/setup-node/blob/v4/docs/advanced-usage.md) 支持 pnpm store 缓存，不缓存 `node_modules`；native SQLite binary 仍按原 job 安装/构建。禁止 cache HOME、凭据目录或哨兵目录。

**价格不能仅看 label**：[官方 Pricing](https://www.ubicloud.com/docs/about/pricing) 当前列 standard 2核 `$0.00125/min`、premium 2核 `$0.002/min`；新账户默认 premium，可在控制台关闭，premium 容量满时可落到 standard。因此 label 中的 standard 不是最终计费层证明。[2026 涨价公告](https://www.ubicloud.com/blog/ubicloud-price-adjustment-2026) 说明标准 runner 调整、2026-05-01/06-01 生效；[产品页](https://www.ubicloud.com/use-cases/github-actions) 仍显示更低旧价，不能据此报节省。首轮默认不擅改账户设置；Lead 留实际 tier、单价、credit、cache 上限的截图/导出作为 receipt，混合 tier 分开记账。未取得账单时只报估算，不承诺“省 7 倍”。

官方其他依据：[Quickstart](https://www.ubicloud.com/docs/github-actions-integration/quickstart)、[workflow_dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch)、[REST jobs](https://docs.github.com/en/rest/actions/workflow-jobs)、[REST runs](https://docs.github.com/en/rest/actions/workflow-runs)。workflow_dispatch 文件必须先存在默认分支，才能由 GitHub 接收 dispatch；由正常 ship 路径落地 PR A 后再跑，不能以设计授权替代合并授权。

## 3. 仓库与消费者审计

| 路径/位置（当前基线） | 合同与处置 |
|---|---|
| `.github/workflows/ci.yml:50` quick-gate | 10分钟上限；完整步骤含 shell 枚举、CI 结构、治理/安全合同、actionlint、build/typecheck/lint。复制所有步骤，不缩成三个 pnpm 命令。 |
| `ci.yml:191` unit-tests / `scripts/teamlead-ci-shard.mjs` | 7项静态矩阵，保留 fork env、setup、git identity、native binary、apt、build、条件 mutation 和 stub-hygiene。选一个完整 matrix entry，保留其 name/cmd 以保持条件步骤。 |
| `ci.yml:269` script-tests | 选 Script Tests 1/5；完整 session/lifecycle 片，20分钟上限，checkout fetch-depth 0，包含最终 elapsed tripwire。 |
| `ci.yml:27,50,191,269,499,896,1213,1319,1441,1571` | 当前10个 job 的 runner 字面量，含矩阵及汇总。PR B 在新基线重枚举所有 ubuntu-latest job；其他 workflow 一律不动。 |
| `scripts/__tests__/ci-structure.test.sh`, `ci-matrix-coverage.test.sh`, `workflow-startup.test.mjs` | 保留图/步骤/矩阵/聚合合同；新测试不弱化现有断言。新 workflow 必须 git add 后再跑 tracked-file validator。 |
| `scripts/check-workflow-startup.mjs` | actionlint 1.7.12 不认识字面 Ubicloud label；新增 `.github/actionlint.yaml` 精确 allowlist，绝不全局忽略 runner-label 或关闭表达式检查。 |
| `scripts/ship-await-ci.sh:60` | 按名字读跨 workflow check-runs。**金丝雀任一 job/check 均不得叫 `CI OK`，也不得叫 `CI Scope OK`。** |
| main branch protection / `ship-await-ci.sh` / land `exactGreenCi` 与 `contentCarryoverCiReason` | 三个硬门零改动；2026-09-17 API 确认 required context=`CI OK`, app_id=15368, enforce_admins=true。 |
| `verify-approval.ts`, `ship-ci-guard.ts`, `ship-eligibility.ts`, `merge-ship-gate.ts`, `ship-on-comment.yml` | 审批、QA、冻结头、串行合并及 updater 部署边界不改。 |

实际分片选择：全量成功 [run 35243005773](https://github.com/xrliAnnie/flywheel/actions/runs/35243005773) 的 teamlead 1/4=884秒、heavy=545秒；[run 35270063933](https://github.com/xrliAnnie/flywheel/actions/runs/35270063933) 分别892秒、634秒，两个样本中 teamlead 1/4 都最长。因此首轮选 `name: teamlead 1 of 4`、`cmd: node scripts/teamlead-ci-shard.mjs --shard=1/4`。实施时复核最近两个成功全量 run，若最长项变化，更新选择与 run/job ID 证据，不能仅凭名字 heavy。

FLY-2681 会区分 `CI OK` 和 `CI Scope OK`；本单尊重它最终获批/合入的合同。切换验收必须触发其真正全量路径并得到 `CI OK`，普通 scoped 头的 `CI Scope OK` 不算通过。

## 4. PR A：独立金丝雀

### 4.1 文件与数据流

创建 `.github/workflows/ci-ubicloud-canary.yml`，只含 `workflow_dispatch`；不改 `ci.yml`。创建 `scripts/ci-ubicloud/__tests__/canary.test.mjs`（Node 内置测试 + 仓库 yaml parser），`.github/actionlint.yaml` 精确标签配置。在现有 `scripts/__tests__/workflow-startup.test.mjs` 中 import 新测试模块，使现有 Quick Gate 的 Node suite 自动执行；另在 canary 的专属验证 step 执行。新模块放子目录，避免 root-suite 枚举器要求直接新增 ci.yml 步骤；不改枚举器规则、不添加豁免。PR B 的 runner-label 测试同样接入此既有 suite。

工作流 `name: Ubicloud Canary`；顶层 `permissions: { contents: read }`；`concurrency.group: ubicloud-canary-${{ github.ref }}`，`cancel-in-progress: false`。不同提供商比较串行 dispatch，不能抢同一缓存写者。inputs：

```yaml
on:
  workflow_dispatch:
    inputs:
      runner:
        type: choice
        default: ubuntu-latest
        options: [ubuntu-latest, ubicloud-standard-2]
      capacity:
        type: choice
        default: '0'
        options: ['0', '1', '8', '33', '54']
```

不提供任意 ref、任意 shell、任意 label 或可插值路径输入。dispatch `--ref` 由 Lead 指向已审计的受信任分支；workflow 校验 repository=`xrliAnnie/flywheel`、event=workflow_dispatch；手动 caller 的 choice 仍在 first preflight 中再次 allowlist 校验。每个 runner 表达式安全映射为两项字面量之一：

```yaml
runs-on: ${{ inputs.runner == 'ubicloud-standard-2' && 'ubicloud-standard-2' || 'ubuntu-latest' }}
```

GitHub preflight job（固定 ubuntu-latest、5分钟上限）先验证 inputs、受信任 ref 和 founder 授权记录的存在。Ubicloud run 额外要求仓库变量 `UBICLOUD_CANARY_AUTHORIZED == 'true'`；这只是 Lead 在核验 founder 消息与 App scope 后设的执行开关，不是 founder consent 的权威来源。Lead 把原消息 ID、授权时间、单仓 scope 证明记入试跑记录。缺项 fail closed，所有 Ubicloud job `needs: preflight`；不能因未经授权的 job skipped 而宣称全绿。GH baseline 不需要 Ubicloud 开关。

三类 payload job 名称固定为 `Ubicloud Canary / Quick Gate`、`Ubicloud Canary / Unit (${{ matrix.name }})`、`Ubicloud Canary / Script 1`。保留完整步骤与 timeout/env，只移除生产 classify 的 needs/if，改为 preflight + capacity=0。Unit matrix 仅保留选定 entry；不得删去以 matrix.name 为条件的步骤。前置环境记录限 OS/version、nproc、RAM、disk、Node/pnpm、runner name（不打印 env）；后置报告限布尔值/耗时/缓存命中与公共执行身份。baseline 和 Ubicloud 使用同一 workflow revision、同一 head SHA、相同 workload。

### 4.2 哨兵与 secret

`isolation-write` 和依赖它的 `isolation-read` 用所选 runner，各5分钟上限；只在 capacity=0 执行。两者都在任何 checkout/cache 之前检查固定未缓存路径：`/tmp/fly2684-vm-sentinel`、`$HOME/.fly2684-vm-sentinel`、`/var/tmp/fly2684-vm-sentinel`。存在即失败。writer 在三处写入非机密常量并立即 `test -s` 确认成功；**不清理**，不注册删除 trap，不经 cache/artifact 传递文件。reader 只验证不存在，也记录 runner identity + `/proc/sys/kernel/random/boot_id` 哈希作为辅证。run B 的 writer 再检查 run A 使用的同一固定路径，不能把 run_id 拼进路径造成假阴性。

每轮 writer 的成功、reader 的成功、run A/B URL、job IDs、start/end、runner identity 必须齐全；reader 被跳过不算通过。不同 runner name 或 boot_id 本身不等于磁盘销毁证明。哨兵不存在只证明抽样路径；官方销毁合同另行引用。

secret 测试用 Lead 创建的**专用随机无生产权限** repository secret `UBICLOUD_CANARY_PROBE`。只在独立的短步骤经 env 传入，不经 `${{ secrets... }}` 拼进 shell 内容：

```yaml
- name: Verify dedicated secret delivery
  env:
    CANARY_PROBE: ${{ secrets.UBICLOUD_CANARY_PROBE }}
  shell: bash
  run: |
    set +x
    set -euo pipefail
    test -n "$CANARY_PROBE"
    printf '%s\n' 'secret_present=true'
```

不打印值、编码、摘要或全量上下文；不使用生产部署/账单凭据。checkout 使用最小 read token 且 `persist-credentials: false` 是 canary 明示差异；检查 private clone 成功即可证明访问，不能以 secret_present 证明所有生产 secret 兼容。测试 secret 缺失必须失败。QA 安全检查 workflow 的日志/上传路径：无 `set -x`、无 env dump、无保存 HOME/全 workspace；对专用测试值用受控本地扫描只输出布尔泄漏结果，不上传扫描输入或 token。测试后 Lead 删除 probe secret。

### 4.3 缓存与并发实测

缓存：同 SHA/lockfile/branch，GH A/B 与 Ubicloud A/B 各一次，记录 setup-node 的 hit/miss、install耗时与控制台 cache 大小。为可复现冷/热测试，另用 `actions/cache@v4` 对 **非机密** `$RUNNER_TEMP/fly2684-cache-probe` 做固定 probe key（锁文件 hash + provider）小文件 round trip，A miss/save、B hit/restore；不清除全仓缓存。真实 pnpm 首次不一定冷，已命中就据实写 warm/unknown，不伪称 cold。回切 GitHub 的 missing cache 不是失败，frozen install 能重建才算兼容。

并发官方额度拿不到时，capacity>0 仅跑 preflight + 一个无 checkout/secret/cache 的矩阵 job；preflight 从允许集合生成 `[1..N]` JSON output，消费端 `fromJSON`，`max-parallel: 54`, `fail-fast: false`, timeout=10min，每项仅运行 `sleep 180`。依次 1、8、33、54，不与三类 heavy payload 一起压测。Lead 发起每一级前确认上一级正常且总本次成本上限 $10；10分钟仍排队则 Lead 从 GitHub 取消，记录限额/排队，不能无限等待或升到下一档。Job timeout 不覆盖未分配 runner 的排队，故需要外部观察与取消。

用 `[started_at, completed_at)` 扫描重叠峰值；分两批共完成54不能证明54同时。33/54尚未观测到或出现持续排队时，记“容量未验证/不足”，禁止全量生产切换；Lead 可联系官方提额后重新跑。一次三类 job 通过不证明峰值容量。若官方确认可用额度≥54，也仍记录试跑启动延迟，保证合同与账户一致。

### 4.4 金丝雀结束与验证

汇总 job 固定 GitHub runner，名 `Ubicloud Canary Result`，`if: always()`；检查 preflight、当前模式全部必需 job 为 success，其余只能按模式 skipped。payload 任一失败、writer失败、secret缺失、取消或依赖跳过均不可绿。不写 checks/statuses，不调用 ship/merge API。

单元验证先红再实现：额外 push/pull_request 触发、CI OK 名称（含表达式产生）、扩大 token scope、允许任意 label、删除任何源步骤、删除 shard1 条件 mutation、删掉 tripwire、哨兵按 run_id 命名/提前清理、reader无 needs、secret缺失被吞、未经授权被总结为成功，均必须红。完整 job 比对：从记录的 source SHA 读取 `ci.yml`，仅允许 runner/name/classify-dependency、canary wrapper 与 persist-credentials 差异；源工作负载 steps/env/timeouts/matrix entry 深等。PR A 不改 `ci.yml` 的 git diff 必须空。

```sh
node --test scripts/ci-ubicloud/__tests__/canary.test.mjs
# 将工作流纳入 tracked 集合后：
node scripts/check-workflow-startup.mjs
node --test scripts/__tests__/workflow-startup.test.mjs
bash scripts/__tests__/ci-shell-suite-enumeration.test.sh
bash scripts/__tests__/ci-structure.test.sh
```

QA 执行顺序：正常 ship PR A → founder 授权记录与账户级设置 receipt → Lead 设 canary-only 开关/probe secret → 同一受信任 revision 跑 GH A/B → Ubicloud A/B → 必要的并发验证。设计节点不执行这些写操作。

## 5. PR B：FLY-2681 后的单变量切换

依赖门：从 GitHub 取得 FLY-2681 merged SHA、确认它为 origin/main 祖先、保存其合入后最新 `ci.yml` blob SHA 与完整 bytes。技术同步正常 merge 进本分支，不能把旧 ci.yml 覆盖回去。新 jobs 按基线重新枚举，不硬编码当前10个以遗漏新 job。

`ci.yml` 唯一允许的改动，对所有原来 `runs-on: ubuntu-latest` 的 job（包括 classify、Quick Gate、全部 matrix/shard、payload测试、聚合）替换为：

```yaml
runs-on: ${{ vars.CI_RUNNER_LABEL || 'ubuntu-latest' }}
```

没有组织变量继承/shadow 意外：Lead 检查 repository/organization 同名变量的有效值（不输出无关变量）。只接受操作值 `ubuntu-latest` 和 `ubicloud-standard-2`；未知非空值不会静默 fallback，可能排队，应按回退处理。环境级同名变量不用于 runner 选择。无新增 bootstrap job、无变更 events、job名/ID/needs/if/concurrency/permissions/命令；不改 FLY-2681 的 `CI_SCOPED_MODE`。

创建 `scripts/ci-ubicloud/__tests__/runner-label.test.mjs`，记录 PR B 前的基线 fixture/hash（小型测试 fixture 或从明确 git SHA 读取；不可偷偷取 HEAD~1）：
1. 从目标逐字替换**精确**新增表达式为 `ubuntu-latest` 后，与冻结基线 bytes 相等；再 YAML 深比较。补一个改 CI OK name/if/命令的 mutant 必须失败。
2. 枚举基线所有 ubuntu-latest 项并断言目标一一替换；missing/空变量解析 Ubuntu，两项合法值各解析到对应 runner。
3. FLY-2681 原有测试保持通过，actionlint 及 `ci-structure` 不放宽；hard gate 路径 git diff 必须空，保护配置未变。
4. 离线 fixture 只证明表达式和 diff；不能声称真 runner 或 CI OK 已通过。

PR B 通过常规审查与 ship 后，生产变量初始仍缺省。Lead 在后续受控窗口通知 founder 并进行验收与试跑；QA 不能为了验收擅改生产变量。操作由 Lead 执行：

```sh
# 切换（只在全部依赖满足后）
gh variable set CI_RUNNER_LABEL --repo xrliAnnie/flywheel --body ubicloud-standard-2
# 回退（不依赖 Ubicloud 控制台）
gh variable set CI_RUNNER_LABEL --repo xrliAnnie/flywheel --body ubuntu-latest
```

记录操作人/时间/前后值/有效 scope、冻结 head、run/attempt/job IDs 和实际 runner labels。每次变更后对受信任测试 PR 的同一 head，走 FLY-2681 合入后的 `ci-full ensure` 全量触发协议；如已绿复用会短路，则在其合法协议下触发新全量事件（例如 `ci:full` remove/add），不能以复用旧绿当新提供商验证。先缺省 GH `CI OK`，再 Ubicloud `CI OK`，再回退 GH `CI OK`，三者必须包含实际执行的全量 job；之后 Lead 才决定再次切到 Ubicloud 开始一周。不要发明 `ci.yml workflow_dispatch`，生产文件目前无此入口。

**回退只改变未来调度**：已经排队或运行的旧 job 不会迁移，也不保证 rerun 旧 attempt 会重读变量。Lead 先设置 GitHub 值、取消受影响旧 run、以当前 workflow 的新事件触发新 run、核对实际 labels + full CI OK。供应商停服时仍可从 GitHub 改变量；冷缓存可使第一轮更慢。回退过程中不关保护、不跳 CI、不复用错误 head 的审批。

## 6. 一周回执：步骤而非新增服务

本单选择可执行的采集步骤，不新建后台任务。Lead 拥有 trial start/end、回退与一周 founder 回执；QA 提供证据。数据放本 issue folder 的 `data/`（只存脱敏元数据），不是另建状态目录。账单敏感资料保留受控位置，仓内只放摘录和证据引用，不存卡号/用户隐私。

### 6.1 最小数据模型

`trial.json`：schemaVersion=1、repo、baseline/start/end UTC、FLY-2681 merged SHA、PR A/B merge SHA、source workflow blob、variable change history、授权消息引用、runner tier/price/cache settings receipt、官方未验证项状态。

`runs.jsonl`：repo、workflow_id/path、run_id、run_attempt、head_sha、event、created_at、run_started_at、status/conclusion、scope(full/scoped/docs/reused)、provider(derived from jobs)、trialPhase(GH-before/UBI-week/GH-rollback/canary)。

`jobs.jsonl`：复合身份 `(repo,run_id,run_attempt,job_id)`，name、labels、runner_id/name、created_at/started_at/completed_at、conclusion；重试也保留，不能按 head 去重而漏钱。`billing.csv`：UTC 时间窗、supplier、tier、currency、gross_compute/cache/other、credit、net、source receipt ref。没有 job 可归因项则保留 unattributed，不平均假分到 jobs。

### 6.2 REST 采集步骤（Lead/QA）

`gh` 使用已有最小只读 Actions 权限，日志不显示 token。先取切换前7个完整 UTC 日，试跑后取7日；同日多于 API 检索上限时细分小时窗口并核对 total_count，不能默默截1000条。按 start inclusive/end exclusive 本地过滤去重。分页、rate limit、非200、缺时间戳写 incomplete，保留原文件后重试，不输出零值假结果。

```sh
gh api --paginate 'repos/xrliAnnie/flywheel/actions/workflows/ci.yml/runs?per_page=100&created=2026-09-10T00:00:00Z..2026-09-17T00:00:00Z' \
  --jq '.workflow_runs[] | tojson' > data/runs-before.jsonl
# 针对每个 run 的 attempt=1..run_attempt 逐一执行，而非只取 latest jobs：
gh api --paginate "repos/xrliAnnie/flywheel/actions/runs/$run_id/attempts/$attempt/jobs?per_page=100" \
  --jq '.jobs[] | tojson' > "data/jobs-$run_id-$attempt.jsonl"
gh api "repos/xrliAnnie/flywheel/actions/runs/$run_id/attempts/$attempt" > "data/run-$run_id-$attempt.json"
```

以上日期是查询格式示例；实际窗口写入 trial.json 后使用。只对验证为十进制的 API run/attempt ID 构造路径。JSONL 每行要紧凑对象：落地实现使用 `--jq '.workflow_runs[] | tojson'` / `'.jobs[] | tojson'` 或 jq -c，不能把 pretty JSON 误当逐行记录。

### 6.3 指标定义与归因

| 指标 | 计算及限度 |
|---|---|
| runner minutes | 每个已启动 job `max(0,completed-started)/60` 求和，包含失败、取消、所有 attempt；skipped=0，未结束=未结算。另列每job向上取整分钟估算，最终计费按账单；不把 workflow 墙钟时间当机器分钟。 |
| 单头 CI 时长 | 固定 `(repo,PR,head_sha)` 从首个相关 run.created_at 到该头第一次真实全量 CI OK job.completed_at；报告 p50/p95、样本数与未完成数。另外分列每 attempt 墙钟，scoped/docs/reused 不混入全量时长。main 的集成头单列。 |
| 排队 | job.created_at→started_at 的“API观察启动等待”；若依赖等待包含其中，注明含依赖，不能叫纯供应商排队。另给 `(started - max(created,所有 needs 的 completed))` 的可调度后延迟估算，动态条件无法重建则 N/A；独立 capacity jobs 可直接用于启动延迟观察。run.created_at→首job.started_at 单独报告 workflow 等待。 |
| 失败率 | 同口径已完成、非取消的 CI attempts 中 conclusion!=success 的比例；取消/跳过/仍在排队另列数量。再列同 head 的首次失败率与供应商基础设施失败（带job日志归因，不猜）。重试不能消除首次失败或花费。 |
| 费用 | GitHub 与 Ubicloud gross、credit、net 分列，含 cache/存储/其他附加费，税/汇率口径一致。Ubicloud tier 以账单证明；GitHub free allowance 的边际节省不能用价目乘分钟代替实际净节省。 |

先按 full/scoped/docs、job类别、provider/tier、冷/热缓存分层。FLY-2681 减少 job 与 Ubicloud 降单价分别归因：如没有7天“FLY-2681 已启用但仍用 GitHub”的稳定基线，则明确前后观察被混杂；使用同 SHA canary A/B 和按实际 post-matrix job 分钟计算的 GH 反事实估算，分别标实际账单差与估算供应商贡献。不得把 FLY-2681 的节省全记 Ubicloud。

### 6.4 试跑退出条件与回执模板

Lead 每日检查、7日汇总。secret泄漏/残留立即回退并按既有事件流程处理；无法起机、供应商导致连续2次 CI 失败、可调度后等待>10分钟，立即回退。满≥10个可比全量头后，p95单头耗时>GH基线1.25倍、失败率增加>2百分点或gross成本/可比头没有下降，Lead暂停扩大使用并回退调查；小样本写证据不足，不擅改阈值。容量低于33/54证明要求，维持金丝雀，不进入生产周。

一周回执固定包含：窗口/变更日志；已验证与未验证五项；实际run链接和授权/VM/secret/cache证据；上表五指标 before/after/样本数；FLY-2681混杂说明；gross/net/credit账单对账；累计回退次数与耗时；结论“继续/回退/证据不足”。未满一周、缺账单或少于10个可比头不得宣布节省已验证；Lead安排补足观察，但不把时间等待归咎于设计节点。

## 7. 实施任务与验收矩阵

1. **PR A / 测试先行**：新增 canary 合同测试、source SHA fixtures 与精确 actionlint label 配置；记录上述 mutants 的失败。实现仅手动 workflow 与独立 probe；再跑 §4.4 全部验证并提交。源步骤取落地时确认的基线，复制差异必须可审。
2. **授权后的 QA**：记录 founder/App单仓授权及账户tier/quota/cache receipt；实际 GH A/B、UBI A/B、必要capacity runs，收集API身份/日志/秘密无泄露布尔结果。失败修正须原流程评审，不改required检查逃避失败。
3. **PR B / 后依赖**：确认 FLY-2681 merged，冻结新基线→写bytes/parity负例测试→仅替换 runs-on→运行原CI合同→提交审查。任何新基线变化重做bytes对照。
4. **Lead 的受控试切与回退演练**：缺省→Ubicloud→GitHub 的真实全量 CI OK 三份回执；通知 founder 后才决定开始7日生产试跑。变量写权限属于 Lead，实施/QA只交准备结果与待执行状态。
5. **Lead 的一周回执**：按 §6 采集、分层、对账和汇报。设计节点结束时所有这些 live项均为 pending，不能涂成已通过。

| 要求 | 必需证据 | 当前设计状态 |
|---|---|---|
| 三条未验证 + 规格缓存 | §2官方日期链接；缺项有精确实测方案 | VM/规格/缓存文档已核实；私仓、额度未验证 |
| canary 真跑、哨兵、secrets | 两次UBI + 同SHA GH、writer/reader success、日志无泄漏 | 未实现/未运行，等待下游与授权 |
| 默认等价及双向切换 | 冻结基线字节比较 + 三次真实全量 CI OK | 待 FLY-2681 / PR B / Lead窗口 |
| required name及三门不变 | baseline diff + 保护API对照 + no canary CI OK | 已审计现合同；下游仍须验证 |
| 一周省钱回执 | attempt完整API数据 + 供应商账单 + 分层指标 | 方法已设计；尚无试跑账单 |

设计交付门：有效 `reviewVerdict=APPROVED` → 最终 plan/HTML/图源 commit+push → publish-only 并验证 hosted HTTP/CSP/互动层 → 向实际 Lead 报 hosted URL → `complete --route phase_design_complete` → park。设计完成不等于本 issue 生产验收完成。
