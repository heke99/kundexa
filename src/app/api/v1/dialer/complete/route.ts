import { NextResponse } from "next/server";
import { z } from "zod";
import { getAppContext } from "@/lib/auth";
import { assertPermission } from "@/lib/permissions";
import { zonedLocalDateTimeToIso } from "@/lib/domain/time";
import { createClient } from "@/lib/supabase/server";

const bodySchema = z.object({
  callId: z.uuid(),
  dispositionKey: z.string().regex(/^[a-z0-9_]{2,50}$/),
  notes: z.string().max(10000).nullable().optional(),
  callbackScope: z.enum(["personal", "global"]).nullable().optional(),
  callbackDueAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/).nullable().optional(),
  createOrder: z.boolean().default(false),
  productId: z.uuid().nullable().optional(),
  quantity: z.number().positive().max(100000).nullable().optional(),
  unitPrice: z.number().nonnegative().max(1_000_000_000).nullable().optional(),
  idempotencyKey: z.string().min(8).max(200),
});

export async function POST(request: Request) {
  try {
    const context = await getAppContext();
    assertPermission(context.role, "calls.create");
    const body = bodySchema.parse(await request.json());
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("complete_dialer_work", {
      p_call_id: body.callId,
      p_disposition_key: body.dispositionKey,
      p_notes: body.notes ?? null,
      p_callback_scope: body.callbackScope ?? null,
      p_callback_due_at: body.callbackDueAt ? zonedLocalDateTimeToIso(body.callbackDueAt, context.tenantTimezone) : null,
      p_create_order: body.createOrder,
      p_product_id: body.productId ?? null,
      p_quantity: body.quantity ?? null,
      p_unit_price: body.unitPrice ?? null,
      p_idempotency_key: body.idempotencyKey,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 409 });
    return NextResponse.json(data);
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: "validation_error", details: error.issues }, { status: 422 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "internal_error" }, { status: 500 });
  }
}
