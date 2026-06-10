import type { CompatExpressApp } from "../../lib/express-compat.js";

export function registerHealthRoutes(app: CompatExpressApp) {
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, service: "restaurant-portal-api" });
  });
}
