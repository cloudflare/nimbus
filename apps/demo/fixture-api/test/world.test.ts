import assert from "node:assert/strict";
import { test } from "node:test";
import { EXAMPLE_CITY_ID, world } from "../src/world";

test("the world has hundreds of cities with unique ids in the spec's pattern", () => {
  assert.ok(world.cities.length >= 400, `only ${world.cities.length} cities`);
  const ids = new Set(world.cities.map((city) => city.id));
  assert.equal(ids.size, world.cities.length);
  for (const city of world.cities) assert.match(city.id, /^loc_[a-z]+_[a-z]{2}$/, city.id);
  const stations = new Set(world.cities.map((city) => city.station.id));
  assert.equal(stations.size, world.cities.length, "station ids are unique");
});

test("every city has coordinates in range, a time zone Intl accepts, and a population", () => {
  for (const city of world.cities) {
    assert.ok(city.latitude >= -90 && city.latitude <= 90, city.id);
    assert.ok(city.longitude >= -180 && city.longitude <= 180, city.id);
    assert.doesNotThrow(() => new Intl.DateTimeFormat("en", { timeZone: city.timezone }), `${city.id}: ${city.timezone}`);
    assert.ok(city.population > 0, city.id);
    assert.match(city.country, /^[A-Z]{2}$/, city.id);
    assert.equal(city.temperatures.length, 12);
    assert.equal(city.precipitationDays.length, 12);
  }
});

test("normals are plausible: summer is warmer than winter in each hemisphere, except near the equator", () => {
  for (const city of world.cities) {
    const t = city.temperatures;
    const july = (t[5] as number) + (t[6] as number) + (t[7] as number);
    const january = (t[11] as number) + (t[0] as number) + (t[1] as number);
    if (Math.abs(city.latitude) < 10) continue;
    if (city.latitude > 0) assert.ok(july > january, `${city.id}: July ${july} should beat January ${january}`);
    else assert.ok(january > july, `${city.id}: January ${january} should beat July ${july}`);
    for (const value of t) assert.ok(value > -50 && value < 45, `${city.id}: ${value}`);
    for (const days of city.precipitationDays) assert.ok(days >= 0 && days <= 31, city.id);
  }
});

test("the example city keeps the specs' ids, so unresolved requests return the documented body", () => {
  const oslo = world.city(EXAMPLE_CITY_ID);
  assert.ok(oslo);
  assert.equal(oslo.station.id, "stn_01492");
  assert.equal(oslo.station.wmoId, "01492");
  assert.equal(oslo.station.name, "Oslo – Blindern");
  assert.equal(oslo.zone.id, "zone_no_03");
  assert.equal(oslo.latitude, 59.9139);
  assert.equal(oslo.population, 709037);
});

test("lookups: search by prefix ignores case and accents, nearest finds the city, stations resolve by both id forms", () => {
  assert.equal(world.search("par")[0]?.id, "loc_paris_fr");
  assert.equal(world.search("sao")[0]?.id, "loc_saopaulo_br");
  assert.equal(world.search("zur")[0]?.id, "loc_zurich_ch");
  assert.deepEqual(world.search("zzz"), []);
  assert.equal(world.search("lon", "GB")[0]?.id, "loc_london_gb");
  assert.equal(world.nearest(51.5, -0.1).id, "loc_london_gb");
  assert.equal(world.nearest(-33.9, 151.2).id, "loc_sydney_au");
  const london = world.city("loc_london_gb");
  assert.ok(london);
  assert.equal(world.stationOwner(london.station.id)?.id, "loc_london_gb");
  assert.equal(world.stationOwner(london.station.wmoId)?.id, "loc_london_gb");
  assert.equal(world.zoneOwner(london.zone.id)?.id, "loc_london_gb");
  assert.equal(world.stationOwner("stn_00000"), undefined);
});
