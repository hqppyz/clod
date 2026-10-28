// Fills in {{NAME}}s; unknown ones stay as written. In JSON, keys are filled in too.
export namespace Template {
  export function fill<T>(value: T, values: Readonly<Record<string, string>>): T;
  export function fill(value: unknown, values: Readonly<Record<string, string>>): unknown {
    if (typeof value === 'string') return value.replace(/\{\{(\w+)\}\}/g, (match, name: string) => values[name] ?? match);
    if (Array.isArray(value)) return value.map((v) => fill(v, values));
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [fill(k, values), fill(v, values)]));
  }
}
