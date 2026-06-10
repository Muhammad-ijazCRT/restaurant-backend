import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import jwt from "@fastify/jwt";
import fastifyStatic from "@fastify/static";
import path from "path";
import { fileURLToPath } from "url";
import { requestContext } from "./lib/async-context.js";
import { getAuthSession, initAuthTokens } from "./lib/auth/tokens.js";
import { createExpressCompatApp } from "./lib/express-compat.js";
import { registerRoutes } from "./routes/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "development"
          ? { target: "pino-pretty", options: { colorize: true } }
          : undefined,
    },
    bodyLimit: 15 * 1024 * 1024,
  });

  const jwtSecret =
    process.env.JWT_SECRET ??
    (process.env.NODE_ENV === "development"
      ? "dev-only-jwt-secret-do-not-use-in-production"
      : undefined);
  if (!jwtSecret) {
    throw new Error("JWT_SECRET is required in environment variables.");
  }
  if (!process.env.JWT_SECRET && process.env.NODE_ENV === "development") {
    app.log.warn("JWT_SECRET not set — using insecure development default.");
  }

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  });

  const configuredOrigins = process.env.CORS_ORIGIN
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  await app.register(cors, {
    origin: configuredOrigins?.length
      ? (origin, callback) => {
          if (!origin || configuredOrigins.includes(origin)) {
            callback(null, true);
            return;
          }
          callback(new Error("CORS origin not allowed"), false);
        }
      : true,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Accept"],
  });

  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_MAX ?? "200"),
    timeWindow: process.env.RATE_LIMIT_WINDOW ?? "1 minute",
  });

  await app.register(jwt, { secret: jwtSecret });
  initAuthTokens(app);

  await app.register(fastifyStatic, {
    root: path.join(__dirname, "..", "public", "uploads"),
    prefix: "/uploads/",
    decorateReply: false,
  });

  app.addHook("onRequest", async (request) => {
    const authHeader = request.headers.authorization;
    const token = authHeader?.split(" ")[1];
    const session = getAuthSession(token);

    // enterWith keeps auth context alive for the full async request (run+resolve only covered the hook).
    if (session) {
      requestContext.enterWith({
        userId: session.userId,
        userName: session.name,
        userRole: session.role,
      });
    } else {
      requestContext.enterWith({
        userId: "anonymous",
        userName: "Anonymous",
        userRole: "guest",
      });
    }
  });

  app.addHook("onResponse", async (request, reply) => {
    if (request.url.startsWith("/api")) {
      app.log.info(
        { method: request.method, url: request.url, statusCode: reply.statusCode },
        "API request",
      );
    }
  });

  const compatApp = createExpressCompatApp(app);
  await registerRoutes(app.server, compatApp);

  app.setErrorHandler((error, _request, reply) => {
    const err = error as { statusCode?: number; status?: number; message?: string };
    const statusCode =
      typeof err.statusCode === "number"
        ? err.statusCode
        : typeof err.status === "number"
          ? err.status
          : 500;

    const message = err.message || "Internal Server Error";
    app.log.error(error);
    return reply.status(statusCode).send({ message });
  });

  return app;
}
