// FLY-2358 E3 · (b) 路线的技术前提:每个执行家各自的 memories_1.sqlite 是【指向共享文件的 symlink】时,
// BEGIN IMMEDIATE 锁还串不串行?SQLite unix VFS 会不会把 -wal/-shm 放到 symlink 目标旁边?
// ⛔ 纯本地 sqlite,不涉及凭据,不碰任何生产家。形状复刻 exp-phase2-lock.cjs(FLY-2119)。
const {DatabaseSync}=require('node:sqlite');
const {fork}=require('child_process');
const fs=require('fs'), os=require('os'), path=require('path');
const KIND='memory.consolidate.global', JOB_KEY='global';
const SCHEMA=`CREATE TABLE IF NOT EXISTS jobs (kind TEXT NOT NULL, job_key TEXT NOT NULL, status TEXT NOT NULL,
  worker_id TEXT, lease_until INTEGER, retry_remaining INTEGER NOT NULL, PRIMARY KEY (kind, job_key));`;
function open(db){ const d=new DatabaseSync(db); d.exec('PRAGMA journal_mode=WAL'); d.exec('PRAGMA busy_timeout=5000'); return d; }
function claim(db, worker){
  const d=open(db); const now=Math.floor(Date.now()/1000);
  try{ d.exec('BEGIN IMMEDIATE');
    const row=d.prepare('SELECT status,lease_until FROM jobs WHERE kind=? AND job_key=?').get(KIND,JOB_KEY);
    if(!row){ d.prepare(`INSERT INTO jobs VALUES (?,?,'running',?,?,3)`).run(KIND,JOB_KEY,worker,now+300); d.exec('COMMIT'); d.close(); return 'Claimed'; }
    d.exec('COMMIT'); d.close(); return (row.status==='running'&&row.lease_until>now)?'SkippedRunning':'OtherBranch';
  }catch(e){ try{d.exec('ROLLBACK');}catch(_){} try{d.close();}catch(_){} return 'ERR:'+String(e.message).slice(0,60); }
}
if(process.argv[2]==='worker'){ let r; try{ r=claim(process.argv[3],process.argv[4]); }catch(e){ r='ERR:'+String(e&&e.message||e).slice(0,60); }
  try{ process.send({worker:process.argv[4],outcome:r}); }catch(_){} process.exit(0); }
async function round(label,n,mode){
  const DIR=fs.mkdtempSync(path.join(os.tmpdir(),'fly2358-e3-'));
  const shared=path.join(DIR,'memory-point'); fs.mkdirSync(shared);
  const target=path.join(shared,'memories_1.sqlite'); open(target).exec(SCHEMA);
  const dbs=[];
  for(let i=0;i<n;i++){ const h=path.join(DIR,'home'+i); fs.mkdirSync(h);
    const f=path.join(h,'memories_1.sqlite');
    if(mode==='symlink') fs.symlinkSync(target,f); else { open(f).exec(SCHEMA); }   // copy = 各自一份(阳性对照)
    dbs.push(f); }
  const out=[]; await new Promise(res=>{ let done=0; for(let i=0;i<n;i++){ const k=fork(__filename,['worker',dbs[i],'w'+i]);
    k.on('message',m=>out.push(m)); k.on('exit',()=>{ if(++done===n) res(); }); } });
  const c=out.filter(o=>o.outcome==='Claimed').length, s=out.filter(o=>o.outcome==='SkippedRunning').length, e=out.filter(o=>o.outcome.startsWith('ERR')).length;
  const walNextToTarget=fs.existsSync(target+'-wal'), walNextToLink=fs.existsSync(dbs[0]+'-wal') && !fs.lstatSync(dbs[0]+'-wal').isSymbolicLink();
  console.log(`${label.padEnd(30)} Claimed=${c} SkippedRunning=${s} ERR=${e} 回收=${out.length}/${n}  wal@target=${walNextToTarget} wal@link=${walNextToLink}`);
  fs.rmSync(DIR,{recursive:true,force:true}); return {c,complete:out.length===n};
}
(async()=>{
  console.log('阳性对照:各家各一份(锁必须失效,证明尺子数得出 8)');
  let pos=0; for(let i=0;i<3;i++){ const r=await round(`  copy 第${i+1}轮`,8,'copy'); if(r.c>1) pos++; }
  console.log(pos===3?'  ✅ 尺子能数出多重 Claimed\n':'  ❌ 尺子数不出失效,下面结果不可解读\n');
  console.log('被测:8 个家各自的 memories_1.sqlite 都是 symlink → 同一个目标文件');
  let bad=0; for(let i=0;i<5;i++){ const r=await round(`  symlink 第${i+1}轮`,8,'symlink'); if(r.c!==1||!r.complete) bad++; }
  console.log(bad===0?'\n⇒ symlink 到共享文件时锁【串行】(恰好 1 个 Claimed),且 -wal 落在目标旁边':`\n⇒ ⚠️ ${bad} 轮不是恰好 1 个,symlink 路线的锁不成立`);
})();
