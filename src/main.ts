// Service entry (SDK-API §3): `startApp(app, process.env)` reads only the TB_* variables (SDK-API §13).
import { startApp } from "@opt2-tealbrick/miniapp-sdk";
import { app } from "./app.ts";

const running = await startApp(app, process.env);
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void running.stop().finally(() => process.exit(0));
  });
}
