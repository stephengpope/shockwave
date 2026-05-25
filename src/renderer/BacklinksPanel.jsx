import React from 'react';
import { prettyName } from './linkIndex.js';

export default function BacklinksPanel({ groups, vaultPath, onOpen }) {
  return (
    <div className="backlinks-section">
      <div className="backlinks-header">
        Linked references ({groups.length})
      </div>
      {groups.length === 0 ? (
        <div className="backlinks-empty">No backlinks yet</div>
      ) : (
        groups.map((group) => (
          <div key={group.fromPath} className="backlinks-group">
            <div
              className="backlinks-source"
              onClick={() => onOpen(group.fromPath)}
            >
              {prettyName(group.fromPath, vaultPath)}
            </div>
            {group.matches.map((match, i) => (
              <div
                key={`${match.lineNumber}-${i}`}
                className="backlinks-match"
                onClick={() => onOpen(group.fromPath)}
              >
                <div className="backlinks-line">{match.lineText.trim()}</div>
                {match.contextLines.length > 0 && (
                  <pre className="backlinks-context">
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
