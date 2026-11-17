begin;
-- Product, initial price and creation audit must commit or roll back together.
-- Preserve the canonical initial-price trigger rather than adding a second flow.
do $$ declare original text; revised text;
begin
 select pg_get_functiondef('private.create_initial_product_price()'::regprocedure) into original;
 revised:=replace(original,E'  return new;\nend',E'  insert into public.audit_logs(tenant_id,actor_user_id,action,entity_type,entity_id,after_data)\n  values(new.tenant_id,auth.uid(),''product.created'',''product'',new.id::text,\n    jsonb_build_object(''price_version'',1,''payment_terms_days'',coalesce((v_seed->>''payment_terms_days'')::integer,30)));\n  return new;\nend');
 if revised=original then raise exception 'product_atomic_audit_anchor_missing'; end if;
 execute revised;
end $$;
commit;
