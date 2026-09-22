import { createRuntime } from "./runtime.mjs";

let runtime;
try {
  runtime = await createRuntime();
  const result = await runtime.observer.syncOnce();
  console.log(JSON.stringify({ ok: true, mode: "run-once", result }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, mode: "run-once", error: error.message }));
  process.exitCode = 1;
} finally {
  if (runtime) await runtime.close();
}
