// Vite dev-server plugin: mounts the real-time companion API (/api/rt/*) on
// the dev server itself, so `npm run dev` needs no separate process. A
// deployed frontend instead talks to the standalone companion (server.mjs);
// both share the same handler (api.mjs).
import path from "node:path";
import { createRtApi } from "./api.mjs";

export function scrRealtimePlugin() {
  return {
    name: "scr-realtime",
    apply: "serve",
    configureServer(server) {
      const api = createRtApi({
        profileDir: path.resolve(server.config.root, ".scr-session"),
        mode: "local",
      });

      server.middlewares.use((req, res, next) => {
        api.handle(req, res).then((handled) => {
          if (!handled) next();
        }, next);
      });

      server.httpServer?.on("close", () => {
        void api.close();
      });
    },
  };
}
