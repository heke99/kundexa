#!/usr/bin/env sh
set -eu
task_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
task_build=$(mktemp -d)
trap 'rm -rf "$task_build"' EXIT
tar -xzf "$task_root/vendor/docuseal-source.tar.gz" -C "$task_build"
cp -R "$task_root/overlay/." "$task_build/"
# The ported web component already supports these props; wire scoped sessions
# into the original component registration before compiling its Vue bundle.
python3 - "$task_build/app/javascript/application.js" <<'PY'
import sys
from pathlib import Path
p=Path(sys.argv[1]); s=p.read_text()
anchor='this.app = createApp(TemplateBuilder, {\n      template,'
assert anchor in s
s=s.replace(anchor, anchor+'\n      baseUrl: this.dataset.baseUrl || "",\n      fetchOptions: JSON.parse(this.dataset.fetchOptions || "{}"),',1)
s=s.replace('withRevisions: true,', 'withRevisions: !this.dataset.baseUrl,',1)
s=s.replace('withReplaceAndCloneUpload: true,', 'withReplaceAndCloneUpload: !this.dataset.baseUrl,',1)
s=s.replace('withDownload: true,', 'withDownload: !this.dataset.baseUrl,',1)
p.write_text(s)

# Swedish is Kundexa's default language. The pinned upstream does not provide
# sv; layer our flow translations over its English fallback in both Vue UIs.
import json
task_source_root=Path(sys.argv[1]).parents[2]
for component, name in [('submission_form', 'signing'), ('template_builder', 'builder')]:
    p=task_source_root/'app/javascript'/component/'i18n.js'
    s=p.read_text()
    translations=json.loads((task_source_root/'app/javascript/kundexa/locales'/f'{name}-sv.json').read_text())
    anchor='const i18n = { en,' if component == 'submission_form' else 'export { en,'
    assert anchor in s
    localized_export='const i18n = { sv, en,' if component == 'submission_form' else 'export { sv, en,'
    s=s.replace(anchor, 'const sv = { ...en, ...'+json.dumps(translations, ensure_ascii=False)+' }\n\n'+localized_export, 1)
    p.write_text(s)
PY
docker build -t kundexa-documents:2026-10-13 "$task_build"
