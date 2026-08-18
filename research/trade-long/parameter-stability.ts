export interface ParameterCandidate<T> {
  score: number;
  values: Record<string, string | number | boolean>;
  payload: T;
}

export interface StableSelection<T> extends ParameterCandidate<T> {
  stabilityScore: number;
  neighborhoodSize: number;
}

export function selectStableCandidate<T>(candidates: ParameterCandidate<T>[]): StableSelection<T> {
  if (candidates.length === 0) throw new Error("cannot select from an empty parameter search");
  const domains = parameterDomains(candidates);
  const assessed = candidates.map((candidate) => {
    const neighbors = candidates.filter((other) => areImmediateNeighbors(candidate.values, other.values, domains));
    return {
      ...candidate,
      stabilityScore: median(neighbors.map((neighbor) => neighbor.score)),
      neighborhoodSize: neighbors.length
    };
  });
  return assessed.sort((a, b) =>
    b.neighborhoodSize - a.neighborhoodSize ||
    b.stabilityScore - a.stabilityScore ||
    b.score - a.score ||
    JSON.stringify(a.values).localeCompare(JSON.stringify(b.values))
  )[0];
}

function areImmediateNeighbors(
  left: Record<string, string | number | boolean>,
  right: Record<string, string | number | boolean>,
  domains: Map<string, Array<string | number | boolean>>
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  const different = [...keys].filter((key) => left[key] !== right[key]);
  if (different.length === 0) return true;
  if (different.length > 1) return false;
  const key = different[0];
  const domain = domains.get(key) ?? [];
  return Math.abs(domain.indexOf(left[key]) - domain.indexOf(right[key])) === 1;
}

function parameterDomains<T>(candidates: ParameterCandidate<T>[]): Map<string, Array<string | number | boolean>> {
  const domains = new Map<string, Array<string | number | boolean>>();
  for (const candidate of candidates) {
    for (const [key, value] of Object.entries(candidate.values)) {
      const values = domains.get(key) ?? [];
      if (!values.includes(value)) values.push(value);
      domains.set(key, values);
    }
  }
  for (const values of domains.values()) {
    values.sort((a, b) => typeof a === "number" && typeof b === "number"
      ? a - b
      : String(a).localeCompare(String(b)));
  }
  return domains;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
