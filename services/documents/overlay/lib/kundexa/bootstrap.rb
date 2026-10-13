# frozen_string_literal: true
# Explicit operator command: rails runner "Kundexa::Bootstrap.call"
# Credentials come from the container environment and are never printed.
module Kundexa
  module Bootstrap
    def self.call
      email = ENV.fetch('KUNDEXA_DOCUMENTS_ADMIN_EMAIL')
      password = ENV.fetch('KUNDEXA_DOCUMENTS_ADMIN_PASSWORD')
      token = ENV.fetch('KUNDEXA_DOCUMENTS_API_KEY')
      raise ArgumentError, 'strong_credentials_required' if password.length < 24 || token.length < 32

      ActiveRecord::Base.transaction do
        user = User.find_by(email:)
        if user
          raise ArgumentError, 'dedicated_service_account_required' unless user.account.name == 'Kundexa documents'
        else
          account = Account.create!(name: 'Kundexa documents', locale: 'sv', timezone: 'Europe/Stockholm')
          user = account.users.create!(email:, password:, first_name: 'Kundexa', last_name: 'Documents')
        end
        user.access_token.update!(token:)
        # Native setup initializes signing material before accepting submissions.
        # Keep the same certificate on reruns: historical PDFs must not change key.
        account = user.account
        account.with_lock do
          account.encrypted_configs.create_or_find_by!(key: EncryptedConfig::ESIGN_CERTS_KEY) do |config|
            config.value = GenerateCertificate.call('Kundexa').transform_values(&:to_pem)
          end
          account.encrypted_configs.create_or_find_by!(key: EncryptedConfig::APP_URL_KEY) do |config|
            config.value = ENV.fetch('APP_URL')
          end
        end
      end
      puts 'Kundexa document service account configured'
    end
  end
end
