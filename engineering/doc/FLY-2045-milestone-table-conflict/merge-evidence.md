# FLY-2045 合并行为沙箱原始证据

Issue: FLY-2045
日期: 2026-08-24
基于: research.md

复现: `bash merge-sandbox.sh`(脚本随本文件一起提交,自建临时 repo,不碰本仓)。

```
################ CASE 1: top-insert into a shared table (status quo) ################
RESULT: CONFLICT

################ CASE 2: same, but .gitattributes merge=union ################
RESULT: MERGED CLEAN; file now:
| Milestone | Status |
|---|---|
| NEW-B | wip |
| NEW-A | wip |
| OLD-1 | done |
| OLD-2 | done |

################ CASE 2b: union + rebase (branch b onto a) ################
RESULT: REBASE CLEAN
| Milestone | Status |
|---|---|
| NEW-A | wip |
| NEW-B | wip |
| OLD-1 | done |
| OLD-2 | done |

################ CASE 2c: union hides a REAL semantic conflict ################
RESULT: MERGED CLEAN (silently kept BOTH contradictory rules):
rule: never ever push to main
rule: always push to main

################ CASE 3: per-issue file (one new file per PR) ################
RESULT: MERGED CLEAN
FLY-A.md
FLY-B.md
OLD-1.md
--- rebase form:
RESULT: REBASE CLEAN
FLY-A.md
FLY-B.md
OLD-1.md

################ CASE 4: append-to-bottom of shared table ################
RESULT: CONFLICT (adjacent-line adds still collide)
```
