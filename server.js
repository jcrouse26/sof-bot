import express from "express";
import Anthropic from "@anthropic-ai/sdk";

const app = express();
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_ALERT_CHANNEL = "C0B5E3MBXST";

let conversation = [];

const SYSTEM_PROMPT = `You are a helpful assistant for Saints of Flow, Jason Crouse's coaching brand. You are texting with someone who has already registered for the Big Three Mastery Workshop. Your job is to answer their questions in a warm, conversational, human way — like a real person on the team, not a bot.

ABOUT THE WORKSHOP:
- Name: The Big Three Mastery Workshop
- Host: Jason Crouse
- Date: Saturday, May 30th
- Time: 9:00am Pacific (PST)
- Cost: Free
- Length: About 75-90 minutes (includes Q&A)
- Platform: Zoom
- How to join: They will receive a Zoom link via email. It will also be texted to them the morning of the event.
- What it covers: How to master the Big Three — Career, Love, and Confidence. Specifically: turning purpose into a career that fits you, attracting love that actually feels right, and building real confidence by keeping promises to yourself.

REPLAY POLICY:
- There is a replay, but attending live is strongly recommended because it is an interactive workshop — not just a presentation.
- If someone cannot make it live, gently encourage them to attend the next one, which runs the following Saturday at 9:00am Pacific.
- Ask them what their situation is — are they definitely unable to make it, or just unsure? Help them find a way to be there live if at all possible.

TONE AND BEHAVIOR:
- Warm, real, conversational — like a helpful human on Jason's team
- Keep responses short — 1-3 sentences unless more is genuinely needed
- Never sound like a bot or use corporate language
- Do not sell or pitch anything — this is purely logistics and info support

COMMON QUESTIONS AND HOW TO HANDLE THEM:
- "What time does it start?" — 9:00am Pacific on this coming Saturday
- "Where do I join?" — Check their email for the Zoom link. It will also be texted to them day of.
- "Will there be a replay?" — Yes, but we really recommend being there live since it is a workshop. If they cannot make it, point them to the following Saturday.
- "How long is it?" — Plan for about 75-90 minutes
- "Is it free?" — Yes, completely free
- "Can I bring a friend?" — They would need to register at webinar.saintsofflow.com/
- "I did not get my confirmation email" — Let them know to check spam, and that they will get a reminder plus Zoom link closer to the date. Jason's team can also resend it. Confirm with them what their email address is.
- "What should I have ready?" — Just show up, have a pen and paper handy if they want to take notes, and be somewhere they can focus for 90 minutes
- Link for the next workshop can be found at webinar.saintsofflow.com

IN SCOPE — questions you should answer:
- Anything about the workshop date, time, length, platform, how to join
- Replay questions
- Confirmation email / Zoom link questions
- What the workshop covers
- Whether a friend can join
- What to have ready

OUT OF SCOPE — questions you should NOT answer:
- Anything about The Flow Code, TFC, or coaching programs
- Pricing or cost of anything beyond the free workshop
- Personal advice or coaching questions
- Anything you are genuinely unsure about

CRITICAL RULE: If a message is out of scope or you are unsure how to answer it, respond with exactly this single word and nothing else: OUTOFSCOPE

Remember: everyone texting has already registered. They are warm. Be helpful, be human, be brief.`;

const TRIAGE_PROMPT = `You are a triage assistant. Your only job is to decide if a message is in scope for a workshop logistics bot.

IN SCOPE: questions about workshop date, time, length, platform, Zoom link, replay, confirmation email, what the workshop covers, bringing a friend, what to prepare.

OUT OF SCOPE: anything about coaching programs, pricing, personal advice, or anything unrelated to basic workshop logistics.

Reply with exactly one word: INSCOPE or OUTOFSCOPE`;

async function isInScope(message) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 10,
    system: TRIAGE_PROMPT,
    messages: [{ role: "user", content: message }],
  });
  const result = response.content[0].text.trim();
  return result === "INSCOPE";
}

async function sendSlackAlert(contactInfo, message) {
  const alertText = `🚨 *Bot handoff needed*\n*Contact:* ${contactInfo}\n*Their message:* "${message}"\n\nThis was outside the bot's scope — please follow up manually.`;

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SLACK_TOKEN}`,
    },
    body: JSON.stringify({
      channel: SLACK_ALERT_CHANNEL,
      text: alertText,
    }),
  });
}

app.post("/chat", async (req, res) => {
  const { message, contactId, contactName, contactPhone } = req.body;
  if (!message) return res.status(400).json({ error: "No message" });

  const inScope = await isInScope(message);

  if (!inScope) {
    const contactInfo = contactName || contactPhone || contactId || "Unknown contact";
    await sendSlackAlert(contactInfo, message);
    return res.json({ reply: null, outOfScope: true });
  }

  conversation.push({ role: "user", content: message });
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 1000,
    system: SYSTEM_PROMPT,
    messages: conversation.slice(-20),
  });
  const reply = response.content[0].text;

  // Safety net: if the main bot still returns OUTOFSCOPE, treat it the same way
  if (reply.trim() === "OUTOFSCOPE") {
    const contactInfo = contactName || contactPhone || contactId || "Unknown contact";
    await sendSlackAlert(contactInfo, message);
    return res.json({ reply: null, outOfScope: true });
  }

  conversation.push({ role: "assistant", content: reply });
  res.json({ reply, outOfScope: false });
});

app.post("/reset", (req, res) => {
  conversation = [];
  res.json({ ok: true });
});

app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>SOF Bot Tester</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&family=DM+Mono&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f0e0c;--surface:#1a1916;--border:#2a2825;--gold:#c9a84c;--gold-dim:#7a6330;--text:#e8e4dc;--text-dim:#7a7670;--red:#e05555;--radius:16px}
body{font-family:'DM Sans',sans-serif;background:var(--bg);color:var(--text);height:100vh;display:flex;flex-direction:column;align-items:center}
.container{width:100%;max-width:680px;height:100vh;display:flex;flex-direction:column}
.header{padding:24px 28px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;flex-shrink:0}
.header-left{display:flex;align-items:center;gap:12px}
.avatar{width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--gold),#8a6020);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:600;color:#0f0e0c}
.header-title{font-size:15px;font-weight:600}
.header-sub{font-size:12px;color:var(--text-dim);margin-top:1px}
.badge{font-size:11px;font-family:'DM Mono',monospace;color:var(--gold);background:rgba(201,168,76,0.1);border:1px solid rgba(201,168,76,0.2);padding:3px 10px;border-radius:20px}
.messages{flex:1;overflow-y:auto;padding:24px 28px;display:flex;flex-direction:column;gap:16px}
.message{display:flex;flex-direction:column;max-width:80%}
.message.user{align-self:flex-end;align-items:flex-end}
.message.bot{align-self:flex-start;align-items:flex-start}
.message.system{align-self:center;align-items:center;max-width:100%}
.bubble{padding:12px 16px;border-radius:var(--radius);font-size:14.5px;line-height:1.55}
.message.user .bubble{background:var(--gold);color:#0f0e0c;border-bottom-right-radius:4px;font-weight:500}
.message.bot .bubble{background:var(--surface);color:var(--text);border:1px solid var(--border);border-bottom-left-radius:4px}
.message.system .bubble{background:rgba(224,85,85,0.1);color:var(--red);border:1px solid rgba(224,85,85,0.2);border-radius:8px;font-size:12px;font-family:'DM Mono',monospace;text-align:center}
.label{font-size:11px;color:var(--text-dim);margin-bottom:5px;font-family:'DM Mono',monospace}
.typing{display:flex;gap:5px;padding:14px 16px;background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);border-bottom-left-radius:4px}
.dot{width:6px;height:6px;border-radius:50%;background:var(--gold-dim);animation:pulse 1.2s ease-in-out infinite}
.dot:nth-child(2){animation-delay:0.2s}
.dot:nth-child(3){animation-delay:0.4s}
@keyframes pulse{0%,80%,100%{opacity:0.3;transform:scale(0.9)}40%{opacity:1;transform:scale(1.1)}}
.input-area{padding:16px 28px 24px;border-top:1px solid var(--border);flex-shrink:0}
.input-row{display:flex;gap:10px;align-items:flex-end}
textarea{flex:1;background:var(--surface);border:1px solid var(--border);border-radius:12px;color:var(--text);font-family:'DM Sans',sans-serif;font-size:14px;padding:12px 16px;resize:none;outline:none;min-height:46px;max-height:120px;line-height:1.5}
textarea:focus{border-color:var(--gold-dim)}
textarea::placeholder{color:var(--text-dim)}
button.send{width:46px;height:46px;border-radius:12px;background:var(--gold);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
button.send:disabled{opacity:0.3;cursor:not-allowed}
.footer{display:flex;align-items:center;justify-content:space-between;margin-top:10px}
.hint{font-size:11px;color:var(--text-dim)}
button.reset{font-size:11px;color:var(--text-dim);background:none;border:none;cursor:pointer;font-family:'DM Sans',sans-serif;padding:0}
button.reset:hover{color:var(--gold)}
.empty-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center}
.empty-icon{width:48px;height:48px;border-radius:50%;background:var(--surface);border:1px solid var(--border);display:flex;align-items:center;justify-content:center;margin-bottom:4px;font-size:20px}
.empty-title{font-size:15px;font-weight:500;color:var(--text)}
.empty-sub{font-size:13px;color:var(--text-dim);max-width:280px;line-height:1.5}
</style>
</head>
<body>
<div class="container">
<div class="header">
  <div class="header-left">
    <div class="avatar">SF</div>
    <div>
      <div class="header-title">Saints of Flow Bot</div>
      <div class="header-sub">Big Three Mastery Workshop — registrant support</div>
    </div>
  </div>
  <div class="badge">LOCAL TEST</div>
</div>
<div class="messages" id="messages">
  <div class="empty-state" id="emptyState">
    <div class="empty-icon">💬</div>
    <div class="empty-title">Ask it anything</div>
    <div class="empty-sub">In-scope questions get a reply. Out-of-scope goes silent + fires a Slack alert.</div>
  </div>
</div>
<div class="input-area">
  <div class="input-row">
    <textarea id="input" placeholder="e.g. What time does it start?" rows="1" onkeydown="handleKey(event)" oninput="autoResize(this)"></textarea>
    <button class="send" id="sendBtn" onclick="sendMessage()">
      <svg viewBox="0 0 24 24" fill="none" stroke="#0f0e0c" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
    </button>
  </div>
  <div class="footer">
    <span class="hint">Enter to send</span>
    <button class="reset" onclick="resetConversation()">Reset conversation</button>
  </div>
</div>
</div>
<script>
const messagesEl=document.getElementById("messages");
const inputEl=document.getElementById("input");
const sendBtn=document.getElementById("sendBtn");
const emptyState=document.getElementById("emptyState");
let isLoading=false;
function autoResize(el){el.style.height="auto";el.style.height=Math.min(el.scrollHeight,120)+"px"}
function handleKey(e){if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage()}}
function addMessage(role,text){
  if(emptyState)emptyState.style.display="none";
  const msg=document.createElement("div");
  msg.className="message "+role;
  const label=document.createElement("div");
  label.className="label";
  if(role==="user")label.textContent="YOU";
  else if(role==="bot")label.textContent="SOF BOT";
  else label.textContent="SYSTEM";
  const bubble=document.createElement("div");
  bubble.className="bubble";
  bubble.textContent=text;
  msg.appendChild(label);
  msg.appendChild(bubble);
  messagesEl.appendChild(msg);
  messagesEl.scrollTop=messagesEl.scrollHeight;
}
function showTyping(){
  if(emptyState)emptyState.style.display="none";
  const w=document.createElement("div");
  w.className="message bot";w.id="typing";
  const label=document.createElement("div");
  label.className="label";label.textContent="SOF BOT";
  const t=document.createElement("div");
  t.className="typing";
  t.innerHTML="<div class='dot'></div><div class='dot'></div><div class='dot'></div>";
  w.appendChild(label);w.appendChild(t);
  messagesEl.appendChild(w);
  messagesEl.scrollTop=messagesEl.scrollHeight;
}
function removeTyping(){const t=document.getElementById("typing");if(t)t.remove()}
async function sendMessage(){
  const text=inputEl.value.trim();
  if(!text||isLoading)return;
  isLoading=true;sendBtn.disabled=true;
  inputEl.value="";inputEl.style.height="auto";
  addMessage("user",text);showTyping();
  try{
    const res=await fetch("/chat",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:text,contactName:"Test User",contactPhone:"+1 (555) 000-0000"})});
    const data=await res.json();
    removeTyping();
    if(data.outOfScope){
      addMessage("system","OUT OF SCOPE — bot went silent. Slack alert fired to #ghl-alerts.");
    } else {
      addMessage("bot",data.reply);
    }
  }catch(err){
    removeTyping();addMessage("system","Something went wrong. Check your API key and server logs.");
  }
  isLoading=false;sendBtn.disabled=false;inputEl.focus();
}
async function resetConversation(){
  await fetch("/reset",{method:"POST"});
  messagesEl.innerHTML="";
  messagesEl.appendChild(emptyState);
  emptyState.style.display="flex";
}
inputEl.focus();
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("SOF Bot Tester running — open http://localhost:3000");
});
