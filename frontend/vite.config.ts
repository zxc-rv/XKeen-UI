import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
    server: {
      proxy: {
        '/api': `http://192.168.1.1:1000`,
        '/ws': { target: `ws://192.168.1.1:1000`, ws: true },
        '/clash': {
          target: `http://192.168.1.1:9090`,
          changeOrigin: true,
          rewrite: (requestPath) => requestPath.replace(/^\/clash/, ''),
        },
        '/clash-ws': {
          target: `ws://192.168.1.1:9090`,
          ws: true,
          changeOrigin: true,
          rewrite: (requestPath) => requestPath.replace(/^\/clash-ws/, ''),
        },
      },
    },
    build: {
      chunkSizeWarningLimit: 4000,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('monaco-editor')) return 'monaco-editor'
            if (id.includes('prettier')) return 'prettier'
          },
        },
      },
    },
  }
})
