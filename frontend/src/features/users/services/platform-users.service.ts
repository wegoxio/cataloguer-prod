import { apiFetch } from '../../../lib/api-client';
import type { AccessChangeBody } from '../platform-access';

/**
 * The platform directory's two calls, in one place so no screen carries a raw
 * path or an untyped body (#275).
 */

export interface PlatformUserRow {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  role: string;
  organization: { id: string; name: string } | null;
  store: { id: string; name: string } | null;
  pendingInvite: boolean;
  deactivatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformUserPage {
  items: PlatformUserRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface PlatformUserFilters {
  search?: string;
  organizationId?: string;
  storeId?: string;
  role?: string;
  status?: 'active' | 'deactivated' | 'all';
  /**
   * `none` = NO PENDING INVITATION. Deliberately not `accepted`: a password can
   * be set by a reset or by an administrator, so the absence of a pending
   * invitation is not evidence that anyone accepted anything. Mirrors
   * `PLATFORM_INVITATION_STATES` in the backend DTO.
   */
  invitation?: 'pending' | 'none' | 'all';
}

/** The page size the screen asks for. The server refuses anything above 100. */
export const PAGE_SIZE = 25;

/** Id and name — all a picker is given, and all it needs. */
export interface TenantRef {
  id: string;
  name: string;
}

/**
 * A BOUNDED slice of companies or branches, and how big the whole set is.
 *
 * `total` is the count of everything matching, not the count returned, so a
 * selector can say "20 of 137" rather than presenting 20 as the complete world.
 */
export interface TenantLookupPage {
  items: TenantRef[];
  total: number;
  limit: number;
  truncated: boolean;
}

export type OrganizationRef = TenantRef;
export type StoreRef = TenantRef;

/** The page size a selector asks for. The server refuses anything above 50. */
export const LOOKUP_PAGE_SIZE = 20;

/**
 * The lookup answer, or a thrown error — never a quietly empty list.
 *
 * A response the client cannot read means the client does not know what exists.
 * Turning that into `[]` would produce a selector that looks loaded, offers
 * nothing, and gives the operator no reason to doubt it.
 */
function asLookupPage(data: unknown, limit: number): TenantLookupPage {
  const page = data as Partial<TenantLookupPage> | undefined;
  if (!page || !Array.isArray(page.items) || typeof page.total !== 'number') {
    throw new Error('The list could not be read');
  }
  return {
    items: page.items as TenantRef[],
    total: page.total,
    limit: typeof page.limit === 'number' ? page.limit : limit,
    truncated: page.truncated === true,
  };
}

export const platformUsersService = {
  /**
   * COMPANIES FOR THE FILTER — a bounded, searchable slice.
   *
   * Never `GET /organizations`, which answers with every client company on the
   * platform: nothing in the product caps how many exist, so that call's cost
   * grows with the customer base and a selector built on it gets slower for
   * every client we sign. This asks for at most `limit`, says how many match,
   * and expects the operator to narrow rather than scroll.
   *
   * A MALFORMED ANSWER IS A FAILURE, not an empty list of companies. Throwing
   * here is what lets the screen say "we could not load the companies" instead
   * of "there are none" — the second sentence is a lie that reads as a fact.
   */
  async organizationLookup(token: string, search = '', limit = LOOKUP_PAGE_SIZE): Promise<TenantLookupPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (search.trim()) params.set('search', search.trim());
    const response = await apiFetch(`/organizations/lookup?${params.toString()}`, { method: 'GET', token });
    return asLookupPage(response?.data, limit);
  },

  /**
   * One company's branches, bounded the same way — because the PLAN does not
   * bound them: `CORPORATIVO` sets `maxWebsites` to null and the capacity guard
   * returns early on null, so a corporate client's branch count has no enforced
   * ceiling.
   *
   * Addressed BY PATH rather than by a managed-tenant header, so reading one
   * company's branches never changes what this session is scoped to.
   */
  async storeLookup(
    token: string,
    organizationId: string,
    search = '',
    limit = LOOKUP_PAGE_SIZE,
  ): Promise<TenantLookupPage> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (search.trim()) params.set('search', search.trim());
    const response = await apiFetch(`/organizations/${organizationId}/stores/lookup?${params.toString()}`, {
      method: 'GET',
      token,
    });
    return asLookupPage(response?.data, limit);
  },

  /**
   * ONE PAGE, from the server.
   *
   * The whole population is never requested and never held in the browser: the
   * page number and the filters go to the endpoint, and what comes back is what
   * is rendered. An "empty" filter is OMITTED rather than sent blank, because
   * the endpoint refuses unknown or malformed parameters and a blank one would
   * be neither honest nor useful.
   */
  async list(token: string, page: number, filters: PlatformUserFilters, limit = PAGE_SIZE): Promise<PlatformUserPage> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (filters.search?.trim()) params.set('search', filters.search.trim());
    if (filters.organizationId) params.set('organizationId', filters.organizationId);
    if (filters.storeId) params.set('storeId', filters.storeId);
    if (filters.role) params.set('role', filters.role);
    if (filters.status && filters.status !== 'active') params.set('status', filters.status);
    if (filters.invitation && filters.invitation !== 'all') params.set('invitation', filters.invitation);

    const response = await apiFetch(`/users/platform?${params.toString()}`, { method: 'GET', token });
    return response?.data as PlatformUserPage;
  },

  /**
   * The deployed atomic access change (#274). Role and branch move together, in
   * one transaction, under the organization's lock; the response is the
   * COMMITTED row, which is what the screen then shows.
   */
  async changeAccess(
    token: string,
    organizationId: string,
    userId: string,
    body: AccessChangeBody,
  ): Promise<PlatformUserRow> {
    const response = await apiFetch(`/organizations/${organizationId}/users/${userId}/access`, {
      method: 'PATCH',
      token,
      body: JSON.stringify(body),
    });
    return response?.data as PlatformUserRow;
  },
};
