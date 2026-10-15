# frozen_string_literal: true

# Kundexa-specific, authenticated API. Uses the pinned upstream attachment/PDF pipeline.
module Api
  class KundexaTemplatesController < ApiBaseController
    MAX_BYTES = 30 * 1024 * 1024

    def create
      authorize!(:create, Template)
      key = params.require(:external_key).to_s
      raise ArgumentError, 'external_key_invalid' unless key.match?(/\A[a-zA-Z0-9_-]{1,128}\z/)
      sha256 = params.require(:source_sha256).to_s
      raise ArgumentError, 'source_sha256_invalid' unless sha256.match?(/\A[a-f0-9]{64}\z/)
      mode = params.require(:mode).to_s
      raise ArgumentError, 'mode_invalid' unless %w[initial reconcile_only].include?(mode)
      role = params.require(:role).to_s
      raise ArgumentError, 'role_invalid' unless role == 'signer'
      fields = normalize_fields(params.require(:fields))
      # Canonical field order is significant and retained; coordinates are normalized.
      payload_hash = Digest::SHA256.hexdigest(JSON.generate([sha256, role, fields]))
      external_id = "kundexa:#{key}"
      template = nil
      # Postgres row lock serializes initial requests and reconciliation for this account.
      current_account.with_lock do
        template = current_account.templates.find_by(external_id:)
        if template
          unless template.preferences['kundexa_payload_sha256'] == payload_hash &&
                 template.preferences['kundexa_frozen'] == true
            return render json: { error: 'kundexa_template_conflict' }, status: :conflict
          end
        elsif mode == 'reconcile_only'
          return render json: { error: 'kundexa_template_not_found' }, status: :not_found
        else
          encoded = params.require(:pdf_base64).to_s
          raise ArgumentError, 'pdf_too_large' if encoded.bytesize > (MAX_BYTES * 4 / 3 + 8)
          bytes = Base64.strict_decode64(encoded)
          raise ArgumentError, 'pdf_invalid' unless bytes.bytesize.between?(5, MAX_BYTES) && bytes.start_with?('%PDF-')
          raise ArgumentError, 'pdf_sha256_mismatch' unless Digest::SHA256.hexdigest(bytes) == sha256
          template = Template.new(name: params[:name].to_s.truncate(200).presence || 'Kundexa avtal',
                                  author: current_user, account: current_account, external_id:,
                                  submitters: [{ 'name' => role, 'uuid' => SecureRandom.uuid }])
          Templates.maybe_assign_access(template)
          template.save!
          Tempfile.create(['kundexa-', '.pdf']) do |file|
            file.binmode
            file.write(bytes)
            file.rewind
            upload = ActionDispatch::Http::UploadedFile.new(tempfile: file, filename: 'contract.pdf', type: 'application/pdf')
            documents, = Templates::CreateAttachments.call(template, { files: [upload] }, extract_fields: false)
            raise ArgumentError, 'pdf_document_count_invalid' unless documents.size == 1
            doc = documents.first
            page_count = doc.metadata.dig('pdf', 'number_of_pages').to_i
            if page_count < 1 || fields.any? { |field| field['areas'].any? { |area| area['page'] >= page_count } }
              raise ArgumentError, 'signature_page_out_of_range'
            end
            # Do not allow the upload pipeline to silently decrypt/replace the source document.
            raise ArgumentError, 'pdf_source_changed' unless Digest::SHA256.hexdigest(doc.download) == sha256
            template.schema = [{ 'attachment_uuid' => doc.uuid, 'name' => 'contract' }]
            template.fields = fields.map do |field|
              { 'uuid' => SecureRandom.uuid, 'submitter_uuid' => template.submitters.first['uuid'],
                'name' => field['name'], 'type' => 'signature', 'required' => field['required'], 'preferences' => {},
                'areas' => field['areas'].map { |area| area.merge('attachment_uuid' => doc.uuid) } }
            end
            template.preferences = template.preferences.merge('kundexa_frozen' => true,
                                                              'kundexa_source_sha256' => sha256,
                                                              'kundexa_payload_sha256' => payload_hash)
            template.save!
          end
        end
      end
      render json: { provider_template_id: template.id.to_s, source_sha256: sha256, payload_sha256: payload_hash }
    rescue ArgumentError, ActionController::ParameterMissing => e
      render json: { error: e.message }, status: :unprocessable_content
    end

    private

    def normalize_fields(raw)
      raise ArgumentError, 'signature_fields_invalid' unless raw.is_a?(Array) && raw.size.between?(1, 100)
      names = []
      raw.map do |field|
        name = field.require(:providerName).to_s
        raise ArgumentError, 'signature_name_invalid' unless name.length.between?(1, 120) && !names.include?(name)
        names << name
        required = field[:required]
        raise ArgumentError, 'signature_required_invalid' unless [true, false].include?(required)
        placements = field.require(:placements)
        raise ArgumentError, 'signature_areas_invalid' unless placements.is_a?(Array) && placements.size.between?(1, 100)
        areas = placements.map do |area|
          page = area.require(:page)
          raise ArgumentError, 'signature_page_invalid' unless page.is_a?(Integer) && page.between?(0, 99)
          values = %w[x y width height].map { |key| Float(area.require(key)) }
          x, y, w, h = values
          unless values.all?(&:finite?) && x >= 0 && y >= 0 && w.positive? && h.positive? && x + w <= 1.000001 && y + h <= 1.000001
            raise ArgumentError, 'signature_area_invalid'
          end
          { 'page' => page, 'x' => x, 'y' => y, 'w' => w, 'h' => h }
        end
        { 'name' => name, 'required' => required, 'areas' => areas }
      end
    end
  end
end
