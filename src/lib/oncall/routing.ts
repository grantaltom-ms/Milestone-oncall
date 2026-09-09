import { lookupOnCall, type OnCallLookup } from "./calendar";
import type { OnCallConfig } from "./config";
import { isOnCallWindow, localTime } from "./window";

/**
 * Turns "the phone is ringing, it is 9:40pm on a Saturday" into a single
 * decision about who to ring. Pure orchestration — the window rules live in
 * window.ts and the calendar read in calendar.ts — so it can be tested with a
 * fixed clock.
 */

export type Destination =
  | { kind: "tech"; phone: string; name: string }
  | { kind: "office"; phone: string }
  | { kind: "backup"; phone: string }
  | { kind: "voicemail" };

export type RoutingDecision = {
  destination: Destination;
  onCallWindow: boolean;
  /** Why we landed here — logged on every call, and shown on the status page. */
  reason: string;
  localLabel: string;
  lookup: OnCallLookup | null;
};

export async function resolveDestination(
  now: Date,
  config: OnCallConfig
): Promise<RoutingDecision> {
  const onCallWindow = isOnCallWindow(now, config);
  const localLabel = localTime(now, config.timezone).label;
  const base = { onCallWindow, localLabel };

  if (!onCallWindow && config.officePhone) {
    return {
      ...base,
      destination: { kind: "office", phone: config.officePhone },
      reason: "business_hours",
      lookup: null,
    };
  }

  const fallback = (reason: string, lookup: OnCallLookup | null): RoutingDecision =>
    config.backupPhone
      ? { ...base, destination: { kind: "backup", phone: config.backupPhone }, reason, lookup }
      : { ...base, destination: { kind: "voicemail" }, reason: `${reason}_no_backup`, lookup };

  if (!config.google) return fallback("calendar_not_configured", null);

  const lookup = await lookupOnCall(config.google, now);
  if (lookup.found) {
    return {
      ...base,
      destination: { kind: "tech", phone: lookup.phone, name: lookup.name },
      reason: "calendar",
      lookup,
    };
  }

  return fallback(lookup.reason, lookup);
}
