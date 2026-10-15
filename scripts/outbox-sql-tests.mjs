import assert from "node:assert/strict";

export async function verifyOutboxRecovery(db) {
  const previousRole = (await db.query("select current_setting('request.jwt.claim.role',true) role")).rows[0].role;
  await db.exec("reset role; select set_config('request.jwt.claim.role','service_role',false)");
  const tenant = (await db.query("select id from public.tenants order by created_at limit 1")).rows[0].id;
  const other = (await db.query("select id from public.tenants where id<>$1 limit 1", [tenant])).rows[0].id;
  // Keep the fixture isolated from pre-existing queued work.
  await db.exec("begin");
  try {
    await db.exec("update public.outbox_jobs set status='completed'");
    const job = (await db.query("insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,payload,idempotency_key) values($1,'email.send','email_message','{}','pr53-lease-runtime') returning id", [tenant])).rows[0].id;
    let claimed = (await db.query("select id from public.claim_outbox_jobs('worker-original',1)")).rows;
    assert.equal(claimed[0].id, job);
    assert.equal((await db.query("select count(*)::int n from public.claim_outbox_jobs('worker-other',1)")).rows[0].n, 0);
    await db.query("update public.outbox_jobs set locked_at=now()-interval '6 minutes',attempts=max_attempts where id=$1", [job]);
    claimed = (await db.query("select id from public.claim_outbox_jobs('worker-recovered',1)")).rows;
    assert.equal(claimed[0].id, job);
    await db.exec("savepoint stale_worker");
    await assert.rejects(db.query("select public.finish_outbox_job($1,'worker-original','completed')", [job]), /outbox_lease_lost/);
    await db.exec("rollback to savepoint stale_worker");
    assert.equal((await db.query("select status from public.outbox_jobs where id=$1", [job])).rows[0].status, "processing");
    await db.query("select public.finish_outbox_job($1,'worker-recovered','completed')", [job]);
    assert.equal((await db.query("select status from public.outbox_jobs where id=$1", [job])).rows[0].status, "completed");

    const email = (await db.query("insert into public.email_messages(tenant_id,status,from_address,to_addresses,subject) values($1,'draft','test@example.com',array['recipient@example.com'],'PR53') returning id", [tenant])).rows[0].id;
    const emailJob = (await db.query("insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key,status,locked_by,locked_at) values($1,'email.send','email_message',$2,'{}','pr53-email-attempt','processing','email-worker',now()) returning id", [tenant,email])).rows[0].id;
    const first = (await db.query("select public.prepare_email_submission($1,$2,$3,'email-worker','{\"subject\":\"frozen\"}',repeat('a',64)) payload", [tenant,email,emailJob])).rows[0].payload;
    const retry = (await db.query("select public.prepare_email_submission($1,$2,$3,'email-worker','{\"subject\":\"changed\"}',repeat('a',64)) payload", [tenant,email,emailJob])).rows[0].payload;
    assert.deepEqual(first, retry);
    const submission = (await db.query("select payload->'submission' submission from public.outbox_jobs where id=$1", [emailJob])).rows[0].submission;
    assert.equal(submission.credential_fingerprint, "a".repeat(64));
    assert.equal(submission.provider_request.subject, "frozen");
    await db.exec("savepoint changed_credential");
    await assert.rejects(db.query("select public.prepare_email_submission($1,$2,$3,'email-worker','{}',repeat('b',64))", [tenant,email,emailJob]), /email_provider_credentials_changed_requires_reconciliation/);
    await db.exec("rollback to savepoint changed_credential");
    assert.deepEqual((await db.query("select payload->'submission' submission from public.outbox_jobs where id=$1",[emailJob])).rows[0].submission,submission);
    await db.exec("savepoint legacy_unknown");
    await db.query("update public.outbox_jobs set payload=payload#-'{submission,credential_fingerprint}' where id=$1", [emailJob]);
    await assert.rejects(db.query("select public.prepare_email_submission($1,$2,$3,'email-worker','{}',repeat('a',64))", [tenant,email,emailJob]), /email_provider_credentials_unknown_requires_reconciliation/);
    await db.exec("rollback to savepoint legacy_unknown");
    await db.exec("savepoint legacy_unrecorded");
    await db.query("update public.outbox_jobs set payload='{}' where id=$1", [emailJob]);
    await assert.rejects(db.query("select public.prepare_email_submission($1,$2,$3,'email-worker','{}',repeat('a',64))", [tenant,email,emailJob]), /email_provider_credentials_unknown_requires_reconciliation/);
    await db.exec("rollback to savepoint legacy_unrecorded");
    await db.exec("savepoint unbound_worker");
    await assert.rejects(db.query("select public.prepare_email_submission($1,$2,$3,'email-worker','{}')", [tenant,email,emailJob]), /email_provider_credential_fingerprint_required/);
    await db.exec("rollback to savepoint unbound_worker");
    await db.exec("savepoint foreign_message");
    await assert.rejects(db.query("select public.prepare_email_submission($1,$2,$3,'email-worker','{}',repeat('a',64))", [other,email,emailJob]), /outbox_lease_lost/);
    await db.exec("rollback to savepoint foreign_message");
    await db.query("update public.outbox_jobs set payload=jsonb_set(payload,'{submission,started_at}',to_jsonb((now()-interval '25 hours')::text)) where id=$1", [emailJob]);
    await db.exec("savepoint expired_key");
    await assert.rejects(db.query("select public.prepare_email_submission($1,$2,$3,'email-worker','{}',repeat('a',64))", [tenant,email,emailJob]), /email_submission_requires_provider_reconciliation/);
    await db.exec("rollback to savepoint expired_key");

    await db.query("insert into public.provider_webhook_events(tenant_id,provider,event_type,provider_event_id,payload,status) values($1,'resend','email.delivered','pr53-early-webhook','{\"type\":\"email.delivered\",\"data\":{\"email_id\":\"pr53-provider-id\"}}','unmatched')", [other]);
    assert.equal((await db.query("select public.replay_unmatched_resend_events(500) n")).rows[0].n,0);
    await db.query("update public.email_messages set provider_message_id='pr53-provider-id',status='sent' where id=$1", [email]);
    await db.query("select public.repair_outbound_delivery($1,$2,'email')", [tenant,email]);
    assert.equal((await db.query("select status from public.email_messages where id=$1", [email])).rows[0].status,"delivered");
    const event=(await db.query("select tenant_id,status from public.provider_webhook_events where provider_event_id='pr53-early-webhook'")).rows[0];
    assert.equal(event.tenant_id,tenant); assert.equal(event.status,"processed");
    assert.equal((await db.query("select public.replay_unmatched_resend_events(500) n")).rows[0].n,0);
    const binding = (await db.query(`select c.id contract_id,c.active_version_id version_id,r.id recipient_id
      from public.contracts c join public.contract_recipients r on r.tenant_id=c.tenant_id and r.contract_id=c.id
      where c.tenant_id=$1 and c.active_version_id is not null limit 1`, [tenant])).rows[0];
    assert.ok(binding, "A migrated contract fixture is required");
    for (const status of ["created","sent","delivered","failed"]) {
      const sms = (await db.query("insert into public.sms_messages(tenant_id,status,direction,from_number,to_number,body) values($1,'submitting','outbound','+46700000001','+46700000002','PR53') returning id",[tenant])).rows[0].id;
      const delivery = (await db.query("insert into public.contract_deliveries(tenant_id,contract_id,contract_version_id,recipient_id,channel,sms_message_id) values($1,$2,$3,$4,'sms',$5) returning id",[tenant,binding.contract_id,binding.version_id,binding.recipient_id,sms])).rows[0].id;
      await db.query("select public.record_sms_submission($1,$2,$3,$4,now())", [tenant,sms,`pr53-sms-${status}`,status]);
      assert.equal((await db.query("select status from public.contract_deliveries where id=$1",[delivery])).rows[0].status,status);
      await db.query("select public.repair_outbound_delivery($1,$2,'sms')", [tenant,sms]);
      assert.equal((await db.query("select status from public.contract_deliveries where id=$1",[delivery])).rows[0].status,status);
    }
    await db.query(`update public.contracts set seller_snapshot='{"legal_name":"Locked issuer AB"}',counterparty_snapshot='{"display_name":"Locked customer"}' where id=$1`,[binding.contract_id]);
    const document=(await db.query(`insert into public.contract_documents(tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,size_bytes,sha256,metadata)
      values($1,$2,$3,'generated_pdf','pr53.pdf','pr53/parties.pdf','application/pdf',1,'pr53-parties-hash','{"canonical":true}') returning id,metadata`,[tenant,binding.contract_id,binding.version_id])).rows[0];
    assert.equal(document.metadata.locked_parties.seller.legal_name,"Locked issuer AB");
    await db.query(`update public.contracts set seller_snapshot='{"legal_name":"Renamed issuer AB"}' where id=$1`,[binding.contract_id]);
    assert.equal((await db.query("select metadata#>>'{locked_parties,seller,legal_name}' name from public.contract_documents where id=$1",[document.id])).rows[0].name,"Locked issuer AB");
    await db.exec("savepoint frozen_metadata");
    await assert.rejects(db.query("update public.contract_documents set metadata='{}' where id=$1",[document.id]),/frozen_contract_artifact_immutable/);
    await db.exec("rollback to savepoint frozen_metadata");
    const artifactJob=(await db.query("insert into public.outbox_jobs(tenant_id,job_type,aggregate_type,aggregate_id,payload,idempotency_key,status,locked_by,locked_at) values($1,'evidence.generate','contract',$2,'{}','pr53-frozen-artifact','processing','artifact-worker',now()) returning id",[tenant,binding.contract_id])).rows[0].id;
    await db.query("select public.freeze_outbox_artifact($1,'artifact-worker','{\"version\":1}')",[artifactJob]);
    assert.deepEqual((await db.query("select public.freeze_outbox_artifact($1,'artifact-worker','{\"version\":2}') artifact",[artifactJob])).rows[0].artifact,{version:1});
    for (const signature of ["public.finish_outbox_job(uuid,text,text,text,integer)","public.renew_outbox_lease(uuid,text)","public.prepare_email_submission(uuid,uuid,uuid,text,jsonb)","public.prepare_email_submission(uuid,uuid,uuid,text,jsonb,text)","public.repair_outbound_delivery(uuid,uuid,text)","public.replay_unmatched_resend_events(integer)"]) {
      assert.equal((await db.query("select has_function_privilege('authenticated',$1,'EXECUTE') allowed",[signature])).rows[0].allowed,false);
    }
  } finally { await db.exec("rollback"); await db.query("select set_config('request.jwt.claim.role',$1,false)",[previousRole ?? "authenticated"]); }
  console.log("PR53 outbox runtime: expired lease recovery, stale-owner refusal, frozen provider payload and credential fingerprint, changed/legacy credential refusal, tenant binding, expired Resend key hold and early shared-account webhook replay, all SMS submission projections, locked canonical parties and frozen evidence retries verified.");
}
