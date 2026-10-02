import type { SessionState } from '@msout-poc/shared';
import type { NotebookRef } from '@msout-poc/shared';

/**
 * Block 2: the notebook list.
 *
 * Disabled until the session is authenticated - not merely greyed out, but
 * actually inert, because "disabled" as a visual state with a live click handler
 * behind it is how a user ends up triggering a 409 they cannot explain.
 */
export function NotebooksBlock({
  state,
  onList,
  onSelect,
  selected,
}: {
  state: SessionState;
  onList: () => Promise<void>;
  onSelect: (notebook: NotebookRef) => void;
  selected: NotebookRef | null;
}) {
  const authed = state.auth.state === 'valid';
  const listing = state.notebooks.state === 'listing';
  const loaded = state.notebooks.state === 'loaded';

  return (
    <section className="card">
      <h2>Your notebooks</h2>

      {!authed && <p className="muted">Sign in above to list your notebooks.</p>}

      {authed && !loaded && !listing && (
        <button type="button" className="primary" onClick={onList}>
          List notebooks
        </button>
      )}

      {listing && <p className="muted">Reading your notebook list…</p>}

      {state.notebooks.error === 'no_notebooks' && (
        <p className="alert">No notebooks were found on this account.</p>
      )}
      {state.notebooks.error === 'no_auth' && (
        <p className="alert">Your Microsoft session is no longer valid. Sign in again.</p>
      )}

      {loaded && state.notebooks.items.length === 0 && (
        <p className="muted">No notebooks. You can still paste a notebook URL below.</p>
      )}

      {loaded && state.notebooks.items.length > 0 && (
        <ul className="notebooks">
          {state.notebooks.items.map((notebook) => (
            <li key={notebook.url ?? notebook.name}>
              <button
                type="button"
                className={selected?.name === notebook.name ? 'notebook selected' : 'notebook'}
                onClick={() => onSelect(notebook)}
              >
                {/* Rendered as text. A notebook name comes from OneNote and is
                    never treated as markup. */}
                {notebook.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}