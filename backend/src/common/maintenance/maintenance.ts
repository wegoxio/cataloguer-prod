/**
 * P5-X1 — deployment-level maintenance mode.
 *
 * This is the OUTER half of a defence-in-depth pair. It protects the traffic
 * transition: while the new revision is being verified and while the cutover
 * job is working, the HTTP surface accepts reads and refuses mutations, so a
 * customer request cannot race the epoch even before any organization has been
 * frozen. The INNER half is the per-organization freeze enforced in
 * `InventoryPostingService`, which protects the inventory domain itself and
 * keeps protecting it no matter which caller arrives.
 *
 * Neither replaces the other. Maintenance mode is broad but coarse — it knows
 * nothing about organizations and would happily let a non-inventory mutation
 * through if it were disabled early. The freeze is narrow but exact. The
 * campaign requires both.
 */

/** The literal that turns maintenance ON. Nothing else does. */
export const MAINTENANCE_ON = 'on';

/** The environment variable the deployed revision carries. */
export const MAINTENANCE_ENV = 'MAINTENANCE_MODE';

/**
 * Exactly the HTTP methods that are refused while maintenance is on.
 *
 * Exported because the structural census asserts against this set rather than
 * against a list retyped in a test — a method added here without the census
 * being reconsidered would otherwise pass silently.
 */
export const REFUSED_METHODS: readonly string[] = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Paths that stay reachable in every mode, so an orchestrator can still see the revision. */
export const ALWAYS_ALLOWED_PATHS: readonly string[] = ['/api/v1/health'] as const;

/**
 * Resolves the mode, matching the exact literal and nothing else.
 *
 * The same exact-literal shape the website-builder status uses. A typo cannot
 * silently read as "off" here, because `env.validation.ts` constrains
 * MAINTENANCE_MODE to `on` or `off` and the application refuses to boot on
 * anything else — so the only two states that can ever reach this function are
 * the two that were meant.
 */
export const isMaintenanceMode = (env: NodeJS.ProcessEnv): boolean => env[MAINTENANCE_ENV] === MAINTENANCE_ON;

/** The stable body every refused request receives. Machine-readable, and identical every time. */
export const MAINTENANCE_RESPONSE = {
  status: 'maintenance',
  message: 'This deployment is in maintenance mode and is not accepting changes.',
} as const;

/** True when a request must be refused. Path is compared before the query string. */
export function refusesRequest(env: NodeJS.ProcessEnv, method: string, path: string): boolean {
  if (!isMaintenanceMode(env)) return false;
  const bare = path.split('?')[0];
  if (ALWAYS_ALLOWED_PATHS.includes(bare)) return false;
  return REFUSED_METHODS.includes(method.toUpperCase());
}
