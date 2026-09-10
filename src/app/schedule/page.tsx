"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * The scheduling dashboard: who is on call, when, and an honest view of the
 * gaps. Everything here writes real Google Calendar events, so a shift added
 * on this page and one typed into Google Calendar on a phone are the same
 * thing — and the phone line picks either up within seconds.
 */

type Shift = { id: string; techName: string; phone: string | null; start: string; end: string };
type Tech = { id: string; name: string; phone: string; active: boolean };

const DAY = 86_400_000;

function fmt(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** A datetime-local value for the next Friday at 5pm, the usual handoff. */
function nextFridayAt5(from = new Date()): string {
  const date = new Date(from);
  date.setSeconds(0, 0);
  date.setHours(17, 0);
  const daysUntilFriday = (5 - date.getDay() + 7) % 7;
  date.setDate(date.getDate() + (daysUntilFriday === 0 && from.getHours() >= 17 ? 7 : daysUntilFriday));
  return toLocalInput(date);
}

function toLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function addDays(localInput: string, days: number): string {
  const date = new Date(localInput);
  date.setDate(date.getDate() + days);
  return toLocalInput(date);
}

type Problem = { kind: "gap" | "overlap"; from: string; to: string };

/** Uncovered stretches and double-booked stretches, in order. */
function findProblems(shifts: Shift[]): Problem[] {
  const sorted = [...shifts].sort((a, b) => a.start.localeCompare(b.start));
  const problems: Problem[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const end = new Date(sorted[i].end).getTime();
    const nextStart = new Date(sorted[i + 1].start).getTime();
    // A minute of slop: handoffs typed by hand rarely line up to the second.
    if (nextStart - end > 60_000) {
      problems.push({ kind: "gap", from: sorted[i].end, to: sorted[i + 1].start });
    } else if (end - nextStart > 60_000) {
      problems.push({ kind: "overlap", from: sorted[i + 1].start, to: sorted[i].end });
    }
  }
  return problems;
}

type LoadResult = {
  authed: boolean;
  now: number;
  shifts?: Shift[];
  techs?: Tech[];
  error?: string;
  rosterError?: string;
};

/** Reads the schedule and roster. Touches no React state. */
async function fetchSchedule(): Promise<LoadResult> {
  const now = Date.now();
  const from = new Date(now - 7 * DAY).toISOString();
  const to = new Date(now + 120 * DAY).toISOString();

  const res = await fetch(`/api/schedule/shifts?from=${from}&to=${to}`);
  if (res.status === 401) return { authed: false, now };

  const body = await res.json();
  if (!res.ok) return { authed: true, now, error: body.error ?? "Could not load the schedule." };

  const result: LoadResult = { authed: true, now, shifts: body.shifts ?? [] };

  const rosterRes = await fetch("/api/schedule/techs");
  const rosterBody = await rosterRes.json();
  if (rosterRes.ok) {
    result.techs = (rosterBody.techs ?? []).filter((tech: Tech) => tech.active);
  } else {
    result.rosterError = rosterBody.error ?? "Could not load the roster.";
  }
  return result;
}

export default function SchedulePage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [now, setNow] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [techs, setTechs] = useState<Tech[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);

  const [techId, setTechId] = useState("");
  const [start, setStart] = useState(() => nextFridayAt5());
  const [end, setEnd] = useState(() => addDays(nextFridayAt5(), 7));
  const [editing, setEditing] = useState<string | null>(null);

  // Fetching is kept free of setState so it can run inside an effect without
  // cascading renders; the result is applied afterwards, in one pass.
  const applyResult = useCallback((result: LoadResult) => {
    setAuthed(result.authed);
    setNow(result.now);
    if (result.shifts) setShifts(result.shifts);
    if (result.techs) {
      setTechs(result.techs);
      setTechId((current) => current || result.techs?.[0]?.id || "");
    }
    setError(result.error ?? null);
    setRosterError(result.rosterError ?? null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSchedule().then((result) => {
      if (!cancelled) applyResult(result);
    });
    return () => {
      cancelled = true;
    };
  }, [applyResult, reloadKey]);

  const reload = useCallback(() => setReloadKey((n) => n + 1), []);

  async function signIn(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/schedule/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "Sign in failed.");
      return;
    }
    setPassword("");
    reload();
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    const tech = techs.find((t) => t.id === techId);
    if (!tech) {
      setError("Pick a technician.");
      return;
    }
    setBusy(true);
    setError(null);

    const payload = {
      techName: tech.name,
      phone: tech.phone,
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    };
    const res = await fetch(
      editing ? `/api/schedule/shifts/${encodeURIComponent(editing)}` : "/api/schedule/shifts",
      {
        method: editing ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      }
    );
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not save that shift.");
      return;
    }
    setEditing(null);
    reload();
  }

  async function remove(id: string) {
    setBusy(true);
    const res = await fetch(`/api/schedule/shifts/${encodeURIComponent(id)}`, { method: "DELETE" });
    setBusy(false);
    if (!res.ok) {
      setError((await res.json()).error ?? "Could not delete that shift.");
      return;
    }
    reload();
  }

  function beginEdit(shift: Shift) {
    setEditing(shift.id);
    setStart(toLocalInput(new Date(shift.start)));
    setEnd(toLocalInput(new Date(shift.end)));
    const match = techs.find((t) => t.name === shift.techName);
    if (match) setTechId(match.id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  const problems = useMemo(() => findProblems(shifts), [shifts]);
  // `now` is captured when the schedule loads rather than read during render,
  // which keeps this component pure and its output stable between renders.
  const onCallNow = useMemo(
    () =>
      now === 0
        ? undefined
        : shifts.find(
            (s) => new Date(s.start).getTime() <= now && new Date(s.end).getTime() > now
          ),
    [shifts, now]
  );

  if (authed === null) return <main><p className="lede">Loading…</p></main>;

  if (!authed) {
    return (
      <main>
        <h1>On-call schedule</h1>
        <p className="lede">Sign in to change the rotation.</p>
        <form className="card" onSubmit={signIn}>
          <label className="label" htmlFor="pw">Password</label>
          <input
            id="pw"
            className="input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
          <button className="btn" type="submit" disabled={busy || !password}>
            {busy ? "Checking…" : "Sign in"}
          </button>
          {error && <p className="warn">{error}</p>}
        </form>
      </main>
    );
  }

  return (
    <main>
      <h1>On-call schedule</h1>
      <p className="lede">
        Every change here writes to the Maintenance On-Call calendar. The phone line picks it up on
        the next call — no deploy, no Twilio login.
      </p>

      <div className="card">
        <strong>On call right now: </strong>
        {onCallNow ? (
          <span className="ok">{onCallNow.techName} · until {fmt(onCallNow.end)}</span>
        ) : (
          <span className="warn">nobody — calls fall through to the backup manager</span>
        )}
      </div>

      {error && <div className="card"><p className="warn">{error}</p></div>}
      {rosterError && <div className="card"><p className="warn">Roster: {rosterError}</p></div>}

      <form className="card" onSubmit={save}>
        <h2>{editing ? "Edit shift" : "Add a shift"}</h2>
        <div className="row-form">
          <div>
            <label className="label" htmlFor="tech">Technician</label>
            <select id="tech" className="input" value={techId} onChange={(e) => setTechId(e.target.value)}>
              {techs.length === 0 && <option value="">No technicians in the roster</option>}
              {techs.map((tech) => (
                <option key={tech.id} value={tech.id}>{tech.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="start">Starts</label>
            <input id="start" className="input" type="datetime-local" value={start}
              onChange={(e) => { setStart(e.target.value); if (!editing) setEnd(addDays(e.target.value, 7)); }} />
          </div>
          <div>
            <label className="label" htmlFor="end">Ends</label>
            <input id="end" className="input" type="datetime-local" value={end}
              onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
        <div className="actions">
          <button className="btn" type="submit" disabled={busy || techs.length === 0}>
            {busy ? "Saving…" : editing ? "Save changes" : "Add shift"}
          </button>
          {editing && (
            <button className="btn btn-quiet" type="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          )}
        </div>
      </form>

      {problems.length > 0 && (
        <div className="card">
          <strong className="warn">Coverage problems</strong>
          <ul>
            {problems.map((problem, i) => (
              <li key={i}>
                {problem.kind === "gap" ? "Nobody on call" : "Two people on call"} from{" "}
                {fmt(problem.from)} to {fmt(problem.to)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="card">
        <h2>Shifts</h2>
        {shifts.length === 0 && <p className="lede">No shifts yet. Every call goes to the backup manager.</p>}
        <table className="table">
          <tbody>
            {shifts.map((shift) => (
              <tr key={shift.id}>
                <td><strong>{shift.techName}</strong><br /><span className="muted">{shift.phone ?? "no number — will not route"}</span></td>
                <td>{fmt(shift.start)}<br /><span className="muted">to {fmt(shift.end)}</span></td>
                <td className="right">
                  <button className="btn btn-quiet" type="button" onClick={() => beginEdit(shift)}>Edit</button>{" "}
                  <button className="btn btn-quiet" type="button" onClick={() => remove(shift.id)} disabled={busy}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
