"""Isolated engine flow probe. Creates one synthetic PDF/order, sends no messages."""
import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request
import uuid

origin = os.environ["DOCUMENTS_CHECK_URL"].rstrip("/")
api_key = os.environ["KUNDEXA_DOCUMENTS_API_KEY"]
secret = os.environ["KUNDEXA_DOCUMENTS_SECRET"]


def request(path, body=None, headers=None, method=None, expected=200):
    if isinstance(body, dict):
        body = json.dumps(body).encode()
        headers = {"Content-Type": "application/json", **(headers or {})}
    req = urllib.request.Request(origin + path, body,
        {"X-Auth-Token": api_key, **(headers or {})}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as result:
            status, data = result.status, result.read()
    except urllib.error.HTTPError as error:
        status, data = error.code, error.read()
    if status != expected:
        raise RuntimeError(f"engine_flow_http_{status}_expected_{expected}: {path}")
    return data


# A standards-compliant one-page PDF; no external files or document libraries.
stream = b"BT /F1 18 Tf 50 760 Td (Kundexa isolated PDF flow) Tj ET"
objects = [b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Length " + str(len(stream)).encode() + b" >>\nstream\n" + stream + b"\nendstream"]
pdf = b"%PDF-1.4\n"
offsets = [0]
for index, obj in enumerate(objects, 1):
    offsets.append(len(pdf))
    pdf += f"{index} 0 obj\n".encode() + obj + b"\nendobj\n"
start = len(pdf)
pdf += b"xref\n0 6\n0000000000 65535 f \n" + b"".join(f"{offset:010d} 00000 n \n".encode() for offset in offsets[1:])
pdf += f"trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF\n".encode()

external_id = f"kundexa:{uuid.uuid4()}:{uuid.uuid4()}"
boundary = "kundexa-" + uuid.uuid4().hex
parts = []
for name, value in {"name": "Isolated PDF flow", "external_id": external_id}.items():
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="probe.pdf"\r\nContent-Type: application/pdf\r\n\r\n'.encode() + pdf + b"\r\n")
parts.append(f"--{boundary}--\r\n".encode())
uploaded = json.loads(request("/kundexa/templates", b"".join(parts),
    {"Content-Type": f"multipart/form-data; boundary={boundary}"}, "POST"))
template_id = uploaded["id"]
snapshot = json.loads(request(f"/kundexa/templates/{template_id}/snapshot", {}, method="POST"))
assert snapshot["external_id"] == external_id
submitter_uuid = snapshot["data"]["submitters"][0]["uuid"]
attachment_uuid = snapshot["data"]["documents"][0]["uuid"]

payload = {"purpose": "builder", "template_id": template_id, "external_id": external_id, "exp": int(time.time()) + 600}
encoded = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
signature = base64.urlsafe_b64encode(hmac.new(secret.encode(), encoded.encode(), hashlib.sha256).digest()).decode().rstrip("=")
builder_headers = {"X-Kundexa-Builder": encoded + "." + signature}
fields = [{"uuid": str(uuid.uuid4()), "name": name, "type": kind, "submitter_uuid": submitter_uuid,
    "required": True, "areas": [{"x": .1, "y": y, "w": .5, "h": .05, "page": 0, "attachment_uuid": attachment_uuid}]}
    for name, kind, y in [("Kundnamn", "text", .15), ("Underskrift", "signature", .3)]]
request(f"/kundexa/templates/{template_id}", {"template": {"fields": fields}}, builder_headers, "PUT")
placed = json.loads(request(f"/kundexa/templates/{template_id}/snapshot", {}, method="POST"))
assert len(placed["data"]["fields"]) == 2
locked = json.loads(request(f"/kundexa/templates/{template_id}/snapshot",
    {"lock": True, "expected_schema_hash": placed["schema_hash"]}, method="POST"))
assert locked["schema_hash"] == placed["schema_hash"]

order = {"template_id": template_id, "schema_hash": locked["schema_hash"], "send_email": False, "send_sms": False,
    "submitters": [{"name": "Kontrollerad kund", "email": "controlled@example.test", "role": "Kund",
        "values": {"Kundnamn": "Kontrollerad kund AB"}, "readonly_fields": ["Kundnamn"], "send_email": False}]}
headers = {"Idempotency-Key": "isolated:" + uuid.uuid4().hex}
first = json.loads(request("/kundexa/submissions", order, headers, "POST"))
replay = json.loads(request("/kundexa/submissions", order, headers, "POST"))
assert first[0]["submission_id"] == replay[0]["submission_id"]
assert first[0]["completed_at"] is None
changed = {**order, "submitters": [{**order["submitters"][0], "name": "Different recipient"}]}
request("/kundexa/submissions", changed, headers, "POST", expected=409)
automatic = {**order, "submitters": [{**order["submitters"][0], "completed": True}]}
request("/kundexa/submissions", automatic, {"Idempotency-Key": "isolated:auto-sign-denied"}, "POST", expected=409)
documents = json.loads(request(f'/api/submissions/{first[0]["submission_id"]}/documents?merge=true'))
assert len(documents["documents"]) == 1
with urllib.request.urlopen(documents["documents"][0]["url"], timeout=30) as response:
    assert response.read().startswith(b"%PDF-")
print("PASS synthetic PDF upload, field placement, fingerprint lock, readonly prefill, preview rendering, idempotent replay and auto-sign denial; no emails or real signatures")
