FROM mcr.microsoft.com/playwright:v1.59.0-noble

WORKDIR /app
COPY package*.json ./
# `npm ci` requires lock-file to match package.json exactly; fall back to
# `npm install` so deps added without a local lock-file refresh still build.
RUN npm ci || npm install
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["node", "dist/index.js"]
