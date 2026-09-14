FROM node:24-bookworm

WORKDIR /app

ENV NODE_ENV=production
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV FORGE_BROWSER_NO_SANDBOX=true

COPY package.json package-lock.json ./

# Install the exact lockfile graph, including build tooling. The server bundle and Vite
# client are built in this image, and Phase 3 needs a real Chromium binary at runtime.
RUN npm ci --include=dev --no-audit --no-fund
RUN npx playwright install --with-deps chromium

COPY . .

RUN npm run build

EXPOSE 3000

CMD ["npm", "run", "start"]
