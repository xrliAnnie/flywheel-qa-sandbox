import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { planGuard, git, put } from './guard-model.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
const results = [];
for (const mode of ['excludes-file', 'uppercase-ignore', 'index-added-file-to-dir', 'head-removed-file-to-dir', 'head-preserved-file-to-dir']) {
 const root = fs.mkdtempSync(path.join(here, mode + '-'));
 git(root, 'init', '-q', '-b', 'main');
 git(root, 'config', 'user.name', 'Review'); git(root, 'config', 'user.email', 'review@example.invalid');
 put(root, 'tracked', 'base\n');
 if (mode === 'excludes-file') {
  put(root, '.gitignore', '# stable\n');
  put(root, 'project.ignore', 'drafts/\n');
  git(root, 'config', 'core.excludesFile', path.join(root, 'project.ignore'));
 } else if (mode === 'uppercase-ignore') {
  put(root, '.GITIGNORE', 'drafts/\n');
 } else {
  put(root, '.gitignore', 'drafts/\n');
  if (mode.startsWith('head-')) put(root, 'drafts', 'old tracked bytes\n');
 }
 git(root, 'add', '-f', '.'); git(root, 'commit', '-qm', 'H');
 const H=git(root, 'rev-parse', 'HEAD').trim();
 if (mode === 'excludes-file') put(root, 'project.ignore', '# no ignore\n');
 else if (mode === 'uppercase-ignore') put(root, '.GITIGNORE', '# no ignore\n');
 else if (mode === 'head-removed-file-to-dir') git(root, 'rm', 'drafts');
 put(root, 'tracked', 'target\n'); git(root, 'add', '-A'); git(root, 'commit', '-qm', 'S');
 const S=git(root, 'rev-parse', 'HEAD').trim();
 git(root, 'reset', '--hard', H);
 if (mode === 'index-added-file-to-dir') { put(root, 'drafts', 'staged addition\n'); git(root, 'add', '-f', 'drafts'); fs.unlinkSync(path.join(root,'drafts')); }
 if (mode.startsWith('head-')) fs.unlinkSync(path.join(root,'drafts'));
 put(root, 'drafts/unpublished.md', 'UNIQUE NEVER COMMITTED\n');
 const beforeStatus=git(root,'status','--porcelain=v2');
 const guard=planGuard(root,H,S);
 const reset=git(root,'reset','--hard',S);
 const afterReset=fs.existsSync(path.join(root,'drafts/unpublished.md'));
 const clean=git(root,'clean','-fd');
 const afterClean=fs.existsSync(path.join(root,'drafts/unpublished.md'));
 const result={mode,root,H,S,beforeStatus,guard,reset,afterReset,clean,afterClean,ignoreCase:git(root,'config','--get','core.ignorecase').trim()};
 results.push(result); console.log(JSON.stringify(result));
}
fs.writeFileSync(path.join(here,'boundary-results.json'),JSON.stringify(results,null,2)+'\n');
