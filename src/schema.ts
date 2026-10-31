import type { JsonSchema } from "./types";

// A small JSON Schema validator for the subset tool definitions need. It is hand-written so the
// kit has no runtime dependency. Unsupported keywords are rejected up front (see assertSchema)
// rather than silently ignored, because a keyword that is ignored is a check that does not happen.

const ANNOTATIONS = new Set(["description", "title", "default", "examples", "$schema"]);
const SUPPORTED = new Set([
  ...ANNOTATIONS,
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "oneOf",
]);
const TYPES = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

/** Throws when the schema uses a keyword this validator does not implement, or is malformed. */
export function assertSchema(schema: unknown, path = "$"): asserts schema is JsonSchema {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw new Error(`schema at ${path} must be an object`);
  }
  const s = schema as JsonSchema;
  for (const key of Object.keys(s)) {
    if (!SUPPORTED.has(key)) throw new Error(`unsupported schema keyword "${key}" at ${path}`);
  }
  if ("type" in s) {
    const types = Array.isArray(s.type) ? s.type : [s.type];
    for (const t of types) {
      if (typeof t !== "string" || !TYPES.has(t)) throw new Error(`unknown type ${JSON.stringify(t)} at ${path}`);
    }
  }
  if ("pattern" in s) {
    try {
      new RegExp(String(s.pattern));
    } catch {
      throw new Error(`invalid pattern at ${path}`);
    }
  }
  if (s.properties !== undefined) {
    if (typeof s.properties !== "object" || s.properties === null) throw new Error(`properties at ${path} must be an object`);
    for (const [k, v] of Object.entries(s.properties)) assertSchema(v, `${path}.${k}`);
  }
  if (typeof s.additionalProperties === "object" && s.additionalProperties !== null) {
    assertSchema(s.additionalProperties, `${path}.additionalProperties`);
  }
  if (s.items !== undefined) assertSchema(s.items, `${path}[]`);
  if (s.oneOf !== undefined) {
    if (!Array.isArray(s.oneOf)) throw new Error(`oneOf at ${path} must be an array`);
    s.oneOf.forEach((sub, i) => assertSchema(sub, `${path}.oneOf[${i}]`));
  }
  if (s.required !== undefined && !(Array.isArray(s.required) && s.required.every((r) => typeof r === "string"))) {
    throw new Error(`required at ${path} must be an array of strings`);
  }
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeOf(value) === type;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Returns a list of problems, empty when the value is valid. Messages name the path and the
 * rule but never echo the offending value, so they are safe to hand back to a model.
 */
export function validate(schema: JsonSchema, value: unknown, path = "$"): string[] {
  const errors: string[] = [];

  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
      return errors; // the rest of the keywords assume the right type
    }
  }
  if (schema.enum !== undefined && !(schema.enum as unknown[]).some((e) => deepEqual(e, value))) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: does not match pattern ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${path}: more than maxItems ${schema.maxItems}`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, i) => errors.push(...validate(schema.items as JsonSchema, item, `${path}[${i}]`)));
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>;
    for (const key of (schema.required ?? []) as string[]) {
      if (!(key in obj) || obj[key] === undefined) errors.push(`${path}.${key}: required`);
    }
    for (const [key, sub] of Object.entries(props)) {
      if (key in obj && obj[key] !== undefined) errors.push(...validate(sub, obj[key], `${path}.${key}`));
    }
    if (schema.additionalProperties !== undefined) {
      for (const key of Object.keys(obj)) {
        if (key in props) continue;
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
        else if (typeof schema.additionalProperties === "object") {
          errors.push(...validate(schema.additionalProperties as JsonSchema, obj[key], `${path}.${key}`));
        }
      }
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const matching = (schema.oneOf as JsonSchema[]).filter((sub) => validate(sub, value, path).length === 0).length;
    if (matching !== 1) errors.push(`${path}: must match exactly one of ${schema.oneOf.length} alternatives (matched ${matching})`);
  }

  return errors;
}
