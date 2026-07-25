/**
 * PulseRoute MCP — Shared Type Definitions & Knowledge Base Loader
 *
 * All data types reflect the exact JSON shapes found in:
 *   - ../../../PulseRoute_Bengaluru_KB.json  (master KB)
 *   - ../../../data/*.json                   (domain data slices)
 *
 * The KB_PATH and DATA_PATH constants resolve at runtime relative to this
 * compiled file so the server can be started from any working directory.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ---------------------------------------------------------------------------
// Path resolution — walk up from build/src/types/ to the mcp-server root
//
// At runtime the compiled file is at:
//   <mcp-server-root>/build/src/types/schemas.js
//
// Three levels up  →  <mcp-server-root>/
// data/ and PulseRoute_Bengaluru_KB.json live here regardless of whether
// Railway is given Root Directory = "mcp-server" or the repo root.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// build/src/types  →  build/src  →  build  →  mcp-server root
const SERVER_ROOT = resolve(__dirname, "..", "..", "..");

export const DATA_DIR = resolve(SERVER_ROOT, "data");
export const KB_FILE = resolve(SERVER_ROOT, "PulseRoute_Bengaluru_KB.json");

// ---------------------------------------------------------------------------
// Domain types — mirrors data/*.json schemas
// ---------------------------------------------------------------------------

export interface Ambulance {
  id: string;
  call_sign: string;
  type: "ALS" | "BLS" | "MICU" | "Neonatal";
  registration_number: string;
  home_hospital_id: string;
  current_locality: string;
  current_lat: number;
  current_lng: number;
  status: "available" | "dispatched" | "standby" | "maintenance";
  crew: Array<{ paramedic_name: string; emt_name: string }>;
  equipment: string[];
  vehicle_make: string;
  year: number;
  comms_channel: string;
  response_zone: string;
}

export interface Hospital {
  id: string;
  name: string;
  locality: string;
  lat: number;
  lng: number;
  address: string;
  type: "private" | "government" | "trust";
  level: "tertiary" | "secondary" | "primary";
  beds_total: number;
  beds_available: number;
  emergency_dept: boolean;
  trauma_level: number;
  specialties: string[];
  phone: string;
  established_year: number;
}

export interface IcuFacility {
  id: string;
  hospital_id: string;
  hospital_name: string;
  locality: string;
  icu_type: string;
  total_beds: number;
  available_beds: number;
  ventilators_total: number;
  ventilators_available: number;
  ecmo_capable: boolean;
  dialysis_available: boolean;
  nursing_ratio: string;
  avg_los_days: number;
  last_updated_timestamp: string;
  isolation_beds: number;
}

export interface TraumaCenter {
  id: string;
  hospital_id: string;
  hospital_name: string;
  locality: string;
  trauma_level: "I" | "II" | "III";
  activation_protocol: string;
  trauma_bay_count: number;
  trauma_surgeons_24x7: boolean;
  neurosurgery_available: boolean;
  orthopedic_available: boolean;
  vascular_surgery: boolean;
  blood_bank_24x7: boolean;
  ct_scan_24x7: boolean;
  helipad: boolean;
  annual_trauma_volume: number;
  mass_casualty_capacity: number;
}

export interface RoadCorridor {
  id: string;
  name: string;
  from_locality: string;
  to_locality: string;
  distance_km: number;
  typical_speed_kmh: number;
  peak_hour_speed_kmh: number;
  road_type: string;
  lanes: number;
  has_signal_preemption: boolean;
  emergency_route: boolean;
  known_bottlenecks: string[];
  alternate_routes: string[];
}

export interface TrafficSignal {
  id: string;
  intersection_name: string;
  locality: string;
  lat: number;
  lng: number;
  type: "adaptive" | "standard" | "emergency_preemptible";
  cycle_time_seconds: number;
  peak_delay_seconds: number;
  signal_preemption_capable: boolean;
  connected_corridors: string[];
  camera_surveillance: boolean;
  avg_daily_volume: number;
  congestion_index: number;
}

// ---------------------------------------------------------------------------
// Data loader — reads JSON files once and caches in module scope
// ---------------------------------------------------------------------------

function loadJson<T>(filePath: string): T {
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

let _ambulances: Ambulance[] | null = null;
let _hospitals: Hospital[] | null = null;
let _icuFacilities: IcuFacility[] | null = null;
let _traumaCenters: TraumaCenter[] | null = null;
let _roadNetwork: RoadCorridor[] | null = null;
let _trafficSignals: TrafficSignal[] | null = null;

export function getAmbulances(): Ambulance[] {
  if (!_ambulances) {
    _ambulances = loadJson<Ambulance[]>(resolve(DATA_DIR, "ambulances.json"));
  }
  return _ambulances;
}

export function getHospitals(): Hospital[] {
  if (!_hospitals) {
    _hospitals = loadJson<Hospital[]>(resolve(DATA_DIR, "hospitals.json"));
  }
  return _hospitals;
}

export function getIcuFacilities(): IcuFacility[] {
  if (!_icuFacilities) {
    _icuFacilities = loadJson<IcuFacility[]>(resolve(DATA_DIR, "icu_facilities.json"));
  }
  return _icuFacilities;
}

export function getTraumaCenters(): TraumaCenter[] {
  if (!_traumaCenters) {
    _traumaCenters = loadJson<TraumaCenter[]>(resolve(DATA_DIR, "trauma_centers.json"));
  }
  return _traumaCenters;
}

export function getRoadNetwork(): RoadCorridor[] {
  if (!_roadNetwork) {
    _roadNetwork = loadJson<RoadCorridor[]>(resolve(DATA_DIR, "road_network.json"));
  }
  return _roadNetwork;
}

export function getTrafficSignals(): TrafficSignal[] {
  if (!_trafficSignals) {
    _trafficSignals = loadJson<TrafficSignal[]>(resolve(DATA_DIR, "traffic_signals.json"));
  }
  return _trafficSignals;
}

// ---------------------------------------------------------------------------
// Haversine distance utility (returns kilometres)
// ---------------------------------------------------------------------------

export function haversineKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// Peak-hour guard — returns true between 07:30-10:30 and 17:30-20:30 IST
// ---------------------------------------------------------------------------

export function isPeakHour(): boolean {
  const now = new Date();
  // IST = UTC+5:30
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);
  const h = ist.getUTCHours();
  const m = ist.getUTCMinutes();
  const totalMin = h * 60 + m;
  const morningStart = 7 * 60 + 30;   // 07:30
  const morningEnd   = 10 * 60 + 30;  // 10:30
  const eveningStart = 17 * 60 + 30;  // 17:30
  const eveningEnd   = 20 * 60 + 30;  // 20:30
  return (
    (totalMin >= morningStart && totalMin <= morningEnd) ||
    (totalMin >= eveningStart && totalMin <= eveningEnd)
  );
}
