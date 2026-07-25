/**
 * PulseRoute AI — Backend Proxy
 *
 * Sits between app.html and watsonx Orchestrate.
 * Keeps the IBM Cloud API key out of the browser.
 *
 * Endpoint:
 *   POST /api/dispatch
 *     Body: { description, incident_type, priority, location, reported_at }
 *     Response: text/event-stream (SSE)
 *
 * SSE event format consumed by app.html:
 *   data: {"type":"thought",     "ts":"...", "content":"..."}
 *   data: {"type":"tool_call",   "ts":"...", "tool_name":"...", "input":"...", "step":"1/6"}
 *   data: {"type":"tool_result", "ts":"...", "tool_name":"...", "output":"..."}
 *   data: {"type":"final",       "ts":"...", "result":"<JSON string>"}
 *   data: {"type":"error",       "ts":"...", "message":"..."}
 *   data: [DONE]
 *
 * Health probe:
 *   GET /health → 200 JSON
 *
 * Environment variables (set in Railway or .env):
 *   IBM_IAM_API_KEY   — IBM Cloud API key (required)
 *   PORT              — HTTP port (default 4000)
 *   ALLOWED_ORIGIN    — CORS origin (default *)
 */

import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

// ---------------------------------------------------------------------------
// Configuration — hardcoded Orchestrate coordinates from user
//
// Orchestrate instance ID is the first segment of the orchestration run ID:
//   61a7cca026674cb69f1c4e32e8c5c982_9291f63d-e948-4929-9c62-56eecfb515ad
//   └─ instance ID ─────────────────┘
//
// Full API base:
//   https://ca-tor.watson-orchestrate.cloud.ibm.com/instances/<instance-id>
// ---------------------------------------------------------------------------

const ORCHESTRATE_INSTANCE_ID = "61a7cca026674cb69f1c4e32e8c5c982";
const ORCHESTRATE_BASE_URL    = `https://ca-tor.watson-orchestrate.cloud.ibm.com/instances/${ORCHESTRATE_INSTANCE_ID}`;
const AGENT_ID                = "f5bb4d34-12e0-466b-9858-6304e52bc4b7";
const IAM_TOKEN_URL           = "https://iam.cloud.ibm.com/identity/token";

const PORT           = parseInt(process.env.PORT ?? "4000", 10);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? "*";
const IBM_API_KEY    = process.env.IBM_IAM_API_KEY ?? "";

// ---------------------------------------------------------------------------
// IAM token cache
// Fetched once, refreshed 5 minutes before expiry.
// ---------------------------------------------------------------------------

let cachedToken     = "";
let tokenExpiresAt  = 0;          // epoch ms

async function getIAMToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  if (!IBM_API_KEY) {
    throw new Error(
      "IBM_IAM_API_KEY environment variable is not set. " +
      "Add it to Railway environment variables."
    );
  }

  const body = new URLSearchParams({
    grant_type: "urn:ibm:params:oauth:grant-type:apikey",
    apikey:     IBM_API_KEY,
  }).toString();

  const data = await httpsPost(IAM_TOKEN_URL, body, {
    "Content-Type":  "application/x-www-form-urlencoded",
    "Accept":        "application/json",
  });

  const json = JSON.parse(data);
  if (!json.access_token) {
    throw new Error(`IAM token exchange failed: ${data}`);
  }

  cachedToken    = json.access_token;
  // expires_in is in seconds; subtract 5 minutes as safety margin
  tokenExpiresAt = now + (json.expires_in - 300) * 1000;
  console.error(`[IAM] Token refreshed — expires in ${json.expires_in}s`);
  return cachedToken;
}

// ---------------------------------------------------------------------------
// Orchestrate invocation
//
// Sends the incident payload to Mission Commander.
// Orchestrate returns either:
//   A) A single JSON response  (non-streaming mode)
//   B) An SSE stream           (streaming mode, if supported)
//
// We handle both: if the response is text/event-stream we relay events
// directly; if it is application/json we synthesise a final event.
// ---------------------------------------------------------------------------

async function invokeOrchestrate(payload, sseWriter) {
  const token = await getIAMToken();

  const invokeUrl  = `${ORCHESTRATE_BASE_URL}/v1/agents/${AGENT_ID}/runs`;
  const parsedUrl  = new URL(invokeUrl);

  // Build the Orchestrate request body.
  // Mission Commander receives the full incident as a structured message.
  const orchBody = JSON.stringify({
    input: {
      message: JSON.stringify(payload),
    },
    stream: true,          // request SSE if Orchestrate supports it
  });

  console.error(`[Proxy] POST ${invokeUrl}`);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: parsedUrl.hostname,
      path:     parsedUrl.pathname + parsedUrl.search,
      method:   "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${token}`,
        "Accept":        "text/event-stream, application/json",
        "Content-Length": Buffer.byteLength(orchBody),
      },
    };

    const req = https.request(options, (orchRes) => {
      const contentType = orchRes.headers["content-type"] ?? "";
      console.error(`[Proxy] Orchestrate → ${orchRes.statusCode} ${contentType}`);

      if (orchRes.statusCode >= 400) {
        let errBody = "";
        orchRes.on("data", (c) => (errBody += c));
        orchRes.on("end", () => {
          sseWriter.event("error", {
            ts:      ts(),
            message: `Orchestrate returned ${orchRes.statusCode}: ${errBody}`,
          });
          sseWriter.done();
          resolve();
        });
        return;
      }

      if (contentType.includes("text/event-stream")) {
        // ── Streaming path — relay SSE events verbatim ───────────────────
        relayOrchestrateSSE(orchRes, sseWriter, resolve);
      } else {
        // ── Non-streaming path — buffer full response, synthesise events ─
        bufferAndSynthesize(orchRes, sseWriter, resolve);
      }
    });

    req.on("error", (err) => {
      sseWriter.event("error", { ts: ts(), message: err.message });
      sseWriter.done();
      reject(err);
    });

    req.write(orchBody);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Streaming path — Orchestrate returns text/event-stream
// We forward each event to the browser after normalising the shape.
// ---------------------------------------------------------------------------

function relayOrchestrateSSE(orchRes, sseWriter, resolve) {
  let buf = "";
  let stepCounter = 0;

  orchRes.on("data", (chunk) => {
    buf += chunk.toString("utf-8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim();
      if (raw === "[DONE]") {
        sseWriter.done();
        resolve();
        return;
      }

      let ev;
      try { ev = JSON.parse(raw); } catch { continue; }

      // Orchestrate event shapes vary by version.
      // Normalise into the shapes app.html expects.
      const normalised = normaliseOrchestrateEvent(ev, stepCounter);
      if (!normalised) continue;

      if (normalised.type === "tool_call")   stepCounter++;
      if (normalised.type === "final")       { sseWriter.event("final", normalised); sseWriter.done(); resolve(); return; }

      sseWriter.event(normalised.type, normalised);
    }
  });

  orchRes.on("end", () => {
    sseWriter.done();
    resolve();
  });

  orchRes.on("error", (err) => {
    sseWriter.event("error", { ts: ts(), message: err.message });
    sseWriter.done();
    resolve();
  });
}

// ---------------------------------------------------------------------------
// Non-streaming path — buffer full JSON, synthesise a final event
// ---------------------------------------------------------------------------

function bufferAndSynthesize(orchRes, sseWriter, resolve) {
  let body = "";
  orchRes.on("data", (c) => (body += c));
  orchRes.on("end", () => {
    let result;
    try {
      const json = JSON.parse(body);
      // Orchestrate wraps output in output.text or output.content
      const text =
        json?.output?.text ??
        json?.output?.content ??
        json?.result ??
        body;
      result = typeof text === "string" ? JSON.parse(text) : text;
    } catch {
      sseWriter.event("thought", {
        ts:      ts(),
        content: `Mission Commander responded (raw): ${body.slice(0, 400)}`,
      });
      sseWriter.event("error", {
        ts:      ts(),
        message: "Could not parse Mission Commander response as JSON.",
      });
      sseWriter.done();
      resolve();
      return;
    }

    // Emit a thought so the MCP console shows something
    sseWriter.event("thought", {
      ts:      ts(),
      content: `Mission Commander synthesis complete — Status: ${result.status ?? "unknown"}`,
    });

    // Emit the final deployment decision
    sseWriter.event("final", {
      ts:     ts(),
      result: JSON.stringify(result),
    });

    sseWriter.done();
    resolve();
  });

  orchRes.on("error", (err) => {
    sseWriter.event("error", { ts: ts(), message: err.message });
    sseWriter.done();
    resolve();
  });
}

// ---------------------------------------------------------------------------
// Event normaliser — maps Orchestrate SSE event shapes to app.html shapes
//
// Orchestrate may emit events like:
//   { event: "agent_message",    data: { content: "..." } }
//   { event: "tool_invocation",  data: { tool: "...", input: {...} } }
//   { event: "tool_response",    data: { tool: "...", output: {...} } }
//   { event: "final_response",   data: { output: { text: "..." } } }
//
// These are mapped to: thought / tool_call / tool_result / final / error
// ---------------------------------------------------------------------------

function normaliseOrchestrateEvent(ev, stepCounter) {
  const now = ts();
  const evType  = ev.event ?? ev.type ?? "";
  const evData  = ev.data  ?? ev;

  // Agent reasoning / thought
  if (
    evType === "agent_message" ||
    evType === "thought"       ||
    evType === "message"
  ) {
    return {
      type:    "thought",
      ts:      evData.ts ?? now,
      content: evData.content ?? evData.text ?? JSON.stringify(evData),
    };
  }

  // Tool call (invocation)
  if (
    evType === "tool_invocation" ||
    evType === "tool_call"       ||
    evType === "function_call"
  ) {
    const toolName = evData.tool ?? evData.tool_name ?? evData.name ?? "unknown";
    const input    = evData.input ?? evData.arguments ?? evData.parameters ?? {};
    return {
      type:      "tool_call",
      ts:        evData.ts ?? now,
      tool_name: toolName,
      input:     typeof input === "string" ? input : JSON.stringify(input, null, 2),
      step:      `${stepCounter + 1}`,
    };
  }

  // Tool result (response)
  if (
    evType === "tool_response" ||
    evType === "tool_result"   ||
    evType === "function_response"
  ) {
    const toolName = evData.tool ?? evData.tool_name ?? evData.name ?? "unknown";
    const output   = evData.output ?? evData.result ?? evData.content ?? {};
    return {
      type:      "tool_result",
      ts:        evData.ts ?? now,
      tool_name: toolName,
      output:    typeof output === "string" ? output : JSON.stringify(output, null, 2),
    };
  }

  // Final response
  if (
    evType === "final_response" ||
    evType === "final"          ||
    evType === "completion"
  ) {
    const text =
      evData?.output?.text    ??
      evData?.output?.content ??
      evData?.result          ??
      evData?.content         ??
      JSON.stringify(evData);

    let result;
    try   { result = typeof text === "string" ? JSON.parse(text) : text; }
    catch { result = { status: "error", notes: text, confidence: 0, ambulance: null, hospital: null, route: null, traffic: null, corridor: null, specialists: [] }; }

    return {
      type:   "final",
      ts:     evData.ts ?? now,
      result: JSON.stringify(result),
    };
  }

  // Error
  if (evType === "error") {
    return {
      type:    "error",
      ts:      evData.ts ?? now,
      message: evData.message ?? evData.error ?? JSON.stringify(evData),
    };
  }

  // Unknown event — log as thought so it's visible in the console
  if (evType) {
    return {
      type:    "thought",
      ts:      now,
      content: `[${evType}] ${JSON.stringify(evData).slice(0, 300)}`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// SSE writer helper
// ---------------------------------------------------------------------------

function makeSseWriter(res) {
  res.writeHead(200, {
    "Content-Type":  "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection":    "keep-alive",
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Expose-Headers": "X-Incident-Location",
  });

  return {
    event(type, data) {
      const payload = JSON.stringify({ ...data, type });
      res.write(`data: ${payload}\n\n`);
    },
    raw(line) {
      res.write(`${line}\n\n`);
    },
    done() {
      res.write("data: [DONE]\n\n");
      res.end();
    },
  };
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // ── CORS preflight ──────────────────────────────────────────────────────
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin":  ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end();
    return;
  }

  // ── Health probe ────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    });
    res.end(JSON.stringify({
      status:          "ok",
      service:         "pulseroute-proxy",
      instance_id:     ORCHESTRATE_INSTANCE_ID,
      orchestrate_url: ORCHESTRATE_BASE_URL,
      agent_id:        AGENT_ID,
      invoke_url:      `${ORCHESTRATE_BASE_URL}/v1/agents/${AGENT_ID}/runs`,
    }));
    return;
  }

  // ── POST /api/dispatch — main integration endpoint ──────────────────────
  if (req.method === "POST" && url.pathname === "/api/dispatch") {
    // Read request body
    let body = "";
    for await (const chunk of req) body += chunk;

    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON body" }));
      return;
    }

    if (!payload.description) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing required field: description" }));
      return;
    }

    // Echo incident location in response header so app.html can pin it on
    // the map before the first SSE event arrives.
    const incidentLat = payload.location?.latitude  ?? 12.9176;
    const incidentLng = payload.location?.longitude ?? 77.6237;
    const incidentName = payload.location?.locality ?? "Incident";

    const sseWriter = makeSseWriter(res);
    // Inject X-Incident-Location so the map pin draws immediately
    res.setHeader("X-Incident-Location", JSON.stringify({
      lat:  incidentLat,
      lng:  incidentLng,
      name: incidentName,
    }));

    console.error(`[Proxy] Dispatch request — type=${payload.incident_type} priority=${payload.priority}`);

    try {
      await invokeOrchestrate(payload, sseWriter);
    } catch (err) {
      console.error("[Proxy] Fatal error:", err);
      // sseWriter.done() already called inside invokeOrchestrate on error
    }
    return;
  }

  // ── 404 ─────────────────────────────────────────────────────────────────
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found. Use POST /api/dispatch" }));
});

server.listen(PORT, () => {
  console.error(`PulseRoute Proxy v1.0.0`);
  console.error(`Listening on http://0.0.0.0:${PORT}`);
  console.error(`Orchestrate : ${ORCHESTRATE_BASE_URL}`);
  console.error(`Agent ID    : ${AGENT_ID}`);
  console.error(`Endpoint    : POST /api/dispatch`);
  console.error(`Health      : GET  /health`);
});

process.on("SIGTERM", () => { console.error("[Proxy] Shutdown"); server.close(() => process.exit(0)); });
process.on("SIGINT",  () => { console.error("[Proxy] Shutdown"); server.close(() => process.exit(0)); });

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function ts() {
  return new Date().toISOString().slice(11, 19);
}

function httpsPost(url, body, headers) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname,
      method:   "POST",
      headers:  { ...headers, "Content-Length": Buffer.byteLength(body) },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
