FROM node:20-alpine

WORKDIR /app

# Copy the entire project so data/ and KB live alongside mcp-server/
COPY . .

# Install dependencies and build inside mcp-server/
WORKDIR /app/mcp-server
RUN npm install
RUN npm run build

# Environment
ENV TRANSPORT=http
ENV PORT=3000
EXPOSE 3000

# data/ and PulseRoute_Bengaluru_KB.json are at /app/mcp-server/
# schemas.ts resolves them 3 levels up from build/src/types/ → /app/mcp-server/
CMD ["node", "build/index.js"]
