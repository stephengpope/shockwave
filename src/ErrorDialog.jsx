import React from 'react';
import Dialog from './Dialog.jsx';

// Single-button error dialog. The `message` prop is the body — pass a string
// or any JSX. The title defaults to "Something went wrong".
export default function ErrorDialog({ open, onClose, title = 'Something went wrong', message }) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <button className="dialog-button dialog-button-primary" onClick={onClose}>
          OK
        </button>
      }
    >
      {message}
    </Dialog>
  );
}
