import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { dryRun } from "../lib/qa-fly-2456-dry-run.mjs";

const scannerPath = resolve("scripts/hooks/flywheel-restart-guard.py");
const producer = resolve("scripts/qa-fly-2456-guard-receipt.py");
test("indented or tilde fences cannot conceal unscanned commands", (t) => {
	for (const block of [
		"  ```bash\npkill -f run-bridge\n  ```",
		"~~~bash\npkill -f run-bridge\n~~~",
	]) {
		const f = fixture(t, "bash /tmp/checkout/scripts/test-deploy.sh 4");
		writeFileSync(
			f.runbookPath,
			`${readFileSync(f.runbookPath, "utf8")}\n${block}\n`,
		);
		assert.equal(produce(f).status, 0);
		assert.equal(dryRun(f).status, "fail");
	}
});
test("receipt cannot hide incomplete runbook step or ambiguous command fences", (t) => {
	for (const content of [
		step("bash /tmp/checkout/scripts/test-deploy.sh 4").replace(
			"停手: 非零",
			"",
		),
		step("bash /tmp/checkout/scripts/test-deploy.sh 4") +
			"\n```sh\nlaunchctl kickstart gui/501/com.flywheel.bridge\n```\n",
	]) {
		const f = fixture(t, "unused");
		writeFileSync(f.runbookPath, content);
		produce(f);
		assert.equal(dryRun(f).status, "fail");
	}
});
const step = (command) =>
	`## Step\n命令\n\`\`\`bash\n${command}\n\`\`\`\n期望输出: exit 0\n落盘: receipt\n停手: 非零\n`;
function fixture(t, command) {
	const dir = mkdtempSync(join(tmpdir(), "fly2456-guard-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const runbookPath = join(dir, "runbook.md"),
		receiptPath = join(dir, "guard.json");
	writeFileSync(runbookPath, step(command));
	return { runbookPath, receiptPath, scannerPath };
}
function produce(f) {
	return spawnSync(
		"python3",
		[producer, f.runbookPath, f.scannerPath, f.receiptPath],
		{ encoding: "utf8", timeout: 10000 },
	);
}
test("actual scanner allows three official primitives", (t) => {
	for (const script of [
		"test-deploy.sh",
		"test-cycle-bridge.sh",
		"test-teardown.sh",
	]) {
		const command = `bash /private/tmp/checkout/scripts/${script} 4`;
		const f = fixture(t, command);
		writeFileSync(f.runbookPath, guarded(command));
		const p = produce(f);
		assert.equal(p.status, 0, p.stderr);
		assert.equal(dryRun(f).status, "pass");
	}
});
test("actual scanner denies P1 P2 P3", (t) => {
	for (const command of [
		"launchctl kickstart -k gui/501/com.flywheel.bridge",
		"pkill -f run-bridge",
		"node /tmp/run-bridge.js",
	]) {
		const f = fixture(t, command);
		const p = produce(f);
		assert.equal(p.status, 1, p.stderr);
		assert.equal(dryRun(f).status, "fail");
	}
});
test("missing receipt not-run, document or scanner digest mismatch fail", (t) => {
	const f = fixture(t, "bash /tmp/checkout/scripts/test-deploy.sh 4");
	assert.equal(dryRun(f).status, "not-run");
	assert.equal(produce(f).status, 0);
	writeFileSync(
		f.runbookPath,
		step("bash /tmp/checkout/scripts/test-deploy.sh 1"),
	);
	assert.equal(dryRun(f).status, "fail");
	const receipt = JSON.parse(readFileSync(f.receiptPath));
	receipt.scannerSha256 = "0".repeat(64);
	writeFileSync(f.receiptPath, JSON.stringify(receipt));
	assert.equal(dryRun(f).status, "fail");
});
test("unguarded primitive, unresolved placeholder and relative tool path fail semantics despite clean scanner", (t) => {
	for (const command of [
		"bash /tmp/checkout/scripts/test-deploy.sh 4",
		"node scripts/qa-fly-2456-drill-tools.mjs bounds --db /tmp/copy",
		"node <tested-checkout>/scripts/qa-fly-2456-drill-tools.mjs bounds --db /tmp/copy",
	]) {
		const f = fixture(t, command);
		writeFileSync(
			f.runbookPath,
			annotated(command, { id: "read", kind: "read" }),
		);
		assert.equal(produce(f).status, 0);
		assert.equal(dryRun(f).status, "fail");
	}
});

function annotated(command, meta) {
	return step(command).replace(
		"命令\n",
		`<!-- fly2456-step ${JSON.stringify(meta)} -->\n命令\n`,
	);
}
function guarded(command) {
	return annotated(
		`intent_file deploy /tmp/intent.json\nadopt_file deploy /tmp/authority.json deploy\nif [ "$ADOPT_ACTION" = execute ]; then\n  ${command}\nfi`,
		{
			id: "deploy",
			kind: "effect",
			intent: "intent_file deploy /tmp/intent.json",
			adopt: "adopt_file deploy /tmp/authority.json deploy",
			effect: command,
			action: "ADOPT_ACTION",
		},
	);
}
test("explicit absolute variables and setup function definitions are accepted", (t) => {
	const f = fixture(t, "unused");
	writeFileSync(
		f.runbookPath,
		annotated(
			'export TESTED=/private/tmp/tested\nexport TOOLS=$TESTED/scripts/qa-fly-2456-drill-tools.mjs\nhelper() {\n  node "$TOOLS" bounds --db "$1"\n}',
			{ id: "setup", kind: "setup" },
		) +
			annotated('node "$TOOLS" bounds --db /tmp/copy', {
				id: "read",
				kind: "read",
			}),
	);
	assert.equal(produce(f).status, 0);
	assert.equal(dryRun(f).status, "pass");
});
test("metadata does not authorize missing, reordered or mismatched execute guards", (t) => {
	for (const change of [
		(s) => s.replace('if [ "$ADOPT_ACTION" = execute ]; then', "if true; then"),
		(s) =>
			s.replace(
				"  bash /tmp/checkout/scripts/test-deploy.sh 4\nfi",
				"fi\nbash /tmp/checkout/scripts/test-deploy.sh 4",
			),
		(s) => s.replace("adopt_file deploy /tmp/authority.json deploy\n", ""),
		(s) =>
			s.replace(
				"intent_file deploy /tmp/intent.json\nadopt_file",
				"adopt_file",
			),
	]) {
		const f = fixture(t, "unused");
		writeFileSync(
			f.runbookPath,
			change(guarded("bash /tmp/checkout/scripts/test-deploy.sh 4")),
		);
		produce(f);
		assert.equal(dryRun(f).status, "fail");
	}
});
test("unbound or relative variables and read-labeled effects are rejected", (t) => {
	for (const command of [
		'node "$MISSING" bounds',
		'export TOOLS=scripts/qa-fly-2456-drill-tools.mjs\nnode "$TOOLS" bounds',
		"bash /tmp/checkout/scripts/test-deploy.sh 4",
	]) {
		const f = fixture(t, "unused");
		writeFileSync(
			f.runbookPath,
			annotated(command, { id: "read", kind: "read" }),
		);
		produce(f);
		assert.equal(dryRun(f).status, "fail");
	}
});
test("validated guarded effect functions can be called from an effect step", (t) => {
	const f = fixture(t, "unused");
	const intent = 'intent_file "$step" /tmp/intent.json',
		adopt = 'adopt_db "$step" before',
		effect = 'bash "$TESTED/scripts/test-deploy.sh" 4';
	const definition = `export TESTED=/tmp/checkout\nstart_body() {\n${intent}\n${adopt}\nif test "$ADOPT_ACTION" = execute; then\n${effect}\nfi\n}`;
	writeFileSync(
		f.runbookPath,
		annotated(definition, {
			id: "helpers",
			kind: "setup",
			functions: [
				{ name: "start_body", intent, adopt, effect, action: "ADOPT_ACTION" },
			],
		}) +
			annotated("start_body B1", {
				id: "start",
				kind: "effect",
				call: "start_body B1",
			}),
	);
	assert.equal(produce(f).status, 0);
	assert.equal(dryRun(f).status, "pass");
});
test("setup cannot hide runtime calls to unannotated mutating functions", (t) => {
	const f = fixture(t, "unused");
	writeFileSync(
		f.runbookPath,
		annotated(
			"hidden() {\nbash /tmp/checkout/scripts/test-deploy.sh 4\n}\nhidden",
			{ id: "setup", kind: "setup" },
		),
	);
	produce(f);
	assert.equal(dryRun(f).status, "fail");
});
test("guard action cannot be reassigned after adoption", (t) => {
	const f = fixture(t, "unused");
	writeFileSync(
		f.runbookPath,
		guarded("bash /tmp/checkout/scripts/test-deploy.sh 4").replace(
			'if [ "$ADOPT_ACTION" = execute ]; then',
			'ADOPT_ACTION=execute\nif [ "$ADOPT_ACTION" = execute ]; then',
		),
	);
	produce(f);
	assert.equal(dryRun(f).status, "fail");
});
test("effect closure catches callers declared before their mutating callee", (t) => {
	const f = fixture(t, "unused");
	writeFileSync(
		f.runbookPath,
		annotated(
			"outer() {\ninner\n}\ninner() {\nbash /tmp/checkout/scripts/test-deploy.sh 4\n}\nouter",
			{ id: "setup", kind: "setup" },
		),
	);
	produce(f);
	assert.equal(dryRun(f).status, "fail");
});
test("registered function call cannot conceal a second unregistered effect call", (t) => {
	const f = fixture(t, "unused"),
		intent = "intent_file deploy /tmp/intent",
		adopt = "adopt_db deploy before",
		effect = "bash /tmp/checkout/scripts/test-deploy.sh 4";
	const def = `valid() {\n${intent}\n${adopt}\nif test "$ADOPT_ACTION" = execute; then\n${effect}\nfi\n}\nhidden() {\n${effect}\n}`;
	writeFileSync(
		f.runbookPath,
		annotated(def, {
			id: "setup",
			kind: "setup",
			functions: [{ name: "valid", intent, adopt, effect }],
		}) +
			annotated("valid\nhidden", { id: "call", kind: "effect", call: "valid" }),
	);
	produce(f);
	assert.equal(dryRun(f).status, "fail");
});
test("bounded inline Node code and module stdin are accepted", (t) => {
	for (const command of [
		`node -e 'console.log(1)'`,
		`node --input-type=module - /tmp/output <<'JS'\nconsole.log('ok');\nJS`,
	]) {
		const f = fixture(t, "unused");
		writeFileSync(
			f.runbookPath,
			annotated(command, { id: "read", kind: "read" }),
		);
		assert.equal(produce(f).status, 0);
		assert.equal(dryRun(f).status, "pass");
	}
});
