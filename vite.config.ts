import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4318',
        // The API's same-origin guard compares the Origin header with the Host header. The proxy
        // rewrites Host to its target by default, which made every browser POST in dev a 403.
        changeOrigin: false,
        configure: proxy => { proxy.on('proxyReq', (proxyReq, req) => { if (req.headers.host) proxyReq.setHeader('host', req.headers.host); }); },
      },
    },
  },
});
