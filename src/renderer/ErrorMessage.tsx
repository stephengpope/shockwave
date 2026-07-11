import React from 'react';
import { CircleAlert } from 'lucide-react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

// Reusable error banner. Pure presentational — positioning (margins,
// max-width) is owned by the caller via `className`.
//
// Usage:
//   <ErrorMessage className="error-message-title">Something went wrong</ErrorMessage>
export default function ErrorMessage({ children, className = '' }: any) {
  return (
    <Alert variant="destructive" className={cn('error-message', className)}>
      <CircleAlert />
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}
