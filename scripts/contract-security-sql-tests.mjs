// Runs against the fully migrated SQL runtime, using actual non-owner RLS roles.
export async function verifyContractSecurity(db) {
  const t = '53000000-0000-0000-0000-000000000001';
  const other = '53000000-0000-0000-0000-000000000002';
  const actor = '53000000-0000-0000-0000-000000000003';
  const customer = '53000000-0000-0000-0000-000000000004';
  const contract = '53000000-0000-0000-0000-000000000005';
  const product = '53000000-0000-0000-0000-000000000007';
  const template = '53000000-0000-0000-0000-000000000008';
  const version = '53000000-0000-0000-0000-000000000009';
  const entity = '53000000-0000-0000-0000-00000000000a';
  const recipient = '53000000-0000-0000-0000-000000000006';
  await db.exec(`begin;
    insert into auth.users(id,email) values('${actor}','pr53-security@example.test');
    insert into public.tenants(id,name,slug,legal_name) values
      ('${t}','Security A','pr53-security-a','Security A AB'),('${other}','Security B','pr53-security-b','Security B AB');
    insert into public.tenant_memberships(tenant_id,user_id,role,status) values('${t}','${actor}','owner','active');
    update public.profiles set active_tenant_id='${t}' where id='${actor}';
    select set_config('request.jwt.claim.sub','${actor}',true);
    select set_config('request.jwt.claim.role','authenticated',true);
    insert into public.customers(id,tenant_id,customer_type,display_name,created_by) values('${customer}','${t}','person','Security customer','${actor}');
    insert into public.contracts(id,tenant_id,contract_number,customer_id,owner_user_id,audience,title)
      values('${contract}','${t}','PR53-SECURITY','${customer}','${actor}','B2C','Security');
    insert into public.contract_recipients(id,tenant_id,contract_id,full_name) values('${recipient}','${t}','${contract}','Security recipient');
    insert into public.products(id,tenant_id,name) values('${product}','${t}','Security product');
    insert into public.product_price_versions(tenant_id,product_id,version) values('${t}','${product}',1);
    insert into public.tenant_legal_entities(id,tenant_id,legal_name) values('${entity}','${t}','Security A AB');
    insert into public.contract_templates(id,tenant_id,name,contract_type,audience,product_id,legal_entity_id)
      values('${template}','${t}','Security template','service','B2C','${product}','${entity}');
    insert into public.contract_template_versions(id,tenant_id,template_id,version,title_template,body_template,terms_template)
      values('${version}','${t}','${template}',1,'Title','Approved body','Approved terms');
    select public.approve_contract_template_version('${version}');
    grant select,insert,update on public.customers,public.contracts,public.contract_recipients,public.contract_versions to authenticated;
  `);
  const refused = async (sql, marker) => {
    await db.exec('savepoint security_attempt; set local role authenticated;');
    let message = '';
    try { await db.exec(sql); } catch (error) { message = String(error); }
    await db.exec('rollback to security_attempt; release security_attempt;');
    if (!message.includes(marker)) throw new Error(`Security gate expected ${marker}: ${message || 'write allowed'}`);
  };
  const price = (await db.query(`select * from public.product_price_versions where tenant_id='${t}' and product_id='${product}' order by version desc limit 1`)).rows[0];
  const draft = {
    p_contract_number: 'PR53-SALES-WRAPPER', p_customer_id: customer, p_product_id: product,
    p_price_version_id: price.id, p_template_id: template, p_template_version_id: version,
    p_legal_entity_id: entity, p_title: 'Title', p_rendered_body: 'Approved body', p_rendered_terms: 'Approved terms',
    p_commercial_terms: { currency: price.currency, setup_fee: price.setup_fee, recurring_fee: price.recurring_fee,
      variable_fees: price.variable_fees, binding_months: price.binding_months, notice_months: price.notice_months,
      payment_terms_days: price.payment_terms_days, contract_value: price.recurring_fee, additional_terms: price.terms ?? {} },
    p_document_hash: 'security-hash', p_sales_channel: 'telephone', p_seller_snapshot: { legal_name: 'Security A AB' },
    p_counterparty_snapshot: { display_name: 'Security customer' }, p_owner_user_id: actor,
    p_binding_months: price.binding_months, p_notice_months: price.notice_months, p_contract_value: price.recurring_fee,
    p_currency: price.currency,
  };
  try {
    for (const role of ['viewer','quality','finance','contract_manager']) {
      await db.exec(`update public.tenant_memberships set role='${role}' where tenant_id='${t}' and user_id='${actor}';`);
      await refused(`insert into public.customers(tenant_id,customer_type,display_name,created_by) values('${t}','person','Forbidden','${actor}')`, 'row-level security');
      await db.exec('set local role authenticated;');
      const result = await db.query(`update public.customers set display_name='Forbidden' where id='${customer}' returning id`);
      await db.exec('reset role;');
      if (result.rows.length) throw new Error(`${role} updated a customer`);
    }
    await db.exec(`update public.tenant_memberships set role='sales' where tenant_id='${t}' and user_id='${actor}';`);
    for (const assignment of ["status='active'", 'acceptance_generation=99', "signed_at=now()"]) {
      await refused(`update public.contracts set ${assignment} where id='${contract}'`, 'controlled_contract_transition_required');
    }
    for (const assignment of ["status='signed'", 'required=false', 'generation=99']) {
      await refused(`update public.contract_recipients set ${assignment} where id='${recipient}'`, 'controlled_recipient_transition_required');
    }
    await refused(`select public.create_contract_draft('PR53-RPC-BYPASS','${customer}','${product}',null,'Forged','Body','Terms','{"currency":"SEK","recurring_fee":1}'::jsonb,'hash','telephone')`, 'permission denied for function create_contract_draft');
    await refused(`select public.create_contract_draft_for_actor('${t}','${actor}','{}'::jsonb)`, 'permission denied for function create_contract_draft_for_actor');
    await refused(`insert into public.contract_versions(tenant_id,contract_id,version,title,rendered_body,commercial_terms,document_hash) values('${t}','${contract}',1,'Forged','Forged body','{}'::jsonb,'forged')`, 'controlled_contract_version_required');
    // Same actor and fully approved resource input: direct rendered-RPC input
    // is rejected, while the server-only wrapper completes the real v3 chain.
    await db.exec('savepoint direct_render; set local role authenticated;');
    let directError = '';
    try {
      await db.query(`select public.create_contract_draft_v3($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14::jsonb,$15::jsonb)`, [
        draft.p_contract_number, customer, product, price.id, template, version, entity, 'Forged', 'Forged body', 'Forged terms',
        JSON.stringify(draft.p_commercial_terms), 'forged-hash', 'telephone', '{}', '{}',
      ]);
    } catch (error) { directError = String(error); }
    await db.exec('rollback to direct_render; release direct_render;');
    if (!directError.includes('controlled_contract_rendering_required')) throw new Error(`Direct seller rendering gate: ${directError}`);
    await db.exec(`select set_config('request.jwt.claim.role','service_role',true); set local role service_role;`);
    const created = (await db.query(`select public.create_contract_draft_for_actor($1,$2,$3::jsonb) as id`, [t, actor, JSON.stringify(draft)])).rows[0].id;
    await db.exec(`reset role; select set_config('request.jwt.claim.role','authenticated',true);`);
    const saved = (await db.query(`select status,owner_user_id from public.contracts where id=$1`, [created])).rows[0];
    if (saved.status !== 'ready' || saved.owner_user_id !== actor) throw new Error('Trusted seller wrapper lost the actor or draft transition');
    // A normal seller can upload its own attachment bytes, but cannot turn
    // those bytes into an approved canonical/signature/evidence artifact.
    await db.exec(`grant usage on schema storage to authenticated;
      grant select,insert on storage.objects to authenticated;
      grant select,insert,update on public.contract_documents to authenticated;`);
    const forgedPath=`${t}/${created}/forged.pdf`;
    await db.exec('set local role authenticated');
    await db.query(`insert into storage.objects(bucket_id,name,metadata) values('contract-documents',$1,'{"mimetype":"application/pdf"}'::jsonb)`,[forgedPath]);
    await db.exec('reset role');
    const activeVersion=(await db.query(`select active_version_id from public.contracts where id=$1`,[created])).rows[0].active_version_id;
    for (const [documentType,metadata] of [
      ['source_pdf',{canonical:true}], ['generated_pdf',{}], ['signed_pdf',{}], ['evidence_pdf',{}], ['manifest',{}],
      ['attachment',{canonical_origin:'kundexa_renderer_v1'}],
    ]) {
      await refused(`insert into public.contract_documents(tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,size_bytes,sha256,metadata)
        values('${t}','${created}','${activeVersion}','${documentType}','forged.pdf','${forgedPath}','application/pdf',100,'${'a'.repeat(64)}','${JSON.stringify(metadata)}'::jsonb)`, 'trusted_contract_artifact_service_required');
    }
    await db.exec('set local role authenticated');
    const attachment=(await db.query(`insert into public.contract_documents(tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,size_bytes,sha256,metadata)
      values($1,$2,$3,'attachment','attachment.pdf',$4,'application/pdf',100,$5,'{}'::jsonb) returning id`,[t,created,activeVersion,forgedPath,'a'.repeat(64)])).rows[0].id;
    await db.exec('reset role');
    await db.exec('set local role authenticated');
    const upgraded=await db.query(`update public.contract_documents set metadata='{"canonical":true}'::jsonb where id=$1 returning id`,[attachment]);
    await db.exec('reset role');
    if (upgraded.rows.length) throw new Error('A seller upgraded attachment metadata to canonical');
    const trusted=(await db.query(`insert into public.contract_documents(tenant_id,contract_id,contract_version_id,document_type,file_name,storage_path,mime_type,size_bytes,sha256,metadata)
      values($1,$2,$3,'generated_pdf','trusted.pdf',$4,'application/pdf',100,$5,$6::jsonb) returning id`,[t,created,activeVersion,`${t}/${created}/trusted.pdf`,'b'.repeat(64),{canonical:true,canonical_origin:'kundexa_renderer_v1',snapshot_hash:'c'.repeat(64)}])).rows[0].id;
    if (!trusted) throw new Error('Trusted service canonical generation was blocked');
    await db.exec(`insert into public.signing_envelopes(tenant_id,contract_id,contract_version_id,provider,signature_policy,status)
      select tenant_id,id,active_version_id,'docuseal','{"method":"external_esign"}'::jsonb,'creating' from public.contracts where id='${created}';`);
    await db.exec('savepoint cancel_external;');
    let cancellationError = '';
    try { await db.exec(`update public.contracts set status='cancelled' where id='${created}'`); }
    catch (error) { cancellationError = String(error); }
    await db.exec('rollback to cancel_external; release cancel_external;');
    if (!cancellationError.includes('external_signing_cancellation_required')) throw new Error(`Unarchived provider cancellation gate: ${cancellationError}`);
    await db.exec(`update public.signing_envelopes set status='cancelled' where contract_id='${created}';
      update public.contracts set status='cancelled' where id='${created}';`);
    await refused(`update public.contracts set value=1 where id='${contract}'`, 'commercial_override_permission_required');
    await refused(`insert into public.customers(tenant_id,customer_type,display_name,created_by) values('${other}','person','Wrong tenant','${actor}')`, 'row-level security');
    await db.exec('set local role authenticated;');
    const ok = await db.query(`update public.customers set display_name='Allowed sales edit' where id='${customer}' returning id`);
    await db.exec('reset role;');
    if (ok.rows.length !== 1) throw new Error('Sales lost its assigned customer write');
    await db.exec(`update public.tenant_memberships set role='owner' where tenant_id='${t}' and user_id='${actor}';
      grant select,insert,update on public.contract_template_versions to authenticated;`);
    const pdf = { schemaVersion: 1, storagePath: `${t}/templates/source/${'a'.repeat(64)}.pdf`, sha256: 'a'.repeat(64),
      pageSizes: [{ width: 595, height: 842 }], fields: [{ id: 'name', label: 'Kundnamn', providerName: 'name', type: 'text',
        source: 'customer.display_name', required: true, fontSize: 12, placements: [{ page: 0, x: 0.1, y: 0.1, width: 0.5, height: 0.1 }] }] };
    const pdfConfig = pdfTemplate => JSON.stringify({ pdf_template: pdfTemplate, signature_policy: { method: 'simple_click', identityAssuranceLevel: 'low', requireFinalProviderDocument: false } });
    const insertPdfSql = config => `insert into public.contract_template_versions(tenant_id,template_id,version,title_template,body_template,terms_template,signing_configuration)
      values('${t}','${template}',2,'PDF title','PDF body','PDF terms','${pdfConfig(config).replaceAll("'", "''")}'::jsonb)`;
    await db.exec('savepoint valid_pdf; set local role authenticated;');
    await db.exec(insertPdfSql(pdf));
    await db.exec('rollback to valid_pdf; release valid_pdf;');
    const customDefinition = { id: 'service_start', label: 'Tjänstestart', type: 'date', required: true };
    const customPdf = { ...pdf, customFields: [customDefinition], fields: [{ ...pdf.fields[0], type: 'date', source: 'custom.service_start' }] };
    for (const valid of [customPdf, { ...pdf, customFields: [] }, { ...customPdf, customFields: [{ ...customDefinition, type: 'number' }], fields: [{ ...customPdf.fields[0], type: 'text' }] }]) {
      await db.exec('savepoint valid_custom_pdf; set local role authenticated;');
      await db.exec(insertPdfSql(valid));
      await db.exec('rollback to valid_custom_pdf; release valid_custom_pdf;');
    }
    const invalidPdfs = [
      { ...pdf, storagePath: `${other}/templates/source.pdf` },
      { ...pdf, storagePath: `${t}/templates/%2e%2e/%2e%2e/${other}/source/${'a'.repeat(64)}.pdf` },
      { ...pdf, pageSizes: [{ width: null, height: 842 }] },
      { ...pdf, pageSizes: [{ width: -1, height: 842 }] },
      { ...pdf, pageSizes: [{ width: '595', height: 842 }] },
      { ...pdf, pageSizes: [{ width: 595, height: 842, unknown: true }] },
      { ...pdf, customFields: null },
      { ...pdf, customFields: {} },
      { ...pdf, customFields: Array.from({ length: 51 }, (_, i) => ({ ...customDefinition, id: `custom_${i}` })) },
      { ...customPdf, customFields: [customDefinition, customDefinition] },
      { ...customPdf, customFields: [{ ...customDefinition, type: 'text' }] },
      { ...customPdf, fields: [{ ...customPdf.fields[0], source: 'custom.unknown' }] },
      ...[{ id: '_invalid' }, { label: '' }, { required: null }, { required: 'true' }, { type: 'signature' }, { unknown: true }]
        .map(patch => ({ ...customPdf, customFields: [{ ...customDefinition, ...patch }] })),
      { ...pdf, schemaVersion: '1' },
      { ...pdf, unknown: true },
      ...[
        { required: null }, { required: 'true' }, { label: '' }, { id: '1bad' }, { providerName: '' },
        { source: null }, { fontSize: null }, { unknown: true },
        { placements: [{ page: 0, x: null, y: 0.1, width: 0.5, height: 0.1 }] },
        { placements: [{ page: 0.5, x: 0.1, y: 0.1, width: 0.5, height: 0.1 }] },
        { placements: [{ page: 0, x: 0.1, y: 0.1, width: null, height: 0.1 }] },
        { placements: [{ page: 0, x: 0.1, y: 0.1, width: 0.5, height: 0.1, unknown: true }] },
      ].map(patch => ({ ...pdf, fields: [{ ...pdf.fields[0], ...patch }] })),
      { ...pdf, fields: [pdf.fields[0], pdf.fields[0]] },
    ];
    for (const invalid of invalidPdfs) await refused(insertPdfSql(invalid), 'pdf_template');
    await refused(insertPdfSql({ ...customPdf, fields: [{ ...customPdf.fields[0], type: 'signature' }] }), 'signature_field_cannot_be_prefilled');
    await refused(`update public.contract_template_versions set signature_policy='{"method":"external_esign"}'::jsonb where id='${version}'`, 'approved_template_version_is_immutable');
    console.log('PDF SQL schema parity: valid approved configuration, cross-tenant source, null/nonnumeric geometry, strict properties, required flags, duplicate fields and approved method immutability verified.');
    await db.exec(`update public.tenants set status='suspended' where id='${t}'; set local role authenticated;`);
    const blocked = await db.query(`update public.customers set display_name='Suspended write' where id='${customer}' returning id`);
    await db.exec('reset role;');
    if (blocked.rows.length) throw new Error('Suspended tenant wrote customer data');
  } finally { await db.exec('rollback;'); }
  console.log('PR53 SQL security: read roles, sales transitions, signed/required/generation, two tenants and suspended tenant verified.');
}
