export interface CourseUser {
  username: string;
  role: 'admin' | 'student';
  isPrimary: boolean;
}

export function roleLabel(user: CourseUser) {
  if (user.isPrimary) return 'Primary administrator';
  return user.role === 'admin' ? 'Administrator' : 'Student';
}
export interface Session {
  user: CourseUser | null;
  setupRequired: boolean;
}
export interface SetInfo {
  id: string;
  title: string;
  revision: number;
  questionsVisible: boolean;
  solutionsVisible: boolean;
}

export class CourseError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}

export async function courseApi<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api/' + path, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...options,
    headers: {
      ...options.headers,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new CourseError(
      'The classroom service is unavailable. Please try again shortly.',
      response.status,
    );
  }
  const payload = await response.json();
  if (!response.ok)
    throw new CourseError(
      payload.error || 'Request failed. Please try again.',
      response.status,
      typeof payload.code === 'string' ? payload.code : undefined,
    );
  return payload as T;
}

export function explain(error: unknown) {
  return error instanceof Error ? error.message : 'The request could not be completed.';
}
