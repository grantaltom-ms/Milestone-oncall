"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * The morning after. Every recorded after-hours call and every voicemail, with
 * the unit it came from already resolved, a player to listen back, and the note
 * ready to paste into AppFolio — which is the only place this information
 * finally has to live.
 *
 * Behind the same password as the scheduling dashboard: these are recordings of
 * residents.
 */

type Call = {
  id: string;
  callSid: string;
  recordingSid: string | null;
  recordingSeconds: number | null;
  kind: "call" | "voicemail";
  callerPhone: string | null;
  propertyName: string | null;
  unit: string | null;
  tenantName: string | null;
  matchCount: number;
  startedAt: string;
  transcript: string | null;
  summary: string | null;
};

function when(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function duration(seconds: number | null): string {
  if (!seconds) return "";
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min ${seconds % 60} sec` : `${seconds} sec`;
}

function phone(value: string | null): string {
  const match = value ? /^\+1(\d{3})(\d{3})(\d{4})$/.exec(value) : null;
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : (value ?? "unknown number");
}

/** "Mendoza, Christopher" is how AppFolio stores it; people say it the other way. */
function readableName(name: string): string {
  const comma = name.indexOf(",");
  if (comma < 1) return name;
  const first = name.slice(comma + 1).trim();
  return first ? `${first} ${name.slice(0, comma).trim()}` : name;
}

function where(call: Call): string {
  if (!call.propertyName) {
    return call.matchCount > 1
      ? `${call.matchCount} units share this number`
      : "Number not in the tenant directory";
  }
  const unit = call.unit ? ` #${call.unit}` : "";
  const tenant = call.tenantName ? ` — ${readableName(call.tenantName)}` : "";
  return `${call.propertyName}${unit}${tenant}`;
}

/**
 * The block that goes in AppFolio. Everything the system already knows is
 * filled in; the three lines a person has to think about are left blank on
 * purpose, because a prefilled "resolved" is how a log stops being true.
 */
function noteFor(call: Call, origin: string): string {
  const link = call.recordingSid ? `${origin}/api/calls/${call.recordingSid}/audio` : "no recording";
  const length = duration(call.recordingSeconds);
  const header = [
    `After-hours ${call.kind === "voicemail" ? "voicemail" : "call"} — ${when(call.startedAt)}`,
    where(call),
    `From ${phone(call.callerPhone)}${length ? ` · ${length}` : ""}`,
    `Recording: ${link}`,
  ];

  // With a summary the note is nearly written, and what is left is the part a
  // person has to decide. Without one it is the blank form it always was.
  return call.summary
    ? [...header, "", call.summary.trim(), "", "Action taken:"].join("\n")
    : [...header, "", "Reported:", "Action taken:", "Follow-up:"].join("\n");
}

type LoadResult = {
  authed: boolean;
  calls?: Call[];
  recording?: boolean;
  error?: string;
};

/** Reads the call log. Touches no React state, so it can run inside an effect. */
async function fetchCalls(): Promise<LoadResult> {
  const res = await fetch("/api/calls");
  if (res.status === 401) return { authed: false };
  const body = await res.json();
  if (!res.ok) return { authed: true, error: body.error ?? "Could not load the call log." };
  return { authed: true, calls: (body.calls ?? []) as Call[], recording: body.recording !== false };
}

export default function CallsPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [calls, setCalls] = useState<Call[]>([]);
  const [recording, setRecording] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchCalls()
      .catch((cause: unknown): LoadResult => ({
        // Never leave the page on "Loading…": say what happened and offer the
        // one control that can recover it.
        authed: false,
        error: `Could not reach the call log: ${cause instanceof Error ? cause.message : "unknown error"}.`,
      }))
      .then((result) => {
        if (cancelled) return;
        setAuthed(result.authed);
        if (result.calls) setCalls(result.calls);
        if (result.recording !== undefined) setRecording(result.recording);
        setError(result.error ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

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

  async function copy(call: Call) {
    const note = noteFor(call, window.location.origin);
    try {
      await navigator.clipboard.writeText(note);
      setCopied(call.id);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      setError("This browser would not let the page copy. Select the note and copy it by hand.");
    }
  }

  if (authed === null) return <main><p className="lede">Loading…</p></main>;

  if (!authed) {
    return (
      <main>
        <h1>After-hours call log</h1>
        <p className="lede">Sign in to listen back. Same password as the scheduling dashboard.</p>
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
      <h1>After-hours call log</h1>
      <p className="lede">
        Recorded calls and voicemails, newest first, with the unit already matched from the tenant
        directory and the call summarized. Read it, listen if you need to, then copy the note into
        the AppFolio work order.
      </p>

      {error && <div className="card"><p className="warn">{error}</p></div>}

      {!recording && (
        <div className="card">
          <strong className="warn">Call recording is off.</strong>
          <p className="muted">
            Voicemails are still logged here. Set <code>ONCALL_RECORD_CALLS=true</code> to record
            answered calls as well — every caller then hears the announcement first.
          </p>
        </div>
      )}

      <div className="card">
        {calls.length === 0 && <p className="lede">Nothing logged yet.</p>}
        <table className="table">
          <tbody>
            {calls.map((call) => (
              <tr key={call.id}>
                <td>
                  <strong>{where(call)}</strong>
                  <br />
                  <span className="muted">
                    {when(call.startedAt)} · {phone(call.callerPhone)}
                    {call.recordingSeconds ? ` · ${duration(call.recordingSeconds)}` : ""}
                    {call.kind === "voicemail" ? " · voicemail" : ""}
                  </span>
                  {call.summary && <p className="summary">{call.summary}</p>}
                  {call.recordingSid && (
                    <audio
                      controls
                      preload="none"
                      src={`/api/calls/${call.recordingSid}/audio`}
                      style={{ marginTop: "0.5rem", width: "100%" }}
                    />
                  )}
                  {call.transcript && (
                    <details className="transcript">
                      <summary>Transcript</summary>
                      <pre>{call.transcript}</pre>
                    </details>
                  )}
                </td>
                <td className="right">
                  <button className="btn btn-quiet" type="button" onClick={() => copy(call)}>
                    {copied === call.id ? "Copied" : "Copy note"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="lede">
        Recordings live in Twilio and play through this page, which is why it asks for a password —
        these are recordings of residents, and the transcripts are the same thing in a form that is
        far easier to forward. Delete recordings on Twilio&apos;s own retention schedule, and decide
        separately how long the transcripts should live.
      </p>
    </main>
  );
}
