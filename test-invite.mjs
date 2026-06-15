// Send a test calendar invite to yourself
// Usage: node test-invite.mjs
// Requires a Gmail App Password — generate one at:
// https://myaccount.google.com/apppasswords

import nodemailer from "nodemailer";

const GMAIL_USER = "jason@saintsofflow.com"; // sending from
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;  // set in terminal
const TO = "jcrouse26@gmail.com";

if (!GMAIL_APP_PASSWORD) {
  console.error("Set GMAIL_APP_PASSWORD env var first:");
  console.error('  GMAIL_APP_PASSWORD=xxxx node test-invite.mjs');
  process.exit(1);
}

// Fetch the ICS from Railway
const icsRes = await fetch(
  `https://sof-bot-production.up.railway.app/invite.ics?email=${TO}&name=Jason`
);
const icsContent = await icsRes.text();
console.log("ICS fetched, METHOD line:", icsContent.split("\n").find(l => l.startsWith("METHOD")));

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
});

await transporter.sendMail({
  from: `"Jason Crouse" <${GMAIL_USER}>`,
  to: TO,
  subject: "You're invited: The Big Three Mastery Workshop",
  text: "You're registered for The Big Three Mastery Workshop — Saturday, June 6 at 9am PT. Open the attachment to add it to your calendar.",
  attachments: [
    {
      filename: "big-three-workshop.ics",
      content: icsContent,
      contentType: "text/calendar; method=REQUEST; charset=utf-8",
    },
  ],
  alternatives: [
    {
      contentType: "text/calendar; method=REQUEST; charset=utf-8",
      content: icsContent,
    },
  ],
});

console.log(`✓ Invite sent to ${TO} — check Gmail for the calendar prompt.`);
