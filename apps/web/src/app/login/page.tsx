"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/contexts/AuthContext";

export default function LoginPage() {
  const { signInWithGoogle, userData, loading, accessDenied, profileError } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loading && userData) router.replace("/");
  }, [loading, userData, router]);

  async function onSignIn() {
    setError(null);
    try {
      await signInWithGoogle();
    } catch {
      setError("No se pudo iniciar sesión con Google. Intenta de nuevo.");
    }
  }

  return (
    <div className="center">
      <div className="card login">
        <div className="brand-mark" style={{ width: 44, height: 44, fontSize: 20 }}>C</div>
        <h1>Cleber Hub</h1>
        <p>Conversaciones de Comercial y Servicio</p>
        {accessDenied && <div className="alert" role="alert">Tu cuenta no tiene acceso. Pide a un administrador que te dé de alta con este correo.</div>}
        {profileError && <div className="alert" role="alert">No se pudo cargar tu perfil. Recarga la página; si sigue igual, avisa a un administrador.</div>}
        {error && <div className="alert" role="alert">{error}</div>}
        <button type="button" className="btn primary" onClick={onSignIn} disabled={loading}>Entrar con Google</button>
      </div>
    </div>
  );
}
