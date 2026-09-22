/** Shape of every error the API returns (RFC 9457 problem+json). */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  code: string;
  detail?: string;
  requestId: string;
  errors?: { path: string; message: string }[];
}

export class ApiError extends Error {
  constructor(readonly problem: ProblemDetails) {
    super(problem.title);
    this.name = 'ApiError';
  }

  get requestId(): string {
    return this.problem.requestId;
  }
}

/**
 * Single entry point for API calls: sends cookies, parses problem+json into a
 * typed error, and keeps request IDs so a failure in the UI can be traced to a
 * server log line.
 */
export interface ApiFetchOptions extends RequestInit {
  /**
   * Statuses whose body is still a valid payload. The readiness report is the
   * motivating case: 503 means "degraded", and the body says which dependency.
   */
  acceptStatuses?: number[];
}

export async function apiFetch<T>(path: string, init: ApiFetchOptions = {}): Promise<T> {
  const { acceptStatuses = [], ...requestInit } = init;
  // `new Headers` normalises every accepted shape (object, array, Headers);
  // spreading would silently drop a Headers instance.
  const headers = new Headers(requestInit.headers);
  headers.set('Accept', 'application/json');

  const response = await fetch(path, { ...requestInit, credentials: 'same-origin', headers });

  if (!response.ok && !acceptStatuses.includes(response.status)) {
    const problem = (await response.json().catch(() => null)) as ProblemDetails | null;
    throw new ApiError(
      problem ?? {
        type: 'about:blank',
        title: response.statusText || 'Request failed',
        status: response.status,
        code: 'unknown_error',
        requestId: response.headers.get('x-request-id') ?? '',
      },
    );
  }

  return (await response.json()) as T;
}
