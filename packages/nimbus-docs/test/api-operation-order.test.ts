// `x-nimbus-order` places an operation among its section's operations, and the
// section page, the sidebar and the home's index all follow; operations without
// it come after, in the spec's path order. Sections themselves keep their order.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildApiModel,
  getApiNav,
  getApiPageProps,
  type ApiRootPage,
  type ApiSectionPage,
} from "../src/api/index.js";

const op = (operationId: string, tag: string, order?: unknown) => ({
  operationId,
  tags: [tag],
  responses: { "200": { description: "ok" } },
  ...(order === undefined ? {} : { "x-nimbus-order": order }),
});

function modelOf(paths: Record<string, unknown>, tags?: { name: string }[]) {
  const spec = {
    openapi: "3.0.0",
    info: { title: "T", version: "1.0.0" },
    ...(tags ? { tags } : {}),
    paths,
  };
  return buildApiModel({ collection: "api", spec });
}

test("ordered operations come first by x-nimbus-order, the rest in path order", async () => {
  const model = await modelOf(
    {
      "/users": {
        get: op("listUsers", "Users", 1),
        post: op("createUser", "Users", 3),
      },
      "/users/export": { get: op("exportUsers", "Users", "1") },
      "/users/{id}": {
        get: op("getUser", "Users", 2),
        delete: op("deleteUser", "Users", 5),
        patch: op("updateUser", "Users", 4),
      },
      "/users/import": { post: op("importUsers", "Users") },
    },
    [{ name: "Users" }],
  );
  const expected = [
    "listUsers",
    "getUser",
    "createUser",
    "updateUser",
    "deleteUser",
    "exportUsers",
    "importUsers",
  ];
  const page = getApiPageProps(model, "tags.Users") as ApiSectionPage;
  assert.deepEqual(
    page.operations.map((o) => o.label),
    expected,
  );
  const section = getApiNav(model).items.find(
    (item) => item.coordinate === "tags.Users",
  )!;
  assert.deepEqual(
    section.children.map((child) => child.label),
    expected,
  );
  const root = getApiPageProps(model, "api") as ApiRootPage;
  assert.deepEqual(
    root.index.groups[0]!.sections[0]!.operations.map((o) => o.label),
    expected,
  );
});

test("sections first seen on an operation keep their path order; root operations sort", async () => {
  const model = await modelOf({
    "/a": { get: op("alphaOne", "Alpha") },
    "/b": { get: op("betaOne", "Beta", 1) },
    "/r1": {
      get: {
        operationId: "rootTwo",
        responses: { "200": { description: "ok" } },
      },
    },
    "/r2": {
      get: {
        operationId: "rootOne",
        responses: { "200": { description: "ok" } },
        "x-nimbus-order": 1,
      },
    },
  });
  const sections = getApiNav(model).items.filter(
    (item) => item.kind === "section",
  );
  assert.deepEqual(
    sections.map((item) => item.label),
    ["Alpha", "Beta"],
  );
  const root = getApiPageProps(model, "api") as ApiRootPage;
  assert.deepEqual(
    root.index.groups[0]!.sections.map((s) => s.ref.label),
    ["Alpha", "Beta"],
  );
  assert.deepEqual(
    root.index.operations.map((o) => o.label),
    ["rootOne", "rootTwo"],
  );
});

test("equal orders keep the spec's path order between them", async () => {
  const model = await modelOf({
    "/b": { get: op("b", "pets", 1) },
    "/a": { get: op("a", "pets", 1) },
    "/c": { get: op("c", "pets") },
  });
  const section = getApiPageProps(model, "tags.pets") as ApiSectionPage;
  assert.deepEqual(section.operations.map((o) => o.label), ["b", "a", "c"]);
});
