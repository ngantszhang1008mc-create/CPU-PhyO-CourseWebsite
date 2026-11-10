// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

export default defineConfig({
  output: 'static',
  integrations: [react()],
  vite: {
    server: {
      proxy: {
        '/api/': {
          target: 'http://127.0.0.1:8787',
          changeOrigin: true,
          configure(proxy) {
            // Preserve the Worker's CSRF check across the local development proxy.
            proxy.on('proxyReq', (outgoing, incoming) => {
              if (incoming.headers.origin === 'http://' + incoming.headers.host) {
                outgoing.setHeader('Origin', 'http://127.0.0.1:8787');
              }
            });
          },
        },
      },
    },
  },
  devToolbar: { enabled: false },
});
