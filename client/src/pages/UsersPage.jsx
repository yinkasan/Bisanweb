import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useAuth } from '../context/AuthContext.jsx';
import {
  Alert, Badge, Button, Card, ErrorText, Field, Input, Modal, PageHeader, Select, Spinner, Table,
} from '../components/ui.jsx';
import { date, dateTime } from '../utils/format.js';

const emptyCreate = {
  username: '', fullName: '', email: '', phone: '', password: '',
  roleKey: '', allDepots: false, depotIds: [],
};

const ACTIONS = [
  ['view', 'View'],
  ['input', 'Input'],
  ['edit', 'Edit'],
  ['viewHistory', 'History'],
  ['export', 'Export'],
  ['approve', 'Approve'],
];

/** Checkbox grid over the page catalogue (SRS §4.1). */
function PermissionsEditor({ catalog, grants, onChange, disabled }) {
  return (
    <Table
      columns={[
        { key: 'page_name', label: 'Page' },
        { key: 'section', label: 'Section', render: (r) => <span className="text-slate-400">{r.section}</span> },
        ...ACTIONS.map(([key, colLabel]) => ({
          key,
          label: colLabel,
          render: (r) => (
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300"
              checked={Boolean(grants[r.page_key]?.[key])}
              disabled={disabled}
              onChange={(e) => onChange(r.page_key, { ...(grants[r.page_key] ?? {}), [key]: e.target.checked })}
            />
          ),
        })),
      ]}
      rows={catalog}
      rowKey={(r) => r.page_key}
      empty="No page catalogue available"
    />
  );
}

/** Full user administration in one modal: profile, role, depots, permissions. */
function ManageModal({ userId, meId, roles, depots, canEdit, canPerms, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);
  const [saving, setSaving] = useState('');
  const [profile, setProfile] = useState(null);
  const [roleForm, setRoleForm] = useState({ roleKey: '', reason: '' });
  const [depotForm, setDepotForm] = useState({ allDepots: false, depotIds: [] });
  const [grants, setGrants] = useState({});

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await api.get(`/users/${userId}`);
      setDetail(d);
      setProfile({
        fullName: d.user.full_name ?? '',
        email: d.user.email ?? '',
        phone: d.user.phone ?? '',
        isActive: d.user.is_active,
        allDepots: d.user.all_depots,
      });
      setRoleForm({ roleKey: d.user.role_key, reason: '' });
      setDepotForm({ allDepots: d.user.all_depots, depotIds: d.depots.map((x) => x.id) });
      const g = {};
      for (const p of d.permissions) {
        g[p.page_key] = {
          view: p.can_view,
          input: p.can_input,
          edit: p.can_edit,
          viewHistory: p.can_view_history,
          export: p.can_export,
          approve: p.can_approve,
        };
      }
      setGrants(g);
      if (canPerms) {
        try {
          const c = await api.get('/roles/permissions');
          setCatalog(c.permissions);
        } catch {
          setCatalog([]);
        }
      }
    } catch (err) {
      setError(err);
    }
  }, [userId, canPerms]);

  useEffect(() => { load(); }, [load]);

  const runSave = async (key, fn, successText) => {
    setSaving(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ kind: 'success', text: successText });
      await load();
      onChanged();
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    } finally {
      setSaving('');
    }
  };

  const isSelf = detail?.user?.id === meId;

  return (
    <Modal
      open
      wide
      title={detail ? `${detail.user.full_name} (@${detail.user.username})` : `User #${userId}`}
      onClose={onClose}
    >
      <ErrorText error={error} />
      {msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : null}
      {!detail || !profile ? <Spinner /> : (
        <div className="space-y-4">
          {isSelf ? <Alert kind="info">This is your own account — changes to your role or permissions refresh the menu immediately.</Alert> : null}

          <Card title="Profile">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Full name" required>
                <Input value={profile.fullName} onChange={(e) => setProfile((f) => ({ ...f, fullName: e.target.value }))} disabled={!canEdit} />
              </Field>
              <Field label="Email">
                <Input value={profile.email} onChange={(e) => setProfile((f) => ({ ...f, email: e.target.value }))} disabled={!canEdit} />
              </Field>
              <Field label="Phone">
                <Input value={profile.phone} onChange={(e) => setProfile((f) => ({ ...f, phone: e.target.value }))} disabled={!canEdit} />
              </Field>
              <div className="flex flex-col justify-end gap-1 pb-1">
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300"
                    checked={profile.isActive}
                    disabled={!canEdit || isSelf}
                    onChange={(e) => setProfile((f) => ({ ...f, isActive: e.target.checked }))}
                  />
                  Active account
                </label>
                <label className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300"
                    checked={profile.allDepots}
                    disabled={!canEdit}
                    onChange={(e) => setProfile((f) => ({ ...f, allDepots: e.target.checked }))}
                  />
                  All depots (current and future)
                </label>
              </div>
            </div>
            {canEdit ? (
              <div className="mt-3 flex justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={saving === 'profile' || !profile.fullName.trim()}
                  onClick={() => runSave('profile', () => api.put(`/users/${userId}`, profile), 'Profile saved.')}
                >
                  {saving === 'profile' ? 'Saving…' : 'Save profile'}
                </Button>
              </div>
            ) : null}
          </Card>

          <Card title="Role">
            <div className="flex flex-wrap items-end gap-3">
              <Field label="Role">
                <Select
                  value={roleForm.roleKey}
                  disabled={!canEdit}
                  onChange={(e) => setRoleForm((f) => ({ ...f, roleKey: e.target.value }))}
                  options={roles.map((r) => ({ value: r.key, label: `${r.name} (level ${r.level})` }))}
                />
              </Field>
              <div className="min-w-[220px] flex-1">
                <Field label="Reason" hint="Stored in the role-change log">
                  <Input
                    value={roleForm.reason}
                    disabled={!canEdit}
                    onChange={(e) => setRoleForm((f) => ({ ...f, reason: e.target.value }))}
                    maxLength={500}
                  />
                </Field>
              </div>
              {canEdit ? (
                <Button
                  variant="primary"
                  size="sm"
                  disabled={saving === 'role' || roleForm.roleKey === detail.user.role_key}
                  onClick={() => runSave('role', () => api.put(`/users/${userId}/role`, roleForm), 'Role updated — recorded in the role history.')}
                >
                  {saving === 'role' ? 'Saving…' : 'Change role'}
                </Button>
              ) : null}
            </div>
            {detail.roleHistory?.length ? (
              <div className="mt-3 space-y-1 border-t border-slate-100 pt-3">
                <h4 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Role history</h4>
                {detail.roleHistory.map((h) => (
                  <p key={h.id} className="text-xs text-slate-500">
                    {dateTime(h.created_at)} — {h.old_role ?? '—'} → <strong>{h.new_role ?? '—'}</strong>
                    {h.changed_by_name ? ` by ${h.changed_by_name}` : ''}
                    {h.reason ? ` · ${h.reason}` : ''}
                  </p>
                ))}
              </div>
            ) : null}
          </Card>

          <Card title="Depot assignments (SRS §4.2)">
            <label className="mb-2 flex items-center gap-2 text-sm text-slate-600">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300"
                checked={depotForm.allDepots}
                disabled={!canEdit}
                onChange={(e) => setDepotForm((f) => ({ ...f, allDepots: e.target.checked }))}
              />
              Access to all depots
            </label>
            <div className={`grid grid-cols-1 gap-1 sm:grid-cols-2 ${depotForm.allDepots ? 'opacity-40' : ''}`}>
              {depots.map((d) => (
                <label key={d.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm text-slate-600 hover:bg-slate-50">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300"
                    disabled={!canEdit || depotForm.allDepots}
                    checked={depotForm.depotIds.includes(d.id)}
                    onChange={(e) => setDepotForm((f) => ({
                      ...f,
                      depotIds: e.target.checked
                        ? [...f.depotIds, d.id]
                        : f.depotIds.filter((x) => x !== d.id),
                    }))}
                  />
                  {d.code} — {d.name}
                </label>
              ))}
            </div>
            {canEdit ? (
              <div className="mt-3 flex justify-end">
                <Button
                  variant="primary"
                  size="sm"
                  disabled={saving === 'depots' || (!depotForm.allDepots && depotForm.depotIds.length === 0)}
                  onClick={() => runSave('depots', () => api.put(`/users/${userId}/depots`, depotForm), 'Depot access saved.')}
                >
                  {saving === 'depots' ? 'Saving…' : 'Save depot access'}
                </Button>
              </div>
            ) : null}
          </Card>

          {canPerms ? (
            <Card title="Page permissions (SRS §4.1)">
              <PermissionsEditor
                catalog={catalog}
                grants={grants}
                disabled={saving === 'perms'}
                onChange={(pageKey, next) => setGrants((g) => ({ ...g, [pageKey]: next }))}
              />
              <div className="mt-3 flex items-center justify-between">
                <p className="text-[11px] text-slate-400">
                  Unticking every action on a page removes the grant entirely. Super Admins always have full access.
                </p>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={saving === 'perms'}
                  onClick={() => runSave(
                    'perms',
                    () => api.put(`/users/${userId}/permissions`, {
                      grants: catalog.map((p) => ({ pageKey: p.page_key, ...(grants[p.page_key] ?? {}) })),
                    }),
                    'Permissions saved — the user sees the change on their next request.'
                  )}
                >
                  {saving === 'perms' ? 'Saving…' : 'Save permissions'}
                </Button>
              </div>
            </Card>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/**
 * User administration — accounts, roles, depot assignments and the page-level
 * permission matrix (SRS §4). All writes are audit-logged server-side.
 */
export default function UsersPage() {
  const { user: me, can, refresh } = useAuth();
  const canInput = can('users', 'input');
  const canEdit = can('users', 'edit');
  const canPerms = can('roles_permissions', 'edit');

  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [depots, setDepots] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreate);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(null);

  const [manageId, setManageId] = useState(null);

  const [resetUser, setResetUser] = useState(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [u, r, d] = await Promise.all([
        api.get('/users'),
        api.get('/roles'),
        api.get('/depots/all').catch(() => api.get('/depots')),
      ]);
      setUsers(u.users);
      setRoles(r.roles);
      setDepots(d.depots);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onChanged = useCallback(async () => {
    await load();
    await refresh();
  }, [load, refresh]);

  const openCreate = () => {
    setCreateForm({ ...emptyCreate, roleKey: roles[0]?.key ?? '' });
    setCreateError(null);
    setCreateOpen(true);
  };

  const submitCreate = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      await api.post('/users', {
        username: createForm.username,
        fullName: createForm.fullName,
        email: createForm.email,
        phone: createForm.phone,
        password: createForm.password,
        roleKey: createForm.roleKey,
        allDepots: createForm.allDepots,
        depotIds: createForm.depotIds.map(Number),
      });
      setCreateOpen(false);
      await load();
    } catch (err) {
      setCreateError(err);
    } finally {
      setCreating(false);
    }
  };

  const submitReset = async () => {
    setResetting(true);
    setResetError(null);
    try {
      await api.post(`/users/${resetUser.id}/reset-password`, { newPassword });
      setResetUser(null);
      setNewPassword('');
    } catch (err) {
      setResetError(err);
    } finally {
      setResetting(false);
    }
  };

  const canCreate = createForm.username.trim()
    && createForm.fullName.trim()
    && createForm.password.length >= 8
    && createForm.roleKey
    && (createForm.allDepots || createForm.depotIds.length > 0);

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Accounts, roles, depot access and page-level permissions. Nobody can grant themselves more access."
        actions={canInput ? <Button variant="primary" onClick={openCreate}>+ New User</Button> : null}
      />

      <ErrorText error={error} />

      <Card title={`${users.length} user${users.length === 1 ? '' : 's'}`}>
        {loading && users.length === 0 ? <Spinner /> : (
          <Table
            columns={[
              {
                key: 'full_name',
                label: 'User',
                render: (r) => (
                  <span>
                    {r.full_name}
                    {r.id === me?.id ? <span className="ml-1 text-[10px] font-semibold uppercase text-indigo-500">you</span> : null}
                    <span className="block text-xs text-slate-400">@{r.username}</span>
                  </span>
                ),
              },
              { key: 'role_name', label: 'Role' },
              {
                key: 'depots',
                label: 'Depot Access',
                render: (r) => (r.all_depots ? 'All depots' : `${r.depot_count} depot${r.depot_count === 1 ? '' : 's'}`),
              },
              { key: 'is_active', label: 'Status', render: (r) => <Badge value={r.is_active ? 'active' : 'inactive'} /> },
              { key: 'last_login_at', label: 'Last Login', render: (r) => (r.last_login_at ? dateTime(r.last_login_at) : 'Never') },
              { key: 'created_at', label: 'Created', render: (r) => date(r.created_at) },
              {
                key: 'actions',
                label: '',
                render: (r) => (
                  <span className="flex justify-end gap-1">
                    <Button size="sm" onClick={() => setManageId(r.id)}>Manage</Button>
                    {canEdit ? (
                      <Button size="sm" variant="ghost" onClick={() => { setResetUser(r); setNewPassword(''); setResetError(null); }}>
                        Reset password
                      </Button>
                    ) : null}
                  </span>
                ),
              },
            ]}
            rows={users}
            rowKey={(r) => r.id}
            empty="No users found"
          />
        )}
      </Card>

      {manageId ? (
        <ManageModal
          userId={manageId}
          meId={me?.id}
          roles={roles}
          depots={depots}
          canEdit={canEdit}
          canPerms={canPerms}
          onClose={() => setManageId(null)}
          onChanged={onChanged}
        />
      ) : null}

      {/* Create user */}
      <Modal
        open={createOpen}
        title="New User"
        onClose={() => setCreateOpen(false)}
        footer={
          <>
            <Button onClick={() => setCreateOpen(false)} disabled={creating}>Cancel</Button>
            <Button variant="primary" onClick={submitCreate} disabled={creating || !canCreate}>
              {creating ? 'Creating…' : 'Create User'}
            </Button>
          </>
        }
      >
        {createError ? <Alert kind="error">{createError.message}</Alert> : null}
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Username" required>
              <Input value={createForm.username} onChange={(e) => setCreateForm((f) => ({ ...f, username: e.target.value }))} maxLength={60} />
            </Field>
            <Field label="Full name" required>
              <Input value={createForm.fullName} onChange={(e) => setCreateForm((f) => ({ ...f, fullName: e.target.value }))} maxLength={120} />
            </Field>
            <Field label="Email">
              <Input value={createForm.email} onChange={(e) => setCreateForm((f) => ({ ...f, email: e.target.value }))} maxLength={160} />
            </Field>
            <Field label="Phone">
              <Input value={createForm.phone} onChange={(e) => setCreateForm((f) => ({ ...f, phone: e.target.value }))} maxLength={40} />
            </Field>
            <Field label="Password" required hint="Minimum 8 characters">
              <Input type="password" value={createForm.password} onChange={(e) => setCreateForm((f) => ({ ...f, password: e.target.value }))} />
            </Field>
            <Field label="Role" required>
              <Select
                value={createForm.roleKey}
                onChange={(e) => setCreateForm((f) => ({ ...f, roleKey: e.target.value }))}
                options={roles.map((r) => ({ value: r.key, label: `${r.name} (level ${r.level})` }))}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-slate-300"
              checked={createForm.allDepots}
              onChange={(e) => setCreateForm((f) => ({ ...f, allDepots: e.target.checked }))}
            />
            Access to all depots (current and future)
          </label>
          <div className={`grid grid-cols-1 gap-1 sm:grid-cols-2 ${createForm.allDepots ? 'opacity-40' : ''}`}>
            {depots.map((d) => (
              <label key={d.id} className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm text-slate-600 hover:bg-slate-50">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300"
                  disabled={createForm.allDepots}
                  checked={createForm.depotIds.includes(d.id)}
                  onChange={(e) => setCreateForm((f) => ({
                    ...f,
                    depotIds: e.target.checked
                      ? [...f.depotIds, d.id]
                      : f.depotIds.filter((x) => x !== d.id),
                  }))}
                />
                {d.code} — {d.name}
              </label>
            ))}
          </div>
          <p className="text-[11px] text-slate-400">
            New users start with no page permissions — grant them on this page after creating the account.
          </p>
        </div>
      </Modal>

      {/* Reset password */}
      <Modal
        open={!!resetUser}
        title={`Reset password — ${resetUser?.full_name ?? ''}`}
        onClose={() => setResetUser(null)}
        footer={
          <>
            <Button onClick={() => setResetUser(null)} disabled={resetting}>Cancel</Button>
            <Button variant="danger" onClick={submitReset} disabled={resetting || newPassword.length < 8}>
              {resetting ? 'Resetting…' : 'Reset Password'}
            </Button>
          </>
        }
      >
        {resetError ? <Alert kind="error">{resetError.message}</Alert> : null}
        <div className="space-y-3">
          <Alert kind="warning">
            The new password takes effect immediately. This action is recorded in the audit trail.
          </Alert>
          <Field label="New password" required hint="Minimum 8 characters">
            <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </>
  );
}
