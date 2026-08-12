import { describe, expect, it } from "vitest";
import { extractJsonObject, parseModelJsonObject } from "../src/model-json.js";

// The one implementation of "get my object back out of a model reply". Three
// reference agents had their own copy and two of the three disagreed, so
// identical model output produced different results depending on which agent
// received it.

describe("extractJsonObject", () => {
  it("recovers the object from a plain reply", () => {
    expect(extractJsonObject('{"a":1}')).toBe('{"a":1}');
  });

  it("strips fences and <thinking> blocks", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonObject('<thinking>hmm</thinking>{"a":1}')).toBe('{"a":1}');
  });

  // These four are the reason the balanced scan exists. The simpler
  // first-`{`-to-last-`}` span fails every one of them, and each is a reply a
  // person would call correct — the measured comparison is in the module header.
  it("survives prose AFTER the object that contains a brace", () => {
    expect(extractJsonObject('{"a":1} note: use { braces } carefully')).toBe('{"a":1}');
  });

  it("returns the FIRST object when a reply contains two", () => {
    expect(extractJsonObject('{"a":1} {"b":2}')).toBe('{"a":1}');
  });

  it("skips a brace that does not open valid JSON and keeps looking", () => {
    expect(extractJsonObject('starts with { and then {"real":1}')).toBe('{"real":1}');
  });

  it("survives a <thinking> block that itself contains braces", () => {
    // The case that silently cost pr-opener its whole PR description: a model
    // reasoning out loud with braces made the naive span unparseable, and a
    // failed parse is indistinguishable from a model that ignored the format.
    expect(extractJsonObject('<thinking>maybe {x} or {y}</thinking>{"a":1}')).toBe('{"a":1}');
  });

  it("does not end early on a brace inside a string value", () => {
    const input = '{"a":"literal } here","b":2}';
    expect(extractJsonObject(input)).toBe(input);
    // Built with JSON.stringify so the fixture is valid by construction: a value
    // holding both an escaped quote and a brace.
    const escaped = JSON.stringify({ a: 'an escaped " quote and a } brace' });
    expect(extractJsonObject(`prose ${escaped} tail`)).toBe(escaped);
  });

  it("returns a nested object whole", () => {
    expect(extractJsonObject('x {"a":{"b":{"c":1}}} y')).toBe('{"a":{"b":{"c":1}}}');
  });

  it("finds an object inside an array wrapper", () => {
    // A documented consequence of scanning for objects anywhere: a top-level
    // array is not an object, but an object inside one is still the reply's
    // payload.
    expect(extractJsonObject('[{"a":1}]')).toBe('{"a":1}');
  });

  it("returns null when there is no object, and never throws", () => {
    for (const input of ["", "no braces here", "{", "}", "{{{{", '{"a":', "[1,2]"]) {
      expect(() => extractJsonObject(input)).not.toThrow();
    }
    expect(extractJsonObject("no braces here")).toBeNull();
    expect(extractJsonObject("")).toBeNull();
  });
});

describe("parseModelJsonObject", () => {
  it("returns the parsed object on success", () => {
    const out = parseModelJsonObject('prose {"a":1,"b":"x"} more');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value).toEqual({ a: 1, b: "x" });
  });

  // The two failure reasons stay distinct because they point at different fixes
  // and agents surface them to a run: "no-object" means the model ignored the
  // format, "invalid" means what looked like an object would not parse (usually a
  // truncated reply). Collapsing them makes a run report useless for diagnosis.
  it("distinguishes a missing object from an unparseable one", () => {
    const missing = parseModelJsonObject("I approve this change.");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toBe("no-object");

    const truncated = parseModelJsonObject('{"summary": "was cut off mid-tok');
    expect(truncated.ok).toBe(false);
    if (!truncated.ok) expect(truncated.reason).toBe("no-object");
  });

  it("an array is not an object", () => {
    const out = parseModelJsonObject("[1,2,3]");
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("no-object");
  });

  it("never throws, whatever arrives", () => {
    for (const input of ["", "{", "}", "null", "undefined", "```json\n```", "{{{"]) {
      expect(() => parseModelJsonObject(input)).not.toThrow();
    }
  });
});
