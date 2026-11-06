import { AlertCircle, Ban, Check, Clock, Pencil, type LucideIcon } from 'lucide-react';

export type StatusTone = 'danger' | 'warn' | 'good' | 'info' | 'neutral';

const ICON: Record<StatusTone, LucideIcon> = {
  danger: AlertCircle,
  warn: Clock,
  good: Check,
  info: Clock,
  neutral: Pencil,
};

/**
 * A document's status as one word, an icon and a colour, so the status never
 * depends on colour alone. Crimson and amber are reserved for what needs action.
 */
export default function StatusPill({ tone, label, voided = false }: { tone: StatusTone; label: string; voided?: boolean }) {
  const Icon = voided ? Ban : ICON[tone];
  return (
    <span className={`status-pill status-pill--${tone}`}>
      <Icon size={14} aria-hidden="true" />
      {label}
    </span>
  );
}
