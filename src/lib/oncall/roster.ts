import type { SupabaseConfig } from "./config";
import { toE164 } from "./phone";

/**
 * The technician roster, read from Supabase over PostgREST with plain `fetch` —
 * same reasoning as the Google client: one HTTP call does not need an SDK.
 *
 * The roster is only ever a convenience for the scheduling dashboard. The
 * phone line never reads it: a shift carries its own phone number, so routing
 * keeps working even if Supabase is down or a technician is later removed.
 */

const TIMEOUT_MS = 5000;

export type Tech = {
  id: string;
  name: string;
  /** E.164. Rows whose number cannot be parsed are dropped rather than shown. */
  phone: string;
  active: boolean;
};

export class RosterError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "RosterError";
  }
}

type Row = { id?: string | number; name?: string; phone?: string; active?: boolean };

export async function listTechs(config: SupabaseConfig): Promise<Tech[]> {
  const url = new URL("/rest/v1/oncall_techs", config.url);
  url.searchParams.set("select", "id,name,phone,active");
  url.searchParams.set("order", "name.asc");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        apikey: config.serviceRoleKey,
        authorization: `Bearer ${config.serviceRoleKey}`,
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw new RosterError(`Could not reach Supabase: ${error}`, 502);
  }

  if (!response.ok) {
    const hint =
      response.status === 404
        ? "The oncall_techs table does not exist yet — run the migration in docs/oncall-techs.sql."
        : `Supabase returned HTTP ${response.status}.`;
    throw new RosterError(hint, response.status);
  }

  const rows = (await response.json()) as Row[];
  return rows
    .map((row) => {
      const phone = toE164(row.phone);
      if (!row.name || !phone) return null;
      return {
        id: String(row.id ?? row.name),
        name: row.name,
        phone,
        active: row.active !== false,
      };
    })
    .filter((tech): tech is Tech => tech !== null);
}
