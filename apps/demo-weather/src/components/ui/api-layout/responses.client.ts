/** Opens a closed error response when the URL links to it. Field links inside
 *  one already open it through their own field group. */

import { mount, initDisclosureGroup } from "@cloudflare/nimbus-docs/client";

mount("[data-api-responses]", (root) => {
  const instance = initDisclosureGroup({ root, deepLink: true });
  return () => instance.destroy();
});
