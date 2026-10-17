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

function notifyUnauthorized(path: string, status: number): void {
  // Expired/invalid sessions surface as 401 from authenticated endpoints.
  // Broadcast so AuthContext can sign out and RequireAuth redirects to
  // sign-in. Sign-in attempts themselves 401 on bad credentials — never
  // broadcast those, the login form already shows the error.
  try {
    if (!shouldBroadcastUnauthorized(path, status)) return;
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('gui:unauthorized', { detail: { path } }));
    }
  } catch {
    /* best effort — the ApiError below still reaches the caller */
  }
}

/** Pure check for the 401 broadcast above (unit-tested). */
export function shouldBroadcastUnauthorized(path: string, status: number): boolean {
  if (status !== 401) return false;
  if (path === '/api/login' || path === '/api/register') return false;
  return true;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
  const body = await parseBody(res);
  if (!res.ok) {
    if (res.status === 401) notifyUnauthorized(path, res.status);
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
