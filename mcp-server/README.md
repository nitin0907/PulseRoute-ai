# PulseRoute MCP Server

MCP (Model Context Protocol) server for the PulseRoute AI emergency dispatch platform — Bengaluru.

Exposes four tools consumable by any MCP-compatible host: IBM Bob, watsonx Orchestrate, Claude Desktop, or any MCP client.

---

## Project Structure

```
mcp-server/
├── package.json                                  # Node.js project manifest
├── tsconfig.json                                 # TypeScript compiler config
├── README.md                                     # This file
├── build/                                        # Compiled output (after npm run build)
│   └── index.js
└── src/
    ├── index.ts                                  # Server entry point — tool registration
    ├── types/
    │   └── schemas.ts                            # Shared types, data loaders, Haversine utility
    └── tools/
        ├── find_nearest_available_ambulance.ts   # Tool 1
        ├── select_hospital.ts                    # Tool 2
        ├── traffic_assessment.ts                 # Tool 3
        └── calculate_route.ts                    # Tool 4
```

---

## Data Sources

All tools read exclusively from the workspace data files. No domain data is hardcoded.

| File | Used by |
|---|---|
| `../data/ambulances.json` | `find_nearest_available_ambulance` |
| `../data/hospitals.json` | `select_hospital` |
| `../data/icu_facilities.json` | `select_hospital` |
| `../data/trauma_centers.json` | `select_hospital` |
| `../data/road_network.json` | `calculate_route`, `traffic_assessment` |
| `../data/traffic_signals.json` | `traffic_assessment`, `calculate_route` |
| `../PulseRoute_Bengaluru_KB.json` | Master reference (routing hints embedded in tools) |

The data directory is resolved at runtime relative to the compiled `build/index.js` — no environment variables required for data access.

---

## Prerequisites

- Node.js >= 18.0.0
- npm >= 9.0.0

---

## Transport Modes

| Mode | Command | When to use |
|---|---|---|
| **HTTP** (default) | `npm start` | watsonx Orchestrate, cloud deployment, any HTTP MCP client |
| **HTTP explicit** | `npm run start:http` | Same as above, env var set explicitly |
| **stdio** | `npm run start:stdio` | IBM Bob, Claude Desktop, local pipe-based MCP hosts |

Transport is selected by the `TRANSPORT` environment variable (`http` \| `stdio`). Unset defaults to `http`.
Port is set by the `PORT` environment variable. Unset defaults to `3000`.

---

## Installation & Build

```bash
# 1. Navigate to the mcp-server directory
cd mcp-server

# 2. Install dependencies
npm install

# 3. Compile TypeScript
npm run build

# 4. Verify the compiled entry point exists
ls build/index.js
```

---

## Tools

### 1. `find_nearest_available_ambulance`

Find the nearest available ambulance to an incident GPS location.

**Input:**

| Field | Type | Required | Description |
|---|---|---|---|
| `latitude` | number | Yes | Incident latitude (WGS84) |
| `longitude` | number | Yes | Incident longitude (WGS84) |
| `ambulance_type` | string | No | `ALS` \| `BLS` \| `MICU` \| `Neonatal` \| `any` (default: `any`) |

**Output fields:** `ambulance_id`, `call_sign`, `ambulance_type`, `vehicle_make`, `current_locality`, `availability_status`, `crew`, `equipment`, `distance_km`, `eta_minutes`, `peak_hour_active`, `alternatives_available`

---

### 2. `select_hospital`

Recommend the best hospital for an emergency type and incident location.

**Input:**

| Field | Type | Required | Description |
|---|---|---|---|
| `emergency_type` | string | Yes | E.g. `Cardiac Arrest`, `Stroke`, `Polytrauma`, `Major Burns` |
| `required_specialties` | string[] | No | Explicit specialty requirements (merged with auto-inferred) |
| `latitude` | number | Yes | Incident latitude (WGS84) |
| `longitude` | number | Yes | Incident longitude (WGS84) |

**Output fields:** `hospital_name`, `address`, `phone`, `distance_km`, `available_beds`, `icu_availability`, `trauma_capability`, `trauma_details`, `matched_specialties`, `recommendation_reason`, `alternatives`

---

### 3. `traffic_assessment`

Assess traffic conditions around an incident location.

**Input:**

| Field | Type | Required | Description |
|---|---|---|---|
| `incident_location.latitude` | number | Yes | Incident latitude |
| `incident_location.longitude` | number | Yes | Incident longitude |
| `incident_location.locality_name` | string | No | Display name for reporting |
| `radius_km` | number | No | Search radius in km (default: 10) |

**Output fields:** `congestion_level`, `traffic_risk`, `congestion_score`, `expected_delay_minutes`, `affected_signals`, `affected_roads`, `emergency_routes_available`, `preemption_capable_signals`, `routing_recommendation`

---

### 4. `calculate_route`

Calculate the best route between two Bengaluru localities.

**Input:**

| Field | Type | Required | Description |
|---|---|---|---|
| `source.locality` | string | Yes | Origin locality name |
| `source.latitude` | number | No | Origin latitude (improves scoring) |
| `source.longitude` | number | No | Origin longitude (improves scoring) |
| `destination.locality` | string | Yes | Destination locality name |
| `destination.latitude` | number | No | Destination latitude |
| `destination.longitude` | number | No | Destination longitude |

**Output fields:** `recommended_route`, `alternate_route`, `eta_minutes`, `distance_km`, `peak_hour_active`, `routing_notes`

---

## Local Testing — stdio transport

After building, start the server in stdio mode and pipe JSON-RPC directly:

```bash
# List all available tools
TRANSPORT=stdio echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node build/index.js
```

### Test — find_nearest_available_ambulance (stdio)

```bash
echo '{
  "jsonrpc": "2.0", "id": 2, "method": "tools/call",
  "params": {
    "name": "find_nearest_available_ambulance",
    "arguments": { "latitude": 12.9176, "longitude": 77.6237, "ambulance_type": "ALS" }
  }
}' | TRANSPORT=stdio node build/index.js
```

---

## Local Testing — HTTP transport

Start the server in HTTP mode, then use curl in a second terminal.

```bash
# Terminal 1 — start HTTP server
npm start
# → PulseRoute MCP Server v1.1.0 — HTTP transport
# → Listening on http://0.0.0.0:3000
# → MCP endpoint : http://0.0.0.0:3000/mcp
```

### Step 1 — Health probe

```bash
curl http://localhost:3000/health
```

Expected response:
```json
{
  "status": "ok",
  "server": "pulseroute-mcp",
  "version": "1.1.0",
  "transport": "http",
  "tools": ["find_nearest_available_ambulance","select_hospital","traffic_assessment","calculate_route"]
}
```

### Step 2 — Initialize a session (POST /mcp)

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -D - \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": { "name": "test-client", "version": "1.0" }
    }
  }'
```

The response headers contain `Mcp-Session-Id`. Copy that value — it is required for all subsequent requests.

### Step 3 — List tools

```bash
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: <session-id-from-step-2>" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
```

### Step 4 — Call a tool

```bash
# find_nearest_available_ambulance
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: <session-id-from-step-2>" \
  -d '{
    "jsonrpc": "2.0", "id": 3, "method": "tools/call",
    "params": {
      "name": "find_nearest_available_ambulance",
      "arguments": { "latitude": 12.9176, "longitude": 77.6237, "ambulance_type": "ALS" }
    }
  }'

# select_hospital
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: <session-id-from-step-2>" \
  -d '{
    "jsonrpc": "2.0", "id": 4, "method": "tools/call",
    "params": {
      "name": "select_hospital",
      "arguments": {
        "emergency_type": "Cardiac Arrest",
        "required_specialties": ["Cardiology","Cardiac Surgery"],
        "latitude": 12.9176, "longitude": 77.6237
      }
    }
  }'

# traffic_assessment
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: <session-id-from-step-2>" \
  -d '{
    "jsonrpc": "2.0", "id": 5, "method": "tools/call",
    "params": {
      "name": "traffic_assessment",
      "arguments": {
        "incident_location": { "latitude": 12.9176, "longitude": 77.6237, "locality_name": "Silk Board" },
        "radius_km": 10
      }
    }
  }'

# calculate_route
curl -s -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Mcp-Session-Id: <session-id-from-step-2>" \
  -d '{
    "jsonrpc": "2.0", "id": 6, "method": "tools/call",
    "params": {
      "name": "calculate_route",
      "arguments": {
        "source": { "locality": "Koramangala", "latitude": 12.938, "longitude": 77.627 },
        "destination": { "locality": "Majestic", "latitude": 12.9748, "longitude": 77.5706 }
      }
    }
  }'
```

### Step 5 — Close the session

```bash
curl -s -X DELETE http://localhost:3000/mcp \
  -H "Mcp-Session-Id: <session-id-from-step-2>"
```

---

## Deployment Instructions

### Local (development)

```bash
cd mcp-server
npm install
npm run build
npm start
# Server is live at http://localhost:3000/mcp
```

### Custom port

```bash
PORT=8080 npm start
# Server is live at http://localhost:8080/mcp
```

### Windows (PowerShell) — set env vars before starting

```powershell
$env:PORT = "3000"
$env:TRANSPORT = "http"
node build/index.js
```

### Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app

# Copy project files
COPY mcp-server/package*.json ./mcp-server/
COPY mcp-server/tsconfig.json ./mcp-server/
COPY mcp-server/src ./mcp-server/src

# Copy data files (required at runtime)
COPY data ./data
COPY PulseRoute_Bengaluru_KB.json .

# Build
RUN cd mcp-server && npm install && npm run build

WORKDIR /app/mcp-server
ENV TRANSPORT=http
ENV PORT=3000
EXPOSE 3000

CMD ["node", "build/index.js"]
```

```bash
# Build and run the container
docker build -t pulseroute-mcp .
docker run -p 3000:3000 pulseroute-mcp
```

### IBM Cloud Code Engine / any container platform

Deploy the Docker image above and expose port 3000.
Set environment variable `TRANSPORT=http`.
The MCP endpoint will be available at `https://<your-app-host>/mcp`.

---

## MCP Registration — IBM Bob / Claude Desktop (stdio)

Add to `.bob/mcp.json` or `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "pulseroute-mcp": {
      "command": "node",
      "args": [
        "C:\\Users\\Dell\\OneDrive\\Desktop\\PulseRoute AI\\mcp-server\\build\\index.js"
      ],
      "env": {
        "TRANSPORT": "stdio"
      }
    }
  }
}
```

---

## MCP Registration — watsonx Orchestrate

### Option A — HTTP (local, for testing)

If watsonx Orchestrate is running on the same network as the server:

1. Start the server: `npm start` (binds to `http://0.0.0.0:3000/mcp`)
2. In watsonx Orchestrate, navigate to:
   **Skills & Apps → MCP Servers → Add MCP Server**
3. Enter the server URL:
   ```
   http://<your-machine-ip>:3000/mcp
   ```
4. Click **Connect**. Orchestrate calls `tools/list` and imports all four tools.

### Option B — HTTP (cloud deployment, recommended for production)

1. Deploy the Docker image to a public endpoint (IBM Cloud, AWS, Azure, etc.)
2. Obtain the public HTTPS URL, e.g.:
   ```
   https://pulseroute-mcp.your-domain.com/mcp
   ```
3. In watsonx Orchestrate:
   - Navigate to **Skills & Apps → MCP Servers → Add MCP Server**
   - Enter: `https://pulseroute-mcp.your-domain.com/mcp`
   - Authentication: **None required** (no API key in the current build)
   - Click **Connect**

4. Orchestrate auto-discovers and imports the four skill cards:

| Tool registered in server | Skill card name in Orchestrate |
|---|---|
| `find_nearest_available_ambulance` | Find Nearest Available Ambulance |
| `select_hospital` | Select Hospital |
| `traffic_assessment` | Traffic Assessment |
| `calculate_route` | Calculate Route |

5. Add the `pulseroute-mcp` server to an Agent in **Agent Builder**:
   - Open Agent Builder → your agent → **Tools** tab
   - Select `pulseroute-mcp` from the connected MCP servers list
   - All four tools become available to the agent

6. Verify by asking the agent:
   ```
   Find the nearest ALS ambulance to latitude 12.9176, longitude 77.6237
   ```
   Orchestrate resolves this to a `find_nearest_available_ambulance` tool call and returns the result.

---

## HTTP Endpoint Reference

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/mcp` | MCP JSON-RPC (initialize + all tool calls) |
| `GET` | `/mcp` | SSE stream (server-initiated notifications) |
| `DELETE` | `/mcp` | Session teardown |
| `GET` | `/health` | Liveness probe — returns `{"status":"ok"}` |

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TRANSPORT` | `http` | Transport mode: `http` or `stdio` |
| `PORT` | `3000` | TCP port for HTTP server |

---

## Development

```bash
# Type-check without compiling
npm run typecheck

# Watch mode — recompiles on file save
npm run dev

# Rebuild
npm run build
```

---

## Notes

- All logging uses `console.error` — stdout is reserved for the MCP JSON-RPC channel (stdio mode).
- Data files are loaded lazily and cached in module scope — first call reads from disk, subsequent calls use the in-memory cache.
- Peak-hour detection is automatic based on IST (UTC+5:30): 07:30–10:30 and 17:30–20:30.
- No API keys or environment variables are required for data access — the server is self-contained.
- HTTP sessions are held in-process memory (`Map`). On server restart all sessions are lost; clients must re-initialize.
- For production, place behind a reverse proxy (nginx, Caddy) to add TLS termination.
