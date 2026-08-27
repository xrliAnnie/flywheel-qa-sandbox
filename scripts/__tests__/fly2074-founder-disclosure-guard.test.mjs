import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	appendFileSync,
	cpSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = join(
	repoRoot,
	"engineering/doc/FLY-2074-raya-voice-pipeline",
);
const diagramNames = [
	"d1-core-flow",
	"d2-lifecycle",
	"d3-disconnect-sequence",
	"d4-data-model",
	"d5-silence",
];

function renderFixture(fixtureRoot) {
	let html = readFileSync(
		join(fixtureRoot, "founder-design.template.html"),
		"utf8",
	);
	diagramNames.forEach((name, index) => {
		html = html.replaceAll(
			`{{SVG${index + 1}}}`,
			readFileSync(join(fixtureRoot, `diagrams/${name}.svg`), "utf8").trim(),
		);
	});
	writeFileSync(join(fixtureRoot, "founder-design.html"), html);
}

function withFixture(mutate) {
	const tempRoot = mkdtempSync(join(tmpdir(), "fly2074-disclosure-"));
	const fixtureRoot = join(tempRoot, "doc");
	cpSync(sourceRoot, fixtureRoot, { recursive: true });
	mutate?.(fixtureRoot);
	const result = spawnSync(
		process.execPath,
		[
			join(repoRoot, "scripts/fly2074-founder-disclosure-guard.mjs"),
			"--root",
			fixtureRoot,
		],
		{ encoding: "utf8" },
	);
	rmSync(tempRoot, { recursive: true, force: true });
	return result;
}

function output(result) {
	return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

test("unmodified founder disclosure is accepted with all diagram fixtures", () => {
	const result = withFixture();
	assert.equal(result.status, 0, output(result));
});

test("rejects a fabricated all-green six-round claim", () => {
	const result = withFixture((fixtureRoot) => {
		appendFileSync(
			join(fixtureRoot, "founder-design.html"),
			"\n<p>Discord E2E 六轮全部通过。</p>\n",
		);
	});
	assert.notEqual(result.status, 0, output(result));
});

test("rejects an independent fabricated five-of-six success claim", () => {
	const result = withFixture((fixtureRoot) => {
		const path = join(fixtureRoot, "founder-design.html");
		const html = readFileSync(path, "utf8");
		writeFileSync(path, html.replace("</body>", "<p>成功 5/6。</p></body>"));
	});
	assert.notEqual(result.status, 0, output(result));
});

test("rejects deletion of the machine-readable round facts", () => {
	const result = withFixture((fixtureRoot) => {
		rmSync(join(fixtureRoot, "evidence/discord-rounds.json"));
	});
	assert.notEqual(result.status, 0, output(result));
});

test("rejects a missing d5 silence diagram", () => {
	const result = withFixture((fixtureRoot) => {
		rmSync(join(fixtureRoot, "diagrams/d5-silence.svg"));
	});
	assert.notEqual(result.status, 0, output(result));
});

test("rejects template drift that was not rendered", () => {
	const result = withFixture((fixtureRoot) => {
		appendFileSync(
			join(fixtureRoot, "founder-design.template.html"),
			"\n<!-- poisoned template -->\n",
		);
	});
	assert.notEqual(result.status, 0, output(result));
});

test("rejects withdrawn semantics inside a delivered inline SVG", () => {
	const result = withFixture((fixtureRoot) => {
		const svgPath = join(fixtureRoot, "diagrams/d5-silence.svg");
		const svg = readFileSync(svgPath, "utf8");
		writeFileSync(
			svgPath,
			svg.replace(
				"</svg>",
				"<text>空房超过 10 分钟就把 codex 关闭</text></svg>",
			),
		);
		renderFixture(fixtureRoot);
	});
	assert.notEqual(result.status, 0, output(result));
});
