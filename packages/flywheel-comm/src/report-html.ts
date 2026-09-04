/**
 * Shared, dependency-free HTML scanning for the hosted-report publisher and
 * verifier. This is deliberately not a general HTML parser: it only exposes
 * the opening-tag, attribute, raw-text, and head-boundary facts needed by the
 * report security contract.
 */

export interface HtmlAttribute {
	name: string;
	nameEnd: number;
	value?: string;
	valueStart?: number;
	valueEnd?: number;
}

export interface HtmlOpeningTag {
	name: string;
	start: number;
	end: number;
	attributes: HtmlAttribute[];
}

interface HtmlClosingTag {
	name: string;
	start: number;
	end: number;
}

export interface HtmlTagScan {
	openings: HtmlOpeningTag[];
	closings: HtmlClosingTag[];
}

const RAW_TEXT_ELEMENTS = new Set([
	"iframe",
	"noembed",
	"noframes",
	"noscript",
	"plaintext",
	"script",
	"style",
	"textarea",
	"title",
	"xmp",
]);

// WHATWG MIME Sniffing's JavaScript MIME type essence list. The report
// contract intentionally compares the parsed essence so legacy parameters
// such as `; charset=utf-8` cannot make a browser-governed script invisible to
// either the publisher or verifier.
const JAVASCRIPT_MIME_TYPE_ESSENCES = new Set([
	"application/ecmascript",
	"application/javascript",
	"application/x-ecmascript",
	"application/x-javascript",
	"text/ecmascript",
	"text/javascript",
	"text/javascript1.0",
	"text/javascript1.1",
	"text/javascript1.2",
	"text/javascript1.3",
	"text/javascript1.4",
	"text/javascript1.5",
	"text/jscript",
	"text/livescript",
	"text/x-ecmascript",
	"text/x-javascript",
]);

function findTagEnd(html: string, from: number): number {
	let quote: '"' | "'" | null = null;
	for (let index = from; index < html.length; index += 1) {
		const char = html[index];
		if (quote !== null) {
			if (char === quote) quote = null;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === ">") return index;
	}
	return -1;
}

function parseAttributes(
	html: string,
	from: number,
	tagEnd: number,
): HtmlAttribute[] {
	const attributes: HtmlAttribute[] = [];
	let cursor = from;
	while (cursor < tagEnd) {
		while (/\s/.test(html[cursor] ?? "")) cursor += 1;
		if (cursor >= tagEnd) break;
		if (html[cursor] === "/") {
			cursor += 1;
			continue;
		}
		const nameStart = cursor;
		while (cursor < tagEnd && !/[\s=/>]/.test(html[cursor] ?? "")) {
			cursor += 1;
		}
		if (cursor === nameStart) {
			cursor += 1;
			continue;
		}
		const nameEnd = cursor;
		const attribute: HtmlAttribute = {
			name: html.slice(nameStart, nameEnd).toLowerCase(),
			nameEnd,
		};
		while (/\s/.test(html[cursor] ?? "")) cursor += 1;
		if (html[cursor] === "=") {
			cursor += 1;
			while (/\s/.test(html[cursor] ?? "")) cursor += 1;
			const quote = html[cursor];
			if (quote === '"' || quote === "'") {
				cursor += 1;
				attribute.valueStart = cursor;
				while (cursor < tagEnd && html[cursor] !== quote) cursor += 1;
				attribute.valueEnd = cursor;
				attribute.value = html.slice(attribute.valueStart, attribute.valueEnd);
				if (html[cursor] === quote) cursor += 1;
			} else {
				attribute.valueStart = cursor;
				while (cursor < tagEnd && !/[\s>]/.test(html[cursor] ?? "")) {
					cursor += 1;
				}
				attribute.valueEnd = cursor;
				attribute.value = html.slice(attribute.valueStart, attribute.valueEnd);
			}
		}
		attributes.push(attribute);
	}
	return attributes;
}

function findClosingTag(
	html: string,
	tagName: string,
	from: number,
): HtmlClosingTag | undefined {
	const lower = html.toLowerCase();
	const needle = `</${tagName}`;
	let cursor = from;
	while (cursor < html.length) {
		const start = lower.indexOf(needle, cursor);
		if (start < 0) return undefined;
		const boundary = html[start + needle.length];
		if (boundary === ">" || /\s/.test(boundary ?? "")) {
			const end = findTagEnd(html, start + needle.length);
			return {
				name: tagName,
				start,
				end: end < 0 ? html.length - 1 : end,
			};
		}
		cursor = start + needle.length;
	}
	return undefined;
}

export function scanHtmlTags(html: string): HtmlTagScan {
	const openings: HtmlOpeningTag[] = [];
	const closings: HtmlClosingTag[] = [];
	let cursor = 0;
	while (cursor < html.length) {
		const start = html.indexOf("<", cursor);
		if (start < 0) break;
		if (html.startsWith("<!--", start)) {
			const commentEnd = html.indexOf("-->", start + 4);
			cursor = commentEnd < 0 ? html.length : commentEnd + 3;
			continue;
		}

		const closingMatch = /^<\/([A-Za-z][A-Za-z0-9:-]*)/.exec(html.slice(start));
		if (closingMatch) {
			const nameEnd = start + closingMatch[0].length;
			const boundary = html[nameEnd];
			if (boundary === ">" || /\s/.test(boundary ?? "")) {
				const end = findTagEnd(html, nameEnd);
				if (end < 0) break;
				closings.push({
					name: closingMatch[1]?.toLowerCase() ?? "",
					start,
					end,
				});
				cursor = end + 1;
				continue;
			}
		}

		const nameMatch = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(html.slice(start));
		if (!nameMatch) {
			cursor = start + 1;
			continue;
		}
		const nameEnd = start + nameMatch[0].length;
		const boundary = html[nameEnd];
		if (boundary !== ">" && boundary !== "/" && !/\s/.test(boundary ?? "")) {
			cursor = nameEnd;
			continue;
		}
		const end = findTagEnd(html, nameEnd);
		if (end < 0) break;
		const name = nameMatch[1]?.toLowerCase();
		if (!name) {
			cursor = end + 1;
			continue;
		}
		openings.push({
			name,
			start,
			end,
			attributes: parseAttributes(html, nameEnd, end),
		});
		cursor = end + 1;
		// In HTML syntax the slash in `<script/>` does not self-close a raw-text
		// element. Treat its contents exactly like `<script>...</script>`.
		if (RAW_TEXT_ELEMENTS.has(name)) {
			const close = findClosingTag(html, name, cursor);
			if (!close) {
				cursor = html.length;
				continue;
			}
			closings.push(close);
			cursor = close.end + 1;
		}
	}
	return { openings, closings };
}

export function htmlAttribute(
	tag: HtmlOpeningTag,
	name: string,
): HtmlAttribute | undefined {
	return tag.attributes.find((candidate) => candidate.name === name);
}

export function hasHtmlAttribute(tag: HtmlOpeningTag, name: string): boolean {
	return htmlAttribute(tag, name) !== undefined;
}

export const EXTERNAL_SCRIPT_REJECTION_MESSAGE =
	"hosted reports must not contain external script src tags; bundle the code into an inline script and republish so publish-report can add matching nonces automatically, or use the __CSP_NONCE__ inline-script convention";

export function isExternalScript(tag: HtmlOpeningTag): boolean {
	return tag.name === "script" && hasHtmlAttribute(tag, "src");
}

export function isCspGovernedInlineScript(tag: HtmlOpeningTag): boolean {
	if (tag.name !== "script" || isExternalScript(tag)) return false;
	const type = htmlAttribute(tag, "type")?.value?.trim().toLowerCase();
	const essence = type?.split(";", 1)[0]?.trim();
	return (
		type === undefined ||
		type === "" ||
		type === "module" ||
		type === "importmap" ||
		type === "speculationrules" ||
		(essence !== undefined && JAVASCRIPT_MIME_TYPE_ESSENCES.has(essence))
	);
}

export function htmlHeadRange(
	scan: HtmlTagScan,
): { start: number; end: number } | undefined {
	const head = scan.openings.find((tag) => tag.name === "head");
	if (!head) return undefined;
	const body = scan.openings.find(
		(tag) => tag.name === "body" && tag.start > head.end,
	);
	const close = scan.closings.find(
		(tag) => tag.name === "head" && tag.start > head.end,
	);
	const candidates = [body?.start, close?.start].filter(
		(value): value is number => value !== undefined,
	);
	return {
		start: head.end + 1,
		end: candidates.length > 0 ? Math.min(...candidates) : head.end + 1,
	};
}

/** Returns a head-scoped meta policy using the canonical report HTML scan. */
export function htmlMetaHttpEquivContent(
	html: string,
	httpEquiv: string,
): string | undefined {
	const scan = scanHtmlTags(html);
	const head = htmlHeadRange(scan);
	if (!head) return undefined;
	const normalized = httpEquiv.trim().toLowerCase();
	for (const tag of scan.openings) {
		if (
			tag.name === "meta" &&
			tag.start >= head.start &&
			tag.start < head.end &&
			htmlAttribute(tag, "http-equiv")?.value?.trim().toLowerCase() ===
				normalized
		) {
			return htmlAttribute(tag, "content")?.value;
		}
	}
	return undefined;
}
