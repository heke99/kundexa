import assert from 'node:assert/strict';
export async function verifyDocusealSql(db) {
  const id = n => `54000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
  const [tenant,other,actor,customer,product,entity,template,templateVersion] = [1,2,3,4,5,6,7,8].map(id);
  const policy = { method:'external_esign',identityAssuranceLevel:'low',orderedSigning:false,requireFinalProviderDocument:true };
  const pdf = { schemaVersion:1,storagePath:`${tenant}/templates/source/${'a'.repeat(64)}.pdf`,sha256:'a'.repeat(64),pageSizes:[{width:595,height:842}],fields:[{id:'sign',label:'Underskrift',providerName:'Sign',type:'signature',source:'',required:true,fontSize:12,placements:[{page:0,x:0.1,y:0.7,width:0.5,height:0.1}]}] };
  const refuse = async (sql,args,marker) => {
    await db.exec('savepoint docuseal_denied');
    let message=''; try { await db.query(sql,args); } catch (error) { message=String(error); }
    await db.exec('rollback to docuseal_denied; release docuseal_denied');
    assert.ok(message.includes(marker), `Expected ${marker}, got ${message || 'success'}`);
  };
  await db.exec('begin');
  try {
    await db.exec(`insert into auth.users(id,email) values('${actor}','docuseal-sql@example.test');
      insert into public.tenants(id,name,slug,legal_name) values('${tenant}','Signing A','signing-a','Signing A AB'),('${other}','Signing B','signing-b','Signing B AB');
      insert into public.tenant_memberships(tenant_id,user_id,role,status) values('${tenant}','${actor}','owner','active');
      update public.profiles set active_tenant_id='${tenant}' where id='${actor}';
      select set_config('request.jwt.claim.sub','${actor}',true); select set_config('request.jwt.claim.role','authenticated',true);
      insert into public.customers(id,tenant_id,customer_type,display_name,phone_e164,created_by) values('${customer}','${tenant}','company','Signing customer','+46705559999','${actor}');
      insert into public.products(id,tenant_id,name) values('${product}','${tenant}','Signing product');
      insert into public.product_price_versions(tenant_id,product_id,version) values('${tenant}','${product}',1);
      insert into public.tenant_legal_entities(id,tenant_id,legal_name) values('${entity}','${tenant}','Signing A AB');
      insert into public.contract_templates(id,tenant_id,name,contract_type,audience,product_id,legal_entity_id) values('${template}','${tenant}','Signing template','service','B2B','${product}','${entity}');`);
    await db.query(`insert into public.contract_template_versions(id,tenant_id,template_id,version,title_template,body_template,terms_template,signing_configuration) values($1,$2,$3,1,'Title','Body','Terms',$4::jsonb)`,[templateVersion,tenant,template,{pdf_template:pdf,signature_policy:policy,provider_key:'docuseal'}]);
    await db.query(`select public.approve_contract_template_version($1)`,[templateVersion]);
    await db.exec(`insert into public.tenant_features(tenant_id,feature_key,enabled) values('${tenant}','outbound_email',true),('${tenant}','contract_delivery_email',true) on conflict(tenant_id,feature_key) do update set enabled=true;
      insert into public.tenant_integrations(tenant_id,name,provider_type,provider,status,configuration) values('${tenant}','Resend','email','resend','active','{}');`);
    const price = (await db.query(`select id from public.product_price_versions where tenant_id=$1 and product_id=$2`,[tenant,product])).rows[0].id;
    const call = (await db.query(`select public.register_external_manual_call($1,'+46705559999','outbound',now()-interval '20 minutes',now()-interval '10 minutes','interested','Signing test',null) as id`,[customer])).rows[0].id;
    const contract = (await db.query(`select public.create_contract_draft_v3('PR53-SIGN',$1,$2,$3,$4,$5,$6,'Title','Body','Terms',$7::jsonb,'draft-hash','telephone','{"legal_name":"Signing A AB"}'::jsonb,'{"display_name":"Signing customer","email":"signer@example.test"}'::jsonb,$8,null,null,null,null,null,0,'SEK',now()+interval '7 days') as id`,[customer,product,price,template,templateVersion,entity,{currency:'SEK',pdf_fields:{template:pdf,values:{}}},actor])).rows[0].id;
    await db.query(`update public.contracts set source_call_id=$1,source_type='external_manual_call',prepared_at=now(),status='ready' where id=$2`,[call,contract]);
    const document = (await db.query(`insert into public.contract_documents(tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,size_bytes,sha256,metadata) select tenant_id,id,active_version_id,'generated_pdf','source.pdf',tenant_id||'/'||id||'/source.pdf','application/pdf',1000,'source-hash','{"canonical":true}' from public.contracts where id=$1 returning id`,[contract])).rows[0].id;
    const input = { tenant_id:tenant,actor_id:actor,contract_id:contract,recipient_name:'Signing customer',email:'signer@example.test',expires_at:new Date(Date.now()+86400000).toISOString(),request_key:'same-key',request_hash:'same-hash',source_document_id:document,source_sha256:'source-hash',public_token_hash:'public-hash',public_token_ciphertext:'cipher' };
    await refuse(`select public.reserve_docuseal_signing($1::jsonb)`,[input],'service_role_required');
    await db.exec(`select set_config('request.jwt.claim.role','service_role',true)`);
    await refuse(`select public.reserve_docuseal_signing($1::jsonb)`,[{...input,tenant_id:other}],'contract_send_permission_required');
    await refuse(`select public.reserve_docuseal_signing($1::jsonb)`,[{...input,email:'other@example.test'}],'signing_recipient_snapshot_mismatch');
    const first=(await db.query(`select public.reserve_docuseal_signing($1::jsonb) as result`,[input])).rows[0].result;
    assert.equal(first.initial,true);
    const replay=(await db.query(`select public.reserve_docuseal_signing($1::jsonb) as result`,[input])).rows[0].result;
    assert.equal(replay.id,first.id); assert.equal(replay.initial,false);
    await refuse(`select public.reserve_docuseal_signing($1::jsonb)`,[{...input,request_hash:'changed'}],'idempotency_conflict');
    assert.equal((await db.query(`select public.claim_docuseal_submission($1,'10') as result`,[first.id])).rows[0].result,true);
    assert.equal((await db.query(`select public.claim_docuseal_submission($1,'10') as result`,[first.id])).rows[0].result,false);
    await refuse(`select public.claim_docuseal_submission($1,'11')`,[first.id],'signing_template_conflict');
    const commit={envelope_id:first.id,provider_envelope_id:'20',provider_recipient_id:'30',provider_template_id:'10',email_from:'from@example.test',subject:'Sign',text:'Sign',html:'<p>Sign</p>',attachments:[]};
    await db.query(`select public.commit_docuseal_invitation($1::jsonb)`,[commit]);
    await db.query(`select public.commit_docuseal_invitation($1::jsonb)`,[commit]);
    assert.equal((await db.query(`select count(*)::int as n from public.email_messages where tenant_id=$1`,[tenant])).rows[0].n,1);
    assert.equal((await db.query(`select count(*)::int as n from public.outbox_jobs where tenant_id=$1 and job_type='email.send'`,[tenant])).rows[0].n,1);
    const completion={envelope_id:first.id,provider_envelope_id:'20',provider_recipient_id:'30',source_sha256:'source-hash',storage_path:`${tenant}/${contract}/${first.contract_version_id}/signed.pdf`,sha256:'signed-hash',size_bytes:1000,completed_at:new Date().toISOString(),event_id:'event-one',audit_storage_path:`${tenant}/${contract}/${first.contract_version_id}/audit.pdf`,audit_sha256:'audit-hash',audit_size_bytes:1000,evidence:{verified_server_status:'completed'}};
    await refuse(`select public.complete_docuseal_signing($1::jsonb)`,[{...completion,source_sha256:'wrong'}],'source_document_hash_mismatch');
    await refuse(`select public.complete_docuseal_signing($1::jsonb)`,[{...completion,storage_path:`${other}/wrong.pdf`}],'final_document_storage_mismatch');
    await refuse(`select public.complete_docuseal_signing($1::jsonb)`,[{...completion,provider_recipient_id:'999'}],'provider_recipient_mismatch');
    await db.exec('savepoint superseded_signing');
    await db.query(`update public.contracts set acceptance_generation=acceptance_generation+1 where id=$1`,[contract]);
    await refuse(`select public.complete_docuseal_signing($1::jsonb)`,[completion],'signing_envelope_generation_superseded');
    await db.exec('rollback to superseded_signing; release superseded_signing');
    await refuse(`select public.complete_docuseal_signing($1::jsonb)`,[{...completion,audit_sha256:null}],'provider_audit_document_required');
    const final=(await db.query(`select public.complete_docuseal_signing($1::jsonb) as result`,[completion])).rows[0].result;
    assert.equal(final.status,'signed');
    const again=(await db.query(`select public.complete_docuseal_signing($1::jsonb) as result`,[completion])).rows[0].result;
    assert.equal(again.idempotent_replay,true);
    const projection=(await db.query(`select e.final_document_id,d.sha256,d.metadata,
      a.id as audit_id,a.sha256 as audit_sha256,a.metadata as audit_metadata,
      ep.manifest->'final_document' as manifest_document
      from public.signing_envelopes e join public.contract_documents d on d.tenant_id=e.tenant_id and d.id=e.final_document_id
      join public.signing_documents sd on sd.tenant_id=e.tenant_id and sd.envelope_id=e.id and sd.document_role='provider_evidence'
      join public.contract_documents a on a.tenant_id=sd.tenant_id and a.id=sd.contract_document_id
      join public.evidence_packages ep on ep.tenant_id=e.tenant_id and ep.contract_id=e.contract_id and ep.contract_version_id=e.contract_version_id and ep.status='completed'
      where e.id=$1`,[first.id])).rows[0];
    assert.equal(projection.sha256,'signed-hash');
    assert.equal(projection.metadata.immutable,true);
    assert.equal(projection.metadata.locked_parties.seller.legal_name,'Signing A AB');
    assert.equal(projection.audit_sha256,'audit-hash');
    assert.equal(projection.audit_metadata.provider_audit,true);
    assert.equal(projection.audit_metadata.immutable,true);
    assert.deepEqual(projection.audit_metadata.locked_parties,projection.metadata.locked_parties);
    assert.equal(projection.manifest_document.id,projection.final_document_id);
    assert.equal(projection.manifest_document.sha256,'signed-hash');
    const jobs=(await db.query(`select job_type,payload from public.outbox_jobs where tenant_id=$1 and job_type in ('evidence.generate','contract.signed.confirmation')`,[tenant])).rows;
    assert.equal(jobs.filter(job=>job.job_type==='evidence.generate').length,0);
    const confirmations=jobs.filter(job=>job.job_type==='contract.signed.confirmation');
    assert.equal(confirmations.length,1);
    assert.equal(confirmations[0].payload.final_document_id,projection.final_document_id);
    const envelopeEvidence=(await db.query(`select provider_evidence from public.signing_envelopes where id=$1`,[first.id])).rows[0].provider_evidence;
    assert.equal(envelopeEvidence.provider_audit_document_id,projection.audit_id);
    assert.equal(envelopeEvidence.provider_audit_sha256,'audit-hash');
    console.log('DocuSeal SQL: tenant/actor isolation, immutable intent replay, one submission claim, one invitation, source/storage binding and finalization replay PASS');
  } finally { await db.exec('rollback'); }
}
