import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { satteri } from "@astrojs/markdown-satteri";
import { unified } from "@astrojs/markdown-remark";
import type {
  AstroMarkdownOptions,
  MarkdownRenderOptions,
  MarkdownRenderResult,
  MdxRenderResult,
  MdxRendererOptions,
} from "astro/markdown";

import { decorateMarkdownProcessor } from "../src/_internal/markdown-processor-decorator.ts";

const shared = { syntaxHighlight: false } as AstroMarkdownOptions;

describe("Markdown processor decoration", () => {
  test("transforms real Satteri renderer input", async () => {
    const processor = satteri();
    const decorated = decorateMarkdownProcessor(processor, (source) =>
      source.replace("before", "after"),
    );

    const renderer = await decorated.createRenderer(shared);
    const result = await renderer.render("before", { frontmatter: {} });

    assert.match(result.code, /<p>after<\/p>/);
    assert.equal(decorated.name, processor.name);
    assert.equal(decorated.options, processor.options);
    assert.equal(
      Object.getPrototypeOf(decorated),
      Object.getPrototypeOf(processor),
    );
  });

  test("transforms real Unified renderer input", async () => {
    const processor = unified();
    const decorated = decorateMarkdownProcessor(processor, (source) =>
      source.replace("before", "after"),
    );

    const renderer = await decorated.createRenderer(shared);
    const result = await renderer.render("before", { frontmatter: {} });

    assert.match(result.code, /<p>after<\/p>/);
    assert.equal(decorated.name, processor.name);
    assert.equal(decorated.options, processor.options);
  });

  test("supports frozen processors and renderers", async () => {
    const renderer = Object.freeze({
      async render(source: string): Promise<MarkdownRenderResult> {
        return {
          code: source,
          metadata: {
            headings: [],
            localImagePaths: [],
            remoteImagePaths: [],
            frontmatter: {},
          },
        };
      },
    });
    const processor = Object.freeze({
      name: "frozen",
      options: Object.freeze({}),
      async createRenderer() {
        return renderer;
      },
    });

    const decorated = decorateMarkdownProcessor(
      processor,
      (source) => `safe:${source}`,
    );
    assert.equal(
      (await (await decorated.createRenderer(shared)).render("source")).code,
      "safe:source",
    );
    assert.equal(
      Object.getOwnPropertyDescriptor(decorated, "name")?.writable,
      false,
    );
    assert.equal(Object.isFrozen(decorated), true);
  });

  test("preserves custom processor and renderer receivers", async () => {
    const options = { marker: "custom" };
    const renderOptions: MarkdownRenderOptions = {
      fileURL: new URL("file:///guide.md"),
      frontmatter: { title: "Guide" },
    };
    const mdxOptions = {
      optimize: true,
      recmaPlugins: [],
    } as unknown as MdxRendererOptions;
    let underlyingRenderer: object | undefined;

    class CustomProcessor {
      readonly name = "unified";
      readonly options = options;
      #receiver = "processor";

      get receiver() {
        return this.#receiver;
      }

      async createRenderer(receivedShared: AstroMarkdownOptions) {
        assert.equal(this.#receiver, "processor");
        assert.equal(receivedShared, shared);
        const renderer = new (class {
          #receiver = "renderer";

          get receiver() {
            return this.#receiver;
          }

          async render(
            source: string,
            receivedOptions?: MarkdownRenderOptions,
          ): Promise<MarkdownRenderResult> {
            assert.equal(this.#receiver, "renderer");
            assert.equal(receivedOptions, renderOptions);
            return {
              code: source,
              metadata: {
                headings: [],
                localImagePaths: [],
                remoteImagePaths: [],
                frontmatter: receivedOptions?.frontmatter ?? {},
              },
            };
          }
        })();
        underlyingRenderer = renderer;
        return renderer;
      }

      async createMdxRenderer(
        receivedShared: AstroMarkdownOptions,
        receivedOptions: MdxRendererOptions,
      ) {
        assert.equal(this.#receiver, "processor");
        assert.equal(receivedShared, shared);
        assert.equal(receivedOptions, mdxOptions);
        return {
          async process(): Promise<MdxRenderResult> {
            return {
              code: "mdx",
              astroMetadata: {
                hydratedComponents: [],
                clientOnlyComponents: [],
                serverComponents: [],
                scripts: [],
                containsHead: false,
                propagation: "none",
                pageOptions: {},
              },
            } as unknown as MdxRenderResult;
          },
        };
      }
    }

    const processor = new CustomProcessor();
    let receivedOptions: MarkdownRenderOptions | undefined;
    const decorated = decorateMarkdownProcessor(processor, (source, value) => {
      receivedOptions = value;
      return `decorated:${source}`;
    });

    assert.equal(decorated.options, options);
    assert.equal(decorated.receiver, "processor");
    assert.equal(decorated.constructor, CustomProcessor);
    assert.equal(Object.getPrototypeOf(decorated), CustomProcessor.prototype);

    const renderer = await decorated.createRenderer(shared);
    assert.equal(renderer.receiver, "renderer");
    assert.ok(underlyingRenderer);
    assert.equal(
      Object.getPrototypeOf(renderer),
      Object.getPrototypeOf(underlyingRenderer),
    );
    assert.equal(
      (await renderer.render("source", renderOptions)).code,
      "decorated:source",
    );
    assert.equal(receivedOptions, renderOptions);

    const mdxRenderer = await decorated.createMdxRenderer(shared, mdxOptions);
    assert.equal((await mdxRenderer.process("", "", {})).code, "mdx");
  });
});
