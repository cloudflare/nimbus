import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveMdxOptions } from "../src/integration.js";

test("MDX optimize is enabled by default", () => {
  assert.deepEqual(resolveMdxOptions(undefined), { optimize: true });
});

test("MDX optimize remains opt-out", () => {
  assert.deepEqual(resolveMdxOptions({ optimize: false }), { optimize: false });
});

test("native MDX options pass through", () => {
  const remark = () => undefined;
  const rehype = () => undefined;
  const recma = () => undefined;
  const remarkRehype = { allowDangerousHtml: true };
  assert.deepEqual(resolveMdxOptions({
    gfm: false,
    smartypants: false,
    remarkPlugins: [remark],
    rehypePlugins: [rehype],
    recmaPlugins: [recma],
    remarkRehype,
  }), {
    optimize: true,
    gfm: false,
    smartypants: false,
    remarkPlugins: [remark],
    rehypePlugins: [rehype],
    recmaPlugins: [recma],
    remarkRehype,
  });
});
