"use client";

import { useRef, useState } from "react";
import { Building2, Check, ChevronsUpDown, Search } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { useDismiss } from "./useDismiss";

/** Con más organizaciones que esto, el menú ofrece un buscador. */
const SEARCH_FROM = 6;

/** Cambia la organización activa: todas para el superadmin, las asignadas para quien tiene varias. */
export function OrgSwitcher() {
  const { userData, organizations, setSelectedOrgId, currentOrgName } = useAuth();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, open, () => setOpen(false));

  const activeId = userData?.organizationId ?? null;
  const name = currentOrgName ?? "Organización";
  const switchable = organizations.length > 1 || (userData?.isSuperAdmin && organizations.length > 0);

  if (!activeId) return null;

  if (!switchable) {
    return (
      <div className="orgpick">
        <p className="lbl">Organización</p>
        <div className="mod-btn org-static" data-m="general">
          <span className="dot"><Building2 /></span>
          <span className="grow"><b>{name}</b></span>
        </div>
      </div>
    );
  }

  const shown = organizations.filter((o) => o.name.toLowerCase().includes(filter.trim().toLowerCase()));

  return (
    <div className="orgpick modpick" ref={ref}>
      <p className="lbl">{userData?.isSuperAdmin ? "Organización · todas" : "Organización"}</p>
      <button
        type="button"
        className="mod-btn mod-trigger"
        data-m="general"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => { setOpen((o) => !o); setFilter(""); }}
      >
        <span className="dot"><Building2 /></span>
        <span className="grow"><b>{name}</b></span>
        <ChevronsUpDown size={16} aria-hidden="true" />
      </button>
      {open && (
        <div className="mod-menu org-menu">
          {organizations.length > SEARCH_FROM && (
            <label className="org-search">
              <Search size={14} aria-hidden="true" />
              <input autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Buscar organización" aria-label="Buscar organización" />
            </label>
          )}
          <ul role="listbox" aria-label="Organización">
            {shown.map((o) => (
              <li key={o.id} role="option" aria-selected={o.id === activeId}>
                <button
                  type="button"
                  className="mod-btn"
                  data-m="general"
                  onClick={() => { setSelectedOrgId(o.id); setOpen(false); }}
                >
                  <span className="grow"><b>{o.name}</b></span>
                  {o.id === activeId && <Check size={16} aria-hidden="true" />}
                </button>
              </li>
            ))}
            {shown.length === 0 && <li className="org-empty">Sin resultados</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
