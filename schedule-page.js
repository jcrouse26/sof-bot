/**
 * SOF Bot — workshop schedule admin page (HTML)
 * ─────────────────────────────────────────────────────────────────────────
 * Styled to match the tester UI at `/`. Kept in its own module because
 * server.js is already large.
 *
 * No window.confirm() anywhere — destructive actions use a two-click inline
 * confirm instead, so a modal can never block the page.
 */

const STYLE = `
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
/* Saints of Flow tokens, lifted from tfc-platform/styles/colors.css. That file
   is explicit that the base stays warm and light — never dark, never stark
   white — which this page previously ignored. */
:root{
  --cream-100:#FBF6EC;--cream-200:#F6EFE0;--cream-300:#F0E6D2;--cream-400:#E7D9BC;
  --sand-500:#C9B48C;--umber-600:#8C7A5C;--umber-700:#6B5A42;--ink-800:#3A2E22;
  --moss-500:#6B7A44;--moss-600:#57603A;--moss-100:#E7ECD9;
  --clay-500:#B65B3A;--clay-600:#9A4A2D;--clay-100:#F3DDCF;
  --gold-500:#C99A3E;--gold-100:#F2E3BE;
  --bg:var(--cream-100);--surface:var(--cream-200);--surface2:var(--cream-300);
  --border:var(--cream-400);--text:var(--ink-800);--text-dim:var(--umber-600);
  --gold:var(--gold-500);--gold-dim:var(--sand-500);--red:var(--clay-600);--green:var(--moss-500);
  --radius:14px}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:0 0 80px}
.wrap{width:100%;max-width:980px;margin:0 auto;padding:0 24px}
.header{padding:28px 0 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.header-left{display:flex;align-items:center;gap:12px}
.avatar{width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--clay-500),var(--gold-500));display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;color:var(--cream-100)}
h1{font-size:17px;font-weight:600}
.sub{font-size:12px;color:var(--text-dim);margin-top:2px}
.badge{font-size:11px;font-family:'DM Mono',monospace;color:var(--moss-600);background:var(--moss-100);border:1px solid rgba(107,122,68,.25);padding:3px 10px;border-radius:20px}
.badge.warn{color:var(--clay-600);background:var(--clay-100);border-color:rgba(182,91,58,.3)}
section{margin-top:28px}
h2{font-size:12px;font-family:'DM Mono',monospace;color:var(--text-dim);text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px}
.live{display:flex;gap:28px;flex-wrap:wrap}
.live div{min-width:150px}
.live .k{font-size:11px;font-family:'DM Mono',monospace;color:var(--text-dim);margin-bottom:4px}
.live .v{font-size:15px;font-weight:500;color:var(--clay-600)}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;font-family:'DM Mono',monospace;color:var(--text-dim);font-weight:400;padding:0 10px 10px;text-transform:uppercase;letter-spacing:.06em}
td{padding:11px 10px;border-top:1px solid var(--border);font-size:14px;vertical-align:middle}
tr.past td{opacity:.5}
.day{font-weight:500}
.note{color:var(--text-dim);font-size:13px}
.time{font-family:'DM Mono',monospace;font-size:13px;color:var(--clay-600)}
.exception{color:var(--umber-700);font-size:11px;font-family:'DM Mono',monospace;border:1px solid var(--sand-500);border-radius:10px;padding:1px 7px;margin-left:8px}
input,button{font-family:inherit;font-size:14px}
input[type=date],input[type=time],input[type=text],input[type=password]{background:var(--cream-100);border:1px solid var(--sand-500);color:var(--text);padding:9px 11px;border-radius:9px;outline:none}
input:focus{border-color:var(--moss-500);box-shadow:0 0 0 3px rgba(107,122,68,.15)}
input[type=text]{width:100%}
button{cursor:pointer;border-radius:9px;padding:9px 16px;font-weight:500;border:1px solid var(--sand-500);background:var(--cream-100);color:var(--text);transition:.12s}
button:hover{border-color:var(--umber-700)}
button:disabled{opacity:.45;cursor:default}
button.primary{background:var(--clay-500);color:var(--cream-100);border-color:var(--clay-500);font-weight:600}
button.primary:hover:not(:disabled){background:var(--clay-600);border-color:var(--clay-600)}
button.icon{padding:6px 11px;font-size:12px;font-family:'DM Mono',monospace;color:var(--text-dim);background:none;border-color:transparent}
button.icon:hover{color:var(--text);border-color:var(--sand-500)}
button.danger{color:var(--clay-600);border-color:rgba(182,91,58,.35)}
button.danger.armed{background:var(--clay-600);color:var(--cream-100);border-color:var(--clay-600)}
.addrow{display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap}
.field{display:flex;flex-direction:column;gap:6px}
.field label{font-size:11px;font-family:'DM Mono',monospace;color:var(--text-dim)}
.field.grow{flex:1;min-width:180px}
.msg{margin-top:12px;font-size:13px;padding:9px 13px;border-radius:9px;display:none}
.msg.ok{display:block;background:var(--moss-100);border:1px solid rgba(107,122,68,.3);color:var(--moss-600)}
.msg.err{display:block;background:var(--clay-100);border:1px solid rgba(182,91,58,.3);color:var(--clay-600)}
.foot{margin-top:22px;font-size:12px;color:var(--text-dim);line-height:1.7}
.foot code{font-family:'DM Mono',monospace;color:var(--umber-700)}
.toggle{background:none;border:none;color:var(--text-dim);font-size:12px;font-family:'DM Mono',monospace;padding:8px 0}
.toggle:hover{color:var(--clay-600)}
.empty{color:var(--text-dim);font-size:13px;padding:18px 10px;text-align:center}
.team-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.team-title{font-size:13px;font-weight:500}
.chips{display:flex;flex-wrap:wrap;gap:8px;align-items:center;background:var(--cream-100);border:1px solid var(--sand-500);border-radius:9px;padding:9px;min-height:46px;cursor:text}
.chips:focus-within{border-color:var(--moss-500);box-shadow:0 0 0 3px rgba(107,122,68,.15)}
.chip{display:inline-flex;align-items:center;gap:6px;background:var(--gold-100);border:1px solid rgba(201,154,62,.4);color:var(--umber-700);border-radius:20px;padding:3px 5px 3px 11px;font-size:13px;font-family:'DM Mono',monospace}
.chip button{background:none;border:none;color:var(--umber-600);padding:0 5px;font-size:15px;line-height:1;border-radius:20px}
.chip button:hover{color:var(--clay-600);border:none}
.chips input{flex:1;min-width:190px;background:none;border:none;outline:none;color:var(--text);font-size:13px;padding:4px 2px;box-shadow:none}
.chips input:focus{box-shadow:none}
.team-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:12px;flex-wrap:wrap}
/* ---- calendar ---- */
.viewbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px}
.views{display:inline-flex;background:var(--surface2);border:1px solid var(--border);border-radius:10px;padding:3px;gap:2px}
.views button{background:none;border:none;padding:6px 14px;border-radius:8px;font-size:12px;font-family:'DM Mono',monospace;color:var(--text-dim)}
.views button.on{background:var(--cream-100);color:var(--ink-800);border:1px solid var(--sand-500)}
.calnav{display:flex;align-items:center;gap:8px}
.calnav .label{font-size:14px;font-weight:600;min-width:170px;text-align:center}
.calgrid{display:grid;grid-template-columns:repeat(7,1fr);gap:1px;background:var(--border);border:1px solid var(--border);border-radius:12px;overflow:hidden}
.calhead{background:var(--surface2);padding:8px 6px;text-align:center;font-size:11px;font-family:'DM Mono',monospace;color:var(--text-dim);text-transform:uppercase;letter-spacing:.06em}
.calcell{background:var(--surface);min-height:104px;padding:6px 6px 8px;display:flex;flex-direction:column;gap:4px}
.calcell.dim{background:var(--cream-300);opacity:.55}
.calcell.today{background:var(--gold-100)}
.caldate{font-size:12px;font-family:'DM Mono',monospace;color:var(--text-dim)}
.calcell.today .caldate{color:var(--clay-600);font-weight:600}
.calev{text-align:left;width:100%;border:1px solid rgba(107,122,68,.35);background:var(--moss-100);color:var(--moss-600);border-radius:7px;padding:4px 7px;font-size:11px;font-family:'DM Mono',monospace;line-height:1.35;cursor:pointer}
.calev:hover{border-color:var(--moss-500)}
.calev.noroom{background:var(--clay-100);border-color:rgba(182,91,58,.35);color:var(--clay-600)}
.calev.off{background:var(--cream-300);border-color:var(--sand-500);color:var(--text-dim);text-decoration:line-through}
.calev b{font-weight:600}
.calweek .calcell{min-height:220px}
@media(max-width:720px){.calcell{min-height:78px}.calweek .calcell{min-height:120px}}
`;

/** Server-side attribute escaping — the name is echoed back into the form. */
function escapeAttr(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function loginPage({ error = "", configured = true, name = "" } = {}) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SOF Schedule — Sign in</title><style>${STYLE}
.login{max-width:360px;margin:14vh auto 0}
.login .card{padding:26px}
.login h1{margin-bottom:6px}
.login form{display:flex;flex-direction:column;gap:14px;margin-top:20px}
</style></head><body>
<div class="wrap login">
  <div class="card">
    <h1>Workshop Schedule</h1>
    <div class="sub">Saints of Flow — team access</div>
    ${configured ? `
    <form method="POST" action="/schedule/login">
      <input type="text" name="name" placeholder="Your first name" autofocus autocomplete="given-name" maxlength="40" value="${escapeAttr(name)}"/>
      <input type="password" name="password" placeholder="Team password" autocomplete="current-password"/>
      <button class="primary" type="submit">Sign in</button>
      <div style="font-size:11px;color:var(--text-dim);font-family:'DM Mono',monospace;line-height:1.6">
        Your name is stamped on any date you change, so the team can see who moved what.
      </div>
    </form>` : `
    <div class="msg err" style="display:block;margin-top:18px">
      <code>SCHEDULE_PASSWORD</code> is not set on this Railway service. Add it in
      Railway → sof-bot → Variables, then redeploy.
    </div>`}
    ${error ? `<div class="msg err" style="display:block">${error}</div>` : ""}
  </div>
</div></body></html>`;
}

export function adminPage({ name = "" } = {}) {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>SOF Workshop Schedule</title><style>${STYLE}</style></head><body>
<div class="wrap">

  <div class="header">
    <div class="header-left">
      <div class="avatar">SF</div>
      <div>
        <h1>Workshop Schedule</h1>
        <div class="sub">The bot reads this. Edits go live within a minute.</div>
      </div>
    </div>
    <div style="display:flex;align-items:center;gap:10px">
      <span class="badge" id="source">loading…</span>
      <form method="POST" action="/schedule/logout" style="display:inline">
        <button class="icon" type="submit">${escapeAttr(name) || "signed in"} · sign out</button>
      </form>
    </div>
  </div>

  <section>
    <h2>What the bot is saying right now</h2>
    <div class="card live">
      <div><div class="k">NEXT WORKSHOP</div><div class="v" id="live-next">…</div></div>
      <div><div class="k">MAKE-UP DATE</div><div class="v" id="live-makeup">…</div></div>
    </div>
  </section>

  <section>
    <h2>Add a workshop</h2>
    <div class="card">
      <div class="addrow">
        <div class="field"><label for="d">DATE</label><input type="date" id="d"/></div>
        <div class="field"><label for="t">TIME (PACIFIC)</label><input type="time" id="t" value="09:00"/></div>
        <div class="field grow"><label for="n">NOTE (OPTIONAL)</label><input type="text" id="n" placeholder="e.g. moved from Saturday"/></div>
        <button class="primary" onclick="addRow()">Add</button>
      </div>
      <div class="msg" id="msg"></div>
    </div>
  </section>

  <section>
    <div class="viewbar">
      <h2 style="margin:0">Schedule</h2>
      <div class="views">
        <button id="v-list" class="on" onclick="setView('list')">List</button>
        <button id="v-month" onclick="setView('month')">Month</button>
        <button id="v-week" onclick="setView('week')">Week</button>
      </div>
    </div>
    <div id="cal-wrap" style="display:none">
      <div class="card" style="padding:14px 16px 16px">
        <div class="viewbar" style="margin-bottom:14px">
          <div class="calnav">
            <button class="icon" onclick="calStep(-1)">&lsaquo;</button>
            <span class="label" id="cal-label">—</span>
            <button class="icon" onclick="calStep(1)">&rsaquo;</button>
          </div>
          <button class="icon" onclick="calToday()">Today</button>
        </div>
        <div id="cal-grid"></div>
        <div class="note" style="margin-top:10px;font-size:12px">
          Click any workshop to edit it. Dates and times are Pacific, matching the schedule.
        </div>
      </div>
    </div>
    <div id="list-wrap">
    <div class="card">
      <table><thead><tr>
        <th style="width:24%">Date</th><th style="width:10%">Time</th><th style="width:52px">#</th><th style="width:88px">Zoom</th><th>Note</th>
        <th style="width:15%">Last edited</th><th style="width:150px"></th>
      </tr></thead><tbody id="upcoming"></tbody></table>
      <div class="empty" id="upcoming-empty" style="display:none">
        No upcoming workshops. The bot will fall back to “next Saturday at 9am PT”.
      </div>
    </div>
    <div class="card" id="team-card" style="margin-top:14px">
      <div class="team-head">
        <div>
          <div class="team-title">Team calendar invites</div>
          <div class="note" id="team-hint">Everyone here gets a calendar invite for each workshop, and an update whenever one moves.</div>
        </div>
        <span class="badge" id="team-count">—</span>
      </div>
      <div class="chips" id="team-chips" onclick="focusTeamInput(event)"></div>
      <div class="team-foot">
        <div class="note" id="team-dirty" style="font-size:12px"></div>
        <button class="primary" id="team-save" onclick="saveTeam()" disabled>Save changes</button>
      </div>
    </div>

    <div id="feed-row" style="display:none;align-items:center;gap:10px;margin:14px 0 4px">
      <span class="note" style="white-space:nowrap">Subscribe in Google Calendar →</span>
      <input type="text" id="feed-url" readonly onclick="this.select()" style="flex:1;font-size:12px"/>
      <button class="icon" onclick="copyFeed()">copy</button>
    </div>
    </div>
    <button class="toggle" onclick="togglePast()" id="past-toggle">▸ show past dates</button>
    <div class="card" id="past-card" style="display:none">
      <table><thead><tr>
        <th style="width:24%">Date</th><th style="width:10%">Time</th><th style="width:52px">#</th><th style="width:88px">Zoom</th><th>Note</th>
        <th style="width:15%">Last edited</th><th style="width:150px"></th>
      </tr></thead><tbody id="past"></tbody></table>
    </div>
  </section>

  <div class="foot">
    Times are Pacific wall-clock — enter <code>9:00 AM</code> and it stays 9am PT through
    daylight saving. You never enter a UTC offset.<br/>
    The bot re-reads this at most 60 seconds after a change.
  </div>
</div>

<script>
let rows = [];
let cutoverMinutes = 30;
let armed = null;   // id of the delete button waiting for a second click

function flash(text, ok) {
  const el = document.getElementById("msg");
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "err");
  setTimeout(() => { el.className = "msg"; }, 4000);
}

function prettyDate(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}
function prettyTime(t) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return h12 + ":" + String(m).padStart(2, "0") + " " + ampm;
}
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function ago(iso) {
  const secs = (Date.now() - new Date(iso).getTime()) / 1000;
  if (secs < 90) return "just now";
  const mins = secs / 60;
  if (mins < 60) return Math.round(mins) + "m ago";
  const hrs = mins / 60;
  if (hrs < 24) return Math.round(hrs) + "h ago";
  const days = hrs / 24;
  if (days < 30) return Math.round(days) + "d ago";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// "Ashley · 2d ago". Seeded rows have no editor, so they just read "imported".
function editedBy(r) {
  if (!r.updated_at) return "—";
  const who = (r.updated_by || "").trim();
  if (who === "seed import") return "imported";
  return (who || "unknown") + " · " + ago(r.updated_at);
}

var calView = "list";
var calAnchor = new Date();

function setView(v) {
  calView = v;
  ["list", "month", "week"].forEach(function (name) {
    document.getElementById("v-" + name).className = name === v ? "on" : "";
  });
  document.getElementById("cal-wrap").style.display = v === "list" ? "none" : "";
  document.getElementById("list-wrap").style.display = v === "list" ? "" : "none";
  document.getElementById("past-toggle").style.display = v === "list" ? "" : "none";
  if (v !== "list") renderCal();
}

function calStep(dir) {
  if (calView === "week") calAnchor.setDate(calAnchor.getDate() + 7 * dir);
  else calAnchor.setMonth(calAnchor.getMonth() + dir);
  renderCal();
}

function calToday() { calAnchor = new Date(); renderCal(); }

function pad2(n) { return String(n).padStart(2, "0"); }

/** Local calendar key. Built from the parts, never from toISOString — the
 *  schedule stores Pacific wall-clock and a browser in another timezone would
 *  shift every workshop by a day. */
function dayKey(d) { return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); }

function prettyClock(hhmm) {
  var parts = hhmm.split(":");
  var h = parseInt(parts[0], 10);
  var m = parts[1];
  var ap = h >= 12 ? "pm" : "am";
  var h12 = h % 12 === 0 ? 12 : h % 12;
  return m === "00" ? h12 + ap : h12 + ":" + m + ap;
}

function renderCal() {
  var grid = document.getElementById("cal-grid");
  var label = document.getElementById("cal-label");
  var days = [];
  var todayKey = dayKey(new Date());

  if (calView === "week") {
    var start = new Date(calAnchor);
    start.setDate(start.getDate() - start.getDay());
    for (var i = 0; i < 7; i++) { var d = new Date(start); d.setDate(start.getDate() + i); days.push({ d: d, dim: false }); }
    var endW = days[6].d;
    label.textContent = start.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + " – " +
      endW.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } else {
    var first = new Date(calAnchor.getFullYear(), calAnchor.getMonth(), 1);
    var gridStart = new Date(first);
    gridStart.setDate(1 - first.getDay());
    for (var j = 0; j < 42; j++) {
      var dd = new Date(gridStart);
      dd.setDate(gridStart.getDate() + j);
      days.push({ d: dd, dim: dd.getMonth() !== calAnchor.getMonth() });
    }
    while (days.length > 35 && days.slice(35).every(function (x) { return x.dim; })) days.length = 35;
    label.textContent = calAnchor.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  }

  var byDay = {};
  rows.forEach(function (r) { (byDay[r.local_date] = byDay[r.local_date] || []).push(r); });

  var html = "";
  ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].forEach(function (n) {
    html += '<div class="calhead">' + n + "</div>";
  });
  days.forEach(function (cell) {
    var key = dayKey(cell.d);
    var cls = "calcell" + (cell.dim ? " dim" : "") + (key === todayKey ? " today" : "");
    html += '<div class="' + cls + '"><div class="caldate">' + cell.d.getDate() + "</div>";
    (byDay[key] || []).sort(function (a, b) { return a.local_time < b.local_time ? -1 : 1; }).forEach(function (r) {
      var evCls = "calev" + (r.active === false ? " off" : r.zoom_link ? "" : " noroom");
      var title = r.zoom_link ? "Zoom room ready" : "No Zoom room yet";
      html += '<button class="' + evCls + '" title="' + esc(title) + '" onclick="openFromCal(' + r.id + ')">' +
        "<b>" + prettyClock(r.local_time) + "</b>" + (r.edition ? " · v" + r.edition : "") + "</button>";
    });
    html += "</div>";
  });

  grid.className = "calgrid" + (calView === "week" ? " calweek" : "");
  grid.innerHTML = html;
}

/** Editing lives in the list, so jump there rather than duplicating the form. */
function openFromCal(id) {
  setView("list");
  var tr = document.querySelector('tr[data-id="' + id + '"]');
  if (!tr) { togglePast(); tr = document.querySelector('tr[data-id="' + id + '"]'); }
  if (tr) { tr.scrollIntoView({ behavior: "smooth", block: "center" }); editRow(id); }
}

function render() {
  const now = Date.now();
  // Same cutover the bot and the GHL values use, sent by the server so this
  // can't drift. A workshop drops to Past 30 minutes after it starts, rather
  // than lingering at the top of Upcoming for a full day.
  const cutoff = now - (cutoverMinutes * 60 * 1000);
  const up = rows.filter(r => new Date(r.starts_at).getTime() > cutoff);
  const past = rows.filter(r => new Date(r.starts_at).getTime() <= cutoff).reverse();

  document.getElementById("upcoming").innerHTML = up.map(row => tpl(row, false)).join("");
  document.getElementById("past").innerHTML = past.map(row => tpl(row, true)).join("");
  document.getElementById("upcoming-empty").style.display = up.length ? "none" : "block";
  if (calView !== "list") renderCal();
}

// The Zoom room is created by hand, and nothing publishes to GHL until it
// exists — so a missing one is shown as a warning, not a blank cell.
function zoomCell(r, isPast) {
  if (r.zoom_link) return \`<a href="\${esc(r.zoom_link)}" target="_blank" rel="noopener" style="color:var(--gold);text-decoration:none">room ↗</a>\`;
  if (isPast) return '<span class="note">—</span>';
  return '<span class="exception" style="color:var(--red);border-color:rgba(224,85,85,.3)">no room</span>';
}

function tpl(r, isPast) {
  // active=false rows exist in the table but are invisible to the bot. Nothing
  // in this UI sets that flag, but say so plainly if something else ever does.
  const hidden = r.active === false;
  return \`<tr class="\${isPast || hidden ? "past" : ""}" data-id="\${r.id}">
    <td class="day">\${esc(prettyDate(r.local_date))}\${hidden ? '<span class="exception" style="color:var(--red);border-color:rgba(224,85,85,.3)">bot ignores this</span>' : ""}</td>
    <td class="time">\${esc(prettyTime(r.local_time))}</td>
    <td class="time" title="\${r.edition ? "tag: the-big-three-webinar-v" + r.edition : "no edition number — tag will not update"}">\${r.edition ? "v" + r.edition : '<span style="color:var(--red)">—</span>'}</td>
    <td>\${zoomCell(r, isPast)}</td>
    <td class="note">\${esc(r.note) || "—"}</td>
    <td class="note">\${esc(editedBy(r))}</td>
    <td style="text-align:right;white-space:nowrap">
      <button class="icon" onclick="editRow(\${r.id})">edit</button>
      <button class="icon danger" id="del-\${r.id}" onclick="delRow(\${r.id})">delete</button>
    </td></tr>\`;
}

function copyFeed() {
  const el = document.getElementById("feed-url");
  el.select();
  navigator.clipboard.writeText(el.value).then(() => flash("Calendar URL copied. In Google Calendar: Other calendars → From URL.", true));
}

var teamEmails = [];
var teamSaved = [];

function teamDirty() { return teamEmails.join(",") !== teamSaved.join(","); }

function validEmail(e) { return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(e); }

function focusTeamInput(ev) {
  if (ev && ev.target && ev.target.tagName === "BUTTON") return;
  var i = document.getElementById("team-input");
  if (i) i.focus();
}

function renderTeam(keepFocus) {
  var box = document.getElementById("team-chips");
  var html = "";
  for (var i = 0; i < teamEmails.length; i++) {
    html += '<span class="chip">' + esc(teamEmails[i]) +
            '<button type="button" title="Remove" onclick="removeTeamEmail(' + i + ')">&times;</button></span>';
  }
  html += '<input type="text" id="team-input" autocomplete="off" spellcheck="false" placeholder="' +
          (teamEmails.length ? "add another…" : "name@saintsofflow.com") + '"/>';
  box.innerHTML = html;

  var input = document.getElementById("team-input");
  input.onkeydown = teamKey;
  input.onblur = function () { commitTeamInput(true); };
  if (keepFocus) input.focus();

  var n = teamEmails.length;
  document.getElementById("team-count").textContent = n + (n === 1 ? " recipient" : " recipients");

  var dirty = teamDirty();
  document.getElementById("team-save").disabled = !dirty;
  document.getElementById("team-dirty").textContent = dirty
    ? "Unsaved. Saving re-sends invites so everyone has the current schedule."
    : (n ? "" : "No one is being invited.");
}

function teamKey(ev) {
  if (ev.key === "Enter" || ev.key === "," || ev.key === " " || ev.key === "Tab") {
    if (ev.key !== "Tab" || ev.target.value.trim()) ev.preventDefault();
    commitTeamInput(false);
  } else if (ev.key === "Backspace" && !ev.target.value && teamEmails.length) {
    // Backspace on an empty box removes the last chip, as tag inputs do.
    teamEmails.pop();
    renderTeam(true);
  }
}

/** quiet=true when triggered by blur, so tabbing away doesn't scold you. */
function commitTeamInput(quiet) {
  var input = document.getElementById("team-input");
  if (!input) return;
  var raw = input.value.trim();
  if (!raw) return;
  var parts = raw.split(/[,;\\s]+/).filter(Boolean);
  var bad = [];
  var addedAny = false;
  for (var i = 0; i < parts.length; i++) {
    var e = parts[i].toLowerCase();
    if (!validEmail(e)) { bad.push(parts[i]); continue; }
    if (teamEmails.indexOf(e) === -1) { teamEmails.push(e); addedAny = true; }
  }
  input.value = bad.join(" ");
  if (bad.length && !quiet) flash("Not an email address: " + bad.join(", "), false);
  if (addedAny || bad.length === 0) renderTeam(true);
}

function removeTeamEmail(i) {
  teamEmails.splice(i, 1);
  renderTeam(true);
}

async function loadTeam() {
  try {
    const r = await fetch("/api/team-emails");
    if (!r.ok) return;
    const d = await r.json();
    teamEmails = (d.emails || []).slice();
    teamSaved = teamEmails.slice();
    renderTeam(false);
    if (!d.mailReady) {
      document.getElementById("team-hint").innerHTML =
        '<span style="color:var(--red)">Gmail credentials are not set on this service, so invites cannot send yet.</span>';
      document.getElementById("team-save").disabled = true;
    }
  } catch (e) { /* the schedule still works without this */ }
}

async function saveTeam() {
  commitTeamInput(true);
  const btn = document.getElementById("team-save");
  btn.disabled = true;
  try {
    const res = await fetch("/api/team-emails", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ emails: teamEmails.join(", ") }),
    });
    const body = await res.json();
    if (!res.ok) { flash(body.error || "Could not save.", false); return; }
    teamEmails = (body.emails || []).slice();
    teamSaved = teamEmails.slice();
    renderTeam(false);
    flash(teamEmails.length
      ? "Saved. Sending invites to " + teamEmails.length + (teamEmails.length === 1 ? " person." : " people.")
      : "Cleared — no invites will be sent.", true);
  } finally {
    renderTeam(false);
  }
}

async function load() {
  const res = await fetch("/api/schedule");
  if (res.status === 401) { location.reload(); return; }
  const data = await res.json();
  rows = data.workshops || [];
  if (Number.isFinite(data.cutoverMinutes)) cutoverMinutes = data.cutoverMinutes;
  if (data.feedUrl) {
    const el = document.getElementById("feed-url");
    el.value = data.feedUrl;
    document.getElementById("feed-row").style.display = "flex";
  }
  const badge = document.getElementById("source");
  badge.textContent = data.meta.source === "database" ? "live · database" : data.meta.source;
  badge.className = "badge" + (data.meta.source === "database" ? "" : " warn");
  render();
  loadLive();
  loadTeam();
}

async function loadLive() {
  try {
    const r = await fetch("/workshop-info");
    const d = await r.json();
    document.getElementById("live-next").textContent = (d.workshopDateLabel || "—") + (d.workshopTimePT ? " · " + d.workshopTimePT + " PT" : "");
    document.getElementById("live-makeup").textContent = (d.makeupDateLabel || "—") + (d.makeupTimePT ? " · " + d.makeupTimePT + " PT" : "");
  } catch (e) {
    document.getElementById("live-next").textContent = "unavailable";
  }
}

async function addRow() {
  const local_date = document.getElementById("d").value;
  const local_time = document.getElementById("t").value || "09:00";
  const note = document.getElementById("n").value;
  if (!local_date) return flash("Pick a date first.", false);

  const res = await fetch("/api/schedule", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ local_date, local_time, note }),
  });
  const body = await res.json();
  if (!res.ok) return flash(body.error || "Could not add that date.", false);

  document.getElementById("d").value = "";
  document.getElementById("n").value = "";
  flash("Added " + prettyDate(local_date) + " at " + prettyTime(local_time) + ".", true);
  load();
}

function editRow(id) {
  const r = rows.find(x => x.id === id);
  if (!r) return;
  const tr = document.querySelector('tr[data-id="' + id + '"]');
  tr.innerHTML = \`
    <td><input type="date" value="\${r.local_date}" id="e-d-\${id}"/></td>
    <td><input type="time" value="\${r.local_time}" id="e-t-\${id}"/></td>
    <td><input type="text" value="\${r.edition ?? ""}" id="e-e-\${id}" placeholder="#" style="padding-left:7px;padding-right:2px"/></td>
    <td colspan="2"><input type="text" value="\${esc(r.zoom_link || "")}" id="e-z-\${id}" placeholder="Zoom link — publishes to the site when saved"/>
      <input type="text" value="\${esc(r.note)}" id="e-n-\${id}" placeholder="note" style="margin-top:6px"/></td>
    <td class="note">\${esc(editedBy(r))}</td>
    <td style="text-align:right;white-space:nowrap">
      <button class="icon" onclick="saveRow(\${id})" style="color:var(--gold)">save</button>
      <button class="icon" onclick="render()">cancel</button>
    </td>\`;
}

async function saveRow(id) {
  const payload = {
    local_date: document.getElementById("e-d-" + id).value,
    local_time: document.getElementById("e-t-" + id).value,
    note: document.getElementById("e-n-" + id).value,
    zoom_link: document.getElementById("e-z-" + id).value,
    edition: document.getElementById("e-e-" + id).value.trim(),
  };
  const res = await fetch("/api/schedule/" + id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  if (!res.ok) return flash(body.error || "Could not save.", false);
  flash("Saved.", true);
  load();
}

// Two-click delete — no modal, so nothing can block the page.
async function delRow(id) {
  const btn = document.getElementById("del-" + id);
  if (armed !== id) {
    if (armed !== null) {
      const prev = document.getElementById("del-" + armed);
      if (prev) { prev.textContent = "delete"; prev.classList.remove("armed"); }
    }
    armed = id;
    btn.textContent = "click to confirm";
    btn.classList.add("armed");
    setTimeout(() => {
      if (armed === id) { armed = null; btn.textContent = "delete"; btn.classList.remove("armed"); }
    }, 4000);
    return;
  }
  armed = null;
  const res = await fetch("/api/schedule/" + id, { method: "DELETE" });
  if (!res.ok) { const b = await res.json(); return flash(b.error || "Could not delete.", false); }
  flash("Removed.", true);
  load();
}

function togglePast() {
  const card = document.getElementById("past-card");
  const btn = document.getElementById("past-toggle");
  const open = card.style.display !== "none";
  card.style.display = open ? "none" : "block";
  btn.textContent = (open ? "▸ show" : "▾ hide") + " past dates";
}

load();
setInterval(load, 60000);
</script>
</body></html>`;
}
