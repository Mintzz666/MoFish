-- Follow-up to the first actual Supabase deployment. Do not rewrite the initial SQL.
-- The optional platform event-trigger helper is internal, not a client RPC.
-- Its owner and event-trigger registration stay intact.
do $hardening$
begin
  if exists (
    select 1 from pg_proc p
    where p.oid = to_regprocedure('public.rls_auto_enable()')
      and p.prorettype = 'event_trigger'::regtype
  ) then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $hardening$;

-- Evaluate the request's identity once, while retaining exactly the same owner filter.
alter policy aquariums_select_own on public.aquariums
  using (owner_id = (select auth.uid()));
