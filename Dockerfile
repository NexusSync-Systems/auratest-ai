# Verze musí odpovídat `playwright` v package.json — image nese předinstalované
# binárky prohlížečů pro svou verzi. Při nesouladu (image 1.44 vs balíček 1.60)
# končí běh chybou "Executable doesn't exist".
FROM mcr.microsoft.com/playwright:v1.60.0-jammy AS builder

WORKDIR /app

# `npm ci` místo `npm install`: reprodukovatelný build podle lockfile.
COPY package.json package-lock.json* ./
RUN npm ci

COPY frontend/package.json frontend/package-lock.json* ./frontend/
RUN cd frontend && npm ci

COPY . .

# Konfigurace Firebase se do frontendu zapéká PŘI BUILDU (Vite nahrazuje
# `import.meta.env.*` konstantami). Bez těchhle ARG sáhne build po fallback
# hodnotách zadrátovaných ve frontend/src/lib/firebase.js, takže se nasazení
# mlčky připne na jeden konkrétní projekt a změna proměnné za běhu se nikde
# neprojeví.
#
# Nejde o tajemství — web config Firebase je veřejný z principu a chrání ho
# Firestore rules, ne utajení. Jde o to, aby bylo z konfigurace vidět, k jakému
# projektu se instalace váže.
ARG VITE_FIREBASE_PROJECT_ID
ARG VITE_FIREBASE_API_KEY
ARG VITE_FIREBASE_AUTH_DOMAIN
ARG VITE_FIREBASE_APP_ID
ARG VITE_FIREBASE_STORAGE_BUCKET
ARG VITE_FIREBASE_MESSAGING_SENDER_ID

RUN cd frontend && npm run build

# ─────────────────────────────────────────────────────────────────────────────
# Runtime: bez devDependencies (jest, eslint, vitest, supertest, concurrently)
# a bez zdrojů frontendu.
# ─────────────────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.60.0-jammy

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Aplikační kód a hotový build frontendu
COPY --from=builder /app/frontend/dist ./frontend/dist
COPY --from=builder /app/public ./public
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/*.js ./
# Smoke test běží PROTI NASAZENÉ instalaci, takže musí být uvnitř image —
# jinak je příkaz v deploy/README.md slib, který skončí „Cannot find module".
# Je to jediný způsob, jak po nasazení ověřit věci, které jednotkové testy
# ověřit nedokážou: PQC sondu proti skutečnému serveru a SBOM z živých bundlů.
COPY --from=builder /app/scripts/smoke-test.mjs ./scripts/

# Adresáře pro artefakty musí patřit neprivilegovanému uživateli.
RUN mkdir -p screenshots videos generated-scripts \
    && chown -R pwuser:pwuser /app

# Base image má připraveného neprivilegovaného uživatele, ale kontejner dosud
# běžel jako root — mimo jiné to vyrábělo root-owned soubory v bind mountech.
USER pwuser

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/auraguard/sdk.js').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `node` přímo, ne přes npm: npm jako PID 1 nepředává SIGTERM, takže
# kontejner se nikdy neukončí korektně.
CMD ["node", "server.js"]
