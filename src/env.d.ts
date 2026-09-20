/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Where the multiplayer server lives, baked in at build time. Only needed when
   * the page is served by something that cannot run the game server (a static
   * host such as Netlify or GitHub Pages): set it to the server's socket
   * address, e.g. `wss://skyfall-escape.onrender.com/ws`. Left unset, the client
   * talks to `/ws` on whatever host served the page, which is what the Node
   * server and the dev server both provide.
   */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
