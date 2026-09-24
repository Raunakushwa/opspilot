/**
 * Thin client for the OpsPilot API.
 *
 * The MCP server holds no privileges of its own: it signs in as a real user
 * and every call is subject to that user's role and tenant. An agent using
 * this server can therefore never see more than the person who configured it.
 */

export class OpsPilotError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpsPilotError';
  }
}

export interface ClientOptions {
  baseUrl: string;
  email: string;
  password: string;
  organizationSlug?: string | undefined;
}

interface Problem {
  title?: string;
  detail?: string;
}

export function createOpsPilotClient(options: ClientOptions) {
  let cookie: string | null = null;
  let organizationId: string | null = null;

  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    // `new Headers` normalises every accepted shape; spreading would drop a
    // Headers instance silently.
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    if (cookie) headers.set('cookie', cookie);

    const response = await fetch(new URL(path, options.baseUrl), { ...init, headers });

    if (response.status === 401 && cookie) {
      // The session expired mid-conversation; sign in again and retry once.
      cookie = null;
      await login();
      return request<T>(path, init);
    }
    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as Problem | null;
      throw new OpsPilotError(
        response.status,
        problem?.title ?? `OpsPilot returned ${String(response.status)}`,
      );
    }
    return (await response.json()) as T;
  };

  const login = async (): Promise<void> => {
    const response = await fetch(new URL('/api/auth/login', options.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: options.email, password: options.password }),
    });
    if (!response.ok) {
      throw new OpsPilotError(response.status, 'Could not sign in to OpsPilot');
    }
    const setCookie = response.headers.getSetCookie().at(0);
    if (!setCookie) throw new OpsPilotError(500, 'OpsPilot did not return a session');
    cookie = setCookie.split(';')[0] ?? null;
  };

  const resolveOrganization = async (): Promise<string> => {
    if (organizationId) return organizationId;
    if (!cookie) await login();

    const organizations = await request<{
      data: { id: string; slug: string; name: string }[];
    }>('/api/orgs');

    const wanted = options.organizationSlug
      ? organizations.data.find((org) => org.slug === options.organizationSlug)
      : organizations.data[0];
    if (!wanted) {
      throw new OpsPilotError(404, 'No matching organization for this account');
    }
    organizationId = wanted.id;
    return organizationId;
  };

  return {
    resolveOrganization,
    get: async <T>(path: string): Promise<T> => {
      const orgId = await resolveOrganization();
      return request<T>(`/api/orgs/${orgId}${path}`);
    },
  };
}

export type OpsPilotClient = ReturnType<typeof createOpsPilotClient>;
