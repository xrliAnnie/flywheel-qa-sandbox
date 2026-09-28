#!/bin/zsh -f
# Dry-run the FLY-2984 plan §3.1–3.3 blocks against a local bare "origin".
# Everything runs in a fresh temp dir; nothing is written inside the repo.
P=${0:A:h}/plan.md
S=$(mktemp -d "${TMPDIR:-/tmp}/fly2984-dry.XXXXXX") || exit 1
blk() { awk -v a="^### $1" -v b="^### $2" '$0~a{f=1;next} $0~b{f=0} f' $P | awk '/^```zsh/{i=1;next} /^```/{i=0} i'; }
blk 3.1 3.2 > $S/defs.zsh
blk 3.2 3.3 | grep -v '^run_step 1 &&' > $S/step.zsh
blk 3.3 3.4 > $S/verify.zsh
mkdir -p $S/bin
cat > $S/bin/node <<'EOF'
#!/bin/zsh -f
f=engineering/doc/FLY-2984-runner-lifecycle-note/progress.md; c=${@[(i)--cursor]}; c=${@[c+1]}; print -l -- '---' 'phase: implement' "phaseCursor: $c" '---' > $f; git add $f; git commit -qm "chore(progress): stub $c" -- $f
EOF
chmod +x $S/bin/node
export PATH=$S/bin:$PATH FLYWHEEL_COMM_CLI=x FLYWHEEL_EXEC_ID=x
git init -q --bare $S/origin.git
git clone -q $S/origin.git $S/w 2>/dev/null
cd $S/w
git checkout -q -b project-slot-2-FLY-2984
mkdir -p engineering/doc/FLY-2984-runner-lifecycle-note
echo base > README; git add -A; git commit -qm base; git push -q origin project-slot-2-FLY-2984
source $S/defs.zsh; source $S/step.zsh

print "== scenario F: crash after first write (untracked qa-sandbox/), §3.0 check must be clean"
mkdir -p qa-sandbox; expect 1 > $F
print "raw=[$(git status --porcelain)] precheck=[$(git status --porcelain --untracked-files=all -- . ":(exclude)$F")]"
print "== scenario A: crash after write before commit in step 2"
run_step 1
expect 2 > $F          # simulate write, then 'crash'
print "state=$(state)"
run_step 1 && run_step 2 && run_step 3
print "== scenario B: crash after commit before push in step 3 (simulate by resetting remote)"
git push -q -f origin HEAD~2:refs/heads/project-slot-2-FLY-2984  # remote behind
run_step 1 && run_step 2 && run_step 3
print "== rerun (idempotent)"
run_step 1 && run_step 2 && run_step 3
print "== rerun step1 only after done (must not regress ledger)"
run_step 1; grep phaseCursor $LEDGER
print "== verify"
source $S/verify.zsh
print "== log"; git log --oneline --format='%h %s' | head -20
print "== file bytes"; od -c $F | tail -3
print "== scenario E: remote unreadable must STOP, not OK"
git remote set-url origin $S/missing.git; run_step 3; print "rc=$?"; git remote set-url origin $S/origin.git
print "== scenario C: unknown content"
echo junk >> $F; run_step 3; print "rc=$?"; git checkout -q -- $F
print "== scenario D: other file dirty"
echo x > other.txt; git add other.txt; expect 3 > $F; run_step 3; print "rc=$?"
