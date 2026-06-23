// webToolsEnabled() is the gate agents use to avoid OFFERING/advertising web
// tools the budget will only reject at call time. It mirrors the budget's own
// ANCHORAGE_TOOL_WEB_ENABLED parsing (default OFF). Dependency-free (node:test),
// run against the built dist with `node --test`.

import assert from "node:assert/strict";
import test from "node:test";
import { webToolsEnabled } from "../dist/index.js";

const KEY = "ANCHORAGE_TOOL_WEB_ENABLED";

function withEnv(value, fn) {
  const had = Object.hasOwn(process.env, KEY);
  const prev = process.env[KEY];
  if (value === undefined) delete process.env[KEY];
  else process.env[KEY] = value;
  try {
    fn();
  } finally {
    if (had) process.env[KEY] = prev;
    else delete process.env[KEY];
  }
}

test("defaults to disabled when the env var is unset", () => {
  withEnv(undefined, () => assert.equal(webToolsEnabled(), false));
});

test("truthy values enable web tools", () => {
  for (const v of ["true", "1", "yes", "on", "TRUE", "On"]) {
    withEnv(v, () => assert.equal(webToolsEnabled(), true, `expected true for ${v}`));
  }
});

test("falsy / unrecognized values keep web tools disabled", () => {
  for (const v of ["false", "0", "no", "off", "", "maybe"]) {
    withEnv(v, () => assert.equal(webToolsEnabled(), false, `expected false for ${v}`));
  }
});
