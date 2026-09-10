import { deleteShift, updateShift } from "@/lib/oncall/calendar";
import { errorResponse, requireDashboard } from "@/lib/oncall/guard";
import { toE164 } from "@/lib/oncall/phone";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { techName?: string; phone?: string; start?: string; end?: string };

/** Change a shift — a swapped weekend, a corrected number, a shifted handoff. */
export async function PATCH(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireDashboard();
  if (!gate.ok) return gate.response;
  if (!gate.config.google) {
    return Response.json({ error: "Google Calendar is not configured." }, { status: 503 });
  }

  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as Body | null;
  const phone = toE164(body?.phone);
  const start = body?.start ? new Date(body.start) : null;
  const end = body?.end ? new Date(body.end) : null;

  if (!body?.techName?.trim()) return Response.json({ error: "Pick a technician." }, { status: 400 });
  if (!phone) return Response.json({ error: "That is not a dialable phone number." }, { status: 400 });
  if (!start || Number.isNaN(start.getTime()) || !end || Number.isNaN(end.getTime())) {
    return Response.json({ error: "Those dates are not real." }, { status: 400 });
  }
  if (end <= start) return Response.json({ error: "The shift ends before it starts." }, { status: 400 });

  try {
    const shift = await updateShift(gate.config.google, id, {
      techName: body.techName.trim(),
      phone,
      start: start.toISOString(),
      end: end.toISOString(),
    });
    return Response.json({ shift });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Remove a shift. Leaves a gap, which the dashboard then flags. */
export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireDashboard();
  if (!gate.ok) return gate.response;
  if (!gate.config.google) {
    return Response.json({ error: "Google Calendar is not configured." }, { status: 503 });
  }

  try {
    await deleteShift(gate.config.google, (await ctx.params).id);
    return Response.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
