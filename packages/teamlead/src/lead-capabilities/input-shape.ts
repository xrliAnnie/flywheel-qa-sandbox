import { z } from "zod";

type JsonSchema = Record<string, unknown>;

const MAX_DEPTH = 4;

function render(value: JsonSchema, depth: number): string {
	const variants = (value.anyOf ?? value.oneOf) as JsonSchema[] | undefined;
	if (Array.isArray(variants) && variants.length > 0)
		return [...new Set(variants.map((variant) => render(variant, depth)))].join(
			" | ",
		);
	const values = value.enum as unknown[] | undefined;
	if (Array.isArray(values) && values.length <= 8)
		return values.map((entry) => JSON.stringify(entry)).join("|");
	if (value.const !== undefined) return JSON.stringify(value.const);
	if (value.type === "array") {
		const items = value.items as JsonSchema | undefined;
		return `${items ? render(items, depth) : "any"}[]`;
	}
	if (
		value.type === "object" &&
		value.properties !== undefined &&
		depth < MAX_DEPTH
	)
		return renderObject(value, depth + 1);
	if (Array.isArray(value.type)) return value.type.join("|");
	if (typeof value.type === "string") return value.type;
	return "any";
}

function renderObject(value: JsonSchema, depth: number): string {
	const properties = (value.properties ?? {}) as Record<string, JsonSchema>;
	const required = new Set((value.required as string[] | undefined) ?? []);
	return `{${Object.entries(properties)
		.map(
			([name, property]) =>
				`${name}${required.has(name) ? "" : "?"}: ${render(property, depth)}`,
		)
		.join(", ")}}`;
}

/**
 * One compact `{field: type, optional?: type}` line for an operation input,
 * with discriminated unions spelled out variant by variant (FLY-2886 QA@4 D1).
 * Derived from the catalog schema only; never from a caller's values.
 */
export function describeOperationInput(schema: z.ZodType): string {
	let json: JsonSchema;
	try {
		json = z.toJSONSchema(schema, { unrepresentable: "any" }) as JsonSchema;
	} catch {
		return "{…}";
	}
	return renderObject(json, 1);
}
