# frozen_string_literal: true
module Kundexa
  class BuilderController < ApplicationController
    skip_before_action :authenticate_user!, :maybe_redirect_to_setup, :sign_in_for_demo
    skip_authorization_check
    skip_forgery_protection
    before_action :authorize_builder
    after_action :secure_embedding

    def show
      @template_data = Templates.serialize_for_builder(@template)
      render :show, layout: 'plain'
    end

    def update
      raise ActiveRecord::ReadOnlyRecord, 'approved_template_is_immutable' if @template.preferences['kundexa_locked']
      # Deliberately expose just placement and names, not arbitrary document uploads
      # or account administration through a builder session.
      allowed = params.require(:template).permit(:name, fields: [:uuid, :name, :type, :submitter_uuid, :required,
        :title, :description, { preferences: {}, areas: %i[uuid x y w h cell_w attachment_uuid page option_uuid],
                              validation: %i[message pattern min max step], options: %i[value uuid] }])
      if allowed[:fields]&.any? { |f| f[:submitter_uuid] != @template.submitters.first['uuid'] }
        return render json: { error: 'invalid_signer' }, status: :unprocessable_content
      end
      @template.update!(allowed)
      head :ok
    end

    private

    def authorize_builder
      @builder_token = request.headers['X-Kundexa-Builder'] || params[:token]
      encoded, signature = @builder_token.to_s.split('.', 2)
      secret = ENV.fetch('KUNDEXA_DOCUMENTS_SECRET')
      expected = Base64.urlsafe_encode64(OpenSSL::HMAC.digest('SHA256', secret, encoded.to_s), padding: false)
      raise CanCan::AccessDenied unless signature && ActiveSupport::SecurityUtils.secure_compare(expected, signature)
      payload = JSON.parse(Base64.urlsafe_decode64(encoded))
      raise CanCan::AccessDenied unless payload['purpose'] == 'builder' && payload['exp'].to_i > Time.now.to_i
      @template = Template.find(params[:id])
      raise CanCan::AccessDenied unless payload['template_id'].to_i == @template.id && payload['external_id'] == @template.external_id
      raise CanCan::AccessDenied if @template.preferences['kundexa_locked']
      @kundexa_user = @template.author
    end

    def current_user
      @kundexa_user
    end

    def secure_embedding
      origin = ENV.fetch('KUNDEXA_APP_ORIGIN')
      raise ArgumentError, 'https_origin_required' unless origin.match?(/\Ahttps:\/\/[^\/\s]+\z/)
      response.headers.delete('X-Frame-Options')
      response.headers['Content-Security-Policy'] = "frame-ancestors #{origin}"
      response.headers['Cache-Control'] = 'private, no-store'
      response.headers['Referrer-Policy'] = 'no-referrer'
    end
  end
end
