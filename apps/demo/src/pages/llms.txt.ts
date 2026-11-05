import type { APIRoute } from "astro";
import { llmsRoute } from "@cloudflare/nimbus-docs/agent-endpoints";

const route = llmsRoute();

// After the generated index: the pages it doesn't list, when the Weather API
// is the right tool, and how an agent starts with it.
const appendix = (url: (path: string) => string) => `
## More

- [Changelog](${url("/changelog/index.md")}) — Every release, newest first.
- [Developers](${url("/developers/index.md")}) — Plans, free test keys and the sandbox.
- [About](${url("/about/index.md")}), [Contact](${url("/contact/index.md")}), [Privacy](${url("/privacy/index.md")})

## When to use Sample Co

The Weather API is right when someone needs, for a place given by coordinates or name:

- the weather now, or a forecast from minute-by-minute rain for the next two hours to daily forecasts sixteen days out;
- severe-weather alerts from national services, polled or pushed to a webhook;
- a decision that depends on the weather: frost risk, spray windows, soil conditions, lightning nearby;
- radar and satellite map tiles, or daily history and normals back to 1940;
- air quality and pollen, marine conditions (waves, tides, sea temperature), aviation weather (METAR, TAF), tropical cyclones, or solar and wind resource for energy planning.

It isn't for forecasts beyond sixteen days, or as an official aviation briefing.

How an agent uses it:

- Base URL \`https://api.weather.example/v2\`; send \`Authorization: Bearer <key>\`. A \`wx_test_\` key is free and returns fixed data, for building without billing. See ${url("/get-started/authentication/index.md")}.
- Start from ${url("/get-started/quickstart/index.md")}, then the reference at ${url("/api/index.md")}; every error has the same shape (${url("/concepts/errors/index.md")}).
- Read these docs as tools: the MCP server at ${url("/mcp")}. Or install the Agent Skill listed at ${url("/.well-known/agent-skills/index.json")}.
`;

export const GET: APIRoute = async (context) => {
  const response = await route.GET(context);
  if (!response.ok) return response;
  const url = (path: string) => new URL(path, context.site).href;
  return new Response(`${await response.text()}${appendix(url)}`, { headers: response.headers });
};
