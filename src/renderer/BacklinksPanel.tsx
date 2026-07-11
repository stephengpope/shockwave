import React from 'react';
import { prettyName } from './linkIndex.js';

export default function BacklinksPanel({ groups, vaultPath, onOpen }) {
  return (
    <div className="shrink-0 px-(--text-col-left) pb-[18px] pt-[5em]">
      <div className="mb-2 border-t border-border pt-2 text-[11px] font-semibold text-muted-foreground">
        Linked references ({groups.length})
      </div>
      {groups.length === 0 ? (
        <div className="text-[11px] text-muted-2">No backlinks yet</div>
      ) : (
        groups.map((group) => (
          <div key={group.fromPath} className="mb-3">
            <div
              className="mb-[3px] cursor-pointer text-xs font-semibold text-primary hover:underline"
              onClick={() => onOpen(group.fromPath)}
            >
              {prettyName(group.fromPath, vaultPath)}
            </div>
            {group.matches.map((match, i) => (
              <div
                key={`${match.lineNumber}-${i}`}
                className="mb-1 cursor-pointer border-l-2 border-border py-[3px] pl-2 hover:border-primary hover:bg-primary/5"
                onClick={() => onOpen(group.fromPath)}
              >
                <div className="whitespace-pre-wrap break-words text-xs text-foreground">{match.lineText.trim()}</div>
                {match.contextLines.length > 0 && (
                  <pre className="m-0 mt-[3px] whitespace-pre-wrap break-words pl-2 font-mono text-[11px] text-muted-foreground">
                    {match.contextLines.join('\n')}
                  </pre>
                )}
              </div>
            ))}
          </div>
        ))
      )}
    </div>
  );
}
