# frozen_string_literal: true
# Explicit operator command: rails runner /app/lib/kundexa/bootstrap.rb
# Credentials come from the container environment and are never printed.
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
end
puts 'Kundexa document service account configured'
