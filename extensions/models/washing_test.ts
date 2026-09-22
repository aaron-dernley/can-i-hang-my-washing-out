import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";
import {
  aggregatePeriod,
  buildHeadline,
  computeDryingScore,
  fetchHourlyForecast,
  model,
  resolveLocation,
  scoreHumidity,
  scoreRain,
  scoreSunshine,
  scoreTemperature,
  scoreWind,
} from "./washing.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeHourly(overrides: {
  hours: number[];
  temperature?: number[];
  humidity?: number[];
  precipProbability?: number[];
  precipitation?: number[];
  wind?: number[];
  sunshineSeconds?: number[];
}) {
  const n = overrides.hours.length;
  const fill = (arr: number[] | undefined, def: number) =>
    arr ?? Array(n).fill(def);
  return {
    time: overrides.hours.map((h) =>
      `2026-09-22T${String(h).padStart(2, "0")}:00`
    ),
    temperature_2m: fill(overrides.temperature, 15),
    relative_humidity_2m: fill(overrides.humidity, 60),
    precipitation_probability: fill(overrides.precipProbability, 0),
    precipitation: fill(overrides.precipitation, 0),
    wind_speed_10m: fill(overrides.wind, 15),
    sunshine_duration: fill(overrides.sunshineSeconds, 3000),
  };
}

// --- scoreRain ---

Deno.test("scoreRain: no rain risk scores 10", () => {
  assertEquals(scoreRain(0, 0), 10);
});

Deno.test("scoreRain: certain heavy rain scores 0", () => {
  assertEquals(scoreRain(100, 5), 0);
});

Deno.test("scoreRain: high probability alone tanks the score even with no measured mm", () => {
  assert(scoreRain(90, 0) <= 1);
});

Deno.test("scoreRain: significant volume alone tanks the score even with low probability", () => {
  assert(scoreRain(10, 3) <= 1);
});

// --- scoreSunshine ---

Deno.test("scoreSunshine: full sun scores 10", () => {
  assertEquals(scoreSunshine(1), 10);
});

Deno.test("scoreSunshine: no sun scores 0", () => {
  assertEquals(scoreSunshine(0), 0);
});

Deno.test("scoreSunshine: half sun scores 5", () => {
  assertEquals(scoreSunshine(0.5), 5);
});

// --- scoreWind ---

Deno.test("scoreWind: dead calm scores low", () => {
  assertEquals(scoreWind(0), 3);
});

Deno.test("scoreWind: moderate breeze scores max", () => {
  assertEquals(scoreWind(15), 10);
  assertEquals(scoreWind(25), 10);
});

Deno.test("scoreWind: gale-force wind scores very low", () => {
  assertEquals(scoreWind(60), 2);
});

Deno.test("scoreWind: increases smoothly between calm and ideal", () => {
  assert(scoreWind(7) > scoreWind(3));
  assert(scoreWind(10) >= scoreWind(7));
});

// --- scoreHumidity ---

Deno.test("scoreHumidity: dry air scores 10", () => {
  assertEquals(scoreHumidity(30), 10);
  assertEquals(scoreHumidity(50), 10);
});

Deno.test("scoreHumidity: saturated air scores 0", () => {
  assertEquals(scoreHumidity(95), 0);
  assertEquals(scoreHumidity(100), 0);
});

Deno.test("scoreHumidity: mid-range humidity is between the extremes", () => {
  const s = scoreHumidity(72.5);
  assert(s > 0 && s < 10);
});

// --- scoreTemperature ---

Deno.test("scoreTemperature: freezing scores 0", () => {
  assertEquals(scoreTemperature(0), 0);
  assertEquals(scoreTemperature(-5), 0);
});

Deno.test("scoreTemperature: warm scores 10", () => {
  assertEquals(scoreTemperature(18), 10);
  assertEquals(scoreTemperature(30), 10);
});

Deno.test("scoreTemperature: mild is proportional", () => {
  assertEquals(scoreTemperature(9), 5);
});

// --- computeDryingScore ---

Deno.test("computeDryingScore: perfect conditions score close to 10 with the top verdict", () => {
  const result = computeDryingScore({
    avgTemperatureC: 22,
    avgHumidityPct: 40,
    avgWindSpeedKmh: 18,
    maxPrecipitationProbabilityPct: 0,
    totalPrecipitationMm: 0,
    sunshineFraction: 1,
  });
  assert(result.score >= 9, `expected >= 9, got ${result.score}`);
  assertEquals(result.verdict, "Great drying day — hang it all out");
});

Deno.test("computeDryingScore: wet, humid, sunless conditions score near 0 with the bottom verdict", () => {
  const result = computeDryingScore({
    avgTemperatureC: 8,
    avgHumidityPct: 98,
    avgWindSpeedKmh: 2,
    maxPrecipitationProbabilityPct: 95,
    totalPrecipitationMm: 4,
    sunshineFraction: 0,
  });
  assert(result.score <= 1, `expected <= 1, got ${result.score}`);
  assertEquals(result.verdict, "Don't bother — keep it inside");
});

Deno.test("computeDryingScore: rain dominates an otherwise decent day", () => {
  const dryButRainy = computeDryingScore({
    avgTemperatureC: 20,
    avgHumidityPct: 45,
    avgWindSpeedKmh: 15,
    maxPrecipitationProbabilityPct: 100,
    totalPrecipitationMm: 5,
    sunshineFraction: 0.8,
  });
  assert(
    dryButRainy.score < 5,
    `expected rain to dominate, got ${dryButRainy.score}`,
  );
});

Deno.test("computeDryingScore: score is always within [0, 10]", () => {
  const result = computeDryingScore({
    avgTemperatureC: -50,
    avgHumidityPct: 200,
    avgWindSpeedKmh: 500,
    maxPrecipitationProbabilityPct: 1000,
    totalPrecipitationMm: 1000,
    sunshineFraction: 5,
  });
  assert(result.score >= 0 && result.score <= 10);
});

// --- aggregatePeriod ---

Deno.test("aggregatePeriod: selects only hours within [start, end)", () => {
  const hourly = makeHourly({
    hours: [5, 6, 11, 12, 17, 18],
    temperature: [1, 10, 20, 30, 40, 50],
  });
  const stats = aggregatePeriod(hourly, 6, 12);
  // Only hours 6 and 11 fall in [6, 12) -> avg temp (10+20)/2 = 15
  assertEquals(stats.avgTemperatureC, 15);
});

Deno.test("aggregatePeriod: sums precipitation but maxes probability", () => {
  const hourly = makeHourly({
    hours: [6, 7, 8],
    precipProbability: [10, 80, 20],
    precipitation: [0.1, 0.2, 0.3],
  });
  const stats = aggregatePeriod(hourly, 6, 12);
  assertEquals(stats.maxPrecipitationProbabilityPct, 80);
  assert(Math.abs(stats.totalPrecipitationMm - 0.6) < 1e-9);
});

Deno.test("aggregatePeriod: converts sunshine seconds to a 0-1 fraction", () => {
  const hourly = makeHourly({ hours: [6], sunshineSeconds: [1800] });
  const stats = aggregatePeriod(hourly, 6, 12);
  assertEquals(stats.sunshineFraction, 0.5);
});

Deno.test("aggregatePeriod: throws when no hours fall in the window", () => {
  const hourly = makeHourly({ hours: [1, 2, 3] });
  let threw = false;
  try {
    aggregatePeriod(hourly, 6, 12);
  } catch {
    threw = true;
  }
  assert(threw);
});

// --- buildHeadline ---

Deno.test("buildHeadline: good best score reads 'Yes mate'", () => {
  const morning = {
    label: "Morning",
    score: 7,
    verdict: "",
    components: {} as never,
    stats: {} as never,
  };
  const afternoon = {
    label: "Afternoon",
    score: 3,
    verdict: "",
    components: {} as never,
    stats: {} as never,
  };
  assertMatch(buildHeadline(morning, afternoon), /^Yes mate/);
});

Deno.test("buildHeadline: poor best score reads 'No mate'", () => {
  const morning = {
    label: "Morning",
    score: 2,
    verdict: "",
    components: {} as never,
    stats: {} as never,
  };
  const afternoon = {
    label: "Afternoon",
    score: 5.9,
    verdict: "",
    components: {} as never,
    stats: {} as never,
  };
  assertMatch(buildHeadline(morning, afternoon), /^No mate/);
});

Deno.test("buildHeadline: picks the higher-scoring window", () => {
  const morning = {
    label: "Morning",
    score: 9,
    verdict: "",
    components: {} as never,
    stats: {} as never,
  };
  const afternoon = {
    label: "Afternoon",
    score: 2,
    verdict: "",
    components: {} as never,
    stats: {} as never,
  };
  assertMatch(buildHeadline(morning, afternoon), /morning/);
});

// --- resolveLocation ---

Deno.test("resolveLocation: run-args override wins over everything", async () => {
  const stubFetch = (() => {
    throw new Error("should not be called");
  }) as unknown as typeof fetch;
  const location = await resolveLocation(
    { latitude: 1, longitude: 2 },
    { latitude: 9, longitude: 9 },
    stubFetch,
  );
  assertEquals(location, { latitude: 1, longitude: 2, source: "run-args" });
});

Deno.test("resolveLocation: falls back to global args when no run override", async () => {
  const stubFetch = (() => {
    throw new Error("should not be called");
  }) as unknown as typeof fetch;
  const location = await resolveLocation({}, {
    latitude: 51.5,
    longitude: -0.1,
  }, stubFetch);
  assertEquals(location, {
    latitude: 51.5,
    longitude: -0.1,
    source: "global-args",
  });
});

Deno.test("resolveLocation: falls back to IP geolocation when nothing is set", async () => {
  const stubFetch = ((_url: string | URL) =>
    Promise.resolve(
      jsonResponse({ latitude: 12.3, longitude: 45.6 }),
    )) as unknown as typeof fetch;
  const location = await resolveLocation({}, {}, stubFetch);
  assertEquals(location, {
    latitude: 12.3,
    longitude: 45.6,
    source: "ip-geolocation",
  });
});

Deno.test("resolveLocation: throws a clear error when IP geolocation fails", async () => {
  const stubFetch =
    (() => Promise.resolve(jsonResponse({}, 503))) as unknown as typeof fetch;
  await assertRejects(
    () => resolveLocation({}, {}, stubFetch),
    Error,
    "HTTP 503",
  );
});

Deno.test("resolveLocation: throws when IP geolocation response is missing coordinates", async () => {
  const stubFetch = (() =>
    Promise.resolve(
      jsonResponse({ city: "Nowhere" }),
    )) as unknown as typeof fetch;
  await assertRejects(
    () => resolveLocation({}, {}, stubFetch),
    Error,
    "latitude/longitude",
  );
});

// --- fetchHourlyForecast ---

Deno.test("fetchHourlyForecast: parses the hourly block from a well-formed response", async () => {
  const hourly = makeHourly({ hours: [6, 7] });
  const stubFetch =
    (() =>
      Promise.resolve(jsonResponse({ hourly }))) as unknown as typeof fetch;
  const result = await fetchHourlyForecast(
    { latitude: 1, longitude: 2 },
    stubFetch,
  );
  assertEquals(result.time.length, 2);
});

Deno.test("fetchHourlyForecast: throws on a non-OK HTTP response", async () => {
  const stubFetch =
    (() => Promise.resolve(jsonResponse({}, 500))) as unknown as typeof fetch;
  await assertRejects(
    () => fetchHourlyForecast({ latitude: 1, longitude: 2 }, stubFetch),
    Error,
    "HTTP 500",
  );
});

Deno.test("fetchHourlyForecast: throws when the response has no hourly block", async () => {
  const stubFetch =
    (() =>
      Promise.resolve(jsonResponse({ daily: {} }))) as unknown as typeof fetch;
  await assertRejects(
    () => fetchHourlyForecast({ latitude: 1, longitude: 2 }, stubFetch),
    Error,
    "hourly forecast",
  );
});

// --- full method execute, via createModelTestContext ---

Deno.test("forecast method: writes a scored forecast resource end to end", async () => {
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const hourly = makeHourly({
    hours,
    temperature: hours.map((h) => (h >= 6 && h < 18 ? 20 : 8)),
    humidity: hours.map(() => 45),
    precipProbability: hours.map(() => 0),
    precipitation: hours.map(() => 0),
    wind: hours.map(() => 15),
    sunshineSeconds: hours.map((h) => (h >= 6 && h < 18 ? 3600 : 0)),
  });

  const stubFetch = ((url: string | URL) => {
    const u = String(url);
    if (u.includes("ipapi.co")) {
      throw new Error(
        "should not geolocate when global args provide a location",
      );
    }
    return Promise.resolve(jsonResponse({ hourly }));
  }) as unknown as typeof fetch;

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { latitude: 51.5, longitude: -0.1 },
    methodName: "forecast",
  });

  const result = await model.methods.forecast.execute(
    { _fetch: stubFetch },
    context as never,
  );

  assertEquals(result.dataHandles?.length, 1);
  const [written] = getWrittenResources();
  assertEquals(written.specName, "forecast");
  assertEquals(written.data.location, {
    latitude: 51.5,
    longitude: -0.1,
    source: "global-args",
  });
  assert((written.data.morning as { score: number }).score >= 8);
  assertMatch(written.data.headline as string, /^Yes mate/);
});

Deno.test("forecast method: uses a run-argument override in preference to global args", async () => {
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const hourly = makeHourly({ hours });
  const stubFetch =
    (() =>
      Promise.resolve(jsonResponse({ hourly }))) as unknown as typeof fetch;

  const { context, getWrittenResources } = createModelTestContext({
    globalArgs: { latitude: 1, longitude: 1 },
    methodName: "forecast",
  });

  await model.methods.forecast.execute(
    { latitude: 40.7, longitude: -74, _fetch: stubFetch },
    context as never,
  );

  const [written] = getWrittenResources();
  assertEquals(written.data.location, {
    latitude: 40.7,
    longitude: -74,
    source: "run-args",
  });
});
