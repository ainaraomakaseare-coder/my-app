import { createClient } from 'npm:@supabase/supabase-js@2';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const reply = (status: number, message: string) => new Response(JSON.stringify({ message }), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (request.method !== 'POST') return reply(405, 'method_not_allowed');
  const authorization = request.headers.get('Authorization');
  if (!authorization?.startsWith('Bearer ')) return reply(401, 'sign_in_required');
  try {
    const body = await request.json();
    if (body.confirm !== 'DELETE') return reply(400, 'confirmation_required');
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await admin.auth.getUser(authorization.slice(7));
    if (error || !data.user) return reply(401, 'sign_in_required');
    // The target comes from the verified JWT; never accept a user id from the request.
    const userId = data.user.id;
    const begun = await admin.rpc('binder_begin_account_deletion', { p_user: userId });
    if (begun.error) return reply(500, 'deletion_start_failed');
    const paths: string[] = begun.data || [];
    for (let offset = 0; offset < paths.length; offset += 100) {
      const removed = await admin.storage.from('photos').remove(paths.slice(offset, offset + 100));
      if (removed.error) return reply(500, 'photo_cleanup_failed');
    }
    const finished = await admin.rpc('binder_finish_account_deletion', { p_user: userId });
    if (finished.error) return reply(500, 'deletion_finish_failed');
    const deleted = await admin.auth.admin.deleteUser(userId);
    if (deleted.error) return reply(500, 'account_deletion_failed');
    return reply(200, 'account_deleted');
  } catch { return reply(500, 'deletion_failed'); }
});
