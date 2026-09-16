import type { SupabaseConfig } from "./config";

/**
 * "Who is this calling?" — the tenant directory, matched on the caller ID.
 *
 * Twilio hands us a number and nothing else. The directory knows that number
 * belongs to unit V-12 at Willow Lake, and a technician told that before they
 * answer arrives knowing which building to drive to.
 *
 * Read over PostgREST with plain `fetch`, same as the roster. Two rules make
 * it safe to do while a phone is ringing:
 *
 *   1. It is on a short leash — 2 seconds, out of the ~15 Twilio allows for a
 *      whole answer, and the call is already being connected either way.
 *   2. It never throws. A directory that is unreachable, empty or not yet
 *      migrated costs the technician one line of a text message, never the
 *      call.
 */

const TIMEOUT_MS = 2000;

/** At most this many units named before the text just says "N units match". */
export const MAX_MATCHES = 4;

export type CallerMatch = {
  propertyName: string;
  unit: string | null;
  tenantName: string | null;
};

export type CallerLookup = {
  /** Distinct units whose residents list this number. Empty means no match. */
  matches: CallerMatch[];
  /** Set when the lookup could not be completed — never a reason to fail a call. */
  error: string | null;
};

const EMPTY: CallerLookup = { matches: [], error: null };

/**
 * `+12065551234` → `2065551234`, the form the directory view is normalized to.
 * Anything that is not a US 10-digit number (a short code, an international
 * caller) has no chance of matching, so it is not worth a round trip.
 */
export function lastTenDigits(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return digits;
  if (digits.length === 11 && digits.startsWith("1")) return digits.slice(1);
  return null;
}

type Row = {
  property_name?: string | null;
  unit?: string | null;
  tenant_name?: string | null;
};

/**
 * One row per resident, so a household with two people on the lease comes back
 * twice. Collapse to one entry per unit — the technician is being sent to an
 * address, not to a person.
 */
function byUnit(rows: Row[]): CallerMatch[] {
  const seen = new Map<string, CallerMatch>();
  for (const row of rows) {
    const propertyName = row.property_name?.trim();
    if (!propertyName) continue;
    const unit = row.unit?.trim() || null;
    const key = `${propertyName}|${unit ?? ""}`;
    if (seen.has(key)) continue;
    seen.set(key, { propertyName, unit, tenantName: row.tenant_name?.trim() || null });
  }
  return [...seen.values()];
}

export async function lookupCaller(
  config: SupabaseConfig,
  phone: string | null
): Promise<CallerLookup> {
  const phone10 = lastTenDigits(phone);
  if (!phone10) return EMPTY;

  const url = new URL("/rest/v1/oncall_caller_lookup", config.url);
  url.searchParams.set("select", "property_name,unit,tenant_name");
  url.searchParams.set("phone10", `eq.${phone10}`);
  // Current residents ahead of residents on notice, so a unit mid-turnover
  // resolves to whoever is living there now.
  url.searchParams.set("order", "match_rank.asc");
  // One extra, so "4 units match" can be told apart from "more than 4".
  url.searchParams.set("limit", String(MAX_MATCHES + 1));

  try {
    const response = await fetch(url, {
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      const hint =
        response.status === 404
          ? "oncall_caller_lookup does not exist — run docs/oncall-caller-lookup.sql"
          : `HTTP ${response.status}`;
      return { matches: [], error: hint };
    }
    return { matches: byUnit((await response.json()) as Row[]), error: null };
  } catch (error) {
    return { matches: [], error: String(error) };
  }
}
