import { buildApp } from "./app";
import { config } from "./config";
import { prisma } from "./db";

const app = buildApp();
let shuttingDown = false;

async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await app.close();
  } finally {
    await prisma.$disconnect();
    process.exitCode = exitCode;
  }
}

function requestShutdown(): void {
  void shutdown(0).catch((error) => {
    app.log.error(error);
    process.exitCode = 1;
  });
}

process.once("SIGINT", requestShutdown);
process.once("SIGTERM", requestShutdown);

try {
  await app.listen({
    host: config.host,
    port: config.port,
  });
} catch (error) {
  app.log.error(error);
  await shutdown(1);
}
