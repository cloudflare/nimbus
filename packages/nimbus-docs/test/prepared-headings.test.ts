import assert from "node:assert/strict";
import { test } from "node:test";

import { validatePreparedHeadings } from "../src/_internal/prepared-headings.js";

const heading = { depth: 2, text: "Prepared", slug: "prepared" };

test("validates and returns one prepared heading record", () => {
  assert.deepEqual(
    validatePreparedHeadings(
      {
        generation: 1,
        base: "/docs",
        records: [
          {
            collection: "docs",
            id: "guide",
            generation: 1,
            base: "/docs",
            headings: [heading],
          },
        ],
      },
      "docs",
      "guide",
      "/docs/",
    ),
    [heading],
  );
});

test("returns null when a public heading record was not baked", () => {
  assert.equal(
    validatePreparedHeadings(
      { generation: 1, base: "/", records: [] },
      "custom",
      "guide",
      "/",
    ),
    null,
  );
});

test("rejects stale, duplicate, and malformed records", () => {
  assert.throws(
    () =>
      validatePreparedHeadings(
        { generation: 1, base: "/old", records: [] },
        "docs",
        "guide",
        "/docs",
      ),
    /stale/,
  );
  const record = {
    collection: "docs",
    id: "guide",
    generation: 1,
    base: "/docs",
    headings: [heading],
  };
  assert.throws(
    () =>
      validatePreparedHeadings(
        { generation: 1, base: "/docs", records: [record, record] },
        "docs",
        "guide",
        "/docs",
      ),
    /duplicate/,
  );
  assert.throws(
    () =>
      validatePreparedHeadings(
        {
          generation: 1,
          base: "/docs",
          records: [{ ...record, headings: [{ ...heading, depth: 2.5 }] }],
        },
        "docs",
        "guide",
        "/docs",
      ),
    /malformed/,
  );
});
