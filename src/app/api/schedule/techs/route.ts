import { errorResponse, requireDashboard } from "@/lib/oncall/guard";
import { listTechs } from "@/lib/oncall/roster";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The technician roster, for the shift form's picker. */
export async function GET() {
  const gate = await requireDashboard();
  if (!gate.ok) return gate.response;

  if (!gate.config.supabase) {
    return Response.json(
      { error: "No roster configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." },
      { status: 503 }
    );
  }

  try {
    return Response.json({ techs: await listTechs(gate.config.supabase) });
  } catch (error) {
    return errorResponse(error);
  }
}
