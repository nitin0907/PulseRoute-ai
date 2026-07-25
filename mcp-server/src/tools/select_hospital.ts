/**
 * Tool: select_hospital
 *
 * Recommends the best hospital for a given emergency type and location.
 * Scoring factors:
 *   1. Required specialty match (eliminates non-matching hospitals)
 *   2. Emergency department availability
 *   3. Bed availability
 *   4. ICU availability (matched from icu_facilities.json)
 *   5. Trauma level (for trauma emergencies)
 *   6. Distance from incident (Haversine)
 *
 * Data sources:
 *   - data/hospitals.json
 *   - data/icu_facilities.json
 *   - data/trauma_centers.json
 *
 * Sample request:
 *   {
 *     "emergency_type": "Cardiac Arrest",
 *     "required_specialties": ["Cardiology", "Cardiac Surgery"],
 *     "latitude": 12.9716,
 *     "longitude": 77.5946
 *   }
 *
 * Sample response:
 *   {
 *     "hospital_id": "hosp_001",
 *     "hospital_name": "Manipal Hospital",
 *     "locality": "Old Airport Road",
 *     "address": "...",
 *     "phone": "+91-80-25023456",
 *     "distance_km": 3.8,
 *     "available_beds": 87,
 *     "trauma_level": 1,
 *     "trauma_capability": true,
 *     "icu_availability": [{ "icu_type": "Cardiac ICU", "available_beds": 3, "ecmo_capable": true }],
 *     "matched_specialties": ["Cardiology", "Cardiac Surgery"],
 *     "specialty_score": 2,
 *     "recommendation_reason": "Closest tertiary hospital with Cardiology, Cardiac Surgery and available ICU.",
 *     "alternatives": [...]
 *   }
 */

import { z } from "zod";
import {
  getHospitals,
  getIcuFacilities,
  getTraumaCenters,
  haversineKm,
} from "../types/schemas.js";

// ---------------------------------------------------------------------------
// Emergency type → specialty hint map
// Allows callers to pass a plain-English emergency type without listing
// specialties manually; the tool will merge these with any explicit list.
// ---------------------------------------------------------------------------

const EMERGENCY_SPECIALTY_MAP: Record<string, string[]> = {
  "Cardiac Arrest":          ["Cardiology", "Cardiac Surgery"],
  "STEMI":                   ["Cardiology", "Cardiac Surgery"],
  "Stroke":                  ["Neurology", "Neurosurgery"],
  "Acute Stroke":            ["Neurology", "Neurosurgery"],
  "Polytrauma":              ["Trauma & Critical Care", "Neurosurgery"],
  "Trauma":                  ["Trauma & Critical Care"],
  "Major Burns":             ["Burns & Reconstructive Surgery"],
  "Burns":                   ["Burns & Reconstructive Surgery"],
  "Obstetric":               ["Obstetrics & Gynecology", "Neonatology"],
  "Pediatric":               ["Pediatrics"],
  "Paediatric":              ["Pediatrics"],
  "Poisoning":               ["General Medicine"],
  "Drowning":                ["General Medicine", "Pulmonology"],
  "Sepsis":                  ["General Medicine"],
  "Neonatal":                ["Neonatology"],
  "Orthopedic":              ["Orthopedics"],
  "Penetrating Trauma":      ["Trauma & Critical Care", "Vascular Surgery"],
};

// ---------------------------------------------------------------------------
// Input schema
// ---------------------------------------------------------------------------

export const SelectHospitalInputSchema = z.object({
  emergency_type: z
    .string()
    .describe(
      "Type of emergency. Examples: 'Cardiac Arrest', 'Stroke', 'Polytrauma', 'Major Burns', " +
        "'Obstetric', 'Pediatric', 'Poisoning'. Used to auto-infer required specialties."
    ),
  required_specialties: z
    .array(z.string())
    .optional()
    .default([])
    .describe(
      "Explicit list of required hospital specialties. If provided alongside emergency_type, " +
        "these are merged with auto-inferred specialties."
    ),
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
});

export type SelectHospitalInput = z.infer<typeof SelectHospitalInputSchema>;

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

export function selectHospital(input: SelectHospitalInput): Record<string, unknown> {
  const { emergency_type, required_specialties, latitude, longitude } = input;

  const hospitals   = getHospitals();
  const icus        = getIcuFacilities();
  const traumaCtrs  = getTraumaCenters();

  // Build final specialty requirement list
  const inferredSpecialties: string[] = [];
  for (const [key, specs] of Object.entries(EMERGENCY_SPECIALTY_MAP)) {
    if (emergency_type.toLowerCase().includes(key.toLowerCase())) {
      inferredSpecialties.push(...specs);
    }
  }
  const allRequiredSpecialties = Array.from(
    new Set([...inferredSpecialties, ...(required_specialties ?? [])])
  );

  // Build ICU index keyed by hospital name fragments for fuzzy matching
  const icuByHospitalName = new Map<string, typeof icus[number][]>();
  for (const icu of icus) {
    const key = icu.hospital_name.toLowerCase();
    const existing = icuByHospitalName.get(key) ?? [];
    existing.push(icu);
    icuByHospitalName.set(key, existing);
  }

  // Build trauma centre index keyed by hospital_name
  const traumaByHospitalName = new Map<string, typeof traumaCtrs[number]>();
  for (const tc of traumaCtrs) {
    traumaByHospitalName.set(tc.hospital_name.toLowerCase(), tc);
  }

  // Score each hospital
  const scored = hospitals
    .filter((h) => h.emergency_dept)
    .map((h) => {
      const distance_km = haversineKm(latitude, longitude, h.lat, h.lng);

      // Specialty matching
      const matchedSpecialties = allRequiredSpecialties.filter((s) =>
        h.specialties.some((hs) => hs.toLowerCase().includes(s.toLowerCase()))
      );
      const specialty_score = matchedSpecialties.length;

      // ICU lookup — fuzzy match on hospital name
      const hNameLower = h.name.toLowerCase();
      let matchedIcus: typeof icus[number][] = [];
      for (const [key, val] of icuByHospitalName.entries()) {
        if (key.includes(hNameLower) || hNameLower.includes(key.split("(")[0].trim())) {
          matchedIcus = val;
          break;
        }
      }
      const icu_availability = matchedIcus
        .filter((i) => i.available_beds > 0)
        .map((i) => ({
          icu_type: i.icu_type,
          available_beds: i.available_beds,
          ecmo_capable: i.ecmo_capable,
          ventilators_available: i.ventilators_available,
          dialysis_available: i.dialysis_available,
        }));

      // Trauma centre lookup
      let traumaCapability = false;
      let traumaData: Record<string, unknown> | null = null;
      for (const [key, tc] of traumaByHospitalName.entries()) {
        if (key.includes(hNameLower) || hNameLower.includes(key.split("(")[0].trim())) {
          traumaCapability = true;
          traumaData = {
            trauma_level: tc.trauma_level,
            trauma_bays: tc.trauma_bay_count,
            neurosurgery: tc.neurosurgery_available,
            vascular_surgery: tc.vascular_surgery,
            helipad: tc.helipad,
            mass_casualty_capacity: tc.mass_casualty_capacity,
          };
          break;
        }
      }

      // Composite score: specialty match weighted highest, then beds, then proximity
      const compositeScore =
        specialty_score * 100 +
        (h.beds_available > 0 ? 30 : 0) +
        (icu_availability.length > 0 ? 20 : 0) +
        (traumaCapability ? 15 : 0) +
        Math.max(0, 50 - distance_km); // closer = higher score, caps at 50 km

      return {
        hospital: h,
        distance_km,
        matchedSpecialties,
        specialty_score,
        icu_availability,
        traumaCapability,
        traumaData,
        compositeScore,
      };
    })
    .sort((a, b) => b.compositeScore - a.compositeScore);

  if (scored.length === 0) {
    return {
      error: true,
      message: "No hospitals with emergency departments found in the knowledge base.",
    };
  }

  const top = scored[0];
  const h   = top.hospital;

  const missingSpecialties = allRequiredSpecialties.filter(
    (s) => !top.matchedSpecialties.includes(s)
  );

  const reasonParts: string[] = [];
  if (top.matchedSpecialties.length > 0) {
    reasonParts.push(`Matches required specialties: ${top.matchedSpecialties.join(", ")}.`);
  }
  if (top.icu_availability.length > 0) {
    reasonParts.push(`ICU available (${top.icu_availability.map((i) => i.icu_type).join(", ")}).`);
  }
  if (top.traumaCapability && top.traumaData) {
    reasonParts.push(`Level ${top.traumaData["trauma_level"]} Trauma Centre with ${top.traumaData["trauma_bays"]} trauma bays.`);
  }
  reasonParts.push(`${parseFloat(top.distance_km.toFixed(1))} km from incident.`);
  if (missingSpecialties.length > 0) {
    reasonParts.push(`Note: ${missingSpecialties.join(", ")} not available at this facility.`);
  }

  return {
    hospital_id: h.id,
    hospital_name: h.name,
    locality: h.locality,
    address: h.address,
    phone: h.phone,
    hospital_type: h.type,
    hospital_level: h.level,
    distance_km: parseFloat(top.distance_km.toFixed(2)),
    available_beds: h.beds_available,
    trauma_level: h.trauma_level,
    trauma_capability: top.traumaCapability,
    trauma_details: top.traumaData,
    icu_availability: top.icu_availability,
    matched_specialties: top.matchedSpecialties,
    missing_specialties: missingSpecialties,
    specialty_score: top.specialty_score,
    recommendation_reason: reasonParts.join(" "),
    alternatives: scored.slice(1, 4).map((s) => ({
      hospital_id: s.hospital.id,
      hospital_name: s.hospital.name,
      locality: s.hospital.locality,
      distance_km: parseFloat(s.distance_km.toFixed(2)),
      available_beds: s.hospital.beds_available,
      specialty_score: s.specialty_score,
      icu_units_available: s.icu_availability.length,
    })),
  };
}
