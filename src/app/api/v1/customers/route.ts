import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticateRequest, dataClientForIdentity } from "@/lib/api-auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizePhone } from "@/lib/domain/phone";
import { buildIlikeOrFilter } from "@/lib/postgrest-filter";
import { sha256 } from "@/lib/crypto";

const createCustomerSchema = z.object({
  customer_type: z.enum(["person", "company"]),
  display_name: z.string().min(2),
  lifecycle: z.enum(["prospect", "lead", "customer"]).default("prospect"),
  email: z.email().optional(),
  phone: z.string().optional(),
  organization_number: z.string().optional(),
  city: z.string().optional(),
  idempotency_key: z.string().min(8).max(200).optional(),
});

export async function GET(request: Request) {
  try {
    const identity = await authenticateRequest(request, "customers:read");
    const url = new URL(request.url);
    const q = url.searchParams.get("q");
    const limit = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);
    const db = await dataClientForIdentity(identity);
    let query = db.from("customers")
      .select("id,customer_type,lifecycle,display_name,email,phone_e164,organization_number,city,county,industry,sni_code,assigned_user_id,assigned_team_id,do_not_call,do_not_sms,do_not_email,updated_at")
      .eq("tenant_id", identity.tenantId)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(limit);
    const search = q ? buildIlikeOrFilter(["display_name", "organization_number", "phone_e164", "email"], q) : null;
    if (search) query = query.or(search);
    const { data, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ data, meta: { count: data.length, limit } });
  } catch (error) {
    if (error instanceof Response) return error;
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const identity = await authenticateRequest(request, "customers:write");
    const parsed = createCustomerSchema.parse(await request.json());
    const phone = parsed.phone ? normalizePhone(parsed.phone) : null;
    const db = await dataClientForIdentity(identity);
    const admin = createAdminClient();
    const customerInput = {
      customer_type: parsed.customer_type,
      display_name: parsed.display_name,
      lifecycle: parsed.lifecycle,
      email: parsed.email?.toLowerCase() ?? null,
      phone_e164: phone,
      organization_number: parsed.organization_number ?? null,
      city: parsed.city ?? null,
    };

    let customerId = crypto.randomUUID();
    let requestFingerprint: string | null = null;

    if (parsed.idempotency_key) {
      requestFingerprint = sha256(JSON.stringify(customerInput));

      // Backward-compatible replay for requests created before the reservation model.
      const { data: legacy } = await admin.from("audit_logs")
        .select("entity_id")
        .eq("tenant_id", identity.tenantId)
        .eq("request_id", parsed.idempotency_key)
        .eq("action", "customer.created")
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (legacy?.entity_id) {
        const { data } = await admin.from("customers")
          .select("*")
          .eq("tenant_id", identity.tenantId)
          .eq("id", legacy.entity_id)
          .maybeSingle();
        if (data) return NextResponse.json({ data, idempotent_replay: true }, { status: 200 });
      }

      const reservationPayload = { state: "reserved", request_fingerprint: requestFingerprint };
      const reservation = await admin.from("audit_logs").insert({
        tenant_id: identity.tenantId,
        actor_user_id: identity.userId,
        action: "customer.api_created",
        entity_type: "customer",
        entity_id: customerId,
        request_id: parsed.idempotency_key,
        after_data: reservationPayload,
      }).select("entity_id,after_data").maybeSingle();

      if (reservation.error && reservation.error.code !== "23505") {
        return NextResponse.json({ error: "idempotency_reservation_failed" }, { status: 500 });
      }

      if (reservation.error?.code === "23505" || !reservation.data) {
        const { data: existingReservation, error: reservationReadError } = await admin.from("audit_logs")
          .select("entity_id,after_data")
          .eq("tenant_id", identity.tenantId)
          .eq("request_id", parsed.idempotency_key)
          .eq("action", "customer.api_created")
          .single();
        if (reservationReadError || !existingReservation?.entity_id) {
          return NextResponse.json({ error: "idempotency_reservation_unavailable" }, { status: 409 });
        }
        const metadata = existingReservation.after_data && typeof existingReservation.after_data === "object" && !Array.isArray(existingReservation.after_data)
          ? existingReservation.after_data as Record<string, unknown>
          : {};
        if (metadata.request_fingerprint && metadata.request_fingerprint !== requestFingerprint) {
          return NextResponse.json({ error: "idempotency_key_reused_with_different_payload" }, { status: 409 });
        }
        customerId = existingReservation.entity_id;
        const { data: existingCustomer } = await admin.from("customers")
          .select("*")
          .eq("tenant_id", identity.tenantId)
          .eq("id", customerId)
          .maybeSingle();
        if (existingCustomer) return NextResponse.json({ data: existingCustomer, idempotent_replay: true }, { status: 200 });
      }
    }

    const { data, error } = await db.from("customers").insert({
      id: customerId,
      tenant_id: identity.tenantId,
      ...customerInput,
      created_by: identity.userId,
    }).select("*").single();

    if (error) {
      if (parsed.idempotency_key && error.code === "23505") {
        const { data: replay } = await admin.from("customers")
          .select("*")
          .eq("tenant_id", identity.tenantId)
          .eq("id", customerId)
          .maybeSingle();
        if (replay) return NextResponse.json({ data: replay, idempotent_replay: true }, { status: 200 });
      }
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

    if (parsed.idempotency_key) {
      const { error: auditError } = await admin.from("audit_logs").update({
        after_data: { state: "committed", request_fingerprint: requestFingerprint, customer: data },
      })
        .eq("tenant_id", identity.tenantId)
        .eq("request_id", parsed.idempotency_key)
        .eq("action", "customer.api_created")
        .eq("entity_id", customerId);
      if (auditError) console.error("customer_idempotency_audit_finalize_failed", { tenantId: identity.tenantId, customerId });
    } else {
      await db.from("audit_logs").insert({
        tenant_id: identity.tenantId,
        actor_user_id: identity.userId,
        action: "customer.created",
        entity_type: "customer",
        entity_id: data.id,
        after_data: data,
      });
    }

    return NextResponse.json({ data }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return error;
    if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
