import React from 'react';
import { ArrowLeftIcon, ArrowRightIcon } from './Icons.jsx';

const navBtn =
  'flex size-[26px] items-center justify-center rounded-[7px] text-muted-foreground ' +
  'hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:text-muted-2/60';

export default function EditorNav({ onBack, onForward, canGoBack, canGoForward }) {
  return (
    <div className="flex gap-1 px-7 pt-3">
      <button
        type="button"
        className={navBtn}
        onClick={onBack}
        disabled={!canGoBack}
        title="Back"
        aria-label="Back"
      >
        <ArrowLeftIcon size={16} />
      </button>
      <button
        type="button"
        className={navBtn}
        onClick={onForward}
        disabled={!canGoForward}
        title="Forward"
        aria-label="Forward"
      >
        <ArrowRightIcon size={16} />
      </button>
    </div>
  );
}
