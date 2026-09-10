import { cookies } from "next/headers";
import { getOnCallConfig } from "@/lib/oncall/config";
import { createSessionToken, isCorrectPassword, SESSION_COOKIE, SESSION_HOURS } from "@/lib/oncall/session";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Sign in to the scheduling dashboard. */
export async function POST(request: Request) {
  const config = getOnCallConfig();
  if (!config.dashboardPassword) {
    return Response.json(
      { error: "The scheduling dashboard is not enabled. Set ONCALL_DASHBOARD_PASSWORD." },
      { status: 503 }
    );
  }

  const body = (await request.json().catch(() => null)) as { password?: string } | null;
  if (!body?.password || !isCorrectPassword(body.password, config.dashboardPassword)) {
    return Response.json({ error: "That password is not right." }, { status: 401 });
  }

  (await cookies()).set(SESSION_COOKIE, createSessionToken(config.dashboardPassword), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
  return Response.json({ ok: true });
}

/** Sign out. */
export async function DELETE() {
  (await cookies()).delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
