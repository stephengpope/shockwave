import React, { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';

// Modal for "Add external link" / "Edit external link".
//
// Add mode:  initialUrl / initialText omitted → only URL field, submits string.
// Edit mode: initialUrl + initialText provided → both fields, submits
//            { url, text }.
//
// The caller's onSubmit always receives an object so the call site can
// destructure cleanly; in Add mode `text` is undefined.
export default function UrlPromptModal({ onSubmit, onCancel, initialUrl, initialText }: any) {
  const isEdit = initialText !== undefined;
  const [url, setUrl] = useState(initialUrl ?? '');
  const [text, setText] = useState(initialText ?? '');
  const inputRef = useRef<any>(null);

  useEffect(() => {
    if (isEdit) {
      // Pre-fill from props; select the URL so users can quickly retype.
      requestAnimationFrame(() => inputRef.current?.select());
      return;
    }
    // Pre-fill from clipboard for the Add case — saves the user a paste.
    if (navigator.clipboard?.readText) {
      navigator.clipboard.readText().then((clip) => {
        const trimmed = (clip ?? '').trim();
        if (/^https?:\/\/\S+$/i.test(trimmed)) {
          setUrl(trimmed);
          requestAnimationFrame(() => inputRef.current?.select());
        }
      }).catch(() => { /* clipboard access denied — fine */ });
    }
  }, [isEdit]);

  const submit = (e) => {
    e.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;
    onSubmit({ url: trimmedUrl, text: isEdit ? text : undefined });
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit external link' : 'Add external link'}</DialogTitle>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          {isEdit && (
            <Field>
              <FieldLabel htmlFor="url-prompt-text">Link text</FieldLabel>
              <Input
                id="url-prompt-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          )}
          <Field>
            <FieldLabel htmlFor="url-prompt-input">External link URL</FieldLabel>
            <Input
              id="url-prompt-input"
              ref={inputRef}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://..."
              autoComplete="off"
              spellCheck={false}
              autoFocus
            />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
            <Button type="submit" disabled={!url.trim()}>
              {isEdit ? 'Save' : 'Add link'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
