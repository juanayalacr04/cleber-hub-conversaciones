"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { collection, getCountFromServer, query, where, type QueryConstraint } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { isAdmin, useAuth } from "@/contexts/AuthContext";
import { PageHead } from "@/components/shell/Shell";
import { Icon } from "@/components/shell/icons";
import { getModule } from "@/lib/modules";

type Counts = { bot: number; waiting_agent: number; with_agent: number; closed: number };

function useCounts(moduleId: string) {
  const { userData } = useAuth();
  const [counts, setCounts] = useState<Counts | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const mod = getModule(moduleId);
    if (!userData?.organizationId || !mod) return;
    let cancelled = false;
    const base: QueryConstraint[] = [where("organizationId", "==", userData.organizationId)];
    if (mod.vertical) base.push(where("vertical", "==", mod.vertical));
    // Un agente solo puede consultar su equipo (lo exigen las reglas de Firestore).
    if (!isAdmin(userData) && userData.teamId) base.push(where("teamId", "==", userData.teamId));

    const count = (status: keyof Counts) =>
      getCountFromServer(query(collection(db, "conversations"), ...base, where("status", "==", status))).then((s) => s.data().count);

    Promise.all([count("bot"), count("waiting_agent"), count("with_agent"), count("closed")])
      .then(([bot, waiting_agent, with_agent, closed]) => !cancelled && setCounts({ bot, waiting_agent, with_agent, closed }))
      .catch((e) => { console.error(e); if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [moduleId, userData]);

  return { counts, error };
}

function Stat({ label, value, note, icon, hot }: { label: string; value: string; note: string; icon: string; hot?: boolean }) {
  return (
    <div className={`card stat${hot ? " hot" : ""}`}>
      <Icon name={icon} className="big" />
      <div className="top">{label}<span className="chipi"><Icon name={icon} /></span></div>
      <strong className="num">{value}</strong>
      <em>{note}</em>
    </div>
  );
}

export default function DashboardPage() {
  const { module: moduleId } = useParams<{ module: string }>();
  const { userData } = useAuth();
  const mod = getModule(moduleId);
  const { counts, error } = useCounts(moduleId);
  if (!mod) return null;

  const n = (v?: number) => (counts ? String(v ?? 0) : "…");
  const first = (userData?.name || "").split(" ")[0] || "Usuario";
  const empty = counts && counts.bot + counts.waiting_agent + counts.with_agent + counts.closed === 0;

  return (
    <>
      <PageHead
        title={`Hola, ${first}`}
        subtitle={mod.id === "general" ? "Resumen de los dos módulos" : `Dashboard del módulo de ${mod.label}`}
        mod={mod}
      />
      <div className="view">
        <div className="pad">
          {error && <div className="alert" role="alert">No se pudieron cargar los indicadores. Revisa tus permisos o recarga la página.</div>}
          <div className="grid4">
            <Stat label="Esperando agente" value={n(counts?.waiting_agent)} note="Pidieron hablar con una persona" icon="clock" hot={!!counts && counts.waiting_agent > 0} />
            <Stat label="Atiende el bot" value={n(counts?.bot)} note="Conversaciones con el bot" icon="bot" />
            <Stat label="Con agente" value={n(counts?.with_agent)} note="Conversaciones asignadas" icon="user" />
            <Stat label="Cerradas" value={n(counts?.closed)} note="Total acumulado" icon="msg" />
          </div>
          {empty && (
            <div className="card">
              <div className="empty">
                <b style={{ color: "var(--fg)" }}>Aún no hay conversaciones</b>
                <br />
                Aparecerán aquí cuando entren por WhatsApp. Los indicadores del módulo (tiempos, citas, embudo) se definen en la Fase 1.
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
