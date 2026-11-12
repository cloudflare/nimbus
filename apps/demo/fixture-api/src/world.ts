/**
 * The sandbox's world: the cities in world.json, each with a station, a zone
 * and monthly normals, and the lookups the answers need (by id, by station,
 * by zone, nearest to a point, by name prefix).
 *
 * Normals come from the city's Köppen class: a twelve-month profile of mean
 * temperature and precipitation days for the northern hemisphere, shifted by
 * six months south of the equator and by the city's `dT` for altitude or
 * coast. Good enough for synthetic weather that is warm where it should be.
 */
import data from "./world.json";

export interface Station {
  id: string;
  wmoId: string;
  icao: string;
  name: string;
}

export interface Zone {
  id: string;
  name: string;
}

export interface City {
  id: string;
  name: string;
  region: string;
  country: string;
  timezone: string;
  latitude: number;
  longitude: number;
  elevation: number;
  population: number;
  climate: string;
  /** Mean temperature per month, January first, °C. */
  temperatures: number[];
  /** Days with precipitation per month, January first. */
  precipitationDays: number[];
  station: Station;
  zone: Zone;
}

type Row = [string, string, string, string, string, number, number, number, number, string, number, string, string];

/** Monthly mean temperature (°C) and precipitation days, northern hemisphere, January first. */
const PROFILES: Record<string, { t: number[]; p: number[] }> = {
  Af: { t: [26, 26, 27, 27, 27, 27, 26, 26, 27, 27, 26, 26], p: [16, 14, 16, 18, 20, 18, 16, 15, 16, 18, 20, 18] },
  Am: { t: [25, 26, 27, 28, 29, 28, 27, 27, 27, 27, 26, 25], p: [2, 1, 1, 2, 8, 18, 24, 22, 16, 8, 3, 2] },
  As: { t: [26, 26, 27, 27, 27, 26, 25, 25, 26, 26, 26, 26], p: [6, 8, 12, 16, 18, 16, 12, 8, 5, 4, 4, 5] },
  Aw: { t: [26, 27, 28, 29, 29, 28, 27, 27, 27, 27, 27, 26], p: [1, 1, 2, 5, 12, 16, 18, 18, 16, 10, 4, 1] },
  BSh: { t: [16, 18, 22, 26, 30, 32, 31, 30, 29, 26, 21, 17], p: [2, 2, 3, 2, 2, 3, 6, 8, 5, 2, 1, 2] },
  BSk: { t: [-1, 1, 6, 12, 17, 22, 25, 24, 19, 12, 5, 0], p: [5, 5, 6, 7, 8, 6, 4, 4, 4, 5, 5, 5] },
  BWh: { t: [14, 16, 20, 25, 30, 34, 36, 36, 33, 28, 21, 15], p: [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1, 1] },
  BWk: { t: [-3, 0, 7, 14, 20, 25, 27, 25, 19, 12, 4, -2], p: [2, 2, 3, 3, 4, 3, 3, 2, 2, 2, 2, 2] },
  Cfa: { t: [5, 7, 11, 16, 21, 25, 28, 27, 23, 17, 12, 7], p: [9, 9, 10, 10, 10, 10, 10, 9, 8, 8, 9, 9] },
  Cfb: { t: [5, 5, 8, 10, 14, 17, 19, 19, 16, 12, 8, 5], p: [12, 10, 11, 10, 10, 9, 9, 9, 9, 12, 12, 12] },
  Cfc: { t: [0, 0, 1, 3, 6, 9, 11, 11, 8, 5, 2, 1], p: [16, 15, 15, 13, 12, 12, 13, 14, 15, 17, 16, 16] },
  Csa: { t: [9, 10, 12, 15, 19, 24, 27, 27, 23, 18, 13, 10], p: [8, 7, 7, 6, 4, 2, 1, 1, 3, 6, 8, 9] },
  Csb: { t: [9, 10, 11, 12, 14, 16, 18, 18, 17, 15, 12, 9], p: [9, 8, 8, 6, 3, 1, 0, 0, 1, 4, 8, 9] },
  Cwa: { t: [14, 17, 23, 29, 33, 33, 31, 30, 29, 26, 20, 15], p: [2, 2, 2, 2, 4, 8, 16, 16, 10, 3, 1, 1] },
  Cwb: { t: [14, 15, 17, 18, 18, 17, 16, 16, 16, 16, 15, 14], p: [2, 3, 5, 10, 14, 16, 18, 18, 14, 10, 5, 2] },
  Dfa: { t: [-4, -2, 4, 11, 17, 22, 25, 24, 19, 12, 5, -2], p: [8, 7, 9, 10, 11, 10, 9, 8, 8, 9, 9, 9] },
  Dfb: { t: [-5, -4, 0, 6, 12, 16, 18, 17, 12, 6, 1, -3], p: [10, 8, 9, 8, 9, 10, 10, 10, 10, 10, 11, 11] },
  Dfc: { t: [-12, -11, -6, 0, 6, 12, 15, 13, 8, 1, -6, -10], p: [9, 8, 8, 7, 8, 9, 11, 12, 11, 11, 10, 10] },
  Dfd: { t: [-38, -33, -20, -6, 7, 16, 19, 15, 6, -8, -27, -36], p: [4, 3, 3, 3, 5, 8, 9, 9, 7, 6, 5, 4] },
  Dwa: { t: [-4, -1, 6, 14, 20, 25, 27, 26, 21, 13, 4, -2], p: [2, 3, 3, 5, 7, 10, 13, 11, 7, 5, 3, 2] },
  Dwb: { t: [-14, -10, -2, 6, 13, 18, 21, 19, 13, 4, -6, -12], p: [2, 2, 3, 4, 7, 10, 13, 12, 8, 4, 3, 2] },
  ET: { t: [-8, -8, -6, -2, 3, 7, 10, 9, 5, 0, -4, -7], p: [8, 7, 7, 6, 6, 7, 8, 9, 10, 9, 8, 8] },
};

const SOUTH_SHIFT = 6;

/** The specs' example city; every documented body is about it. */
export const EXAMPLE_CITY_ID = "loc_oslo_no";

function rotate<T>(values: T[], by: number): T[] {
  return values.map((_, index) => values[(index + by) % values.length] as T);
}

/** FNV-1a over a string, as a 32-bit unsigned integer. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** One zone per city, numbered within its country in file order; the example city keeps the specs' `zone_no_03`. */
const zoneCounters = new Map<string, number>();
function zoneIdFor(id: string, country: string): string {
  if (id === EXAMPLE_CITY_ID) return "zone_no_03";
  let n = (zoneCounters.get(country) ?? 0) + 1;
  if (country === "NO" && n === 3) n = 4;
  zoneCounters.set(country, n);
  return `zone_${country.toLowerCase()}_${String(n).padStart(2, "0")}`;
}

function toCity(row: Row): City {
  const [id, name, region, country, timezone, latitude, longitude, elevation, population, climate, dT, district, icao] = row;
  const profile = PROFILES[climate];
  if (!profile) throw new Error(`world.json: unknown climate class ${climate} for ${id}`);
  const shift = latitude < 0 ? SOUTH_SHIFT : 0;
  const temperatures = rotate(profile.t, shift).map((t) => t + dT);
  const precipitationDays = rotate(profile.p, shift);
  const slug = id.slice("loc_".length);
  // The example city keeps the specs' station and zone ids, so an unresolved
  // request still returns the documented body.
  const wmoId = id === EXAMPLE_CITY_ID ? "01492" : String(hash32(slug) % 90000 + 10000);
  const zoneId = zoneIdFor(id, country);
  return {
    id,
    name,
    region,
    country,
    timezone,
    latitude,
    longitude,
    elevation,
    population,
    climate,
    temperatures,
    precipitationDays,
    station: { id: `stn_${wmoId}`, wmoId, icao, name: `${name} – ${district}` },
    zone: { id: zoneId, name },
  };
}

const cities: City[] = (data.cities as Row[]).map(toCity);
const byId = new Map(cities.map((city) => [city.id, city]));
const byStation = new Map(cities.map((city) => [city.station.id, city]));
const byWmo = new Map(cities.map((city) => [city.station.wmoId, city]));
const byZone = new Map(cities.map((city) => [city.zone.id, city]));

export const world = {
  cities,
  example(): City {
    return byId.get(EXAMPLE_CITY_ID) as City;
  },
  city(id: string): City | undefined {
    return byId.get(id);
  },
  /** By `stn_<n>` (later versions) or the bare WMO number (v1). */
  stationOwner(id: string): City | undefined {
    return byStation.get(id) ?? byWmo.get(id);
  },
  zoneOwner(id: string): City | undefined {
    return byZone.get(id);
  },
  /** Cities whose name starts with `q`, case-insensitive, most populous first. */
  search(q: string, country?: string): City[] {
    const needle = q.trim().toLowerCase();
    const cc = country?.toUpperCase();
    return cities
      .filter((city) => (!cc || city.country === cc) && (needle === "" || fold(city.name).startsWith(needle) || city.name.toLowerCase().startsWith(needle)))
      .sort((a, b) => b.population - a.population);
  },
  nearest(latitude: number, longitude: number): City {
    let best = cities[0] as City;
    let bestDistance = Infinity;
    for (const city of cities) {
      const d = distanceKm(latitude, longitude, city.latitude, city.longitude);
      if (d < bestDistance) {
        bestDistance = d;
        best = city;
      }
    }
    return best;
  },
  inCountry(country: string): City[] {
    const cc = country.toUpperCase();
    return cities.filter((city) => city.country === cc).sort((a, b) => b.population - a.population);
  },
};

/** Strip diacritics so "sao" finds São Paulo and "zurich" finds Zürich. */
function fold(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
