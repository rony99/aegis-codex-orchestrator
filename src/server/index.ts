import express, { type Express, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiRouter } from "./routes.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_PORT = 3001;

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

export function startServer(port: number = DEFAULT_PORT): void {
  const app = createServer();
  const actualPort = Number(process.env.CODEX_GTD_SERVER_PORT) || port;

  app.listen(actualPort, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║         Aegis Codex Orchestrator Web Server                    ║
╠══════════════════════════════════════════════════════════════╣
║                                                                  ║
║  Web UI:   http://localhost:${actualPort}                         ║
║  API:      http://localhost:${actualPort}/api                     ║
║                                                                  ║
║  Endpoints:                                                      ║
║  - POST   /api/tasks     - Create and start a new task         ║
║  - GET    /api/tasks     - List all tasks                       ║
║  - GET    /api/tasks/:id - Get task details and progress       ║
║                                                                  ║
╚══════════════════════════════════════════════════════════════╝
    `);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
