import pathlib,subprocess,tempfile,json,hashlib
root=pathlib.Path.cwd(); rev='f022a0a7ee5a4cf42f590cbd0c90b12b84e2c854'
with tempfile.TemporaryDirectory(prefix='fly2567-original-bundle-') as d:
 t=pathlib.Path(d)
 paths=subprocess.check_output(['git','ls-tree','-r','--name-only',rev,'packages/teamlead/lead-rules-base','packages/teamlead/scripts/lead-rules-bundle.sh','packages/teamlead/scripts/inbox-ack-rule.md'],text=True).splitlines()
 for p in paths:
  dest=t/p;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(subprocess.check_output(['git','show',rev+':'+p]))
 sh='source "$1/scripts/lead-rules-bundle.sh"; FLYWHEEL_LEAD_HAS_SUMMARY_DUTY=1; rules_bundle_reset; while IFS= read -r path; do rules_bundle_add "$path" governance || exit $?; done < <(compute_lead_rule_bundle dept "$1/lead-rules-base" mailbox 1); rules_bundle_add "$1/scripts/inbox-ack-rule.md" launcher; rules_bundle_materialize "$2" dept fixture flywheel'
 subprocess.check_output(['bash','-c',sh,'fixture',str(t/'packages/teamlead'),str(t/'bundle.md')])
 body=(t/'bundle.md').read_bytes().split('═══ RULE SOURCE'.encode(),1)[1]
 body='═══ RULE SOURCE'.encode()+body
 data=dict(revision=rev,meaning='Historical shared selector and materializer, dept mailbox with summary duty plus inbox launcher rule. Body only: host paths and timestamp in metadata intentionally excluded.',bodyBytes=len(body),sha256=hashlib.sha256(body).hexdigest())
 (root/'packages/teamlead/src/__tests__/fixtures/fly2567/legacy-bundle.json').write_text(json.dumps(data,indent=2)+'\n')
