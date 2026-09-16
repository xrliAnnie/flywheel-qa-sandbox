import { z } from "zod";

const object = (shape: z.ZodRawShape) => z.object(shape).strict();
const uid = z.string().min(1).max(256),
	text = z.string().max(32000),
	integer = z.number().int().nonnegative();
const snapshot = { includeSnapshot: z.boolean().optional() },
	timeout = { timeout: z.number().int().min(1).max(15000).optional() };
const pagination = {
	pageSize: z.number().int().min(1).max(100).optional(),
	pageIdx: integer.max(10000).optional(),
};
/** Explicit audited subset of pinned 1.9.0 schemas. No upstream-added tools/fields inherit access. */
export const BROWSER_TOOL_SCHEMAS: Readonly<
	Record<string, z.ZodObject<z.ZodRawShape>>
> = Object.freeze({
	list_pages: object({}),
	select_page: object({
		pageId: integer,
		bringToFront: z.boolean().optional(),
	}),
	close_page: object({ pageId: integer }),
	new_page: object({
		url: z.string().max(8192),
		background: z.boolean().optional(),
		isolatedContext: uid.optional(),
		...timeout,
	}),
	navigate_page: object({
		type: z.enum(["url", "back", "forward", "reload"]).optional(),
		url: z.string().max(8192).optional(),
		ignoreCache: z.boolean().optional(),
		handleBeforeUnload: z.enum(["accept", "dismiss"]).optional(),
		initScript: text.optional(),
		...timeout,
	}),
	resize_page: object({
		width: z.number().int().min(1).max(7680),
		height: z.number().int().min(1).max(4320),
	}),
	handle_dialog: object({
		action: z.enum(["accept", "dismiss"]),
		promptText: text.optional(),
	}),
	click: object({ uid, dblClick: z.boolean().optional(), ...snapshot }),
	hover: object({ uid, ...snapshot }),
	fill: object({ uid, value: text, ...snapshot }),
	fill_form: object({
		elements: z
			.array(object({ uid, value: text }))
			.min(1)
			.max(100),
		...snapshot,
	}),
	press_key: object({ key: uid, ...snapshot }),
	drag: object({ from_uid: uid, to_uid: uid, ...snapshot }),
	wait_for: object({
		text: z.array(z.string().min(1).max(4096)).min(1).max(32),
		...timeout,
	}),
	take_snapshot: object({ verbose: z.boolean().optional() }),
	take_screenshot: object({
		format: z.enum(["png", "jpeg", "webp"]).optional(),
		quality: z.number().int().min(0).max(100).optional(),
		uid: uid.optional(),
		fullPage: z.boolean().optional(),
	}),
	evaluate_script: object({
		function: text.min(1),
		args: z.array(uid).max(100).optional(),
		dialogAction: z.string().max(4096).optional(),
		waitForStableDom: z.boolean().optional(),
	}),
	list_console_messages: object({
		...pagination,
		types: z
			.array(
				z.enum([
					"log",
					"debug",
					"info",
					"error",
					"warn",
					"dir",
					"dirxml",
					"table",
					"trace",
					"clear",
					"startGroup",
					"startGroupCollapsed",
					"endGroup",
					"assert",
					"profile",
					"profileEnd",
					"count",
					"timeEnd",
					"verbose",
					"issue",
				]),
			)
			.max(32)
			.optional(),
		includePreservedMessages: z.boolean().optional(),
		includeStackTraces: z.boolean().optional(),
	}),
	get_console_message: object({ msgid: integer }),
	list_network_requests: object({
		...pagination,
		resourceTypes: z
			.array(
				z.enum([
					"document",
					"stylesheet",
					"image",
					"media",
					"font",
					"script",
					"texttrack",
					"xhr",
					"fetch",
					"prefetch",
					"eventsource",
					"websocket",
					"manifest",
					"signedexchange",
					"ping",
					"cspviolationreport",
					"preflight",
					"fedcm",
					"other",
				]),
			)
			.max(32)
			.optional(),
		includePreservedRequests: z.boolean().optional(),
	}),
	get_network_request: object({ reqid: integer.optional() }),
});
