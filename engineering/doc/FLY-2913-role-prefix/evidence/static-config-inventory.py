#!/usr/bin/env python3
"""Bounded metadata-only inventory. Never emits config values, hooks, auth, prompts, or description text."""
import pathlib,json,hashlib,re,datetime,argparse
ap=argparse.ArgumentParser();ap.add_argument('--repo',type=pathlib.Path,required=True);ap.add_argument('--output',type=pathlib.Path,required=True);a=ap.parse_args();h=pathlib.Path.home()
out={'capturedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'evidenceKind':'configured-files-only; NOT actual loaded tool/schema/token inventory','configs':[],'plugins':[],'skills':[],'agents':[],'rules':[],'claudeMd':[]}
def meta(p):
 b=p.read_bytes();return {'path':str(p),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()}
def front(p):
 x=meta(p);s=p.read_text(errors='replace');fm=s.split('---',2)[1] if s.startswith('---') and s.count('---')>=2 else '';name=re.search(r'^name:\s*(.*)$',fm,re.M);desc=re.search(r'^description:\s*([^\n]*(?:\n[ \t]+[^\n]*)*)',fm,re.M);x['name']=name.group(1).strip(' "\'') if name else p.parent.name if p.name=='SKILL.md' else p.stem;x['descriptionSourceBytes']=len(desc.group(1).encode()) if desc else 0;x['descriptionMeasurement']='UTF-8 bytes of raw YAML value including indentation; not token count';return x
settings={}
for p in [h/'.claude/settings.json',h/'.claude/settings.local.json',h/'.claude.json',a.repo/'.claude/settings.json',a.repo/'.claude/settings.local.json',a.repo/'.mcp.json']:
 if not p.is_file():continue
 j=json.loads(p.read_text());x=meta(p);x['enabledPlugins']=j.get('enabledPlugins',{});x['mcpServerNames']=list(j.get('mcpServers',{}));out['configs'].append(x)
 if p==h/'.claude/settings.json':settings=j
installed=h/'.claude/plugins/installed_plugins.json';roster=json.loads(installed.read_text()).get('plugins',{})
for name,records in roster.items():
 enabled=settings.get('enabledPlugins',{}).get(name) is True
 for r in records:
  root=pathlib.Path(r['installPath']);x={'key':name,'enabledInUserSettings':enabled,'scope':r.get('scope'),'version':r.get('version'),'installPath':str(root),'mcpServerNames':[]}
  for f in [root/'.mcp.json',root/'.claude-plugin/plugin.json']:
   if f.is_file():
    try:
     j=json.loads(f.read_text());servers=j.get('mcpServers',j if f.name=='.mcp.json' else {});x['mcpServerNames']+=list(servers) if isinstance(servers,dict) else []
    except (ValueError,OSError):pass
  out['plugins'].append(x)
  if enabled:
   for p in (root/'skills').glob('*/SKILL.md'):out['skills'].append(dict(front(p),scope='enabled-plugin',plugin=name))
   for p in (root/'agents').rglob('*.md'):out['agents'].append(dict(front(p),scope='enabled-plugin',plugin=name))
for root,scope in [(h/'.claude','user'),(a.repo/'.claude','worktree')]:
 for p in (root/'skills').glob('*/SKILL.md'):out['skills'].append(dict(front(p),scope=scope))
 for p in (root/'agents').rglob('*.md'):out['agents'].append(dict(front(p),scope=scope))
 for p in (root/'rules').rglob('*.md'):out['rules'].append(dict(meta(p),scope=scope))
for p in [h/'.claude/CLAUDE.md',a.repo/'CLAUDE.md',a.repo/'CLAUDE.local.md',a.repo/'.claude/CLAUDE.md']:
 if p.is_file():out['claudeMd'].append(meta(p))
out['summary']={'enabledPluginKeys':[p['key'] for p in out['plugins'] if p['enabledInUserSettings']],'skillCandidates':len(out['skills']),'skillDescriptionSourceBytes':sum(s['descriptionSourceBytes'] for s in out['skills']),'agentCandidates':len(out['agents']),'agentDescriptionSourceBytes':sum(s['descriptionSourceBytes'] for s in out['agents']),'ruleFiles':len(out['rules']),'ruleBytes':sum(r['bytes'] for r in out['rules']),'claudeMdBytes':sum(r['bytes'] for r in out['claudeMd'])}
a.output.write_text(json.dumps(out,ensure_ascii=False,indent=2));print(json.dumps(out['summary'],ensure_ascii=False,indent=2))
