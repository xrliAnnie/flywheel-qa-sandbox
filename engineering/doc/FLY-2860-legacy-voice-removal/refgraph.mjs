// FLY-2860 reference graph: file-level import graph over the voice packages,
// with symbol-level resolution through package barrels (src/index.ts).
// usage: node refgraph.mjs <treeRoot> [--json out.json]
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2]);
const jsonOut = process.argv.includes("--json")
	? process.argv[process.argv.indexOf("--json") + 1]
	: null;
const PKGS = {
	"flywheel-voice-bridge": "packages/voice-bridge",
	"flywheel-voice-core": "packages/voice-core",
	"flywheel-gemini-agent": "packages/gemini-agent",
	"flywheel-voice-codex": "packages/voice-codex",
	"flywheel-voice-headphone": "packages/voice-headphone",
};
const SCAN = [
	"packages/voice-bridge",
	"packages/voice-core",
	"packages/gemini-agent",
	"packages/voice-codex",
	"packages/voice-headphone",
	"packages/teamlead/src",
	"scripts",
];
const rel = (p) => path.relative(root, p);
const files = [];
function walk(d) {
	if (!fs.existsSync(d)) return;
	for (const e of fs.readdirSync(d, { withFileTypes: true })) {
		if (e.name === "node_modules" || e.name === "dist") continue;
		const p = path.join(d, e.name);
		if (e.isDirectory()) walk(p);
		else if (/\.(ts|mts|mjs|js|cjs)$/.test(e.name) && !e.name.endsWith(".d.ts"))
			files.push(p);
	}
}
for (const s of SCAN) walk(path.join(root, s));

const src = new Map(files.map((f) => [f, fs.readFileSync(f, "utf8")]));
// import/export ... from "x"  |  import("x")  |  import "x"
const RE_FROM =
	/(import|export)\s+(type\s+)?([\s\S]*?)\s+from\s+["']([^"']+)["']/g;
const RE_DYN = /import\(\s*["']([^"']+)["']\s*\)/g;
const RE_BARE = /^\s*import\s+["']([^"']+)["']/gm;

function resolveRel(from, spec) {
	const base = path.resolve(path.dirname(from), spec);
	const cands = [
		base,
		base.replace(/\.js$/, ".ts"),
		base.replace(/\.mjs$/, ".mts"),
		`${base}.ts`,
		`${base}.mjs`,
		`${base}.js`,
		path.join(base, "index.ts"),
	];
	return cands.find((c) => src.has(c)) ?? null;
}
function names(clause) {
	const m = clause.match(/\{([\s\S]*)\}/);
	if (!m) return clause.includes("*") ? ["*"] : [];
	return m[1]
		.split(",")
		.map((s) => s.trim().replace(/^type\s+/, ""))
		.filter(Boolean)
		.map((s) => s.split(/\s+as\s+/)[0].trim());
}
// barrel: symbol -> file, for each package index.ts
const barrel = {};
for (const [pkg, dir] of Object.entries(PKGS)) {
	const idx = path.join(root, dir, "src/index.ts");
	if (!src.has(idx)) continue;
	const map = new Map();
	const stars = [];
	for (const m of src.get(idx).matchAll(RE_FROM)) {
		if (m[1] !== "export") continue;
		const target = resolveRel(idx, m[4]);
		if (!target) continue;
		const ns = names(m[3]);
		if (ns[0] === "*") stars.push(target);
		for (const n of ns) if (n !== "*") map.set(n, target);
	}
	barrel[pkg] = { map, stars, idx };
}
// export * re-export chains inside a barrel target (e.g. headphone/index.ts)
function barrelTarget(pkg, sym) {
	const b = barrel[pkg];
	if (!b) return null;
	if (b.map.has(sym)) return b.map.get(sym);
	for (const s of b.stars) {
		if (new RegExp(`export\\s+(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?(?:class|function\\*?|const|let|interface|type|enum)\\s+${sym}\\b`).test(src.get(s) ?? ""))
			return s;
		// nested barrel
		for (const m of (src.get(s) ?? "").matchAll(RE_FROM)) {
			if (m[1] !== "export") continue;
			const t = resolveRel(s, m[4]);
			const ns = names(m[3]);
			if (t && (ns.includes(sym) || ns[0] === "*")) {
				if (ns.includes(sym)) return t;
				if (new RegExp(`export\\s+(?:class|function|const|interface|type|enum)\\s+${sym}\\b`).test(src.get(t) ?? "")) return t;
			}
		}
	}
	return `UNRESOLVED:${pkg}:${sym}`;
}

const edges = new Map(); // file -> Set(file)
const pkgSyms = new Map(); // file -> [{pkg,sym}]
for (const [f, text] of src) {
	const out = new Set();
	const syms = [];
	const isBarrel = Object.values(barrel).some((b) => b.idx === f);
	for (const m of text.matchAll(RE_FROM)) {
		const spec = m[4];
		if (spec.startsWith(".")) {
			const t = resolveRel(f, spec);
			if (t && !(isBarrel && m[1] === "export")) out.add(t);
		} else if (PKGS[spec] || PKGS[spec.split("/").slice(0, 1)[0]]) {
			for (const n of names(m[3])) {
				if (n === "*") {
					out.add(barrel[spec]?.idx);
					continue;
				}
				const t = barrelTarget(spec, n);
				syms.push({ pkg: spec, sym: n, file: t });
				if (t && !t.startsWith("UNRESOLVED")) out.add(t);
			}
		}
	}
	for (const m of text.matchAll(RE_DYN)) {
		const spec = m[1];
		if (spec.startsWith(".")) {
			const t = resolveRel(f, spec);
			if (t) out.add(t);
		} else if (PKGS[spec]) out.add(`DYN:${spec}`);
	}
	for (const m of text.matchAll(RE_BARE)) {
		if (m[1].startsWith(".")) {
			const t = resolveRel(f, m[1]);
			if (t) out.add(t);
		}
	}
	out.delete(undefined);
	edges.set(f, out);
	pkgSyms.set(f, syms);
}

const isTest = (f) =>
	/__tests__|\.test\.|\.smoke\.test\.|\/test\/|e2e\/|scripts\/__tests__|fixtures/.test(
		rel(f),
	);
function reach(roots) {
	const seen = new Set();
	const st = [...roots];
	while (st.length) {
		const f = st.pop();
		if (seen.has(f)) continue;
		seen.add(f);
		for (const t of edges.get(f) ?? []) if (src.has(t)) st.push(t);
	}
	return seen;
}
const under = (d) => [...src.keys()].filter((f) => rel(f).startsWith(d));
// Production roots: every non-test source file of the packages that stay.
const prodRoots = [
	...under("packages/voice-codex/src"),
	...under("packages/voice-headphone/src"),
	...under("packages/teamlead/src"),
].filter((f) => !isTest(f));
// Old-command roots.
const oldRootDirs = [
	"packages/voice-bridge/src/assistant/",
	"packages/voice-bridge/src/eleven/",
	"packages/voice-bridge/src/huddle/",
	"packages/gemini-agent/src/",
];
const oldRoots = [
	...oldRootDirs.flatMap(under),
	path.join(root, "packages/voice-bridge/src/cli.ts"),
].filter((f) => src.has(f) && !isTest(f));
const prod = reach(prodRoots);
const old = reach(oldRoots);
const libs = ["packages/voice-bridge/src", "packages/voice-core/src", "packages/gemini-agent/src"];
const inLibs = (f) => libs.some((l) => rel(f).startsWith(l)) && !isTest(f);
const onlyOld = [...old].filter((f) => !prod.has(f) && inLibs(f)).map(rel).sort();
const shared = [...old].filter((f) => prod.has(f) && inLibs(f)).map(rel).sort();
const orphan = [...src.keys()]
	.filter((f) => inLibs(f) && !old.has(f) && !prod.has(f))
	.map(rel)
	.sort();
// who (outside the delete set) pulls each shared file — evidence for keep list
const onlyOldSet = new Set(onlyOld);
const deleteSet = new Set([...onlyOld]);
function importersOf(target) {
	return [...edges]
		.filter(([f, out]) => out.has(target))
		.map(([f]) => rel(f));
}
const sharedEvidence = Object.fromEntries(
	shared.map((s) => [
		s,
		importersOf(path.join(root, s)).filter(
			(i) => !onlyOldSet.has(i) && !isTest(path.join(root, i)),
		),
	]),
);
// tests: classify by what they import
const tests = [...src.keys()].filter(
	(f) => isTest(f) && libs.some((l) => rel(f).startsWith(l.replace("/src", ""))),
);
const testClass = {};
for (const t of tests) {
	const deps = [...(edges.get(t) ?? [])].filter((d) => src.has(d) && inLibs(d));
	const del = deps.filter((d) => deleteSet.has(rel(d)));
	const keep = deps.filter((d) => !deleteSet.has(rel(d)));
	const cls =
		deps.length === 0
			? "no-lib-import"
			: del.length && !keep.length
				? "delete"
				: del.length
					? "mixed"
					: "keep";
	testClass[rel(t)] = { cls, del: del.map(rel), keep: keep.map(rel) };
}
// symbols consumed from each barrel by production (non-test, outside own pkg)
const prodSyms = {};
for (const f of prodRoots) {
	for (const s of pkgSyms.get(f) ?? []) {
		(prodSyms[s.pkg] ??= new Set()).add(`${s.sym} <- ${s.file ? rel(s.file) : "?"}`);
	}
}
// also lib-internal prod reach consumes voice-core symbols via voice-bridge
for (const f of prod) {
	if (!rel(f).startsWith("packages/voice-bridge/src")) continue;
	for (const s of pkgSyms.get(f) ?? []) {
		(prodSyms[`${s.pkg} (via voice-bridge kept)`] ??= new Set()).add(`${s.sym} <- ${s.file ? rel(s.file) : "?"}`);
	}
}
const result = {
	root,
	counts: { files: src.size, prod: prod.size, old: old.size, onlyOld: onlyOld.length, shared: shared.length, orphan: orphan.length },
	onlyOld,
	shared: sharedEvidence,
	orphan,
	tests: testClass,
	prodSyms: Object.fromEntries(Object.entries(prodSyms).map(([k, v]) => [k, [...v].sort()])),
	dynamic: [...edges].filter(([, o]) => [...o].some((x) => String(x).startsWith("DYN:"))).map(([f, o]) => [rel(f), [...o].filter((x) => String(x).startsWith("DYN:"))]),
};
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(result, null, 1));
console.log(JSON.stringify(result.counts));
