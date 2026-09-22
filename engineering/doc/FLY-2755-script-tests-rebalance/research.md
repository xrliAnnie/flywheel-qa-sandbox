# FLY-2755 Script Tests 六片再平衡 — 调研
Issue: FLY-2755 (https://linear.app/geoforge3d/issue/FLY-2755/main-红挡全部-pr-script-tests-35-分片耗时-1036s-超预算-1020sfly-1870-容量闸1260-合入后)
日期: 2026-09-18
基于: exploration.md

## 1. 权威失败证据

main run `35419985906` 绑定 head
`487799b801f3147748b1c6188cadd0c035226c1e`：

- 3/5 从 start-file 到 tripwire 为 1036s，usage 86%，所有 36 条 tripwire
  自测以及前置 suite 均已通过；失败只来自容量门。
- 1/5 在 FLY-1572 step 内报 `jq: parse error: Invalid numeric literal at line
  12, column 10`，GitHub step 退出 5；同一 job 的 tripwire 因提前停止只记录
  176s，不能用于该片容量判断。
- 2/5、4/5、5/5 的 job wall time 分别为 993s、599s、754s。wall time
  包含 record-start 之前和 tripwire 之后的少量开销，容量模型改用逐 step
  timestamp，最终验收只认 tripwire 自报 elapsed。

## 2. 五片容量历史

从 GitHub Actions jobs API 读取四个完整近期 run 和当前失败 run：

| run | 1/5 | 2/5 | 3/5 | 4/5 | 5/5 | 结果 |
|---|---:|---:|---:|---:|---:|---|
| 35404015407 | 737 | 997 | 987 | 570 | 768 | green |
| 35410420823 | 644 | 899 | 875 | 495 | 762 | green |
| 35412663528 | 623 | 984 | 811 | 612 | 618 | green |
| 35408506888 | 726 | 985 | 938 | 545 | 770 | PR #1260 green |
| 35419985906 | 失败于 176 | 993 | 1043 | 599 | 754 | main red |

单位为 job wall seconds。四个完整 run 的测试 step 总耗时为 2992–3311s，
五片公共开销合计 656–748s（131–150s/片均值）。现有五片里 2/5、3/5
反复超过用户要求的 70% cap（840s）；第六片为后续增长恢复明确余量。

## 3. 六片装箱模型

### 3.1 权重与约束

- 对 105 个当前 Test/Integration named step，取五个 run 中成功样本的
  75 分位秒数；当前 main 在 1/5 失败后 skipped 的后续 step 不参与该轮样本。
- 按权重降序执行 LPT，完整 step 为不可拆原子。
- 含 FLY-2007 的目标组绑定 `script-tests`，继续 full-history checkout。
- 含 FLY-1364 的目标组绑定 `script-tests-4`；FLY-2444、FLY-2146 分别尽量
  保留在原有 2、5 号 job，减少特定结构断言改动。
- 每组的 75 分位测试权重均为 565s；零秒表示 GitHub timestamp 分辨率下
  小于一秒，不代表删除或跳过。

### 3.2 目标组

| job | 主要长步骤 | named steps | p75 测试秒数 |
|---|---|---:|---:|
| 1/6 | FLY-1389、2598 host、1496、2007 | 15 | 565 |
| 2/6 | FLY-2331、2444、2598 coexistence、1081 | 15 | 565 |
| 3/6 | FLY-1434、payload install、1501、1678 | 15 | 565 |
| 4/6 | FLY-1364、2404，加短合同组 | 31 | 565 |
| 5/6 | FLY-1855、1929、1986、2146、1572 | 14 | 565 |
| 6/6 | FLY-1663、1814、1726、2274 | 15 | 565 |

完整顺序由 plan.md 的固定 inventory 定义，`ci-structure.test.sh` 将它作为
exact census：union=105、无缺失、无重复、每个完整 step 对象只换 owner。

### 3.3 历史回放投影

将新分组应用到四个完整 run 的实际 step timestamp，并给每片统一加上该轮
五片中最大的公共开销，得到保守投影：

| run | 1/6 | 2/6 | 3/6 | 4/6 | 5/6 | 6/6 |
|---|---:|---:|---:|---:|---:|---:|
| 35408506888 | 704 | 700 | 698 | 662 | 676 | 698 |
| 35412663528 | 638 | 656 | 679 | 685 | 609 | 619 |
| 35410420823 | 636 | 665 | 683 | 598 | 641 | 652 |
| 35404015407 | 727 | 734 | 726 | 657 | 726 | 731 |

最慢旧轮的 job-wall 公共开销是 165s，且包含 tripwire 区间外时间，因此上表
不是通过/失败判据。四轮保守投影最高 734s（约 61% cap），低于用户要求的
`usage ≤70%`，但 exact-head 真机仍是不可替代的验收门。若某片超过 840s，
只根据该 run 的实际 step timestamp 在六片间移动完整 named step，不改变
cap/threshold/测试内容。

## 4. FLY-1572 exit 5 根因

### 4.1 复现与对照

- PR #1260 exact-head run `35408506888`：同一套件 14s PASS。
- 含后续 `db.ts` 自动批准改动的 main run `35412663528`：1/5 PASS，排除该
  schema 改动稳定触发回归。
- 当前 worktree 在 `pnpm install --frozen-lockfile && pnpm -r build` 后连续
  三次运行套件，13–21s，全部 PASS。
- main 失败日志没有业务断言文本，只有 `jq` parse error；测试的最后一段把
  成功迁移命令写成 command substitution 加 `2>&1`，再把合并后的文本直接
  送给 `jq`。

### 4.2 定性

这是测试 harness 的通道竞态/flake，不是 mailbox migration 业务回归：CLI
约定 stdout 为 JSON、stderr 为诊断，但测试在 migrated-success case 将两者
合并。`openCommDbWritable` 安装的 SQL timing hook 会在查询超过 250ms 时用
`console.warn` 打印 `[slow-sql]`；其前缀恰好使 jq 报 `line 12, column 10`，
与 CI 逐字一致。因此这是机器负载触发的 harness flake，不是业务迁移回归。

### 4.3 可执行修复

在现有 shell suite 内先在成功 CLI 输出后注入一条 `[slow-sql]` stderr fixture；
保持 `2>&1` 时 `jq` 必须以同形 exit 5 变红。随后把 stdout 捕获到 `MIGRATED_OUTPUT`、
stderr 捕获到独立文件，先断言命令 rc=0、再只解析 stdout，并断言 fixture
确实到达 stderr 文件。业务 JSON/state/permission/negative guards 全部保留。

这既不改迁移 CLI，也不把真实非零退出吞掉；它只恢复 POSIX 输出通道边界。

## 5. 需要同步的静态合同

1. `.github/workflows/ci.yml`：增加 `script-tests-6`，六片复制同一 setup、
   timeout 与 tripwire；移动完整 named step；CI OK needs/jq 纳入第六片。
2. `.github/ci-required-jobs.json`：required heavy checks 改为 1/6…6/6。
3. `scripts/__tests__/ci-structure.test.sh`：job ids/order、required checks、
   aggregate、timeout/setup/tripwire 遍历和 exact shard inventory 全部扩为六片。
4. `scripts/__tests__/ci-shell-suite-enumeration.test.sh` 继续证明每个 tracked
   shell suite 都至少登记一次；`ci-structure` 负责恰好一次及 owner 清单。
5. `.github/workflows/ci-ubicloud-canary.yml` 不属于 required 1–6 分片图，
   本任务不顺带重构；其 fixture 只有在现有 guard 明确要求 parity 时才同步。

## 6. 验收证据层级

- RED/GREEN：结构 inventory 先改后红、workflow 后绿；stderr fixture 在旧
  合流下红、分流后绿。
- 本地：结构、shell enumeration、tripwire、mailbox（重复）、lint、build、
  package aggregate。
- 评审：当前实现 head 的有效 code review。
- PR：最终 frozen head 的 exact-head CI 六片绿，并从每片 tripwire 日志记录
  elapsed/usage；不能用 job projection 替代。
