"use client";

import { useEffect, useState } from "react";
import { Loader2, Building2, Car, ExternalLink } from "lucide-react";
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

interface Vehicle {
  Id: string;
  Name: string;
  SerialNumber?: string;
  Status?: string;
  AccountId?: string;
}

interface AccountsPanelProps {
  customerPhone: string;
}

async function salesforceQuery<T>(soql: string, organizationId: string, errorMessage: string): Promise<T[]> {
  const token = await auth.currentUser?.getIdToken();
  const res = await fetch("/api/salesforce/query", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ soql, organizationId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || errorMessage);
  return data.records;
}

/** Cuentas del cliente con los vehículos de cada una. */
export default function AccountsPanel({ customerPhone }: AccountsPanelProps) {
  const { userData } = useAuth();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userData?.organizationId || !customerPhone) return;
    const organizationId = userData.organizationId;

    async function fetchAccounts() {
      setLoading(true);
      setError(null);
      try {
        const digits = customerPhone.replace(/\D/g, "").slice(-10);
        const accountRecords = await salesforceQuery<Account>(
          `SELECT Id, Name, Phone, BillingCity, Type, Industry FROM Account WHERE Phone LIKE '%${digits}%' ORDER BY CreatedDate DESC LIMIT 10`,
          organizationId,
          "Error al cargar cuentas"
        );
        setAccounts(accountRecords);

        if (accountRecords.length === 0) {
          setVehicles([]);
          return;
        }
        const idList = accountRecords.map((a) => `'${a.Id}'`).join(",");
        setVehicles(
          await salesforceQuery<Vehicle>(
            `SELECT Id, Name, SerialNumber, Status, AccountId FROM Asset WHERE AccountId IN (${idList}) ORDER BY CreatedDate DESC LIMIT 20`,
            organizationId,
            "Error al cargar vehiculos"
          )
        );
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
      {accounts.map((account) => {
        const accountVehicles = vehicles.filter((v) => v.AccountId === account.Id);
        return (
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
            {accountVehicles.length > 0 && (
              <div className="pt-2 space-y-1">
                {accountVehicles.map((vehicle) => (
                  <div key={vehicle.Id} className="flex items-center justify-between gap-2 rounded-md bg-gray-50 px-2 py-1.5">
                    <div className="min-w-0 flex items-center gap-2">
                      <Car className="h-3.5 w-3.5 text-gray-400 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate">{vehicle.Name}</p>
                        {vehicle.SerialNumber && (
                          <p className="text-[10px] text-gray-400 truncate">Serie: {vehicle.SerialNumber}</p>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {vehicle.Status && (
                        <Badge variant="secondary" className="text-[10px]">
                          {vehicle.Status}
                        </Badge>
                      )}
                      <a
                        href={`https://cleber.lightning.force.com/lightning/r/Asset/${vehicle.Id}/view`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gray-400 hover:text-gray-600"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
