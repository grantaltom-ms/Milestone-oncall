import { getOnCallConfig } from "@/lib/oncall/config";
import { maskPhone } from "@/lib/oncall/phone";
import { resolveDestination } from "@/lib/oncall/routing";

export const dynamic = "force-dynamic";

/**
 * The same decision the phone line makes, on a page — so anyone in the office
 * can see who picks up right now without a Twilio login or an API key. Names
 * and last-four only; full numbers live behind ONCALL_API_KEY on
 * /api/oncall/status.
 */

const WHO: Record<string, string> = {
  tech: "On-call technician",
  office: "Office line",
  backup: "Backup manager",
  voicemail: "Voicemail",
};

export default async function Page() {
  const config = getOnCallConfig();
  const decision = await resolveDestination(new Date(), config);
  const destination = decision.destination;
  const phone = destination.kind === "voicemail" ? null : destination.phone;

  const setup: string[] = [];
  if (!config.mainLine) setup.push("TWILIO_MAIN_LINE is not set — technicians will not see a consistent caller ID.");
  if (!config.twilio) setup.push("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set — webhooks cannot be verified and no texts are sent.");
  if (!config.google) setup.push("Google Calendar is not connected — every after-hours call goes to the backup manager.");
  if (!config.backupPhone) setup.push("ONCALL_BACKUP_PHONE is not set — an unanswered call goes straight to voicemail.");
  if (decision.lookup && !decision.lookup.found && decision.lookup.reason === "event_without_phone") {
    setup.push(`A shift is on the calendar with no phone number in it: "${decision.lookup.detail}".`);
  }

  return (
    <main>
      <h1>After-hours maintenance line</h1>
      <p className="lede">
        One number for tenants. Whoever is on the rotation calendar answers it, and always shows the
        office number on their phone.
      </p>

      <div className="card">
        <dl>
          <div className="row">
            <dt>Right now</dt>
            <dd>{decision.localLabel}</dd>
          </div>
          <div className="row">
            <dt>Hours</dt>
            <dd>{decision.onCallWindow ? "After hours — rotation is live" : "Business hours"}</dd>
          </div>
          <div className="row">
            <dt>A call now rings</dt>
            <dd className={destination.kind === "tech" || destination.kind === "office" ? "ok" : "warn"}>
              {destination.kind === "tech" ? destination.name : WHO[destination.kind]}
              {phone ? ` · ${maskPhone(phone)}` : ""}
            </dd>
          </div>
          <div className="row">
            <dt>Because</dt>
            <dd>{decision.reason.replace(/_/g, " ")}</dd>
          </div>
        </dl>
      </div>

      {setup.length > 0 && (
        <div className="card">
          <strong className="warn">Setup still needed</strong>
          <ul>
            {setup.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="lede">
        Full details, with phone numbers, at <code>/api/oncall/status?key=…</code>. Setup and the
        week-to-week runbook are in <code>docs/oncall-routing.md</code>.
      </p>
    </main>
  );
}
