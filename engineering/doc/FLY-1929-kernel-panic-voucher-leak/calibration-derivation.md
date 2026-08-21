# FLY-1929 分子标定 — 原始 capture 与推导(可复核)

Issue: FLY-1929 (https://linear.app/geoforge3d/issue/FLY-1929/infra宿主-内核-panic-致-0135-全机重启-ipc-voucher-泄漏打满-ivac-entries)
日期: 2026-08-20
基于: plan.md §1.3

Codex R6 MEDIUM advisory:仓库里只有聚合结论、没有原始 capture,承重的标定就无法被独立复核。此文件补上。

## capture

- 文件:`calibration-720-samples.ndjson.txt`
- 行数:720
- sha256:`d42071e1b5f789597ae32e0fcfa07d7f62a70f362e6392b3e54bc4f47479538c`
- 采样节奏:每 5 秒一次
- 宿主:Mac17,8 / macOS 26.6.2 (25G83) / 内核 `xnu-12377.161.14`
- 采集期间宿主状态:生产舰队在跑(约 1000–1180 个进程),期间包含一次 `ecosystemanalyticsd` 重启

**已知污染**:07:42–07:51 PT 一段是运维手工 attach 20 个 cmux pane 造成的人为抬升
(每个 attach client 约 +430)。标定用的是**三个 zone 之间的关系**(差值),
不是绝对速率,所以这段污染不影响本文件的结论;但**不得**拿这份 capture 去算泄漏速率。

## 采集命令(等价形式)

```bash
zprint | awk '$1=="bank_task"{b=$7} $1=="bank_account"{a=$7} $1=="ipc.vouchers"{v=$7} END{print b,a,v}'
ps -axo pid=,comm=            # nproc
```

zprint 列序:zone name / elem size / cur size / max size / cur #elts / max #elts / **cur inuse($7)** / alloc size / alloc count

## 推导命令(逐字可复跑)

```bash
python3 - <<'PY'
import re,statistics
rows=[]
for ln in open("calibration-720-samples.ndjson.txt"):
    m=re.match(r'(\S+) bank=(\d+) acct=(\d+) vouch=(\d+) nproc=(\d+)',ln)
    if m: rows.append((m.group(1),*map(int,m.groups()[1:])))
d1=[b-a for _,b,a,v,n in rows]
d2=[(b-a)-n for _,b,a,v,n in rows]
d3=[v-a for _,b,a,v,n in rows]
print("samples",len(rows))
for name,d in (("bank_task-bank_account",d1),("that-nproc",d2),("vouchers-bank_account",d3)):
    print(name,"min",min(d),"med",statistics.median(d),"max",max(d))
print("bank_task>=bank_account all:", all(b>=a for _,b,a,v,n in rows))
print("bank_task>=vouchers     all:", all(b>=v for _,b,a,v,n in rows))
PY
```

## 结论(与 plan.md §1.3 一致)

| 关系 | min | median | max |
|---|---|---|---|
| `bank_task − bank_account` | 742 | 956 | 1097 |
| 上一行再减 `nproc` | −353 | −227 | −177 |
| `ipc.vouchers − bank_account` | 52 | 62 | 79 |

`bank_task >= bank_account` 与 `bank_task >= ipc.vouchers` 均 720/720 成立。
`bank_task` 跨度 1176 – 14693(约 12 倍动态范围)。

定稿分子 = `bank_task + bank_account`(对象支撑非默认 BANK 值的**上包络**,不是等式;
详见 plan.md §1.3 的 R6 更正 —— 我原来声称的「下界」是错的,已删)。

## XNU 版本的诚实声明

宿主内核是 `xnu-12377.161.14`;评审期可取到的公开源码修订是 `xnu-12377.121.6` / `main`。
故源码层结论对宿主构建而言是**由邻近已发布修订作出的推断**,不是对宿主确切构建的源码验证。
