import { test } from "node:test";
import assert from "node:assert/strict";

import { prepareApiPageCode } from "../src/_internal/api-loader.js";
import {
  isPreparedApiPage,
  preparedApiVersion,
} from "../src/_internal/api/prepared.js";
import { buildApiModel, getApiPageProps } from "../src/api/index.js";

test("prepares every named request example", async () => {
  const model = await buildApiModel({
    collection: "named-examples",
    spec: {
      openapi: "3.1.0",
      info: { title: "Named examples", version: "1" },
      paths: {
        "/status": {
          patch: {
            operationId: "changeStatus",
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { status: { type: "string" } },
                  },
                  examples: {
                    pause: { value: { status: "pause" } },
                    resume: { value: { status: "resume" } },
                  },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    },
  });
  const page = await prepareApiPageCode(getApiPageProps(model, "changeStatus"));
  assert.equal(page.kind, "operation");
  if (page.kind !== "operation") return;
  assert.equal(page.requestExamples?.length, 2);
  assert.ok(
    page.requestExamples?.every((example) =>
      example.highlightedHtml?.includes("<pre"),
    ),
  );
  assert.equal(
    isPreparedApiPage({
      version: preparedApiVersion,
      page,
      navEntryId: page.coordinate,
    }),
    true,
  );
});
