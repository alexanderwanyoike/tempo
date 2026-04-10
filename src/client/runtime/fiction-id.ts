export type EnvironmentFictionId = 1 | 2 | 3;

export function clampFictionId(value: number | null | undefined): EnvironmentFictionId {
  if (value === 2 || value === 3) return value;
  return 1;
}
