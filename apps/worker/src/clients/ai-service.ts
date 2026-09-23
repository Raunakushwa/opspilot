/**
 * Client for the internal AI service.
 *
 * The worker owns database access and passes document text across; the AI
 * service never holds domain credentials, which keeps every read of tenant
 * data behind the API's authorization (see docs/architecture.md).
 */

export interface IndexDocumentInput {
  organizationId: string;
  documentId: string;
  documentVersionId: string;
  title: string;
  content: string;
  documentType: string;
  serviceSlug?: string | undefined;
  tags: string[];
}

export interface IndexDocumentResult {
  chunksIndexed: number;
  tookMs: number;
}

export class AiServiceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AiServiceError';
  }

  /** 5xx and network faults are worth retrying; a 4xx will fail identically. */
  get retryable(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

export interface AiServiceClientOptions {
  baseUrl: string;
  token?: string | undefined;
  timeoutMs?: number;
}

export function createAiServiceClient({
  baseUrl,
  token,
  timeoutMs = 120_000,
}: AiServiceClientOptions) {
  const request = async <T>(path: string, payload: unknown): Promise<T> => {
    const response = await fetch(new URL(path, baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((err: unknown) => {
      throw new AiServiceError(0, err instanceof Error ? err.message : 'network failure');
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new AiServiceError(
        response.status,
        `ai-service ${String(response.status)}: ${detail.slice(0, 300)}`,
      );
    }
    return (await response.json()) as T;
  };

  return {
    indexDocumentVersion: async (input: IndexDocumentInput): Promise<IndexDocumentResult> => {
      const result = await request<{ chunks_indexed: number; took_ms: number }>(
        '/internal/index/document-versions',
        {
          organization_id: input.organizationId,
          document_id: input.documentId,
          document_version_id: input.documentVersionId,
          title: input.title,
          content: input.content,
          document_type: input.documentType,
          service_slug: input.serviceSlug ?? null,
          tags: input.tags,
        },
      );
      return { chunksIndexed: result.chunks_indexed, tookMs: result.took_ms };
    },
  };
}

export type AiServiceClient = ReturnType<typeof createAiServiceClient>;
