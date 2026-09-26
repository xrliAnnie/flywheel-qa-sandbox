"""Read-only fixed-string consumer discovery; writes only /tmp evidence intermediates.
Every production file contributes full-path, filename and parent-directory queries.
One batched git grep preserves the exact -lF union without rescanning the tree 3N times.
"""
import subprocess, pathlib, json, re, hashlib, datetime
root=pathlib.Path.cwd()
def git(*args):
 p=subprocess.run(['git',*args],capture_output=True,check=False)
 if p.returncode not in (0,1): raise RuntimeError(p.stderr.decode())
 return p.stdout.decode()
base=git('merge-base','origin/main','HEAD').strip();head=git('rev-parse','HEAD').strip()
changed=sorted(set(git('diff','--name-only','-z',base,'--').split('\0')+git('ls-files','--others','--exclude-standard','-z').split('\0'))-{''})
def test_file(f):
 return bool(re.search(r'(?:\.test|\.spec)\.(?:[cm]?[jt]sx?|sh|py)$',f) or re.search(r'(?:^|/)test[-_][^/]+\.(?:sh|py)$',f)) and '/fixtures/' not in f
def production(f):
 return bool(re.search(r'\.(?:tsx?|mts|cts)$',f)) and not test_file(f) and not any(p in pathlib.PurePosixPath(f).parts for p in ('__tests__','test','tests','fixtures')) and pathlib.Path(f).is_file()
production_files=[f for f in changed if production(f)]
query_map={f:[('full_path',f),('filename',pathlib.PurePosixPath(f).name),('parent_directory',str(pathlib.PurePosixPath(f).parent))] for f in production_files}
pathspec=['--','.',':!engineering/doc/FLY-2886-voice-brain-agent/evidence/related-test-*',':!engineering/doc/FLY-2886-voice-brain-agent/evidence/retained-*',':!engineering/doc/FLY-2886-voice-brain-agent/evidence/changed-production-*']
args=['grep','-lF','-z','--untracked','--exclude-standard']
for q in sorted(set(q for queries in query_map.values() for kind,q in queries)):args+=['-e',q]
args+=pathspec
matched_paths=list(filter(None,git(*args).split('\0')))
texts={f:(root/f).read_text(errors='replace') for f in matched_paths if (root/f).is_file()}
rows=[]
for f,qlist in query_map.items():
 row={'file':f,'sha256':hashlib.sha256((root/f).read_bytes()).hexdigest(),'queries':[{'kind':kind,'query':q,'batchedCommandIndex':0} for kind,q in qlist],'matches':[]}
 for path,text in sorted(texts.items()):
  kinds=[kind for kind,q in qlist if q in text]
  if not kinds:continue
  is_test=test_file(path);m={'path':path,'queryKinds':kinds,'isTest':is_test}
  if is_test:
   m['matchingLines']=[{'line':i+1,'text':line[:1200],'queryKinds':[kind for kind,q in qlist if q in line]} for i,line in enumerate(text.splitlines()) if any(q in line for _,q in qlist)][:12]
  row['matches'].append(m)
 rows.append(row)
data={'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'root':str(root),'mergeBase':base,'head':head,'changedFiles':changed,'batchedCommands':[['git',*args]],'productionFiles':rows}
pathlib.Path('/tmp/fly2886-scope-raw.json').write_text(json.dumps(data,indent=2,ensure_ascii=False)+'\n')
print(json.dumps({'productionFiles':len(rows),'uniqueMatchedPaths':len(texts)}))
