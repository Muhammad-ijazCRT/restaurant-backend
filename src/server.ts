import { buildApp } from "./app.js";

const port = Number(process.env.PORT ?? "5000");
const host = process.env.HOST ?? "0.0.0.0";

async function start() {
  const app = await buildApp();

  try {
    await app.listen({ port, host });
    app.log.info(`API server listening on ${host}:${port}`);
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
}

start();
