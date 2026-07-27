import cors from "@fastify/cors";
import Fastify from "fastify";
import { config } from "./config";
import { authRoutes } from "./routes/auth.route";
import { catalogRoutes } from "./routes/catalog.route";
import { installationRoutes } from "./routes/installation.route";

export function buildApp() {
  const app = Fastify({
    logger: true,
  });

  void app.register(cors, {
    origin: config.frontendOrigins,
    methods: ["GET", "POST", "OPTIONS"],
  });
  void app.register(authRoutes, {
    prefix: "/api",
  });
  void app.register(catalogRoutes, {
    prefix: "/api",
  });
  void app.register(installationRoutes, {
    prefix: "/api",
  });
  app.get("/health", async () => ({
    ok: true,
  }));

  return app;
}
