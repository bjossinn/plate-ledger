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
  if (!userIds.length) {
    console.log("sendTo: nobody to send to");
    return 0;
  }
  const { data: subs, error } = await admin
    .from("push_subscriptions")
    .select("*")
    .in("user_id", userIds);

  if (error) console.log("sendTo: subscription lookup failed —", error.message);
  console.log(`sendTo: ${userIds.length} recipient(s), ${subs?.length ?? 0} subscription(s)`);

  let sent = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
      );
      sent++;
      console.log("sendTo: delivered to", s.endpoint.slice(0, 48));
    } catch (err) {
      const code = (err as { statusCode?: number }).statusCode;
      console.log(`sendTo: FAILED (${code ?? "no status"}) ${s.endpoint.slice(0, 48)} — ${String(err).slice(0, 200)}`);
      if (code === 404 || code === 410) {
        await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
        console.log("sendTo: dropped a dead subscription");
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

const METRIC_EMOJI: Record<string, string> = { protein: "🍗", creatine: "⚡", water: "💧" };

/** Wording deliberately mirrors the in-app feed, so a lock screen and the
    Friends tab do not describe the same event two different ways. */
function describe(ev: { type: string; payload: Record<string, unknown> }, who: string) {
  const p = ev.payload ?? {};

  if (ev.type === "workout_finished") {
    const bits: string[] = [];
    if (p.lifts) bits.push(`${p.lifts} exercise${Number(p.lifts) === 1 ? "" : "s"}`);
    bits.push(`${p.sets ?? 0} set${Number(p.sets) === 1 ? "" : "s"}`);
    bits.push(`${Number(p.volume ?? 0).toLocaleString()} ${p.unit ?? "kg"}`);
    if (p.minutes) {
      const h = Math.floor(Number(p.minutes) / 60), m = Number(p.minutes) % 60;
      bits.push(h ? `${h}h ${m}m` : `${m} min`);
    }
    if (p.prs) bits.push(`${p.prs} record${Number(p.prs) === 1 ? "" : "s"} 🏆`);
    return {
      title: `🏋️ ${who} finished an exercise`,
      body: `${p.day ?? "A workout"} — ${bits.join(" · ")}`,
    };
  }

  if (ev.type === "pr") {
    return {
      title: `🏆 ${who} set a personal record`,
      body: `${p.exercise ?? "A lift"} — ${p.weight}×${p.reps}${p.per_hand ? " per hand" : ""}`,
    };
  }

  if (ev.type === "goal_hit") {
    const emoji = METRIC_EMOJI[String(p.metric ?? "")] ?? "🎯";
    return {
      title: `${emoji} ${who} hit their ${String(p.name ?? "daily").toLowerCase()} goal`,
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
  const { data: events, error: evErr } = await admin
    .from("events")
    .select("type,payload,created_at,notified")
    .eq("user_id", userId)
    .eq("notified", false)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(10);

  if (evErr) {
    console.log("fanout: event lookup failed —", evErr.message);
    return json({ error: evErr.message }, 500);
  }

  console.log(`fanout: ${who} has ${events?.length ?? 0} unannounced event(s) since ${since}`);
  if (!events?.length) return json({ sent: 0, events: 0 });

  const friends = await friendsOf(userId);
  console.log(`fanout: ${friends.length} accepted friend(s)`);
  let sent = 0;
  for (const ev of events) {
    const { title, body } = describe(ev, who);
    sent += await sendTo(friends, { title, body, tag: ev.type, url: "/plate-ledger/" });
  }

  await admin.from("events").update({ notified: true })
    .eq("user_id", userId).eq("notified", false).gte("created_at", since);

  console.log(`fanout: done — ${sent} push(es) accepted for ${events.length} event(s)`);
  return json({ sent, events: events.length });
}

/** Send the caller a notification on their own devices, to prove the chain works.
    Scoped to whoever is signed in, so it can never be used to ping someone else. */
async function selftest(req: Request) {
  const jwt = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const { data: me, error } = await admin.auth.getUser(jwt);
  if (error || !me?.user) return json({ error: "not signed in" }, 401);

  const { data: profile } = await admin.from("profiles").select("handle").eq("id", me.user.id).single();
  const { data: subs } = await admin.from("push_subscriptions").select("id").eq("user_id", me.user.id);
  console.log(`selftest: @${profile?.handle ?? "?"} has ${subs?.length ?? 0} registered device(s)`);

  const sent = await sendTo([me.user.id], {
    title: "Plate Ledger is wired up",
    body: "If you can read this, notifications work" + (profile?.handle ? ", @" + profile.handle : "") + ".",
    tag: "selftest",
    url: "/plate-ledger/",
  });
  return json({ sent, devices: subs?.length ?? 0 });
}

/* ---------- fuel reminders ----------
   Pace, not a fixed halfway mark. Each checkpoint carries the fraction of the
   day's target you would ideally be at, and a nudge only fires below
   ideal x TOLERANCE — so being merely a bit behind never buzzes anyone.

   Water is spread evenly so its pace is linear. Protein is NOT: it arrives in
   meals, so its checkpoints sit just after people eat rather than pretending
   intake is continuous. Creatine is one dose, where pace means nothing at all. */

const TOLERANCE = 0.6;
const DEFAULTS: Record<string, number> = { protein: 200, creatine: 10, water: 3000 };

type Checkpoint = { at: string; hour: number; ideal: Record<string, number> };

const CHECKPOINTS: Checkpoint[] = [
  { at: "12:00", hour: 12, ideal: { water: 0.30 } },
  { at: "14:00", hour: 14, ideal: { protein: 0.40 } },
  { at: "15:00", hour: 15, ideal: { water: 0.55 } },
  { at: "18:00", hour: 18, ideal: { water: 0.80, protein: 0.70 } },
  { at: "19:00", hour: 19, ideal: { water: 0.88 } },          // last call for water
  { at: "20:00", hour: 20, ideal: { protein: 0.90 } },
  { at: "21:00", hour: 21, ideal: { creatine: 0 } },          // binary: taken or not
];

const MAX_PER_METRIC_PER_DAY = 2;

/* Same nudge every day stops being read. Varied by day and metric so it is
   stable within a day but different tomorrow. */
const LINES: Record<string, Array<(d: string, t: string, left: string) => [string, string]>> = {
  water: [
    (d, t, left) => ["💧 Your water bottle is sulking", `${d} of ${t}. ${left} still owed.`],
    (_d, _t, left) => ["💧 Best tap water on earth", `And you are ignoring it. ${left} to go.`],
    (d, t, left) => ["💧 Hydration check", `${d} of ${t} — ${left} left before the day runs out.`],
  ],
  protein: [
    (d, t, left) => ["🍗 Protein is lagging", `${d} of ${t}. That builds nothing. ${left} to go.`],
    (_d, _t, left) => ["🍗 Gains need groceries", `${left} of protein still owed today.`],
    (d, t, _left) => ["🍗 Feed the machine", `${d} of ${t} so far. The bar noticed.`],
  ],
  creatine: [
    () => ["⚡ Creatine untouched", "Five grams. Ten seconds. Go on."],
    () => ["⚡ Your creatine is sulking in the tub", "It has one job and so do you."],
    () => ["⚡ Scoop missing", "The cheapest thing that works and it is still sitting there."],
  ],
};

function fmt(metric: string, value: number) {
  if (metric === "water") {
    const litres = value / 1000;
    return (Math.round(litres * 100) / 100) + " L";
  }
  return Math.round(value) + " g";
}

function pick<T>(list: T[], seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return list[h % list.length];
}

async function reminder(req: Request) {
  const key = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
  const token = Deno.env.get("REMINDER_TOKEN") ?? "";
  if (key !== SERVICE_KEY && !(token && key === token)) return json({ error: "forbidden" }, 403);

  const { data: people } = await admin.from("profiles").select("id,handle,timezone");
  let nudged = 0, considered = 0;

  for (const p of people ?? []) {
    const tz = p.timezone;
    if (!tz) continue;                       // no zone, no idea when their day is

    let hour: number, date: string;
    try {
      const now = new Date();
      hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "numeric", hour12: false }).format(now));
      date = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);
    } catch {
      continue;                              // unknown zone: skip rather than guess
    }

    const cp = CHECKPOINTS.find((c) => c.hour === hour);
    if (!cp) continue;
    considered++;

    const { data: row } = await admin
      .from("fuel_days").select("*").eq("user_id", p.id).eq("date", date).maybeSingle();

    const { data: already } = await admin
      .from("reminder_log").select("metric,checkpoint").eq("user_id", p.id).eq("date", date);
    const sentAt = new Set((already ?? []).map((r) => `${r.metric}|${r.checkpoint}`));
    const countFor = (m: string) => (already ?? []).filter((r) => r.metric === m).length;

    const behind: Array<{ metric: string; done: number; target: number }> = [];

    for (const [metric, ideal] of Object.entries(cp.ideal)) {
      if (sentAt.has(`${metric}|${cp.at}`)) continue;                 // already sent this one
      if (countFor(metric) >= MAX_PER_METRIC_PER_DAY) continue;       // enough for one day

      const target = Number(row?.[`target_${metric}`] ?? 0) || DEFAULTS[metric];
      const done = Number(row?.[metric] ?? 0);
      if (done >= target) continue;                                   // already there

      const isBehind = metric === "creatine" ? done <= 0 : done < target * ideal * TOLERANCE;
      if (isBehind) behind.push({ metric, done, target });
    }

    if (!behind.length) continue;

    /* One buzz per checkpoint, even when two metrics are lagging. */
    let title: string, body: string;
    if (behind.length === 1) {
      const b = behind[0];
      const line = pick(LINES[b.metric], date + b.metric);
      [title, body] = line(fmt(b.metric, b.done), fmt(b.metric, b.target), fmt(b.metric, b.target - b.done));
    } else {
      const names = behind.map((b) => b.metric).join(" and ");
      title = "💧🍗 Behind on " + names;
      body = behind.map((b) => `${b.metric}: ${fmt(b.metric, b.done)} of ${fmt(b.metric, b.target)}`).join(" · ");
    }

    /* Record the DECISION before attempting delivery. If it were recorded only
       on success, a phone that is unreachable right now would be re-attempted
       every half hour for the rest of the day. A missed checkpoint is far
       better than a loop, and there are later checkpoints anyway. */
    await admin.from("reminder_log").upsert(
      behind.map((b) => ({ user_id: p.id, date, metric: b.metric, checkpoint: cp.at })),
      { onConflict: "user_id,date,metric,checkpoint", ignoreDuplicates: true },
    );

    const sent = await sendTo([p.id], { title, body, tag: "fuel-reminder", url: "/plate-ledger/" });
    if (sent) nudged++;
    console.log(`reminder: @${p.handle} at ${cp.at} local — behind on ${behind.map((b) => b.metric).join(", ")}, delivered to ${sent}`);
  }

  console.log(`reminder: ${considered} at a checkpoint, ${nudged} nudged`);
  return json({ considered, nudged });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json().catch(() => ({}));
    console.log("notify: invoked, kind =", body.kind ?? "fanout");
    if (body.kind === "reminder") return await reminder(req);
    if (body.kind === "test") return await selftest(req);
    return await fanout(req);
  } catch (err) {
    console.log("notify: unhandled error —", String(err));
    return json({ error: String(err) }, 500);
  }
});
