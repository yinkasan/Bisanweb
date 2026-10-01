import { Fragment, useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { Alert, Button, Card, ErrorText, PageHeader, Spinner } from '../components/ui.jsx';

/**
 * Roles & Permissions — the Super Admin control centre for each category of
 * user (roles):
 *
 *   * Activate/deactivate every page (View) and its actions.
 *   * Activate/deactivate every component of a page (cards, tables, buttons)
 *     for visibility, and — for input components — whether input is allowed.
 *
 * Enforcement is server-side (accessService + edge functions merge the role
 * grants with per-user grants); this page only edits the configuration.
 */

const ACTIONS = [
  ['view', 'View'],
  ['input', 'Input'],
  ['edit', 'Edit'],
  ['viewHistory', 'History'],
  ['export', 'Export'],
  ['approve', 'Approve'],
];

const NO_FLAGS = {
  view: false, input: false, edit: false, viewHistory: false, export: false, approve: false,
};

const DEFAULT_COMP = { visible: true, input: true };

export default function RolesPage() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [saving, setSaving] = useState(false);
  const [roleId, setRoleId] = useState(null);
  const [expanded, setExpanded] = useState('');

  // Editable drafts for the selected role.
  const [pageDraft, setPageDraft] = useState({});
  const [compDraft, setCompDraft] = useState({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.get('/roles/access');
      setData(result);
      return result;
    } catch (err) {
      setError(err);
      return null;
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // (Re)build the drafts whenever the payload or the selected role changes.
  useEffect(() => {
    if (!data) return;
    const role = data.roles.find((r) => r.id === roleId) ?? data.roles[0];
    if (!role) return;
    if (role.id !== roleId) setRoleId(role.id);

    const pages = {};
    for (const p of data.pages) pages[p.page_key] = { ...NO_FLAGS };
    for (const grant of data.rolePermissions) {
      if (grant.role_id !== role.id) continue;
      pages[grant.page_key] = {
        view: grant.can_view,
        input: grant.can_input,
        edit: grant.can_edit,
        viewHistory: grant.can_view_history,
        export: grant.can_export,
        approve: grant.can_approve,
      };
    }
    const comps = {};
    for (const c of data.components) {
      if (c.role_id !== role.id) continue;
      comps[`${c.page_key}:${c.component_key}`] = { visible: c.is_visible, input: c.can_input };
    }
    setPageDraft(pages);
    setCompDraft(comps);
    setSaveError(null);
    setSavedAt(null);
    setExpanded('');
  }, [data, roleId]);

  const role = data?.roles.find((r) => r.id === roleId);

  const setFlag = (pageKey, action) => {
    setPageDraft((prev) => ({
      ...prev,
      [pageKey]: { ...prev[pageKey], [action]: !prev[pageKey][action] },
    }));
    setSavedAt(null);
  };

  const setComp = (pageKey, componentKey, field) => {
    const id = `${pageKey}:${componentKey}`;
    setCompDraft((prev) => {
      const cur = prev[id] ?? DEFAULT_COMP;
      return { ...prev, [id]: { ...cur, [field]: !cur[field] } };
    });
    setSavedAt(null);
  };

  const save = async () => {
    if (!role) return;
    setSaving(true);
    setSaveError(null);
    try {
      const pages = data.pages
        .map((p) => ({ pageKey: p.page_key, ...pageDraft[p.page_key] }))
        .filter((p) => ACTIONS.some(([a]) => p[a]));
      const components = [];
      for (const p of data.pages) {
        if (!pageDraft[p.page_key]?.view) continue; // inactive page → nothing to configure
        for (const c of data.componentCatalog[p.page_key] ?? []) {
          const cur = compDraft[`${p.page_key}:${c.key}`] ?? DEFAULT_COMP;
          if (!cur.visible || !cur.input) {
            components.push({ pageKey: p.page_key, componentKey: c.key, visible: cur.visible, input: cur.input });
          }
        }
      }
      await api.put(`/roles/${role.id}/access`, { pages, components });
      await load();
      setSavedAt(new Date());
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Roles & Permissions"
        subtitle="Activate pages and every component for each category of user — enforced on the server and on mobile."
      />

      <ErrorText error={error} />

      {!data ? (error ? null : <Spinner />) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {data.roles.map((r) => (
              <button
                key={r.id}
                type="button"
                onClick={() => setRoleId(r.id)}
                className={`rounded-full border px-3 py-1.5 text-sm font-medium transition ${
                  r.id === roleId
                    ? 'border-indigo-600 bg-indigo-600 text-white'
                    : 'border-slate-300 bg-white text-slate-600 hover:border-indigo-300'
                }`}
              >
                {r.name} <span className="opacity-70">· {r.user_count} user{r.user_count === 1 ? '' : 's'}</span>
              </button>
            ))}
          </div>

          {role?.key === 'super_admin' ? (
            <Alert kind="info">
              The Super Admin bypasses every check — all pages and components are always active for this category.
            </Alert>
          ) : null}

          <Card title={`Pages & components — ${role?.name ?? ''}`}>
            {saveError ? <Alert kind="error">{saveError.message}</Alert> : null}
            {savedAt ? (
              <Alert kind="success">
                Saved. Users of "{role?.name}" see the new access on their next request (web and mobile).
              </Alert>
            ) : null}

            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="py-2 pr-3 font-medium">Page</th>
                    {ACTIONS.map(([a, label]) => (
                      <th key={a} className="px-2 py-2 text-center font-medium">{label}</th>
                    ))}
                    <th className="px-2 py-2 text-center font-medium">Components</th>
                  </tr>
                </thead>
                <tbody>
                  {data.pages.map((p) => {
                    const flags = pageDraft[p.page_key] ?? NO_FLAGS;
                    const comps = data.componentCatalog[p.page_key] ?? [];
                    const open = expanded === p.page_key;
                    return (
                      <Fragment key={p.page_key}>
                        <tr className={`border-b border-slate-100 ${flags.view ? 'bg-white' : 'bg-slate-50/50'}`}>
                          <td className="py-2 pr-3">
                            <span className="font-medium text-slate-800">{p.page_name}</span>
                            <span className="block text-[11px] text-slate-400">{p.section} · {p.page_key}</span>
                          </td>
                          {ACTIONS.map(([a]) => (
                            <td key={a} className="px-2 py-2 text-center">
                              <input
                                type="checkbox"
                                className="h-4 w-4 rounded border-slate-300 accent-indigo-600"
                                checked={Boolean(flags[a])}
                                onChange={() => setFlag(p.page_key, a)}
                              />
                            </td>
                          ))}
                          <td className="px-2 py-2 text-center">
                            {comps.length ? (
                              <button
                                type="button"
                                className="text-xs font-medium text-indigo-600 hover:underline"
                                onClick={() => setExpanded(open ? '' : p.page_key)}
                              >
                                {open ? 'Hide' : `Configure (${comps.length})`}
                              </button>
                            ) : (
                              <span className="text-xs text-slate-300">—</span>
                            )}
                          </td>
                        </tr>
                        {open ? (
                          <tr className="border-b border-slate-100 bg-slate-50/60">
                            <td colSpan={ACTIONS.length + 2} className="px-3 py-3">
                              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                {comps.map((c) => {
                                  const cur = compDraft[`${p.page_key}:${c.key}`] ?? DEFAULT_COMP;
                                  return (
                                    <div
                                      key={c.key}
                                      className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs"
                                    >
                                      <span className="text-slate-600">{c.label}</span>
                                      <span className="flex shrink-0 items-center gap-3">
                                        <label className="flex items-center gap-1">
                                          <input
                                            type="checkbox"
                                            className="h-3.5 w-3.5 accent-indigo-600"
                                            checked={cur.visible}
                                            onChange={() => setComp(p.page_key, c.key, 'visible')}
                                          />
                                          Visible
                                        </label>
                                        {c.input ? (
                                          <label className={`flex items-center gap-1 ${cur.visible ? '' : 'opacity-40'}`}>
                                            <input
                                              type="checkbox"
                                              className="h-3.5 w-3.5 accent-indigo-600"
                                              checked={cur.input}
                                              onChange={() => setComp(p.page_key, c.key, 'input')}
                                            />
                                            Input
                                          </label>
                                        ) : null}
                                      </span>
                                    </div>
                                  );
                                })}
                              </div>
                              <p className="mt-2 text-[11px] text-slate-400">
                                "Visible" switched off removes the component from the page for this category.
                                "Input" switched off keeps an input component visible but disabled.
                              </p>
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-end gap-3">
              <span className="text-xs text-slate-400">
                Save applies to every user of this category · per-user grants are set on the Users page.
              </span>
              <Button
                variant="primary"
                onClick={save}
                disabled={saving || role?.key === 'super_admin'}
              >
                {saving ? 'Saving…' : 'Save access'}
              </Button>
            </div>
          </Card>

          <Alert kind="info">
            <strong>Actions:</strong> View opens a page · Input creates new records · Edit corrects and updates
            existing records · History reveals full transaction/audit histories · Export downloads CSV · Approve is
            reserved for approval flows. Page actions and component switches are merged with per-user grants — the
            server re-checks everything on every request.
          </Alert>
        </div>
      )}
    </>
  );
}
