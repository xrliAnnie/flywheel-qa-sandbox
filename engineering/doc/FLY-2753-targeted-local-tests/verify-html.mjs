import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html = fs.readFileSync(
	"engineering/doc/FLY-2753-targeted-local-tests/founder-design.html",
	"utf8",
);
const scripts = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
assert.equal(scripts.length, 1);
assert.equal(scripts[0][1], ' nonce="__CSP_NONCE__"');
assert.doesNotMatch(
	html,
	/\son\w+\s*=|<meta[^>]+Content-Security-Policy|<script[^>]+src=|<link[^>]+href=/i,
);
assert.doesNotMatch(scripts[0][2], /innerHTML/);
assert.equal((html.match(/<section /g) || []).length, 7);
assert.equal((html.match(/data-comment=/g) || []).length, 7);
assert.ok(html.includes("DIAGRAM PENDING LOCAL RENDER"));
const marker = "【页面意见汇总】FLY-2753";
function harness({
	pathname = "/one",
	storage = new Map(),
	denied = false,
	clipboard = "ok",
} = {}) {
	const copies = [],
		fallback = [];
	class Element {
		constructor() {
			this.value = "";
			this.dataset = {};
			this.listeners = {};
			this.children = [];
			this.textContent = "";
		}
		addEventListener(name, fn) {
			this.listeners[name] = fn;
		}
		appendChild(el) {
			this.children.push(el);
		}
		replaceChildren() {
			this.children = [];
		}
		setAttribute() {}
		select() {
			fallback.push(this.value);
		}
		remove() {}
	}
	const fields = [
		...html.matchAll(/data-comment="([^"]+)" data-title="([^"]+)"/g),
	].map((m) => {
		const el = new Element();
		el.dataset = { comment: m[1], title: m[2] };
		return el;
	});
	const ids = Object.fromEntries(
		["aggregate", "chunks", "copy-status", "copy-all"].map((k) => [
			k,
			new Element(),
		]),
	);
	const document = {
		querySelectorAll: () => fields,
		getElementById: (id) => ids[id],
		createElement: () => new Element(),
		body: new Element(),
		execCommand: (cmd) => cmd === "copy",
	};
	const navigator =
		clipboard === "absent"
			? {}
			: {
					clipboard: {
						writeText: async (text) => {
							if (clipboard === "reject") throw Error("denied");
							copies.push(text);
						},
					},
				};
	const localStorage = {
		getItem: (k) => {
			if (denied) throw Error("denied");
			return storage.get(k);
		},
		setItem: (k, v) => {
			if (denied) throw Error("denied");
			storage.set(k, v);
		},
	};
	vm.runInNewContext(scripts[0][2], {
		document,
		navigator,
		localStorage,
		location: { pathname },
	});
	return { fields, ids, storage, copies, fallback };
}
let checks = 5;
const h = harness();
h.fields[0].value = "<script>alert(1)</script>";
h.fields[0].listeners.input();
assert.equal(
	h.storage.get("flywheel-feedback:/one:summary"),
	"<script>alert(1)</script>",
);
assert.ok(h.ids.aggregate.value.startsWith(`${marker}\n\n[一句话方案]`));
checks++;
assert.equal(
	harness({ storage: h.storage }).fields[0].value,
	h.fields[0].value,
);
checks++;
assert.equal(
	harness({ pathname: "/two", storage: h.storage }).fields[0].value,
	"",
);
checks++;
h.fields[1].value = "长评😀".repeat(1600);
h.fields[1].listeners.input();
assert.ok(h.ids.chunks.children.length > 1);
for (const button of h.ids.chunks.children) await button.listeners.click();
assert.ok(
	h.copies.every(
		(text) => text.startsWith(`${marker}\n`) && text.length <= 1800,
	),
);
checks++;
await h.ids["copy-all"].listeners.click();
assert.equal(h.copies.at(-1), h.ids.aggregate.value);
checks++;
for (const clipboard of ["absent", "reject"]) {
	const f = harness({ clipboard });
	f.fields[0].value = "feedback";
	f.fields[0].listeners.input();
	await f.ids["copy-all"].listeners.click();
	assert.ok(f.fallback[0].startsWith(marker));
	checks++;
}
const denied = harness({ denied: true });
denied.fields[0].value = "still works";
denied.fields[0].listeners.input();
assert.ok(denied.ids.aggregate.value.includes("still works"));
checks++;
for (const field of h.fields) {
	field.value = "";
	field.listeners.input();
}
assert.equal(h.ids.aggregate.value, "");
assert.equal(h.ids["copy-all"].disabled, true);
checks++;
console.log(
	JSON.stringify({
		checks,
		passed: true,
		scope:
			"HTML static checks and actual inline JavaScript in Node VM with DOM/storage/clipboard fixtures",
		notCovered:
			"Real browser rendering/CSP execution blocked by local Chromium sandbox; hosted response checked separately",
	}),
);
