#!/bin/bash
# FLY-2045 sandbox: measure conflict behaviour of the three candidate layouts.
set -u
SB="${TMPDIR:-/tmp}/fly2045-mergetest"
rm -rf "$SB"; mkdir -p "$SB"; cd "$SB" || exit 1

mkrepo() {
  cd "$SB" || exit 1; rm -rf "$1"; mkdir -p "$1"; cd "$SB/$1" || exit 1
  git init -q -b main .
  git config user.email t@t; git config user.name t
}

echo "################ CASE 1: top-insert into a shared table (status quo) ################"
mkrepo case1
printf '| Milestone | Status |\n|---|---|\n| OLD-1 | done |\n| OLD-2 | done |\n' > TABLE.md
git add -A; git commit -qm base
git checkout -qb a
sed -i '' '2a\
| NEW-A | wip |
' TABLE.md; git commit -qam a
git checkout -q main; git checkout -qb b
sed -i '' '2a\
| NEW-B | wip |
' TABLE.md; git commit -qam b
if git merge a -m m >/dev/null 2>&1; then echo "RESULT: MERGED CLEAN"; else echo "RESULT: CONFLICT"; git merge --abort; fi

echo
echo "################ CASE 2: same, but .gitattributes merge=union ################"
mkrepo case2
printf '| Milestone | Status |\n|---|---|\n| OLD-1 | done |\n| OLD-2 | done |\n' > TABLE.md
printf 'TABLE.md merge=union\n' > .gitattributes
git add -A; git commit -qm base
git checkout -qb a
sed -i '' '2a\
| NEW-A | wip |
' TABLE.md; git commit -qam a
git checkout -q main; git checkout -qb b
sed -i '' '2a\
| NEW-B | wip |
' TABLE.md; git commit -qam b
if git merge a -m m >/dev/null 2>&1; then
  echo "RESULT: MERGED CLEAN; file now:"; cat TABLE.md
else
  echo "RESULT: CONFLICT"; git merge --abort
fi

echo
echo "################ CASE 2b: union + rebase (branch b onto a) ################"
cd "$SB/case2" || exit 1
git checkout -q main; git checkout -qb b2 b 2>/dev/null || true
git reset -q --hard b
if git rebase a >/dev/null 2>&1; then echo "RESULT: REBASE CLEAN"; cat TABLE.md; else echo "RESULT: REBASE CONFLICT"; git rebase --abort; fi

echo
echo "################ CASE 2c: union hides a REAL semantic conflict ################"
mkrepo case2c
printf 'rule: never push to main\n' > RULES.md
printf 'RULES.md merge=union\n' > .gitattributes
git add -A; git commit -qm base
git checkout -qb a
printf 'rule: always push to main\n' > RULES.md; git commit -qam a
git checkout -q main; git checkout -qb b
printf 'rule: never ever push to main\n' > RULES.md; git commit -qam b
if git merge a -m m >/dev/null 2>&1; then echo "RESULT: MERGED CLEAN (silently kept BOTH contradictory rules):"; cat RULES.md; else echo "RESULT: CONFLICT"; git merge --abort; fi

echo
echo "################ CASE 3: per-issue file (one new file per PR) ################"
mkrepo case3
mkdir -p milestones
printf 'see milestones/\n' > INDEX.md
printf '| OLD-1 | done |\n' > milestones/OLD-1.md
git add -A; git commit -qm base
git checkout -qb a
printf '| NEW-A | wip |\n' > milestones/FLY-A.md; git add -A; git commit -qm a
git checkout -q main; git checkout -qb b
printf '| NEW-B | wip |\n' > milestones/FLY-B.md; git add -A; git commit -qm b
if git merge a -m m >/dev/null 2>&1; then echo "RESULT: MERGED CLEAN"; ls milestones/; else echo "RESULT: CONFLICT"; git merge --abort; fi
echo "--- rebase form:"
git reset -q --hard b
if git rebase a >/dev/null 2>&1; then echo "RESULT: REBASE CLEAN"; ls milestones/; else echo "RESULT: REBASE CONFLICT"; git rebase --abort; fi

echo
echo "################ CASE 4: append-to-bottom of shared table ################"
mkrepo case4
printf '| Milestone | Status |\n|---|---|\n| OLD-1 | done |\n' > TABLE.md
git add -A; git commit -qm base
git checkout -qb a
printf '| NEW-A | wip |\n' >> TABLE.md; git commit -qam a
git checkout -q main; git checkout -qb b
printf '| NEW-B | wip |\n' >> TABLE.md; git commit -qam b
if git merge a -m m >/dev/null 2>&1; then echo "RESULT: MERGED CLEAN"; else echo "RESULT: CONFLICT (adjacent-line adds still collide)"; git merge --abort; fi
