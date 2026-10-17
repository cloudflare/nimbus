/** Stations: the public network since v1, plus private stations you run (v2). */

import {
  arr,
  bool,
  date,
  enm,
  int,
  list,
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
  type Area,
  type Version,
} from "../lib";

export function stations(v: Version): Area {
  const tag = "Stations";
  const id = path(v === 1 ? "id" : "station_id", "Station id.", v === 1 ? "01492" : "stn_01492");
  const station = obj(
    props({
      id: str("Station id.", v === 1 ? "01492" : "stn_01492"),
      wmo_id: v === 1 ? undefined : nullable(str("WMO index number, for synoptic stations.", "01492")),
      icao: nullable(str("ICAO code, for airport stations.")),
      name: str("Station name.", "Oslo – Blindern"),
      ...(v === 1
        ? { lat: num("Latitude.", 59.9423), lon: num("Longitude.", 10.72), elevation_ft: num("Elevation, feet.", 308) }
        : { coordinates: ref("Coordinates") }),
      country: str("ISO 3166-1 alpha-2 country code.", "NO"),
      network: v === 1 ? undefined : enm("Who operates the station.", ["synoptic", "airport", "climate", "private"], "synoptic"),
      owner: v === 1 ? undefined : nullable(str("Your organization id, for private stations.")),
      active: bool("Whether the station reported in the last 24 hours.", true),
      reporting_interval: v === 1 ? undefined : int("Minutes between reports.", 10),
      public: v === 1 ? undefined : bool("Whether anyone can read the station's observations. Private stations start as false.", true),
      sensors: v === 1 ? undefined : arr(ref("Sensor"), "Instruments fitted to the station."),
    }),
    ["id", "name", "country", "active"],
    "A place that reports weather measurements.",
  );
  const sensor = obj(
    {
      id: str("Sensor id.", "sen_4hT2"),
      kind: enm("What it measures.", ["temperature", "humidity", "pressure", "wind", "precipitation", "solar_radiation", "snow_depth"]),
      model: str("Manufacturer and model.", "Vaisala HMP155"),
      height_m: num("Height above ground, metres.", 2),
      installed_on: date("Installation date.", "2024-05-02"),
      last_calibrated_on: nullable(date("Most recent calibration.", "2025-11-18")),
    },
    ["id", "kind"],
  );
  const stationInput = obj(
    {
      name: str("Station name.", "Rooftop – Grünerløkka"),
      latitude: num("", 59.9236),
      longitude: num("", 10.7591),
      elevation: num("Metres above sea level.", 34),
      reporting_interval: int("Minutes between reports.", 5),
      public: bool("Publish the station's observations to everyone. Defaults to false.", false),
    },
    ["name", "latitude", "longitude"],
  );
  const reading = obj(
    {
      observed_at: time("Measurement time (UTC).", "2026-01-14T07:55:00Z"),
      temperature: num("°C.", -2.6),
      humidity: int("Percent.", 84),
      pressure: num("hPa, station level.", 1009.8),
      wind_speed: num("m/s.", 3.9),
      wind_direction: int("Degrees true.", 15),
      precipitation: num("mm since the previous reading.", 0.2),
    },
    ["observed_at"],
    "One reading from a private station, in SI units.",
  );
  const maintenance = obj(
    {
      id: str("Window id.", "mnt_92kd"),
      starts_at: time("Start.", "2026-02-02T09:00:00Z"),
      ends_at: time("End.", "2026-02-02T12:00:00Z"),
      reason: str("Why readings will be missing.", "Replacing the rain gauge."),
    },
    ["id", "starts_at", "ends_at"],
  );

  const priv = v >= 2;
  return {
    group: "Weather",
    tag: {
      name: tag,
      description: priv
        ? "The public station network, and private stations you operate and report from."
        : "The public station network.",
    },
    schemas: props({
      Station: station,
      Sensor: priv ? sensor : undefined,
      StationInput: priv ? stationInput : undefined,
      Reading: priv ? reading : undefined,
      MaintenanceWindow: priv ? maintenance : undefined,
    }),
    paths: paths([
      [
        "/stations",
        "get",
        op(tag, {
          id: "listStations",
          summary: "List stations",
          params: [
            query("country", "ISO 3166-1 alpha-2 country code.", str("", "NO")),
            ...(priv
              ? [
                  query("network", "Only stations in this network.", enm("", ["synoptic", "airport", "climate", "private"])),
                  query("bbox", "Bounding box: west,south,east,north.", str("", "10.4,59.8,11.0,60.1")),
                ]
              : []),
            query("active", "Only stations that reported in the last 24 hours.", bool("", true)),
            ...paging(v),
          ],
          responses: { "200": list(v, ref("Station"), "Stations.") },
        }),
      ],
      [
        v === 1 ? "/stations/{id}" : "/stations/{station_id}",
        "get",
        op(tag, { id: "getStation", summary: "Get a station", params: [id], responses: { "200": ref("Station") } }),
      ],
      priv && ["/stations", "post", op(tag, {
        id: "createStation",
        summary: "Register a private station",
        description: "Private stations are visible only to your organization until you set `public` to true.",
        body: ref("StationInput"),
        responses: { "201": ref("Station") },
      })],
      priv && ["/stations/{station_id}", "patch", op(tag, {
        id: "updateStation",
        summary: "Update a private station",
        params: [id],
        body: ref("StationInput"),
        responses: { "200": ref("Station") },
      })],
      priv && ["/stations/{station_id}", "delete", op(tag, {
        id: "deleteStation",
        summary: "Retire a private station",
        description: "Readings already submitted stay in the archive.",
        params: [id],
        responses: { "204": null },
      })],
      priv && ["/stations/{station_id}/readings", "post", op(tag, {
        id: "submitReadings",
        summary: "Submit readings",
        description: "Send up to 1,000 readings as JSON, or upload a logger file as multipart form data.",
        params: [id],
        body: {
          content: {
            "application/json": { schema: obj({ readings: arr(ref("Reading"), undefined, { maxItems: 1000 }) }, ["readings"]) },
            "multipart/form-data": {
              schema: obj(
                {
                  file: str("Logger export.", undefined, { format: "binary" }),
                  format: enm("File format.", ["campbell_toa5", "davis_wlk", "csv"]),
                },
                ["file", "format"],
              ),
            },
          },
        },
        responses: {
          "202": obj({
            accepted: int("Readings queued.", 288),
            rejected: arr(obj({ index: int("Position in the request.", 17), reason: str("", "observed_at is in the future") })),
          }),
        },
      })],
      priv && ["/stations/{station_id}/readings", "get", op(tag, {
        id: "listReadings",
        summary: "List submitted readings",
        params: [id, query("start", "Earliest reading.", time("", "2026-01-13T00:00:00Z")), ...paging(v)],
        responses: { "200": list(v, ref("Reading"), "Readings, newest first.") },
      })],
      priv && ["/stations/{station_id}/sensors", "get", op(tag, {
        id: "listSensors",
        summary: "List sensors",
        params: [id],
        responses: { "200": arr(ref("Sensor")) },
      })],
      priv && ["/stations/{station_id}/sensors", "post", op(tag, {
        id: "addSensor",
        summary: "Add a sensor",
        params: [id],
        body: obj({ kind: str("", "wind"), model: str("", "Gill WindSonic"), height_m: num("", 10) }, ["kind"]),
        responses: { "201": ref("Sensor") },
      })],
      priv && ["/stations/{station_id}/sensors/{sensor_id}/calibrations", "post", op(tag, {
        id: "recordCalibration",
        summary: "Record a calibration",
        description: "Readings after this date are corrected with the new offset.",
        params: [id, path("sensor_id", "Sensor id.", "sen_4hT2")],
        body: obj({ calibrated_on: date("", "2026-01-10"), offset: num("Correction added to raw values.", -0.15), certificate_url: str("", "https://example.com/cert/4471.pdf") }, ["calibrated_on", "offset"]),
        responses: { "201": ref("Sensor") },
      })],
      priv && ["/stations/{station_id}/maintenance", "get", op(tag, {
        id: "listMaintenanceWindows",
        summary: "List maintenance windows",
        params: [id],
        responses: { "200": arr(ref("MaintenanceWindow")) },
      })],
      priv && ["/stations/{station_id}/maintenance", "post", op(tag, {
        id: "scheduleMaintenance",
        summary: "Schedule maintenance",
        description: "Missing readings inside a window aren't flagged as an outage.",
        params: [id],
        body: obj({ starts_at: time("", "2026-02-02T09:00:00Z"), ends_at: time("", "2026-02-02T12:00:00Z"), reason: str("", "Replacing the rain gauge.") }, ["starts_at", "ends_at"]),
        responses: { "201": ref("MaintenanceWindow") },
      })],
      priv && ["/stations/{station_id}/health", "get", op(tag, {
        id: "getStationHealth",
        summary: "Get station health",
        description: "Reporting completeness and quality-control flags over the last 7 days.",
        params: [id],
        responses: {
          "200": obj({
            completeness: num("Share of expected reports received, 0–1.", 0.982),
            last_report_at: time("", "2026-01-14T07:55:00Z"),
            suspect_readings: int("Readings flagged by quality control.", 3),
            issues: arr(enm("", ["stale", "frozen_sensor", "out_of_range", "clock_drift"], "clock_drift")),
          }),
        },
      })],
    ]),
  };
}
