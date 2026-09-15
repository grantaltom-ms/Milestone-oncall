import type { SupabaseConfig } from "./config";
import type { CallerMatch } from "./tenants";

/**
 * The call log: one row per recording, written by the Twilio webhooks once a
 * call is over and read back by /calls, where somebody listens and types the
 * gist of it into AppFolio the next morning.
 *
 * Deliberately written *after* the call rather than during it. Nothing here is
 * on the path of a ringing phone, so it can afford a normal timeout and a
 * proper error.
 */

const TIMEOUT_MS = 5000;
/** Enough to cover a long weekend of after-hours calls on one screen. */
export const DEFAULT_LIMIT = 50;

export type CallKind = "call" | "voicemail";

export type NewCall = {
  callSid: string;
  recordingSid: string | null;
  recordingSeconds: number | null;
  kind: CallKind;
  callerPhone: string | null;
  match: CallerMatch | null;
  matchCount: number;
  startedAt?: string;
};

export type LoggedCall = {
  id: string;
  callSid: string;
  recordingSid: string | null;
  recordingSeconds: number | null;
  kind: CallKind;
  callerPhone: string | null;
  propertyName: string | null;
  unit: string | null;
  tenantName: string | null;
  matchCount: number;
  startedAt: string;
};

export class CallLogError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "CallLogError";
  }
}

function headers(config: SupabaseConfig): Record<string, string> {
  return {
    apikey: config.serviceRoleKey,
    authorization: `Bearer ${config.serviceRoleKey}`,
    "content-type": "application/json",
  };
}

/**
 * Twilio retries a webhook it did not get a clean answer to, so the same
 * recording can arrive twice. The recording SID is unique in the table and the
 * insert merges on it, which makes a repeat delivery a no-op rather than a
 * duplicate row in somebody's morning review.
 */
export async function logCall(
  config: SupabaseConfig,
  call: NewCall
): Promise<{ ok: boolean; error?: string }> {
  const url = new URL("/rest/v1/oncall_calls", config.url);
  if (call.recordingSid) url.searchParams.set("on_conflict", "recording_sid");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...headers(config),
        prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        call_sid: call.callSid,
        recording_sid: call.recordingSid,
        recording_seconds: call.recordingSeconds,
        kind: call.kind,
        caller_phone: call.callerPhone,
        property_name: call.match?.propertyName ?? null,
        unit: call.match?.unit ?? null,
        tenant_name: call.match?.tenantName ?? null,
        match_count: call.matchCount,
        started_at: call.startedAt ?? new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) {
      const hint =
        response.status === 404
          ? "The oncall_calls table does not exist yet — run docs/oncall-caller-lookup.sql."
          : `Supabase returned HTTP ${response.status}.`;
      return { ok: false, error: hint };
    }
    return { ok: true };
  } catch (error) {
    // A call log that cannot be written must never take a phone call with it.
    return { ok: false, error: String(error) };
  }
}

type Row = {
  id?: string | number;
  call_sid?: string;
  recording_sid?: string | null;
  recording_seconds?: number | null;
  kind?: string;
  caller_phone?: string | null;
  property_name?: string | null;
  unit?: string | null;
  tenant_name?: string | null;
  match_count?: number | null;
  started_at?: string;
};

export async function listCalls(
  config: SupabaseConfig,
  limit: number = DEFAULT_LIMIT
): Promise<LoggedCall[]> {
  const url = new URL("/rest/v1/oncall_calls", config.url);
  url.searchParams.set(
    "select",
    "id,call_sid,recording_sid,recording_seconds,kind,caller_phone,property_name,unit,tenant_name,match_count,started_at"
  );
  url.searchParams.set("order", "started_at.desc");
  url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 200)));

  let response: Response;
  try {
    response = await fetch(url, {
      headers: headers(config),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new CallLogError(`Could not reach Supabase: ${error}`, 502);
  }

  if (!response.ok) {
    throw new CallLogError(
      response.status === 404
        ? "The oncall_calls table does not exist yet — run docs/oncall-caller-lookup.sql in the Supabase SQL editor."
        : `Supabase returned HTTP ${response.status}.`,
      response.status
    );
  }

  const rows = (await response.json()) as Row[];
  return rows.map((row) => ({
    id: String(row.id ?? row.call_sid ?? ""),
    callSid: row.call_sid ?? "",
    recordingSid: row.recording_sid ?? null,
    recordingSeconds: row.recording_seconds ?? null,
    kind: row.kind === "voicemail" ? "voicemail" : "call",
    callerPhone: row.caller_phone ?? null,
    propertyName: row.property_name ?? null,
    unit: row.unit ?? null,
    tenantName: row.tenant_name ?? null,
    matchCount: row.match_count ?? 0,
    startedAt: row.started_at ?? new Date(0).toISOString(),
  }));
}
