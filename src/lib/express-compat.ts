import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteHandlerMethod,
} from "fastify";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ExpressHandler = (req: CompatRequest, res: CompatResponse, next?: (err?: unknown) => void) => any;

type ExpressMiddleware = ExpressHandler;

export interface CompatRequest {
  method: string;
  path: string;
  url: string;
  body: unknown;
  params: Record<string, string>;
  query: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
  rawBody?: unknown;
  headersSent: boolean;
}

export interface CompatResponse {
  statusCode: number;
  headersSent: boolean;
  status(code: number): CompatResponse;
  json(body: unknown): CompatResponse;
  send(body?: unknown): CompatResponse;
  sendStatus(code: number): CompatResponse;
  setHeader(name: string, value: string): void;
  getHeader(name: string): string | number | string[] | undefined;
  on(event: "finish", listener: () => void): void;
}

function toCompatRequest(request: FastifyRequest): CompatRequest {
  const query = request.query as Record<string, string | string[] | undefined>;
  const rawParams = request.params as Record<string, string | undefined>;
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(rawParams)) {
    if (value !== undefined) params[key] = value;
  }
  return {
    method: request.method,
    path: request.url.split("?")[0] ?? request.url,
    url: request.url,
    body: request.body,
    params,
    query,
    headers: request.headers as Record<string, string | string[] | undefined>,
    headersSent: false,
  };
}

function toCompatResponse(reply: FastifyReply): CompatResponse {
  let statusCode = 200;
  const finishListeners: Array<() => void> = [];

  const res: CompatResponse = {
    statusCode,
    headersSent: false,
    status(code: number) {
      statusCode = code;
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: string) {
      void reply.header(name, value);
    },
    getHeader(name: string) {
      return reply.getHeader(name);
    },
    json(body: unknown) {
      res.headersSent = true;
      void reply.status(statusCode).send(body);
      finishListeners.forEach((listener) => listener());
      return res;
    },
    send(body?: unknown) {
      res.headersSent = true;
      void reply.status(statusCode).send(body);
      finishListeners.forEach((listener) => listener());
      return res;
    },
    sendStatus(code: number) {
      res.headersSent = true;
      void reply.status(code).send();
      finishListeners.forEach((listener) => listener());
      return res;
    },
    on(event: "finish", listener: () => void) {
      if (event === "finish") {
        finishListeners.push(listener);
      }
    },
  };

  return res;
}

function wrapHandler(handler: ExpressHandler): RouteHandlerMethod {
  return async (request, reply) => {
    const req = toCompatRequest(request);
    const res = toCompatResponse(reply);
    await handler(req, res);
  };
}

function wrapHandlers(handlers: ExpressHandler[]): RouteHandlerMethod {
  return async (request, reply) => {
    const req = toCompatRequest(request);
    const res = toCompatResponse(reply);

    for (const handler of handlers) {
      if (res.headersSent) return;

      await new Promise<void>((resolve, reject) => {
        const next = (err?: unknown) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        };

        Promise.resolve(handler(req, res, next))
          .then(() => {
            if (!res.headersSent) resolve();
          })
          .catch(reject);
      });
    }
  };
}

export interface CompatExpressApp {
  get(path: string, ...handlers: ExpressHandler[]): void;
  post(path: string, ...handlers: ExpressHandler[]): void;
  put(path: string, ...handlers: ExpressHandler[]): void;
  patch(path: string, ...handlers: ExpressHandler[]): void;
  delete(path: string, ...handlers: ExpressHandler[]): void;
  use(pathOrHandler: string | ExpressMiddleware, handler?: ExpressMiddleware): void;
}

export function createExpressCompatApp(fastify: FastifyInstance): CompatExpressApp {
  const app: CompatExpressApp = {
    get(path, ...handlers) {
      fastify.get(path, wrapHandlers(handlers));
    },
    post(path, ...handlers) {
      fastify.post(path, wrapHandlers(handlers));
    },
    put(path, ...handlers) {
      fastify.put(path, wrapHandlers(handlers));
    },
    patch(path, ...handlers) {
      fastify.patch(path, wrapHandlers(handlers));
    },
    delete(path, ...handlers) {
      fastify.delete(path, wrapHandlers(handlers));
    },
    use(pathOrHandler, handler) {
      if (typeof pathOrHandler === "function") {
        fastify.addHook("onRequest", wrapHandler(pathOrHandler));
        return;
      }

      if (handler) {
        fastify.register(async (instance) => {
          instance.addHook("onRequest", async (request, reply) => {
            if (!request.url.startsWith(pathOrHandler)) return;
            const req = toCompatRequest(request);
            const res = toCompatResponse(reply);
            await handler(req, res);
          });
        });
      }
    },
  };

  return app;
}
