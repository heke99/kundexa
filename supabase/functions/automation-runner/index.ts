import { createClient } from "npm:@supabase/supabase-js@2.110.7";

const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const cronSecret = Deno.env.get("CRON_SECRET")!;
const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Run = {
  id: string;
  tenant_id: string;
  automation_id: string;
  version_id: string;
  trigger_event_id: string;
  entity_type: string | null;
  entity_id: string | null;
  input: Record<string, Json>;
  attempts: number;
};
type Condition = { field?: string; operator?: string; value?: Json };
type Action = Record<string, Json> & { type?: string };
type Version = {
  conditions: Condition[];
  exceptions: Condition[];
  actions: Action[];
  limits: Record<string, Json>;
  test_mode: boolean;
};

type Customer = {
  id: string;
  tenant_id: string;
  display_name: string;
  email: string | null;
  phone_e164: string | null;
  lifecycle: string;
  do_not_call: boolean;
  do_not_sms: boolean;
  do_not_email: boolean;
  assigned_user_id: string | null;
  assigned_team_id: string | null;
  custom_fields: Record<string, Json>;
};

function pathValue(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, part) => {
    if (value && typeof value === "object" && !Array.isArray(value)) return (value as Record<string, unknown>)[part];
    return undefined;
  }, source);
}

function compare(actual: unknown, condition: Condition): boolean {
  const operator = condition.operator ?? "equals";
  const expected = condition.value;
  if (operator === "exists") return expected === false ? actual == null : actual != null;
  if (operator === "equals" || operator === "eq") return JSON.stringify(actual) === JSON.stringify(expected);
  if (operator === "not_equals" || operator === "neq") return JSON.stringify(actual) !== JSON.stringify(expected);
  if (operator === "in") return Array.isArray(expected) && expected.some((value) => JSON.stringify(value) === JSON.stringify(actual));
  if (operator === "not_in") return Array.isArray(expected) && !expected.some((value) => JSON.stringify(value) === JSON.stringify(actual));
  if (operator === "contains") return Array.isArray(actual) ? actual.includes(expected) : String(actual ?? "").includes(String(expected ?? ""));
  if (operator === "starts_with") return String(actual ?? "").startsWith(String(expected ?? ""));
  if (operator === "gt") return Number(actual) > Number(expected);
  if (operator === "gte") return Number(actual) >= Number(expected);
  if (operator === "lt") return Number(actual) < Number(expected);
  if (operator === "lte") return Number(actual) <= Number(expected);
  return false;
}

function matchesAll(context: Record<string, unknown>, conditions: Condition[]) {
  return conditions.every((condition) => condition.field && compare(pathValue(context, condition.field), condition));
}

function limitNumber(limits: Record<string, Json>, key: string, fallback: number) {
  const value = Number(limits[key] ?? fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

async function getCustomer(run: Run): Promise<Customer | null> {
  let customerId = run.entity_type === "customer" ? run.entity_id : null;
  if (!customerId && run.entity_type === "contract" && run.entity_id) {
    const { data } = await supabase.from("contracts").select("customer_id").eq("tenant_id", run.tenant_id).eq("id", run.entity_id).maybeSingle();
    customerId = data?.customer_id ?? null;
  }
  if (!customerId) return null;
  const { data, error } = await supabase.from("customers").select("id,tenant_id,display_name,email,phone_e164,lifecycle,do_not_call,do_not_sms,do_not_email,assigned_user_id,assigned_team_id,custom_fields")
    .eq("tenant_id", run.tenant_id).eq("id", customerId).maybeSingle();
  if (error) throw error;
  return data as Customer | null;
}

async function complianceBlocked(tenantId: string, customer: Customer, channel: "call" | "sms" | "email") {
  if ((channel === "call" && customer.do_not_call) || (channel === "sms" && customer.do_not_sms) || (channel === "email" && customer.do_not_email)) return true;
  const now = new Date().toISOString();
  const { data, error } = await supabase.from("compliance_blocks").select("id")
    .eq("tenant_id", tenantId).eq("active", true).contains("channels", [channel])
    .or(`customer_id.eq.${customer.id}${customer.phone_e164 ? `,phone_e164.eq.${customer.phone_e164}` : ""}${customer.email ? `,email.eq.${customer.email}` : ""}`)
    .or(`expires_at.is.null,expires_at.gt.${now}`).limit(1);
  if (error) throw error;
  return Boolean(data?.length);
}

async function queueSms(run: Run, customer: Customer, action: Action, index: number) {
  if (!customer.phone_e164 || await complianceBlocked(run.tenant_id, customer, "sms")) return { skipped: "sms_not_allowed" };
  const { data: number, error: numberError } = await supabase.from("phone_numbers").select("number_e164")
    .eq("tenant_id", run.tenant_id).eq("supports_sms", true).eq("status", "active").order("created_at").limit(1).maybeSingle();
  if (numberError) throw numberError;
  if (!number) return { skipped: "sms_number_missing" };
  const body = String(action.body ?? action.message ?? "Automatiserad uppföljning från {{tenant}}.").replaceAll("{{customer}}", customer.display_name);
  const idempotencyKey = `automation:${run.id}:sms:${index}`;
  const { data: message, error } = await supabase.from("sms_messages").upsert({
    tenant_id: run.tenant_id,
    customer_id: customer.id,
    direction: "outbound",
    from_number: number.number_e164,
    to_number: customer.phone_e164,
    body,
    status: "queued",
    idempotency_key: idempotencyKey,
  }, { onConflict: "tenant_id,idempotency_key" }).select("id").single();
  if (error) throw error;
  const { error: outboxError } = await supabase.from("outbox_jobs").upsert({
    tenant_id: run.tenant_id,
    job_type: "sms.send",
    aggregate_type: "sms_message",
    aggregate_id: message.id,
    payload: { automation_run_id: run.id },
    idempotency_key: `sms.send:${message.id}`,
  }, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true });
  if (outboxError) throw outboxError;
  return { queued: "sms", id: message.id };
}

async function queueEmail(run: Run, customer: Customer, action: Action, index: number) {
  if (!customer.email || await complianceBlocked(run.tenant_id, customer, "email")) return { skipped: "email_not_allowed" };
  const subject = String(action.subject ?? "Uppföljning").replaceAll("{{customer}}", customer.display_name);
  const body = String(action.body ?? "Hej {{customer}}, vi följer upp vårt tidigare ärende.").replaceAll("{{customer}}", customer.display_name);
  const idempotencyKey = `automation:${run.id}:email:${index}`;
  const { data: message, error } = await supabase.from("email_messages").upsert({
    tenant_id: run.tenant_id,
    customer_id: customer.id,
    direction: "outbound",
    from_address: "pending@kundexa.local",
    to_addresses: [customer.email],
    subject,
    body_text: body,
    status: "queued",
    idempotency_key: idempotencyKey,
  }, { onConflict: "tenant_id,idempotency_key" }).select("id").single();
  if (error) throw error;
  const { error: outboxError } = await supabase.from("outbox_jobs").upsert({
    tenant_id: run.tenant_id,
    job_type: "email.send",
    aggregate_type: "email_message",
    aggregate_id: message.id,
    payload: { automation_run_id: run.id },
    idempotency_key: `email.send:${message.id}`,
  }, { onConflict: "tenant_id,idempotency_key", ignoreDuplicates: true });
  if (outboxError) throw outboxError;
  return { queued: "email", id: message.id };
}

async function executeAction(run: Run, customer: Customer | null, action: Action, index: number) {
  const type = String(action.type ?? "");
  if (type === "create_activity") {
    if (!customer) return { skipped: "customer_missing" };
    const metadata = { automation_run_id: run.id, action_index: index };
    const { data: existing } = await supabase.from("activities").select("id").eq("tenant_id", run.tenant_id).eq("customer_id", customer.id).contains("metadata", metadata).maybeSingle();
    if (existing) return { existing: existing.id };
    const dueMinutes = Number(action.due_minutes ?? 0);
    const dueAt = dueMinutes > 0 ? new Date(Date.now() + dueMinutes * 60000).toISOString() : null;
    const { data, error } = await supabase.from("activities").insert({
      tenant_id: run.tenant_id,
      customer_id: customer.id,
      type: String(action.activity_type ?? "task"),
      title: String(action.title ?? "Automatiserad uppföljning"),
      description: action.description ? String(action.description) : null,
      assigned_user_id: action.assigned_user_id ? String(action.assigned_user_id) : customer.assigned_user_id,
      assigned_team_id: action.assigned_team_id ? String(action.assigned_team_id) : customer.assigned_team_id,
      priority: String(action.priority ?? "normal"),
      due_at: dueAt,
      metadata,
    }).select("id").single();
    if (error) throw error;
    return { created: "activity", id: data.id };
  }
  if (type === "block_contact") {
    if (!customer) return { skipped: "customer_missing" };
    const channels = Array.isArray(action.channels) ? action.channels.map(String) : ["call", "sms", "email"];
    const source = `automation:${run.id}:${index}`;
    const { data: existing } = await supabase.from("compliance_blocks").select("id").eq("tenant_id", run.tenant_id).eq("customer_id", customer.id).eq("source", source).maybeSingle();
    if (!existing) {
      const { error } = await supabase.from("compliance_blocks").insert({
        tenant_id: run.tenant_id,
        customer_id: customer.id,
        phone_e164: customer.phone_e164,
        email: customer.email,
        channels,
        reason: String(action.reason ?? "Automationsregel"),
        source,
      });
      if (error) throw error;
    }
    const update: Record<string, boolean | string> = { blocked_reason: String(action.reason ?? "Automationsregel") };
    if (channels.includes("call")) update.do_not_call = true;
    if (channels.includes("sms")) update.do_not_sms = true;
    if (channels.includes("email")) update.do_not_email = true;
    if (channels.length === 3) update.lifecycle = "blocked";
    const { error } = await supabase.from("customers").update(update).eq("tenant_id", run.tenant_id).eq("id", customer.id);
    if (error) throw error;
    return { blocked: channels };
  }
  if (type === "update_status") {
    if (!customer) return { skipped: "customer_missing" };
    const lifecycle = String(action.lifecycle ?? action.status ?? "lead");
    const allowed = ["prospect", "lead", "customer", "former_customer", "lost", "blocked"];
    if (!allowed.includes(lifecycle)) throw new Error("automation_lifecycle_invalid");
    const { error } = await supabase.from("customers").update({ lifecycle }).eq("tenant_id", run.tenant_id).eq("id", customer.id);
    if (error) throw error;
    return { lifecycle };
  }
  if (type === "assign_customer") {
    if (!customer) return { skipped: "customer_missing" };
    const update = {
      assigned_user_id: action.user_id ? String(action.user_id) : customer.assigned_user_id,
      assigned_team_id: action.team_id ? String(action.team_id) : customer.assigned_team_id,
    };
    const { error } = await supabase.from("customers").update(update).eq("tenant_id", run.tenant_id).eq("id", customer.id);
    if (error) throw error;
    return { assigned: update };
  }
  if (type === "send_sms") return customer ? queueSms(run, customer, action, index) : { skipped: "customer_missing" };
  if (type === "send_email") return customer ? queueEmail(run, customer, action, index) : { skipped: "customer_missing" };
  throw new Error(`unsupported_automation_action:${type}`);
}

async function processRun(run: Run) {
  const [{ data: version, error: versionError }, { data: rule, error: ruleError }, customer] = await Promise.all([
    supabase.from("automation_versions").select("conditions,exceptions,actions,limits,test_mode").eq("tenant_id", run.tenant_id).eq("id", run.version_id).single(),
    supabase.from("automation_rules").select("status,name").eq("tenant_id", run.tenant_id).eq("id", run.automation_id).single(),
    getCustomer(run),
  ]);
  if (versionError || !version) throw new Error(`automation_version_missing:${versionError?.message ?? ""}`);
  if (ruleError || !rule || rule.status !== "active") return { skipped: "automation_not_active" };
  const v = version as Version;
  const context: Record<string, unknown> = { input: run.input, customer, event: run.input, entity: { type: run.entity_type, id: run.entity_id } };
  if (!matchesAll(context, v.conditions ?? [])) return { skipped: "conditions_not_met" };
  if ((v.exceptions ?? []).length && matchesAll(context, v.exceptions)) return { skipped: "exception_matched" };

  const maxPerEntity = limitNumber(v.limits ?? {}, "max_executions_per_entity", 1);
  if (maxPerEntity > 0 && run.entity_id) {
    const { count, error } = await supabase.from("automation_runs").select("id", { count: "exact", head: true })
      .eq("tenant_id", run.tenant_id).eq("automation_id", run.automation_id).eq("entity_id", run.entity_id).eq("status", "completed");
    if (error) throw error;
    if ((count ?? 0) >= maxPerEntity) return { skipped: "entity_execution_limit" };
  }

  const maxActions = Math.min(50, limitNumber(v.limits ?? {}, "max_actions_per_run", 20));
  const actions = (v.actions ?? []).slice(0, maxActions);
  if (v.test_mode) return { simulated: true, actions };
  const results = [];
  let smsCount = 0;
  let emailCount = 0;
  for (const [index, action] of actions.entries()) {
    if (action.type === "send_sms" && smsCount >= limitNumber(v.limits ?? {}, "max_sms_per_run", 1)) { results.push({ skipped: "sms_limit" }); continue; }
    if (action.type === "send_email" && emailCount >= limitNumber(v.limits ?? {}, "max_email_per_run", 1)) { results.push({ skipped: "email_limit" }); continue; }
    const result = await executeAction(run, customer, action, index);
    if (action.type === "send_sms" && "queued" in result) smsCount++;
    if (action.type === "send_email" && "queued" in result) emailCount++;
    results.push(result);
  }
  return { actions_executed: results.length, results };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  if (request.headers.get("x-cron-secret") !== cronSecret) return new Response("Forbidden", { status: 403 });
  const worker = `automation-${crypto.randomUUID()}`;
  const { data: runs, error } = await supabase.rpc("claim_automation_runs", { p_worker: worker, p_limit: 25 });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  const results = [];
  for (const raw of (runs ?? []) as Run[]) {
    try {
      const output = await processRun(raw);
      const { error: completionError } = await supabase.from("automation_runs").update({
        status: "completed",
        output,
        completed_at: new Date().toISOString(),
        locked_at: null,
        locked_by: null,
      }).eq("id", raw.id).eq("tenant_id", raw.tenant_id);
      if (completionError) throw completionError;
      results.push({ id: raw.id, status: "completed", output });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const dead = raw.attempts >= 10;
      await supabase.from("automation_runs").update({
        status: dead ? "dead_letter" : "failed",
        error: message.slice(0, 4000),
        available_at: new Date(Date.now() + Math.min(3600000, 15000 * 2 ** Math.min(raw.attempts, 8))).toISOString(),
        completed_at: dead ? new Date().toISOString() : null,
        locked_at: null,
        locked_by: null,
      }).eq("id", raw.id).eq("tenant_id", raw.tenant_id);
      results.push({ id: raw.id, status: dead ? "dead_letter" : "failed", error: message });
    }
  }
  return Response.json({ worker, claimed: runs?.length ?? 0, results });
});
