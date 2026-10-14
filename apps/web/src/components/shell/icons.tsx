import {
  Bell, Bot, Building2, Clock, FileText, LayoutDashboard, LayoutGrid, Megaphone, MessageSquare,
  Phone, Settings, Tag, User, Users, Wrench, type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  dash: LayoutDashboard, msg: MessageSquare, bot: Bot, phone: Phone, teams: Users, user: User,
  mega: Megaphone, file: FileText, gear: Settings, org: Building2,
  wrench: Wrench, tag: Tag, grid: LayoutGrid, clock: Clock, bell: Bell,
};

export function Icon({ name, className }: { name: string; className?: string }) {
  const C = ICONS[name] ?? LayoutDashboard;
  return <C className={className} aria-hidden="true" strokeWidth={1.7} />;
}
