# frozen_string_literal: true
module Kundexa
  class SubmissionsController < Api::SubmissionsController
    around_action :idempotent_create, only: :create

    private

    def idempotent_create
      key = request.headers['Idempotency-Key'].to_s
      raise ArgumentError, 'idempotency_key_required' unless key.length.between?(8, 200)
      # Never let CRM data mark the customer as having signed.
      if Array.wrap(params[:submitters]).any? { |s| s[:completed].present? }
        raise ArgumentError, 'customer_auto_signature_forbidden'
      end
      params[:send_email] = false
      params[:send_sms] = false
      digest = Digest::SHA256.hexdigest(TemplatesController.canonical(params.except(:controller, :action).to_unsafe_h))
      operation = KundexaOperation.create_or_find_by!(account_id: current_account.id, operation_key: "submission:#{key}") do |op|
        op.request_hash = digest
      end
      operation.with_lock do
        raise ArgumentError, 'idempotency_payload_conflict' unless operation.request_hash == digest
        if operation.result
          render json: operation.result
          return
        end
        @template.with_lock do
          snapshot = TemplatesController.snapshot_data(@template)
          raise ArgumentError, 'template_schema_changed' unless params[:schema_hash] == snapshot[:schema_hash]
          raise ArgumentError, 'locked_template_required' unless @template.preferences['kundexa_locked'] == true
          yield
          if response.status < 300
            operation.update!(result: JSON.parse(response.body))
          end
        end
      end
    rescue ArgumentError => e
      render json: { error: e.message }, status: :conflict
    end
  end
end
