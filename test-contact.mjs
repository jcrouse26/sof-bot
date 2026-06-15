// Test a specific GHL contact against the live bot
// Usage: node test-contact.mjs <contact_id> [message]
// Example: node test-contact.mjs Lgyu9aezDpSNTMsN7n5G "what time does it start?"

const contactId = process.argv[2];
const message = process.argv[3] || "hey, just checking in";

if (!contactId) {
  console.error("Usage: node test-contact.mjs <contact_id> [message]");
  process.exit(1);
}

// Point this at your Railway URL
const RAILWAY_URL = "https://sof-bot-production.up.railway.app/chat";

const payload = {
  customData: {
    contactId,
    contactName: "Test Contact",
    contactPhone: "+10000000000",
    message,
  },
  message: { type: 2, body: message },
};

console.log(`\nSending to Railway: ${RAILWAY_URL}`);
console.log(`Contact ID: ${contactId}`);
console.log(`Message: "${message}"\n`);

try {
  const res = await fetch(RAILWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  console.log("Response:", JSON.stringify(data, null, 2));
  if (data.reply) console.log(`\nBot reply: "${data.reply}"`);
} catch (err) {
  console.error("Error:", err.message);
}
