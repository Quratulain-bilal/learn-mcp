/**
 * The three small pages of the sign-in flow that Better Auth sends the user to:
 *   /sign-in         email + password (sign in or create an account)
 *   /select-company  only if the user belongs to more than one company
 *   /consent         approve or deny the app (Claude, ChatGPT…) that wants access
 *
 * Better Auth redirects to each page with a SIGNED query string. The page sends it back,
 * unchanged, as `oauth_query`, so the server can continue the same OAuth request.
 * All dynamic text is set with textContent (never innerHTML), and the script is served
 * from /auth.js so the Content-Security-Policy can forbid inline scripts.
 */

const SECURITY_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

function page(title: string, body: string): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · learn-mcp sales</title>
<style>
  :root { color-scheme: light dark; --accent: #2f6fde; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { width: min(380px, 92vw); padding: 28px; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 12px; }
  h1 { font-size: 1.3rem; margin: 0 0 4px; }
  p.sub { margin: 0 0 20px; opacity: .75; }
  label { display: block; font-size: .9rem; margin: 12px 0 4px; }
  input { box-sizing: border-box; width: 100%; padding: 10px; border-radius: 8px; border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); font: inherit; background: Field; color: FieldText; }
  button { width: 100%; margin-top: 18px; padding: 10px; border: 0; border-radius: 8px; background: var(--accent); color: white; font: inherit; font-weight: 600; cursor: pointer; }
  button.secondary { background: transparent; color: CanvasText; border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); margin-top: 8px; }
  button:disabled { opacity: .6; cursor: wait; }
  .link { background: none; color: var(--accent); width: auto; padding: 0; margin: 16px 0 0; font-weight: 400; }
  .error { color: #d33; min-height: 1.5em; margin: 12px 0 0; }
  ul { padding-left: 20px; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main>
${body}
<p class="error" id="error" role="alert"></p>
</main>
<script src="/auth.js"></script>
</body>
</html>`;
  return new Response(html, { headers: SECURITY_HEADERS });
}

export function signInPage(): Response {
  return page(
    "Sign in",
    `<h1 id="heading">Sign in</h1>
<p class="sub">to connect your sales data</p>
<form id="sign-in-form">
  <div id="name-field" hidden>
    <label for="name">Your name</label>
    <input id="name" name="name" autocomplete="name" maxlength="80">
  </div>
  <label for="email">Email</label>
  <input id="email" name="email" type="email" autocomplete="email" required maxlength="254">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required minlength="8" maxlength="128">
  <button id="submit" type="submit">Sign in</button>
</form>
<button class="link" id="toggle" type="button">New here? Create an account</button>`,
  );
}

export function selectCompanyPage(): Response {
  return page(
    "Choose a company",
    `<h1>Choose a company</h1>
<p class="sub">Your sales connection will use this company.</p>
<div id="companies">Loading…</div>`,
  );
}

export function consentPage(): Response {
  return page(
    "Allow access",
    `<h1>Allow access?</h1>
<p class="sub"><strong id="client-name">An app</strong> wants to use your sales data.</p>
<p>It will be able to:</p>
<ul id="scopes"></ul>
<button id="allow" type="button">Allow</button>
<button id="deny" class="secondary" type="button">Deny</button>`,
  );
}

/** Plain browser JavaScript for the three pages, served at /auth.js. */
export function authScript(): Response {
  const js = String.raw`
"use strict";
// The signed query Better Auth put in this page's URL. We send it back unchanged.
const oauthQuery = location.search.slice(1);
const errorBox = document.getElementById("error");
const showError = (message) => { errorBox.textContent = message; };

async function post(path, body) {
  const res = await fetch("/api/auth" + path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(oauthQuery ? { ...body, oauth_query: oauthQuery } : body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error_description || data.error || "Something went wrong (" + res.status + ").");
  return data;
}

// Better Auth answers with { redirect: true, url } when the OAuth flow moves on.
function follow(data, fallbackMessage) {
  if (data && data.url) { location.assign(data.url); return; }
  showError(fallbackMessage);
}

const SCOPE_TEXT = {
  openid: "Know who you are",
  profile: "See your name",
  email: "See your email address",
  offline_access: "Stay connected when you're away",
  sales: "Read your company's sales data",
};

// ----- /sign-in -----
const form = document.getElementById("sign-in-form");
if (form) {
  let creating = false;
  const toggle = document.getElementById("toggle");
  toggle.addEventListener("click", () => {
    creating = !creating;
    document.getElementById("name-field").hidden = !creating;
    document.getElementById("name").required = creating;
    document.getElementById("heading").textContent = creating ? "Create an account" : "Sign in";
    document.getElementById("submit").textContent = creating ? "Create account" : "Sign in";
    document.getElementById("password").autocomplete = creating ? "new-password" : "current-password";
    toggle.textContent = creating ? "Already have an account? Sign in" : "New here? Create an account";
    showError("");
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = document.getElementById("submit");
    button.disabled = true; showError("");
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    try {
      const data = creating
        ? await post("/sign-up/email", { name: document.getElementById("name").value.trim(), email, password })
        : await post("/sign-in/email", { email, password });
      follow(data, "You're signed in. You can close this tab and go back to your app.");
    } catch (err) { showError(err.message); }
    finally { button.disabled = false; }
  });
}

// ----- /select-company -----
const companies = document.getElementById("companies");
if (companies) {
  fetch("/api/auth/organization/list", { credentials: "same-origin", headers: { accept: "application/json" } })
    .then((res) => res.ok ? res.json() : Promise.reject(new Error("Please sign in again.")))
    .then((list) => {
      companies.textContent = "";
      for (const org of list) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary";
        button.textContent = org.name;
        button.addEventListener("click", async () => {
          try {
            await post("/organization/set-active", { organizationId: org.id });
            follow(await post("/oauth2/continue", { postLogin: true }), "Company selected. Go back to your app.");
          } catch (err) { showError(err.message); }
        });
        companies.appendChild(button);
      }
    })
    .catch((err) => { companies.textContent = ""; showError(err.message); });
}

// ----- /consent -----
const allow = document.getElementById("allow");
if (allow) {
  const params = new URLSearchParams(location.search);
  const list = document.getElementById("scopes");
  for (const scope of (params.get("scope") || "").split(" ").filter(Boolean)) {
    const item = document.createElement("li");
    item.textContent = SCOPE_TEXT[scope] || scope;
    list.appendChild(item);
  }
  // The app's name is chosen by whoever registered it, so show it as plain text only.
  const clientId = params.get("client_id");
  if (clientId) {
    fetch("/api/auth/oauth2/public-client?client_id=" + encodeURIComponent(clientId), { credentials: "same-origin" })
      .then((res) => res.ok ? res.json() : null)
      .then((client) => { if (client && client.client_name) document.getElementById("client-name").textContent = client.client_name; })
      .catch(() => {});
  }
  const decide = async (accept) => {
    try { follow(await post("/oauth2/consent", { accept }), "Done. Go back to your app."); }
    catch (err) { showError(err.message); }
  };
  allow.addEventListener("click", () => decide(true));
  document.getElementById("deny").addEventListener("click", () => decide(false));
}
`;
  return new Response(js, {
    headers: { "content-type": "text/javascript; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-cache" },
  });
}
