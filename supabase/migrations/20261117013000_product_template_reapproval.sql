begin;
-- Moving a template to a product must not carry its previous legal approval to
-- a new commercial binding. Keep the old immutable version, clear only the
-- current pointer, and require explicit approval of the newly authored draft.
-- This also provides a repair path for legacy unlinked approved templates whose
-- old instruction text correctly fails the new readiness guard.
do $$ declare original text; revised text;
begin
 select pg_get_functiondef('public.create_product_contract_template_version(uuid,uuid,text,text,text,text,uuid,text,text,text,jsonb,jsonb,jsonb)'::regprocedure) into original;
 revised:=replace(original,
   '  update public.contract_templates set product_id=p_product_id,updated_at=now()',
   '  if v_previous_product is distinct from p_product_id then
    update public.contract_templates set current_version_id=null,updated_at=now()
      where tenant_id=v_tenant and id=v_template;
  end if;
  update public.contract_templates set product_id=p_product_id,updated_at=now()');
 if original=revised then raise exception 'product_template_reapproval_anchor_missing'; end if;
 execute revised;
end $$;
commit;
