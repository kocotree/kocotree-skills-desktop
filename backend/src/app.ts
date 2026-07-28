import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { config } from "./config";
import { authRoutes } from "./routes/auth.route";
import { catalogRoutes } from "./routes/catalog.route";
import { installationRoutes } from "./routes/installation.route";
import { mySkillsRoutes } from "./routes/my-skills.route";
import { publishingRoutes } from "./routes/publishing.route";

export function buildApp() {
  const app = Fastify({
    logger: true,
  });

  void app.register(cors, {
    origin: config.frontendOrigins,
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
  });
  void app.register(multipart, {
    throwFileSizeLimit: true,
    limits: {
      files: 1,
      fileSize: config.skillUploadMaxMb * 1024 * 1024,
      fields: 30,
      parts: 32,
    },
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
  void app.register(mySkillsRoutes, {
    prefix: "/api",
  });
  void app.register(publishingRoutes, {
    prefix: "/api",
  });
  app.get("/health", async () => ({
    ok: true,
  }));

  return app;
}
