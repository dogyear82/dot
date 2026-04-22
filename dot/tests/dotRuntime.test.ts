import assert from "node:assert/strict";
import test from "node:test";

import { createRuntimeWorldLookupAdapters } from "../src/runtime/dotRuntime.js";

test("createRuntimeWorldLookupAdapters includes NewsData when the API key is configured", () => {
  const adapters = createRuntimeWorldLookupAdapters({
    NEWSDATA_API_KEY: "test-newsdata-key"
  });

  assert.ok(adapters.newsdata);
});

test("createRuntimeWorldLookupAdapters omits NewsData when the API key is empty", () => {
  const adapters = createRuntimeWorldLookupAdapters({
    NEWSDATA_API_KEY: ""
  });

  assert.equal(adapters.newsdata, undefined);
});
