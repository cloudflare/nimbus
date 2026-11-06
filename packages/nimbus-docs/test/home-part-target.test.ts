import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { homePartTarget } from "../src/client/home-parts.ts";

const { window } = new JSDOM(
  `<a id="hash" href="#tags.Pets">a</a>
   <a id="part" href="/api/index/2/#tags.Health">b</a>
   <a id="other-version" href="/api/index/2/?version=v1#tags.Health">c</a>
   <a id="other-origin" href="https://elsewhere.example/api/index/2/#tags.Health">d</a>
   <a id="other-page" href="/api/pets/#x">e</a>
   <a id="blank" href="/api/index/2/#tags.Health" target="_blank">f</a>
   <a id="self" href="/api/index/2/#tags.Health" target="_self">g</a>
   <a id="download" href="#tags.Pets" download>h</a>
   <a id="malformed" href="#tags.%E0%A4%A">i</a>`,
  { url: "https://docs.example/api/" },
);
Object.assign(globalThis, { location: window.location });
const parts = ["/api/index/2/", "/api/index/3/"];
const click = (id: string, init: MouseEventInit = {}) => {
  const event = new window.MouseEvent("click", { button: 0, bubbles: true, cancelable: true, ...init });
  Object.defineProperty(event, "target", { value: window.document.getElementById(id) });
  return homePartTarget(event as unknown as MouseEvent, parts);
};

test("a hash link and a later part's link give the heading", () => {
  assert.equal(click("hash"), "tags.Pets");
  assert.equal(click("part"), "tags.Health");
});

test("a hash link the client router already cancelled still gives the heading", () => {
  const event = new window.MouseEvent("click", { button: 0, bubbles: true, cancelable: true });
  event.preventDefault();
  Object.defineProperty(event, "target", { value: window.document.getElementById("hash") });
  assert.equal(event.defaultPrevented, true);
  assert.equal(homePartTarget(event as unknown as MouseEvent, parts), "tags.Pets");
});

test("modified and non-primary clicks are left to the browser", () => {
  for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    assert.equal(click("part", init), null, JSON.stringify(init));
  }
});

test("another version's part, another origin and another page aren't intercepted", () => {
  assert.equal(click("other-version"), null);
  assert.equal(click("other-origin"), null);
  assert.equal(click("other-page"), null);
});

test("a link that opens elsewhere or downloads is left to the browser", () => {
  assert.equal(click("blank"), null);
  assert.equal(click("download"), null);
  assert.equal(click("self"), "tags.Health");
});

test("a malformed fragment is left to the browser instead of throwing", () => {
  assert.equal(click("malformed"), null);
});
