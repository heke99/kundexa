# frozen_string_literal: true
module Kundexa
  class TemplatesController < Api::ApiBaseController
    skip_authorization_check

    def create
      authorize!(:create, Template)
      external_id = params.require(:external_id).to_s
      raise ArgumentError, 'invalid_external_id' unless external_id.match?(/\Akundexa:[a-f0-9-]{36}:[a-f0-9-]{36}\z/)
      # Serialize creation with a durable ledger, including duplicate HTTP retries.
      operation = KundexaOperation.create_or_find_by!(account_id: current_account.id, operation_key: "template:#{external_id}") do |op|
        op.request_hash = Digest::SHA256.hexdigest(params[:file].read)
        params[:file].rewind
      end
      operation.with_lock do
        digest = Digest::SHA256.hexdigest(params[:file].read)
        params[:file].rewind
        raise ArgumentError, 'idempotency_payload_conflict' unless operation.request_hash == digest
        if operation.result
          render json: operation.result
          return
        end
        raise ArgumentError, 'pdf_required' unless params[:file].content_type == 'application/pdf'
        template = Template.create!(name: params[:name].presence || 'Avtalsmall', account: current_account,
                                    author: current_user, external_id:, submitters: [{ 'name' => 'Kund', 'uuid' => SecureRandom.uuid }])
        documents, = Templates::CreateAttachments.call(template, { files: [params[:file]] }, extract_fields: false)
        template.update!(schema: documents.map { |doc| { 'attachment_uuid' => doc.uuid, 'name' => doc.filename.base } })
        operation.update!(result: { id: template.id, external_id: })
        render json: operation.result
      end
    rescue ArgumentError => e
      render json: { error: e.message }, status: :unprocessable_content
    end

    def snapshot
      template = Template.accessible_by(current_ability).find(params[:id])
      authorize!(:read, template)
      snapshot = self.class.snapshot_data(template)
      if params[:lock] == true
        authorize!(:update, template)
        template.with_lock do
          snapshot = self.class.snapshot_data(template)
          unless params[:expected_schema_hash] == snapshot[:schema_hash]
            return render json: { error: 'template_changed_while_saving' }, status: :conflict
          end
          template.update!(preferences: template.preferences.merge('kundexa_locked' => true))
        end
      end
      render json: snapshot
    end

    def self.snapshot_data(template)
      documents = template.schema_documents.map do |a|
        { 'uuid' => a.uuid, 'sha256' => Digest::SHA256.hexdigest(a.blob.download), 'filename' => a.filename.to_s }
      end
      data = { 'schema' => template.schema, 'fields' => template.fields, 'submitters' => template.submitters, 'documents' => documents }
      { id: template.id, external_id: template.external_id, schema_hash: Digest::SHA256.hexdigest(canonical(data)), data: }
    end

    def self.canonical(value)
      case value
      when Hash then '{' + value.keys.sort.map { |key| key.to_json + ':' + canonical(value[key]) }.join(',') + '}'
      when Array then '[' + value.map { |item| canonical(item) }.join(',') + ']'
      else value.to_json
      end
    end
  end
end
