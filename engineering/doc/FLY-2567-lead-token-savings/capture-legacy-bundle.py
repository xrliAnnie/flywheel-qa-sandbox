import pathlib,subprocess,tempfile,json,hashlib,argparse
parser=argparse.ArgumentParser()
parser.add_argument("--intake-overlay", type=pathlib.Path)
args=parser.parse_args()
approved_digest="24d7b1928661a4952de3e721b684d703452c86dd25037bd9f1f6ea2631f902a6"
overlay=args.intake_overlay.read_bytes() if args.intake_overlay else None
if overlay is not None and hashlib.sha256(overlay).hexdigest() != approved_digest:
 raise SystemExit("unapproved_intake_overlay")
root=pathlib.Path.cwd(); rev='f022a0a7ee5a4cf42f590cbd0c90b12b84e2c854'
source_manifest=root/'engineering/doc/FLY-2567-lead-token-savings/evidence/rework-legacy-sources.json'
source_data=json.loads(source_manifest.read_text())
if source_data['legacyRevision'] != rev:
 raise SystemExit('unexpected_legacy_revision')
patrol_path='packages/teamlead/lead-rules-base/runner-patrol-rules.md'
anchor=b'\n---\n\n## 1. Proactive patrol'
original_patrol=subprocess.check_output(['git','show',rev+':'+patrol_path])
evolved_patrol=original_patrol
if overlay is not None:
 if original_patrol.count(anchor) != 1 or b'### 0.11 Epic' in original_patrol:
  raise SystemExit('ambiguous_intake_overlay_anchor')
 evolved_patrol=original_patrol.replace(anchor,b'\n'+overlay+anchor)
 if evolved_patrol.replace(b'\n'+overlay,b'',1) != original_patrol:
  raise SystemExit('historical_bytes_changed')
 if (root/'packages/teamlead/lead-rules-base/legacy-token-savings/runner-patrol-rules.md').read_bytes() != evolved_patrol:
  raise SystemExit('off_source_does_not_match_approved_evolution')
for entry in source_data['sources']:
 content=evolved_patrol if entry['path']==patrol_path else subprocess.check_output(['git','show',rev+':'+entry['path']])
 entry['revision']=rev
 entry['bytes']=len(content)
 entry['sha256']=hashlib.sha256(content).hexdigest()
source_data.pop('intakeOverlay',None)
if overlay is not None:
 source_data['intakeOverlay']={'approvedSectionSha256':approved_digest,'beforeSourceSha256':hashlib.sha256(original_patrol).hexdigest(),'afterSourceSha256':hashlib.sha256(evolved_patrol).hexdigest(),'meaning':'Historical source bytes preserved, with only the approved FLY-2557 section 0.11 added under Lead ruling dd6d00cc.'}
with tempfile.TemporaryDirectory(prefix='fly2567-original-bundle-') as d:
 t=pathlib.Path(d)
 paths=subprocess.check_output(['git','ls-tree','-r','--name-only',rev,'packages/teamlead/lead-rules-base','packages/teamlead/scripts/lead-rules-bundle.sh','packages/teamlead/scripts/inbox-ack-rule.md'],text=True).splitlines()
 for p in paths:
  dest=t/p;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(subprocess.check_output(['git','show',rev+':'+p]))
 if overlay is not None:
  (t/patrol_path).write_bytes(evolved_patrol)
 sh='source "$1/scripts/lead-rules-bundle.sh"; FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=1; rules_bundle_reset; while IFS= read -r path; do rules_bundle_add "$path" governance || exit $?; done < <(compute_lead_rule_bundle dept "$1/lead-rules-base" mailbox 1); rules_bundle_add "$1/scripts/inbox-ack-rule.md" launcher; rules_bundle_materialize "$2" dept fixture flywheel'
 subprocess.check_output(['bash','-c',sh,'fixture',str(t/'packages/teamlead'),str(t/'bundle.md')])
 body=(t/'bundle.md').read_bytes().split('═══ RULE SOURCE'.encode(),1)[1]
 body='═══ RULE SOURCE'.encode()+body
 data=dict(revision=rev,meaning='Historical shared selector and materializer, dept mailbox with summary duty plus inbox launcher rule. Body only: host paths and timestamp in metadata intentionally excluded.',bodyBytes=len(body),sha256=hashlib.sha256(body).hexdigest())
 if overlay is not None:
  data['meaning'] += ' Additive FLY-2557 section 0.11 evolution; all other historical rule bytes preserved.'
  data['intakeOverlay']=source_data['intakeOverlay']
 source_manifest.write_text(json.dumps(source_data,indent=2)+'\n')
 (root/'packages/teamlead/src/__tests__/fixtures/fly2567/legacy-bundle.json').write_text(json.dumps(data,indent='\t')+'\n')
