#!/bin/bash
# 盯【目录】不盯文件 —— 因为「我记得每次都要换目标」型的规矩是 bug。
# 任何 annie-*.jsonl 出现 realtime closed 就报,不管它叫什么、是第几场。
set -u
cd "$HOME/.fly1911"
REPORTED="/tmp/annie-reported.txt"; touch "$REPORTED"
for f in annie-215638 annie-215952 annie-214932; do grep -qx "$f" "$REPORTED" || echo "$f" >> "$REPORTED"; done
while true; do
  ls annie-*.jsonl >/dev/null 2>&1 || { echo "SCREAM: 匹配到 0 个 annie-*.jsonl —— 判据形状不对,不许把这个零当成「还没开始」"; exit 1; }
  for f in annie-*.jsonl; do
    tag="${f%.jsonl}"
    grep -qx "$tag" "$REPORTED" && continue
    grep -q "realtime closed" "$f" || continue
    echo "$tag" >> "$REPORTED"
    node -e "
const fs=require('fs');
const L=fs.readFileSync('$f','utf8').trim().split('\n').map(JSON.parse);
const st=L.find(x=>x.obj&&x.obj.state==='realtime started'), cl=L.find(x=>x.obj&&x.obj.state==='realtime closed');
const tx=L.filter(x=>x.dir==='TX'), sp=L.filter(x=>x.dir==='SPEAKING');
const first=sp.length?((Date.parse(sp[0].t)-Date.parse(st.t))/1000).toFixed(1):null;
console.log('DIED $tag durationMs='+(Date.parse(cl.t)-Date.parse(st.t))+' reason='+cl.obj.reason
 +' 她首次出声距会话起='+(first===null?'(全程没出声)':first+'s')
 +' 轮到了吗='+(first!==null&&Date.parse(sp[0].t)<Date.parse(cl.t)?'是':'否')
 +' TX条数='+tx.length);
for(const t of tx) console.log('   '+t.obj.role+': '+t.obj.text);
"
  done
  sleep 5
done
