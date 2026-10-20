import { createShift, listShifts } from "@/lib/oncall/calendar";
import { errorResponse, requireDashboard } from "@/lib/oncall/guard";
import { listTechs } from "@/lib/oncall/roster";
import { planRotation, ROTATION_FALL_2026 } from "@/lib/oncall/rotation";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Puts the written-down fall rotation on the calendar. Safe to press twice:
 * weeks already there exactly as written are skipped, and if anything cannot
 * be matched or collides with an existing shift, nothing is written at all.
 */
export async function POST() {
  const gate = await requireDashboard();
  if (!gate.ok) return gate.response;
  const { google, supabase, timezone } = gate.config;
  if (!google) {
    return Response.json({ error: "Google Calendar is not configured." }, { status: 503 });
  }
  if (!supabase) {
    return Response.json(
      { error: "No roster configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY." },
      { status: 503 }
    );
  }

  try {
    const weeks = ROTATION_FALL_2026;
    const techs = await listTechs(supabase);
    // A day of slack either side so a shift ending exactly at the boundary is seen.
    const first = new Date(`${weeks[0].firstDay}T00:00:00Z`).getTime() - 86_400_000;
    const last = new Date(`${weeks[weeks.length - 1].lastDay}T00:00:00Z`).getTime() + 2 * 86_400_000;
    const existing = await listShifts(google, new Date(first).toISOString(), new Date(last).toISOString());

    const plan = planRotation(weeks, techs, existing, timezone);
    if (plan.problems.length > 0) {
      return Response.json({ error: "Nothing was added.", problems: plan.problems }, { status: 409 });
    }

    for (const planned of plan.toCreate) {
      await createShift(google, {
        techName: planned.techName,
        phone: planned.phone,
        start: planned.start,
        end: planned.end,
      });
    }
    return Response.json({ created: plan.toCreate.length, alreadyThere: plan.alreadyThere.length });
  } catch (error) {
    return errorResponse(error);
  }
}
