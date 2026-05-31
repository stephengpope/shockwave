import React from 'react';
import Dialog from './Dialog.jsx';

// Two-button confirm dialog. `onConfirm` fires when the user clicks the
// primary button; the caller is responsible for closing the dialog (usually
// by also calling its setter to null/false). `onClose` fires on Cancel,
// backdrop click, or Esc.
//
// Set `destructive` to true when the action is irreversible — the primary
// button is styled red instead of accent.
export default function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button className="dialog-button" onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            className={`dialog-button ${destructive ? 'dialog-button-destructive' : 'dialog-button-primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      {message}
    </Dialog>
  );
}
