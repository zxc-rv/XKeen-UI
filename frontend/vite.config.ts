import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { defineConfig } from 'vite'

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { '@': path.resolve(__dirname, './src') },
    },
    server: {
      proxy: {
        '/api': {
          target: `http://192.168.1.1:1000`,
          changeOrigin: true,
          ws: true,
        },
        '/ws': { target: `ws://192.168.1.1:1000`, ws: true },
        '/clash': {
          target: `http://192.168.1.1:1000`,
          changeOrigin: true,
        },
        '/clash-ws': {
          target: `ws://192.168.1.1:1000`,
          ws: true,
          changeOrigin: true,
        },
      },
    },
    build: {
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('@codemirror') || id.includes('/codemirror/')) return 'codemirror'
            if (id.includes('prettier')) return 'prettier'
            if (id.includes('@radix-ui')) return 'radix'
            if (id.includes('@tabler/icons-react')) return 'icons'
            if (id.includes('react-markdown') || id.includes('remark-gfm')) return 'markdown'
            if (id.includes('framer-motion')) return 'motion'
          },
        },
      },
    },
  }
})
