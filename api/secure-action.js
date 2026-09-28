// api/secure-action.js
// Deletes (soft, reversible), restores, and download/print authorization.
// Default-deny: only the user IDs in api/_lib/auth.js allowlists may act; every attempt is audited.

import { serviceClient, setCORS, requireUser, canDelete, canReport, audit, deny } from './_lib/auth.js';

// Tables with a status column record previous_status so a delete can be undone exactly.
const DELETE_TARGETS = {
  submission:   { table: 'lb_submissions',      hasStatus: true,  restoreDefault: 'live' },
  mapd:         { table: 'lb_mapd_submissions', hasStatus: true,  restoreDefault: 'live' },
  scorer:       { table: 'lb_scorer_results',   hasStatus: true,  restoreDefault: 'complete' },
  dialer_entry: { table: 'lb_dialer_activity',  hasStatus: false },
};

const DOWNLOAD_KINDS = ['performance_pdf', 'wow_report', 'eod_pdf', 'scorer_pdf', 'scorer_print'];

export default async function handler(req, res) {
  setCORS(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const supabase = serviceClient();
  const user = await requireUser(req, supabase);
  if (!user) return res.status(401).json({ error: 'Session expired' });

  const { action, target, id, kind, detail } = req.body || {};
  try {
    if (action === 'delete' || action === 'restore') {
      const spec = DELETE_TARGETS[target];
      if (!spec || !id) return res.status(400).json({ error: 'Invalid target' });
      if (!canDelete(user)) return deny(res, supabase, req, user, action, { target, id });
      return action === 'delete'
        ? await softDelete(req, res, supabase, user, spec, id)
        : await restore(req, res, supabase, user, spec, id);
    }
    if (action === 'download') {
      if (!DOWNLOAD_KINDS.includes(kind)) return res.status(400).json({ error: 'Invalid download' });
      if (!canReport(user)) return deny(res, supabase, req, user, 'export', { kind });
      if (!(await audit(supabase, req, { actor: user.id, action: 'export', detail: { kind, ...(detail || {}) } }))) {
        return res.status(500).json({ error: 'Could not record this action; try again.' });
      }
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('secure-action error', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

async function softDelete(req, res, supabase, user, spec, id) {
  const cols = spec.hasStatus ? 'id,status,deleted_at' : 'id,deleted_at';
  const { data: row, error } = await supabase.from(spec.table).select(cols).eq('id', id).single();
  if (error || !row) return res.status(404).json({ error: 'Not found' });
  if (row.deleted_at || (spec.hasStatus && row.status === 'deleted')) return res.status(200).json({ ok: true, alreadyDeleted: true });

  const previous = spec.hasStatus ? row.status : null;
  // Audit first: if the log can't be written, the delete doesn't happen.
  if (!(await audit(supabase, req, { actor: user.id, action: 'delete', table: spec.table, target: id, detail: { previous_status: previous } }))) {
    return res.status(500).json({ error: 'Could not record this action; nothing was deleted.' });
  }
  const patch = { deleted_at: new Date().toISOString(), deleted_by: user.id };
  if (spec.hasStatus) Object.assign(patch, { status: 'deleted', previous_status: previous });
  let q = supabase.from(spec.table).update(patch).eq('id', id).is('deleted_at', null);
  if (spec.hasStatus) q = q.eq('status', previous);
  const { error: upErr } = await q;
  if (upErr) return res.status(500).json({ error: 'Delete failed: ' + upErr.message });
  return res.status(200).json({ ok: true });
}

async function restore(req, res, supabase, user, spec, id) {
  const cols = spec.hasStatus ? 'id,status,previous_status,deleted_at' : 'id,deleted_at';
  const { data: row, error } = await supabase.from(spec.table).select(cols).eq('id', id).single();
  if (error || !row) return res.status(404).json({ error: 'Not found' });
  const isDeleted = row.deleted_at || (spec.hasStatus && row.status === 'deleted');
  if (!isDeleted) return res.status(200).json({ ok: true, notDeleted: true });

  // Rows soft-deleted before previous_status existed fall back to the table's normal status.
  const toStatus = spec.hasStatus ? (row.previous_status || spec.restoreDefault) : null;
  if (!(await audit(supabase, req, { actor: user.id, action: 'restore', table: spec.table, target: id, detail: { to_status: toStatus } }))) {
    return res.status(500).json({ error: 'Could not record this action; nothing was restored.' });
  }
  const patch = { deleted_at: null, deleted_by: null };
  if (spec.hasStatus) Object.assign(patch, { status: toStatus, previous_status: null });
  const { error: upErr } = await supabase.from(spec.table).update(patch).eq('id', id);
  if (upErr) return res.status(500).json({ error: 'Restore failed: ' + upErr.message });
  return res.status(200).json({ ok: true });
}
