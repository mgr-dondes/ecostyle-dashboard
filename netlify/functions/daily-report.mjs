// Netlify Scheduled Function: Daily Activity Report
// Runs Mon-Fri at 8:05 Kyiv time (5:05 UTC)
// Sends personalized report to each employee via Bitrix24 IM

import { schedule } from "@netlify/functions";

const WEBHOOK = "https://ecostyle.bitrix24.eu/rest/4/mc0jnypsq03nu8qu/";

async function bxCall(method, params = {}) {
  const resp = await fetch(WEBHOOK + method, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!resp.ok) throw new Error(`${method}: HTTP ${resp.status}`);
  return resp.json();
}

async function bxCallAll(method, params = {}, key = null) {
  let all = [], start = 0;
  while (true) {
    const data = await bxCall(method, { ...params, start });
    let items = data.result;
    if (key && items && items[key]) items = items[key];
    if (Array.isArray(items)) all = all.concat(items);
    if (!data.next) break;
    start = data.next;
  }
  return all;
}

function getReportDate() {
  // Kyiv timezone offset: UTC+3 in summer (EET/EEST)
  const now = new Date();
  const kyiv = new Date(now.toLocaleString("en-US", { timeZone: "Europe/Kyiv" }));
  const dayOfWeek = kyiv.getDay(); // 0=Sun, 1=Mon...

  // Mon → report for Fri, Tue-Fri → report for yesterday
  // Sat/Sun → don't run (but just in case, report for Fri)
  let daysBack = 1;
  if (dayOfWeek === 1) daysBack = 3; // Mon → Fri
  else if (dayOfWeek === 0) daysBack = 2; // Sun → Fri (safety)
  else if (dayOfWeek === 6) daysBack = 1; // Sat → Fri (safety)

  const reportDate = new Date(kyiv);
  reportDate.setDate(reportDate.getDate() - daysBack);
  const y = reportDate.getFullYear();
  const m = String(reportDate.getMonth() + 1).padStart(2, "0");
  const d = String(reportDate.getDate()).padStart(2, "0");
  return { dateStr: `${y}-${m}-${d}`, displayDate: `${d}.${m}.${y}`, dayOfWeek };
}

async function collectData(dateStr) {
  const [users, created, completed, changed, crm] = await Promise.all([
    bxCallAll("user.get", { filter: { ACTIVE: true, USER_TYPE: "employee" } }),
    bxCallAll("tasks.task.list", { filter: { ">=CREATED_DATE": dateStr, "<CREATED_DATE": dateStr + "T23:59:59" }, select: ["id", "createdBy"] }, "tasks"),
    bxCallAll("tasks.task.list", { filter: { ">=CLOSED_DATE": dateStr, "<CLOSED_DATE": dateStr + "T23:59:59", STATUS: 5 }, select: ["id", "responsibleId", "createdBy", "closedBy"] }, "tasks"),
    bxCallAll("tasks.task.list", { filter: { ">=CHANGED_DATE": dateStr, "<CHANGED_DATE": dateStr + "T23:59:59" }, select: ["id", "responsibleId", "createdBy", "changedBy"] }, "tasks"),
    bxCallAll("crm.activity.list", { filter: { ">=CREATED": dateStr + "T00:00:00", "<CREATED": dateStr + "T23:59:59" }, select: ["ID", "RESPONSIBLE_ID", "AUTHOR_ID"] }),
  ]);

  // Get chat messages
  let chatData;
  try {
    chatData = await bxCall("im.recent.get", {});
  } catch (e) {
    chatData = { result: [] };
  }
  const imItems = Array.isArray(chatData.result) ? chatData.result : (chatData.result?.items || []);
  const todayChats = imItems.filter(i => i.message?.date && String(i.message.date).includes(dateStr));

  // Count chat messages per user by fetching dialog messages
  const chatUsers = {};
  const chatPromises = todayChats.slice(0, 50).map(async (c) => {
    const did = c.type === "user" ? String(c.id) : "chat" + String(c.chat_id || c.id);
    try {
      const mr = await bxCall("im.dialog.messages.get", { DIALOG_ID: did, LIMIT: 50 });
      const msgs = mr.result?.messages || [];
      msgs.forEach(m => {
        if (m.date && String(m.date).includes(dateStr)) {
          const a = String(m.author_id || "");
          if (a && a !== "0") chatUsers[a] = (chatUsers[a] || 0) + 1;
        }
      });
    } catch (e) { /* skip */ }
  });
  await Promise.all(chatPromises);

  // Build per-user stats
  const um = {};
  users.forEach(u => {
    const id = String(u.ID);
    um[id] = {
      id, name: `${u.NAME || ""} ${u.LAST_NAME || ""}`.trim(),
      cr: 0, cx: 0, ct: 0, cm: 0, ch: 0, wk: 0
    };
  });

  created.forEach(t => { const u = String(t.createdBy || ""); if (u && um[u]) um[u].cr++; });
  completed.forEach(t => {
    const resp = String(t.responsibleId || "");
    const creator = String(t.createdBy || "");
    if (resp && um[resp]) um[resp].cx++;
    if (creator && creator !== resp && um[creator]) um[creator].ct++;
  });
  const uTasks = {};
  changed.forEach(t => {
    const tid = String(t.id || "");
    [t.responsibleId, t.createdBy, t.changedBy].forEach(v => {
      const u = String(v || "");
      if (u && um[u]) { if (!uTasks[u]) uTasks[u] = {}; uTasks[u][tid] = 1; }
    });
  });
  for (const uid in uTasks) if (um[uid]) um[uid].wk = Object.keys(uTasks[uid]).length;
  crm.forEach(a => {
    [a.RESPONSIBLE_ID, a.AUTHOR_ID].forEach(v => {
      const u = String(v || "");
      if (u && um[u]) um[u].cm++;
    });
  });
  for (const uid in chatUsers) if (um[uid]) um[uid].ch = chatUsers[uid];

  return um;
}

function buildReport(um, recipientId, displayDate) {
  const list = Object.values(um)
    .filter(u => u.cr > 0 || u.cx > 0 || u.ct > 0 || u.cm > 0 || u.ch > 0 || u.wk > 0)
    .sort((a, b) => {
      // Recipient first
      if (a.id === recipientId) return -1;
      if (b.id === recipientId) return 1;
      return (b.cr + b.cx + b.ct + b.cm + b.ch + b.wk) - (a.cr + a.cx + a.ct + a.cm + a.ch + a.wk);
    });

  if (list.length === 0) return null;

  const activeCount = list.length;
  const totalUsers = Object.keys(um).length;
  const pct = totalUsers ? Math.round(activeCount / totalUsers * 100) : 0;

  let msg = `[B]📊 Активність команди за ${displayDate}[/B]\n`;
  msg += `Активних: ${activeCount} з ${totalUsers} (${pct}%)\n\n`;

  list.forEach((u, i) => {
    const isMe = u.id === recipientId;
    const prefix = isMe ? "➡️ " : `${i + 1}. `;
    const bold = isMe ? "[B]" : "";
    const boldEnd = isMe ? "[/B]" : "";
    const stats = [];
    if (u.cr > 0) stats.push(`📝${u.cr}`);
    if (u.cx > 0) stats.push(`✅${u.cx}`);
    if (u.ct > 0) stats.push(`🔒${u.ct}`);
    if (u.cm > 0) stats.push(`💼${u.cm}`);
    if (u.ch > 0) stats.push(`💬${u.ch}`);
    if (u.wk > 0) stats.push(`📂${u.wk}`);
    msg += `${prefix}${bold}${u.name}${boldEnd}: ${stats.join(" ")}\n`;
  });

  msg += `\n📝створено ✅виконано 🔒закрито 💼CRM 💬дописів 📂оброблено`;
  return msg;
}

async function sendReports(um, displayDate) {
  const userIds = Object.keys(um);
  let sent = 0;

  for (const uid of userIds) {
    const report = buildReport(um, uid, displayDate);
    if (!report) continue;

    try {
      await bxCall("im.message.add", {
        DIALOG_ID: uid,
        MESSAGE: report,
      });
      sent++;
      // Rate limiting: 50ms between messages
      await new Promise(r => setTimeout(r, 50));
    } catch (e) {
      console.error(`Failed to send to user ${uid}:`, e.message);
    }
  }
  return sent;
}

const handler = async (event) => {
  try {
    const { dateStr, displayDate, dayOfWeek } = getReportDate();

    // Skip weekends (safety check — cron shouldn't run on weekends)
    if (dayOfWeek === 0 || dayOfWeek === 6) {
      return { statusCode: 200, body: "Weekend — skipped" };
    }

    console.log(`Collecting data for ${dateStr}...`);
    const um = await collectData(dateStr);

    console.log(`Sending reports...`);
    const sent = await sendReports(um, displayDate);

    console.log(`Done! Sent ${sent} reports for ${displayDate}`);
    return { statusCode: 200, body: `Sent ${sent} reports for ${displayDate}` };
  } catch (e) {
    console.error("Error:", e);
    return { statusCode: 500, body: e.message };
  }
};

// Run at 5:05 UTC = 8:05 Kyiv time (UTC+3)
// Mon-Fri only
export const config = {
  schedule: "5 5 * * 1-5",
};

export { handler };
