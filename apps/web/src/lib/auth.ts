import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

/**
 * Login del dashboard: NextAuth v5 + Google (template-para-desarrollo, docs/autenticacion.md; diseño del hub Q2).
 *
 * La sesión guarda el id_token de Google, que se usa para dos cosas:
 *   - El servidor lo manda al API Gateway (lib/api.ts); el authorizer lo valida e inyecta X-User-Email.
 *   - El navegador abre con él la sesión de Firebase (signInWithCredential), solo para leer Firestore.
 *
 * El id_token de Google vence en una hora y el authorizer rechaza tokens vencidos (a diferencia de lo que supone
 * el template), así que se pide un refresh token (access_type=offline) y se renueva el id_token 5 minutos antes
 * de que venza. Si la renovación falla, la sesión queda con `error` y el cliente vuelve a /login.
 */

const MARGEN_S = 5 * 60;

interface TokenGoogle {
  idToken?: string;
  expiraEn?: number;        // segundos epoch en que vence el id_token
  refreshToken?: string;
  error?: "RENOVACION_FALLIDA";
}

async function renuevaIdToken(token: TokenGoogle): Promise<TokenGoogle> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID!,
        client_secret: process.env.GOOGLE_CLIENT_SECRET!,
        grant_type: "refresh_token",
        refresh_token: token.refreshToken!,
      }),
    });
    const nuevo = await res.json();
    if (!res.ok || !nuevo.id_token) throw new Error(nuevo.error ?? `HTTP ${res.status}`);
    return {
      ...token,
      idToken: nuevo.id_token,
      expiraEn: Math.floor(Date.now() / 1000) + Number(nuevo.expires_in ?? 3600),
      refreshToken: nuevo.refresh_token ?? token.refreshToken,   // Google normalmente no rota el refresh token
      error: undefined,
    };
  } catch (e) {
    console.error("No se pudo renovar el id_token de Google:", e);
    return { ...token, error: "RENOVACION_FALLIDA" };
  }
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      // offline + consent: Google entrega refresh token para renovar el id_token sin volver a pedir login
      authorization: { params: { access_type: "offline", prompt: "consent", scope: "openid email profile" } },
    }),
  ],
  pages: { signIn: "/login" },
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        // Primer inicio de sesión: Google acaba de entregar los tokens
        return {
          ...token,
          idToken: account.id_token,
          expiraEn: account.expires_at ?? Math.floor(Date.now() / 1000) + 3600,
          refreshToken: account.refresh_token,
          error: undefined,
        };
      }
      const t = token as typeof token & TokenGoogle;
      if (t.expiraEn && Date.now() / 1000 < t.expiraEn - MARGEN_S) return token;
      if (!t.refreshToken) return { ...token, error: "RENOVACION_FALLIDA" };
      return { ...token, ...(await renuevaIdToken(t)) };
    },
    async session({ session, token }) {
      const t = token as typeof token & TokenGoogle;
      session.idToken = t.idToken;
      session.error = t.error;
      return session;
    },
  },
});
