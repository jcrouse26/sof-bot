// Run with: node test-sheet.mjs YOUR_WEBHOOK_URL
const url = process.argv[2];
if (!url) {
  console.error("Usage: node test-sheet.mjs <webhook_url>");
  process.exit(1);
}

const payload = {
  timestamp: new Date().toISOString(),
  contactName: "Test User",
  contactPhone: "+15550001234",
  contactId: "test-contact-123",
  message: "What time does it start?",
  triage: "INSCOPE",
  reply: "hey! it starts at 9am pt this Saturday 😊",
  nextWeekSignup: false,
  confidence: 9,
};

console.log("Sending to:", url);
console.log("Payload:", JSON.stringify(payload, null, 2));

try {
  const res = await fetch(url, {
    method: "POST",
    redirect: "follow",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log("Status:", res.status);
  const text = await res.text();
  console.log("Response:", text);
  if (text === "ok") {
    console.log("\n✓ Sheet logging is working — check your Google Sheet for the test row.");
  } else {
    console.log("\n✗ Unexpected response — may not have logged correctly.");
  }
} catch (err) {
  console.error("Error:", err.message);
}
