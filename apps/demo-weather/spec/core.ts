/** Schemas shared by every area: places, measurements, conditions, errors. */

import {
  arr,
  enm,
  int,
  nullable,
  num,
  obj,
  props,
  ref,
  str,
  time,
  type Schema,
  type Version,
} from "./lib";

/** WMO weather interpretation codes (WMO 4677, condensed). */
export const CONDITIONS = [
  "clear",
  "mainly_clear",
  "partly_cloudy",
  "overcast",
  "fog",
  "rime_fog",
  "drizzle_light",
  "drizzle",
  "drizzle_dense",
  "freezing_drizzle",
  "rain_light",
  "rain",
  "rain_heavy",
  "freezing_rain",
  "snow_light",
  "snow",
  "snow_heavy",
  "snow_grains",
  "showers",
  "showers_heavy",
  "snow_showers",
  "thunderstorm",
  "thunderstorm_hail",
];

export function coreSchemas(v: Version): Record<string, Schema> {
  const schemas: Record<string, Schema> = {
    Error: obj(
      {
        error: obj(
          {
            type: enm("Error category.", [
              "invalid_request",
              "authentication",
              "permission",
              "not_found",
              "rate_limited",
              "server",
            ], "invalid_request"),
            code: str("Stable machine-readable code.", "parameter_out_of_range"),
            message: str("Human-readable explanation.", "latitude must be between -90 and 90."),
            param: str("The parameter that caused the error, when there is one.", "latitude"),
            request_id: str("Quote this when contacting support.", "req_7Kq2LmB3x9"),
          },
          ["type", "code", "message", "request_id"],
        ),
      },
      ["error"],
    ),
    Coordinates: obj(
      {
        [v === 1 ? "lat" : "latitude"]: num("Latitude in decimal degrees.", 59.9139),
        [v === 1 ? "lon" : "longitude"]: num("Longitude in decimal degrees.", 10.7522),
        ...(v === 1 ? {} : { elevation: num("Elevation above mean sea level, in metres.", 23) }),
      },
      v === 1 ? ["lat", "lon"] : ["latitude", "longitude"],
    ),
    Location: obj(
      props({
        id: str("Location id.", "loc_oslo_no"),
        name: str("Place name.", "Oslo"),
        region: str("First-level administrative region.", "Oslo"),
        country: str("ISO 3166-1 alpha-2 country code.", "NO"),
        timezone: str("IANA time zone.", "Europe/Oslo"),
        ...(v === 1
          ? { lat: num("Latitude.", 59.9139), lon: num("Longitude.", 10.7522) }
          : { coordinates: ref("Coordinates") }),
        population: v === 1 ? undefined : int("Population, when known.", 709037),
      }),
      ["id", "name", "country", "timezone"],
      "A named place weather can be requested for.",
    ),
  };

  if (v === 1) {
    schemas.Conditions = obj(
      {
        temp_f: num("Air temperature, °F.", 26.6),
        feels_like_f: num("Apparent temperature, °F.", 19.4),
        humidity: int("Relative humidity, percent.", 86),
        pressure_mb: num("Sea-level pressure, millibars.", 1012.4),
        wind_mph: num("Sustained wind speed, mph.", 9.2),
        wind_dir: str("Compass direction the wind blows from.", "NNE"),
        visibility_mi: num("Visibility, miles.", 6.2),
        condition: str("Plain-language summary.", "Light snow"),
        icon: str("Icon name.", "snow"),
      },
      ["temp_f", "condition"],
      "Weather at one moment. v1 reports imperial units only.",
    );
  } else {
    schemas.Wind = obj(
      {
        speed: num("Sustained speed in the requested units.", 4.1),
        gust: nullable(num("Gust speed, when reported.", 7.6)),
        direction: int("Direction the wind blows from, degrees true.", 20, { minimum: 0, maximum: 360 }),
      },
      ["speed", "direction"],
    );
    schemas.Condition = obj(
      {
        code: int("WMO weather interpretation code.", 71),
        label: enm("Condition label.", CONDITIONS, "snow_light"),
        text: str("Localized summary.", "Light snow"),
      },
      ["code", "label"],
    );
    schemas.Conditions = obj(
      props({
        temperature: num("Air temperature in the requested units.", -3.0),
        feels_like: num("Apparent temperature.", -7.0),
        dew_point: num("Dew point.", -5.1),
        humidity: int("Relative humidity, percent.", 86, { minimum: 0, maximum: 100 }),
        pressure: num("Sea-level pressure, hPa.", 1012.4),
        wind: ref("Wind"),
        visibility: num("Visibility, kilometres (miles in imperial).", 10),
        cloud_cover: int("Cloud cover, percent.", 90),
        uv_index: num("UV index.", 0.4),
        condition: ref("Condition"),
      }),
      ["temperature", "humidity", "wind", "condition"],
      "Weather at one moment.",
    );
  }
  return schemas;
}

export function coreResponses(): Record<string, unknown> {
  const error = (description: string) => ({
    description,
    content: { "application/json": { schema: ref("Error") } },
  });
  return {
    "400": error("The request was malformed or a parameter was out of range."),
    "401": error("The API key is missing or invalid."),
    "404": error("The resource does not exist."),
    "429": {
      ...error("Too many requests. Retry after the time in `Retry-After`."),
      headers: {
        "Retry-After": { description: "Seconds to wait before retrying.", schema: { type: "integer", example: 12 } },
        "RateLimit-Remaining": { description: "Requests left in the current window.", schema: { type: "integer", example: 0 } },
      },
    },
  };
}

export const observedAt = time("When the measurement was taken (UTC).", "2026-01-14T07:50:00Z");

export const stationRef = (v: Version) =>
  obj({
    id: str("Station id.", v === 1 ? "01492" : "stn_01492"),
    name: str("Station name.", "Oslo – Blindern"),
  });

export const percentiles = obj(
  {
    p10: num("10th percentile.", -6.2),
    p50: num("Median.", -3.1),
    p90: num("90th percentile.", 0.4),
  },
  ["p10", "p50", "p90"],
  "Spread across ensemble members.",
);

export const listOf = (schema: Schema, description: string) => arr(schema, description);
