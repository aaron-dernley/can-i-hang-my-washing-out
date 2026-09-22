/**
 * Tells you whether it's worth hanging your washing out, for a chosen
 * location, using free Open-Meteo forecast data (temperature, humidity,
 * wind, rain probability and sunshine duration). Produces a drying score
 * out of 10 for the morning window (06:00-12:00) and the afternoon/evening
 * window (12:00-18:00), each on a five-factor weighted formula, plus a
 * one-line "yes mate / no mate" headline.
 *
 * Location is never required as a literal argument committed to a model
 * definition: leave `latitude`/`longitude` unset (directly, or via
 * `${{ vault.get(...) }}` in the model YAML) and the method falls back to
 * free IP-based geolocation at run time, so nothing about where you live
 * needs to be written to a (possibly public) git history.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** A resolved geographic location and how it was obtained. */
export interface Location {
  /** Decimal degrees, positive north. */
  latitude: number;
  /** Decimal degrees, positive east. */
  longitude: number;
  /** Where this location came from: an explicit run/global argument, or IP geolocation. */
  source: "run-args" | "global-args" | "ip-geolocation";
}

/** Aggregated weather statistics for a single drying window. */
export interface PeriodStats {
  /** Mean air temperature across the window, in Celsius. */
  avgTemperatureC: number;
  /** Mean relative humidity across the window, as a percentage. */
  avgHumidityPct: number;
  /** Mean wind speed across the window, in km/h. */
  avgWindSpeedKmh: number;
  /** Highest hourly rain probability seen in the window, as a percentage. */
  maxPrecipitationProbabilityPct: number;
  /** Total expected rainfall across the window, in millimetres. */
  totalPrecipitationMm: number;
  /** Fraction of the window's hours with sunshine, from 0 (none) to 1 (all). */
  sunshineFraction: number;
}

/** The five 0-10 sub-scores that make up a drying score. */
export interface ScoreComponents {
  /** Sub-score for rain risk. */
  rain: number;
  /** Sub-score for sunshine. */
  sunshine: number;
  /** Sub-score for wind. */
  wind: number;
  /** Sub-score for humidity. */
  humidity: number;
  /** Sub-score for temperature. */
  temperature: number;
}

/** Full scored result for one drying window. */
export interface PeriodResult {
  /** Human-readable window name, e.g. "Morning" or "Afternoon". */
  label: string;
  /** Overall drying score out of 10. */
  score: number;
  /** Short human-readable verdict for this score. */
  verdict: string;
  /** The five sub-scores this score was built from. */
  components: ScoreComponents;
  /** The raw aggregated weather stats this score was built from. */
  stats: PeriodStats;
}

/** Raw hourly block shape returned by the Open-Meteo forecast API. */
export interface OpenMeteoHourly {
  /** ISO-8601 local timestamp for each hourly entry. */
  time: string[];
  /** Air temperature at 2m, in Celsius, per hour. */
  temperature_2m: number[];
  /** Relative humidity at 2m, as a percentage, per hour. */
  relative_humidity_2m: number[];
  /** Probability of precipitation, as a percentage, per hour. */
  precipitation_probability: number[];
  /** Expected precipitation, in millimetres, per hour. */
  precipitation: number[];
  /** Wind speed at 10m, in km/h, per hour. */
  wind_speed_10m: number[];
  /** Sunshine duration within the hour, in seconds (max 3600). */
  sunshine_duration: number[];
}

/** Global arguments: an optional default location, reusable across runs. */
const GlobalArgsSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90).optional()
    .describe(
      "Default latitude. Omit (and omit longitude) to auto-detect via IP geolocation at run time.",
    ),
  longitude: z.coerce.number().min(-180).max(180).optional()
    .describe(
      "Default longitude. Omit (and omit latitude) to auto-detect via IP geolocation at run time.",
    ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Per-run arguments: an optional location override for a one-off check. */
const ForecastArgsSchema = z.object({
  latitude: z.coerce.number().min(-90).max(90).optional()
    .describe("Override the default latitude for this run only."),
  longitude: z.coerce.number().min(-180).max(180).optional()
    .describe("Override the default longitude for this run only."),
});

const LocationSchema = z.object({
  latitude: z.number(),
  longitude: z.number(),
  source: z.enum(["run-args", "global-args", "ip-geolocation"]),
});

const PeriodStatsSchema = z.object({
  avgTemperatureC: z.number(),
  avgHumidityPct: z.number(),
  avgWindSpeedKmh: z.number(),
  maxPrecipitationProbabilityPct: z.number(),
  totalPrecipitationMm: z.number(),
  sunshineFraction: z.number().min(0).max(1),
});

const ScoreComponentsSchema = z.object({
  rain: z.number(),
  sunshine: z.number(),
  wind: z.number(),
  humidity: z.number(),
  temperature: z.number(),
});

const PeriodResultSchema = z.object({
  label: z.string(),
  score: z.number().min(0).max(10),
  verdict: z.string(),
  components: ScoreComponentsSchema,
  stats: PeriodStatsSchema,
});

/** The full washing forecast for a day: morning + afternoon. */
const ForecastSchema = z.object({
  location: LocationSchema,
  generatedAt: z.iso.datetime(),
  headline: z.string(),
  morning: PeriodResultSchema,
  afternoon: PeriodResultSchema,
});

/** Clamp a number between a lower and upper bound. */
function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Score rain risk (0 = will get rained on, 10 = bone dry). Driven by the
 * worse of peak hourly rain probability and total expected rainfall.
 */
export function scoreRain(maxProbabilityPct: number, totalMm: number): number {
  const probabilityPenalty = clamp(maxProbabilityPct / 100, 0, 1);
  const volumePenalty = clamp(totalMm / 2, 0, 1);
  const penalty = Math.max(probabilityPenalty, volumePenalty);
  return clamp(10 * (1 - penalty), 0, 10);
}

/** Score sunshine (0 = overcast the whole window, 10 = unbroken sun). */
export function scoreSunshine(sunshineFraction: number): number {
  return clamp(sunshineFraction * 10, 0, 10);
}

/**
 * Score wind (0-10). A light-to-moderate breeze (10-25 km/h) speeds up
 * evaporation and scores highest; dead-still air dries slowly, and very
 * strong wind risks blowing washing off the line.
 */
export function scoreWind(avgKmh: number): number {
  if (avgKmh <= 3) return 3;
  if (avgKmh < 10) return 3 + (avgKmh - 3) * (7 / 7);
  if (avgKmh <= 25) return 10;
  if (avgKmh <= 45) return 10 - (avgKmh - 25) * (7 / 20);
  return 2;
}

/** Score humidity (0-10). Drier air dries washing faster. */
export function scoreHumidity(avgPct: number): number {
  if (avgPct <= 50) return 10;
  if (avgPct >= 95) return 0;
  return clamp(10 - ((avgPct - 50) / 45) * 10, 0, 10);
}

/** Score temperature (0-10). Warmer air holds more moisture capacity. */
export function scoreTemperature(avgC: number): number {
  if (avgC <= 0) return 0;
  if (avgC >= 18) return 10;
  return clamp((avgC / 18) * 10, 0, 10);
}

/**
 * Combine the five sub-scores into one drying score out of 10, plus a
 * short human verdict. Rain is treated as a multiplicative gate rather
 * than just another weighted term: a near-certain downpour can ruin an
 * otherwise perfect drying day, so it scales the rest of the score down
 * (to as little as 30% of its rain-free value) instead of only shaving a
 * fixed number of points off it.
 */
export function computeDryingScore(
  stats: PeriodStats,
): { score: number; verdict: string; components: ScoreComponents } {
  const rain = scoreRain(
    stats.maxPrecipitationProbabilityPct,
    stats.totalPrecipitationMm,
  );
  const sunshine = scoreSunshine(stats.sunshineFraction);
  const wind = scoreWind(stats.avgWindSpeedKmh);
  const humidity = scoreHumidity(stats.avgHumidityPct);
  const temperature = scoreTemperature(stats.avgTemperatureC);

  const base = sunshine * 0.35 + wind * 0.20 + humidity * 0.20 +
    temperature * 0.25;
  const rainGate = 0.3 + 0.7 * (rain / 10);
  const score = Math.round(clamp(base * rainGate, 0, 10) * 10) / 10;

  const verdict = score >= 8
    ? "Great drying day — hang it all out"
    : score >= 6
    ? "Good — washing should dry fine"
    : score >= 4
    ? "Marginal — dries slowly, keep an eye on the sky"
    : "Don't bother — keep it inside";

  return {
    score,
    verdict,
    components: { rain, sunshine, wind, humidity, temperature },
  };
}

/** Minimal shape this module reads from the Open-Meteo response. */
interface OpenMeteoResponse {
  hourly: OpenMeteoHourly;
}

/** Minimal shape this module reads from the ipapi.co response. */
interface IpGeolocationResponse {
  latitude?: number;
  longitude?: number;
}

const IP_GEOLOCATION_URL = "https://ipapi.co/json/";
const OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast";
const HOURLY_FIELDS = [
  "temperature_2m",
  "relative_humidity_2m",
  "precipitation_probability",
  "precipitation",
  "wind_speed_10m",
  "sunshine_duration",
].join(",");

/**
 * Resolve the latitude/longitude to forecast for: per-run override wins,
 * then the model's global-argument default, then free IP geolocation as a
 * last resort so a location never has to be committed to source control.
 */
export async function resolveLocation(
  runArgs: { latitude?: number; longitude?: number },
  globalArgs: { latitude?: number; longitude?: number },
  fetchImpl: typeof fetch,
): Promise<Location> {
  if (runArgs.latitude !== undefined && runArgs.longitude !== undefined) {
    return {
      latitude: runArgs.latitude,
      longitude: runArgs.longitude,
      source: "run-args",
    };
  }
  if (globalArgs.latitude !== undefined && globalArgs.longitude !== undefined) {
    return {
      latitude: globalArgs.latitude,
      longitude: globalArgs.longitude,
      source: "global-args",
    };
  }

  const response = await fetchImpl(IP_GEOLOCATION_URL);
  if (!response.ok) {
    throw new Error(
      `IP geolocation lookup failed with HTTP ${response.status}. ` +
        "Set latitude/longitude explicitly (global argument, run argument, " +
        "or a vault.get() expression) to avoid relying on IP geolocation.",
    );
  }
  const data = await response.json() as IpGeolocationResponse;
  if (typeof data.latitude !== "number" || typeof data.longitude !== "number") {
    throw new Error(
      "IP geolocation response did not include latitude/longitude. " +
        "Set latitude/longitude explicitly instead.",
    );
  }
  return {
    latitude: data.latitude,
    longitude: data.longitude,
    source: "ip-geolocation",
  };
}

/** Fetch the raw hourly forecast for a location from Open-Meteo. */
export async function fetchHourlyForecast(
  location: { latitude: number; longitude: number },
  fetchImpl: typeof fetch,
): Promise<OpenMeteoHourly> {
  const url = new URL(OPEN_METEO_URL);
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("hourly", HOURLY_FIELDS);
  url.searchParams.set("timezone", "auto");
  url.searchParams.set("forecast_days", "1");

  const response = await fetchImpl(url.toString());
  if (!response.ok) {
    throw new Error(
      `Open-Meteo forecast request failed with HTTP ${response.status}`,
    );
  }
  const data = await response.json() as OpenMeteoResponse;
  if (!data.hourly || !Array.isArray(data.hourly.time)) {
    throw new Error("Open-Meteo response did not include an hourly forecast");
  }
  return data.hourly;
}

/**
 * Aggregate the hourly forecast into stats for a single window, selecting
 * hours whose local hour-of-day falls in [startHour, endHour).
 */
export function aggregatePeriod(
  hourly: OpenMeteoHourly,
  startHour: number,
  endHour: number,
): PeriodStats {
  const indices: number[] = [];
  for (let i = 0; i < hourly.time.length; i++) {
    const hour = new Date(hourly.time[i]).getHours();
    if (hour >= startHour && hour < endHour) indices.push(i);
  }
  if (indices.length === 0) {
    throw new Error(
      `Open-Meteo response had no hourly data in the ${startHour}:00-${endHour}:00 window`,
    );
  }

  const avg = (values: number[]) =>
    indices.reduce((sum, i) => sum + (values[i] ?? 0), 0) / indices.length;
  const max = (values: number[]) =>
    indices.reduce((m, i) => Math.max(m, values[i] ?? 0), -Infinity);
  const sum = (values: number[]) =>
    indices.reduce((total, i) => total + (values[i] ?? 0), 0);

  return {
    avgTemperatureC: avg(hourly.temperature_2m),
    avgHumidityPct: avg(hourly.relative_humidity_2m),
    avgWindSpeedKmh: avg(hourly.wind_speed_10m),
    maxPrecipitationProbabilityPct: max(hourly.precipitation_probability),
    totalPrecipitationMm: sum(hourly.precipitation),
    sunshineFraction: clamp(avg(hourly.sunshine_duration) / 3600, 0, 1),
  };
}

/** Build the scored result for one named window. */
function scorePeriod(
  label: string,
  hourly: OpenMeteoHourly,
  startHour: number,
  endHour: number,
): PeriodResult {
  const stats = aggregatePeriod(hourly, startHour, endHour);
  const { score, verdict, components } = computeDryingScore(stats);
  return { label, score, verdict, components, stats };
}

/** Build the one-line "yes mate / no mate" headline from both periods. */
export function buildHeadline(
  morning: PeriodResult,
  afternoon: PeriodResult,
): string {
  const best = morning.score >= afternoon.score ? morning : afternoon;
  if (best.score >= 6) {
    return `Yes mate \u{1F9FA} — best window is the ${best.label.toLowerCase()} (${best.score}/10)`;
  }
  return `No mate ☔ — best you'll get today is the ${best.label.toLowerCase()} at ${best.score}/10`;
}

/** Model definition for the can-i-hang-my-washing-out drying forecast. */
export const model = {
  type: "@aaronge/can-i-hang-my-washing-out",
  version: "2026.09.22.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.22.2",
      description:
        "Documentation-only update (README scheduling details); no schema change.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    "forecast": {
      description: "Morning/afternoon washing-drying forecast and score",
      schema: ForecastSchema,
      lifetime: "7d",
      garbageCollection: 20,
    },
  },
  methods: {
    forecast: {
      description:
        "Fetch today's forecast and score morning/afternoon washing-drying conditions",
      arguments: ForecastArgsSchema,
      execute: async (
        args: z.infer<typeof ForecastArgsSchema> & { _fetch?: typeof fetch },
        context: {
          globalArgs: GlobalArgs;
          logger: {
            info(msg: string, props?: Record<string, unknown>): void;
          };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const fetchImpl = args._fetch ?? fetch;

        const location = await resolveLocation(
          args,
          context.globalArgs,
          fetchImpl,
        );
        context.logger.info(
          "Forecasting for {latitude},{longitude} (via {source})",
          {
            latitude: location.latitude,
            longitude: location.longitude,
            source: location.source,
          },
        );

        const hourly = await fetchHourlyForecast(location, fetchImpl);
        const morning = scorePeriod("Morning", hourly, 6, 12);
        const afternoon = scorePeriod("Afternoon", hourly, 12, 18);
        const headline = buildHeadline(morning, afternoon);

        context.logger.info("{headline}", { headline });
        context.logger.info("Morning: {score}/10 - {verdict}", {
          score: morning.score,
          verdict: morning.verdict,
        });
        context.logger.info("Afternoon: {score}/10 - {verdict}", {
          score: afternoon.score,
          verdict: afternoon.verdict,
        });

        const handle = await context.writeResource("forecast", "today", {
          location,
          generatedAt: new Date().toISOString(),
          headline,
          morning,
          afternoon,
        });

        return { dataHandles: [handle] };
      },
    },
  },
};
