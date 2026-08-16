// Plate Ledger — push fan-out.
//
// Deploy:
//   npx supabase functions deploy notify --project-ref kjaoltyumjmcunyvhmvb
//
// Secrets it needs (never in the repo — the private key is the whole point):
//   npx supabase secrets set VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
//
// Two jobs, chosen by the "kind" field of the request body:
//
//   {"kind":"fanout"}   Called by the app right after it uploads activity.
//                       Sends the caller's recent events to their friends.
//                       Authorised by the caller's own JWT — you can only ever
//                       fan out your own activity.
//
//   {"kind":"reminder"} Called by pg_cron. Nudges anyone whose local clock has
//                       just passed the reminder hour and who is under half way
//                       on a fuel goal. Requires the service-role key, so the
//                       open internet cannot trigger it.

import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const REMINDER_HOUR = 16;

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:nobody@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

/** A dead subscription 404s or 410s forever; drop it rather than retrying it daily. */
async function sendTo(userIds: string[], payload: unknown) {
  if (!userIds.length) return 0;
  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("*")
    .in("user_id", userIds);

  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
      );
      sent++;
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      }
    }
  }
  return sent;
}

async function friendsOf(userId: string) {
  const { data } = await admin
    .from("friendships")
    .select("requester,addressee")
    .eq("status", "accepted")
    .or(`requester.eq.${userId},addressee.eq.${userId}`);
  return (data ?? []).map((f) => (f.requester === userId ? f.addressee : f.requester));
}

function describe(ev: { type: string; payload: Record<string, unknown> }, who: string) {
  const p = ev.payload ?? {};
  if (ev.type === "workout_finished") {
    return {
      title: `${who} finished ${p.day ?? "a workout"}`,
      body: `${p.sets ?? 0} sets · ${Number(p.volume ?? 0).toLocaleString()} ${p.unit ?? "kg"}`,
    };
  }
  if (ev.type === "pr") {
    return {
      title: `${who} set a record`,
      body: `${p.exercise ?? "A lift"} · ${p.weight}×${p.reps}${p.per_hand ? " per hand" : ""}`,
    };
  }
  if (ev.type === "goal_hit") {
    return {
      title: `${who} hit their ${String(p.name ?? "daily").toLowerCase()} goal`,
      body: `${p.total} / ${p.target} ${p.unit ?? ""}`,
    };
  }
  return { title: `${who} logged something`, body: "" };
}

/** Fan the caller's own recent activity out to their friends. */
async function fanout(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: me, error } = await admin.auth.getUser(jwt);
  if (error || !me?.user) return json({ error: "not signed in" }, 401);
  const userId = me.user.id;

  const { data: profile } = await admin.from("profiles").select("handle").eq("id", userId).single();
  const who = profile?.handle ? "@" + profile.handle : "A friend";

  // only what landed in the last few minutes, so a re-sync of old history
  // cannot spam anyone's lock screen
  const since = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: events } = await admin
    .from("events")
    .select("type,payload,created_at,notified")
    .eq("user_id", userId)
    .eq("notified", false)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(10);

  if (!events?.length) return json({ sent: 0, events: 0 });

  const friends = await friendsOf(userId);
  let sent = 0;
  for (const ev of events) {
    const { title, body } = describe(ev, who);
    sent += await sendTo(friends, { title, body, tag: ev.type, url: "/plate-ledger/" });
  }

  await admin.from("events").update({ notified: true })
    .eq("user_id", userId).eq("notified", false).gte("created_at", since);

  return json({ sent, events: events.length });
}

/** Nudge anyone who is behind on fuel and whose local clock just passed the hour. */
async function reminder(req: Request) {
  const key = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  if (key !== SERVICE_KEY) return json({ error: "forbidden" }, 403);

  const { data: people } = await admin.from("profiles").select("id,handle,timezone");
  let nudged = 0;

  for (const p of people ?? []) {
    const tz = p.timezone || "UTC";
    let localHour: number, localDate: string;
    try {
      const now = new Date();
      localHour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", hour12: false }).format(now));
      localDate = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    } catch {
      continue; // unknown timezone, skip rather than guess
    }
    if (localHour !== REMINDER_HOUR) continue;

    const { data: rows } = await admin
      .from("fuel_days").select("*").eq("user_id", p.id).eq("date", localDate).maybeSingle();

    // No row at all means nothing has synced today — the server genuinely does
    // not know, so say so softly rather than claiming they have eaten nothing.
    const behind: string[] = [];
    const check = (label: string, total: number, target: number) => {
      if (target > 0 && total < target / 2) behind.push(label);
    };
    check("protein", Number(rows?.protein ?? 0), Number(rows?.target_protein ?? 0) || 200);
    check("creatine", Number(rows?.creatine ?? 0), Number(rows?.target_creatine ?? 0) || 10);
    check("water", Number(rows?.water ?? 0), Number(rows?.target_water ?? 0) || 3000);
    if (!behind.length) continue;

    const list = behind.length === 1
      ? behind[0]
      : behind.slice(0, -1).join(", ") + " and " + behind[behind.length - 1];

    nudged += await sendTo([p.id], {
      title: "Still short on " + list,
      body: "Under halfway with the day nearly gone — worth a top-up.",
      tag: "fuel-reminder",
      url: "/plate-ledger/",
    });
  }
  return json({ nudged });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    if (body.kind === "reminder") return await reminder(req);
    return await fanout(req);
  } catch (err) {
    return json({ error: String(err) }, 500);
  }
});
