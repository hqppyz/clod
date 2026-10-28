import { Config } from '../../config';

export function snowflake(v: unknown, where: string): string {
  if (v === undefined || v === null) Config.fail(where, 'required');
  if (typeof v === 'number') {
    // YAML parses unquoted IDs as floats, which can't hold 19-digit snowflakes
    if (!Number.isSafeInteger(v)) Config.fail(where, 'ID too large for an unquoted number, wrap it in quotes');
    v = String(v);
  }
  if (typeof v !== 'string' || !/^\d+$/.test(v)) Config.fail(where, 'expected a Discord ID');
  return v;
}

// Optional; a single ID or a list
export function snowflakes(v: unknown, where: string): readonly string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return [snowflake(v, where)];
  return v.map((id, i) => snowflake(id, `${where}[${i}]`));
}
