"use client";

/**
 * Pestaña "Horarios de Atención" de un bot: la comparten la pantalla de Bots de Ventas y Servicio (Firestore) y la de Valuación
 * (hub_cleber). Es solo presentación: el estado y el guardado son de quien la usa.
 */

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export const SCHEDULE_DAY_ORDER = ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] as const;
export const SCHEDULE_DAY_NAMES: Record<string, string> = {
  monday: "Lunes", tuesday: "Martes", wednesday: "Miércoles",
  thursday: "Jueves", friday: "Viernes", saturday: "Sábado", sunday: "Domingo",
};
const FIXED_CLOSING = "Si necesitas un asesor en otro momento, con gusto lo intento de nuevo.";
export const TIMEZONES = [
  "America/Mexico_City",
  "America/Monterrey",
  "America/Tijuana",
  "America/Bogota",
  "America/Lima",
  "America/Santiago",
  "America/Argentina/Buenos_Aires",
  "America/New_York",
  "America/Los_Angeles",
];

export type DayState = { enabled: boolean; startTime: string; endTime: string };

function buildPreviewMessage(message: string, days: Record<string, DayState>): string {
  const base = message || "Nuestros asesores no están disponibles en este momento.";
  const lines = ["\n\nNuestro horario de atención:"];
  for (const day of SCHEDULE_DAY_ORDER) {
    const d = days[day];
    lines.push(`\n  ${SCHEDULE_DAY_NAMES[day]}: ${d?.enabled ? `${d.startTime} - ${d.endTime}` : "Cerrado"}`);
  }
  lines.push(`\n\n${FIXED_CLOSING}`);
  return base + lines.join("");
}

export function ScheduleConfigTab({
  enabled, onEnabledChange,
  timezone, onTimezoneChange,
  outOfHoursMessage, onOutOfHoursMessageChange,
  days, onDaysChange,
  viaBot, onViaBotChange,
}: {
  enabled: boolean; onEnabledChange: (v: boolean) => void;
  timezone: string; onTimezoneChange: (v: string) => void;
  outOfHoursMessage: string; onOutOfHoursMessageChange: (v: string) => void;
  days: Record<string, DayState>; onDaysChange: (v: Record<string, DayState>) => void;
  viaBot: boolean; onViaBotChange: (v: boolean) => void;
}) {
  const updateDay = (day: string, field: keyof DayState, value: boolean | string) => {
    onDaysChange({ ...days, [day]: { ...days[day], [field]: value } });
  };
  const preview = buildPreviewMessage(outOfHoursMessage, days);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Horarios de Atención</CardTitle>
        <CardDescription>
          Configura los horarios en que los asesores están disponibles. Si el cliente pide un asesor fuera de horario, el bot le enviará el mensaje de no disponibilidad.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id="scheduleEnabled"
            checked={enabled}
            onChange={(e) => onEnabledChange(e.target.checked)}
            className="h-4 w-4 rounded border-gray-300"
          />
          <Label htmlFor="scheduleEnabled">Habilitar verificación de horarios</Label>
        </div>

        {enabled && (
          <>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="scheduleViaBot"
                checked={viaBot}
                onChange={(e) => onViaBotChange(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              <Label htmlFor="scheduleViaBot">El bot redacta el aviso de fuera de horario</Label>
            </div>
            <div className="space-y-2">
              <Label>Zona horaria</Label>
              <Select value={timezone} onValueChange={onTimezoneChange}>
                <SelectTrigger className="w-72">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TIMEZONES.map((tz) => (
                    <SelectItem key={tz} value={tz}>{tz}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="outOfHoursMessage">Mensaje base (fuera de horario)</Label>
              <textarea
                id="outOfHoursMessage"
                value={outOfHoursMessage}
                onChange={(e) => onOutOfHoursMessageChange(e.target.value)}
                placeholder="Nuestros asesores no están disponibles en este momento."
                rows={3}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <p className="text-xs text-muted-foreground">El sistema agregará automáticamente el horario formateado y el texto de cierre.</p>
            </div>

            <div className="space-y-2">
              <Label>Días y horarios</Label>
              <div className="rounded-lg border divide-y">
                {SCHEDULE_DAY_ORDER.map((day) => {
                  const d = days[day];
                  return (
                    <div key={day} className="flex items-center gap-4 px-4 py-3">
                      <div className="flex items-center gap-2 w-36">
                        <input
                          type="checkbox"
                          id={`day-${day}`}
                          checked={d?.enabled ?? false}
                          onChange={(e) => updateDay(day, "enabled", e.target.checked)}
                          className="h-4 w-4 rounded border-gray-300"
                        />
                        <Label htmlFor={`day-${day}`} className="font-normal cursor-pointer">
                          {SCHEDULE_DAY_NAMES[day]}
                        </Label>
                      </div>
                      {d?.enabled ? (
                        <div className="flex items-center gap-2">
                          <Input
                            type="time"
                            value={d.startTime}
                            onChange={(e) => updateDay(day, "startTime", e.target.value)}
                            className="w-32"
                          />
                          <span className="text-muted-foreground text-sm">a</span>
                          <Input
                            type="time"
                            value={d.endTime}
                            onChange={(e) => updateDay(day, "endTime", e.target.value)}
                            className="w-32"
                          />
                        </div>
                      ) : (
                        <span className="text-sm text-muted-foreground">Cerrado</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Vista previa del mensaje al cliente</Label>
              <div className="rounded-lg border bg-muted/30 p-4">
                <p className="text-sm whitespace-pre-wrap text-muted-foreground">{preview}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                El texto <span className="font-medium text-foreground">&ldquo;{FIXED_CLOSING}&rdquo;</span> se agrega siempre automáticamente.
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** Los siete días cerrados, con el horario que se propone al abrirlos. */
export function diasPorOmision(): Record<string, DayState> {
  return Object.fromEntries(SCHEDULE_DAY_ORDER.map((d) => [d, { enabled: false, startTime: "09:00", endTime: "18:00" }]));
}

