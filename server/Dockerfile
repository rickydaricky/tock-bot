FROM mcr.microsoft.com/playwright:v1.52.0-noble

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . ./
RUN npx tsc
RUN npm prune --omit=dev

EXPOSE 3000
CMD ["node", "dist/index.js"]
