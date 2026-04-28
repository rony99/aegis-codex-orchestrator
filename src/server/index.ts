import express, { type Express, type Request, type Response } from "express";
import type { Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiRouter } from "./routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PORT = 3001;
const PORT_FALLBACK_LIMIT = 20;

export function createServer(): Express {
  const app = express();

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  app.use(
    "/static",
    express.static(path.resolve(__dirname, "..", "..", "web"))
  );

  app.use("/api", apiRouter);

  app.get("/", (_req: Request, res: Response) => {
    res.sendFile(path.resolve(__dirname, "..", "..", "web", "index.html"));
  });

  app.get("/task/:id", (_req: Request, res: Response) => {
    res.sendFile(path.resolve(__dirname, "..", "..", "web", "task.html"));
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      error: "Not Found",
      message: "The requested resource was not found",
    });
  });

  app.use((error: Error, _req: Request, res: Response) => {
    console.error("Server error:", error);
    res.status(500).json({
      error: "Internal Server Error",
      message: error.message,
    });
  });

  return app;
}

export async function startServer(port: number = DEFAULT_PORT): Promise<Server> {
  const app = createServer();
  const requestedPort = Number(process.env.CODEX_GTD_SERVER_PORT) || port;
  const { server, actualPort } = await listenWithFallback(app, requestedPort);

  printServerBanner(actualPort, requestedPort);
  return server;
}

async function listenWithFallback(
  app: Express,
  requestedPort: number
): Promise<{ server: Server; actualPort: number }> {
  for (let attempt = 0; attempt <= PORT_FALLBACK_LIMIT; attempt += 1) {
    const actualPort = requestedPort + attempt;
    try {
      const server = await listenOnPort(app, actualPort);
      return { server, actualPort };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") {
        throw error;
      }
    }
  }

  throw new Error(
    `Unable to start web server: ports ${requestedPort}-${requestedPort + PORT_FALLBACK_LIMIT} are already in use`
  );
}

function listenOnPort(app: Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port);

    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function printServerBanner(actualPort: number, requestedPort: number): void {
  const portNote = actualPort === requestedPort
    ? ""
    : `║  Note: requested port ${requestedPort} was busy; using ${actualPort}.        ║\n`;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║         Aegis Codex Orchestrator Web Server                    ║
╠══════════════════════════════════════════════════════════════╣
║                                                                  ║
║  Web UI:   http://localhost:${actualPort}                         ║
║  API:      http://localhost:${actualPort}/api                     ║
${portNote}║                                                                  ║
║  Endpoints:                                                      ║
║  - POST   /api/tasks          - Create and start a new task     ║
║  - GET    /api/tasks          - List all tasks                   ║
║  - GET    /api/tasks/:id      - Get task details and progress   ║
║  - POST   /api/tasks/:id/reply - Reply and continue ask_user    ║
║  - POST   /api/tasks/:id/stop - Stop a running task             ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════╝
    `);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void startServer().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
