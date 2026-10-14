import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { FieldValue } from "firebase-admin/firestore";
import { verifyAuthToken } from "@/lib/auth-middleware";

const MAKE_EMAIL_WEBHOOK = "https://hook.us1.make.com/11t3blm10bdy7f7ol5d7lyaqvjeteajr";
const EMAIL_FROM = "usr.prd.sistemas@cleber.com";
const FALLBACK_APP_URL = "https://web-delta-three-35.vercel.app";

// URL de la plataforma según el ambiente (dev / qa / prod / local):
// 1) Origen de la petición — el admin invita desde el dashboard de su propio ambiente.
// 2) NEXT_PUBLIC_APP_URL — override por si se quiere forzar un dominio canónico.
// 3) Fallback: dominio de producción.
function resolveAppUrl(request: NextRequest): string {
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host");
  if (host) {
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim();
    const isLocal = host.startsWith("localhost") || host.startsWith("127.0.0.1");
    return `${forwardedProto || (isLocal ? "http" : "https")}://${host}`;
  }

  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");

  return FALLBACK_APP_URL;
}

export async function POST(request: NextRequest) {
  try {
    const authUser = await verifyAuthToken(request);
    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { email, role, organizationId: requestedOrgId, teamId: requestedTeamId } = await request.json();

    if (!email || !role) {
      return NextResponse.json(
        { error: "Email and role are required" },
        { status: 400 }
      );
    }

    if (!["admin", "agent", "viewer"].includes(role)) {
      return NextResponse.json(
        { error: "Role must be 'admin', 'agent', or 'viewer'" },
        { status: 400 }
      );
    }

    // Verify the caller is an admin
    const callerDoc = await adminDb.collection("users").doc(authUser.uid).get();
    if (!callerDoc.exists) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const callerData = callerDoc.data();
    const isSuperAdmin = callerData?.isSuperAdmin === true;
    const callerOrgIds: string[] = callerData?.organizationIds ||
      (callerData?.organizationId ? [callerData.organizationId] : []);

    if (!isSuperAdmin && (callerData?.role !== "admin" || callerOrgIds.length === 0)) {
      return NextResponse.json({ error: "Forbidden: admin role required" }, { status: 403 });
    }

    // SuperAdmin: cualquier org; admin multi-org: solo sus orgs; admin single-org: su org
    const organizationId = isSuperAdmin
      ? (requestedOrgId || callerOrgIds[0])
      : (requestedOrgId && callerOrgIds.includes(requestedOrgId))
        ? requestedOrgId
        : callerOrgIds[0];

    // Buscar todos los docs con ese email
    const emailSnap = await adminDb.collection("users").where("email", "==", email).get();

    // Revisar si alguno ya pertenece a la org destino
    const alreadyInOrg = emailSnap.docs.find((d) => {
      const orgIds: string[] = d.data().organizationIds ||
        (d.data().organizationId ? [d.data().organizationId] : []);
      return orgIds.includes(organizationId);
    });

    // Equipo opcional: debe existir y pertenecer a la organización destino
    let teamId: string | null = null;
    if (requestedTeamId) {
      const teamDoc = await adminDb.collection("teams").doc(String(requestedTeamId)).get();
      if (!teamDoc.exists || teamDoc.data()?.organizationId !== organizationId) {
        return NextResponse.json({ error: "Equipo inválido para la organización" }, { status: 400 });
      }
      teamId = teamDoc.id;
    }

    const now = new Date();
    let newUserData: Record<string, unknown>;

    if (alreadyInOrg) {
      const existingData = alreadyInOrg.data();
      // Usuario activo (tiene id de Firebase Auth) ya en esta org → rechazar
      if (existingData.id) {
        return NextResponse.json(
          { error: "Ya existe un usuario activo con este email en la organización" },
          { status: 409 }
        );
      }
      // Pre-registrado en esta org → actualizar rol
      const teamUpdate = teamId
        ? { teamId, [`orgTeams.${organizationId}`]: teamId }
        : {};
      await alreadyInOrg.ref.update({ role, invitedBy: authUser.uid, ...teamUpdate });
      newUserData = {
        ...existingData,
        role,
        invitedBy: authUser.uid,
        ...(teamId ? { teamId, orgTeams: { ...(existingData.orgTeams || {}), [organizationId]: teamId } } : {}),
      };
    } else if (!emailSnap.empty) {
      // Usuario existe pero en otra org → agregar esta org
      const existingDoc = emailSnap.docs[0];
      const existingData = existingDoc.data();
      const existingOrgId = existingData.organizationId as string | null;
      // Si aún no tiene organizationIds (formato viejo), inicializar con org actual + nueva
      const idsToUnion: string[] = existingData.organizationIds
        ? [organizationId]
        : existingOrgId ? [existingOrgId, organizationId] : [organizationId];
      await existingDoc.ref.update({
        organizationIds: FieldValue.arrayUnion(...idsToUnion),
        role,
        invitedBy: authUser.uid,
        ...(teamId ? { teamId, [`orgTeams.${organizationId}`]: teamId } : {}),
      });
      const existingOrgIds: string[] = existingData.organizationIds ||
        (existingOrgId ? [existingOrgId] : []);
      newUserData = {
        ...existingData,
        organizationIds: [...new Set([...existingOrgIds, organizationId])],
        role,
        invitedBy: authUser.uid,
        ...(teamId ? { teamId, orgTeams: { ...(existingData.orgTeams || {}), [organizationId]: teamId } } : {}),
      };
    } else {
      // Usuario nuevo → crear doc pre-registrado
      const newUserRef = adminDb.collection("users").doc();
      newUserData = {
        id: newUserRef.id,
        email,
        name: "",
        role,
        organizationId,
        organizationIds: [organizationId],
        teamId,
        orgTeams: teamId ? { [organizationId]: teamId } : {},
        status: "offline",
        photoURL: null,
        createdAt: now,
        lastLoginAt: null,
        invitedBy: authUser.uid,
      };
      await newUserRef.set(newUserData);
    }

    const appUrl = resolveAppUrl(request);
    const roleLabel = role === "admin" ? "Administrador" : role === "agent" ? "Agente" : "Observador";

    const orgDoc = await adminDb.collection("organizations").doc(organizationId).get();
    const orgName = (orgDoc.data()?.name as string | undefined) || organizationId;

    try {
      await fetch(MAKE_EMAIL_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: email,
          from: EMAIL_FROM,
          subject: `Invitación a la plataforma de Conversaciones — ${orgName}`,
          content: `
            <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Has sido invitado a la plataforma</h2>
              <p>Un administrador te ha invitado a unirte al equipo de <strong>${orgName}</strong> como <strong>${roleLabel}</strong>.</p>
              <p>Haz clic en el siguiente enlace para acceder:</p>
              <a href="${appUrl}" style="display: inline-block; padding: 12px 24px; background-color: #000; color: #fff; text-decoration: none; border-radius: 6px; margin: 16px 0;">
                Acceder a la plataforma
              </a>
              <p style="color: #666; font-size: 14px;">Inicia sesión con tu cuenta de Google asociada a <strong>${email}</strong>.</p>
            </div>
          `,
        }),
      });
    } catch (emailError) {
      console.error("Error sending invite email:", emailError);
      // No fallar la invitación si el email falla — el doc ya fue creado en Firestore
    }

    return NextResponse.json({ success: true, user: newUserData });
  } catch (error) {
    console.error("Error creating invite:", error);
    return NextResponse.json(
      { error: "Failed to create invitation" },
      { status: 500 }
    );
  }
}
