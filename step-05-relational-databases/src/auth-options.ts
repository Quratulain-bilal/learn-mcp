import { mcp } from "@better-auth/mcp";
import type { OAuthProviderExtension } from "@better-auth/oauth-provider";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { jwt, organization } from "better-auth/plugins";

export const OAUTH_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "mcp:read",
  "mcp:write"
] as const;

export interface AuthConfig {
  baseURL: string;
  resource: string;
  secret: string;
  database: D1Database;
}

function slugFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "user";
  const slug = local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "user";
}

async function currentOrganizationId(
  database: D1Database,
  userId: string,
  sessionId?: string
): Promise<string | null> {
  if (sessionId) {
    const session = await database
      .prepare("SELECT activeOrganizationId FROM session WHERE id = ?")
      .bind(sessionId)
      .first<{ activeOrganizationId: string | null }>();
    if (session?.activeOrganizationId) return session.activeOrganizationId;
  }

  const membership = await database
    .prepare("SELECT organizationId FROM member WHERE userId = ? ORDER BY createdAt DESC LIMIT 1")
    .bind(userId)
    .first<{ organizationId: string | null }>();
  return membership?.organizationId ?? null;
}

export function createAuthOptions(config: AuthConfig): BetterAuthOptions {
  const origin = new URL(config.baseURL).origin;
  const extensions: OAuthProviderExtension[] = [
    {
      claims: {
        accessToken: async ({ user, sessionId }) => {
          if (!user?.id) return {};
          const orgId = await currentOrganizationId(config.database, user.id, sessionId);
          return orgId ? { org_id: orgId } : {};
        }
      }
    }
  ];

  return {
    appName: "Learn MCP Auth",
    baseURL: config.baseURL,
    secret: config.secret,
    database: config.database,
    trustedOrigins: [origin],
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false
    },
    advanced: {
      database: {
        generateId: () => crypto.randomUUID()
      }
    },
    plugins: [
      jwt({
        disableSettingJwtHeader: true,
        jwt: {
          definePayload: ({ session }) => ({
            org_id:
              (session as { activeOrganizationId?: string }).activeOrganizationId ??
              undefined
          })
        }
      }),
      organization({
        allowUserToCreateOrganization: true
      }),
      mcp({
        resource: config.resource,
        loginPage: "/sign-in",
        consentPage: "/consent",
        scopes: [...OAUTH_SCOPES],
        extensions,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultApplicationType: "infer",
        clientRegistrationDefaultScopes: [...OAUTH_SCOPES]
      })
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            const organizationId = `org-${crypto.randomUUID()}`;
            const memberId = `member-${crypto.randomUUID()}`;
            const slug = `${slugFromEmail(user.email)}-${organizationId.slice(-8)}`;
            const now = Date.now();
            await config.database.batch([
              config.database
                .prepare(
                  "INSERT INTO organization (id, name, slug, metadata, createdAt) VALUES (?, ?, ?, ?, ?)"
                )
                .bind(
                  organizationId,
                  `${user.name || user.email}'s company`,
                  slug,
                  "{}",
                  now
                ),
              config.database
                .prepare(
                  "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)"
                )
                .bind(memberId, organizationId, user.id, "admin", now)
            ]);
          }
        }
      },
      session: {
        create: {
          after: async (session) => {
            const orgId = await currentOrganizationId(config.database, session.userId);
            if (!orgId) return;
            await config.database
              .prepare("UPDATE session SET activeOrganizationId = ? WHERE id = ?")
              .bind(orgId, session.id)
              .run();
          }
        }
      }
    }
  };
}

export function createAuth(config: AuthConfig) {
  return betterAuth(createAuthOptions(config));
}
