// The sidebar for a page that isn't an API page reads only a prepared entry's
// envelope: the prepared page, which can be large, is never touched.
import assert from "node:assert/strict";
import { test } from "node:test";

import { preparedApiVersion, preparedNavEntryId } from "../src/_internal/api/prepared.js";

test("the nav entry comes from the envelope without reading the page", () => {
  const prepared = {
    version: preparedApiVersion,
    navEntryId: "api",
    get page(): never {
      throw new Error("the prepared page was read");
    },
  };
  assert.equal(preparedNavEntryId(prepared), "api");
});

test("anything but a current prepared page has no nav entry", () => {
  assert.equal(preparedNavEntryId(undefined), undefined);
  assert.equal(preparedNavEntryId({ version: preparedApiVersion - 1, navEntryId: "api" }), undefined);
  assert.equal(preparedNavEntryId({ version: preparedApiVersion }), undefined);
});
