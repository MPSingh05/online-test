# Container for Google Cloud Run (or any container host). DATA_DIR must be persistent storage: on Cloud Run,
# a Cloud Storage bucket mounted at /data. Settings and secrets come from environment variables, not .env.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY lib ./lib
COPY public ./public
ENV DATA_DIR=/data PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
