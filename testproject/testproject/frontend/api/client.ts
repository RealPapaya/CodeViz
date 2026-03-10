// frontend/api/client.ts — Base HTTP client with auth and retry
import axios, { AxiosInstance, AxiosRequestConfig, AxiosError } from 'axios';
import { tokenStore } from '../store/tokenStore';
import { sleep, exponentialBackoff } from '../utils/async';
import type { ApiError } from '../types';

const BASE_URL = process.env.REACT_APP_API_URL ?? 'http://localhost:8080';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 300;

class ApiClient {
  private http: AxiosInstance;
  private pendingRequests = new Map<string, Promise<any>>();

  constructor(baseURL: string) {
    this.http = axios.create({
      baseURL,
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' },
    });

    this._setupRequestInterceptor();
    this._setupResponseInterceptor();
  }

  private _setupRequestInterceptor() {
    this.http.interceptors.request.use(cfg => {
      const token = tokenStore.getToken();
      if (token) {
        cfg.headers.Authorization = `Bearer ${token}`;
      }
      cfg.headers['X-Request-ID'] = generateRequestId();
      return cfg;
    });
  }

  private _setupResponseInterceptor() {
    this.http.interceptors.response.use(
      res => res,
      async (err: AxiosError) => {
        if (err.response?.status === 401) {
          tokenStore.clearToken();
          window.dispatchEvent(new CustomEvent('auth:logout'));
        }
        return Promise.reject(normalizeError(err));
      }
    );
  }

  async get<T>(path: string, params?: Record<string, any>): Promise<T> {
    return this._withRetry(() => this.http.get<T>(path, { params }).then(r => r.data));
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this._withRetry(() => this.http.post<T>(path, body).then(r => r.data));
  }

  async put<T>(path: string, body?: unknown): Promise<T> {
    return this._withRetry(() => this.http.put<T>(path, body).then(r => r.data));
  }

  async patch<T>(path: string, body?: unknown): Promise<T> {
    return this.http.patch<T>(path, body).then(r => r.data);
  }

  async delete<T>(path: string): Promise<T> {
    return this.http.delete<T>(path).then(r => r.data);
  }

  // Deduplicates concurrent identical GET requests
  async dedupGet<T>(key: string, path: string, params?: Record<string, any>): Promise<T> {
    if (this.pendingRequests.has(key)) {
      return this.pendingRequests.get(key)!;
    }
    const req = this.get<T>(path, params).finally(() => this.pendingRequests.delete(key));
    this.pendingRequests.set(key, req);
    return req;
  }

  private async _withRetry<T>(fn: () => Promise<T>, retries = MAX_RETRIES): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        const apiErr = err as ApiError;
        const isRetryable = !apiErr.status || apiErr.status >= 500;
        if (!isRetryable || attempt === retries) throw err;
        const delay = exponentialBackoff(attempt, RETRY_DELAY_MS);
        await sleep(delay);
      }
    }
    throw new Error('unreachable');
  }
}

function generateRequestId(): string {
  return Math.random().toString(36).slice(2, 11);
}

function normalizeError(err: AxiosError): ApiError {
  return {
    message: (err.response?.data as any)?.error ?? err.message,
    status: err.response?.status,
    code: (err.response?.data as any)?.code,
  };
}

export const apiClient = new ApiClient(BASE_URL);
export default apiClient;
