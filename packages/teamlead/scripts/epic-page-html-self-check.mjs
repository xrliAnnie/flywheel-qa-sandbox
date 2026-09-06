#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Window } from "happy-dom";

function fail(message) {
	throw new Error(`epic_page_html_self_check: ${message}`);
}

function loadPage(html) {
	const window = new Window({ url: "https://epic.example.test/r/token/" });
	// Setting innerHTML keeps scripts inert until this probe explicitly evaluates the
	// single age script. That gives the blocked-script negative control a real shape.
	window.document.documentElement.innerHTML = html;
	window.setInterval = () => 1;
	return window;
}

function elements(window) {
	const root = window.document.querySelector("[data-generated-at]");
	const age = window.document.querySelector("[data-opened-age]");
	const script = window.document.querySelector("script[nonce]");
	if (!root) fail("generated-at root missing");
	if (!age) fail("opened-age element missing");
	if (!script) fail("nonce age script missing");
	return { root, age, script };
}

function assertStaticFallback(window) {
	const { root, age } = elements(window);
	const generatedAt = root.getAttribute("data-generated-at") ?? "";
	if (!Number.isFinite(Date.parse(generatedAt)))
		fail("generated-at is invalid");
	if (!window.document.body.textContent.includes(generatedAt)) {
		fail("generated-at is not visible without script execution");
	}
	assertVisible(window, age);
	return { generatedAt, initialAge: age.textContent };
}

function assertVisible(window, element) {
	const style = window.getComputedStyle(element);
	if (
		element.hidden ||
		style.display === "none" ||
		style.visibility === "hidden"
	) {
		fail("opened-age element is hidden");
	}
}

function executeAgeScript(window, generatedAt) {
	const { script } = elements(window);
	window.Date.now = () => Date.parse(generatedAt) + 7 * 60_000;
	window.eval(script.textContent ?? "");
}

function assertDynamicAge(window, initialAge) {
	const { age } = elements(window);
	assertVisible(window, age);
	if (age.textContent === initialAge || !age.textContent.includes("7 分钟旧")) {
		fail("age script did not update visible text");
	}
}

function checkLive(html) {
	const window = loadPage(html);
	try {
		const { generatedAt, initialAge } = assertStaticFallback(window);
		executeAgeScript(window, generatedAt);
		assertDynamicAge(window, initialAge);
		return { ok: true, dynamicAgeChanged: true };
	} finally {
		window.close();
	}
}

function checkNegativeControls(html) {
	let blockedScriptFailed = false;
	const blocked = loadPage(html);
	try {
		const { initialAge } = assertStaticFallback(blocked);
		try {
			assertDynamicAge(blocked, initialAge);
		} catch {
			blockedScriptFailed = true;
		}
	} finally {
		blocked.close();
	}

	let hiddenElementFailed = false;
	const hidden = loadPage(html);
	try {
		const { generatedAt, initialAge } = assertStaticFallback(hidden);
		executeAgeScript(hidden, generatedAt);
		const { age } = elements(hidden);
		age.style.display = "none";
		try {
			assertDynamicAge(hidden, initialAge);
		} catch {
			hiddenElementFailed = true;
		}
	} finally {
		hidden.close();
	}

	if (!blockedScriptFailed || !hiddenElementFailed) {
		fail("negative controls did not fail closed");
	}
	return { ok: true, blockedScriptFailed, hiddenElementFailed };
}

try {
	const { values } = parseArgs({
		options: {
			file: { type: "string" },
			"self-check": { type: "boolean", default: false },
		},
		strict: true,
		allowPositionals: false,
	});
	if (!values.file) fail("--file is required");
	const html = readFileSync(values.file, "utf8");
	const result = values["self-check"]
		? checkNegativeControls(html)
		: checkLive(html);
	process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
}
