/** Same-origin fetch client (single-server serving works; dev proxy handles /api). */

export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const body = await parseBody(res);
  if (!res.ok) {
    const message =
      (body as { error?: string; message?: string } | null)?.error ??
      (body as { message?: string } | null)?.message ??
      `Request failed (${res.status})`;
    throw new ApiError(res.status, String(message), body);
  }
  return body as T;
}

export const api = {
  get<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'GET' });
  },
  post<T>(path: string, payload?: unknown): Promise<T> {
    return request<T>(path, {
      method: 'POST',
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  },
  put<T>(path: string, payload?: unknown): Promise<T> {
    return request<T>(path, {
      method: 'PUT',
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  },
  del<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'DELETE' });
  },
};
