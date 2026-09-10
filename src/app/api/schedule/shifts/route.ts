import { createShift, listShifts } from "@/lib/oncall/calendar";
import { errorResponse, requireDashboard } from "@/lib/oncall/guard";
import { toE164 } from "@/lib/oncall/phone";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Body = { techName?: string; phone?: string; start?: string; end?: string };

/** Validates a shift the way a coordinator would be told off for getting wrong. */
function validate(body: Body | null): { error: string } | { techName: string; phone: string; start: string; end: string } {
  if (!body) return { error: "Nothing to save." };

  const techName = body.techName?.trim();
  if (!techName) return { error: "Pick a technician." };

  const phone = toE164(body.phone);
  if (!phone) return { error: `"${body.phone ?? ""}" is not a phone number this line can dial.` };

  const start = body.start ? new Date(body.start) : null;
  const end = body.end ? new Date(body.end) : null;
  if (!start || Number.isNaN(start.getTime())) return { error: "That start time is not a real date." };
  if (!end || Number.isNaN(end.getTime())) return { error: "That end time is not a real date." };
  if (end <= start) return { error: "The shift ends before it starts." };

  return { techName, phone, start: start.toISOString(), end: end.toISOString() };
}

/** Every shift overlapping a window. */
export async function GET(request: Request) {
  const gate = await requireDashboard();
  if (!gate.ok) return gate.response;
  if (!gate.config.google) {
    return Response.json({ error: "Google Calendar is not configured." }, { status: 503 });
  }

  const url = new URL(request.url);
  const from = url.searchParams.get("from") ?? new Date().toISOString();
  const to =
    url.searchParams.get("to") ?? new Date(Date.now() + 90 * 86_400_000).toISOString();

  try {
    return Response.json({ shifts: await listShifts(gate.config.google, from, to) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Add a shift. */
export async function POST(request: Request) {
  const gate = await requireDashboard();
  if (!gate.ok) return gate.response;
  if (!gate.config.google) {
    return Response.json({ error: "Google Calendar is not configured." }, { status: 503 });
  }

  const parsed = validate((await request.json().catch(() => null)) as Body | null);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });

  try {
    return Response.json({ shift: await createShift(gate.config.google, parsed) }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export { validate as validateShiftForTests };
