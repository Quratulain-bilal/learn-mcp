import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import { jwt, organization } from "better-auth/plugins";

/**
 * Better Auth makes this Worker its own OAuth 2.1 authorization server, so Claude and
 * ChatGPT can sign users in when they add the connector:
 *
 *   1. The client calls /mcp with no token and gets a 401 pointing at our discovery metadata.
 *   2. It registers itself (dynamic client registration) and sends the user to /sign-in.
 *   3. The user signs in (email + password), picks a company if they have several, and
 *      approves access on /consent.
 *   4. The client gets an access token (a signed JWT) bound to our /mcp URL, and sends it
 *      on every request.
 *
 * All auth data (users, sessions, companies, members, OAuth clients) lives in D1.
 * Business data never goes in D1.
 */

/** Default roles from the organization plugin are owner/admin/member; we use admin and member. */
export const COMPANY_ROLES = ["admin", "member"] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];

// Scopes this server understands. MCP clients request them when they connect.
const SCOPES = ["openid", "profile", "email", "offline_access", "sales"];

/**
 * Builds the Better Auth instance for one request. It's cheap to build, and the base URL
 * (http://localhost:8787 locally, https://<worker>.workers.dev in production) comes
 * from the request, so nothing about a request is kept between requests.
 */
export function createAuth(env: Env, origin: string) {
  const auth = betterAuth({
    appName: "learn-mcp sales",
    baseURL: origin,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    // D1 is supported natively: pass the binding straight in.
    database: env.AUTH_DB,

    // Sign in with email and password. Sign-up is open: anyone can create an account,
    // and they only ever see their own company's data.
    emailAndPassword: { enabled: true, minPasswordLength: 8, maxPasswordLength: 128 },

    // The JWT plugin signs access tokens. Its own /token route and session-JWT header
    // are turned off so session JWTs can never be confused with OAuth access tokens.
    disabledPaths: ["/token"],

    plugins: [
      jwt({ disableSettingJwtHeader: true }),

      // Companies (tenants) and roles. Whoever creates a company is its admin.
      organization({ creatorRole: "admin", allowUserToCreateOrganization: true }),

      // mcp() is Better Auth's OAuth provider configured for MCP: tokens are bound to our
      // /mcp URL (the "resource"), and it serves the discovery metadata clients look for.
      mcp({
        resource: `${origin}/mcp`,
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: SCOPES,
        // Claude and ChatGPT register themselves when a user adds the connector (RFC 7591).
        // Registration is anonymous by design, so registered clients get only our scopes
        // and must use PKCE (Better Auth's default). The user still has to sign in and consent.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "infer",
        clientRegistrationDefaultScopes: SCOPES,
        clientRegistrationAllowedScopes: SCOPES,
        // Workers build the auth instance per request, so seed the resource once per isolate.
        resourceSeedScope: "process",

        // After sign-in: if the user belongs to several companies, send them to
        // /select-company to choose which one this connection is for.
        postLogin: {
          page: "/select-company",
          shouldRedirect: async ({ session, isContinuation }) => {
            if (isContinuation) return false; // they just chose one
            return (await countCompanies(env.AUTH_DB, session.userId)) > 1;
          },
          // Consent (and so the token) is tied to the chosen company. With only one
          // company there's nothing to choose, so fall back to it. A brand-new user's
          // first session can be created before their personal company exists.
          consentReferenceId: async ({ session }) =>
            (session.activeOrganizationId as string | null | undefined) ??
            (await firstCompanyId(env.AUTH_DB, session.userId)) ??
            undefined,
        },

        // Put the chosen company in the access token. The MCP endpoint reads it from the
        // VERIFIED token, so a tool can never be told which company to use.
        customAccessTokenClaims: ({ referenceId }) => (referenceId ? { org_id: referenceId } : {}),
      }),
    ],

    databaseHooks: {
      user: {
        create: {
          // Every user belongs to a company: create a personal one on sign-up.
          after: async (user) => {
            await auth.api.createOrganization({
              body: {
                name: `${user.name || user.email}'s company`,
                slug: `personal-${user.id.toLowerCase()}`,
                userId: user.id,
              },
            });
          },
        },
      },
      session: {
        create: {
          // New sessions start with the user's first company active.
          before: async (session) => ({
            data: { ...session, activeOrganizationId: await firstCompanyId(env.AUTH_DB, session.userId) },
          }),
        },
      },
    },
  });
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;

async function firstCompanyId(db: D1Database, userId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT organizationId FROM member WHERE userId = ? ORDER BY createdAt LIMIT 1")
    .bind(userId)
    .first<{ organizationId: string }>();
  return row?.organizationId ?? null;
}

async function countCompanies(db: D1Database, userId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM member WHERE userId = ?").bind(userId).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * The user's CURRENT role in a company, read from the member table on every request,
 * so removing or demoting someone takes effect on their very next call.
 * Returns null if they are no longer a member.
 */
export async function lookupRole(db: D1Database, orgId: string, userId: string): Promise<CompanyRole | null> {
  const row = await db
    .prepare("SELECT role FROM member WHERE organizationId = ? AND userId = ?")
    .bind(orgId, userId)
    .first<{ role: string }>();
  if (!row) return null;
  // A member row can hold several comma-separated roles; owner counts as admin.
  const roles = row.role.split(",").map((r) => r.trim());
  return roles.includes("admin") || roles.includes("owner") ? "admin" : "member";
}
