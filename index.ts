import { loadConfig } from "./src/config";
import { Engine } from "./src/engine";
import { createServer } from "./src/server";

const cfg = await loadConfig();
const engine = new Engine(cfg);

engine.start();
createServer(cfg, () => engine.poll());

// Graceful shutdown
process.on("SIGTERM", () => { engine.stop(); process.exit(0); });
process.on("SIGINT",  () => { engine.stop(); process.exit(0); });