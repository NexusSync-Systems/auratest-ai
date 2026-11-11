import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:3001',
      '/sdk': 'http://localhost:3001',
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true
      }
    }
  },
  build: {
    rolldownOptions: {
      output: {
        // Bez rozdělení šel celý bundle v jednom chunku přes 1 MB.
        // Firebase je největší kus a mění se zřídka, takže se dobře cachuje.
        //
        // Dřív to byl `manualChunks` jako objekt `{ firebase: [...] }`. Vite 8
        // staví na rolldownu, který objektovou formu nepodporuje — build končil
        // na `TypeError: manualChunks is not a function`. Funkční forma
        // `manualChunks` v rolldownu existuje, ale je označená jako deprecated,
        // takže by se stejná práce opakovala u dalšího majoru. `codeSplitting`
        // je její náhrada. Stejně tak `rollupOptions` je ve vite 8 jen
        // deprecated alias pro `rolldownOptions`.
        //
        // `includeDependenciesRecursively` je u skupiny implicitně `true`, takže
        // stačí uvést vstupní balíček a závislosti se přiberou samy — to je
        // přesně to, co dělala objektová forma se seznamem `firebase/app`,
        // `firebase/auth`, `firebase/firestore`.
        codeSplitting: {
          groups: [
            { name: 'firebase', test: /[\\/]node_modules[\\/](firebase|@firebase)[\\/]/ },
            { name: 'markdown', test: /[\\/]node_modules[\\/]react-markdown[\\/]/ },
          ]
        }
      }
    }
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
  }
})
