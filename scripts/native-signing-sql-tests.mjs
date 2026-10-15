import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
export async function verifyNativeSigningSql(db) {
  const id = n => `56000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
  const [tenant,other,actor,customer,product,entity,template,templateVersion] = [1,2,3,4,5,6,7,8].map(id);
  const policy = { method:'external_esign',identityAssuranceLevel:'low',orderedSigning:false,requireFinalProviderDocument:true };
  const pdf = { schemaVersion:1,storagePath:`${tenant}/templates/source/${'a'.repeat(64)}.pdf`,sha256:'a'.repeat(64),pageSizes:[{width:595,height:842}],fields:[{id:'sign',label:'Underskrift',providerName:'Sign',type:'signature',source:'',required:true,fontSize:12,placements:[{page:0,x:0.1,y:0.7,width:0.5,height:0.1}]}] };
  const refuse = async (sql,args,marker) => {
    await db.exec('savepoint native_denied');
    let message=''; try { await db.query(sql,args); } catch (error) { message=String(error); }
    await db.exec('rollback to native_denied; release native_denied');
    assert.ok(message.includes(marker), `Expected ${marker}, got ${message || 'success'}`);
  };
  const rpc = async (name, input) => (await db.query(`select public.${name}($1::jsonb) as result`, [input])).rows[0].result;
  await db.exec('begin');
  try {
    await db.exec(`insert into auth.users(id,email) values('${actor}','native-sql@example.test');
      insert into public.tenants(id,name,slug,legal_name) values('${tenant}','Signing A','native-signing-a','Signing A AB'),('${other}','Signing B','native-signing-b','Signing B AB');
      insert into public.tenant_memberships(tenant_id,user_id,role,status) values('${tenant}','${actor}','owner','active');
      update public.profiles set active_tenant_id='${tenant}' where id='${actor}';
      select set_config('request.jwt.claim.sub','${actor}',true); select set_config('request.jwt.claim.role','authenticated',true);
      insert into public.customers(id,tenant_id,customer_type,display_name,phone_e164,created_by) values('${customer}','${tenant}','company','Signing customer','+46705559999','${actor}');
      insert into public.products(id,tenant_id,name) values('${product}','${tenant}','Signing product');
      insert into public.product_price_versions(tenant_id,product_id,version) values('${tenant}','${product}',1);
      insert into public.tenant_legal_entities(id,tenant_id,legal_name) values('${entity}','${tenant}','Signing A AB');
      insert into public.contract_templates(id,tenant_id,name,contract_type,audience,product_id,legal_entity_id) values('${template}','${tenant}','Signing template','service','B2B','${product}','${entity}');`);
    await db.query(`insert into public.contract_template_versions(id,tenant_id,template_id,version,title_template,body_template,terms_template,signing_configuration) values($1,$2,$3,1,'Title','Body','Terms',$4::jsonb)`,[templateVersion,tenant,template,{pdf_template:pdf,signature_policy:policy,provider_key:'kundexa_native'}]);
    await db.query(`select public.approve_contract_template_version($1)`,[templateVersion]);
    await db.exec(`insert into public.tenant_features(tenant_id,feature_key,enabled) values('${tenant}','outbound_email',true),('${tenant}','contract_delivery_email',true) on conflict(tenant_id,feature_key) do update set enabled=true;
      insert into public.tenant_integrations(tenant_id,name,provider_type,provider,status,configuration) values('${tenant}','Resend','email','resend','active','{}');`);
    const price = (await db.query(`select id from public.product_price_versions where tenant_id=$1 and product_id=$2`,[tenant,product])).rows[0].id;
    const call = (await db.query(`select public.register_external_manual_call($1,'+46705559999','outbound',now()-interval '20 minutes',now()-interval '10 minutes','interested','Signing test',null) as id`,[customer])).rows[0].id;
    const contract = (await db.query(`select public.create_contract_draft_v3('PR53-SIGN',$1,$2,$3,$4,$5,$6,'Title','Body','Terms',$7::jsonb,'draft-hash','telephone','{"legal_name":"Signing A AB"}'::jsonb,'{"display_name":"Signing customer","email":"signer@example.test"}'::jsonb,$8,null,null,null,null,null,0,'SEK',now()+interval '7 days') as id`,[customer,product,price,template,templateVersion,entity,{currency:'SEK',pdf_fields:{template:pdf,values:{}}},actor])).rows[0].id;
    await db.query(`update public.contracts set source_call_id=$1,source_type='external_manual_call',prepared_at=now(),status='ready' where id=$2`,[call,contract]);
    const document = (await db.query(`insert into public.contract_documents(tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,size_bytes,sha256,metadata) select tenant_id,id,active_version_id,'generated_pdf','source.pdf',tenant_id||'/'||id||'/source.pdf','application/pdf',1000,'${'a'.repeat(64)}','{"canonical":true}' from public.contracts where id=$1 returning id`,[contract])).rows[0].id;
    const input = { tenant_id:tenant,actor_id:actor,contract_id:contract,recipient_name:'Signing customer',email:'signer@example.test',expires_at:new Date(Date.now()+86400000).toISOString(),request_key:'same-key',request_hash:'b'.repeat(64),source_document_id:document,source_sha256:'a'.repeat(64),public_token_hash:'c'.repeat(64),public_token_ciphertext:'cipher' };
    // Public/normal authenticated transports cannot reach any signing mutation.
    for (const name of ['reserve_native_signing','commit_native_invitation','claim_native_signature','finalize_native_signature','cancel_native_signing']) {
      await db.exec('savepoint native_role; set local role authenticated');
      await refuse(`select public.${name}($1::jsonb)`, [{}], 'permission denied');
      await db.exec('rollback to native_role; release native_role');
    }
    await refuse(`select public.reserve_native_signing($1::jsonb)`,[input],'service_role_required');
    await db.exec(`select set_config('request.jwt.claim.role','service_role',true)`);
    await refuse(`select public.reserve_native_signing($1::jsonb)`,[{...input,tenant_id:other}],'contract_send_permission_required');
    await db.exec('savepoint active_other_tenant');
    await db.query(`insert into public.tenant_memberships(tenant_id,user_id,role,status) values($1,$2,'owner','active')`,[other,actor]);
    await refuse(`select public.reserve_native_signing($1::jsonb)`,[{...input,tenant_id:other}],'contract_not_found');
    await db.exec('rollback to active_other_tenant; release active_other_tenant');
    await db.exec('savepoint disabled_actor');
    await db.query(`update public.tenant_memberships set role='viewer' where tenant_id=$1 and user_id=$2`,[tenant,actor]);
    await refuse(`select public.reserve_native_signing($1::jsonb)`,[input],'contract_send_permission_required');
    await db.exec('rollback to disabled_actor; release disabled_actor');
    await refuse(`select public.reserve_native_signing($1::jsonb)`,[{...input,email:'wrong@example.test'}],'signing_recipient_snapshot_mismatch');
    await refuse(`select public.reserve_native_signing($1::jsonb)`,[{...input,expires_at:null}],'signing_recipient_or_expiry_invalid');
    const first=await rpc('reserve_native_signing',input);
    assert.equal(first.provider,'kundexa_native'); assert.equal(first.initial,true);
    const again=await rpc('reserve_native_signing',input);
    assert.equal(first.id,again.id); assert.equal(again.initial,false);
    await refuse(`select public.reserve_native_signing($1::jsonb)`,[{...input,request_hash:'d'.repeat(64)}],'idempotency_conflict');
    await refuse(`select public.reserve_native_signing($1::jsonb)`,[{...input,source_sha256:'d'.repeat(64)}],'idempotency_conflict');
    const commit={envelope_id:first.id,email_from:'from@example.test',subject:'Sign',text:'Sign',html:'<p>Sign</p>',attachments:[]};
    await rpc('commit_native_invitation',commit); await rpc('commit_native_invitation',commit);
    await refuse(`select public.commit_native_invitation($1::jsonb)`,[{...commit,subject:'Changed'}],'native_invitation_conflict');
    assert.equal((await db.query(`select count(*)::int as n from public.email_messages where tenant_id=$1`,[tenant])).rows[0].n,1);
    assert.equal((await db.query(`select count(*)::int as n from public.outbox_jobs where tenant_id=$1 and job_type='email.send'`,[tenant])).rows[0].n,1);
    const cancellation={tenant_id:tenant,actor_id:actor,envelope_id:first.id};
    await refuse(`select public.cancel_native_signing($1::jsonb)`,[{...cancellation,tenant_id:other}],'active_membership_required');
    await db.exec('savepoint cancel_reader');
    await db.query(`update public.tenant_memberships set role='viewer' where tenant_id=$1 and user_id=$2`,[tenant,actor]);
    await refuse(`select public.cancel_native_signing($1::jsonb)`,[cancellation],'contract_write_permission_required');
    await db.exec('rollback to cancel_reader; release cancel_reader');
    await db.exec('savepoint cancellation_atomic_failure');
    await db.exec(`create function pg_temp.reject_native_restore() returns trigger language plpgsql as $block$
      begin if new.id='${contract}' and new.status='ready' and old.status='signing' then raise exception 'injected_native_restore_failure'; end if; return new; end $block$;
      create trigger verify_atomic_native_cancel before update on public.contracts for each row execute function pg_temp.reject_native_restore();`);
    await refuse(`select public.cancel_native_signing($1::jsonb)`,[cancellation],'injected_native_restore_failure');
    assert.equal((await db.query(`select status from public.signing_envelopes where id=$1`,[first.id])).rows[0].status,'sent');
    assert.equal((await db.query(`select status from public.contracts where id=$1`,[contract])).rows[0].status,'signing');
    await db.exec('rollback to cancellation_atomic_failure; release cancellation_atomic_failure');
    await db.exec('savepoint cancellation_success');
    assert.equal((await rpc('cancel_native_signing',cancellation)).idempotent_replay,false);
    assert.equal((await db.query(`select status from public.contracts where id=$1`,[contract])).rows[0].status,'ready');
    assert.equal((await db.query(`select status from public.signing_envelopes where id=$1`,[first.id])).rows[0].status,'cancelled');
    assert.equal((await rpc('cancel_native_signing',cancellation)).idempotent_replay,true);
    assert.equal((await db.query(`select count(*)::int as n from public.contract_events where contract_id=$1 and event_type='signing.native_cancelled'`,[contract])).rows[0].n,1);
    await db.exec('rollback to cancellation_success; release cancellation_success');
    await db.exec('savepoint cancellation_legacy_partial');
    await db.query(`update public.signing_envelopes set status='cancelled' where id=$1`,[first.id]);
    assert.equal((await rpc('cancel_native_signing',cancellation)).idempotent_replay,true);
    assert.equal((await db.query(`select status from public.contracts where id=$1`,[contract])).rows[0].status,'ready');
    await db.exec('rollback to cancellation_legacy_partial; release cancellation_legacy_partial');
    await db.exec('savepoint cancellation_old_generation');
    await db.query(`update public.signing_envelopes set status='cancelled' where id=$1`,[first.id]);
    await db.query(`update public.contracts set acceptance_generation=acceptance_generation+1 where id=$1`,[contract]);
    assert.equal((await rpc('cancel_native_signing',cancellation)).idempotent_replay,true);
    assert.equal((await db.query(`select status from public.contracts where id=$1`,[contract])).rows[0].status,'signing');
    await db.exec('rollback to cancellation_old_generation; release cancellation_old_generation');
    const claim={envelope_id:first.id,public_token_hash:input.public_token_hash,request_key:'sign-once',request_hash:'d'.repeat(64),source_sha256:input.source_sha256,
      signature_sha256:'e'.repeat(64),signature_storage_path:`${tenant}/${contract}/${first.contract_version_id}/signatures/${'e'.repeat(64)}.png`,signer_name:'Anna Företrädare',consent:true,ip_address:'192.0.2.1',user_agent:'SQL runtime'};
    await refuse(`select public.claim_native_signature($1::jsonb)`,[{...claim,public_token_hash:'f'.repeat(64)}],'native_signing_token_invalid');
    await refuse(`select public.claim_native_signature($1::jsonb)`,[{...claim,consent:false}],'native_signature_payload_invalid');
    await refuse(`select public.claim_native_signature($1::jsonb)`,[{...claim,signer_name:'\n'}],'native_signature_payload_invalid');
    await refuse(`select public.claim_native_signature($1::jsonb)`,[{...claim,signature_storage_path:`${other}/signature.png`}],'native_signature_payload_invalid');
    await db.exec('savepoint old_generation');
    await db.query(`update public.contracts set acceptance_generation=acceptance_generation+1 where id=$1`,[contract]);
    await refuse(`select public.claim_native_signature($1::jsonb)`,[claim],'signing_generation_superseded');
    await db.exec('rollback to old_generation; release old_generation');
    await db.exec('savepoint expired_signature');
    await db.query(`update public.signing_envelopes set provider_evidence=jsonb_set(provider_evidence,'{expires_at}',to_jsonb(now()-interval '1 minute')) where id=$1`,[first.id]);
    await refuse(`select public.claim_native_signature($1::jsonb)`,[claim],'native_signing_expired');
    assert.equal((await db.query(`select public.expire_native_signing($1) as expired`,[first.id])).rows[0].expired,true);
    assert.equal((await db.query(`select status from public.contracts where id=$1`,[contract])).rows[0].status,'expired');
    assert.equal((await db.query(`select public.expire_native_signing($1) as expired`,[first.id])).rows[0].expired,false);
    await db.exec('rollback to expired_signature; release expired_signature');
    await db.exec('savepoint suspended_signing');
    await db.query(`update public.tenants set status='suspended' where id=$1`,[tenant]);
    await refuse(`select public.claim_native_signature($1::jsonb)`,[claim],'native_signing_actor_inactive');
    await db.exec('rollback to suspended_signing; release suspended_signing');
    // Receipts accepted by delivered006 must remain exactly replayable after007.
    await db.exec('savepoint legacy_native_receipt');
    const currentClaim=(await db.query(`select pg_get_functiondef('public.claim_native_signature(jsonb)'::regprocedure) as definition`)).rows[0].definition;
    const legacyMigration=await readFile(new URL('../supabase/migrations/202610150006_native_document_signing.sql',import.meta.url),'utf8');
    const legacyStart=legacyMigration.indexOf('create or replace function public.claim_native_signature');
    const legacyEnd=legacyMigration.indexOf('revoke all on function public.claim_native_signature',legacyStart);
    await db.exec(legacyMigration.slice(legacyStart,legacyEnd));
    const legacyInput={...claim,signer_name:'Signing customer'};
    const legacyReceipt=(await rpc('claim_native_signature',legacyInput)).native_signature;
    assert.equal(legacyReceipt.recipient_name,undefined);
    await db.exec(currentClaim);
    const legacyReplay=await rpc('claim_native_signature',legacyInput);
    assert.equal(legacyReplay.initial,false); assert.deepEqual(legacyReplay.native_signature,legacyReceipt);
    await db.exec('rollback to legacy_native_receipt; release legacy_native_receipt');
    const claimed=await rpc('claim_native_signature',claim);
    const receipt=claimed.native_signature;
    assert.ok(receipt.receipt_id); assert.equal(receipt.signer_name,'Anna Företrädare'); assert.equal(receipt.recipient_name,'Signing customer'); assert.equal(receipt.recipient_email,'signer@example.test'); assert.equal(receipt.consent,true);
    const verifiedIdentity=(await db.query(`select verified_identity from public.signing_attempts where envelope_id=$1`,[first.id])).rows[0].verified_identity;
    assert.equal(verifiedIdentity.signer_name,'Anna Företrädare'); assert.equal(verifiedIdentity.recipient_name,'Signing customer');
    assert.equal(verifiedIdentity.recipient_email,'signer@example.test'); assert.equal(verifiedIdentity.identity_assurance_level,'low');
    assert.equal(receipt.source_sha256,input.source_sha256); assert.ok(receipt.accepted_at); assert.equal(receipt.generation,first.generation);
    await db.exec('savepoint claimed_expiry');
    await db.query(`update public.signing_envelopes set provider_evidence=jsonb_set(provider_evidence,'{expires_at}',to_jsonb(now()-interval '1 minute')) where id=$1`,[first.id]);
    assert.equal((await db.query(`select public.expire_native_signing($1) as expired`,[first.id])).rows[0].expired,false);
    await db.exec('rollback to claimed_expiry; release claimed_expiry');
    const replay=await rpc('claim_native_signature',{...claim,ip_address:'192.0.2.2',user_agent:'retry'});
    assert.deepEqual(replay.native_signature,receipt); assert.equal(replay.initial,false);
    await refuse(`select public.claim_native_signature($1::jsonb)`,[{...claim,request_hash:'f'.repeat(64)}],'native_signature_idempotency_conflict');
    await refuse(`select public.cancel_native_signing($1::jsonb)`,[cancellation],'native_signature_already_claimed');
    await refuse(`update public.signing_envelopes set status='cancelled' where id=$1`,[first.id],'native_signature_already_claimed');
    await refuse(`update public.signing_envelopes set provider_evidence=provider_evidence-'native_signature' where id=$1`,[first.id],'native_signature_already_claimed');
    const prefix=`${tenant}/${contract}/${first.contract_version_id}/native/${receipt.receipt_id}`;
    const completion={envelope_id:first.id,public_token_hash:input.public_token_hash,receipt_id:receipt.receipt_id,request_key:claim.request_key,request_hash:claim.request_hash,
      source_sha256:claim.source_sha256,signature_sha256:claim.signature_sha256,storage_path:`${prefix}/signed.pdf`,sha256:'1'.repeat(64),size_bytes:1000,audit_storage_path:`${prefix}/audit.pdf`,audit_sha256:'2'.repeat(64),audit_size_bytes:1000};
    await refuse(`select public.finalize_native_signature($1::jsonb)`,[{...completion,signature_sha256:'3'.repeat(64)}],'native_signature_receipt_mismatch');
    await refuse(`select public.finalize_native_signature($1::jsonb)`,[{...completion,storage_path:`${other}/signed.pdf`}],'native_signature_documents_invalid');
    await refuse(`select public.finalize_native_signature($1::jsonb)`,[{...completion,audit_sha256:null}],'native_signature_documents_invalid');
    await refuse(`select public.finalize_native_signature($1::jsonb)`,[{...completion,size_bytes:0}],'native_signature_documents_invalid');
    const result=await rpc('finalize_native_signature',completion);
    assert.equal(result.status,'signed');
    assert.equal((await rpc('finalize_native_signature',completion)).idempotent_replay,true);
    await refuse(`select public.finalize_native_signature($1::jsonb)`,[{...completion,sha256:'3'.repeat(64)}],'native_finalization_conflict');
    const projection=(await db.query(`select e.status,e.final_document_id,d.metadata,d.sha256,
      (select count(*)::int from public.evidence_packages where tenant_id=$1 and contract_id=$2) as evidence_count,
      (select count(*)::int from public.signing_events where tenant_id=$1 and envelope_id=$3) as event_count,
      (select count(*)::int from public.contract_recipients where tenant_id=$1 and contract_id=$2 and generation=e.generation and required and status='signed') as signed_recipients
      from public.signing_envelopes e join public.contract_documents d on d.id=e.final_document_id where e.id=$3`,[tenant,contract,first.id])).rows[0];
    assert.equal(projection.status,'completed'); assert.equal(projection.sha256,completion.sha256); assert.equal(projection.evidence_count,1); assert.equal(projection.event_count,1); assert.equal(projection.signed_recipients,1);
    assert.equal(projection.metadata.locked_parties.counterparty.display_name,'Signing customer');
    assert.equal(projection.metadata.native_signature.receipt_id,receipt.receipt_id);
    assert.equal((await db.query(`select count(*)::int as n from public.evidence_packages where contract_id=$1 and manifest::text like '%public_token%'`,[contract])).rows[0].n,0);
    // Historical approved DocuSeal versions can still be read/left unchanged;
    // newly authored templates must use the native provider now.
    await refuse(`insert into public.contract_template_versions(tenant_id,template_id,version,title_template,body_template,terms_template,signing_configuration) values($1,$2,2,'T','B','Terms',$3::jsonb)`,[tenant,template,{pdf_template:pdf,signature_policy:policy,provider_key:'docuseal'}],'external_signing_policy_invalid');
    console.log('Native signing SQL PASS: permission/two-tenant/actor/token/expiry/generation/consent/source validation, human signer separate from locked organisation, atomic/idempotent cancellation with injected failure and legacy repair, immutable receipt, one invitation/finalization/evidence, locked identity and current native template policy.');
  } finally { await db.exec('rollback'); }
}
