import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, CheckCircle2, Clock } from 'lucide-react';

const MARK = { danger: AlertCircle, warn: Clock, good: CheckCircle2 } as const;

export interface AlertProps {
  tone: 'danger' | 'warn' | 'good';
  title: ReactNode;
  children?: ReactNode;
  action?: { label: string; to: string };
  /** A live region only where the page needs one; most alerts are static content. */
  role?: 'status' | 'alert';
}

/**
 * The one banner for something that needs attention. Danger pulses gently until
 * it is dealt with, warning holds still, success pops in once.
 */
export default function Alert({ tone, title, children, action, role }: AlertProps) {
  const Icon = MARK[tone];
  return (
    <div className={`alert alert--${tone}`} {...(role !== undefined ? { role } : {})}>
      <span className="alert__mark" aria-hidden="true">
        <Icon size={20} />
      </span>
      <div className="min-w-0 flex-[1_1_11rem]">
        <p className="m-0 font-semibold">{title}</p>
        {children !== undefined && <div className="text-sm mt-0.5">{children}</div>}
      </div>
      {action !== undefined && (
        <Link to={action.to} className="alert__action">
          {action.label}
        </Link>
      )}
    </div>
  );
}
