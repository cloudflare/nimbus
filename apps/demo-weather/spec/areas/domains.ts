/** Specialist products added in v2: air quality, marine, aviation, agriculture, energy, tropical, lightning. */

import {
  arr,
  bool,
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
  query,
  ref,
  str,
  time,
  units,
  type Area,
  type Param,
  type Schema,
  type Version,
} from "../lib";

/** A GET that takes a point and returns `schema`. */
function pointOp(v: Version, tag: string, id: string, summary: string, description: string, schema: Schema, extra: Param[] = []) {
  return op(tag, { id, summary, description, params: [lat(v), lon(v), ...units(v), ...extra], responses: { "200": schema } });
}

const hourly = (fields: Record<string, Schema>) =>
  arr(obj({ time: time("", "2026-01-14T08:00:00Z"), ...fields }));

export function airQuality(v: Version): Area {
  const tag = "Air quality";
  const pollutants = ["pm2_5", "pm10", "o3", "no2", "so2", "co"];
  const reading = obj(
    {
      aqi: int("Air Quality Index, 0–500 (US EPA scale).", 38),
      category: enm("", ["good", "moderate", "unhealthy_sensitive", "unhealthy", "very_unhealthy", "hazardous"], "good"),
      dominant_pollutant: enm("", pollutants, "pm2_5"),
      concentrations: obj(Object.fromEntries(pollutants.map((p) => [p, num("µg/m³.", 9.1)]))),
    },
    ["aqi", "category"],
  );
  return {
    group: "Environment",
    tag: { name: tag, description: "Pollutant concentrations, AQI, and pollen." },
    schemas: { AirQuality: reading },
    paths: paths([
      ["/air-quality/current", "get", pointOp(v, tag, "getCurrentAirQuality", "Get current air quality", "Modelled concentrations, corrected with nearby monitor readings.", ref("AirQuality"))],
      ["/air-quality/forecast", "get", pointOp(v, tag, "getAirQualityForecast", "Get an air quality forecast", "Hourly AQI for the next five days.", hourly({ aqi: int("", 41), category: str("", "good") }))],
      ["/air-quality/pollen", "get", pointOp(v, tag, "getPollen", "Get pollen levels", "Daily pollen index by plant type, for the next three days.", arr(obj({
        date: date("", "2026-05-02"),
        tree: int("0–5.", 4),
        grass: int("0–5.", 1),
        weed: int("0–5.", 0),
        species: arr(obj({ name: str("", "Birch"), level: int("", 4) })),
      })))],
      ["/air-quality/monitors", "get", op(tag, {
        id: "listAirMonitors",
        summary: "List monitoring stations",
        params: [query("bbox", "west,south,east,north.", str("", "10.4,59.8,11.0,60.1"), true), ...paging(v)],
        responses: { "200": list(v, obj({ id: str("", "aqm_no_0041"), name: str("", "Kirkeveien"), operator: str("", "Norwegian Institute for Air Research") }), "Monitors.") },
      })],
    ]),
  };
}

export function marine(v: Version): Area {
  const tag = "Marine";
  return {
    group: "Environment",
    tag: { name: tag, description: "Waves, tides, and sea temperature." },
    paths: paths([
      ["/marine/forecast", "get", pointOp(v, tag, "getMarineForecast", "Get a marine forecast", "Hourly wave and swell for open water.", hourly({
        wave_height: num("Significant wave height, m.", 1.8),
        wave_period: num("Seconds.", 7.2),
        wave_direction: int("Degrees true.", 220),
        swell_height: num("", 1.1),
        sea_surface_temperature: num("", 4.6),
      }))],
      ["/marine/tides", "get", op(tag, {
        id: "getTidePredictions",
        summary: "Get tide predictions",
        description: "High and low water at a tide station.",
        params: [query("station", "Tide station id.", str("", "tide_no_osl"), true), query("days", "Days ahead.", int("", 3, { maximum: 30 }))],
        responses: { "200": arr(obj({ time: time("", "2026-01-14T10:42:00Z"), type: enm("", ["high", "low"]), height_m: num("Above chart datum.", 0.41) })) },
      })],
      ["/marine/tide-stations", "get", op(tag, {
        id: "listTideStations",
        summary: "List tide stations",
        params: [query("country", "ISO 3166-1 alpha-2 country code.", str("", "NO")), ...paging(v)],
        responses: { "200": list(v, obj({ id: str("", "tide_no_osl"), name: str("", "Oslo"), coordinates: ref("Coordinates") }), "Tide stations.") },
      })],
      ["/marine/buoys/{buoy_id}/observations", "get", op(tag, {
        id: "listBuoyObservations",
        summary: "List buoy observations",
        params: [path("buoy_id", "Buoy id.", "buoy_lf3j"), ...paging(v)],
        responses: { "200": list(v, obj({ observed_at: time("", "2026-01-14T07:00:00Z"), wave_height: num("", 2.1), water_temperature: num("", 5.2) }), "Observations.") },
      })],
    ]),
  };
}

export function aviation(v: Version): Area {
  const tag = "Aviation";
  const icao = path("icao", "ICAO airport code.", "ENGM");
  return {
    group: "Environment",
    tag: { name: tag, description: "METAR, TAF, and hazards for flight planning. Not a substitute for an official briefing." },
    paths: paths([
      ["/aviation/airports/{icao}/metar", "get", op(tag, {
        id: "getDecodedMetar",
        summary: "Get a decoded METAR",
        params: [icao],
        responses: { "200": obj({
          raw: str("", "ENGM 140750Z 02008KT 6000 -SN BKN012 M03/M05 Q1012"),
          observed_at: time("", "2026-01-14T07:50:00Z"),
          flight_category: enm("", ["VFR", "MVFR", "IFR", "LIFR"], "MVFR"),
          ceiling_ft: nullable(int("", 1200)),
          visibility_m: int("", 6000),
          wind: ref("Wind"),
        }) },
      })],
      ["/aviation/airports/{icao}/taf", "get", op(tag, {
        id: "getTaf",
        summary: "Get a TAF",
        params: [icao],
        responses: { "200": obj({
          raw: str("", "TAF ENGM 140500Z 1406/1512 02010KT 9999 BKN015 TEMPO 1406/1412 4000 -SN BKN008"),
          issued_at: time("", "2026-01-14T05:00:00Z"),
          periods: arr(obj({ from: time("", "2026-01-14T06:00:00Z"), to: time("", "2026-01-14T12:00:00Z"), change: enm("", ["base", "tempo", "becmg", "prob30", "prob40"], "tempo"), flight_category: str("", "IFR") })),
        }) },
      })],
      ["/aviation/sigmets", "get", op(tag, {
        id: "listSigmets",
        summary: "List SIGMETs",
        description: "Significant weather advisories for en-route hazards.",
        params: [query("fir", "Flight information region.", str("", "ENOR")), query("hazard", "Hazard.", enm("", ["turbulence", "icing", "convection", "volcanic_ash", "mountain_wave"]))],
        responses: { "200": arr(obj({ id: str("", "sig_ENOR_A3"), hazard: str("", "icing"), valid_from: time("", "2026-01-14T06:00:00Z"), valid_to: time("", "2026-01-14T10:00:00Z"), base_ft: int("", 4000), top_ft: int("", 12000) })) },
      })],
      ["/aviation/pireps", "get", op(tag, {
        id: "listPireps",
        summary: "List pilot reports",
        params: [query("near", "ICAO airport code.", str("", "ENGM"), true), query("hours", "How far back.", int("", 2, { maximum: 12 }))],
        responses: { "200": arr(obj({ reported_at: time("", "2026-01-14T07:31:00Z"), aircraft: str("", "B738"), altitude_ft: int("", 9000), turbulence: nullable(str("", "light")), icing: nullable(str("", "moderate rime")) })) },
      })],
    ]),
  };
}

export function agriculture(v: Version): Area {
  const tag = "Agriculture";
  return {
    group: "Industries",
    tag: { name: tag, description: "Soil, frost, and crop-growth indicators." },
    paths: paths([
      ["/agriculture/soil", "get", pointOp(v, tag, "getSoilConditions", "Get soil conditions", "Modelled soil temperature and moisture at four depths.", obj({
        layers: arr(obj({ depth_cm: str("", "0-7"), temperature: num("", 1.2), moisture: num("m³/m³.", 0.31) })),
      }))],
      ["/agriculture/growing-degree-days", "get", pointOp(v, tag, "getGrowingDegreeDays", "Get growing degree days", "Accumulated heat units since `start_date`.", obj({
        total: num("", 812.5),
        days: arr(obj({ date: date("", "2025-06-01"), value: num("", 9.4) })),
      }), [query("start_date", "Planting date.", date("", "2025-05-01"), true), query("base", "Base temperature.", num("", 10)), query("cap", "Upper cutoff.", num("", 30))])],
      ["/agriculture/frost-risk", "get", pointOp(v, tag, "getFrostRisk", "Get frost risk", "Nightly chance of ground frost for the next 10 nights.", arr(obj({
        night_of: date("", "2026-05-03"),
        probability: num("0–1.", 0.35),
        min_ground_temperature: num("", -0.8),
      })))],
      ["/agriculture/evapotranspiration", "get", pointOp(v, tag, "getEvapotranspiration", "Get evapotranspiration", "Daily FAO-56 reference evapotranspiration, for irrigation planning.", arr(obj({
        date: date("", "2025-07-14"),
        et0: num("mm.", 4.1),
      })))],
      ["/agriculture/spray-windows", "get", pointOp(v, tag, "getSprayWindows", "Get spray windows", "Hours when wind, rain, and temperature suit crop spraying.", arr(obj({
        start: time("", "2025-07-15T04:00:00Z"),
        end: time("", "2025-07-15T08:00:00Z"),
        rating: enm("", ["good", "marginal"]),
        limiting_factor: nullable(enm("", ["wind", "rain", "temperature", "inversion"], "wind")),
      })))],
    ]),
  };
}

export function energy(v: Version): Area {
  const tag = "Energy";
  return {
    group: "Industries",
    tag: { name: tag, description: "Solar and wind resource forecasts for generation planning." },
    paths: paths([
      ["/energy/solar", "get", pointOp(v, tag, "getSolarForecast", "Get a solar forecast", "Irradiance on a horizontal surface and on your panel's tilt.", hourly({
        ghi: num("Global horizontal irradiance, W/m².", 412),
        dni: num("Direct normal irradiance, W/m².", 610),
        dhi: num("Diffuse horizontal irradiance, W/m².", 98),
        poa: nullable(num("Plane-of-array irradiance, when `tilt` is given.", 538)),
      }), [query("tilt", "Panel tilt, degrees.", num("", 35)), query("azimuth", "Panel azimuth, degrees from north.", num("", 180))])],
      ["/energy/wind", "get", pointOp(v, tag, "getWindPowerForecast", "Get a wind resource forecast", "Wind speed at hub height, with air density for power-curve conversion.", hourly({
        speed: num("m/s at hub height.", 9.6),
        direction: int("", 245),
        air_density: num("kg/m³.", 1.262),
      }), [query("hub_height", "Metres above ground.", num("", 100), true)])],
      ["/energy/demand-drivers", "get", pointOp(v, tag, "getDemandDrivers", "Get demand drivers", "Population-weighted temperature and degree days for a grid region.", hourly({
        temperature: num("", -4.1),
        heating_degree_hours: num("", 0.88),
      }), [query("region", "Grid region.", str("", "NO1"))])],
    ]),
  };
}

export function tropical(v: Version): Area {
  const tag = "Tropical";
  const storm = path("storm_id", "Storm id.", "al052025");
  return {
    group: "Environment",
    tag: { name: tag, description: "Active tropical cyclones, tracks, and forecast cones." },
    schemas: {
      Storm: obj(
        {
          id: str("Basin, number, and year.", "al052025"),
          name: str("", "Erin"),
          basin: enm("", ["atlantic", "east_pacific", "west_pacific", "north_indian", "south_indian", "south_pacific"]),
          classification: enm("", ["depression", "tropical_storm", "hurricane", "major_hurricane", "post_tropical"], "hurricane"),
          category: nullable(int("Saffir–Simpson category.", 3)),
          max_wind: num("Knots.", 105),
          min_pressure: num("hPa.", 958),
          position: ref("Coordinates"),
          movement: obj({ direction: int("", 300), speed: num("Knots.", 12) }),
          advisory_at: time("", "2025-08-19T15:00:00Z"),
        },
        ["id", "name", "basin", "classification", "position"],
      ),
    },
    paths: paths([
      ["/tropical/storms", "get", op(tag, {
        id: "listActiveStorms",
        summary: "List active storms",
        params: [query("basin", "Ocean basin.", str("", "atlantic"))],
        responses: { "200": arr(ref("Storm")) },
      })],
      ["/tropical/storms/{storm_id}", "get", op(tag, { id: "getStorm", summary: "Get a storm", params: [storm], responses: { "200": ref("Storm") } })],
      ["/tropical/storms/{storm_id}/track", "get", op(tag, {
        id: "getStormTrack",
        summary: "Get a storm's track",
        description: "Every past position, plus the official forecast track.",
        params: [storm],
        responses: { "200": obj({
          past: arr(obj({ time: time("", "2025-08-18T12:00:00Z"), position: ref("Coordinates"), max_wind: num("", 95) })),
          forecast: arr(obj({ time: time("", "2025-08-20T12:00:00Z"), position: ref("Coordinates"), max_wind: num("", 110) })),
        }) },
      })],
      ["/tropical/storms/{storm_id}/cone", "get", op(tag, {
        id: "getForecastCone",
        summary: "Get the forecast cone",
        description: "The cone of uncertainty as GeoJSON.",
        params: [storm],
        responses: { "200": { description: "A GeoJSON Feature.", content: { "application/geo+json": { schema: obj({ type: str("", "Feature"), geometry: obj({}) }) } } } },
      })],
      ["/tropical/seasons/{year}", "get", op(tag, {
        id: "getSeasonSummary",
        summary: "Get a season summary",
        params: [path("year", "Season year.", "2025"), query("basin", "Ocean basin.", str("", "atlantic"), true)],
        responses: { "200": obj({ named_storms: int("", 14), hurricanes: int("", 6), major_hurricanes: int("", 3), ace: num("Accumulated cyclone energy.", 132.4) }) },
      })],
    ]),
  };
}

export function lightning(v: Version): Area {
  const tag = "Lightning";
  return {
    group: "Environment",
    tag: { name: tag, description: "Strikes detected by the lightning network." },
    paths: paths([
      ["/lightning/strikes", "get", op(tag, {
        id: "listStrikes",
        summary: "List recent strikes",
        description: "Strikes inside a bounding box in the last 60 minutes.",
        params: [query("bbox", "west,south,east,north.", str("", "4.5,57.9,12.5,62.0"), true), query("since", "Only strikes after this time.", time("", "2026-07-02T14:00:00Z")), ...paging(v)],
        responses: { "200": list(v, obj({
          time: time("", "2026-07-02T14:03:17.402Z"),
          position: ref("Coordinates"),
          type: enm("", ["cloud_to_ground", "intra_cloud"]),
          peak_current_ka: num("", -18.4),
        }), "Strikes, newest first.") },
      })],
      ["/lightning/proximity", "get", pointOp(v, tag, "getLightningProximity", "Check for nearby lightning", "Whether lightning has struck within `radius` km, for outdoor-safety decisions.", obj({
        strikes: int("", 4),
        nearest_km: nullable(num("", 6.2)),
        last_strike_at: nullable(time("", "2026-07-02T14:03:17Z")),
        all_clear_at: nullable(time("30 minutes after the last strike in range.", "2026-07-02T14:33:17Z")),
        safe: bool("", false),
      }), [query("radius", "Kilometres.", num("", 16))])],
      ["/lightning/density", "get", op(tag, {
        id: "getStrikeDensity",
        summary: "Get strike density",
        description: "Strikes per square kilometre per year, from 10 years of data.",
        params: [lat(v), lon(v)],
        responses: { "200": obj({ flashes_per_km2_year: num("", 0.6), years: str("", "2015-2024") }) },
      })],
    ]),
  };
}
