import { cookies } from "next/headers";
import { getOnCallConfig, type OnCallConfig } from "./config";
import { isValidSessionToken, SESSION_COOKIE } from "./session";

/**
 * Gate for every scheduling endpoint. Returns the config when the caller holds
 * a valid session, or the Response to send back when they do not.
 *
 * With no ONCALL_DASHBOARD_PASSWORD set, the dashboard is off entirely rather
 * than open — an unset password must never mean "no password required" on
 * something that can rewrite an emergency rotation.
 */
export async function requireDashboard(): Promise<
  { ok: true; config: OnCallConfig } | { ok: false; response: Response }
> {
  const config = getOnCallConfig();

  if (!config.dashboardPassword) {
    return {
      ok: false,
      response: Response.json(
        { error: "The scheduling dashboard is not enabled. Set ONCALL_DASHBOARD_PASSWORD." },
        { status: 503 }
      ),
    };
  }

  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!isValidSessionToken(token, config.dashboardPassword)) {
    return { ok: false, response: Response.json({ error: "Not signed in." }, { status: 401 }) };
  }

  return { ok: true, config };
}

/** Turns a thrown CalendarWriteError/RosterError into an honest HTTP reply. */
export function errorResponse(error: unknown): Response {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? Number((error as { status: unknown }).status) || 500
      : 500;
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return Response.json({ error: message }, { status });
}
