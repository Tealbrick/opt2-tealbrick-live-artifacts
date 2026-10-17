// UI entry: served by the SDK from dist/ui under /a/live-artifacts/ behind the person session (SDK-API §3.2, §14).
import { TbProvider } from "@opt2-tealbrick/miniapp-sdk/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <TbProvider product="live-artifacts">
      <App />
    </TbProvider>
  </StrictMode>,
);
