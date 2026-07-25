/**
 * Tool: calculate_route
 *
 * Computes the best ambulance route between two Bengaluru localities by:
 *   1. Matching source and destination to road corridor endpoints
 *   2. Selecting the road with the best emergency speed profile
 *   3. Identifying an alternate route from the road's alternate_routes field
 *   4. Accounting for peak-hour speed conditions
 *   5. Flagging high-congestion junctions on the path
 *
 * Data sources:
 *   - data/road_network.json
 *   - data/traffic_signals.json
 *
 * Sample request:
 *   {
 *     "source": { "locality": "Hebbal", "latitude": 13.035, "longitude": 77.597 },
 *     "destination": { "locality": "Silk Board", "latitude": 12.917, "longitude": 77.623 }
 *   }
 *
 * Sample response:
 *   {
 *     "source": "Hebbal",
 *     "destination": "Silk Board",
 *     "recommended_route": {
 *       "road_id": "RD001",
 *       "road_name": "Outer Ring Road (ORR) – Hebbal to Silk Board",
 *       "distance_km": 34.2,
 *       "eta_minutes": 38,
 *       "speed_used_kmh": 55,
 *       "emergency_route": true,
 *       "signal_preemption": true,
 *       "bottlenecks": [...],
 *       "congested_junctions": [...]
 *     },
 *     "alternate_route": {
 *       "road_name": "NICE Road (Peripheral Ring Road)",
 *       "distance_km": 65.0,
 *       "eta_minutes": 60,
 *       "reason": "Lower congestion alternative"
 *     },
 *     "eta_minutes": 38,
 *     "distance_km": 34.2,
 *     "peak_hour_active": false,
 *     "routing_notes": "..."
 *   }
 */

import { z } from "zod";
import { getRoadNetwork, getTrafficSignals, haversineKm, isPeakHour } from "../types/schemas.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

const LocationSchema = z.object({
  locality: z
    .string()
    .describe("Human-readable locality name (e.g. 'Hebbal', 'Silk Board', 'Koramangala')"),
  latitude: z
    .number()
    .min(-90)
    .max(90)
    .optional()
    .describe("Optional GPS latitude for precise distance scoring"),
  longitude: z
    .number()
    .min(-180)
    .max(180)
    .optional()
    .describe("Optional GPS longitude for precise distance scoring"),
});

export const CalculateRouteInputSchema = z.object({
  source: LocationSchema.describe("Origin location — ambulance or incident start point"),
  destination: LocationSchema.describe("Destination location — target hospital or handover point"),
});

export type CalculateRouteInput = z.infer<typeof CalculateRouteInputSchema>;

// ---------------------------------------------------------------------------
// Locality fuzzy matcher — returns true if a road endpoint contains the query
// ---------------------------------------------------------------------------

function localityMatches(endpoint: string, query: string): boolean {
  return endpoint.toLowerCase().includes(query.toLowerCase()) ||
    query.toLowerCase().includes(endpoint.toLowerCase().split(" ")[0]);
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export function calculateRoute(input: CalculateRouteInput): Record<string, unknown> {
  const { source, destination } = input;
  const roads   = getRoadNetwork();
  const signals = getTrafficSignals();
  const peak    = isPeakHour();

  // ---------------------------------------------------------------------------
  // Step 1: Find candidate roads that connect source → destination direction
  // Scoring: direct locality match > partial match > GPS proximity (if provided)
  // ---------------------------------------------------------------------------

  type ScoredRoad = {
    road: typeof roads[number];
    score: number;
    isDirectMatch: boolean;
    distance_km: number;
    eta_minutes: number;
    speed_used: number;
    congested_junctions: Array<{
      junction: string;
      congestion_index: number;
      peak_delay_seconds: number;
      preemption_capable: boolean;
    }>;
  };

  const scored: ScoredRoad[] = [];

  for (const road of roads) {
    let score = 0;
    const fromMatch =
      localityMatches(road.from_locality, source.locality) ||
      localityMatches(road.to_locality, source.locality);
    const toMatch =
      localityMatches(road.to_locality, destination.locality) ||
      localityMatches(road.from_locality, destination.locality);

    const directMatch = fromMatch && toMatch;
    const partialMatch = fromMatch || toMatch;

    if (!directMatch && !partialMatch) continue;

    if (directMatch) score += 200;
    else if (partialMatch) score += 80;

    // Prefer emergency routes
    if (road.emergency_route) score += 50;
    // Prefer signal preemption
    if (road.has_signal_preemption) score += 30;

    // Speed score — use peak or typical
    const speedUsed  = peak ? road.peak_hour_speed_kmh : road.typical_speed_kmh;
    const eta_min    = Math.ceil((road.distance_km / speedUsed) * 60);
    score += Math.max(0, 100 - eta_min); // faster = higher score

    // GPS proximity scoring (bonus when lat/lng provided)
    let distance_km = road.distance_km; // default = road length as proxy
    if (source.latitude && source.longitude && destination.latitude && destination.longitude) {
      // Straight-line source→dest as a minimum bound
      const crowFly = haversineKm(
        source.latitude, source.longitude,
        destination.latitude, destination.longitude
      );
      distance_km = Math.max(road.distance_km, crowFly);
      score += Math.max(0, 50 - crowFly);
    }

    // Find congested signals on this road's corridors
    const congested_junctions = signals
      .filter((s) =>
        s.connected_corridors.includes(road.id) && s.congestion_index >= 8.0
      )
      .map((s) => ({
        junction: s.intersection_name,
        congestion_index: s.congestion_index,
        peak_delay_seconds: peak ? s.peak_delay_seconds : Math.round(s.peak_delay_seconds * 0.35),
        preemption_capable: s.signal_preemption_capable,
      }))
      .sort((a, b) => b.congestion_index - a.congestion_index);

    // Penalise routes with non-preemptible high-congestion junctions
    const nonPreemptibleBlocks = congested_junctions.filter(
      (j) => j.congestion_index >= 9.0 && !j.preemption_capable
    );
    score -= nonPreemptibleBlocks.length * 40;

    scored.push({
      road,
      score,
      isDirectMatch: directMatch,
      distance_km: parseFloat(distance_km.toFixed(2)),
      eta_minutes: eta_min,
      speed_used: speedUsed,
      congested_junctions,
    });
  }

  // ---------------------------------------------------------------------------
  // Step 2: If no road matches, fall back to a generic NICE Road / ORR recommendation
  // ---------------------------------------------------------------------------

  if (scored.length === 0) {
    const orr  = roads.find((r) => r.id === "RD001")!;
    const nice = roads.find((r) => r.id === "RD002")!;
    const speedOrr  = peak ? orr.peak_hour_speed_kmh  : orr.typical_speed_kmh;
    const speedNice = peak ? nice.peak_hour_speed_kmh : nice.typical_speed_kmh;

    return {
      source: source.locality,
      destination: destination.locality,
      recommended_route: {
        road_id: orr.id,
        road_name: orr.name,
        distance_km: orr.distance_km,
        eta_minutes: Math.ceil((orr.distance_km / speedOrr) * 60),
        speed_used_kmh: speedOrr,
        emergency_route: orr.emergency_route,
        signal_preemption: orr.has_signal_preemption,
        bottlenecks: orr.known_bottlenecks,
        congested_junctions: [],
      },
      alternate_route: {
        road_id: nice.id,
        road_name: nice.name,
        distance_km: nice.distance_km,
        eta_minutes: Math.ceil((nice.distance_km / speedNice) * 60),
        speed_used_kmh: speedNice,
        reason: "No direct corridor found — NICE Road (peripheral bypass) recommended as alternate",
      },
      eta_minutes: Math.ceil((orr.distance_km / speedOrr) * 60),
      distance_km: orr.distance_km,
      peak_hour_active: peak,
      routing_notes:
        `No road corridor in the knowledge base directly connects '${source.locality}' ` +
        `to '${destination.locality}'. Outer Ring Road and NICE Road recommended as ` +
        `primary emergency corridors. Provide GPS coordinates for more precise routing.`,
    };
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  // ---------------------------------------------------------------------------
  // Step 3: Resolve alternate route
  // Use the road's own alternate_routes list, then cross-reference roads by name
  // ---------------------------------------------------------------------------

  let alternateRouteResult: Record<string, unknown> | null = null;

  const altRoadNames: string[] = best.road.alternate_routes;
  for (const altName of altRoadNames) {
    const altRoad = roads.find(
      (r) => r.name.toLowerCase().includes(altName.toLowerCase().split("(")[0].trim()) ||
             altName.toLowerCase().includes(r.name.toLowerCase().split("(")[0].trim())
    );
    if (altRoad) {
      const altSpeed  = peak ? altRoad.peak_hour_speed_kmh : altRoad.typical_speed_kmh;
      const altEta    = Math.ceil((altRoad.distance_km / altSpeed) * 60);
      const altJunctions = signals
        .filter((s) => s.connected_corridors.includes(altRoad.id) && s.congestion_index >= 8.0)
        .map((s) => ({
          junction: s.intersection_name,
          congestion_index: s.congestion_index,
          preemption_capable: s.signal_preemption_capable,
        }));

      alternateRouteResult = {
        road_id: altRoad.id,
        road_name: altRoad.name,
        from: altRoad.from_locality,
        to: altRoad.to_locality,
        distance_km: altRoad.distance_km,
        eta_minutes: altEta,
        speed_used_kmh: altSpeed,
        emergency_route: altRoad.emergency_route,
        signal_preemption: altRoad.has_signal_preemption,
        congested_junctions: altJunctions,
        reason: `Listed as alternate for ${best.road.name}`,
      };
      break;
    }
  }

  // Fallback alternate: second scored road
  if (!alternateRouteResult && scored.length > 1) {
    const second = scored[1];
    alternateRouteResult = {
      road_id: second.road.id,
      road_name: second.road.name,
      distance_km: second.distance_km,
      eta_minutes: second.eta_minutes,
      speed_used_kmh: second.speed_used,
      emergency_route: second.road.emergency_route,
      signal_preemption: second.road.has_signal_preemption,
      congested_junctions: second.congested_junctions,
      reason: "Second-best scored corridor from knowledge base",
    };
  }

  // ---------------------------------------------------------------------------
  // Step 4: Build routing notes
  // ---------------------------------------------------------------------------

  const notes: string[] = [];
  if (peak) notes.push("Peak hour active — ETA may be 40-60% higher than listed.");
  if (best.road.emergency_route) notes.push("Route designated as emergency corridor.");
  if (best.road.has_signal_preemption) {
    notes.push("Signal preemption available on this corridor — activate via ERSS 112.");
  }
  const critical = best.congested_junctions.filter(
    (j) => j.congestion_index >= 9.0 && !j.preemption_capable
  );
  if (critical.length > 0) {
    notes.push(
      `Critical non-preemptible junctions on route: ${critical.map((j) => j.junction).join(", ")}. Consider alternate.`
    );
  }

  return {
    source: source.locality,
    destination: destination.locality,
    recommended_route: {
      road_id: best.road.id,
      road_name: best.road.name,
      from: best.road.from_locality,
      to: best.road.to_locality,
      distance_km: best.distance_km,
      eta_minutes: best.eta_minutes,
      speed_used_kmh: best.speed_used,
      emergency_route: best.road.emergency_route,
      signal_preemption: best.road.has_signal_preemption,
      lanes: best.road.lanes,
      road_type: best.road.road_type,
      bottlenecks: best.road.known_bottlenecks,
      congested_junctions: best.congested_junctions,
    },
    alternate_route: alternateRouteResult,
    eta_minutes: best.eta_minutes,
    distance_km: best.distance_km,
    peak_hour_active: peak,
    routing_notes: notes.join(" ") || "No special routing conditions detected.",
  };
}
