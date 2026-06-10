import type { FastifyInstance } from "fastify";

export interface AuthSession {
  role: string;
  userId: string;
  email: string;
  name: string;
  vendorId?: string;
}

let fastifyInstance: FastifyInstance | null = null;

export function initAuthTokens(fastify: FastifyInstance): void {
  fastifyInstance = fastify;
}

export function createAuthToken(session: AuthSession): string {
  if (!fastifyInstance) {
    throw new Error("Auth tokens not initialized. Call initAuthTokens first.");
  }
  return fastifyInstance.jwt.sign(session, { expiresIn: "7d" });
}

export function getAuthSession(token: string | undefined): AuthSession | undefined {
  if (!token || !fastifyInstance) return undefined;
  try {
    return fastifyInstance.jwt.verify<AuthSession>(token);
  } catch {
    return undefined;
  }
}

export function revokeAuthToken(_token: string | undefined): void {
  // JWT tokens are stateless; client-side removal is sufficient.
}

export function updateAuthSession(
  token: string | undefined,
  patch: Partial<AuthSession>,
): AuthSession | undefined {
  const current = getAuthSession(token);
  if (!current || !fastifyInstance) return undefined;
  const updated = { ...current, ...patch };
  return updated;
}

export function signUpdatedSession(session: AuthSession): string {
  return createAuthToken(session);
}
