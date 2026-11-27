import { exports } from "cloudflare:workers";

/**
 * Drives the full OAuth 2.1 flow against the Worker the way Claude or ChatGPT would:
 * discovery, dynamic client registration, authorize with PKCE, sign-in (or sign-up),
 * optional company choice, consent, then the token exchange.
 */
const BASE = "http://localhost";
const REDIRECT = "http://localhost:9999/callback";
const PASSWORD = "correct-horse-battery-staple";

const call = (path: string, init: RequestInit = {}) => exports.default.fetch(new Request(new URL(path, BASE), init));

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface Session {
  cookies: Map<string, string>;
}

const cookieHeader = (s: Session) => [...s.cookies].map(([k, v]) => `${k}=${v}`).join("; ");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Better Auth replies are loose JSON
export async function authPost(session: Session, path: string, body: unknown): Promise<any> {
  const res = await call(`/api/auth${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", origin: BASE, cookie: cookieHeader(session) },
    body: JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0]!;
    const eq = pair.indexOf("=");
    session.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

/** Signs in with email and password (no OAuth) and returns the browser-style session. */
export async function signIn(email: string): Promise<Session> {
  const session: Session = { cookies: new Map() };
  await authPost(session, "/sign-in/email", { email, password: PASSWORD });
  return session;
}

/** Signs up a user directly (no OAuth). */
export async function signUp(email: string): Promise<void> {
  await authPost({ cookies: new Map() }, "/sign-up/email", { email, name: email.split("@")[0], password: PASSWORD });
}

/**
 * Connects as `email` (signing up first if needed) and returns an access token.
 * `chooseCompany` picks a company by name on /select-company, for users in several.
 */
export async function connect(email: string, options: { chooseCompany?: string } = {}) {
  const session: Session = { cookies: new Map() };

  const prm = await (await call("/.well-known/oauth-protected-resource/mcp")).json<{
    resource: string;
    authorization_servers: string[];
  }>();
  const issuerPath = new URL(prm.authorization_servers[0]!).pathname;
  const as = await (await call(`/.well-known/oauth-authorization-server${issuerPath}`)).json<{
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint: string;
  }>();

  const client = await (
    await call(as.registration_endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Client",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    })
  ).json<{ client_id: string }>();

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const authorize = new URL(as.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    scope: "openid profile email offline_access sales",
    state: "s",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: prm.resource,
  })) {
    authorize.searchParams.set(k, v);
  }

  const a = await call(authorize.toString(), { redirect: "manual", headers: { accept: "application/json" } });
  let next = new URL(a.headers.get("location") ?? (await a.json<{ url: string }>()).url, BASE);

  const signIn = { email, password: PASSWORD, oauth_query: next.search.slice(1) };
  const signedIn = await authPost(session, "/sign-in/email", signIn).catch(() =>
    authPost(session, "/sign-up/email", { ...signIn, name: email.split("@")[0] }),
  );
  next = new URL(signedIn.url, BASE);

  if (next.pathname === "/select-company") {
    const res = await call("/api/auth/organization/list", { headers: { cookie: cookieHeader(session) } });
    const orgs = await res.json<{ id: string; name: string }[]>();
    const org = orgs.find((o) => o.name === options.chooseCompany) ?? orgs[0]!;
    await authPost(session, "/organization/set-active", { organizationId: org.id });
    const cont = await authPost(session, "/oauth2/continue", { postLogin: true, oauth_query: next.search.slice(1) });
    next = new URL(cont.url, BASE);
  }
  if (next.pathname === "/consent") {
    const consent = await authPost(session, "/oauth2/consent", { accept: true, oauth_query: next.search.slice(1) });
    next = new URL(consent.url);
  }
  const code = next.searchParams.get("code");
  if (!code) throw new Error(`No authorization code in ${next}`);

  const tokenRes = await call(as.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: prm.resource,
    }),
  });
  const tokens = await tokenRes.json<{ access_token?: string }>();
  if (!tokens.access_token) throw new Error(`Token exchange failed: ${JSON.stringify(tokens)}`);
  const payload = tokens.access_token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
  const claims = JSON.parse(atob(payload)) as { sub: string; org_id: string; aud: string[] };
  return { token: tokens.access_token, claims };
}
