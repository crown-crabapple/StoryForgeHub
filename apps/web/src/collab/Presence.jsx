import { useEffect, useState } from 'react';
import { sendRequest } from '../continuity/requests.js';
import { HEARTBEAT_MS, alsoHereText, presenceRequest } from './model.js';

/**
 * Advisory presence (M07-J03b): while `enabled`, tell the server every 20 seconds that this person has the scene open, and return who else does.
 * It only informs: a failed or slow heartbeat changes nothing, and nothing waits for it.
 * @param {{ bookId: string, sceneId: string, enabled: boolean }} p
 * @returns {{ name: string, id: string }[]}
 */
export function usePresence({ bookId, sceneId, enabled }) {
  const [others, setOthers] = useState(/** @type {{ name: string, id: string }[]} */ ([]));
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    const beat = async () => {
      const { status, json } = await sendRequest(presenceRequest(bookId, sceneId));
      if (live && status === 200 && Array.isArray(json?.users)) setOthers(json.users.map((u) => ({ id: String(u.id), name: String(u.name) })));
    };
    void beat();
    const timer = setInterval(() => void beat(), HEARTBEAT_MS);
    return () => {
      live = false;
      clearInterval(timer);
      void sendRequest(presenceRequest(bookId, null)); // closed: the others stop seeing us at once
    };
  }, [bookId, sceneId, enabled]);
  return others;
}

/** "Ilse is also in this scene". Nothing is drawn when nobody else is here. @param {{ users: { name: string }[] }} props */
export function PresenceNote({ users }) {
  const text = alsoHereText(users);
  if (text === '') return null;
  return (
    <p className="editor-presence muted" role="status">
      {text}. You can both keep writing: if you save over each other, both versions are kept.
    </p>
  );
}
