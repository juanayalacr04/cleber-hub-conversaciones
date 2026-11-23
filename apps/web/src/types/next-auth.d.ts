import "next-auth";
import "next-auth/jwt";

declare module "next-auth" {
  interface Session {
    /** id_token de Google: para el API Gateway (servidor) y para abrir la sesión de Firebase (navegador). */
    idToken?: string;
    /** "RENOVACION_FALLIDA": el id_token venció y no se pudo renovar; hay que volver a iniciar sesión. */
    error?: "RENOVACION_FALLIDA";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    idToken?: string;
    expiraEn?: number;
    refreshToken?: string;
    error?: "RENOVACION_FALLIDA";
  }
}
