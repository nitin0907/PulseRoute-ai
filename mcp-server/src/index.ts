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
import https from "node:https";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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

const PORT      = parseInt(process.env.PORT ?? "3000", 10);
const TRANSPORT = (process.env.TRANSPORT ?? "http").toLowerCase();

// In-memory store for the latest Mission Commander result posted via webhook
let _latestResult:    unknown = null;
let _resultTimestamp: number  = 0;

// ---------------------------------------------------------------------------
// Orchestrate proxy configuration
// ---------------------------------------------------------------------------

const ORCHESTRATE_INSTANCE_ID    = "9291f63d-e948-4929-9c62-56eecfb515ad";
const ORCHESTRATE_HOST           = "api.ca-tor.watson-orchestrate.cloud.ibm.com";
const ORCHESTRATE_AGENT_ID       = "f5bb4d34-12e0-466b-9858-6304e52bc4b7";
const ORCHESTRATE_ENV_ID         = "2681c726-3962-4c10-8382-a7dd1acb1762";
const IAM_TOKEN_URL              = "https://iam.cloud.ibm.com/identity/token";

// Candidate API paths — tried in order, first 2xx/non-404 wins.
// Each entry is [path, bodyVariant] where bodyVariant controls which
// request body shape is sent to that particular endpoint.
//   "chat"  → { messages: [{role:"user", content}] }   (OpenAI-style)
//   "runs"  → { input: { text }, agent_id, agent_environment_id }
const ORCHESTRATE_API_CANDIDATES: Array<[string, "chat" | "runs"]> = [
  // ── v1 chat (preferred — standard watsonx Orchestrate chat endpoint)
  [`/instances/${ORCHESTRATE_INSTANCE_ID}/v1/agent_environments/${ORCHESTRATE_ENV_ID}/chat`,        "chat"],
  // ── v2 chat
  [`/instances/${ORCHESTRATE_INSTANCE_ID}/v2/agent_environments/${ORCHESTRATE_ENV_ID}/chat`,        "chat"],
  // ── v1 runs with runs-style body
  [`/instances/${ORCHESTRATE_INSTANCE_ID}/v1/agent_environments/${ORCHESTRATE_ENV_ID}/runs`,        "runs"],
  // ── v2 runs
  [`/instances/${ORCHESTRATE_INSTANCE_ID}/v2/agent_environments/${ORCHESTRATE_ENV_ID}/runs`,        "runs"],
  // ── agent-scoped endpoints (no environment)
  [`/instances/${ORCHESTRATE_INSTANCE_ID}/v1/agents/${ORCHESTRATE_AGENT_ID}/runs`,                 "runs"],
  [`/instances/${ORCHESTRATE_INSTANCE_ID}/v2/agents/${ORCHESTRATE_AGENT_ID}/runs`,                 "runs"],
  // ── root-relative fallbacks
  [`/v1/agent_environments/${ORCHESTRATE_ENV_ID}/chat`,                                             "chat"],
  [`/v1/agent_environments/${ORCHESTRATE_ENV_ID}/runs`,                                             "runs"],
  [`/v1/agents/${ORCHESTRATE_AGENT_ID}/runs`,                                                       "runs"],
];

// IAM token cache
let _iamToken     = "";
let _iamExpiresAt = 0;

async function getIAMToken(): Promise<string> {
  const now = Date.now();
  if (_iamToken && now < _iamExpiresAt) return _iamToken;
  const apiKey = process.env.IBM_IAM_API_KEY ?? "";
  if (!apiKey) throw new Error("IBM_IAM_API_KEY environment variable is not set");
  const body = `grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=${encodeURIComponent(apiKey)}`;
  const data = await httpsPost(IAM_TOKEN_URL, body, {
    "Content-Type": "application/x-www-form-urlencoded",
    "Accept":       "application/json",
  });
  const json = JSON.parse(data) as { access_token: string; expires_in: number };
  if (!json.access_token) throw new Error(`IAM token exchange failed: ${data}`);
  _iamToken     = json.access_token;
  _iamExpiresAt = now + (json.expires_in - 300) * 1000;
  console.error(`[Proxy] IAM token refreshed — expires in ${json.expires_in}s`);
  return _iamToken;
}

function httpsPost(url: string, body: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) } },
      (res) => { let d = ""; res.on("data", (c: Buffer) => (d += c)); res.on("end", () => resolve(d)); }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// Serve app.html — resolved relative to this compiled file
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
// build/index.js → mcp-server root → command-center/app.html
const APP_HTML_PATH      = resolve(__dirname, "..", "..", "command-center", "app.html");
const COMMAND_CENTER_PATH = resolve(__dirname, "..", "..", "command-center", "pulseroute-command-center.html");
// build/index.js → mcp-server root → workflows/
const WORKFLOWS_DIR = resolve(__dirname, "..", "..", "workflows");
let   _appHtml      = "";
function getAppHtml(): string {
  if (_appHtml) return _appHtml;
  if (existsSync(APP_HTML_PATH)) {
    // Rewrite the proxy URL to point at this same server so there is no CORS
    const raw = readFileSync(APP_HTML_PATH, "utf-8");
    _appHtml  = raw.replace(
      /const ORCHESTRATE_PROXY_URL\s*=\s*['"][^'"]*['"]/,
      "const ORCHESTRATE_PROXY_URL = '/api/dispatch'"
    );
    console.error(`[UI] Serving app.html from ${APP_HTML_PATH}`);
  } else {
    _appHtml = "<html><body style='background:#0a0c10;color:#e6edf3;font-family:monospace;padding:40px'>" +
               "<h2>PulseRoute AI</h2><p>app.html not found at expected path.</p>" +
               `<pre>${APP_HTML_PATH}</pre></body></html>`;
    console.error(`[UI] WARNING: app.html not found at ${APP_HTML_PATH}`);
  }
  return _appHtml;
}

// Normalise an Orchestrate SSE event into the shape the UI expects.
// Handles both the /runs event schema and the /chat (OpenAI-style) schema.
function normaliseOrchestrateEvent(ev: Record<string, unknown>, stepCounter: number): Record<string, unknown> | null {
  const now    = new Date().toISOString().slice(11, 19);
  const evType = (ev.event ?? ev.type ?? "") as string;
  // /chat responses nest their payload under ev.data; /runs put it at the root
  const evData = (ev.data ?? ev) as Record<string, unknown>;

  // ── Agent reasoning / thought ────────────────────────────────────────────
  if (["agent_message", "thought", "message", "text"].includes(evType)) {
    const content = evData.content ?? evData.text ?? evData.delta ?? JSON.stringify(evData);
    return { type: "thought", ts: evData.ts ?? now, content };
  }

  // ── OpenAI-style chat.completion.chunk (streaming /chat endpoint) ─────────
  // shape: { type: "chat.completion.chunk", data: { choices: [{ delta: { content } }] } }
  if (evType === "chat.completion.chunk" || evType === "chunk") {
    const choices = (evData.choices ?? []) as Array<Record<string, Record<string, unknown>>>;
    const delta   = choices[0]?.delta ?? {};
    const content = delta.content;
    if (content) return { type: "thought", ts: now, content };
    // tool_calls delta
    const tc = (delta.tool_calls ?? []) as Array<Record<string, unknown>>;
    if (tc.length) {
      const t     = tc[0] as Record<string, unknown>;
      const fn    = (t.function ?? {}) as Record<string, unknown>;
      const tName = (fn.name ?? t.name ?? "tool") as string;
      const args  = (fn.arguments ?? t.arguments ?? "{}") as string;
      return { type: "tool_call", ts: now, tool_name: tName,
               input: args, step: String(stepCounter + 1) };
    }
    return null; // empty delta (role-only chunk), skip
  }

  // ── OpenAI-style final chat.completion (non-streaming /chat endpoint) ─────
  // shape: { type: "chat.completion", data: { choices: [{ message: { content } }] } }
  if (evType === "chat.completion" || evType === "message.completed") {
    const choices = (evData.choices ?? []) as Array<Record<string, Record<string, unknown>>>;
    const msg     = choices[0]?.message ?? evData;
    const rawText = (msg.content ?? evData.content ?? evData.text ?? "") as string;
    let result: unknown;
    try   { result = JSON.parse(rawText as string); }
    catch { result = { status: "error", notes: rawText, confidence: 0,
                       ambulance: null, hospital: null, route: null, traffic: null,
                       corridor: null, specialists: [] }; }
    return { type: "final", ts: now, result: JSON.stringify(result) };
  }

  // ── Tool invocation ───────────────────────────────────────────────────────
  if (["tool_invocation", "tool_call", "function_call", "tool_use"].includes(evType)) {
    const toolName = evData.tool ?? evData.tool_name ?? evData.name ?? "unknown";
    const input    = evData.input ?? evData.arguments ?? evData.parameters ?? {};
    return { type: "tool_call", ts: evData.ts ?? now, tool_name: toolName,
             input: typeof input === "string" ? input : JSON.stringify(input, null, 2),
             step: String(stepCounter + 1) };
  }

  // ── Tool response ─────────────────────────────────────────────────────────
  if (["tool_response", "tool_result", "function_response", "tool_result_block"].includes(evType)) {
    const toolName = evData.tool ?? evData.tool_name ?? evData.name ?? "unknown";
    const output   = evData.output ?? evData.result ?? evData.content ?? {};
    return { type: "tool_result", ts: evData.ts ?? now, tool_name: toolName,
             output: typeof output === "string" ? output : JSON.stringify(output, null, 2) };
  }

  // ── Final / completion ────────────────────────────────────────────────────
  if (["final_response", "final", "completion", "done"].includes(evType)) {
    const text = (evData as Record<string, Record<string, unknown>>)?.output?.text ??
                 (evData as Record<string, Record<string, unknown>>)?.output?.content ??
                 evData?.result ?? evData?.content ?? JSON.stringify(evData);
    let result: unknown;
    try   { result = typeof text === "string" ? JSON.parse(text as string) : text; }
    catch { result = { status: "error", notes: String(text), confidence: 0,
                       ambulance: null, hospital: null, route: null, traffic: null,
                       corridor: null, specialists: [] }; }
    return { type: "final", ts: evData.ts ?? now, result: JSON.stringify(result) };
  }

  // ── Error ─────────────────────────────────────────────────────────────────
  if (evType === "error") {
    return { type: "error", ts: evData.ts ?? now,
             message: evData.message ?? evData.error ?? JSON.stringify(evData) };
  }

  // ── Anything else — surface as a thought so it's visible in the console ───
  if (evType) {
    return { type: "thought", ts: now, content: `[${evType}] ${JSON.stringify(evData).slice(0, 400)}` };
  }
  return null;
}

// Handle POST /api/dispatch — proxy to Orchestrate, stream SSE back to browser
async function handleDispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Read body
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const rawBody = Buffer.concat(chunks).toString("utf-8");

  let payload: Record<string, unknown>;
  try   { payload = JSON.parse(rawBody); }
  catch { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "Invalid JSON" })); return; }

  if (!payload.description) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Missing field: description" }));
    return;
  }

  // Start SSE response
  res.writeHead(200, {
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });

  const sseWrite = (type: string, data: Record<string, unknown>): void => {
    res.write(`data: ${JSON.stringify({ ...data, type })}\n\n`);
  };
  const sseDone = (): void => { res.write("data: [DONE]\n\n"); res.end(); };
  const now = (): string => new Date().toISOString().slice(11, 19);

  let token: string;
  try   { token = await getIAMToken(); }
  catch (err) {
    sseWrite("error", { ts: now(), message: (err as Error).message });
    sseDone(); return;
  }

  // The incident payload is serialised to a natural-language message string
  // so Mission Commander's intake agent can parse it as free-text input.
  const incidentText = typeof payload.description === "string"
    ? `${payload.description}. Location: ${JSON.stringify(payload.location ?? {})}. ` +
      `Type: ${payload.incident_type ?? "Unknown"}. Priority: ${payload.priority ?? "P1"}. ` +
      `Casualties: ${payload.casualties_count ?? 1}.`
    : JSON.stringify(payload);

  // Delegate to the redirect-following multi-candidate function
  postToOrchestrate(incidentText, token, sseWrite, sseDone, now, 0);
}

// ---------------------------------------------------------------------------
// Try Orchestrate API candidate paths in order.
// Follows 301/302/307/308 redirects. Falls through to next candidate on 404/500.
// ---------------------------------------------------------------------------
function buildOrchBody(incidentText: string, variant: "chat" | "runs"): string {
  if (variant === "chat") {
    // OpenAI-style chat format — the standard watsonx Orchestrate chat endpoint
    return JSON.stringify({
      messages: [{ role: "user", content: incidentText }],
    });
  }
  // /runs-style body
  return JSON.stringify({
    input:                { text: incidentText },
    agent_id:             ORCHESTRATE_AGENT_ID,
    agent_environment_id: ORCHESTRATE_ENV_ID,
  });
}

function postToOrchestrate(
  incidentText: string,
  token: string,
  sseWrite: (type: string, data: Record<string, unknown>) => void,
  sseDone: () => void,
  now: () => string,
  candidateIndex: number,
  overridePath?: string,
  overrideHost?: string,        // set when a redirect points to a different hostname
  overrideVariant?: "chat" | "runs"
): void {
  const candidate = ORCHESTRATE_API_CANDIDATES[candidateIndex];
  const apiPath   = overridePath ?? candidate?.[0];
  const variant   = overrideVariant ?? candidate?.[1] ?? "chat";
  const apiHost   = overrideHost ?? ORCHESTRATE_HOST;

  if (!apiPath) {
    sseWrite("error", { ts: now(), message: "All Orchestrate API path candidates exhausted. Check Railway logs for the correct URL." });
    sseDone();
    return;
  }

  const orchBody = buildOrchBody(incidentText, variant);

  console.error(`[Proxy] POST https://${apiHost}${apiPath}  (body-variant: ${variant})`);
  sseWrite("thought", { ts: now(), content: `[proxy] Calling Orchestrate: https://${apiHost}${apiPath}` });

  const orchReq = https.request({
    hostname: apiHost,
    path:     apiPath,
    method:   "POST",
    headers: {
      "Content-Type":   "application/json",
      "Authorization":  `Bearer ${token}`,
      "Accept":         "text/event-stream, application/json",
      "Content-Length": Buffer.byteLength(orchBody),
    },
  }, (orchRes) => {
    const ct     = orchRes.headers["content-type"] ?? "";
    const status = orchRes.statusCode ?? 500;
    console.error(`[Proxy] Orchestrate → ${status} ${ct}`);

    // Follow redirects — extract BOTH host and path from Location header
    if (status === 301 || status === 302 || status === 307 || status === 308) {
      const location = orchRes.headers["location"] ?? "";
      console.error(`[Proxy] Redirect ${status} → ${location}`);
      sseWrite("thought", { ts: now(), content: `[proxy] Redirect ${status} → ${location}` });
      orchRes.on("data", () => {});
      orchRes.on("end", () => {
        let nextHost: string = apiHost;
        let nextPath: string;
        try {
          const loc = new URL(location);
          nextHost = loc.hostname;           // ← carry the new host (e.g. dev-wa.watson-orchestrate.ibm.com)
          nextPath = loc.pathname + loc.search;
        } catch {
          nextPath = location;
        }
        postToOrchestrate(incidentText, token, sseWrite, sseDone, now, candidateIndex, nextPath, nextHost, variant);
      });
      return;
    }

    // On 404 try next candidate
    // Fall through to next candidate on 404 OR 500 (bad body shape), but not on 401/403
    const shouldFallThrough = (status === 404 || status === 500) &&
                              !overridePath &&
                              candidateIndex + 1 < ORCHESTRATE_API_CANDIDATES.length;
    if (shouldFallThrough) {
      let errBody = "";
      orchRes.on("data", (c: Buffer) => (errBody += c));
      orchRes.on("end", () => {
        console.error(`[Proxy] ${status} on candidate ${candidateIndex} — trying next. Body: ${errBody.slice(0, 400)}`);
        sseWrite("thought", { ts: now(), content: `[proxy] ${status} on candidate ${candidateIndex}, trying next path...` });
        postToOrchestrate(incidentText, token, sseWrite, sseDone, now, candidateIndex + 1);
      });
      return;
    }

    if (status >= 400) {
      let errBody = "";
      orchRes.on("data", (c: Buffer) => (errBody += c));
      orchRes.on("end", () => {
        // Log full error body (no truncation) so the exact failure reason is visible
        sseWrite("thought", { ts: now(), content: `Orchestrate ${status} body:\n${errBody}` });
        sseWrite("error",   { ts: now(), message: `Orchestrate ${status} on https://${apiHost}${apiPath}` });
        sseDone();
      });
      return;
    }

    if (ct.includes("text/event-stream")) {
      // ── Streaming ─────────────────────────────────────────────────────
      let buf = ""; let stepCounter = 0;
      orchRes.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf-8");
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const raw = line.slice(5).trim();
          if (raw === "[DONE]") { sseDone(); return; }
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(raw) as Record<string, unknown>; } catch { continue; }
          const norm = normaliseOrchestrateEvent(ev, stepCounter);
          if (!norm) continue;
          if (norm.type === "tool_call") stepCounter++;
          sseWrite(norm.type as string, norm);
          if (norm.type === "final") { sseDone(); return; }
        }
      });
      orchRes.on("end", sseDone);
      orchRes.on("error", (e: Error) => { sseWrite("error", { ts: now(), message: e.message }); sseDone(); });
    } else {
      // ── Non-streaming ─────────────────────────────────────────────────
      let body = "";
      orchRes.on("data", (c: Buffer) => (body += c));
      orchRes.on("end", () => {
        let result: unknown;
        try {
          const json = JSON.parse(body) as Record<string, Record<string, unknown>>;
          const text = json?.output?.text ?? json?.output?.content ?? json?.result ?? body;
          result = typeof text === "string" ? JSON.parse(text as string) : text;
        } catch {
          sseWrite("thought", { ts: now(), content: `Orchestrate raw: ${body.slice(0, 600)}` });
          sseWrite("error",   { ts: now(), message: "Could not parse Orchestrate response as JSON. See raw above." });
          sseDone(); return;
        }
        sseWrite("thought", { ts: now(), content: `Mission Commander complete — Status: ${(result as Record<string,unknown>).status ?? "unknown"}` });
        sseWrite("final",   { ts: now(), result: JSON.stringify(result) });
        sseDone();
      });
      orchRes.on("error", (e: Error) => { sseWrite("error", { ts: now(), message: e.message }); sseDone(); });
    }
  });

  orchReq.on("error", (e: Error) => { sseWrite("error", { ts: now(), message: e.message }); sseDone(); });
  orchReq.write(orchBody);
  orchReq.end();
}

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

      // ── Serve app.html at GET / ──────────────────────────────────────────
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(getAppHtml());
        return;
      }

      // ── Serve premium command center at GET /demo ────────────────────────
      if (req.method === "GET" && url.pathname === "/demo") {
        if (existsSync(COMMAND_CENTER_PATH)) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(readFileSync(COMMAND_CENTER_PATH, "utf-8"));
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("pulseroute-command-center.html not found");
        }
        return;
      }

      // ── Webhook receiver — Orchestrate posts Mission Commander output here ─
      // POST /api/result   { ...mission commander JSON response... }
      // GET  /api/result   app.html polls this to get the latest result
      // DELETE /api/result clears the stored result
      if (req.method === "POST" && url.pathname === "/api/result") {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = Buffer.concat(chunks).toString("utf-8");
        try {
          _latestResult = JSON.parse(body);
          _resultTimestamp = Date.now();
          console.error(`[Webhook] Result received at ${new Date().toISOString()}`);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
          });
          res.end(JSON.stringify({ ok: true, received_at: new Date().toISOString() }));
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON body" }));
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/result") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({
          result:    _latestResult,
          timestamp: _resultTimestamp,
          has_result: _latestResult !== null,
        }));
        return;
      }

      if (req.method === "DELETE" && url.pathname === "/api/result") {
        _latestResult    = null;
        _resultTimestamp = 0;
        res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "OPTIONS" && url.pathname === "/api/result") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin":  "*",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        });
        res.end();
        return;
      }

      // ── IAM token vending — lets the widget authenticate without browser session
      if (req.method === "GET" && url.pathname === "/api/token") {
        try {
          const token = await getIAMToken();
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify({ access_token: token }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: (err as Error).message }));
        }
        return;
      }

      // ── CORS preflight for /api/dispatch ────────────────────────────────
      if (req.method === "OPTIONS" && url.pathname === "/api/dispatch") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin":  "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      // ── Orchestrate proxy ────────────────────────────────────────────────
      if (req.method === "POST" && url.pathname === "/api/dispatch") {
        await handleDispatch(req, res);
        return;
      }

      // ── GET /workflows — list available workflow IDs ─────────────────────
      if (req.method === "GET" && url.pathname === "/workflows") {
        const ids = [
          "emergency-dispatch-workflow",
          "green-corridor-workflow",
          "mci-escalation-workflow",
        ];
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({
          workflows: ids.map((id) => ({
            workflow_id: id,
            url: `/workflows/${id}`,
          })),
        }));
        return;
      }

      // ── GET /workflows/:id — serve a workflow YAML file ──────────────────
      if (req.method === "GET" && url.pathname.startsWith("/workflows/")) {
        const workflowId = url.pathname.slice("/workflows/".length).replace(/[^a-z0-9-]/g, "");
        const yamlPath = resolve(WORKFLOWS_DIR, `${workflowId}.yaml`);
        if (workflowId && existsSync(yamlPath)) {
          res.writeHead(200, {
            "Content-Type": "text/yaml; charset=utf-8",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
            "Content-Disposition": `inline; filename="${workflowId}.yaml"`,
          });
          res.end(readFileSync(yamlPath, "utf-8"));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: `Workflow not found: ${workflowId}` }));
        }
        return;
      }

      // ── Only handle /mcp ────────────────────────────────────────────────
      if (url.pathname !== "/mcp") {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found. Use POST /mcp or GET /" }));
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
