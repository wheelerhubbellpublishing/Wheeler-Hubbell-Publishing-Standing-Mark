import { createRuntime } from "./runtime.mjs";

const runtime = await createRuntime();
const server = runtime.createServer();

server.listen(runtime.config.port, "0.0.0.0", () => {
  console.log(JSON.stringify({ ok: true, mode: "service", port: runtime.config.port }));
});

runtime.observer.start().catch(async (error) => {
  console.error(JSON.stringify({ ok: false, component: "startup", error: error.message }));
  server.close();
  await runtime.close();
  process.exitCode = 1;
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ ok: true, component: "shutdown", signal }));
  runtime.observer.stop();
  await new Promise((resolve) => server.close(resolve));
  await runtime.close();
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
