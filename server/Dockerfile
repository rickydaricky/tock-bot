FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . ./
RUN npx tsc
RUN cp -r src/public dist/public
RUN npm prune --omit=dev

RUN apt-get update && apt-get install -y xvfb && rm -rf /var/lib/apt/lists/*

EXPOSE 3000
CMD ["xvfb-run", "--auto-servernum", "node", "dist/index.js"]
