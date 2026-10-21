import type { z } from 'zod';
import { apiFetch, type FetchOptions } from './api-client';

/** Raised when the server answered successfully but broke its published shape. */
export class ApiContractError extends Error {
  readonly endpoint: string;
  readonly issues: z.ZodIssue[];

  constructor(endpoint: string, issues: z.ZodIssue[]) {
    super(`Invalid API response for ${endpoint}`);
    this.name = 'ApiContractError';
    this.endpoint = endpoint;
    this.issues = issues;
  }
}

/**
 * Runtime boundary for high-value API reads. Static TypeScript types disappear
 * in the browser; this parser makes malformed production responses fail as a
 * contract error instead of silently becoming false KPIs or empty tables.
 */
export async function apiFetchValidated<TSchema extends z.ZodType>(
  endpoint: string,
  schema: TSchema,
  options: FetchOptions = {},
): Promise<z.output<TSchema>> {
  const payload: unknown = await apiFetch<unknown>(endpoint, options);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new ApiContractError(endpoint, parsed.error.issues);
  return parsed.data;
}
