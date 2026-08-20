/**
 * Renders the admin page and checks the JavaScript that actually reaches the
 * browser. Run with: node tests/render-check.mjs
 *
 * Exists because schedule-page.js emits client code from inside a server-side
 * template literal, which silently consumes single backslashes. A regex
 * written as /[,;\s]+/ arrives as /[,;s]+/ — still valid JavaScript, still
 * passes `node --check`, and splits email addresses on the letter "s".
 * jason@saintsofflow.com became "ja on@ aint offlow.com" in production.
 *
 * Nothing else in this repo looks at the rendered output, so nothing else can
 * catch that class of bug.
 */
import { adminPage, loginPage } from "../schedule-page.js";
import { writeFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  ok  " : "  FAIL"}  ${label}${ok || !detail ? "" : "\n        " + detail}`);
  if (!ok) failures++;
};

const html = adminPage({ name: "Test" });
const js = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";

check("admin page renders an inline script", js.length > 500);

// The escapes that were lost. Written with String.raw so this file can't
// suffer the same problem it is testing for.
check("email split keeps its \\s", js.includes(String.raw`[,;\s]+`),
  "found: " + (js.match(/split\(\/\[[^)]*\)/)?.[0] ?? "no split pattern"));
check("email validator keeps its \\s and \\.", js.includes(String.raw`[^@\s]+@[^@\s]+\.[^@\s]+`),
  "found: " + (js.match(/\/\^\[\^@[^\n]*?\$\//)?.[0] ?? "no validator"));

// The behaviour those escapes exist for.
const splitPattern = js.match(/split\(\/(\[[^\/]*\])\+\//)?.[1];
if (splitPattern) {
  const parts = "jason@saintsofflow.com".split(new RegExp(splitPattern + "+"));
  check("a real address survives the split", parts.length === 1 && parts[0] === "jason@saintsofflow.com",
    JSON.stringify(parts));
}

// The rendered script must itself be valid JavaScript.
// fileURLToPath, not .pathname — this repo lives under a path with spaces,
// which .pathname percent-encodes into a filename that does not exist.
const tmp = fileURLToPath(new URL("./.rendered-client.tmp.js", import.meta.url));
try {
  writeFileSync(tmp, js);
  execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  check("rendered client JS parses", true);
} catch (err) {
  check("rendered client JS parses", false, String(err.stderr || err).slice(0, 300));
} finally {
  try { unlinkSync(tmp); } catch {}
}

check("login page renders", loginPage({}).includes("<form"));

console.log(failures ? `\n${failures} check(s) failed` : "\nall render checks passed");
process.exit(failures ? 1 : 0);
