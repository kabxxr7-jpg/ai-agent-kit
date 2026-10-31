import { describe, expect, it } from "vitest";
import { assertSchema, validate } from "../src/schema";

describe("validate", () => {
  it("checks primitive types, including integer vs number", () => {
    expect(validate({ type: "string" }, "a")).toEqual([]);
    expect(validate({ type: "string" }, 1)).toEqual(["$: expected string, got number"]);
    expect(validate({ type: "integer" }, 2)).toEqual([]);
    expect(validate({ type: "integer" }, 2.5)).toHaveLength(1);
    expect(validate({ type: "number" }, 2.5)).toEqual([]);
    expect(validate({ type: "number" }, Number.NaN)).toHaveLength(1);
    expect(validate({ type: "boolean" }, "true")).toHaveLength(1);
    expect(validate({ type: "null" }, null)).toEqual([]);
    expect(validate({ type: "array" }, {})).toEqual(["$: expected array, got object"]);
    expect(validate({ type: "object" }, [])).toEqual(["$: expected object, got array"]);
  });

  it("accepts a union of types", () => {
    const s = { type: ["string", "null"] };
    expect(validate(s, null)).toEqual([]);
    expect(validate(s, "x")).toEqual([]);
    expect(validate(s, 3)).toHaveLength(1);
  });

  it("checks string length and pattern", () => {
    const s = { type: "string", minLength: 2, maxLength: 4, pattern: "^[a-z]+$" };
    expect(validate(s, "abc")).toEqual([]);
    expect(validate(s, "a")).toEqual(["$: shorter than minLength 2"]);
    expect(validate(s, "abcde")).toEqual(["$: longer than maxLength 4"]);
    expect(validate(s, "AB")).toEqual(["$: does not match pattern ^[a-z]+$"]);
  });

  it("checks number bounds", () => {
    const s = { type: "number", minimum: 0, maximum: 10 };
    expect(validate(s, 0)).toEqual([]);
    expect(validate(s, 10)).toEqual([]);
    expect(validate(s, -1)).toEqual(["$: below minimum 0"]);
    expect(validate(s, 11)).toEqual(["$: above maximum 10"]);
  });

  it("checks enum and const with deep equality", () => {
    expect(validate({ enum: ["a", "b"] }, "a")).toEqual([]);
    expect(validate({ enum: ["a", "b"] }, "c")).toEqual(['$: must be one of ["a","b"]']);
    expect(validate({ enum: [{ x: 1 }] }, { x: 1 })).toEqual([]);
    expect(validate({ const: "open" }, "open")).toEqual([]);
    expect(validate({ const: "open" }, "closed")).toHaveLength(1);
  });

  it("checks required properties, nested paths and additionalProperties", () => {
    const s = {
      type: "object",
      properties: { id: { type: "string" }, tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 } },
      required: ["id"],
      additionalProperties: false,
    };
    expect(validate(s, { id: "a", tags: ["x"] })).toEqual([]);
    expect(validate(s, {})).toEqual(["$.id: required"]);
    expect(validate(s, { id: "a", extra: 1 })).toEqual(["$.extra: not allowed"]);
    expect(validate(s, { id: "a", tags: [] })).toEqual(["$.tags: fewer than minItems 1"]);
    expect(validate(s, { id: "a", tags: ["a", "b", "c"] })).toEqual(["$.tags: more than maxItems 2"]);
    expect(validate(s, { id: "a", tags: ["a", 2] })).toEqual(["$.tags[1]: expected string, got number"]);
    expect(validate(s, { id: 5 })).toEqual(["$.id: expected string, got number"]);
  });

  it("treats an undefined property value as missing", () => {
    expect(validate({ type: "object", required: ["a"] }, { a: undefined })).toEqual(["$.a: required"]);
  });

  it("supports a schema for additional properties", () => {
    const s = { type: "object", additionalProperties: { type: "number" } };
    expect(validate(s, { a: 1, b: 2 })).toEqual([]);
    expect(validate(s, { a: "x" })).toEqual(["$.a: expected number, got string"]);
  });

  it("supports oneOf: exactly one alternative must match", () => {
    const s = { oneOf: [{ type: "string" }, { type: "integer" }] };
    expect(validate(s, "a")).toEqual([]);
    expect(validate(s, 3)).toEqual([]);
    expect(validate(s, true)).toHaveLength(1);
    expect(validate({ oneOf: [{ type: "number" }, { type: "integer" }] }, 3)).toHaveLength(1); // matches both
  });

  it("never echoes the offending value in a message", () => {
    const secret = "sk-this-must-not-leak";
    const msgs = [
      ...validate({ type: "number" }, secret),
      ...validate({ enum: ["a"] }, secret),
      ...validate({ type: "string", pattern: "^x$" }, secret),
      ...validate({ const: "a" }, secret),
    ];
    expect(msgs.length).toBe(4);
    expect(msgs.join(" ")).not.toContain(secret);
  });
});

describe("assertSchema", () => {
  it("accepts annotations and supported keywords", () => {
    expect(() => assertSchema({ type: "object", description: "x", title: "t", properties: { a: { type: "string", default: "z" } } })).not.toThrow();
  });

  it("rejects keywords that would be silently ignored", () => {
    expect(() => assertSchema({ type: "object", patternProperties: {} })).toThrow('unsupported schema keyword "patternProperties"');
    expect(() => assertSchema({ type: "object", properties: { a: { format: "email" } } })).toThrow('"format" at $.a');
    expect(() => assertSchema({ anyOf: [] })).toThrow('"anyOf"');
  });

  it("rejects malformed schemas", () => {
    expect(() => assertSchema(null)).toThrow("must be an object");
    expect(() => assertSchema({ type: "text" })).toThrow("unknown type");
    expect(() => assertSchema({ pattern: "(" })).toThrow("invalid pattern");
    expect(() => assertSchema({ required: "id" })).toThrow("array of strings");
    expect(() => assertSchema({ oneOf: {} })).toThrow("oneOf");
  });
});
