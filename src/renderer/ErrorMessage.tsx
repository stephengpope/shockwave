import React from 'react';

// Reusable red error banner with a little upward arrow. Pure presentational —
// positioning (margins, max-width) is owned by the caller via `className`.
//
// Usage:
//   <ErrorMessage className="error-message-title">Something went wrong</ErrorMessage>
export default function ErrorMessage({ children, className = '' }) {
  return (
    <div className={`error-message ${className}`.trim()} role="alert">
      {children}
    </div>
  );
}
