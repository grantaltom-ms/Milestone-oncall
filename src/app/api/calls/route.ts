import { listCalls } from "@/lib/oncall/calls";
import { errorResponse, requireDashboard } from "@/lib/oncall/guard";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** The recent after-hours calls, for the review page. */
export async function GET() {
  const gate = await requireDashboard();
  if (!gate.ok) return gate.response;

  if (!gate.config.supabase) {
    return Response.json(
      { error: "No call log configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." },
      { status: 503 }
    );
  }

  try {
    return Response.json({
      calls: await listCalls(gate.config.supabase),
      // The page says so out loud when recording is off, because an empty list
      // then means "nothing is being recorded", not "nobody called".
      recording: gate.config.recordCalls,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
