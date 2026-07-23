/**
 * MDX globals registry.
 *
 * Anything in this map is available inside MDX files without an `import`
 * statement. Pass `components` to Astro's `<Content components={components} />`
 * at render time — wired in `pages/[...slug].astro`.
 *
 * Add new components here as you build them. Components installed via
 * `nimbus-docs add <name>` will give you instructions to register them.
 */

import { Aside } from "./components/ui/aside";
import Render from "./components/Render.astro";
import { Card } from "./components/ui/card";
import { CardGrid } from "./components/ui/card-grid";
import { LinkCard } from "./components/ui/link-card";
import { PackageManagers } from "./components/ui/package-managers";
import { Step, Steps } from "./components/ui/steps";
import { Tabs, TabItem } from "./components/ui/tabs";

export const components = {
  Aside,
  Card,
  CardGrid,
  LinkCard,
  PackageManagers,
  Render,
  Step,
  Steps,
  TabItem,
  Tabs,
};
