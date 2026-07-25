FROM node:20-alpine

WORKDIR /app

# Copy the entire project
COPY . .

# Build the MCP server
WORKDIR /app/mcp-server
RUN npm install
RUN npm run build

# Set environment
ENV TRANSPORT=http
ENV PORT=3000
EXPOSE 3000

# Start the HTTP server
CMD ["node", "build/index.js"]
