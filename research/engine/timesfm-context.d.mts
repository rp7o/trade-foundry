export interface TimesfmForecast {
  asOf: string;
  horizonDays: 10;
  predictedReturnPct: number;
}
export type TimesfmForecasts = Record<string, Record<string, TimesfmForecast>>;
export function timesfmAsOf(forecasts: TimesfmForecasts | undefined, symbol: string, date: string): TimesfmForecast | undefined;
