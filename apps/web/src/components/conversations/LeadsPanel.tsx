"use client";

import { useEffect, useState } from "react";
import { Loader2, UserCircle, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { auth } from "@/lib/firebase";

interface Lead {
  Id: string;
  Name: string;
  Phone?: string;
  MobilePhone?: string;
  Email?: string;
  Status?: string;
  Company?: string;
  LeadSource?: string;
}

interface LeadsPanelProps {
  customerPhone: string;
}

export default function LeadsPanel({ customerPhone }: LeadsPanelProps) {
  const { userData } = useAuth();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userData?.organizationId || !customerPhone) return;

    async function fetchLeads() {
      setLoading(true);
      setError(null);
      try {
        const token = await auth.currentUser?.getIdToken();
        // Use last 10 digits to match regardless of country code format
        const digits = customerPhone.replace(/\D/g, "").slice(-10);
        const soql = `SELECT Id, Name, Phone, MobilePhone, Email, Status, Company, LeadSource FROM Lead WHERE Phone LIKE '%${digits}%' OR MobilePhone LIKE '%${digits}%' ORDER BY CreatedDate DESC LIMIT 10`;

        const res = await fetch("/api/salesforce/query", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ soql, organizationId: userData!.organizationId }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Error al cargar leads");
        setLeads(data.records);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Error desconocido");
      } finally {
        setLoading(false);
      }
    }

    fetchLeads();
  }, [customerPhone, userData?.organizationId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="py-8 px-4 text-center">
        <p className="text-sm text-red-500">{error}</p>
      </div>
    );
  }

  if (leads.length === 0) {
    return (
      <div className="py-8 px-4 text-center">
        <UserCircle className="h-10 w-10 text-gray-300 mx-auto mb-2" />
        <p className="text-sm text-gray-500">No se encontraron leads en Salesforce para este numero.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-3 space-y-2">
      {leads.map((lead) => (
        <div key={lead.Id} className="border rounded-lg p-3 space-y-1 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium truncate">{lead.Name}</span>
            <a
              href={`https://cleber.lightning.force.com/lightning/r/Lead/${lead.Id}/view`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-600 ml-2 shrink-0"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
          {lead.Company && (
            <p className="text-gray-500 text-xs truncate">{lead.Company}</p>
          )}
          <div className="flex flex-wrap gap-1 pt-1">
            {lead.Status && (
              <Badge variant="secondary" className="text-[10px]">
                {lead.Status}
              </Badge>
            )}
            {lead.LeadSource && (
              <Badge variant="outline" className="text-[10px]">
                {lead.LeadSource}
              </Badge>
            )}
          </div>
          {lead.Email && (
            <p className="text-xs text-gray-400 truncate">{lead.Email}</p>
          )}
        </div>
      ))}
    </div>
  );
}
