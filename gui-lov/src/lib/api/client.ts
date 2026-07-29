/**
 * API Client for Satyanaash backend
 */

const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001';
const API_VERSION = 'v1';

export const API_URL = `${API_BASE_URL}/api/${API_VERSION}`;

/**
 * An error body from the API.
 *
 * The server calls the human-readable part **`error`** (see `ErrorResponse` in
 * `api/src/error.rs`), not `message`. This said `message` for a long time, so every
 * explanation the server sent — "Version conflict: expected 1, got 2", "Flow has no
 * START node" — was read as undefined and reported to the author as "Unknown error".
 * `message` is kept as a fallback only for a body that didn't come from our API, like
 * a JSON error page from a proxy in front of it.
 */
export interface ApiError {
  code: string;
  error?: string;
  message?: string;
  details?: unknown;
}

export class ApiClientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'ApiClientError';
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let error: ApiError;
    try {
      error = await response.json();
    } catch {
      error = {
        code: 'UNKNOWN_ERROR',
        error: response.statusText || 'Unknown error occurred',
      };
    }
    throw new ApiClientError(
      response.status,
      error.code || 'UNKNOWN_ERROR',
      error.error || error.message || 'Unknown error',
      error.details
    );
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export const apiClient = {
  async get<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${API_URL}${endpoint}`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    return handleResponse<T>(response);
  },

  async post<T>(endpoint: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return handleResponse<T>(response);
  },

  async patch<T>(endpoint: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API_URL}${endpoint}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return handleResponse<T>(response);
  },

  async put<T>(endpoint: string, body?: unknown): Promise<T> {
    const response = await fetch(`${API_URL}${endpoint}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return handleResponse<T>(response);
  },

  async delete(endpoint: string): Promise<void> {
    const response = await fetch(`${API_URL}${endpoint}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    return handleResponse<void>(response);
  },
};
