import { z } from 'zod';
import { CATEGORIES } from './constants.js';

export const SORTS = ['relevance', 'downloads', 'score', 'updated', 'created', 'title'] as const;
export type Sort = (typeof SORTS)[number];

/**
 * The search/filter object. The UI builds it from form controls; in later phases an
 * LLM produces it from natural language. Either way it is validated with this schema
 * and turned into parameterized SQL by core/query.ts.
 */
export const ModFilterSchema = z.object({
  /** Full-text query over name, title, summary and description. */
  q: z.string().trim().max(200).optional(),
  categories: z.array(z.enum(CATEGORIES)).max(CATEGORIES.length).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  /** Whether a mod must have all selected tags or any of them. */
  tagMode: z.enum(['all', 'any']).default('all'),
  owner: z.string().trim().max(100).optional(),
  /** Major Factorio version, e.g. "2.0". */
  factorioVersion: z
    .string()
    .regex(/^\d+\.\d+$/)
    .optional(),
  /** "any": some release supports the version; "latest": the latest release targets it. */
  versionMatch: z.enum(['any', 'latest']).default('any'),
  /** required = needs Space Age, excluded = works without it, incompatible = refuses to load with it. */
  spaceAge: z.enum(['any', 'required', 'excluded', 'incompatible']).default('any'),
  minDownloads: z.number().int().min(0).optional(),
  /** ISO date (YYYY-MM-DD): latest release on or after this day. */
  updatedSince: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  hideDeprecated: z.boolean().default(true),
  includeRemoved: z.boolean().default(false),
  sort: z.enum(SORTS).default('relevance'),
  order: z.enum(['asc', 'desc']).optional(),
  page: z.number().int().min(1).max(10_000).default(1),
  pageSize: z.number().int().min(1).max(100).default(30),
});

export type ModFilter = z.infer<typeof ModFilterSchema>;
export type ModFilterInput = z.input<typeof ModFilterSchema>;

const ARRAY_KEYS = { categories: 'category', tags: 'tag' } as const;
const NUMBER_KEYS = ['minDownloads', 'page', 'pageSize'] as const;
const BOOLEAN_KEYS = ['hideDeprecated', 'includeRemoved'] as const;

/** Reads a filter from URL query params (`?q=…&category=a&category=b&tag=…`). Unvalidated. */
export function filterFromSearchParams(params: URLSearchParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, param] of Object.entries(ARRAY_KEYS)) {
    const values = params
      .getAll(param)
      .flatMap((v) => v.split(','))
      .filter(Boolean);
    if (values.length) out[key] = values;
  }
  for (const key of NUMBER_KEYS) {
    const v = params.get(key);
    if (v !== null && v !== '') out[key] = Number(v);
  }
  for (const key of BOOLEAN_KEYS) {
    const v = params.get(key);
    if (v !== null) out[key] = v === '1' || v === 'true';
  }
  for (const key of [
    'q',
    'tagMode',
    'owner',
    'factorioVersion',
    'versionMatch',
    'spaceAge',
    'updatedSince',
    'sort',
    'order',
  ]) {
    const v = params.get(key);
    if (v) out[key] = v;
  }
  return out;
}

/** Inverse of filterFromSearchParams; omits values equal to the defaults. */
export function filterToSearchParams(filter: ModFilterInput): URLSearchParams {
  const params = new URLSearchParams();
  const defaults = ModFilterSchema.parse({});
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === '' || value === defaults[key as keyof ModFilter]) continue;
    if (key in ARRAY_KEYS) {
      for (const v of value as string[])
        params.append(ARRAY_KEYS[key as keyof typeof ARRAY_KEYS], v);
    } else if (typeof value === 'boolean') {
      params.set(key, value ? '1' : '0');
    } else {
      params.set(key, String(value));
    }
  }
  return params;
}
