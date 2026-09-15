import { formatUS } from "./phone";
import { MAX_MATCHES, type CallerLookup, type CallerMatch } from "./tenants";

/**
 * The one piece of writing in this system a technician actually reads: the
 * text that lands as their phone starts ringing at 2am.
 *
 * It is written to a hard 160 characters — one SMS segment. A longer message
 * is split by the carrier into parts that can arrive out of order, and the
 * part that matters is the one with the callback number in it. That budget is
 * why the property is shortened, the name initialed and, in the worst case,
 * dropped: the unit and the number survive, everything else gives way.
 */

/** One GSM-7 SMS segment. Past this a carrier splits the message. */
export const SMS_LIMIT = 160;

/** A misconfigured company name must never push the callback number out. */
const COMPANY_LIMIT = 40;

/**
 * A text with any character outside the GSM-7 alphabet is sent as UCS-2, where
 * one segment is 70 characters rather than 160 — so a single accented letter
 * in a resident's name would silently split the message. Accents are stripped
 * (Jose, not José) and anything still exotic is dropped.
 */
function gsm7(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[‐-―]/g, "-") // en/em dashes, which Word and AppFolio both produce
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e\n]/g, "")
    .trim();
}

/** A line, or nothing at all — never a line that would split the message. */
const fits = (line: string, budget: number): string | null =>
  line.length <= budget ? line : null;

/** "Willow Lake Apartments" → "Willow Lake". Nobody needs telling twice. */
function shortProperty(name: string): string {
  return gsm7(name).replace(/\s+apartments$/i, "").trim() || gsm7(name);
}

/** "S - 01" → "S-01": AppFolio pads unit labels, and the padding costs three characters. */
function shortUnit(unit: string): string {
  return gsm7(unit).replace(/\s*-\s*/g, "-").trim();
}

/**
 * AppFolio exports "Mendoza, Christopher". A technician reads "Christopher
 * Mendoza" a beat faster, and "Christopher M." when the line is tight.
 */
function readableName(name: string): string {
  const clean = gsm7(name);
  const comma = clean.indexOf(",");
  if (comma < 1) return clean;
  const last = clean.slice(0, comma).trim();
  const first = clean.slice(comma + 1).trim();
  return first ? `${first} ${last}` : last;
}

function initialed(name: string): string {
  const parts = readableName(name).split(/\s+/).filter(Boolean);
  if (parts.length < 2) return parts.join(" ");
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

/**
 * Where the call is coming from, in as few characters as the budget allows.
 * Tried in order, most useful first — the unit is the last thing to go.
 */
function identityLine(match: CallerMatch, budget: number): string | null {
  const property = shortProperty(match.propertyName);
  const unit = match.unit ? ` #${shortUnit(match.unit)}` : "";
  const name = match.tenantName ? readableName(match.tenantName) : "";
  const place = `${property}${unit}`.trim();

  // A comma rather than a dash between the unit and the name: it reads the
  // same and costs a character, and characters are what buy the name a place
  // on the line at all.
  const options = [
    name ? `${place}, ${name}` : place,
    name ? `${place}, ${initialed(match.tenantName ?? "")}` : place,
    place,
    unit ? `Unit ${shortUnit(match.unit ?? "")}` : "",
  ];

  for (const option of options) {
    if (option && option.length <= budget) return option;
  }
  return null;
}

/**
 * What the lookup found, as a line of text — or null when there was no lookup
 * to report, in which case the message reads exactly as it did before the
 * directory was wired up.
 */
function whoIsCalling(lookup: CallerLookup | null | undefined, budget: number): string | null {
  if (!lookup || budget < 12) return null;
  // A lookup that could not run says nothing at all. "Not in the directory" and
  // "the directory was unreachable" mean opposite things to whoever is driving.
  if (lookup.error) return null;

  const { matches } = lookup;
  if (matches.length === 0) return fits("Number not in the tenant directory.", budget);
  if (matches.length === 1) return identityLine(matches[0], budget);

  // Naming one of several is worse than naming none: it sends somebody to a
  // door with confidence, and one time in two it is the wrong door.
  const count = matches.length > MAX_MATCHES ? `${MAX_MATCHES}+` : String(matches.length);
  return (
    fits(`${count} units share this number.`, budget) ?? fits(`${count} possible units.`, budget)
  );
}

/**
 * Exported for tests — the wording is the product here, not an implementation
 * detail.
 */
export function incomingCallMessage(
  companyName: string,
  callerNumber: string | null,
  lookup?: CallerLookup | null
): string {
  const opening = `${gsm7(companyName).slice(0, COMPANY_LIMIT)} after-hours call ringing you now.`;

  if (!callerNumber) {
    // Nothing to look up and nothing to call back, so say the one useful thing.
    return `${opening}\nCaller ID came through blocked. Get a callback number on the call.`.slice(
      0,
      SMS_LIMIT
    );
  }

  const callback = `Callback: ${formatUS(callerNumber)}`;
  // Said plainly, because the number on the screen is the office line, and
  // calling it back after hours routes straight into this same rotation.
  const warning = "Do not call back the number on your screen.";

  const spent = opening.length + callback.length + warning.length + 3; // three newlines
  const identity = whoIsCalling(lookup, SMS_LIMIT - spent);

  return [opening, identity, callback, warning].filter(Boolean).join("\n").slice(0, SMS_LIMIT);
}
