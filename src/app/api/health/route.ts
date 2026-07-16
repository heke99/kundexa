import { NextResponse } from "next/server";
export async function GET(){return NextResponse.json({status:'ok',service:'kundexa-web',time:new Date().toISOString()})}
