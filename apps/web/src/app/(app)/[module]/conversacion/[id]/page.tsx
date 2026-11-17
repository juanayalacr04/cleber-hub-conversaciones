"use client";

import { notFound, useParams } from "next/navigation";
import { getModule } from "@/lib/modules";
import { ConversacionHubView } from "@/components/valuacion/ConversacionHubView";

/** Una conversación de Valuación en hub_cleber (p. ej. la que abrió el envío de una oferta). Ventas y Servicio aún leen Firestore. */
export default function ConversacionPage() {
  const { module: moduleId, id } = useParams<{ module: string; id: string }>();
  const mod = getModule(moduleId);
  if (mod?.id !== "valuacion") notFound();
  return <ConversacionHubView key={id} mod={mod} idConversacion={decodeURIComponent(id)} />;
}
