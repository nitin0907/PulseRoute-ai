#!/usr/bin/env node
/**
 * PulseRoute MCP Server — Entry Point
 *
 * Dual-transport MCP server: HTTP (default) + stdio (fallback).
 *
 * Transport selection is controlled by the TRANSPORT environment variable:
 *   TRANSPORT=http    → Starts HTTP server on PORT (default 3000)
 *   TRANSPORT=stdio   → Starts stdio server (original behaviour)
 *   (unset)           → Defaults to HTTP
 *
 * HTTP endpoints (StreamableHTTPServerTransport):
 *   POST   /mcp  — JSON-RPC request / tool call
 *   GET    /mcp  — SSE stream for server-initiated messages
 *   DELETE /mcp  — Session termination
 *   GET    /health — Liveness probe (returns 200 JSON)
 *
 * Tools exposed (unchanged):
 *   1. find_nearest_available_ambulance
 *   2. select_hospital
 *   3. traffic_assessment
 *   4. calculate_route
 *
 * All tools read exclusively from:
 *   - PulseRoute_Bengaluru_KB.json
 *   - data/ambulances.json
 *   - data/hospitals.json
 *   - data/icu_facilities.json
 *   - data/trauma_centers.json
 *   - data/road_network.json
 *   - data/traffic_signals.json
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import {
  FindAmbulanceInputSchema,
  findNearestAvailableAmbulance,
} from "./tools/find_nearest_available_ambulance.js";
import {
  SelectHospitalInputSchema,
  selectHospital,
} from "./tools/select_hospital.js";
import {
  TrafficAssessmentInputSchema,
  trafficAssessment,
} from "./tools/traffic_assessment.js";
import {
  CalculateRouteInputSchema,
  calculateRoute,
} from "./tools/calculate_route.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const TRANSPORT = (process.env.TRANSPORT ?? "http").toLowerCase();

// ---------------------------------------------------------------------------
// Factory — creates and fully registers a new McpServer instance.
//
// HTTP transport is stateless per-request: each POST /mcp with an
// InitializeRequest spawns a fresh McpServer + StreamableHTTPServerTransport
// pair. Existing sessions are looked up by Mcp-Session-Id header and reused.
// ---------------------------------------------------------------------------

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "pulseroute-mcp",
    version: "1.0.0",
  });

  // ── Tool 1 — find_nearest_available_ambulance ──────────────────────────
  server.registerTool(
    "find_nearest_available_ambulance",
    {
      description:
        "Find the nearest available ambulance to an incident location in Bengaluru. " +
        "Returns ambulance ID, call sign, type, crew, equipment, current locality, GPS coordinates, " +
        "availability status, distance from incident in km, and estimated time of arrival (ETA) in minutes. " +
        "ETA accounts for peak-hour traffic. " +
        "Optionally filter by ambulance type: ALS (Advanced Life Support), BLS (Basic Life Support), " +
        "MICU (Mobile ICU), or Neonatal. Returns top 3 alternatives alongside the best match.",
      inputSchema: FindAmbulanceInputSchema,
    },
    async (input) => {
      try {
        const result = findNearestAvailableAmbulance(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `find_nearest_available_ambulance failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // ── Tool 2 — select_hospital ───────────────────────────────────────────
  server.registerTool(
    "select_hospital",
    {
      description:
        "Recommend the best hospital for a given emergency type and incident location in Bengaluru. " +
        "Scores hospitals on: specialty match, bed availability, ICU availability, trauma centre level, " +
        "and proximity to incident. " +
        "Returns hospital name, address, phone, distance, available beds, ICU units, trauma capability, " +
        "matched specialties, and a human-readable recommendation reason. " +
        "Also returns up to 3 alternative hospitals. " +
        "Supported emergency types: Cardiac Arrest, STEMI, Stroke, Polytrauma, Trauma, Major Burns, " +
        "Obstetric, Pediatric, Poisoning, Drowning, Sepsis, Neonatal, Orthopedic, Penetrating Trauma.",
      inputSchema: SelectHospitalInputSchema,
    },
    async (input) => {
      try {
        const result = selectHospital(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `select_hospital failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // ── Tool 3 — traffic_assessment ────────────────────────────────────────
  server.registerTool(
    "traffic_assessment",
    {
      description:
        "Assess real-time traffic conditions around an incident location in Bengaluru. " +
        "Finds all traffic signals within a configurable radius, ranks them by congestion index, " +
        "identifies affected road corridors, and computes expected delay in minutes. " +
        "Returns congestion level (LOW / MODERATE / HIGH / SEVERE / CRITICAL), traffic risk rating, " +
        "list of affected signals and roads, emergency route alternatives, " +
        "signal-preemption-capable junctions, and a routing recommendation. " +
        "Default search radius is 10 km. Congestion indices above 9.0 trigger NICE Road bypass recommendations.",
      inputSchema: TrafficAssessmentInputSchema,
    },
    async (input) => {
      try {
        const result = trafficAssessment(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `traffic_assessment failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  // ── Tool 4 — calculate_route ───────────────────────────────────────────
  server.registerTool(
    "calculate_route",
    {
      description:
        "Calculate the best ambulance route between two localities in Bengaluru. " +
        "Returns a recommended route and an alternate route, each with road name, distance in km, " +
        "ETA in minutes, speed used, emergency-route flag, signal-preemption flag, known bottlenecks, " +
        "and congested junctions on path. " +
        "ETA accounts for peak-hour traffic conditions. " +
        "When GPS coordinates are provided for both source and destination, routing precision improves. " +
        "When no direct road corridor is found, falls back to Outer Ring Road + NICE Road recommendations.",
      inputSchema: CalculateRouteInputSchema,
    },
    async (input) => {
      try {
        const result = calculateRoute(input);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          content: [{ type: "text", text: `calculate_route failed: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP transport — stateless per-session model
//
// Session lifecycle:
//   1. Client sends POST /mcp with an InitializeRequest (no Mcp-Session-Id).
//   2. Server creates a new McpServer + StreamableHTTPServerTransport pair,
//      connects them, and returns the session ID in the response header.
//   3. Client attaches Mcp-Session-Id to all subsequent requests.
//   4. Client sends DELETE /mcp to explicitly close the session.
// ---------------------------------------------------------------------------

async function startHttpServer(): Promise<void> {
  // Map of sessionId → transport, for re-using established sessions.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

      // ── Health probe ────────────────────────────────────────────────────
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            server: "pulseroute-mcp",
            version: "1.0.0",
            transport: "http",
            tools: [
              "find_nearest_available_ambulance",
              "select_hospital",
              "traffic_assessment",
              "calculate_route",
            ],
          })
        );
        return;
      }

      // ── Only handle /mcp ────────────────────────────────────────────────
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found. Use POST /mcp" }));
        return;
      }

      // ── DELETE /mcp — session teardown ──────────────────────────────────
      if (req.method === "DELETE") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (sessionId && sessions.has(sessionId)) {
          const transport = sessions.get(sessionId)!;
          await transport.handleRequest(req, res);
          sessions.delete(sessionId);
          console.error(`[HTTP] Session closed: ${sessionId}`);
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
        }
        return;
      }

      // ── POST /mcp — tool call or initialize ─────────────────────────────
      if (req.method === "POST") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;

        // Reuse an existing session.
        if (sessionId && sessions.has(sessionId)) {
          const transport = sessions.get(sessionId)!;
          await transport.handleRequest(req, res);
          return;
        }

        // New session — generate the session ID synchronously so it is
        // available in the sessions Map before handleRequest() returns and
        // before Orchestrate sends the next request (tools/list, initialized).
        const newSessionId = randomUUID();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => newSessionId,
        });

        // Register the session BEFORE handing control to handleRequest so
        // that any immediately-following request (initialized notification,
        // tools/list) can always find it in the Map.
        sessions.set(newSessionId, transport);
        console.error(`[HTTP] Session created: ${newSessionId}`);

        // Attach a fresh McpServer to this transport.
        const mcpServer = createMcpServer();
        await mcpServer.connect(transport);

        // Clean up the session from our map when it closes.
        transport.onclose = () => {
          sessions.delete(newSessionId);
          console.error(`[HTTP] Session closed: ${newSessionId}`);
        };

        // Delegate full request routing to the transport — do not pre-read
        // the body; the transport owns the stream from this point forward.
        await transport.handleRequest(req, res);
        return;
      }

      // ── GET /mcp — SSE stream for server-initiated messages ─────────────
      if (req.method === "GET") {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        if (!sessionId || !sessions.has(sessionId)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "Missing or unknown Mcp-Session-Id. Initialize a session first via POST /mcp.",
            })
          );
          return;
        }
        const transport = sessions.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      // ── Unsupported method ───────────────────────────────────────────────
      res.writeHead(405, {
        "Content-Type": "application/json",
        Allow: "GET, POST, DELETE",
      });
      res.end(JSON.stringify({ error: "Method not allowed" }));
    }
  );

  httpServer.listen(PORT, () => {
    console.error(`PulseRoute MCP Server v1.0.0 — HTTP transport`);
    console.error(`Listening on http://0.0.0.0:${PORT}`);
    console.error(`MCP endpoint : http://0.0.0.0:${PORT}/mcp`);
    console.error(`Health probe : http://0.0.0.0:${PORT}/health`);
    console.error(
      `Tools        : find_nearest_available_ambulance | select_hospital | traffic_assessment | calculate_route`
    );
  });

  // Graceful shutdown on SIGTERM (container stop) and SIGINT (Ctrl+C).
  const shutdown = (): void => {
    console.error("[HTTP] Shutting down...");
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// ---------------------------------------------------------------------------
// Stdio transport — original behaviour, unchanged
// ---------------------------------------------------------------------------

async function startStdioServer(): Promise<void> {
  const mcpServer = createMcpServer();
  const transport = new StdioServerTransport();
  await mcpServer.connect(transport);
  console.error("PulseRoute MCP Server v1.0.0 — stdio transport");
  console.error(
    "Tools: find_nearest_available_ambulance | select_hospital | traffic_assessment | calculate_route"
  );
}

// ---------------------------------------------------------------------------
// Entry point — choose transport from TRANSPORT env var
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (TRANSPORT === "stdio") {
    await startStdioServer();
  } else {
    await startHttpServer();
  }
}

main().catch((error: unknown) => {
  console.error("Fatal error starting PulseRoute MCP Server:", error);
  process.exit(1);
});
