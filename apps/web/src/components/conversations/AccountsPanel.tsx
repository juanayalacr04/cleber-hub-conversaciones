"use client";

import { useEffect, useState } from "react";
import { Loader2, Building2, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { auth } from "@/lib/firebase";

interface Account {
  Id: string;
  Name: string;
  Phone?: string;
  BillingCity?: string;
  Type?: string;
  Industry?: string;
}

interface AccountsPanelProps {
  customerPhone: string;
  onAccountsLoaded: (ids: string[]) => void;
}

export default function AccountsPanel({ customerPhone, onAccountsLoaded }: AccountsPanelProps) {
  const { userData } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userData?.organizationId || !customerPhone) return;

    async function fetchAccounts() {
      setLoading(true);
      setError(null);
      try {
        const token = await auth.currentUser?.getIdToken();
        const digits = customerPhone.replace(/\D/g, "").slice(-10);
        const soql = `SELECT Id, Name, Phone, BillingCity, Type, Industry FROM Account WHERE Phone LIKE '%${digits}%' ORDER BY CreatedDate DESC LIMIT 10`;

        const res = await fetch("/api/salesforce/query", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ soql, organizationId: userData!.organizationId }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Error al cargar cuentas");

        setAccounts(data.records);
        onAccountsLoaded(data.records.map((a: Account) => a.Id));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Error desconocido");
      } finally {
        setLoading(false);
      }
    }

    fetchAccounts();
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

  if (accounts.length === 0) {
    return (
      <div className="py-8 px-4 text-center">
        <Building2 className="h-10 w-10 text-gray-300 mx-auto mb-2" />
        <p className="text-sm text-gray-500">No se encontraron cuentas en Salesforce para este numero.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-3 space-y-2">
      {accounts.map((account) => (
        <div key={account.Id} className="border rounded-lg p-3 space-y-1 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium truncate">{account.Name}</span>
            <a
              href={`https://cleber.lightning.force.com/lightning/r/Account/${account.Id}/view`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-600 ml-2 shrink-0"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
          {account.BillingCity && (
            <p className="text-xs text-gray-400">{account.BillingCity}</p>
          )}
          <div className="flex flex-wrap gap-1 pt-1">
            {account.Type && (
              <Badge variant="secondary" className="text-[10px]">
                {account.Type}
              </Badge>
            )}
            {account.Industry && (
              <Badge variant="outline" className="text-[10px]">
                {account.Industry}
              </Badge>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
