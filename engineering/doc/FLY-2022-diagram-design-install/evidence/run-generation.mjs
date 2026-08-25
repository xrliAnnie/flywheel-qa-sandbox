#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
	existsSync,
	lstatSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const evidenceDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(evidenceDir, "../../../..");
const [mode, requestName, outputName] = process.argv.slice(2);

if (!['explicit', 'natural'].includes(mode) || !requestName || !outputName) {
	console.error('usage: node run-generation.mjs explicit|natural <request.md> <output.html>');
	process.exit(2);
}

function evidencePath(name) {
	const path = resolve(evidenceDir, name);
	if (path !== evidenceDir && !path.startsWith(`${evidenceDir}${sep}`)) {
		throw new Error(`evidence path escapes task folder: ${name}`);
	}
	return path;
}

const requestPath = evidencePath(requestName);
const outputPath = evidencePath(outputName);
const stem = mode === 'explicit' ? 'explicit' : 'natural';
const transcriptPath = evidencePath(`${stem}-transcript.jsonl`);
const stderrPath = evidencePath(`${stem}-stderr.log`);
const statusPath = evidencePath(`${stem}-generation-evidence.json`);

for (const path of [outputPath, transcriptPath, stderrPath, statusPath]) {
	if (existsSync(path)) {
		throw new Error(`refusing to overwrite generation evidence: ${relative(repoRoot, path)}`);
	}
}

function digest(value) {
	return createHash('sha256').update(value).digest('hex');
}

function fingerprint(path) {
	if (!existsSync(path)) return { exists: false };
	const hash = createHash('sha256');
	let files = 0;

	function visit(current, logical) {
		const stat = lstatSync(current);
		if (stat.isSymbolicLink()) {
			hash.update(`L\0${logical}\0${readlinkSync(current)}\0`);
			files += 1;
			return;
		}
		if (stat.isDirectory()) {
			hash.update(`D\0${logical}\0`);
			for (const entry of readdirSync(current).sort()) {
				visit(resolve(current, entry), logical ? `${logical}/${entry}` : entry);
			}
			return;
		}
		hash.update(`F\0${logical}\0${stat.mode & 0o777}\0`);
		hash.update(readFileSync(current));
		files += 1;
	}

	visit(path, '');
	return { exists: true, files, sha256: hash.digest('hex') };
}

const home = homedir();
const watched = {
	agentLock: resolve(home, '.agents/.skill-lock.json'),
	agentSkill: resolve(home, '.agents/skills/diagram-design'),
	claudeSkill: resolve(home, '.claude/skills/diagram-design'),
	codexSkill: resolve(home, '.codex/skills/diagram-design'),
	defaultProfile: resolve(home, '.diagram-design/profiles/default.md'),
};

function snapshot() {
	return {
		projectSkill: fingerprint(resolve(repoRoot, '.claude/skills/diagram-design')),
		projectConfig: fingerprint(resolve(repoRoot, '.diagram-design')),
		userPaths: Object.fromEntries(
			Object.entries(watched).map(([name, path]) => [name, fingerprint(path)]),
		),
	};
}

const before = snapshot();
const prompt = readFileSync(requestPath, 'utf8');
const claudeArgs = [
	'-p',
	'--no-session-persistence',
	'--no-chrome',
	'--output-format',
	'stream-json',
	'--verbose',
	'--permission-mode',
	'acceptEdits',
	'--allowedTools',
	'Skill,Read,Write,Edit,Glob,Grep,Bash(python3 .claude/skills/diagram-design/scripts/self_check.py:*)',
	'--disallowedTools',
	'WebFetch,WebSearch',
];

const startedAt = new Date().toISOString();
const child = spawn('claude', claudeArgs, {
	cwd: repoRoot,
	env: process.env,
	stdio: ['pipe', 'pipe', 'pipe'],
});
const stdoutChunks = [];
const stderrChunks = [];
child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
child.stderr.on('data', (chunk) => stderrChunks.push(chunk));
child.stdin.end(prompt);

let timedOut = false;
const timeout = setTimeout(() => {
	timedOut = true;
	child.kill('SIGTERM');
	setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
}, 15 * 60 * 1_000);

const { code, signal } = await new Promise((resolveExit, reject) => {
	child.once('error', reject);
	child.once('close', (exitCode, exitSignal) =>
		resolveExit({ code: exitCode, signal: exitSignal }),
	);
});
clearTimeout(timeout);

const stdout = Buffer.concat(stdoutChunks).toString('utf8');
const stderr = Buffer.concat(stderrChunks).toString('utf8');
writeFileSync(transcriptPath, stdout);
writeFileSync(stderrPath, stderr);

const events = [];
const parseErrors = [];
for (const [index, line] of stdout.split(/\r?\n/).entries()) {
	if (!line.trim()) continue;
	try {
		events.push({ index: index + 1, value: JSON.parse(line) });
	} catch (error) {
		parseErrors.push({ line: index + 1, error: String(error) });
	}
}

const skillEvents = [];
const assistantTexts = [];
for (const event of events) {
	const blocks = event.value?.type === 'assistant'
		? event.value?.message?.content
		: undefined;
	if (!Array.isArray(blocks)) continue;
	for (const block of blocks) {
		if (block?.type === 'tool_use' && block?.name === 'Skill') {
			skillEvents.push({ line: event.index, skill: block.input?.skill ?? null });
		}
		if (block?.type === 'text' && typeof block.text === 'string') {
			assistantTexts.push({ line: event.index, text: block.text });
		}
	}
}

const brandingQuestions = assistantTexts.filter(({ text }) =>
	/(品牌|配色|brand(?:ing)?|colou?r)[\s\S]{0,240}[?？]/i.test(text),
);
const after = snapshot();
const changedUserPaths = Object.keys(before.userPaths).filter(
	(name) => JSON.stringify(before.userPaths[name]) !== JSON.stringify(after.userPaths[name]),
);
const projectSkillUnchanged =
	JSON.stringify(before.projectSkill) === JSON.stringify(after.projectSkill);
const projectConfigUnchanged =
	JSON.stringify(before.projectConfig) === JSON.stringify(after.projectConfig);
const output = existsSync(outputPath)
	? {
		exists: true,
		bytes: readFileSync(outputPath).byteLength,
		sha256: digest(readFileSync(outputPath)),
	}
	: { exists: false };
const invokedDiagramDesign = skillEvents.some(({ skill }) => skill === 'diagram-design');

const status = {
	mode,
	startedAt,
	finishedAt: new Date().toISOString(),
	claudeVersion: '2.1.241',
	command: ['claude', ...claudeArgs],
	promptTransport: 'stdin',
	request: {
		path: relative(repoRoot, requestPath),
		sha256: digest(prompt),
	},
	exit: { code, signal, timedOut },
	transcript: {
		path: relative(repoRoot, transcriptPath),
		sha256: digest(stdout),
		jsonEvents: events.length,
		parseErrors,
	},
	skillEvents,
	invokedDiagramDesign,
	brandingQuestions,
	output: {
		path: relative(repoRoot, outputPath),
		...output,
	},
	guard: {
		projectSkillUnchanged,
		projectConfigUnchanged,
		changedUserPaths,
		before,
		after,
	},
};
writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);

const failures = [];
if (code !== 0 || signal || timedOut) failures.push(`claude exit code=${code} signal=${signal} timeout=${timedOut}`);
if (parseErrors.length > 0) failures.push(`${parseErrors.length} transcript JSON parse errors`);
if (!output.exists || output.bytes === 0) failures.push('expected HTML was not generated');
if (mode === 'explicit' && !invokedDiagramDesign) failures.push('missing Skill(diagram-design) event');
if (brandingQuestions.length > 0) failures.push('branding/color question appeared');
if (!projectSkillUnchanged) failures.push('installed project skill changed during generation');
if (!projectConfigUnchanged) failures.push('project .diagram-design changed during generation');
if (changedUserPaths.length > 0) failures.push(`user-level paths changed: ${changedUserPaths.join(', ')}`);

if (failures.length > 0) {
	console.error(`FAIL ${mode}: ${failures.join('; ')}`);
	process.exit(1);
}

console.log(`PASS ${mode}: output=${relative(repoRoot, outputPath)} skillEvents=${skillEvents.map(({ skill }) => skill).join(',') || 'none'}`);
