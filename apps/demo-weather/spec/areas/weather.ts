/** Locations, forecasts, and observations: the core of the API since v1. */

import { CONDITIONS, observedAt, percentiles, stationRef } from "../core";
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
  props,
  query,
  ref,
  str,
  time,
  units,
  type Area,
  type Version,
} from "../lib";

export function locations(v: Version): Area {
  const tag = "Locations";
  return {
    group: "Weather",
    tag: { name: tag, description: "Find places by name or coordinates." },
    paths: paths([
      [
        "/locations/search",
        "get",
        op(tag, {
          id: "searchLocations",
          summary: "Search locations",
          description: "Find places whose name starts with the query, ranked by population.",
          params: [
            query("q", "Place name, or the start of one.", str("", "Osl"), true),
            query("country", "Limit to one ISO 3166-1 alpha-2 country.", str("", "NO")),
            ...paging(v),
          ],
          responses: { "200": list(v, ref("Location"), "Matching locations.") },
        }),
      ],
      [
        "/locations/reverse",
        "get",
        op(tag, {
          id: "reverseGeocode",
          summary: "Find the nearest location",
          description: "Return the closest named place to a coordinate.",
          params: [lat(v), lon(v)],
          responses: { "200": ref("Location") },
        }),
      ],
      [
        "/locations/{location_id}",
        "get",
        op(tag, {
          id: "getLocation",
          summary: "Get a location",
          params: [path("location_id", "Location id.", "loc_oslo_no")],
          responses: { "200": ref("Location") },
        }),
      ],
      v >= 2 && [
        "/locations/{location_id}/nearby-stations",
        "get",
        op(tag, {
          id: "listNearbyStations",
          summary: "List stations near a location",
          description: "Stations within `radius` kilometres, nearest first.",
          params: [
            path("location_id", "Location id.", "loc_oslo_no"),
            query("radius", "Search radius in kilometres.", num("", 25, { maximum: 200, default: 25 })),
            ...paging(v),
          ],
          responses: {
            "200": list(
              v,
              obj({ station: ref("Station"), distance_km: num("Distance from the location.", 3.4) }),
              "Stations, nearest first.",
            ),
          },
        }),
      ],
      v >= 2 && [
        "/timezones/{timezone}",
        "get",
        op(tag, {
          id: "getTimezone",
          summary: "Get a time zone",
          description: "Current offset and the next daylight-saving transition.",
          params: [path("timezone", "IANA time zone, URL-encoded.", "Europe%2FOslo")],
          responses: {
            "200": obj({
              id: str("IANA id.", "Europe/Oslo"),
              utc_offset: str("Current offset.", "+01:00"),
              is_dst: bool("Whether daylight saving time is in effect.", false),
              next_transition: time("Next offset change.", "2026-03-29T01:00:00Z"),
            }),
          },
        }),
      ],
    ]),
  };
}

export function forecasts(v: Version): Area {
  const tag = "Forecasts";
  const where = [lat(v), lon(v), ...units(v)];
  const hour =
    v === 1
      ? obj(
          {
            time: time("Start of the hour (UTC).", "2026-01-14T08:00:00Z"),
            temp_f: num("Temperature, °F.", 26.1),
            precip_in: num("Precipitation, inches.", 0.01),
            precip_chance: int("Chance of precipitation, percent.", 40),
            wind_mph: num("Wind speed, mph.", 8.7),
            condition: str("Summary.", "Light snow"),
          },
          ["time", "temp_f"],
        )
      : obj(
          props({
            time: time("Start of the hour (UTC).", "2026-01-14T08:00:00Z"),
            temperature: num("Temperature.", -3.3),
            feels_like: num("Apparent temperature.", -7.4),
            precipitation: num("Precipitation amount, mm (inches in imperial).", 0.3),
            precipitation_probability: int("Chance of precipitation, percent.", 40),
            wind: ref("Wind"),
            cloud_cover: int("Cloud cover, percent.", 95),
            condition: ref("Condition"),
            temperature_spread: v === 3 ? percentiles : undefined,
          }),
          ["time", "temperature", "condition"],
        );
  const day =
    v === 1
      ? obj(
          {
            date: date("Local date.", "2026-01-14"),
            high_f: num("High, °F.", 30.2),
            low_f: num("Low, °F.", 21.0),
            precip_chance: int("Chance of precipitation, percent.", 60),
            sunrise: str("Local sunrise, HH:MM.", "09:10"),
            sunset: str("Local sunset, HH:MM.", "15:32"),
            condition: str("Summary.", "Snow showers"),
          },
          ["date", "high_f", "low_f"],
        )
      : obj(
          props({
            date: date("Local date.", "2026-01-14"),
            temperature_max: num("Daily high.", -1.0),
            temperature_min: num("Daily low.", -6.1),
            precipitation_sum: num("Total precipitation.", 2.4),
            precipitation_probability: int("Chance of precipitation, percent.", 60),
            snowfall_sum: num("Total snowfall, cm (inches in imperial).", 3.1),
            wind_max: num("Highest sustained wind.", 6.3),
            sunrise: time("Sunrise (UTC).", "2026-01-14T08:10:00Z"),
            sunset: time("Sunset (UTC).", "2026-01-14T14:32:00Z"),
            uv_index_max: num("Highest UV index.", 0.5),
            condition: ref("Condition"),
            high_spread: v === 3 ? percentiles : undefined,
          }),
          ["date", "temperature_max", "temperature_min", "condition"],
        );

  const envelope = (key: string, item: Record<string, unknown>, description: string) =>
    obj(
      props({
        location: ref("Location"),
        generated_at: time("When the model run behind this forecast finished.", "2026-01-14T06:00:00Z"),
        units: v === 1 ? undefined : enm("Units used in this response.", ["metric", "imperial", "si"]),
        model: v === 1 ? undefined : str("Forecast model.", "gfs-ecmwf-blend-4"),
        [key]: arr(item),
      }),
      ["location", key],
      description,
    );

  return {
    group: "Weather",
    tag: { name: tag, description: "Hourly, daily, and minute-by-minute forecasts for any point." },
    schemas: { HourlyForecast: hour, DailyForecast: day },
    paths: paths([
      [
        v === 1 ? "/forecast" : "/forecasts/daily",
        "get",
        op(tag, {
          id: v === 1 ? "getForecast" : "getDailyForecast",
          summary: v === 1 ? "Get a forecast" : "Get a daily forecast",
          description:
            v === 1
              ? "Seven days of daily highs, lows, and conditions."
              : "Up to 16 days of daily aggregates.",
          params: [
            ...where,
            query("days", "Number of days.", int("", 7, { minimum: 1, maximum: v === 1 ? 7 : 16, default: 7 })),
          ],
          responses: { "200": envelope("days", ref("DailyForecast"), "Daily forecast.") },
        }),
      ],
      [
        v === 1 ? "/forecast/hourly" : "/forecasts/hourly",
        "get",
        op(tag, {
          id: "getHourlyForecast",
          summary: "Get an hourly forecast",
          params: [
            ...where,
            query("hours", "Number of hours.", int("", 48, { minimum: 1, maximum: v === 1 ? 48 : 384, default: 48 })),
          ],
          responses: { "200": envelope("hours", ref("HourlyForecast"), "Hourly forecast.") },
        }),
      ],
      v >= 2 && [
        "/forecasts/minutely",
        "get",
        op(tag, {
          id: "getMinutelyPrecipitation",
          summary: "Get minute-by-minute precipitation",
          description: "Precipitation intensity for the next two hours in five-minute steps, from radar nowcasting.",
          params: where,
          responses: {
            "200": obj({
              location: ref("Location"),
              summary: str("Plain-language summary.", "Light snow starting in 15 minutes."),
              minutes: arr(
                obj({
                  time: time("Start of the step.", "2026-01-14T08:15:00Z"),
                  intensity: num("Precipitation rate, mm/h.", 0.6),
                  probability: int("Chance of any precipitation, percent.", 70),
                }),
              ),
            }),
          },
        }),
      ],
      v >= 2 && [
        "/forecasts/batch",
        "post",
        op(tag, {
          id: "batchForecasts",
          summary: "Get forecasts for many points",
          description: "Up to 100 points in one request. Each point is billed as one call.",
          body: obj(
            {
              points: arr(
                obj({ latitude: num("", 59.9139), longitude: num("", 10.7522), ref: str("Your own id, echoed back.", "warehouse-12") }, ["latitude", "longitude"]),
                undefined,
                { maxItems: 100 },
              ),
              kind: enm("Forecast kind.", ["daily", "hourly"]),
              units: enm("Unit system.", ["metric", "imperial", "si"]),
            },
            ["points", "kind"],
          ),
          responses: {
            "200": obj({
              results: arr(
                obj({
                  ref: str("Your id.", "warehouse-12"),
                  status: enm("Result for this point.", ["ok", "error"]),
                  forecast: obj({}, [], "Same shape as the single-point response."),
                }),
              ),
            }),
          },
        }),
      ],
      v >= 2 && [
        "/forecasts/discussion",
        "get",
        op(tag, {
          id: "getForecastDiscussion",
          summary: "Get the forecaster discussion",
          description: "The meteorologist's written reasoning behind the regional forecast.",
          params: [query("region", "Forecast region.", str("", "eu-north"), true)],
          responses: {
            "200": obj({
              region: str("Region.", "eu-north"),
              issued_at: time("Issue time.", "2026-01-14T05:30:00Z"),
              author: str("Forecaster.", "M. Haugen"),
              text: str("Discussion, Markdown.", "A shallow low tracks east across southern Norway this morning…"),
            }),
          },
        }),
      ],
      v === 3 && [
        "/forecasts/ensemble",
        "get",
        op(tag, {
          id: "getEnsembleForecast",
          summary: "Get an ensemble forecast",
          description: "Every member of the 51-member ensemble, for building your own probability products.",
          params: [...where, query("variable", "Variable to return.", enm("", ["temperature", "precipitation", "wind_speed"]), true)],
          responses: {
            "200": obj({
              location: ref("Location"),
              variable: str("Variable.", "temperature"),
              members: int("Ensemble size.", 51),
              times: arr(time("", "2026-01-14T08:00:00Z")),
              values: arr(arr(num("", -3.2)), "One row per member, one column per time."),
            }),
          },
        }),
      ],
      v === 3 && [
        "/forecasts/probability",
        "get",
        op(tag, {
          id: "getExceedanceProbability",
          summary: "Get the chance of exceeding a threshold",
          params: [
            ...where,
            query("variable", "Variable.", enm("", ["temperature", "precipitation", "wind_gust", "snowfall"]), true),
            query("threshold", "Threshold in the requested units.", num("", 10), true),
          ],
          responses: {
            "200": obj({
              location: ref("Location"),
              hours: arr(obj({ time: time("", "2026-01-14T08:00:00Z"), probability: num("0–1.", 0.18) })),
            }),
          },
        }),
      ],
    ]),
  };
}

export function observations(v: Version): Area {
  const tag = "Observations";
  const observation = obj(
    props({
      id: str("Observation id.", v === 1 ? "8812004" : "obs_8812004"),
      station: stationRef(v),
      observed_at: observedAt,
      conditions: ref("Conditions"),
      quality: v === 1 ? undefined : enm("Quality-control status.", ["raw", "checked", "corrected", "suspect"], "checked"),
      raw_metar: v === 1 ? undefined : nullable(str("Original METAR, for airport stations.", "ENGM 140750Z 02008KT 6000 -SN BKN012 M03/M05 Q1012")),
    }),
    ["id", "station", "observed_at", "conditions"],
    "A measurement reported by a station.",
  );
  const station = path(v === 1 ? "id" : "station_id", "Station id.", v === 1 ? "01492" : "stn_01492");
  return {
    group: "Weather",
    tag: { name: tag, description: "Measured weather from ground stations." },
    schemas: { Observation: observation },
    paths: paths([
      [
        v === 1 ? "/stations/{id}/observations/latest" : "/stations/{station_id}/observations/latest",
        "get",
        op(tag, {
          id: v === 1 ? "getCurrentConditions" : "getLatestObservation",
          summary: v === 1 ? "Get current conditions" : "Get the latest observation",
          params: [station, ...units(v)],
          responses: { "200": ref("Observation") },
        }),
      ],
      [
        v === 1 ? "/stations/{id}/observations" : "/stations/{station_id}/observations",
        "get",
        op(tag, {
          id: "listObservations",
          summary: "List observations",
          description: v === 1 ? "The last 24 hours of observations." : "Observations between `start` and `end`, newest first.",
          params: [
            station,
            ...(v === 1
              ? []
              : [
                  query("start", "Earliest observation time.", time("", "2026-01-13T08:00:00Z")),
                  query("end", "Latest observation time.", time("", "2026-01-14T08:00:00Z")),
                  query("quality", "Only observations with this status.", enm("", ["raw", "checked", "corrected", "suspect"])),
                ]),
            ...units(v),
            ...paging(v),
          ],
          responses: { "200": list(v, ref("Observation"), "Observations, newest first.") },
        }),
      ],
      v >= 2 && [
        "/observations/{observation_id}",
        "get",
        op(tag, {
          id: "getObservation",
          summary: "Get an observation",
          params: [path("observation_id", "Observation id.", "obs_8812004"), ...units(v)],
          responses: { "200": ref("Observation") },
        }),
      ],
      [
        v === 1 ? "/current" : "/observations/nearest",
        "get",
        op(tag, {
          id: v === 1 ? "getCurrent" : "getNearestObservation",
          summary: v === 1 ? "Get current weather" : "Get the nearest observation",
          description:
            v === 1
              ? "Current conditions at the station closest to a point."
              : "The latest observation from the closest station reporting within the last hour.",
          params: [lat(v), lon(v), ...units(v)],
          responses: { "200": ref("Observation") },
        }),
      ],
      v >= 2 && [
        "/observations/metar/{icao}",
        "get",
        op(tag, {
          id: "getRawMetar",
          summary: "Get a raw METAR",
          description: "The latest METAR report for an airport, as plain text.",
          params: [path("icao", "ICAO airport code.", "ENGM")],
          responses: {
            "200": {
              description: "The METAR string.",
              content: { "text/plain": { schema: str("", "ENGM 140750Z 02008KT 6000 -SN BKN012 M03/M05 Q1012") } },
            },
          },
        }),
      ],
      v >= 2 && [
        "/observations/conditions",
        "get",
        op(tag, {
          id: "listConditionCodes",
          summary: "List condition codes",
          description: "Every condition label, its WMO code, and its English text.",
          responses: {
            "200": arr(obj({ code: int("WMO code.", 71), label: enm("", CONDITIONS, "snow_light"), text: str("", "Light snow") })),
          },
        }),
      ],
    ]),
  };
}
