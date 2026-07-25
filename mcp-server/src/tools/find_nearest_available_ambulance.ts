/**
 * Tool: find_nearest_available_ambulance
 *
 * Scans data/ambulances.json and returns the closest available ambulance
 * to the caller's GPS coordinates, filtered by requested type if provided.
 *
 * Distance is calculated with the Haversine formula.
 * ETA accounts for peak-hour traffic conditions.
 *
 * Sample request:
 *   {
 *     "latitude": 12.9716,
 *     "longitude": 77.5946,
 *     "ambulance_type": "ALS"
 *   }
 *
 * Sample response:
 *   {
 *     "ambulance_id": "AMB-001",
 *     "call_sign": "KA-108-N01",
 *     "ambulance_type": "ALS",
 *     "vehicle_make": "Tata Winger",
 *     "current_locality": "Hebbal",
 *     "current_lat": 13.045,
 *     "current_lng": 77.5946,
 *     "availability_status": "available",
 *     "response_zone": "North",
 *     "crew": [{ "paramedic_name": "Rajesh Kumar", "emt_name": "Suresh Naik" }],
 *     "equipment": ["Cardiac Monitor/Defibrillator", "Ventilator", ...],
 *     "comms_channel": "CH-04",
 *     "distance_km": 7.4,
 *     "eta_minutes": 14,
 *     "peak_hour_active": false,
 *     "note": "Nearest available ALS unit. ETA is estimated at typical traffic speed."
 *   }
 */

import { z } from "zod";
import { getAmbulances, haversineKm, isPeakHour } from "../types/schemas.js";

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const FindAmbulanceInputSchema = z.object({
  latitude: z
    .number()
    .min(-90)
    .max(90)
    .describe("Incident latitude in decimal degrees (WGS84)"),
  longitude: z
    .number()
    .min(-180)
    .max(180)
    .describe("Incident longitude in decimal degrees (WGS84)"),
  ambulance_type: z
    .enum(["ALS", "BLS", "MICU", "Neonatal", "any"])
    .optional()
    .default("any")
    .describe(
      "Preferred ambulance type. ALS = Advanced Life Support (paramedic + full drug box). " +
        "BLS = Basic Life Support. MICU = Mobile ICU. Neonatal = neonatal transport. " +
        "Use 'any' when type does not matter."
    ),
});

export type FindAmbulanceInput = z.infer<typeof FindAmbulanceInputSchema>;

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export function findNearestAvailableAmbulance(input: FindAmbulanceInput): Record<string, unknown> {
  const { latitude, longitude, ambulance_type } = input;
  const allAmbulances = getAmbulances();
  const peak = isPeakHour();

  // Filter: only available units; apply type filter unless 'any'
  const candidates = allAmbulances.filter((a) => {
    if (a.status !== "available") return false;
    if (ambulance_type && ambulance_type !== "any" && a.type !== ambulance_type) return false;
    return true;
  });

  if (candidates.length === 0) {
    // Fall back to standby units if no available units match
    const standby = allAmbulances.filter((a) => {
      if (a.status !== "standby") return false;
      if (ambulance_type && ambulance_type !== "any" && a.type !== ambulance_type) return false;
      return true;
    });

    if (standby.length === 0) {
      return {
        error: true,
        message: `No ${ambulance_type !== "any" ? ambulance_type + " " : ""}ambulances are currently available or on standby.`,
        total_fleet_size: allAmbulances.length,
        suggestion: "Contact ERSS 112 or Karnataka 108 for assisted dispatch.",
      };
    }

    // Use standby units with a note
    candidates.push(...standby);
  }

  // Rank by Haversine distance
  const ranked = candidates
    .map((a) => ({
      ambulance: a,
      distance_km: haversineKm(latitude, longitude, a.current_lat, a.current_lng),
    }))
    .sort((a, b) => a.distance_km - b.distance_km);

  const best = ranked[0];
  const { ambulance, distance_km } = best;

  // ETA: use peak-hour speed ~20 km/h or typical ~45 km/h for ambulances with sirens
  const speedKmh = peak ? 22 : 45;
  const eta_minutes = Math.ceil((distance_km / speedKmh) * 60);

  // Build result
  return {
    ambulance_id: ambulance.id,
    call_sign: ambulance.call_sign,
    ambulance_type: ambulance.type,
    vehicle_make: ambulance.vehicle_make,
    vehicle_year: ambulance.year,
    current_locality: ambulance.current_locality,
    current_lat: ambulance.current_lat,
    current_lng: ambulance.current_lng,
    availability_status: ambulance.status,
    response_zone: ambulance.response_zone,
    crew: ambulance.crew,
    equipment: ambulance.equipment,
    comms_channel: ambulance.comms_channel,
    distance_km: parseFloat(distance_km.toFixed(2)),
    eta_minutes,
    peak_hour_active: peak,
    alternatives_available: ranked.slice(1, 3).map((r) => ({
      ambulance_id: r.ambulance.id,
      call_sign: r.ambulance.call_sign,
      type: r.ambulance.type,
      locality: r.ambulance.current_locality,
      distance_km: parseFloat(r.distance_km.toFixed(2)),
      eta_minutes: Math.ceil((r.distance_km / speedKmh) * 60),
    })),
    note:
      ambulance.status === "standby"
        ? "No available units found — nearest STANDBY unit returned. Confirm activation before dispatch."
        : `Nearest available ${ambulance.type} unit. ETA estimated at ${peak ? "peak-hour" : "typical"} traffic speed.`,
  };
}
