begin;
-- Row-level tenant ownership alone does not authorize declaring arbitrary bytes
-- to be the approved canonical contract or its signing/evidence artifacts.
create or replace function private.guard_contract_artifact_origin() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if current_user in ('anon','authenticated') and (
    new.document_type in ('generated_pdf','signed_pdf','evidence_pdf','manifest')
    or coalesce(new.metadata->>'canonical','false')='true'
    or coalesce(new.metadata->>'immutable','false')='true'
    or new.metadata ? 'canonical_origin'
    or new.metadata ? 'native_signature'
    or new.metadata ? 'provider_audit'
  ) then raise exception 'trusted_contract_artifact_service_required'; end if;
  return new;
end $$;
revoke all on function private.guard_contract_artifact_origin() from public,anon,authenticated;
create trigger contract_documents_trusted_origin before insert or update on public.contract_documents
for each row execute function private.guard_contract_artifact_origin();

-- These live-only13October endpoints belong to the retired remote DocuSeal
-- implementation. No current application call or pending provider job uses them.
-- Keep their definitions/history intact, retire direct invocation only.
do $$ declare signature text; target regprocedure; begin
  foreach signature in array array[
    'public.reserve_docuseal_signing(jsonb)',
    'public.claim_docuseal_submission(uuid,text)',
    'public.commit_docuseal_invitation(jsonb)',
    'public.complete_docuseal_signing(jsonb)',
    'public.save_pdf_template_configuration(uuid,jsonb)',
    'public.prepare_docuseal_signing(uuid,uuid,text,text,timestamptz,text,text,text,text,uuid,uuid)',
    'public.queue_docuseal_invitation(uuid,uuid,text,text,text)',
    'public.project_docuseal_terminal(uuid,uuid,text,text)'
  ] loop
    target:=to_regprocedure(signature);
    if target is not null then execute format('revoke execute on function %s from public,anon,authenticated,service_role',target); end if;
  end loop;
end $$;
commit;
