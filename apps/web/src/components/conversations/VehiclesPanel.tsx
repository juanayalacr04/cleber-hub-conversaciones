"use client";

import { useEffect, useState } from "react";
import { Loader2, Car, ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { useAuth } from "@/contexts/AuthContext";
import { auth } from "@/lib/firebase";

interface Vehicle {
  Id: string;
  Name: string;
  SerialNumber?: string;
  Status?: string;
  AccountId?: string;
  // Custom fields common in dealership setups
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface VehiclesPanelProps {
  accountIds: string[];
}

export default function VehiclesPanel({ accountIds }: VehiclesPanelProps) {
  const { userData } = useAuth();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userData?.organizationId || accountIds.length === 0) {
      setVehicles([]);
      return;
    }

    async function fetchVehicles() {
      setLoading(true);
      setError(null);
      try {
        const token = await auth.currentUser?.getIdToken();
        const idList = accountIds.map((id) => `'${id}'`).join(",");
        const soql = `SELECT Id, Name, SerialNumber, Status, AccountId FROM Asset WHERE AccountId IN (${idList}) ORDER BY CreatedDate DESC LIMIT 20`;

        const res = await fetch("/api/salesforce/query", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ soql, organizationId: userData!.organizationId }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "Error al cargar vehiculos");
        setVehicles(data.records);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Error desconocido");
      } finally {
        setLoading(false);
      }
    }

    fetchVehicles();
  }, [accountIds, userData?.organizationId]);

  if (accountIds.length === 0) {
    return (
      <div className="py-8 px-4 text-center">
        <Car className="h-10 w-10 text-gray-300 mx-auto mb-2" />
        <p className="text-sm text-gray-500">Abre la pestana Cuentas primero para cargar los vehiculos asociados.</p>
      </div>
    );
  }

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

  if (vehicles.length === 0) {
    return (
      <div className="py-8 px-4 text-center">
        <Car className="h-10 w-10 text-gray-300 mx-auto mb-2" />
        <p className="text-sm text-gray-500">No se encontraron vehiculos asociados a estas cuentas.</p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto py-3 space-y-2">
      {vehicles.map((vehicle) => (
        <div key={vehicle.Id} className="border rounded-lg p-3 space-y-1 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium truncate">{vehicle.Name}</span>
            <a
              href={`https://cleber.lightning.force.com/lightning/r/Asset/${vehicle.Id}/view`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-gray-400 hover:text-gray-600 ml-2 shrink-0"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
          {vehicle.SerialNumber && (
            <p className="text-xs text-gray-400">Serie: {vehicle.SerialNumber}</p>
          )}
          {vehicle.Status && (
            <div className="pt-1">
              <Badge variant="secondary" className="text-[10px]">
                {vehicle.Status}
              </Badge>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
