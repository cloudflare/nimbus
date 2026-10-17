/** Imagery tiles and the historical archive, including async bulk exports. */

import {
  arr,
  date,
  enm,
  int,
  lat,
  list,
  lon,
  nullable,
  num,
  obj,
  op,
  paging,
  path,
  paths,
  props,
  query,
  ref,
  str,
  time,
  units,
  type Area,
  type Param,
  type Version,
} from "../lib";

const LAYERS = ["radar", "satellite_ir", "satellite_visible", "precipitation_forecast", "temperature", "wind", "clouds"];

const binary = (mediaType: string, description: string) => ({
  description,
  content: { [mediaType]: { schema: { type: "string", format: "binary" } } },
});

export function imagery(v: Version): Area {
  const tag = "Imagery";
  const tile: Param[] = [
    path("z", "Zoom level, 0–12.", "6"),
    path("x", "Tile column.", "33"),
    path("y", "Tile row.", "17"),
  ];
  const layers = v === 1 ? ["radar"] : LAYERS;
  return {
    group: "Maps",
    tag: { name: tag, description: "Radar, satellite, and forecast map tiles in Web Mercator." },
    schemas: {
      Layer: obj(
        props({
          id: enm("Layer id.", layers, "radar"),
          name: str("Display name.", "Precipitation radar"),
          min_zoom: int("", 0),
          max_zoom: int("", v === 1 ? 10 : 12),
          update_interval: int("Minutes between new frames.", 5),
          legend_url: v === 1 ? undefined : str("Color scale image.", "https://tiles.weather.example/legends/radar.png"),
        }),
        ["id", "name"],
      ),
    },
    paths: paths([
      [v === 1 ? "/radar/{z}/{x}/{y}.png" : "/tiles/{layer}/{z}/{x}/{y}.png", "get", op(tag, {
        id: v === 1 ? "getRadarTile" : "getTile",
        summary: v === 1 ? "Get a radar tile" : "Get a map tile",
        description: "A 256×256 PNG. Transparent where there is nothing to draw.",
        params: [
          ...(v === 1 ? [] : [path("layer", "Layer id.", "radar")]),
          ...tile,
          query("time", "Frame time. Defaults to the latest.", time("", "2026-01-14T07:50:00Z")),
        ],
        responses: { "200": binary("image/png", "The tile.") },
      })],
      v >= 2 && ["/tiles/{layer}/{z}/{x}/{y}@2x.png", "get", op(tag, {
        id: "getRetinaTile",
        summary: "Get a high-density map tile",
        description: "A 512×512 PNG for high-density displays.",
        params: [path("layer", "Layer id.", "radar"), ...tile],
        responses: { "200": binary("image/png", "The tile.") },
      })],
      ["/layers", "get", op(tag, {
        id: "listLayers",
        summary: "List layers",
        responses: { "200": arr(ref("Layer")) },
      })],
      v >= 2 && ["/layers/{layer}/frames", "get", op(tag, {
        id: "listFrames",
        summary: "List available frames",
        description: "Past frames for the last two hours, and forecast frames for layers that have them.",
        params: [path("layer", "Layer id.", "radar")],
        responses: {
          "200": obj({
            past: arr(time("", "2026-01-14T07:50:00Z")),
            forecast: arr(time("", "2026-01-14T08:10:00Z")),
          }),
        },
      })],
      v >= 2 && ["/maps/static", "get", op(tag, {
        id: "renderStaticMap",
        summary: "Render a static map",
        description: "One image of a layer over a basemap, for emails and reports.",
        params: [
          query("layer", "Layer id.", enm("", LAYERS, "radar"), true),
          query("center", "latitude,longitude.", str("", "59.91,10.75"), true),
          query("zoom", "Zoom level.", int("", 7)),
          query("size", "widthxheight in pixels, up to 1280x1280.", str("", "800x600")),
          query("format", "Image format.", enm("", ["png", "jpeg", "webp"])),
        ],
        responses: {
          "200": {
            description: "The image.",
            content: {
              "image/png": { schema: { type: "string", format: "binary" } },
              "image/jpeg": { schema: { type: "string", format: "binary" } },
              "image/webp": { schema: { type: "string", format: "binary" } },
            },
          },
        },
      })],
      v >= 2 && ["/maps/animation", "get", op(tag, {
        id: "renderAnimation",
        summary: "Render a radar loop",
        description: "An animated GIF of the last hour of frames.",
        params: [
          query("center", "latitude,longitude.", str("", "59.91,10.75"), true),
          query("zoom", "Zoom level.", int("", 7)),
        ],
        responses: { "200": binary("image/gif", "The animation.") },
      })],
    ]),
  };
}

export function history(v: Version): Area {
  const tag = "History";
  const where = [lat(v), lon(v), ...units(v)];
  const range = [
    query(v === 1 ? "from" : "start_date", "First day.", date("", "2025-01-01"), true),
    query(v === 1 ? "to" : "end_date", "Last day.", date("", "2025-01-31"), true),
  ];
  const exportJob = obj(
    {
      id: str("Export id.", "exp_5mQ1"),
      status: enm("Progress.", ["queued", "running", "succeeded", "failed", "cancelled"], "running"),
      progress: num("0–1.", 0.42),
      rows: nullable(int("Rows written so far.", 1_204_330)),
      download_url: nullable(str("Signed URL, valid for 24 hours once `succeeded`.", "https://exports.weather.example/exp_5mQ1.csv.gz?sig=…")),
      error: nullable(str("Why it failed.")),
      created_at: time("", "2026-01-14T08:01:00Z"),
      expires_at: nullable(time("When the file is deleted.", "2026-01-15T08:20:00Z")),
    },
    ["id", "status", "created_at"],
    "An asynchronous bulk export.",
  );
  return {
    group: "Climate",
    tag: { name: tag, description: "Hourly and daily records back to 1940, from reanalysis and station archives." },
    schemas: props({ Export: v >= 2 ? exportJob : undefined }),
    paths: paths([
      [v === 1 ? "/history" : "/history/daily", "get", op(tag, {
        id: v === 1 ? "getHistory" : "getDailyHistory",
        summary: v === 1 ? "Get historical weather" : "Get daily history",
        description: v === 1 ? "Daily records, up to one year per request." : "Daily aggregates, up to ten years per request.",
        params: [...where, ...range],
        responses: { "200": obj({ location: ref("Location"), days: arr(ref("DailyForecast")) }) },
      })],
      v >= 2 && ["/history/hourly", "get", op(tag, {
        id: "getHourlyHistory",
        summary: "Get hourly history",
        description: "Hourly values, up to 31 days per request. Use an export for longer ranges.",
        params: [...where, ...range],
        responses: { "200": obj({ location: ref("Location"), hours: arr(ref("HourlyForecast")) }) },
      })],
      v >= 2 && ["/climate/normals", "get", op(tag, {
        id: "getClimateNormals",
        summary: "Get climate normals",
        description: "30-year averages (1991–2020) for each month.",
        params: where,
        responses: {
          "200": obj({
            period: str("", "1991-2020"),
            months: arr(obj({
              month: int("1–12.", 1),
              temperature_mean: num("", -2.3),
              precipitation_total: num("", 63),
              sunshine_hours: num("", 41),
            })),
          }),
        },
      })],
      v >= 2 && ["/climate/records", "get", op(tag, {
        id: "getClimateRecords",
        summary: "Get records",
        description: "Highest and lowest values on record at the nearest climate station.",
        params: where,
        responses: {
          "200": arr(obj({
            variable: enm("", ["temperature_max", "temperature_min", "precipitation_day", "snow_depth"]),
            value: num("", 35.0),
            date: date("", "1901-07-21"),
            station: str("", "stn_01492"),
          })),
        },
      })],
      v >= 2 && ["/climate/degree-days", "get", op(tag, {
        id: "getDegreeDays",
        summary: "Get degree days",
        description: "Heating and cooling degree days, for energy demand modelling.",
        params: [...where, ...range, query("base", "Base temperature.", num("", 17))],
        responses: { "200": arr(obj({ date: date("", "2025-01-01"), heating: num("", 19.4), cooling: num("", 0) })) },
      })],
      v >= 2 && ["/exports", "post", op(tag, {
        id: "createExport",
        summary: "Start a bulk export",
        description: "Exports run in the background. Poll the export, or pass `notify_url` to get a POST when it finishes.",
        body: obj(
          {
            kind: enm("What to export.", ["hourly", "daily", "observations"]),
            points: arr(obj({ latitude: num("", 59.9139), longitude: num("", 10.7522) })),
            stations: arr(str("", "stn_01492")),
            start_date: date("", "2015-01-01"),
            end_date: date("", "2024-12-31"),
            variables: arr(str("", "temperature")),
            format: enm("File format.", ["csv", "parquet", "netcdf"]),
            notify_url: str("", "https://example.com/hooks/export-done"),
          },
          ["kind", "start_date", "end_date"],
        ),
        responses: { "202": ref("Export") },
      })],
      v >= 2 && ["/exports", "get", op(tag, {
        id: "listExports",
        summary: "List exports",
        params: paging(v),
        responses: { "200": list(v, ref("Export"), "Exports, newest first.") },
      })],
      v >= 2 && ["/exports/{export_id}", "get", op(tag, {
        id: "getExport",
        summary: "Get an export",
        params: [path("export_id", "Export id.", "exp_5mQ1")],
        responses: { "200": ref("Export") },
      })],
      v >= 2 && ["/exports/{export_id}/download", "get", op(tag, {
        id: "downloadExport",
        summary: "Download an export",
        description: "Redirects to the signed file URL. Fails with 409 until the export has succeeded.",
        params: [path("export_id", "Export id.", "exp_5mQ1")],
        responses: {
          "303": { description: "See the `Location` header.", content: { "text/csv": { schema: str("", "time,latitude,longitude,temperature\n2015-01-01T00:00:00Z,59.9139,10.7522,-4.2") } } },
        },
      })],
      v >= 2 && ["/exports/{export_id}", "delete", op(tag, {
        id: "cancelExport",
        summary: "Cancel an export",
        params: [path("export_id", "Export id.", "exp_5mQ1")],
        responses: { "200": ref("Export") },
      })],
    ]),
  };
}
