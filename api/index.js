const Anthropic = require("@anthropic-ai/sdk").default;

const SK = process.env.STRIPE_SECRET_KEY || "";
const MP = process.env.STRIPE_MONTHLY_PRICE_ID || "";
const YP = process.env.STRIPE_YEARLY_PRICE_ID || "";
const APP = "https://circuitmess-automations.github.io/circuitblocks-ai";

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

async function callStripe(method, path, params) {
  if (!SK) throw new Error("Stripe not configured");
  const body = params ? new URLSearchParams(params).toString() : "";
  const r = await fetch("https://api.stripe.com/v1" + path + (method === "GET" && body ? "?" + body : ""), {
    method,
    headers: { "Authorization": "Bearer " + SK, "Content-Type": "application/x-www-form-urlencoded" },
    body: method !== "GET" ? body : undefined,
  });
  return r.json();
}

const classrooms = new Map();
const gallery = [];
const redeemed = new Set();
const subs = new Map();

module.exports = async (req, res) => {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();

  const p = (req.url || "/").replace(/\?.*$/, "").replace(/^\/api/, "");

  try {
    // Health
    if (p === "/health") {
      return res.json({ ok: true, hasStripe: !!SK, hasAnthropic: !!process.env.ANTHROPIC_API_KEY });
    }

    // ── Billing ──
    if (p === "/billing/create-checkout" && req.method === "POST") {
      const { plan, email, successUrl, cancelUrl } = req.body;
      const priceId = plan === "yearly" ? YP : MP;
      const s = await callStripe("POST", "/checkout/sessions", {
        mode: "subscription", "payment_method_types[0]": "card", customer_email: email,
        "line_items[0][price]": priceId, "line_items[0][quantity]": "1",
        success_url: successUrl || APP + "?checkout=success", cancel_url: cancelUrl || APP,
        "metadata[plan]": plan, "subscription_data[metadata][plan]": plan,
      });
      if (s.error) return res.status(400).json({ error: s.error.message });
      return res.json({ url: s.url, sessionId: s.id });
    }

    if (p === "/billing/portal" && req.method === "POST") {
      const c = await callStripe("GET", "/customers", { email: req.body.email, limit: "1" });
      if (!c.data?.length) return res.status(404).json({ error: "No customer found" });
      const s = await callStripe("POST", "/billing_portal/sessions", { customer: c.data[0].id, return_url: APP });
      return res.json({ url: s.url });
    }

    if (p === "/billing/status" && req.method === "POST") {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Email required" });
      const sub = subs.get(email);
      if (sub) { if (sub.expiresAt && Date.now() > sub.expiresAt) sub.status = "expired"; return res.json({ subscription: sub }); }
      if (SK) {
        try {
          const c = await callStripe("GET", "/customers", { email, limit: "1" });
          if (c.data?.length) {
            const sl = await callStripe("GET", "/subscriptions", { customer: c.data[0].id, status: "active", limit: "1" });
            if (sl.data?.length) return res.json({ subscription: { status: "pro", plan: sl.data[0].items.data[0].price.id === YP ? "yearly" : "monthly" } });
          }
        } catch {}
      }
      return res.json({ subscription: { status: "free" } });
    }

    if (p === "/billing/webhook" && req.method === "POST") {
      const ev = req.body;
      if (ev.type === "checkout.session.completed" && ev.data?.object?.customer_email) {
        subs.set(ev.data.object.customer_email, { status: "pro", plan: ev.data.object.metadata?.plan || "monthly", expiresAt: null });
      }
      return res.json({ received: true });
    }

    // ── Redeem ──
    if (p === "/redeem" && req.method === "POST") {
      const { serial, email } = req.body;
      if (!serial || serial.length < 6) return res.status(400).json({ error: "Invalid serial" });
      if (redeemed.has(serial.toUpperCase())) return res.status(409).json({ error: "Already redeemed" });
      redeemed.add(serial.toUpperCase());
      const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000;
      if (email) subs.set(email, { status: "trial", plan: "device_redemption", expiresAt });
      return res.json({ success: true, expiresAt, message: "3 months of Pro activated!" });
    }

    // ── Classroom ──
    if (p === "/classroom/create" && req.method === "POST") {
      const code = String(1000 + Math.floor(Math.random() * 9000));
      classrooms.set(code, { teacherName: req.body.teacherName || "Teacher", deviceId: req.body.deviceId || "", starterCode: req.body.starterCode || "", students: [], createdAt: Date.now() });
      return res.json({ code, room: classrooms.get(code) });
    }
    if (p === "/classroom/join" && req.method === "POST") {
      const room = classrooms.get(req.body.code);
      if (!room) return res.status(404).json({ error: "Room not found" });
      if (!room.students.find(s => s.name === req.body.studentName)) room.students.push({ name: req.body.studentName, joinedAt: Date.now(), hasRun: false });
      return res.json({ room });
    }
    if (p === "/classroom/status" && req.method === "POST") {
      const room = classrooms.get(req.body.code);
      return room ? res.json({ room }) : res.status(404).json({ error: "Room not found" });
    }
    if (p === "/classroom/broadcast" && req.method === "POST") {
      const room = classrooms.get(req.body.code);
      if (!room) return res.status(404).json({ error: "Room not found" });
      if (req.body.starterCode) room.starterCode = req.body.starterCode;
      if (req.body.deviceId) room.deviceId = req.body.deviceId;
      return res.json({ room });
    }

    // ── Gallery ──
    if (p === "/gallery/list") return res.json({ projects: gallery.slice(-50).reverse() });
    if (p === "/gallery/publish" && req.method === "POST") {
      const { title, description, deviceId, code, author } = req.body;
      if (!title || !code || !deviceId) return res.status(400).json({ error: "Missing fields" });
      const project = { id: `g_${Date.now()}`, title, description: description || "", deviceId, code, author: author || "Anonymous", createdAt: Date.now(), reactions: { fire: 0, heart: 0, star: 0 } };
      gallery.push(project);
      return res.json({ project });
    }
    if (p === "/gallery/react" && req.method === "POST") {
      const project = gallery.find(pr => pr.id === req.body.id);
      if (!project) return res.status(404).json({ error: "Not found" });
      if (project.reactions[req.body.reaction] !== undefined) project.reactions[req.body.reaction]++;
      return res.json({ reactions: project.reactions });
    }

    // ── Chat (default) ──
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const { messages, systemPrompt } = req.body;
    if (!messages || !systemPrompt) return res.status(400).json({ error: "Missing messages or systemPrompt" });

    const response = await getClient().messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 4096,
      system: systemPrompt,
      messages,
    });
    const text = response.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    return res.json({ text });

  } catch (err) {
    console.error("API error:", err.message, err.stack);
    return res.status(500).json({ error: err.message || "Internal error" });
  }
};
