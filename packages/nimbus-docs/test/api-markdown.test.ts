// The API-page Markdown emitter: pure view-model → Markdown. Asserts corpus
// safety (no `#` H1), determinism, per-kind completeness, nesting/truncation,
// OR-of-AND auth, and a full-sweep resilience pass over the smallco model.

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildApiModel,
  getApiPageProps,
  getApiPageSlugs,
  renderApiPageMarkdown,
  type ApiModel,
  type ApiFieldView,
  type ApiOperationPage,
  type ApiRootPage,
  type ApiSchemaPage,
} from "../src/api/index.js";

function fixture(rel: string): string {
  return fileURLToPath(new URL(`./fixtures/api/${rel}`, import.meta.url));
}

function field(partial: Partial<ApiFieldView> & { name: string }): ApiFieldView {
  return {
    coordinate: `c.${partial.name}`,
    type: "string",
    required: false,
    anchor: partial.name,
    children: [],
    childCount: 0,
    truncated: false,
    ...partial,
  };
}

function schema(fields: ApiFieldView[], description?: string): ApiSchemaPage {
  return {
    apiSchemaVersion: 1,
    kind: "schema",
    collection: "x",
    coordinate: "c",
    href: "/x/c",
    markdownHref: "/x/c.md",
    title: "S",
    breadcrumbs: [],
    ...(description ? { description } : {}),
    fields,
  };
}

function operation(partial: Partial<ApiOperationPage>): ApiOperationPage {
  return {
    apiSchemaVersion: 1,
    kind: "operation",
    collection: "x",
    coordinate: "c",
    href: "/x/c",
    markdownHref: "/x/c.md",
    title: "Op",
    breadcrumbs: [],
    method: "get",
    path: "/things",
    auth: [],
    parameters: [],
    body: [],
    responses: [],
    samples: [],
    ...partial,
  };
}

let smallco: ApiModel;

before(async () => {
  smallco = await buildApiModel({
    collection: "smallco",
    spec: readFileSync(fixture("smallco.yaml"), "utf8"),
    label: "smallco.yaml",
  });
});

describe("api markdown emitter", () => {
  test("output is corpus-safe: no single-hash H1 lines", () => {
    for (const { coordinate } of getApiPageSlugs(smallco)) {
      const md = renderApiPageMarkdown(getApiPageProps(smallco, coordinate));
      for (const line of md.split("\n")) {
        assert.doesNotMatch(line, /^# /, `H1 in ${coordinate}: ${line}`);
      }
    }
  });

  test("deterministic across independent projections of the same node", () => {
    // Two fresh projections → distinct object graphs, same content. Catches
    // iteration-order nondeterminism the same-object-twice check cannot.
    const a = renderApiPageMarkdown(getApiPageProps(smallco, "create"));
    const b = renderApiPageMarkdown(getApiPageProps(smallco, "create"));
    assert.equal(a, b);
  });

  test("full sweep: every page renders to non-empty markdown, no throw", () => {
    const slugs = getApiPageSlugs(smallco);
    assert.ok(slugs.length > 0);
    for (const { coordinate } of slugs) {
      const md = renderApiPageMarkdown(getApiPageProps(smallco, coordinate));
      assert.equal(typeof md, "string");
      assert.ok(md.trim().length > 0, `empty markdown for ${coordinate}`);
      assert.ok(md.endsWith("\n"), `missing trailing newline for ${coordinate}`);
    }
  });

  test("operation page carries method + path and its facts", () => {
    const props = getApiPageProps(smallco, "create");
    assert.equal(props.kind, "operation");
    const md = renderApiPageMarkdown(props);
    assert.match(md, /`POST \/[^`]*`/);
      for (const group of (props as ApiOperationPage).parameters) {
        for (const f of group.fields) assert.ok(md.includes(f.coordinate));
      }
      for (const f of (props as ApiOperationPage).body) {
        assert.ok(md.includes(f.coordinate), `missing body field ${f.coordinate}`);
      }
    for (const r of (props as ApiOperationPage).responses) {
      assert.ok(md.includes(`### ${r.status}`) || md.includes(`### ${r.status} —`));
    }
  });

  test("schema page lists its fields under ## Fields", () => {
    const props = getApiPageProps(smallco, "Charge") as ApiSchemaPage;
    assert.equal(props.kind, "schema");
    const md = renderApiPageMarkdown(props);
    assert.match(md, /## Fields/);
    for (const f of props.fields) assert.ok(md.includes(f.coordinate), `missing ${f.coordinate}`);
  });

  test("each field row is titled by its full coordinate, so an agent can cite it", () => {
    const props = getApiPageProps(smallco, "create") as ApiOperationPage;
    const md = renderApiPageMarkdown(props);
    // The body field `amount` is addressable as `create.amount`, not bare `amount`.
    assert.match(md, /- `create\.amount` \(/);
    const amount = props.body.find((f) => f.name === "amount");
    assert.equal(amount!.coordinate, "create.amount");
  });

  test("scalar/enum schema page renders Type + constraints + enum, never 'no fields'", () => {
    const props = getApiPageProps(smallco, "Currency") as ApiSchemaPage;
    assert.equal(props.kind, "schema");
    assert.ok(props.scalar, "scalar shape is projected");
    const md = renderApiPageMarkdown(props);
    assert.match(md, /Type: `string`/);
    assert.match(md, /one of `"usd"`/);
    assert.match(md, /minLength 3/);
    assert.match(md, /pattern `\^\[a-z\]\{3\}\$`/);
    assert.doesNotMatch(md, /No fields documented/);
  });

  test("top-level union renders 'One of:' with a link per named variant, never 'no fields'", () => {
    const props = getApiPageProps(smallco, "EitherAccount") as ApiSchemaPage;
    const md = renderApiPageMarkdown(props);
    assert.match(md, /^One of:$/m);
    assert.match(md, /- \[Card\]\(\/smallco\/schemas\/Card\)/);
    assert.match(md, /- \[BankAccount\]\(\/smallco\/schemas\/BankAccount\)/);
    assert.doesNotMatch(md, /No fields documented/);
  });

  test("mixed union renders a link for the named branch and inline code for the anonymous one", () => {
    const props = getApiPageProps(smallco, "Mixed") as ApiSchemaPage;
    const md = renderApiPageMarkdown(props);
    assert.match(md, /^Any of:$/m);
    assert.match(md, /- \[Card\]\(\/smallco\/schemas\/Card\)/);
    assert.match(md, /- `string`/);
  });

  test("discriminated union renders the value→variant mapping", async () => {
    const model = await buildApiModel({
      collection: "disc",
      spec: {
        openapi: "3.0.0",
        info: { title: "D", version: "1" },
        paths: {},
        components: {
          schemas: {
            A: { type: "object", properties: { k: { type: "string" } } },
            B: { type: "object", properties: { k: { type: "string" } } },
            U: {
              oneOf: [{ $ref: "#/components/schemas/A" }, { $ref: "#/components/schemas/B" }],
              discriminator: {
                propertyName: "k",
                mapping: { a: "#/components/schemas/A", b: "#/components/schemas/B" },
              },
            },
          },
        },
      },
    });
    const md = renderApiPageMarkdown(getApiPageProps(model, "U"));
    assert.match(md, /Discriminator: `k`/);
    assert.match(md, /- `a` → \[A\]\(\/disc\/schemas\/A\)/);
    assert.match(md, /- `b` → \[B\]\(\/disc\/schemas\/B\)/);
  });

  test("a backtick in a variant's schema name cannot corrupt the link", async () => {
    const model = await buildApiModel({
      collection: "inj",
      spec: {
        openapi: "3.0.0",
        info: { title: "I", version: "1" },
        paths: {},
        components: {
          schemas: {
            "Ev`il": { type: "object", properties: { x: { type: "string" } } },
            W: { oneOf: [{ $ref: "#/components/schemas/Ev`il" }] },
          },
        },
      },
    });
    const md = renderApiPageMarkdown(getApiPageProps(model, "W"));
    // Backtick escaped in the label, %60 in the href — no code span forms.
    assert.match(md, /- \[Ev\\`il\]\(\/inj\/schemas\/Ev%60il\)/);
  });

  test("backslash in a variant name is escaped in the label so it can't eat the closing bracket", async () => {
    const model = await buildApiModel({
      collection: "esc",
      spec: {
        openapi: "3.0.0",
        info: { title: "E", version: "1" },
        paths: {},
        components: {
          schemas: {
            "Trail\\": { type: "object", properties: { x: { type: "string" } } },
            U: { oneOf: [{ $ref: "#/components/schemas/Trail\\" }] },
          },
        },
      },
    });
    const md = renderApiPageMarkdown(getApiPageProps(model, "U"));
    // Label carries an escaped backslash (`\\`), so the `]` still closes the span.
    assert.match(md, /- \[Trail\\\\\]\(/);
  });

  test("tab/control chars in a variant href are percent-encoded, never left raw", async () => {
    const model = await buildApiModel({
      collection: "esc",
      spec: {
        openapi: "3.0.0",
        info: { title: "E", version: "1" },
        paths: {},
        components: {
          schemas: {
            "Tab\tX": { type: "object", properties: { x: { type: "string" } } },
            U: { oneOf: [{ $ref: "#/components/schemas/Tab\tX" }] },
          },
        },
      },
    });
    const md = renderApiPageMarkdown(getApiPageProps(model, "U"));
    const linkLine = md.split("\n").find((l) => l.includes("schemas/Tab"));
    assert.ok(linkLine, "the variant link line is present");
    assert.doesNotMatch(linkLine!, /[\t\r\n]/, "no raw control char survives in the link line");
    assert.match(linkLine!, /schemas\/Tab%09X/, "tab is encoded as %09 in the href");
  });

  test("malformed non-string schema `type` is coerced, never crashes the emitter", async () => {
    const model = await buildApiModel({
      collection: "weird",
      spec: {
        openapi: "3.0.0",
        info: { title: "W", version: "1" },
        paths: {},
        components: { schemas: { Weird: { type: 123, minLength: 1 } } },
      },
    });
    let md = "";
    assert.doesNotThrow(() => {
      md = renderApiPageMarkdown(getApiPageProps(model, "Weird"));
    });
    assert.match(md, /Type: `unknown`/);
    assert.match(md, /minLength 1/);
  });

  test("section + root pages emit ref links", () => {
    const section = renderApiPageMarkdown(getApiPageProps(smallco, "tags.charges"));
    assert.match(section, /## Operations/);
    assert.match(section, /- \[.+\]\(.+\)/);

    const root = renderApiPageMarkdown(getApiPageProps(smallco, "smallco"));
    assert.match(root, /## Sections/);
  });

  test("deprecation banner links the successor", () => {
    const md = renderApiPageMarkdown(
      operation({
        deprecated: true,
        deprecation: { successor: { label: "createV2", href: "/x/create-v2" } },
      }),
    );
    assert.match(md, /> \*\*Deprecated\.\*\* Use \[createV2\]\(\/x\/create-v2\)/);
  });

  test("nested fields indent by two spaces per depth", () => {
    const md = renderApiPageMarkdown({
      apiSchemaVersion: 1,
      kind: "schema",
      collection: "x",
      coordinate: "c",
      href: "/x/c",
      markdownHref: "/x/c.md",
      title: "S",
      breadcrumbs: [],
      fields: [
        field({
          name: "parent",
          type: "object",
          required: true,
          children: [field({ name: "child", coordinate: "c.parent.child" })],
          childCount: 1,
        }),
      ],
    });
    assert.match(md, /^- `c\.parent`/m);
    assert.match(md, /^ {2}- `c\.parent\.child`/m);
  });

  test("truncated children emit an omitted-count note", () => {
    const md = renderApiPageMarkdown({
      apiSchemaVersion: 1,
      kind: "schema",
      collection: "x",
      coordinate: "c",
      href: "/x/c",
      markdownHref: "/x/c.md",
      title: "S",
      breadcrumbs: [],
      fields: [field({ name: "big", type: "object", childCount: 9, truncated: true })],
    });
    assert.match(md, /… 9 more field\(s\) omitted/);
  });

  test("OR-of-AND auth renders alternatives", () => {
    const md = renderApiPageMarkdown(
      operation({
        auth: [
          [{ scheme: "apiKey", type: "apiKey", in: "header", headerName: "X-Key", scopes: [] }],
          [{ scheme: "oauth", type: "oauth2", scopes: ["read", "write"] }],
        ],
      }),
    );
    assert.match(md, /## Authentication/);
    assert.match(md, /Requires one of the following:/);
    assert.match(md, /`apiKey`/);
    assert.ok(md.includes("scopes: `read`, `write`"));
  });

  test("union typeRefs render as linked alternatives", () => {
    const md = renderApiPageMarkdown(
      schema([
        field({
          name: "u",
          type: "A | B",
          typeRefs: [
            { label: "A", href: "/x/a" },
            { label: "B", href: "/x/b" },
          ],
        }),
      ]),
    );
    assert.match(md, /\[A\]\(\/x\/a\) \| \[B\]\(\/x\/b\)/);
  });

  test("injection: a heading-forging description cannot forge structure", () => {
    for (const desc of ["# Overview", "intro\n# Section", "intro\n## Fields"]) {
      const md = renderApiPageMarkdown(schema([], desc));
      assert.doesNotMatch(md, /^# /m, `H1 leaked for ${JSON.stringify(desc)}`);
      assert.doesNotMatch(md, /^## Fields$/m, `forged ## Fields for ${JSON.stringify(desc)}`);
    }
  });

  test("injection: setext underline in a description is neutralized", () => {
    const md = renderApiPageMarkdown(schema([], "Status codes\n============"));
    assert.doesNotMatch(md, /^=+\s*$/m);
  });

  test("injection: a backtick in a field name keeps the code span intact", () => {
    const md = renderApiPageMarkdown(schema([field({ name: "a`b" })]));
    // The coordinate (`c.a`b`) carries the backtick and is adaptively fenced.
    assert.ok(md.includes("``c.a`b``"), "field coordinate not adaptively fenced");
  });

  test("injection: hostile path, bearerFormat, and format cannot forge a heading", () => {
    const opMd = renderApiPageMarkdown(
      operation({
        path: "/a\n# forged",
        auth: [[{ scheme: "bearer", type: "http", bearerFormat: "x\n# forged", scopes: [] }]],
      }),
    );
    assert.doesNotMatch(opMd, /^# /m);
    assert.doesNotMatch(opMd, /^=+\s*$/m);

    const schemaMd = renderApiPageMarkdown(
      schema([field({ name: "f", constraints: { format: "x\n# forged" } })]),
    );
    assert.doesNotMatch(schemaMd, /^# /m);
  });

  test("injection: a backtick in the path keeps the method line's span intact", () => {
    const md = renderApiPageMarkdown(operation({ method: "get", path: "/a`b" }));
    assert.ok(md.includes("``GET /a`b``"), "path not adaptively fenced");
  });

  test("injection: a bracket in a ref label is escaped", () => {
    const md = renderApiPageMarkdown({
      apiSchemaVersion: 1,
      kind: "section",
      collection: "x",
      coordinate: "c",
      href: "/x/c",
      markdownHref: "/x/c.md",
      title: "Sec",
      breadcrumbs: [],
      operations: [{ label: "List [beta]", href: "/x/op" }],
    });
    assert.match(md, /\[List \\\[beta\\\]\]\(\/x\/op\)/);
  });

  test("injection: hostile auth.in cannot forge a heading", () => {
    const md = renderApiPageMarkdown(
      operation({
        auth: [[{ scheme: "s", type: "apiKey", in: "header\n# forged" as "header", scopes: [] }]],
      }),
    );
    assert.doesNotMatch(md, /^# /m);
  });

  test("injection: a newline or paren in a link href is neutralized", () => {
    const md = renderApiPageMarkdown({
      apiSchemaVersion: 1,
      kind: "section",
      collection: "x",
      coordinate: "c",
      href: "/x/c",
      markdownHref: "/x/c.md",
      title: "Sec",
      breadcrumbs: [],
      operations: [{ label: "op", href: "/x/tags/a\n# forged/op" }],
    });
    assert.doesNotMatch(md, /^# /m);
    assert.ok(md.includes("(/x/tags/a#%20forged/op)"), "newline not stripped from href");
  });

  test("injection: star and underscore thematic breaks in a description are neutralized", () => {
    for (const rule of ["***", "___", "* * *"]) {
      const md = renderApiPageMarkdown(schema([], `intro\n\n${rule}\n\nmore`));
      assert.doesNotMatch(md, /^(\*|_|\* |_ ){3,}\s*$/m, `unescaped ${rule}`);
    }
  });

  test("injection: a lone CR in a description cannot forge an ATX heading", () => {
    const md = renderApiPageMarkdown(schema([], "intro\r# forged"));
    assert.doesNotMatch(md, /(^|\r)# /);
  });

  test("injection: a lone CR in a description cannot forge a setext heading", () => {
    const md = renderApiPageMarkdown(schema([], "Status codes\r============"));
    assert.doesNotMatch(md, /(^|\r)=+\s*$/m);
  });

  test("injection: a dash setext underline in a description is neutralized", () => {
    const md = renderApiPageMarkdown(schema([], "Status codes\n---"));
    assert.doesNotMatch(md, /^-+\s*$/m);
  });

  test("injection: parens in a link href are percent-encoded", () => {
    const md = renderApiPageMarkdown({
      apiSchemaVersion: 1,
      kind: "section",
      collection: "x",
      coordinate: "c",
      href: "/x/c",
      markdownHref: "/x/c.md",
      title: "Sec",
      breadcrumbs: [],
      operations: [{ label: "op", href: "/x/tags/a(b)/op" }],
    });
    assert.ok(md.includes("(/x/tags/a%28b%29/op)"), "parens not encoded in href");
  });

  test("injection: a multi-line field type collapses to one line", () => {
    const md = renderApiPageMarkdown(schema([field({ name: "f", type: "object\n# forged" })]));
    assert.doesNotMatch(md, /^# /m);
  });

  test("injection: a multi-line ref label collapses and cannot forge a break", () => {
    const md = renderApiPageMarkdown({
      apiSchemaVersion: 1,
      kind: "section",
      collection: "x",
      coordinate: "c",
      href: "/x/c",
      markdownHref: "/x/c.md",
      title: "Sec",
      breadcrumbs: [],
      operations: [{ label: "Do a thing.\n\n---\n\nMore prose.", href: "/x/op" }],
    });
    assert.doesNotMatch(md, /^-+\s*$/m, "thematic break leaked from a ref label");
    assert.doesNotMatch(md, /^# /m);
    assert.match(md, /- \[Do a thing\. --- More prose\.\]\(\/x\/op\)/);
  });

  test("deprecation surfaces a migration guide even without a successor", () => {
    const md = renderApiPageMarkdown(
      operation({
        deprecated: true,
        deprecation: { migrationHref: "/x/guide" },
      }),
    );
    assert.match(md, /> \*\*Deprecated\.\*\*/);
    assert.match(md, /\[migration guide\]\(\/x\/guide\)/);
  });

  test("field.link renders a details reference", () => {
    const md = renderApiPageMarkdown(
      schema([field({ name: "nested", type: "object", link: { label: "x", href: "/x/nested" } })]),
    );
    assert.match(md, /\(\[details\]\(\/x\/nested\)\)/);
  });

  test("root page emits version, servers, and section links", () => {
    const root: ApiRootPage = {
      apiSchemaVersion: 1,
      kind: "api",
      collection: "x",
      coordinate: "x",
      href: "/x",
      markdownHref: "/x.md",
      title: "X API",
      breadcrumbs: [],
      version: "2024-01-01",
      servers: ["https://api.example.com/v1"],
      sections: [{ label: "Charges", href: "/x/charges" }],
    };
    const md = renderApiPageMarkdown(root);
    assert.match(md, /Version: 2024-01-01/);
    assert.match(md, /## Servers/);
    assert.ok(md.includes("`https://api.example.com/v1`"));
    assert.match(md, /## Sections/);
    assert.match(md, /\[Charges\]\(\/x\/charges\)/);
  });

  test("response headers render under a Headers block", () => {
    const md = renderApiPageMarkdown(
      operation({
        responses: [
          {
            coordinate: "c.200",
            status: "200",
            anchor: "r-200",
            headers: [field({ name: "X-Rate-Limit", type: "integer" })],
            fields: [field({ name: "id", type: "string" })],
          },
        ],
      }),
    );
    assert.match(md, /### 200/);
    assert.match(md, /Headers:/);
    assert.ok(md.includes("`c.X-Rate-Limit`"));
  });

  test("deeply nested truncation indents four spaces at depth two", () => {
    const md = renderApiPageMarkdown(
      schema([
        field({
          name: "a",
          type: "object",
          children: [
            field({
              name: "b",
              coordinate: "c.a.b",
              type: "object",
              childCount: 3,
              truncated: true,
            }),
          ],
          childCount: 1,
        }),
      ]),
    );
    assert.match(md, /^ {4}- … 3 more field\(s\) omitted$/m);
  });

  test("breadcrumbs render as a path trail", () => {
    const md = renderApiPageMarkdown(
      operation({ breadcrumbs: [{ label: "X API", href: "/x" }, { label: "Charges", href: "/x/charges" }] }),
    );
    assert.match(md, /^Path: X API › Charges$/m);
  });

  test("content-less schema emits an explicit empty-body signal", () => {
    const md = renderApiPageMarkdown(schema([]));
    assert.match(md, /_No fields documented\._/);
    assert.ok(md.trim().length > 0);
  });
});
