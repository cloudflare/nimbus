/**
 * Synthetic weather: plausible, bounded, deterministic. Every value is a
 * function of the city, the day or hour, and the field, through one hash, so
 * the same request gives the same answer and different cities differ. The
 * numbers sit around the city's monthly normal; nothing here forecasts.
 */
import { type City, hash32 } from "./world";

export type Units = "metric" | "imperial" | "si";

export interface ConditionTuple {
  code: number;
  label: string;
  text: string;
}

/** The spec's condition list (core.ts CONDITIONS) with WMO codes and English text. */
export const CONDITIONS: ConditionTuple[] = [
  { code: 0, label: "clear", text: "Clear sky" },
  { code: 1, label: "mainly_clear", text: "Mainly clear" },
  { code: 2, label: "partly_cloudy", text: "Partly cloudy" },
  { code: 3, label: "overcast", text: "Overcast" },
  { code: 45, label: "fog", text: "Fog" },
  { code: 48, label: "rime_fog", text: "Depositing rime fog" },
  { code: 51, label: "drizzle_light", text: "Light drizzle" },
  { code: 53, label: "drizzle", text: "Drizzle" },
  { code: 55, label: "drizzle_dense", text: "Dense drizzle" },
  { code: 56, label: "freezing_drizzle", text: "Freezing drizzle" },
  { code: 61, label: "rain_light", text: "Light rain" },
  { code: 63, label: "rain", text: "Rain" },
  { code: 65, label: "rain_heavy", text: "Heavy rain" },
  { code: 66, label: "freezing_rain", text: "Freezing rain" },
  { code: 71, label: "snow_light", text: "Light snow" },
  { code: 73, label: "snow", text: "Snow" },
  { code: 75, label: "snow_heavy", text: "Heavy snow" },
  { code: 77, label: "snow_grains", text: "Snow grains" },
  { code: 80, label: "showers", text: "Rain showers" },
  { code: 82, label: "showers_heavy", text: "Heavy rain showers" },
  { code: 85, label: "snow_showers", text: "Snow showers" },
  { code: 95, label: "thunderstorm", text: "Thunderstorm" },
  { code: 96, label: "thunderstorm_hail", text: "Thunderstorm with hail" },
];

const byLabel = new Map(CONDITIONS.map((c) => [c.label, c]));

/** A number in [0, 1) that is the same for the same parts. */
export function roll(...parts: Array<string | number>): number {
  return hash32(parts.join("|")) / 0x100000000;
}

export function round(value: number, decimals = 1): number {
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** `YYYY-MM-DD` of a Date, UTC. */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - start) / 86_400_000) + 1;
}

/** The city's normal temperature on a day, interpolated between monthly means. */
export function normalTemperature(city: City, date: Date): number {
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const length = MONTH_DAYS[month] as number;
  const next = (month + 1) % 12;
  const t = (day - 1) / length;
  const a = city.temperatures[month] as number;
  const b = city.temperatures[next] as number;
  return a + (b - a) * t;
}

export interface DayWeather {
  date: string;
  mean: number;
  max: number;
  min: number;
  range: number;
  /** Chance of precipitation, percent, integer. */
  probability: number;
  /** Precipitation amount, mm. */
  precipitation: number;
  /** Snowfall, cm; only at or below 1 °C. */
  snowfall: number;
  humidity: number;
  cloud: number;
  windMax: number;
  uvMax: number;
  condition: ConditionTuple;
  sunrise: Date;
  sunset: Date;
}

export function dayWeather(city: City, date: Date): DayWeather {
  const day = isoDate(date);
  const key = `${city.id}|${day}`;
  const normal = normalTemperature(city, date);
  const mean = round(normal + (roll(key, "t") - 0.5) * 8);
  const range = round(5 + roll(key, "range") * 8);
  const max = round(mean + range / 2);
  const min = round(mean - range / 2);
  const month = date.getUTCMonth();
  const wetDays = city.precipitationDays[month] as number;
  const base = wetDays / 30;
  const probability = Math.round(clamp((base + (roll(key, "p") - 0.5) * 0.5) * 100, 0, 100));
  const precipitation = probability > 55 ? round(0.5 + roll(key, "amount") * 12) : probability > 35 ? round(roll(key, "amount") * 2) : 0;
  const snowfall = max <= 1 && precipitation > 0 ? round(precipitation * 1.2) : 0;
  const humidity = Math.round(clamp(45 + roll(key, "h") * 40 + (precipitation > 0 ? 15 : 0), 0, 100));
  const cloud = Math.round(clamp(precipitation > 0 ? 65 + roll(key, "c") * 35 : roll(key, "c") * 95, 0, 100));
  const windMax = round(2 + roll(key, "w") * 12);
  const uvMax = uvIndex(city.latitude, date, cloud);
  const condition = conditionFor(mean, precipitation, cloud, humidity, windMax);
  const { sunrise, sunset } = sunTimes(city, date);
  return { date: day, mean, max, min, range, probability, precipitation, snowfall, humidity, cloud, windMax, uvMax, condition, sunrise, sunset };
}

export interface HourWeather {
  time: Date;
  temperature: number;
  feelsLike: number;
  dewPoint: number;
  humidity: number;
  pressure: number;
  wind: { speed: number; gust: number; direction: number };
  precipitation: number;
  probability: number;
  cloud: number;
  visibility: number;
  uv: number;
  condition: ConditionTuple;
}

export function hourWeather(city: City, time: Date): HourWeather {
  const day = dayWeather(city, time);
  const key = `${city.id}|${time.toISOString().slice(0, 13)}`;
  const localHour = (time.getUTCHours() + city.longitude / 15 + 24) % 24;
  // Coldest just before dawn, warmest mid-afternoon.
  const curve = -Math.cos(((localHour - 4) / 24) * 2 * Math.PI);
  const temperature = round(day.mean + (curve * day.range) / 2 + (roll(key, "t") - 0.5) * 1.5);
  const wet = day.probability > 55 ? roll(key, "wet") < 0.6 : day.probability > 35 ? roll(key, "wet") < 0.25 : false;
  const precipitation = wet ? round(Math.max(0.1, (day.precipitation / 8) * (0.5 + roll(key, "amount")))) : 0;
  const probability = Math.round(clamp(day.probability + (roll(key, "p") - 0.5) * 30, 0, 100));
  const humidity = Math.round(clamp(day.humidity + (roll(key, "h") - 0.5) * 20 + (wet ? 10 : 0), 0, 100));
  const cloud = Math.round(clamp(day.cloud + (roll(key, "c") - 0.5) * 30, 0, 100));
  const speed = round(clamp(day.windMax * (0.4 + roll(key, "w") * 0.6), 0, 60));
  const gust = round(speed * (1.2 + roll(key, "g") * 0.6));
  const direction = Math.floor(roll(`${city.id}|${day.date}`, "dir") * 360 + (roll(key, "dir") - 0.5) * 40 + 360) % 360;
  const pressure = round(1013 + (roll(`${city.id}|${day.date}`, "pr") - 0.5) * 40 + (roll(key, "pr") - 0.5) * 2);
  const dewPoint = round(temperature - ((100 - humidity) / 5));
  const feelsLike = round(feelsLikeOf(temperature, humidity, speed));
  const visibility = round(wet ? 2 + roll(key, "v") * 6 : 10 + roll(key, "v") * 40);
  const uv = round(uvIndex(city.latitude, time, cloud) * Math.max(0, Math.sin(((localHour - 6) / 12) * Math.PI)));
  const condition = conditionFor(temperature, precipitation, cloud, humidity, speed);
  return { time, temperature, feelsLike, dewPoint, humidity, pressure, wind: { speed, gust, direction }, precipitation, probability, cloud, visibility, uv, condition };
}

function feelsLikeOf(temperature: number, humidity: number, wind: number): number {
  if (temperature <= 10 && wind > 1.3) {
    const kmh = wind * 3.6;
    return 13.12 + 0.6215 * temperature - 11.37 * kmh ** 0.16 + 0.3965 * temperature * kmh ** 0.16;
  }
  if (temperature >= 27) return temperature + 0.33 * (humidity / 100) * 6.105 * Math.exp((17.27 * temperature) / (237.7 + temperature)) - 4;
  return temperature;
}

export function conditionFor(temperature: number, precipitation: number, cloud: number, humidity: number, wind: number): ConditionTuple {
  let label: string;
  if (precipitation > 0) {
    if (temperature <= 0) label = precipitation > 6 ? "snow_heavy" : precipitation > 2 ? "snow" : "snow_light";
    else if (temperature <= 1) label = "snow_showers";
    else if (temperature > 24 && precipitation > 8) label = "thunderstorm";
    else label = precipitation > 8 ? "rain_heavy" : precipitation > 2 ? "rain" : precipitation > 0.6 ? "rain_light" : "drizzle_light";
  } else if (humidity >= 96 && wind < 2) {
    label = temperature <= 0 ? "rime_fog" : "fog";
  } else {
    label = cloud >= 85 ? "overcast" : cloud >= 50 ? "partly_cloudy" : cloud >= 20 ? "mainly_clear" : "clear";
  }
  return byLabel.get(label) as ConditionTuple;
}

/** A v1 icon name from a condition. */
export function iconFor(condition: ConditionTuple): string {
  const { label } = condition;
  if (label.startsWith("snow")) return "snow";
  if (label.startsWith("thunder")) return "thunderstorm";
  if (label.startsWith("rain") || label.startsWith("drizzle") || label.startsWith("showers") || label.startsWith("freezing")) return "rain";
  if (label.endsWith("fog")) return "fog";
  if (label === "clear") return "clear";
  if (label === "overcast") return "cloudy";
  return "partly-cloudy";
}

const COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

export function compass(direction: number): string {
  return COMPASS[Math.round((((direction % 360) + 360) % 360) / 22.5) % 16] as string;
}

/** Clear-sky UV index for a latitude and day, reduced by cloud. */
export function uvIndex(latitude: number, date: Date, cloud: number): number {
  const rad = Math.PI / 180;
  const declination = 23.44 * Math.sin(((2 * Math.PI) / 365) * (dayOfYear(date) - 81));
  const noon = Math.cos((latitude - declination) * rad);
  const clear = 11 * Math.max(0, noon) ** 1.5;
  return round(clamp(clear * (1 - cloud / 160), 0, 12));
}

/** Sunrise and sunset (UTC) from latitude, longitude and the day; 06:00/18:00 local in polar day or night. */
export function sunTimes(city: City, date: Date): { sunrise: Date; sunset: Date } {
  const rad = Math.PI / 180;
  const declination = 23.44 * Math.sin(((2 * Math.PI) / 365) * (dayOfYear(date) - 81));
  const cosH = -Math.tan(city.latitude * rad) * Math.tan(declination * rad);
  const halfDay = cosH <= -1 || cosH >= 1 ? 6 : Math.acos(cosH) / rad / 15;
  const solarNoonUtc = 12 - city.longitude / 15;
  const base = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const at = (hours: number) => new Date(base + Math.round(hours * 60) * 60_000);
  return { sunrise: at(solarNoonUtc - halfDay), sunset: at(solarNoonUtc + halfDay) };
}

/** `HH:MM` of an instant in the city's time zone. */
export function localClock(city: City, instant: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: city.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(instant);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

// Metric is °C, m/s, mm, cm, km, hPa; imperial is °F, mph, in, in, mi and, as
// the specs say, still hPa; si is K, m/s, m, m, m, Pa.
export const temperature = (celsius: number, units: Units): number =>
  units === "imperial" ? round(celsius * 1.8 + 32) : units === "si" ? round(celsius + 273.15) : celsius;
export const speed = (ms: number, units: Units): number => (units === "imperial" ? round(ms * 2.23694) : ms);
export const length = (mm: number, units: Units): number => (units === "imperial" ? round(mm / 25.4, 2) : units === "si" ? round(mm / 1000, 4) : mm);
export const depth = (cm: number, units: Units): number => (units === "imperial" ? round(cm / 2.54) : units === "si" ? round(cm / 100, 3) : cm);
export const distance = (km: number, units: Units): number => (units === "imperial" ? round(km * 0.621371) : units === "si" ? Math.round(km * 1000) : km);
export const pressureIn = (hpa: number, units: Units): number => (units === "si" ? Math.round(hpa * 100) : hpa);

/** Ordered percentiles around a value, for v3-preview's spreads. */
export function spread(value: number, key: string, units: Units): { p10: number; p50: number; p90: number } {
  const width = 1.5 + roll(key, "spread") * 3;
  return { p10: temperature(round(value - width), units), p50: temperature(value, units), p90: temperature(round(value + width), units) };
}
