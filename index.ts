import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SECRET_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SECRET_KEY);
const ORIGIN = "https://qgjta99-code.github.io";
const BUCKET = "customer-files";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const TYPES: Record<string, string[]> = {
  pdf: ["application/pdf"],
  doc: ["application/msword"],
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  xls: ["application/vnd.ms-excel"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
};
const cors = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Vary": "Origin",
};
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  const origin = req.headers.get("origin");
  if (origin !== ORIGIN) return json({ error: "Origin not allowed" }, 403);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let customer_name = "", customer_email = "", service_type = "", description = "";
  let attachment: File | null = null;
  try {
    const type = req.headers.get("content-type") || "";
    if (type.includes("multipart/form-data")) {
      const form = await req.formData();
      customer_name = String(form.get("customer_name") ?? "").trim();
      customer_email = String(form.get("customer_email") ?? "").trim();
      service_type = String(form.get("service_type") ?? "").trim();
      description = String(form.get("description") ?? "").trim();
      const value = form.get("attachment");
      if (value instanceof File && value.size > 0) attachment = value;
    } else if (type.includes("application/json")) {
      const body = await req.json();
      customer_name = String(body.customer_name ?? "").trim();
      customer_email = String(body.customer_email ?? "").trim();
      service_type = String(body.service_type ?? "").trim();
      description = String(body.description ?? "").trim();
    } else return json({ error: "Unsupported content type" }, 415);
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  if (customer_name.length < 2 || customer_name.length > 120 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer_email) || customer_email.length > 254 ||
      service_type.length < 2 || service_type.length > 120 ||
      description.length < 10 || description.length > 3000) {
    return json({ error: "Invalid request data" }, 400);
  }

  let extension = "";
  if (attachment) {
    extension = attachment.name.split(".").pop()?.toLowerCase() ?? "";
    if (!TYPES[extension] || !TYPES[extension].includes(attachment.type) ||
        attachment.size > MAX_FILE_SIZE) {
      return json({ error: "Unsupported file type or size (maximum 10 MB)" }, 400);
    }
    const signature = new Uint8Array(await attachment.slice(0, 8).arrayBuffer());
    const isPdf = signature[0] === 0x25 && signature[1] === 0x50 && signature[2] === 0x44 && signature[3] === 0x46;
    const isZip = signature[0] === 0x50 && signature[1] === 0x4b && [0x03, 0x05, 0x07].includes(signature[2]);
    const isOle = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => signature[i] === b);
    if ((extension === "pdf" && !isPdf) ||
        (["docx", "xlsx"].includes(extension) && !isZip) ||
        (["doc", "xls"].includes(extension) && !isOle)) {
      return json({ error: "File contents do not match the extension" }, 400);
    }
  }

  // A request is inserted first so the file path can be linked to its UUID.
  const { data: request, error: insertError } = await supabase.from("service_requests")
    .insert({ customer_name, customer_email, service_type, description, status: "جديد" })
    .select("id").single();
  if (insertError || !request) {
    console.error("Request insert failed:", insertError?.message);
    return json({ error: "Unable to save request" }, 500);
  }

  if (attachment) {
    const path = `${request.id}/${crypto.randomUUID()}.${extension}`;
    const { error: uploadError } = await supabase.storage.from(BUCKET)
      .upload(path, attachment, { contentType: attachment.type, upsert: false });
    if (uploadError) {
      console.error("File upload failed:", uploadError.message);
      await supabase.from("service_requests").delete().eq("id", request.id);
      return json({ error: "Unable to upload attachment" }, 500);
    }
    const { error: updateError } = await supabase.from("service_requests")
      .update({ file_path: path }).eq("id", request.id);
    if (updateError) {
      console.error("File link failed:", updateError.message);
      await supabase.storage.from(BUCKET).remove([path]);
      await supabase.from("service_requests").delete().eq("id", request.id);
      return json({ error: "Unable to link attachment" }, 500);
    }
  }
  return json({ success: true }, 201);
});
