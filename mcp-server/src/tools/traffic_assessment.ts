/**
 * Tool: traffic_assessment
 *
 * Assesses current traffic conditions around an incident location by:
 *   1. Finding all traffic signals within a configurable radius (default 10 km)
 *   2. Ranking them by congestion_index
 *   3. Identifying affected road corridors from connected_corridors fields
 *   4. Computing expected delay and traffic risk level
 *
 * Data sources:
 *   - data/traffic_signals.json
 *   - data/road_network.json
 *
 * Sample request:
 *   {
 *     "incident_location": {
 *       "latitude": 12.9176,
 *       "longitude": 77.6237,
 *       "locality_name": "Silk Board"
 *     }
 *   }
 *
 * Sample response:
 *   {
 *     "incident_locality": "Silk Board",
 *     "radius_km": 10,
 *     "peak_hour_active": true,
 *     "congestion_level": "CRITICAL",
 *     "traffic_risk": "HIGH",
 *     "congestion_score": 9.8,
 *     "expected_delay_minutes": 7,
 *     "affected_signals": [...],
 *     "affected_roads": [...],
 *     "emergency_routes_available": [...],
 *     "preemption_capable_signals": [...],
 *     "routing_recommendation": "Avoid Silk Board Junction (9.8/10). Use NICE Road (RD002) as primary alternate."
 *   }
 */

import { z } from "zod";
import { getTrafficSignals, getRoadNetwork, haversineKm, isPeakHour } from "../types/schemas.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const TrafficAssessmentInputSchema = z.object({
  incident_location: z
    .object({
      latitude: z
        .number()
        .min(-90)
        .max(90)
        .describe("Incident latitude in decimal degrees"),
      longitude: z
        .number()
        .min(-180)
        .max(180)
        .describe("Incident longitude in decimal degrees"),
      locality_name: z
        .string()
        .optional()
        .describe("Optional human-readable locality name for display purposes"),
    })
    .describe("GPS coordinates of the incident"),
  radius_km: z
    .number()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe(
      "Search radius in kilometres around the incident. Default 10 km covers most Bengaluru zones."
    ),
});

export type TrafficAssessmentInput = z.infer<typeof TrafficAssessmentInputSchema>;

// ---------------------------------------------------------------------------
// Congestion level thresholds
// ---------------------------------------------------------------------------

function getCongestionLevel(index: number): string {
  if (index >= 9.5) return "CRITICAL";
  if (index >= 8.5) return "SEVERE";
  if (index >= 7.0) return "HIGH";
  if (index >= 5.0) return "MODERATE";
  return "LOW";
}

function getTrafficRisk(level: string, peak: boolean): string {
  if (level === "CRITICAL" && peak) return "CRITICAL";
  if (level === "CRITICAL" || (level === "SEVERE" && peak)) return "HIGH";
  if (level === "SEVERE" || level === "HIGH") return "MEDIUM";
  return "LOW";
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export function trafficAssessment(input: TrafficAssessmentInput): Record<string, unknown> {
  const { incident_location, radius_km = 10 } = input;
  const { latitude, longitude, locality_name } = incident_location;

  const signals = getTrafficSignals();
  const roads   = getRoadNetwork();
  const peak    = isPeakHour();

  // Find all signals within radius
  const nearbySignals = signals
    .map((s) => ({
      signal: s,
      distance_km: haversineKm(latitude, longitude, s.lat, s.lng),
    }))
    .filter((s) => s.distance_km <= radius_km)
    .sort((a, b) => b.signal.congestion_index - a.signal.congestion_index);

  if (nearbySignals.length === 0) {
    return {
      incident_locality: locality_name ?? `${latitude},${longitude}`,
      radius_km,
      peak_hour_active: peak,
      congestion_level: "UNKNOWN",
      traffic_risk: "UNKNOWN",
      congestion_score: null,
      expected_delay_minutes: null,
      affected_signals: [],
      affected_roads: [],
      message: `No traffic signal data found within ${radius_km} km of this location.`,
    };
  }

  // Highest congestion signal in radius
  const worstSignal = nearbySignals[0];
  const peakDelaySec = peak
    ? worstSignal.signal.peak_delay_seconds
    : Math.round(worstSignal.signal.peak_delay_seconds * 0.35);
  const expected_delay_minutes = Math.ceil(peakDelaySec / 60);

  // Collect unique affected corridor IDs from all nearby signals
  const affectedCorridorIds = new Set<string>();
  for (const { signal } of nearbySignals) {
    for (const cid of signal.connected_corridors) {
      affectedCorridorIds.add(cid);
    }
  }

  // Enrich with road data
  const affectedRoads = roads
    .filter((r) => affectedCorridorIds.has(r.id))
    .map((r) => ({
      road_id: r.id,
      road_name: r.name,
      from: r.from_locality,
      to: r.to_locality,
      distance_km: r.distance_km,
      typical_speed_kmh: r.typical_speed_kmh,
      peak_speed_kmh: r.peak_hour_speed_kmh,
      emergency_route: r.emergency_route,
      has_signal_preemption: r.has_signal_preemption,
      known_bottlenecks: r.known_bottlenecks,
      alternate_routes: r.alternate_routes,
    }));

  const emergencyRoutes = affectedRoads.filter((r) => r.emergency_route);
  const preemptibleSignals = nearbySignals
    .filter((s) => s.signal.signal_preemption_capable)
    .map((s) => ({
      signal_id: s.signal.id,
      intersection: s.signal.intersection_name,
      locality: s.signal.locality,
      congestion_index: s.signal.congestion_index,
      distance_km: parseFloat(s.distance_km.toFixed(2)),
    }));

  // Routing recommendation text
  const highCongestion = nearbySignals.filter(
    (s) => s.signal.congestion_index >= 9.0 && !s.signal.signal_preemption_capable
  );
  const recommendationParts: string[] = [];
  if (highCongestion.length > 0) {
    const names = highCongestion
      .map((s) => `${s.signal.intersection_name} (${s.signal.congestion_index}/10)`)
      .join(", ");
    recommendationParts.push(`Avoid: ${names}.`);
  }
  const niceRoad = roads.find((r) => r.id === "RD002");
  if (niceRoad && worstSignal.signal.congestion_index >= 9.0) {
    recommendationParts.push(
      `Use NICE Road (RD002) as primary bypass — ${niceRoad.typical_speed_kmh} km/h typical, no high-congestion signals.`
    );
  }
  if (preemptibleSignals.length > 0) {
    recommendationParts.push(
      `${preemptibleSignals.length} signal-preemption-capable junction(s) on route — activate via ERSS 112.`
    );
  }
  if (peak) {
    recommendationParts.push("Peak hour in effect — allow extra 40-60% time buffer.");
  }

  const congestionLevel = getCongestionLevel(worstSignal.signal.congestion_index);
  const trafficRisk     = getTrafficRisk(congestionLevel, peak);

  return {
    incident_locality: locality_name ?? `${latitude.toFixed(4)},${longitude.toFixed(4)}`,
    radius_km,
    peak_hour_active: peak,
    congestion_level: congestionLevel,
    traffic_risk: trafficRisk,
    congestion_score: worstSignal.signal.congestion_index,
    expected_delay_minutes,
    worst_junction: {
      signal_id: worstSignal.signal.id,
      intersection_name: worstSignal.signal.intersection_name,
      locality: worstSignal.signal.locality,
      congestion_index: worstSignal.signal.congestion_index,
      peak_delay_seconds: worstSignal.signal.peak_delay_seconds,
      signal_preemption_capable: worstSignal.signal.signal_preemption_capable,
      distance_km: parseFloat(worstSignal.distance_km.toFixed(2)),
    },
    affected_signals: nearbySignals.map((s) => ({
      signal_id: s.signal.id,
      intersection_name: s.signal.intersection_name,
      locality: s.signal.locality,
      congestion_index: s.signal.congestion_index,
      peak_delay_seconds: peak ? s.signal.peak_delay_seconds : Math.round(s.signal.peak_delay_seconds * 0.35),
      signal_preemption_capable: s.signal.signal_preemption_capable,
      distance_km: parseFloat(s.distance_km.toFixed(2)),
    })),
    affected_roads: affectedRoads,
    emergency_routes_available: emergencyRoutes,
    preemption_capable_signals: preemptibleSignals,
    routing_recommendation: recommendationParts.join(" ") || "No critical congestion detected in this radius.",
  };
}
